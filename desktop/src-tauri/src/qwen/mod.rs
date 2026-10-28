pub mod model;
mod transcription;

pub use transcription::transcribe;

use crate::cmd::download::{download_model, DownloadIntegrity, DownloadModelResult};
use eyre::{bail, Context, Result};
use once_cell::sync::Lazy;
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use tauri::{Emitter, Listener, Manager};
use tokio::sync::Mutex;

static DOWNLOAD_LOCK: Lazy<Mutex<()>> = Lazy::new(|| Mutex::new(()));

#[derive(Serialize)]
pub struct ModelStatus {
    path: String,
    installed: bool,
    reason: Option<String>,
}

#[derive(Serialize)]
pub struct InstalledModel {
    name: String,
    path: String,
    valid: bool,
    reason: Option<String>,
}

pub fn resolve_binary(app: &tauri::AppHandle) -> Result<PathBuf> {
    if !cfg!(target_os = "macos") {
        bail!("本地 Qwen 引擎目前仅支持 macOS");
    }
    let mut candidates = Vec::new();
    if let Ok(resource_dir) = app.path().resource_dir() {
        candidates.push(resource_dir.join("qwen-asr"));
    }
    if let Ok(exe_path) = std::env::current_exe() {
        if let Some(parent) = exe_path.parent() {
            candidates.push(parent.join("qwen-asr"));
        }
    }
    #[cfg(debug_assertions)]
    {
        let triple = format!("{}-apple-darwin", std::env::consts::ARCH);
        candidates.push(Path::new(env!("CARGO_MANIFEST_DIR")).join(format!("binaries/qwen-asr-{triple}")));
    }
    candidates
        .into_iter()
        .find(|path| path.is_file())
        .ok_or_else(|| eyre::eyre!("未找到本地 Qwen 引擎，请先运行 uv run scripts/prepare_qwen.py 再构建应用"))
}

fn status(path: PathBuf) -> ModelStatus {
    if !path.exists() {
        return ModelStatus {
            path: path.to_string_lossy().into_owned(),
            installed: false,
            reason: None,
        };
    }
    let error = model::metadata(&path).err();
    ModelStatus {
        path: path.to_string_lossy().into_owned(),
        installed: error.is_none(),
        reason: error.map(|error| error.to_string()),
    }
}

#[tauri::command]
pub fn qwen_model_status(app_handle: tauri::AppHandle) -> Result<ModelStatus> {
    Ok(status(model::model_path(&app_handle)?))
}

#[tauri::command]
pub fn list_qwen_models(app_handle: tauri::AppHandle, folder: Option<String>) -> Result<Vec<InstalledModel>> {
    let path = match folder {
        Some(folder) => PathBuf::from(folder).join(model::manifest()?.directory),
        None => model::model_path(&app_handle)?,
    };
    if !path.try_exists()? {
        return Ok(Vec::new());
    }
    let status = status(path);
    Ok(vec![InstalledModel {
        name: "Qwen3-ASR-1.7B".into(),
        path: status.path,
        valid: status.installed,
        reason: status.reason,
    }])
}

pub(super) struct AbortListener {
    app: tauri::AppHandle,
    listener: tauri::EventId,
}

impl AbortListener {
    pub(super) fn new(app: &tauri::AppHandle, event: &'static str, aborted: Arc<AtomicBool>) -> Self {
        let listener = app.listen(event, move |_| aborted.store(true, Ordering::Release));
        Self {
            app: app.clone(),
            listener,
        }
    }
}

impl Drop for AbortListener {
    fn drop(&mut self) {
        self.app.unlisten(self.listener);
    }
}

#[tauri::command]
pub async fn download_qwen_model(app_handle: tauri::AppHandle) -> Result<DownloadModelResult> {
    let _lock = DOWNLOAD_LOCK.try_lock().context("Qwen 模型已在下载中")?;
    let manifest = model::manifest()?;
    let directory = model::model_path(&app_handle)?;
    std::fs::create_dir_all(&directory)?;
    model::validate_directory_path(&directory)?;
    let aborted = Arc::new(AtomicBool::new(false));
    let _listener = AbortListener::new(&app_handle, "abort_download", aborted.clone());

    for file in manifest.files {
        if aborted.load(Ordering::Acquire) {
            return Ok(DownloadModelResult::Cancelled);
        }
        let path = directory.join(&file.name);
        reject_symlink(&path)?;
        reject_symlink(&directory.join(format!("{}.part", file.name)))?;
        let checked_path = path.clone();
        let checked_file = model::ModelFile {
            name: file.name.clone(),
            size: file.size,
            sha256: file.sha256.clone(),
        };
        let already_valid =
            tokio::task::spawn_blocking(move || model::check_file(&checked_path, &checked_file, true).is_ok()).await?;
        if aborted.load(Ordering::Acquire) {
            return Ok(DownloadModelResult::Cancelled);
        }
        if already_valid {
            continue;
        }
        let url = format!(
            "https://huggingface.co/{}/resolve/{}/{}",
            manifest.id, manifest.revision, file.name
        );
        let download = download_model(
            app_handle.clone(),
            url,
            path.to_string_lossy().into_owned(),
            Some(DownloadIntegrity {
                size: Some(file.size),
                sha256: Some(file.sha256),
            }),
        );
        tokio::pin!(download);
        let mut cancellation_check = tokio::time::interval(std::time::Duration::from_millis(50));
        // Re-deliver an abort that arrived in the gap before download_model registered its own
        // listener. Poll to completion so the shared downloader can remove its listener and .part.
        let result = loop {
            tokio::select! {
                result = &mut download => break result?,
                _ = cancellation_check.tick() => {
                    if aborted.load(Ordering::Acquire) {
                        app_handle.emit("abort_download", ()).ok();
                    }
                }
            }
        };
        if matches!(result, DownloadModelResult::Cancelled) {
            return Ok(result);
        }
    }
    if aborted.load(Ordering::Acquire) {
        return Ok(DownloadModelResult::Cancelled);
    }
    // Download_model already hashed each file; check the directory as a whole before exposing it.
    model::metadata(&directory)?;
    Ok(DownloadModelResult::Completed {
        path: directory.to_string_lossy().into_owned(),
    })
}

fn reject_symlink(path: &Path) -> Result<()> {
    match std::fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() => bail!("模型下载路径不能是符号链接"),
        Ok(_) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.into()),
    }
}

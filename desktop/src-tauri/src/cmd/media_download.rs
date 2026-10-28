//! Task-scoped download process with bounded output, cancellation and audio verification.
use super::{files::get_ffmpeg_path, media_input::prepare_media_source};
use eyre::{bail, ContextCompat, Result};
use once_cell::sync::Lazy;
use serde::Serialize;
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    process::Stdio,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};
use tauri::{AppHandle, Emitter, Manager};
use tokio::{
    io::{AsyncBufReadExt, AsyncRead, AsyncReadExt, BufReader},
    process::{Child, Command},
    sync::mpsc,
};

const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(30 * 60);
const MAX_FILE_BYTES: u64 = 2 * 1024 * 1024 * 1024;
const MAX_LINE_BYTES: usize = 8192;
const MAX_ERROR_BYTES: usize = 32_768;

struct RequestState {
    flag: Arc<AtomicBool>,
    active: bool,
    created: Instant,
}
static REQUESTS: Lazy<Mutex<HashMap<String, RequestState>>> = Lazy::new(|| Mutex::new(HashMap::new()));

struct RequestGuard {
    id: String,
    flag: Arc<AtomicBool>,
}

impl RequestGuard {
    fn begin(id: String) -> Result<Self> {
        validate_request_id(&id)?;
        let mut requests = REQUESTS.lock().map_err(|_| eyre::eyre!("下载状态不可用"))?;
        requests.retain(|_, state| state.active || state.created.elapsed() < Duration::from_secs(60));
        if requests.get(&id).is_some_and(|state| state.active) {
            bail!("相同下载任务正在运行");
        }
        if requests.len() >= 128 {
            bail!("下载任务过多，请稍后重试");
        }
        let state = requests.entry(id.clone()).or_insert_with(|| RequestState {
            flag: Arc::new(AtomicBool::new(false)),
            active: false,
            created: Instant::now(),
        });
        state.active = true;
        Ok(Self {
            id,
            flag: state.flag.clone(),
        })
    }
}

impl Drop for RequestGuard {
    fn drop(&mut self) {
        if let Ok(mut requests) = REQUESTS.lock() {
            if requests
                .get(&self.id)
                .is_some_and(|state| Arc::ptr_eq(&self.flag, &state.flag))
            {
                requests.remove(&self.id);
            }
        }
    }
}

fn validate_request_id(id: &str) -> Result<()> {
    if id.is_empty() || id.len() > 128 || !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
        bail!("下载任务标识无效");
    }
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadedMedia {
    pub path: String,
    pub title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_url: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DownloadProgress<'a> {
    request_id: &'a str,
    stage: &'static str,
    progress: Option<f32>,
}

#[tauri::command]
pub fn cancel_media_download(request_id: String) -> Result<()> {
    validate_request_id(&request_id)?;
    let mut requests = REQUESTS.lock().map_err(|_| eyre::eyre!("下载状态不可用"))?;
    requests.retain(|_, state| state.active || state.created.elapsed() < Duration::from_secs(60));
    if let Some(state) = requests.get(&request_id) {
        state.flag.store(true, Ordering::SeqCst);
    } else if requests.len() < 128 {
        // Cancellation may overtake the async invocation before it registers its task.
        requests.insert(
            request_id,
            RequestState {
                flag: Arc::new(AtomicBool::new(true)),
                active: false,
                created: Instant::now(),
            },
        );
    }
    Ok(())
}

fn ensure_active(flag: &AtomicBool) -> Result<()> {
    if flag.load(Ordering::SeqCst) {
        bail!("下载已取消");
    }
    Ok(())
}

async fn cancelled(flag: &AtomicBool) {
    while !flag.load(Ordering::SeqCst) {
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

fn emit_progress(app: &AppHandle, request_id: &str, stage: &'static str, progress: Option<f32>) {
    let _ = app.emit(
        "media-download-progress",
        DownloadProgress {
            request_id,
            stage,
            progress,
        },
    );
}

fn downloader_name() -> &'static str {
    if cfg!(windows) {
        if cfg!(target_arch = "aarch64") {
            "yt-dlp_arm64.exe"
        } else {
            "yt-dlp.exe"
        }
    } else if cfg!(target_os = "linux") {
        if cfg!(target_arch = "aarch64") {
            "yt-dlp_linux_aarch64"
        } else {
            "yt-dlp_linux"
        }
    } else {
        "yt-dlp_macos"
    }
}

fn process_command(executable: &Path) -> Command {
    let mut command = Command::new(executable);
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.as_std_mut().process_group(0);
    }
    #[cfg(windows)]
    {
        command.creation_flags(0x08000000);
    }
    command
}

async fn kill_process(child: &mut Child) {
    #[cfg(unix)]
    if let Some(id) = child.id() {
        // Each subprocess has its own process group, so this also stops FFmpeg children.
        let _ = Command::new("/bin/kill")
            .args(["-KILL", "--", &format!("-{id}")])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .await;
    }
    let _ = child.kill().await;
    let _ = child.wait().await;
}

/// Drain invalid UTF-8 and excessively long lines without retaining unbounded process output.
async fn read_output(reader: impl AsyncRead + Unpin, tx: mpsc::Sender<String>) {
    let mut reader = BufReader::new(reader);
    loop {
        let mut line = Vec::new();
        loop {
            let Ok(buffer) = reader.fill_buf().await else {
                return;
            };
            if buffer.is_empty() {
                if !line.is_empty() {
                    let _ = tx.send(String::from_utf8_lossy(&line).into_owned()).await;
                }
                return;
            }
            let end = buffer.iter().position(|byte| *byte == b'\n').map(|index| index + 1);
            let consumed = end.unwrap_or(buffer.len());
            let keep = consumed.min(MAX_LINE_BYTES.saturating_sub(line.len()));
            line.extend_from_slice(&buffer[..keep]);
            reader.consume(consumed);
            if end.is_some() {
                break;
            }
        }
        if tx.send(String::from_utf8_lossy(&line).trim().to_string()).await.is_err() {
            return;
        }
    }
}

fn classify_failure(stderr: &str) -> &'static str {
    let lower = stderr.to_ascii_lowercase();
    if [
        "sign in",
        "login required",
        "log in",
        "authentication required",
        "fresh cookies",
        "cookies are needed",
        "cookies-needed",
    ]
    .iter()
    .any(|text| lower.contains(text))
    {
        "该视频需要登录或平台凭据，第一版仅支持无需登录的内容；可以选择本地文件转写"
    } else if lower.contains("unsupported url") || lower.contains("no suitable extractor") {
        "该链接暂不受下载器支持，请选择本地音视频文件"
    } else if lower.contains("private video")
        || lower.contains("video unavailable")
        || lower.contains("not available")
        || lower.contains("http error 404")
        || lower.contains("http error 410")
    {
        "视频不可用、已删除或链接已失效"
    } else if lower.contains("http error 403") || lower.contains("http error 429") || lower.contains("rate limit") {
        "平台拒绝或限制了下载请求，请稍后重试或选择本地文件"
    } else if lower.contains("timed out") || lower.contains("unable to download") || lower.contains("connection") {
        "媒体下载失败，请检查网络、链接有效性或稍后重试"
    } else {
        "媒体下载失败，平台可能暂不兼容；可以重试或选择本地文件"
    }
}

fn parse_progress(line: &str) -> Option<f32> {
    let value = line.strip_prefix("VIBE_PROGRESS:")?.trim().trim_end_matches('%').trim();
    value
        .parse::<f32>()
        .ok()
        .filter(|value| value.is_finite() && (0.0..=100.0).contains(value))
}

fn parse_title(line: &str) -> Option<String> {
    let title: String = serde_json::from_str(line.strip_prefix("VIBE_TITLE:")?).ok()?;
    let title = title.chars().filter(|c| !c.is_control()).take(200).collect::<String>();
    (!title.trim().is_empty()).then(|| title.trim().to_string())
}

async fn directory_size(directory: &Path) -> u64 {
    let Ok(mut files) = tokio::fs::read_dir(directory).await else {
        return 0;
    };
    let mut total: u64 = 0;
    while let Ok(Some(file)) = files.next_entry().await {
        if let Ok(meta) = file.metadata().await {
            total = total.saturating_add(meta.len());
        }
    }
    total
}

async fn run_download(
    on_progress: &(dyn Fn(&'static str, Option<f32>) + Sync),
    request: &RequestGuard,
    url: &str,
    executable: &Path,
    ffmpeg: &str,
    directory: &Path,
) -> Result<String> {
    let output = directory.join("media.%(ext)s");
    let mut command = process_command(executable);
    command.args([
        "--ignore-config",
        "--no-cache-dir",
        "--no-playlist",
        "--no-warnings",
        "--newline",
        "--progress",
        "--no-simulate",
        "--socket-timeout",
        "20",
        "--retries",
        "2",
        "--fragment-retries",
        "2",
        "--concurrent-fragments",
        "1",
        "--max-filesize",
        "2G",
        "--match-filter",
        "duration <=? 14400",
        "--progress-template",
        "download:VIBE_PROGRESS:%(progress._percent_str)s",
        "--print",
        "before_dl:VIBE_TITLE:%(title)j",
        "--print",
        "post_process:VIBE_PREPARING",
        "--restrict-filenames",
        "--no-mtime",
        "-f",
        "bestaudio/best",
        "-x",
        "--audio-format",
        "m4a",
        "--ffmpeg-location",
        ffmpeg,
        "-o",
        output.to_str().context("下载目录无效")?,
        "--",
        url,
    ]);
    let mut child = command
        .spawn()
        .map_err(|_| eyre::eyre!("无法启动媒体下载器，请重新安装下载器"))?;
    let (tx, mut rx) = mpsc::channel(32);
    let stdout = tokio::spawn(read_output(child.stdout.take().context("无法读取下载进度")?, tx.clone()));
    let stderr = tokio::spawn(read_output(child.stderr.take().context("无法读取下载错误")?, tx));
    let mut tick = tokio::time::interval(Duration::from_millis(100));
    let started = Instant::now();
    let mut errors = String::new();
    let mut title = None;
    let mut output_open = true;
    let result = loop {
        tokio::select! {
            line = rx.recv(), if output_open => {
                match line {
                    Some(line) => {
                        if let Some(progress) = parse_progress(&line) { on_progress("downloading", Some(progress)); }
                        else if let Some(value) = parse_title(&line) { title = Some(value); }
                        else if line == "VIBE_PREPARING" { on_progress("preparing", None); }
                        else if errors.len() < MAX_ERROR_BYTES { errors.extend(line.chars().take((MAX_ERROR_BYTES - errors.len()) / 4)); errors.push('\n'); }
                    },
                    None => output_open = false,
                }
            },
            _ = tick.tick() => {
                if request.flag.load(Ordering::SeqCst) { break Err(eyre::eyre!("下载已取消")); }
                if started.elapsed() > DOWNLOAD_TIMEOUT { break Err(eyre::eyre!("下载超时，请重试或选择本地文件")); }
                if directory_size(directory).await > MAX_FILE_BYTES { break Err(eyre::eyre!("媒体超过 2 GB 上限，请选择较小的文件")); }
                match child.try_wait() {
                    Ok(Some(status)) if !output_open => break if status.success() { Ok(()) } else { Err(eyre::eyre!(classify_failure(&errors))) },
                    Ok(_) => {},
                    Err(_) => break Err(eyre::eyre!("无法读取下载进程状态")),
                }
            }
        }
    };
    // Never leave a child or its readers alive after an error/cancel/timeout.
    if result.is_err() {
        kill_process(&mut child).await;
    }
    stdout.abort();
    stderr.abort();
    result?;
    ensure_active(&request.flag)?;
    Ok(title.unwrap_or_else(|| "链接音视频".to_string()))
}

async fn verify_audio(path: &Path, ffmpeg: &str, flag: &AtomicBool) -> Result<()> {
    let metadata = tokio::fs::symlink_metadata(path)
        .await
        .map_err(|_| eyre::eyre!("下载完成但未生成音频文件"))?;
    if !metadata.is_file() || metadata.len() == 0 || metadata.len() > MAX_FILE_BYTES {
        bail!("下载产物为空、过大或不是音频文件");
    }
    let mut command = process_command(Path::new(ffmpeg));
    command.args([
        "-nostdin",
        "-v",
        "error",
        "-protocol_whitelist",
        "file,crypto,data",
        "-i",
        path.to_str().context("音频路径无效")?,
        "-map",
        "0:a:0",
        "-t",
        "0.25",
        "-ac",
        "1",
        "-ar",
        "16000",
        "-f",
        "s16le",
        "pipe:1",
    ]);
    let mut child = command.spawn().map_err(|_| eyre::eyre!("无法启动 FFmpeg 验证音轨"))?;
    let mut stdout = child.stdout.take().context("无法读取音轨")?;
    let mut stderr = child.stderr.take().context("无法读取音轨状态")?;
    let read_stdout = tokio::spawn(async move {
        let mut bytes = Vec::new();
        stdout.read_to_end(&mut bytes).await.map(|_| bytes.len())
    });
    let read_stderr = tokio::spawn(async move {
        let mut sink = tokio::io::sink();
        tokio::io::copy(&mut stderr, &mut sink).await
    });
    let result = tokio::select! {
        result = child.wait() => result.map_err(|_| eyre::eyre!("音轨检查失败")),
        _ = cancelled(flag) => Err(eyre::eyre!("下载已取消")),
        _ = tokio::time::sleep(Duration::from_secs(30)) => Err(eyre::eyre!("音轨检查超时")),
    };
    if result.as_ref().is_err() {
        kill_process(&mut child).await;
        read_stdout.abort();
        read_stderr.abort();
    }
    let status = result?;
    let bytes = read_stdout
        .await
        .map_err(|_| eyre::eyre!("音轨检查失败"))?
        .map_err(|_| eyre::eyre!("音轨检查失败"))?;
    let _ = read_stderr.await;
    ensure_active(flag)?;
    if !status.success() || bytes == 0 {
        bail!("下载内容没有可解码的音轨，请选择包含声音的视频或音频");
    }
    Ok(())
}

#[tauri::command]
pub async fn download_media(app: AppHandle, url: String, request_id: String) -> Result<DownloadedMedia> {
    let request = RequestGuard::begin(request_id)?;
    ensure_active(&request.flag)?;
    emit_progress(&app, &request.id, "downloading", None);
    let source = tokio::select! {
        source = prepare_media_source(&url) => source?,
        _ = cancelled(&request.flag) => bail!("下载已取消"),
        _ = tokio::time::sleep(Duration::from_secs(90)) => bail!("链接解析超时，请检查网络或重试"),
    };
    ensure_active(&request.flag)?;
    let executable = app
        .path()
        .app_local_data_dir()
        .map_err(|_| eyre::eyre!("无法获取下载器目录"))?
        .join(downloader_name());
    if !executable.is_file() {
        bail!("媒体下载器尚未安装，请先安装 yt-dlp 后重试");
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        tokio::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o755))
            .await
            .map_err(|_| eyre::eyre!("无法设置下载器权限"))?;
    }
    let ffmpeg = get_ffmpeg_path();
    if ffmpeg.is_empty() {
        bail!("FFmpeg 不可用，请重新安装应用");
    }
    // tempfile owns all partial files and deletes them on every error path.
    let directory = tempfile::Builder::new()
        .prefix("vibe-media-")
        .tempdir_in(crate::ffmpeg::get_vibe_temp_folder())?;
    let progress = |stage, value| emit_progress(&app, &request.id, stage, value);
    let title = run_download(
        &progress,
        &request,
        source.url.as_str(),
        &executable,
        &ffmpeg,
        directory.path(),
    )
    .await?;
    let path = directory.path().join("media.m4a");
    emit_progress(&app, &request.id, "preparing", None);
    verify_audio(&path, &ffmpeg, &request.flag).await?;
    ensure_active(&request.flag)?;
    // The existing queue will copy/move this into a durable project. Keep a single managed
    // staging file, while all downloader metadata/partials are removed with the temporary dir.
    let output = PathBuf::from(super::ytdlp::get_temp_path("m4a".to_string()));
    tokio::fs::rename(&path, &output)
        .await
        .map_err(|_| eyre::eyre!("无法暂存已下载音频"))?;
    if let Err(error) = ensure_active(&request.flag) {
        let _ = tokio::fs::remove_file(&output).await;
        return Err(error);
    }
    Ok(DownloadedMedia {
        path: output.to_string_lossy().into_owned(),
        title,
        source_url: source.source_url,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn task_ids_cannot_be_paths_and_duplicate_active_tasks_are_rejected() {
        assert!(RequestGuard::begin("../escape".to_string()).is_err());
        let guard = RequestGuard::begin("test-unique-task".to_string()).unwrap();
        assert!(RequestGuard::begin(guard.id.clone()).is_err());
    }

    #[test]
    fn cancellation_before_registration_is_not_lost() {
        let id = "test-pre-cancelled".to_string();
        cancel_media_download(id.clone()).unwrap();
        let guard = RequestGuard::begin(id).unwrap();
        assert!(ensure_active(&guard.flag).is_err());
    }

    #[test]
    fn cancellation_is_isolated_to_its_request() {
        let first = RequestGuard::begin("test-isolated-one".to_string()).unwrap();
        let second = RequestGuard::begin("test-isolated-two".to_string()).unwrap();
        cancel_media_download(first.id.clone()).unwrap();
        assert!(ensure_active(&first.flag).is_err());
        assert!(ensure_active(&second.flag).is_ok());
    }

    #[test]
    fn process_data_does_not_become_a_command_or_unbounded_title() {
        assert_eq!(parse_progress("VIBE_PROGRESS: 42.3%"), Some(42.3));
        assert_eq!(parse_progress("VIBE_PROGRESS: NaN"), None);
        assert_eq!(parse_progress("VIBE_PROGRESS: 101%"), None);
        assert_eq!(
            parse_title("VIBE_TITLE:\"中文视频\\n标题\""),
            Some("中文视频标题".to_string())
        );
        assert_eq!(parse_title("VIBE_TITLE:{\"title\":\"bad\"}"), None);
    }

    #[test]
    fn download_errors_never_echo_urls_tokens_or_raw_process_output() {
        let raw = "ERROR: https://example.com/private?token=secret HTTP Error 403";
        assert!(!classify_failure(raw).contains("secret"));
        assert!(classify_failure("ERROR: Sign in to confirm your age").contains("登录"));
        assert!(!classify_failure(raw).contains("需要登录"));
    }

    #[tokio::test]
    async fn drains_long_and_non_utf8_process_output_without_blocking() {
        let data = [vec![0xff; MAX_LINE_BYTES * 2], b"\nnext\n".to_vec()].concat();
        let (tx, mut rx) = mpsc::channel(4);
        read_output(data.as_slice(), tx).await;
        assert!(rx.recv().await.unwrap().len() <= MAX_LINE_BYTES * 3);
        assert_eq!(rx.recv().await.as_deref(), Some("next"));
        assert!(rx.recv().await.is_none());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn cancels_a_silent_downloader_without_waiting_for_a_line() {
        use std::os::unix::fs::PermissionsExt;
        let directory = tempfile::tempdir().unwrap();
        let executable = directory.path().join("silent-downloader");
        std::fs::write(&executable, "#!/bin/sh\nsleep 30\n").unwrap();
        std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o755)).unwrap();
        let request = RequestGuard::begin("test-silent-cancel".to_string()).unwrap();
        let flag = request.flag.clone();
        let cancel = tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(150)).await;
            flag.store(true, Ordering::SeqCst);
        });
        let progress = |_, _| {};
        let result = tokio::time::timeout(
            Duration::from_secs(3),
            run_download(
                &progress,
                &request,
                "https://example.com/audio",
                &executable,
                "/unused",
                directory.path(),
            ),
        )
        .await
        .expect("cancellation must not wait for child stdout");
        assert!(result.unwrap_err().to_string().contains("取消"));
        cancel.await.unwrap();
    }

    #[tokio::test]
    async fn verifies_real_audio_and_rejects_non_audio_when_ffmpeg_is_available() {
        let Some(ffmpeg) = crate::ffmpeg::find_ffmpeg_path() else {
            return;
        };
        let ffmpeg = ffmpeg.to_str().unwrap();
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("sample.wav");
        let spec = hound::WavSpec {
            channels: 1,
            sample_rate: 16_000,
            bits_per_sample: 16,
            sample_format: hound::SampleFormat::Int,
        };
        let mut writer = hound::WavWriter::create(&path, spec).unwrap();
        for index in 0..8000 {
            let sample = ((index as f32 * 440.0 * std::f32::consts::TAU / 16000.0).sin() * 10000.0) as i16;
            writer.write_sample(sample).unwrap();
        }
        writer.finalize().unwrap();
        let flag = AtomicBool::new(false);
        verify_audio(&path, ffmpeg, &flag).await.unwrap();
        std::fs::write(&path, b"<html>this is not an audio track</html>").unwrap();
        assert!(verify_audio(&path, ffmpeg, &flag)
            .await
            .unwrap_err()
            .to_string()
            .contains("音轨"));
        std::fs::write(&path, b"").unwrap();
        assert!(verify_audio(&path, ffmpeg, &flag).await.is_err());
    }

    #[tokio::test]
    #[ignore = "requires explicit public media URL, downloader and FFmpeg paths"]
    async fn downloads_and_verifies_real_public_media() {
        let url = std::env::var("VIBE_MEDIA_TEST_URL").expect("VIBE_MEDIA_TEST_URL");
        let executable = PathBuf::from(std::env::var("VIBE_MEDIA_TEST_YTDLP").expect("VIBE_MEDIA_TEST_YTDLP"));
        let ffmpeg = std::env::var("VIBE_MEDIA_TEST_FFMPEG").expect("VIBE_MEDIA_TEST_FFMPEG");
        let request = RequestGuard::begin(format!("test-real-{}", crate::ffmpeg::random_string(8))).unwrap();
        let source = prepare_media_source(&url).await.expect("public source validation");
        let directory = tempfile::tempdir().unwrap();
        let progress = |stage, value| eprintln!("media stage={stage} progress={value:?}");
        let title = run_download(
            &progress,
            &request,
            source.url.as_str(),
            &executable,
            &ffmpeg,
            directory.path(),
        )
        .await
        .expect("download and audio extraction");
        let path = directory.path().join("media.m4a");
        verify_audio(&path, &ffmpeg, &request.flag)
            .await
            .expect("nonempty decodable audio");
        assert!(!title.is_empty());
        assert!(std::fs::metadata(&path).unwrap().len() > 0);
        // An explicitly supplied output lets the coordinator feed the verified artifact to STT.
        if let Ok(output) = std::env::var("VIBE_MEDIA_TEST_OUTPUT") {
            std::fs::copy(&path, output).expect("copy verified test audio");
        }
    }
}

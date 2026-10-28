use crate::server::{ModelCapabilities, ModelMetadata};
use eyre::{bail, Context, ContextCompat, Result};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::io::Read;
use std::path::{Path, PathBuf};

#[derive(Debug, Deserialize)]
pub struct Manifest {
    pub id: String,
    pub revision: String,
    pub directory: String,
    pub files: Vec<ModelFile>,
}

#[derive(Debug, Deserialize)]
pub struct ModelFile {
    pub name: String,
    pub size: u64,
    pub sha256: String,
}

pub fn manifest() -> Result<Manifest> {
    let manifest: Manifest = serde_json::from_str(include_str!("../../resources/qwen3-asr-1.7b.json"))?;
    validate_manifest(&manifest)?;
    Ok(manifest)
}

fn validate_manifest(manifest: &Manifest) -> Result<()> {
    if manifest.id != "Qwen/Qwen3-ASR-1.7B"
        || manifest.directory != "Qwen3-ASR-1.7B"
        || manifest.revision.len() != 40
        || !manifest.revision.bytes().all(|byte| byte.is_ascii_hexdigit())
        || manifest.files.is_empty()
    {
        bail!("Qwen 模型清单无效");
    }
    let mut names = HashSet::new();
    for file in &manifest.files {
        if Path::new(&file.name).file_name().and_then(|name| name.to_str()) != Some(file.name.as_str())
            || file.name.contains(['/', '\\'])
            || file.size == 0
            || file.sha256.len() != 64
            || !file.sha256.bytes().all(|byte| byte.is_ascii_hexdigit())
            || !names.insert(&file.name)
        {
            bail!("Qwen 模型文件清单无效");
        }
    }
    Ok(())
}

pub fn metadata(path: &Path) -> Result<ModelMetadata> {
    check_directory(path, &manifest()?, false)?;
    Ok(ModelMetadata {
        format: "safetensors".into(),
        capabilities: ModelCapabilities {
            engine: "qwen3-asr".into(),
            requires_vad: false,
            languages: vec!["zh".into()],
            language_detection: true,
            streaming: false,
            translation: false,
            timestamps: false,
            text_prompts: true,
        },
    })
}

pub fn validate(path: &Path) -> Result<()> {
    check_directory(path, &manifest()?, true)
}

pub fn check_directory(path: &Path, manifest: &Manifest, hashes: bool) -> Result<()> {
    validate_directory_path(path)?;
    let directory = path.canonicalize().context("无法读取 Qwen 模型目录")?;
    // The native engine stores this path in a 512-byte buffer.
    validate_path_length(&directory)?;
    let expected: HashSet<&str> = manifest.files.iter().map(|file| file.name.as_str()).collect();
    for entry in std::fs::read_dir(&directory)? {
        let entry = entry?;
        let name = entry.file_name();
        let name = name.to_string_lossy();
        // The native shard scanner also reads suffixed names such as .safetensors.part.
        let native_shard = name.starts_with("model-") && name.contains(".safetensors");
        if (name.ends_with(".safetensors") || native_shard) && !expected.contains(name.as_ref()) {
            bail!("Qwen 模型目录包含不受支持的权重文件：{name}");
        }
    }
    for file in &manifest.files {
        let file_path = directory.join(&file.name);
        check_file(&file_path, file, hashes)?;
    }
    Ok(())
}

pub fn validate_directory_path(path: &Path) -> Result<()> {
    validate_path_length(path)?;
    let metadata = std::fs::symlink_metadata(path).context("Qwen 模型尚未下载完整")?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        bail!("Qwen 模型必须是实际目录，不能是符号链接");
    }
    Ok(())
}

fn validate_path_length(path: &Path) -> Result<()> {
    let text = path.to_str().context("Qwen 模型目录必须是有效 UTF-8 路径")?;
    if text.len() >= 500 || text.as_bytes().contains(&0) {
        bail!("Qwen 模型目录路径过长，请将模型放到更短的路径下");
    }
    Ok(())
}

pub fn check_file(path: &Path, file: &ModelFile, hash: bool) -> Result<()> {
    let metadata = std::fs::symlink_metadata(path).context(format!("缺少 Qwen 模型文件：{}", file.name))?;
    if metadata.file_type().is_symlink() || !metadata.is_file() || metadata.len() != file.size {
        bail!("Qwen 模型文件不完整或无效：{}", file.name);
    }
    if hash && sha256(path)? != file.sha256.to_ascii_lowercase() {
        bail!("Qwen 模型文件校验失败，请重新下载：{}", file.name);
    }
    Ok(())
}

fn sha256(path: &Path) -> Result<String> {
    let mut file = std::fs::File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0u8; 1024 * 1024];
    loop {
        let count = file.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        hasher.update(&buffer[..count]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

pub fn model_path(app: &tauri::AppHandle) -> Result<PathBuf> {
    Ok(crate::cmd::app::get_models_folder(app.clone())?.join(manifest()?.directory))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture(bytes: &[u8]) -> (tempfile::TempDir, Manifest) {
        let directory = tempfile::tempdir().unwrap();
        std::fs::write(directory.path().join("model.safetensors"), bytes).unwrap();
        let manifest = Manifest {
            id: "Qwen/Qwen3-ASR-1.7B".into(),
            revision: "a".repeat(40),
            directory: "Qwen3-ASR-1.7B".into(),
            files: vec![ModelFile {
                name: "model.safetensors".into(),
                size: bytes.len() as u64,
                sha256: format!("{:x}", Sha256::digest(bytes)),
            }],
        };
        (directory, manifest)
    }

    #[test]
    fn rejects_a_same_size_corrupt_weight() {
        let (directory, manifest) = fixture(b"weights");
        check_directory(directory.path(), &manifest, true).unwrap();
        std::fs::write(directory.path().join("model.safetensors"), b"damaged").unwrap();
        assert!(check_directory(directory.path(), &manifest, true).is_err());
    }

    #[test]
    fn rejects_missing_or_unexpected_weights() {
        let (directory, manifest) = fixture(b"weights");
        std::fs::write(directory.path().join("extra.safetensors"), b"extra").unwrap();
        assert!(check_directory(directory.path(), &manifest, false).is_err());
        std::fs::remove_file(directory.path().join("extra.safetensors")).unwrap();
        std::fs::remove_file(directory.path().join("model.safetensors")).unwrap();
        assert!(check_directory(directory.path(), &manifest, false).is_err());
    }

    #[test]
    fn rejects_unknown_shards_with_suffixes_the_native_reader_would_load() {
        let (directory, manifest) = fixture(b"weights");
        for name in ["model-fake.safetensors.part", "model-00001-of-00002.safetensors.backup"] {
            let path = directory.path().join(name);
            std::fs::write(&path, b"extra").unwrap();
            assert!(
                check_directory(directory.path(), &manifest, false).is_err(),
                "accepted {name}"
            );
            std::fs::remove_file(path).unwrap();
        }
    }

    #[test]
    fn rejects_manifest_path_traversal() {
        let (_, mut manifest) = fixture(b"weights");
        manifest.files[0].name = "../model.safetensors".into();
        assert!(validate_manifest(&manifest).is_err());
    }

    #[test]
    fn rejects_too_long_model_path() {
        assert!(validate_path_length(Path::new(&"a".repeat(500))).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn rejects_symlinked_weight_and_model_directory() {
        let (directory, manifest) = fixture(b"weights");
        let other = tempfile::tempdir().unwrap();
        let weight = directory.path().join("model.safetensors");
        std::fs::rename(&weight, other.path().join("weights")).unwrap();
        std::os::unix::fs::symlink(other.path().join("weights"), &weight).unwrap();
        assert!(check_directory(directory.path(), &manifest, true).is_err());
        let link = other.path().join("model");
        std::os::unix::fs::symlink(directory.path(), &link).unwrap();
        assert!(check_directory(&link, &manifest, false).is_err());
    }
}

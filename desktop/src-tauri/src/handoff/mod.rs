//! Phone handoff: a phone records audio, sends it over iroh, this desktop
//! transcribes it with Server and streams the transcript back.
//!
//! The endpoint is *not* spawned at startup — the user opts in from the UI,
//! which calls the `handoff_start` command.

pub mod devices;
pub mod protocol;
mod transcribe;
mod transfer;

use std::path::PathBuf;

use eyre::{Context, Result};
use iroh::endpoint::presets;
use iroh::protocol::Router;
use iroh::{Endpoint, SecretKey};
use sha2::{Digest, Sha256};
use tauri::{Emitter, Manager};

use crate::error::LogError;
use protocol::{HandoffActivity, ALPN};
use transfer::HandoffHandler;

/// Whether the user turned handoff on. Namespaced like the other feature keys in
/// `lib/config-keys.ts` (`model.path`, `transcription.saveTranscripts`).
pub const CONFIG_KEY_HANDOFF_ENABLED: &str = "handoff.enabled";

/// 手机网页须由当前产品自行部署。保留已有变量名及运行时覆盖编译期的规则，
/// 未配置时关闭接力入口，不再把配对凭据交给上游网页。
const COMPILED_PWA_ORIGIN: Option<&str> = option_env!("VIBE_PWA_ORIGIN");

/// A running handoff endpoint. Dropping this aborts the accept loop; prefer
/// [`HandoffState::shutdown`] for a clean close.
pub struct HandoffState {
    router: Router,
    endpoint_id: String,
    authorization_changes: tokio::sync::watch::Sender<()>,
}

impl HandoffState {
    /// 64 lowercase hex chars identifying this desktop on the iroh network.
    pub fn endpoint_id(&self) -> String {
        self.endpoint_id.clone()
    }

    /// Wake active requests so revoked credentials stop being usable immediately.
    pub fn authorization_changed(&self) {
        self.authorization_changes.send_replace(());
    }

    pub async fn shutdown(self) {
        if let Err(error) = self.router.shutdown().await {
            tracing::warn!("handoff router shutdown failed: {:?}", error);
        } else {
            tracing::debug!("handoff router shut down");
        }
    }
}

/// Correlate successful authentication with the current QR without emitting its secret.
pub(crate) fn pairing_id(token: &str) -> String {
    format!("{:x}", Sha256::digest(token.as_bytes()))
}

/// `<pwa_origin>/#<endpoint_id>:<token>` — the exact string the QR encodes.
pub(crate) fn format_pairing_url(pwa_origin: &str, endpoint_id: &str, token: &str) -> String {
    format!("{}/#{}:{}", pwa_origin.trim_end_matches('/'), endpoint_id, token)
}

/// The configured page the pairing QR should point at.
pub fn pwa_origin() -> Result<String> {
    resolve_pwa_origin(std::env::var("VIBE_PWA_ORIGIN").ok().as_deref(), COMPILED_PWA_ORIGIN)
}

fn resolve_pwa_origin(runtime: Option<&str>, compiled: Option<&str>) -> Result<String> {
    let value = runtime
        .filter(|value| !value.trim().is_empty())
        .or_else(|| compiled.filter(|value| !value.trim().is_empty()))
        .ok_or_else(|| eyre::eyre!("尚未配置自有手机网页，手机接力暂不可用。请部署手机网页并设置 VIBE_PWA_ORIGIN。"))?
        .trim();
    let invalid = || {
        eyre::eyre!(
            "手机网页地址无效：VIBE_PWA_ORIGIN 必须使用 HTTPS，且不能包含账号、查询参数或片段；本机开发可使用 HTTP 回环地址。"
        )
    };
    if value.chars().any(char::is_control) {
        return Err(invalid());
    }
    let url = url::Url::parse(value).map_err(|_| invalid())?;
    let local = match url.host() {
        Some(url::Host::Domain(host)) => host == "localhost",
        Some(url::Host::Ipv4(ip)) => ip.is_loopback(),
        Some(url::Host::Ipv6(ip)) => ip.is_loopback(),
        None => false,
    };
    if !(url.scheme() == "https" || url.scheme() == "http" && local)
        || url.host().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(invalid());
    }
    Ok(url.as_str().trim_end_matches('/').to_owned())
}

fn handoff_dir(app_handle: &tauri::AppHandle) -> Result<PathBuf> {
    let dir = app_handle
        .path()
        .app_data_dir()
        .context("failed to resolve app data dir")?
        .join("handoff");
    std::fs::create_dir_all(&dir).with_context(|| format!("failed to create {}", dir.display()))?;
    Ok(dir)
}

#[cfg(unix)]
fn restrict_permissions(path: &std::path::Path) -> Result<()> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
        .with_context(|| format!("failed to chmod {}", path.display()))
}

#[cfg(not(unix))]
fn restrict_permissions(_path: &std::path::Path) -> Result<()> {
    Ok(())
}

/// Load the persisted iroh identity, generating it on first use so pairing QR
/// codes keep working across restarts.
fn load_or_create_secret_key(app_handle: &tauri::AppHandle) -> Result<SecretKey> {
    let path = handoff_dir(app_handle)?.join("endpoint.key");
    if path.exists() {
        let bytes = std::fs::read(&path).with_context(|| format!("failed to read {}", path.display()))?;
        if bytes.len() == 32 {
            let mut key = [0u8; 32];
            key.copy_from_slice(&bytes);
            return Ok(SecretKey::from_bytes(&key));
        }
        tracing::warn!("handoff secret key at {} is malformed, regenerating", path.display());
    }
    let secret_key = SecretKey::generate();
    std::fs::write(&path, secret_key.to_bytes()).with_context(|| format!("failed to write {}", path.display()))?;
    restrict_permissions(&path).log_error();
    Ok(secret_key)
}

fn generate_token() -> String {
    let bytes: [u8; 16] = rand::random();
    hex::encode(bytes)
}

/// Remember whether the user wants handoff on, so enabling it survives a restart.
///
/// Enablement has to persist alongside the identity: the secret key and token are
/// already on disk, so the pairing QR stays valid across restarts. If the endpoint
/// did not come back with it, the phone would keep believing it is paired and dial
/// an endpoint that no longer exists.
pub fn set_enabled(app_handle: &tauri::AppHandle, enabled: bool) {
    use tauri_plugin_store::StoreExt;

    match app_handle.store(crate::config::STORE_FILENAME) {
        Ok(store) => store.set(CONFIG_KEY_HANDOFF_ENABLED, serde_json::Value::Bool(enabled)),
        Err(error) => tracing::warn!("handoff could not persist the enabled flag: {:?}", error),
    }
}

/// Whether handoff was on when the app last closed. Defaults to off: this opens a
/// network listener, so only a user who explicitly turned it on gets it back.
pub fn is_enabled(app_handle: &tauri::AppHandle) -> bool {
    use tauri_plugin_store::StoreExt;

    app_handle
        .store(crate::config::STORE_FILENAME)
        .ok()
        .and_then(|store| store.get(CONFIG_KEY_HANDOFF_ENABLED))
        .and_then(|value| value.as_bool())
        .unwrap_or(false)
}

/// Bind the iroh endpoint and start accepting handoff connections.
pub async fn spawn(app_handle: tauri::AppHandle) -> Result<HandoffState> {
    // 校验先于凭据创建及网络监听，未配置网页时不产生副作用。
    pwa_origin()?;
    let secret_key = load_or_create_secret_key(&app_handle)?;
    devices::invitation(&app_handle)?;

    let endpoint = Endpoint::builder(presets::N0)
        .secret_key(secret_key)
        .alpns(vec![ALPN.to_vec()])
        .bind()
        .await
        .map_err(|error| eyre::eyre!("failed to bind handoff endpoint: {error}"))?;

    let endpoint_id = endpoint.id().to_string();
    tracing::info!("handoff endpoint bound: {}", endpoint_id);

    let (authorization_changes, authorization_receiver) = tokio::sync::watch::channel(());
    let handler = HandoffHandler {
        app_handle,
        authorization_changes: authorization_receiver,
    };
    let router = Router::builder(endpoint).accept(ALPN, handler).spawn();

    Ok(HandoffState {
        router,
        endpoint_id,
        authorization_changes,
    })
}

/// Bring handoff back if the user had it on, without making the app wait.
///
/// Binding an iroh endpoint reaches the network, so this returns immediately and
/// finishes in the background; `handoff_status` reports the real state once it
/// settles. A brand-new user gets nothing: the flag defaults to off, and silently
/// opening a network listener on upgrade would be wrong.
pub fn restore_on_startup(app_handle: &tauri::AppHandle) {
    if !is_enabled(app_handle) {
        tracing::debug!("handoff is disabled; not restoring");
        return;
    }
    if let Err(error) = pwa_origin() {
        tracing::debug!("handoff is unavailable; not restoring: {}", error);
        return;
    }

    let app_handle = app_handle.clone();
    tauri::async_runtime::spawn(async move {
        tracing::info!("restoring handoff endpoint in the background");
        match spawn(app_handle.clone()).await {
            Ok(state) => {
                let runtime = app_handle.state::<tokio::sync::Mutex<Option<HandoffState>>>();
                let mut guard = runtime.lock().await;
                if guard.is_some() {
                    // The user toggled it on while we were still binding; keep
                    // theirs rather than leaking a second router.
                    tracing::debug!("handoff was started manually during restore; dropping the restored one");
                    drop(guard);
                    state.shutdown().await;
                } else {
                    tracing::info!("handoff restored: {}", state.endpoint_id());
                    *guard = Some(state);
                    drop(guard);
                    app_handle
                        .emit_to("main", "handoff_activity", HandoffActivity::new("ready", None))
                        .log_error();
                }
            }
            Err(error) => {
                // Never leave the UI claiming handoff is on when it is not. The
                // saved preference stays true so the next launch retries, but
                // `handoff_status` reports the truth: not running.
                let message = format!("{error:#}");
                tracing::error!("failed to restore handoff endpoint: {}", message);
                app_handle
                    .emit_to("main", "handoff_activity", HandoffActivity::new("error", Some(message)))
                    .log_error();
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_phone_page_disables_handoff_instead_of_using_an_upstream_fallback() {
        for (runtime, compiled) in [(None, None), (Some("  "), None), (None, Some(""))] {
            let error = resolve_pwa_origin(runtime, compiled).unwrap_err().to_string();
            assert!(error.contains("尚未配置自有手机网页"));
            assert!(error.contains("VIBE_PWA_ORIGIN"));
        }
    }

    #[test]
    fn phone_page_uses_the_existing_runtime_override_and_compiled_fallback() {
        assert_eq!(
            resolve_pwa_origin(Some(" https://phone.example/product/ "), Some("https://compiled.example")).unwrap(),
            "https://phone.example/product"
        );
        assert_eq!(
            resolve_pwa_origin(Some(""), Some("https://compiled.example/")).unwrap(),
            "https://compiled.example"
        );
        assert!(resolve_pwa_origin(Some("invalid"), Some("https://compiled.example")).is_err());
    }

    #[test]
    fn phone_page_allows_secure_deployment_and_local_development() {
        for value in [
            "https://phone.example/path",
            "http://localhost:8088",
            "http://127.0.0.1:8088",
            "http://[::1]:8088",
        ] {
            assert!(resolve_pwa_origin(Some(value), None).is_ok(), "{value}");
        }
    }

    #[test]
    fn phone_page_rejects_unsafe_or_ambiguous_addresses() {
        for value in [
            "http://phone.example",
            "http://192.168.1.10:8088",
            "https://user:password@phone.example",
            "https://phone.example/?token=secret",
            "https://phone.example/#old-pairing",
            "https://phone.example/\npath",
            "file:///phone.html",
            "javascript:alert(1)",
        ] {
            assert!(resolve_pwa_origin(Some(value), None).is_err(), "{value}");
        }
    }

    #[test]
    fn pairing_url_matches_the_contract_shape() {
        let id = "a".repeat(64);
        let token = "0123456789abcdef0123456789abcdef";
        assert_eq!(
            format_pairing_url("http://localhost:8088", &id, token),
            format!("http://localhost:8088/#{id}:{token}")
        );
        // A trailing slash on the origin must not produce a double slash.
        assert_eq!(
            format_pairing_url("https://vibe.example/", &id, token),
            format_pairing_url("https://vibe.example", &id, token)
        );
    }
}

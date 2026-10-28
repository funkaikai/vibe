//! Validation for user-provided media URLs. Downloader-internal CDN requests are outside this layer.
use eyre::{bail, ContextCompat, Result};
use reqwest::{header, Client, Response};
use std::{
    net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr},
    time::Duration,
};
use url::{Host, Url};

const PLATFORM_DOMAINS: &[&str] = &[
    "bilibili.com",
    "b23.tv",
    "xiaohongshu.com",
    "xhslink.com",
    "youtube.com",
    "youtu.be",
    "douyin.com",
    "iesdouyin.com",
    "weibo.com",
    "weibo.cn",
    "t.cn",
];
const SHORT_DOMAINS: &[&str] = &["b23.tv", "xhslink.com", "youtu.be", "v.douyin.com", "t.cn"];
const MAX_REDIRECTS: usize = 6;

pub(crate) struct MediaSource {
    pub url: Url,
    pub source_url: Option<String>,
}

fn domain_matches(host: &str, domain: &str) -> bool {
    host == domain || host.strip_suffix(domain).is_some_and(|prefix| prefix.ends_with('.'))
}

pub(crate) fn platform_host(host: &str) -> bool {
    PLATFORM_DOMAINS.iter().any(|domain| domain_matches(host, domain))
}

fn short_host(host: &str) -> bool {
    SHORT_DOMAINS.iter().any(|domain| domain_matches(host, domain))
}

pub(crate) fn parse_media_url(input: &str) -> Result<Url> {
    if input.len() > 8192 || input.chars().any(char::is_control) {
        bail!("链接过长或包含无效字符");
    }
    let url = Url::parse(input).map_err(|_| eyre::eyre!("链接格式无效"))?;
    if !matches!(url.scheme(), "http" | "https") || !url.username().is_empty() || url.password().is_some() {
        bail!("仅支持不含账号密码的 HTTP 或 HTTPS 链接");
    }
    let host = url.host_str().context("链接缺少域名")?;
    if host.ends_with('.') || host == "localhost" || host.ends_with(".localhost") || host.ends_with(".local") {
        bail!("不支持本机或内网媒体地址");
    }
    match url.host() {
        Some(Host::Ipv4(ip)) if !public_ip(IpAddr::V4(ip)) => bail!("不支持本机或内网媒体地址"),
        Some(Host::Ipv6(ip)) if !public_ip(IpAddr::V6(ip)) => bail!("不支持本机或内网媒体地址"),
        None => bail!("链接缺少域名"),
        _ => {}
    }
    Ok(url)
}

fn public_v4(ip: Ipv4Addr) -> bool {
    let [a, b, c, _] = ip.octets();
    !(ip.is_private()
        || ip.is_loopback()
        || ip.is_link_local()
        || ip.is_broadcast()
        || ip.is_documentation()
        || ip.is_multicast()
        || a == 0
        || a >= 240
        || (a == 100 && (64..=127).contains(&b))
        || (a == 192 && b == 0 && c == 0)
        || (a == 198 && (b == 18 || b == 19)))
}

fn public_v6(ip: Ipv6Addr) -> bool {
    if let Some(v4) = ip.to_ipv4_mapped() {
        return public_v4(v4);
    }
    let segments = ip.segments();
    // Globally routed unicast only. Exclude documentation and transition ranges.
    (segments[0] & 0xe000 == 0x2000)
        && segments[0] != 0x2002
        && !(segments[0] == 0x2001 && segments[1] < 0x0200)
        && !(segments[0] == 0x2001 && segments[1] == 0x0db8)
        && !(segments[0] == 0x3fff && segments[1] < 0x1000)
}

pub(crate) fn public_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => public_v4(ip),
        IpAddr::V6(ip) => public_v6(ip),
    }
}

async fn public_addresses(url: &Url) -> Result<Vec<SocketAddr>> {
    let host = url.host_str().context("链接缺少域名")?;
    let host = host.trim_matches(['[', ']']);
    let addresses = tokio::time::timeout(
        Duration::from_secs(10),
        tokio::net::lookup_host((host, url.port_or_known_default().unwrap_or(443))),
    )
    .await
    .map_err(|_| eyre::eyre!("域名解析超时"))?
    .map_err(|_| eyre::eyre!("无法解析媒体域名，请检查网络"))?
    .collect::<Vec<_>>();
    if addresses.is_empty() || addresses.iter().any(|address| !public_ip(address.ip())) {
        bail!("媒体域名指向本机、内网或不可用地址");
    }
    Ok(addresses)
}

async fn probe(url: &Url, addresses: &[SocketAddr]) -> Result<Response> {
    let client = Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(20))
        // Pin validated DNS answers, including each redirect. No proxy may resolve a different host.
        .no_proxy()
        .resolve_to_addrs(url.host_str().context("链接缺少域名")?, addresses)
        .user_agent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36")
        .build()
        .map_err(|_| eyre::eyre!("无法初始化媒体请求"))?;
    client
        .get(url.clone())
        .header(header::RANGE, "bytes=0-1023")
        .send()
        .await
        .map_err(|_| eyre::eyre!("无法连接媒体地址，请检查网络或稍后重试"))
}

fn media_content_type(value: &str) -> bool {
    let mime = value.split(';').next().unwrap_or_default().trim().to_ascii_lowercase();
    mime.starts_with("audio/")
        || mime.starts_with("video/")
        || matches!(
            mime.as_str(),
            "application/vnd.apple.mpegurl" | "application/x-mpegurl" | "application/dash+xml"
        )
}

fn media_signature(bytes: &[u8]) -> bool {
    bytes.starts_with(b"ID3")
        || bytes.starts_with(b"fLaC")
        || bytes.starts_with(b"OggS")
        || bytes.starts_with(&[0x1a, 0x45, 0xdf, 0xa3])
        || (bytes.len() >= 12 && (&bytes[4..8] == b"ftyp" || (&bytes[..4] == b"RIFF" && &bytes[8..12] == b"WAVE")))
        || (bytes.len() > 2 && bytes[0] == 0xff && bytes[1] & 0xe0 == 0xe0)
}

/// Public social links retain their exact query (e.g. Xiaohongshu's public share token).
/// A direct URL may carry opaque credentials, so only query-free direct URLs are persisted.
pub(crate) fn persistable_source(url: &Url) -> Option<String> {
    let signed = url.query_pairs().any(|(key, _)| {
        let key = key.to_ascii_lowercase();
        key.contains("signature")
            || key.starts_with("x-amz-")
            || key.starts_with("x-goog-")
            || matches!(
                key.as_str(),
                "sig" | "token" | "access_token" | "auth" | "authorization" | "expires" | "expire" | "wssecret" | "wstime"
            )
    });
    if signed || (!platform_host(url.host_str()?) && url.query().is_some()) {
        return None;
    }
    let mut source = url.clone();
    source.set_fragment(None);
    Some(source.to_string())
}

pub(crate) async fn prepare_media_source(input: &str) -> Result<MediaSource> {
    let original = parse_media_url(input)?;
    let source_url = persistable_source(&original);
    let mut url = original;
    for redirect_count in 0..=MAX_REDIRECTS {
        let addresses = public_addresses(&url).await?;
        let host = url.host_str().context("链接缺少域名")?;
        // Established platform pages are handled by their registered yt-dlp extractor.
        // Only application-managed short-link hops and direct-link probes are fetched here.
        if platform_host(host) && !short_host(host) {
            return Ok(MediaSource { url, source_url });
        }
        let mut response = probe(&url, &addresses).await?;
        if response.status().is_redirection() {
            if redirect_count == MAX_REDIRECTS {
                bail!("链接跳转次数过多");
            }
            let location = response
                .headers()
                .get(header::LOCATION)
                .and_then(|value| value.to_str().ok())
                .context("链接跳转地址无效")?;
            let target = url.join(location).map_err(|_| eyre::eyre!("链接跳转地址无效"))?;
            url = parse_media_url(target.as_str())?;
            continue;
        }
        if !response.status().is_success() {
            bail!(
                "媒体地址无法访问（HTTP {}），请确认链接有效且无需登录",
                response.status().as_u16()
            );
        }
        if media_content_type(
            response
                .headers()
                .get(header::CONTENT_TYPE)
                .and_then(|value| value.to_str().ok())
                .unwrap_or_default(),
        ) {
            return Ok(MediaSource { url, source_url });
        }
        // Some storage services use application/octet-stream even for media. Read at most
        // a short signature, never an unbounded body or a website supplied by the model.
        let mut prefix = Vec::new();
        while prefix.len() < 16 {
            let chunk = response.chunk().await.map_err(|_| eyre::eyre!("无法检查媒体内容"))?;
            let Some(chunk) = chunk else {
                break;
            };
            prefix.extend_from_slice(&chunk[..chunk.len().min(1024 - prefix.len())]);
        }
        if media_signature(&prefix) {
            return Ok(MediaSource { url, source_url });
        }
        bail!("该地址不是可识别的音视频直链，或所属平台暂不支持");
    }
    bail!("链接跳转次数过多")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_non_network_credential_and_private_urls() {
        for input in [
            "file:///tmp/test.mp4",
            "https://user:pass@example.com/a.mp4",
            "http://127.1/a",
            "http://[::1]/a",
            "http://localhost/a",
            "http://10.0.0.1/a",
            "http://[::ffff:192.168.1.1]/a",
            "http://example.com./a",
        ] {
            assert!(parse_media_url(input).is_err(), "accepted {input}");
        }
    }

    #[test]
    fn rejects_non_global_dns_answers_for_both_ip_families() {
        for address in [
            "0.0.0.0",
            "100.64.1.1",
            "169.254.169.254",
            "192.0.2.1",
            "198.18.0.1",
            "224.0.0.1",
            "240.0.0.1",
            "::",
            "fc00::1",
            "fe80::1",
            "2001:db8::1",
            "2002:7f00:1::",
        ] {
            assert!(!public_ip(address.parse().unwrap()), "accepted {address}");
        }
        for address in ["1.1.1.1", "8.8.8.8", "2606:4700:4700::1111"] {
            assert!(public_ip(address.parse().unwrap()));
        }
    }

    #[test]
    fn platform_matching_observes_domain_boundaries() {
        assert!(platform_host("www.bilibili.com"));
        assert!(platform_host("v.douyin.com"));
        assert!(!platform_host("evilyoutube.com"));
        assert!(!platform_host("youtube.com.example.org"));
    }

    #[test]
    fn source_history_omits_signatures_and_direct_query_strings() {
        for input in [
            "https://example.com/media?token=secret",
            "https://example.com/media?opaque=value",
            "https://www.youtube.com/watch?v=test&signature=secret",
        ] {
            assert_eq!(persistable_source(&Url::parse(input).unwrap()), None);
        }
        assert!(persistable_source(&Url::parse("https://www.youtube.com/watch?v=test").unwrap()).is_some());
        assert!(
            persistable_source(&Url::parse("https://www.xiaohongshu.com/explore/a?xsec_token=publicshare").unwrap()).is_some()
        );
    }

    #[test]
    fn identifies_media_by_type_or_signature_not_extension() {
        assert!(media_content_type("video/mp4; charset=binary"));
        assert!(media_content_type("application/vnd.apple.mpegurl"));
        assert!(media_signature(b"\0\0\0\x18ftypisom"));
        assert!(!media_content_type("text/html"));
        assert!(!media_signature(b"<html>not a video.mp4</html>"));
    }
}

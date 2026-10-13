//! HTTP client and error handling for AI provider requests (plan D12, R4, R10).
//!
//! Every client: no redirects (a 3xx is an error, so credentials and bodies never
//! follow a hop), bounded timeouts, and for plaintext http no system/env proxy and
//! `localhost` pinned to loopback. Errors never include URLs, hosts or bodies.

use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::time::Duration;

use url::Url;

use super::url_policy;

pub const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
pub const CHAT_TIMEOUT: Duration = Duration::from_secs(180);
pub const DISCOVERY_TIMEOUT: Duration = Duration::from_secs(15);

/// Upper bound for a model-list response body.
pub const DISCOVERY_MAX_BYTES: usize = 2 * 1024 * 1024;

/// Upper bound for a chat/agent completion response body.
pub const CHAT_MAX_BYTES: usize = 2 * 1024 * 1024;

pub fn client_for(url: &Url, timeout: Duration) -> Result<reqwest::Client, String> {
    let mut builder = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(CONNECT_TIMEOUT)
        .timeout(timeout);
    if url.scheme() == "http" {
        builder = builder.no_proxy();
    }
    if url_policy::is_localhost(url) {
        let port = url
            .port_or_known_default()
            .ok_or_else(|| url_policy::URL_INVALID.to_string())?;
        builder = builder.resolve(
            "localhost",
            SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), port),
        );
    }
    builder
        .build()
        .map_err(|_| "AI_HTTP_CLIENT_FAILED".to_string())
}

/// Maps a transport error to a stable code without leaking the URL.
pub fn request_error(error: &reqwest::Error) -> String {
    let reason = if error.is_timeout() {
        "timeout"
    } else if error.is_connect() {
        "connect"
    } else if error.is_redirect() {
        "redirect"
    } else if error.is_body() || error.is_decode() {
        "body"
    } else {
        "request"
    };
    format!("AI_CHAT_REQUEST_FAILED: {reason}")
}

/// Rejects redirects explicitly; with `Policy::none()` they surface as a 3xx response.
pub fn reject_redirect(status: reqwest::StatusCode) -> Result<(), String> {
    if status.is_redirection() {
        return Err(format!("AI_PROVIDER_REDIRECT_BLOCKED: {}", status.as_u16()));
    }
    Ok(())
}

/// Reads a response body, failing once it exceeds `max_bytes`.
pub async fn read_body_limited(
    mut response: reqwest::Response,
    max_bytes: usize,
) -> Result<String, String> {
    if response
        .content_length()
        .is_some_and(|len| len > max_bytes as u64)
    {
        return Err("AI_PROVIDER_RESPONSE_TOO_LARGE".into());
    }
    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|e| request_error(&e))? {
        if body.len() + chunk.len() > max_bytes {
            return Err("AI_PROVIDER_RESPONSE_TOO_LARGE".into());
        }
        body.extend_from_slice(&chunk);
    }
    String::from_utf8(body).map_err(|_| "AI_CHAT_RESPONSE_READ_FAILED: encoding".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;

    /// Serves `response` to the first `connections` clients on loopback.
    fn serve(response: &'static str, connections: usize) -> u16 {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        std::thread::spawn(move || {
            for stream in listener.incoming().take(connections) {
                let mut stream = stream.unwrap();
                let mut buf = [0u8; 4096];
                let _ = stream.read(&mut buf);
                let _ = stream.write_all(response.as_bytes());
            }
        });
        port
    }

    fn local_url(raw: &str) -> Url {
        url_policy::validate(raw, url_policy::ProviderClass::Local).unwrap()
    }

    #[tokio::test]
    async fn redirects_are_not_followed() {
        let port = serve(
            "HTTP/1.1 302 Found\r\nLocation: http://8.8.8.8/v1/models\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
            1,
        );
        let url = local_url(&format!("http://127.0.0.1:{port}/v1/models"));
        let client = client_for(&url, DISCOVERY_TIMEOUT).unwrap();
        let response = client.get(url).send().await.unwrap();
        assert_eq!(response.status().as_u16(), 302);
        assert!(reject_redirect(response.status())
            .unwrap_err()
            .starts_with("AI_PROVIDER_REDIRECT_BLOCKED"));
    }

    #[tokio::test]
    async fn localhost_is_pinned_to_loopback() {
        let port = serve(
            "HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok",
            1,
        );
        let url = local_url(&format!("http://localhost:{port}/v1/models"));
        let client = client_for(&url, DISCOVERY_TIMEOUT).unwrap();
        let response = client.get(url).send().await.unwrap();
        assert_eq!(read_body_limited(response, 16).await.unwrap(), "ok");
    }

    #[tokio::test]
    async fn body_limit_is_enforced() {
        let port = serve(
            "HTTP/1.1 200 OK\r\nContent-Length: 10\r\nConnection: close\r\n\r\n0123456789",
            1,
        );
        let url = local_url(&format!("http://127.0.0.1:{port}/v1/models"));
        let client = client_for(&url, DISCOVERY_TIMEOUT).unwrap();
        let response = client.get(url).send().await.unwrap();
        assert_eq!(
            read_body_limited(response, 4).await.unwrap_err(),
            "AI_PROVIDER_RESPONSE_TOO_LARGE"
        );
    }

    #[tokio::test]
    async fn connect_errors_do_not_leak_the_url() {
        // Bind then drop to get a closed loopback port.
        let port = TcpListener::bind("127.0.0.1:0")
            .unwrap()
            .local_addr()
            .unwrap()
            .port();
        let url = local_url(&format!("http://127.0.0.1:{port}/secret-path/v1"));
        let client = client_for(&url, DISCOVERY_TIMEOUT).unwrap();
        let error = client.get(url).send().await.unwrap_err();
        let message = request_error(&error);
        assert_eq!(message, "AI_CHAT_REQUEST_FAILED: connect");
        assert!(!message.contains("127.0.0.1") && !message.contains("secret-path"));
    }

    #[tokio::test]
    async fn http_requests_ignore_env_proxies() {
        let port = serve(
            "HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok",
            1,
        );
        // A proxy nobody listens on: using it would fail the request.
        let dead = TcpListener::bind("127.0.0.1:0")
            .unwrap()
            .local_addr()
            .unwrap()
            .port();
        let previous = std::env::var_os("HTTP_PROXY");
        std::env::set_var("HTTP_PROXY", format!("http://127.0.0.1:{dead}"));
        let url = local_url(&format!("http://127.0.0.1:{port}/v1/models"));
        let client = client_for(&url, DISCOVERY_TIMEOUT);
        match previous {
            Some(value) => std::env::set_var("HTTP_PROXY", value),
            None => std::env::remove_var("HTTP_PROXY"),
        }
        let response = client.unwrap().get(url).send().await.unwrap();
        assert_eq!(read_body_limited(response, 16).await.unwrap(), "ok");
    }
}

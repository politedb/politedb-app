//! Which AI provider URLs PoliteDB may call (plan D12).
//!
//! - `https`: any public or private host (cloud and local providers).
//! - `http`: local providers only, and only to IP literals in loopback/private ranges
//!   or the exact host `localhost` (pinned to loopback by the transport, no resolver).
//!
//! Hostnames other than `localhost` are rejected over http so DNS answers can never
//! steer a plaintext request (no rebinding, no `.local` mDNS lookups).

use std::net::{Ipv4Addr, Ipv6Addr};

use url::{Host, Url};

pub const URL_INVALID: &str = "AI_PROVIDER_URL_INVALID";
pub const HTTPS_REQUIRED: &str = "AI_PROVIDER_HTTPS_REQUIRED";
pub const HOST_NOT_ALLOWED: &str = "AI_PROVIDER_URL_HOST_NOT_ALLOWED";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ProviderClass {
    /// Hosted APIs (OpenAI, Anthropic, ...): https only.
    Cloud,
    /// User-run servers (Ollama, LM Studio, ...): https anywhere, http on loopback/LAN.
    Local,
}

/// Validates a provider base URL or a full request URL derived from it.
pub fn validate(raw: &str, class: ProviderClass) -> Result<Url, String> {
    let raw = raw.trim();
    let url = Url::parse(raw).map_err(|_| URL_INVALID.to_string())?;

    if !url.username().is_empty() || url.password().is_some() {
        return Err(URL_INVALID.into());
    }
    if url.query().is_some() || url.fragment().is_some() {
        return Err(URL_INVALID.into());
    }

    let host = url.host().ok_or_else(|| URL_INVALID.to_string())?;
    if let Host::Ipv4(addr) = host {
        // `url` canonicalizes `2130706433`, `0x7f.1`, `0177.0.0.1` to `127.0.0.1`.
        // Only accept the dotted-decimal form the user can actually read.
        if !raw_host(raw).is_some_and(|text| text == addr.to_string()) {
            return Err(URL_INVALID.into());
        }
    }
    if is_unspecified(&host) {
        return Err(HOST_NOT_ALLOWED.into());
    }

    match url.scheme() {
        "https" => Ok(url),
        "http" => match class {
            ProviderClass::Cloud => Err(HTTPS_REQUIRED.into()),
            ProviderClass::Local if http_host_allowed(&host) => Ok(url),
            ProviderClass::Local => Err(HOST_NOT_ALLOWED.into()),
        },
        _ => Err(URL_INVALID.into()),
    }
}

/// True when the transport must pin `localhost` to loopback instead of resolving it.
pub fn is_localhost(url: &Url) -> bool {
    matches!(url.host(), Some(Host::Domain("localhost")))
}

fn is_unspecified(host: &Host<&str>) -> bool {
    match host {
        Host::Ipv4(addr) => addr.is_unspecified(),
        Host::Ipv6(addr) => {
            addr.is_unspecified() || mapped_ipv4(addr).is_some_and(|v4| v4.is_unspecified())
        }
        Host::Domain(_) => false,
    }
}

fn http_host_allowed(host: &Host<&str>) -> bool {
    match host {
        Host::Domain(domain) => *domain == "localhost",
        Host::Ipv4(addr) => ipv4_allowed(addr),
        Host::Ipv6(addr) => match mapped_ipv4(addr) {
            Some(v4) => ipv4_allowed(&v4),
            None => addr.is_loopback() || is_unique_local(addr),
        },
    }
}

fn ipv4_allowed(addr: &Ipv4Addr) -> bool {
    addr.is_loopback() || addr.is_private()
}

/// `fc00::/7` (unique local addresses).
fn is_unique_local(addr: &Ipv6Addr) -> bool {
    (addr.segments()[0] & 0xfe00) == 0xfc00
}

/// Embedded IPv4 of an IPv4-mapped address (`::ffff:a.b.c.d`).
fn mapped_ipv4(addr: &Ipv6Addr) -> Option<Ipv4Addr> {
    match addr.segments() {
        [0, 0, 0, 0, 0, 0xffff, hi, lo] => Some(Ipv4Addr::new(
            (hi >> 8) as u8,
            hi as u8,
            (lo >> 8) as u8,
            lo as u8,
        )),
        _ => None,
    }
}

/// Host text exactly as typed (lowercased), without scheme, port or path.
fn raw_host(raw: &str) -> Option<String> {
    let after_scheme = raw.split_once("://")?.1;
    let authority = after_scheme
        .split(['/', '?', '#', '\\'])
        .next()
        .unwrap_or_default();
    let host = if authority.starts_with('[') {
        authority.split_once(']').map(|(h, _)| format!("{h}]"))?
    } else {
        authority
            .rsplit_once(':')
            .map_or(authority, |(h, _)| h)
            .to_string()
    };
    Some(host.to_ascii_lowercase())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn local(raw: &str) -> Result<Url, String> {
        validate(raw, ProviderClass::Local)
    }

    fn cloud(raw: &str) -> Result<Url, String> {
        validate(raw, ProviderClass::Cloud)
    }

    #[test]
    fn local_http_allows_loopback_lan_and_localhost() {
        for url in [
            "http://127.0.0.1:1234/v1",
            "http://127.8.9.10:11434/v1",
            "http://localhost:11434/v1",
            "http://LOCALHOST:1234/v1",
            "http://10.0.0.5:1234/v1",
            "http://172.16.0.1/v1",
            "http://172.31.255.254/v1",
            "http://192.168.1.20:1234/v1",
            "http://[::1]:1234/v1",
            "http://[fd12:3456::1]:8080/v1",
            "http://[::ffff:192.168.1.2]:1234/v1",
        ] {
            assert!(local(url).is_ok(), "{url} should be allowed");
        }
    }

    #[test]
    fn local_http_rejects_public_and_special_hosts() {
        for url in [
            "http://8.8.8.8/v1",
            "http://172.32.0.1/v1",
            "http://169.254.169.254/latest",
            "http://224.0.0.1/v1",
            "http://255.255.255.255/v1",
            "http://[2001:4860:4860::8888]/v1",
            "http://[fe80::1]/v1",
            "http://[::ffff:8.8.8.8]/v1",
            "http://example.com/v1",
            "http://my-pc.local:1234/v1",
            "http://localhost.example.com/v1",
            "http://127.0.0.1.nip.io/v1",
        ] {
            assert_eq!(local(url).unwrap_err(), HOST_NOT_ALLOWED, "{url}");
        }
    }

    #[test]
    fn rejects_unspecified_addresses_for_any_scheme() {
        for url in [
            "http://0.0.0.0:1234/v1",
            "https://0.0.0.0/v1",
            "http://[::]:1234/v1",
            "http://[::ffff:0.0.0.0]/v1",
        ] {
            assert_eq!(local(url).unwrap_err(), HOST_NOT_ALLOWED, "{url}");
        }
    }

    #[test]
    fn rejects_non_canonical_ipv4_spellings() {
        for url in [
            "http://2130706433/v1",
            "http://0x7f000001/v1",
            "http://0177.0.0.1/v1",
            "http://127.1/v1",
            "http://0x7f.0.0.1/v1",
            "https://3232235777/v1",
        ] {
            assert_eq!(local(url).unwrap_err(), URL_INVALID, "{url}");
        }
    }

    #[test]
    fn rejects_credentials_query_fragment_and_other_schemes() {
        for url in [
            "http://user:pass@127.0.0.1:1234/v1",
            "http://user@localhost/v1",
            "http://127.0.0.1:1234/v1?key=secret",
            "http://127.0.0.1:1234/v1#frag",
            "ftp://127.0.0.1/v1",
            "file:///etc/passwd",
            "127.0.0.1:1234/v1",
            "not a url",
            "",
        ] {
            assert_eq!(local(url).unwrap_err(), URL_INVALID, "{url}");
        }
    }

    #[test]
    fn https_allows_any_named_or_ip_host() {
        assert!(local("https://llm.example.com/v1").is_ok());
        assert!(local("https://my-pc.local:8443/v1").is_ok());
        assert!(local("https://8.8.8.8/v1").is_ok());
        assert!(cloud("https://api.openai.com/v1").is_ok());
    }

    #[test]
    fn cloud_requires_https_even_on_loopback() {
        assert_eq!(
            cloud("http://127.0.0.1:1234/v1").unwrap_err(),
            HTTPS_REQUIRED
        );
        assert_eq!(
            cloud("http://api.openai.com/v1").unwrap_err(),
            HTTPS_REQUIRED
        );
    }

    #[test]
    fn rejects_ipv6_zone_ids() {
        assert!(local("http://[fe80::1%25en0]:1234/v1").is_err());
    }

    #[test]
    fn localhost_detection_is_exact() {
        assert!(is_localhost(&local("http://localhost:1234/v1").unwrap()));
        assert!(!is_localhost(&local("http://127.0.0.1:1234/v1").unwrap()));
        assert!(!is_localhost(
            &local("https://localhost.example.com/v1").unwrap()
        ));
    }
}

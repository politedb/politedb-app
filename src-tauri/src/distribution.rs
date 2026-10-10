//! Build flavor (direct download vs Mac App Store) and the features each flavor allows.
//!
//! The flavor is fixed at compile time by the `app-store` Cargo feature. Callers ask
//! capability questions here instead of checking the feature flag themselves.

use crate::types::EngineKind;

/// Error code returned by commands that are compiled in but disabled for this flavor.
pub const FEATURE_UNAVAILABLE: &str = "FEATURE_UNAVAILABLE_IN_DISTRIBUTION";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Distribution {
    /// Developer ID signed DMG / installers downloaded from the website.
    Direct,
    /// Sandboxed Mac App Store build.
    AppStore,
}

impl Distribution {
    pub const fn current() -> Self {
        if cfg!(feature = "app-store") {
            Self::AppStore
        } else {
            Self::Direct
        }
    }

    /// In-app updater (App Store guideline 2.4.5 forbids self-updating).
    pub const fn supports_self_update(self) -> bool {
        matches!(self, Self::Direct)
    }

    /// Website-issued 14-day trial. App Store builds use subscription intro offers instead.
    pub const fn supports_local_trial(self) -> bool {
        matches!(self, Self::Direct)
    }

    /// Whether `license_open_external_url` may open `url`. App Store builds open only
    /// support destinations, never purchase or donation pages (guideline 3.1.1).
    pub fn allows_external_url(self, url: &str) -> bool {
        match self {
            Self::Direct => true,
            Self::AppStore => is_app_store_safe_url(url),
        }
    }

    /// Engines whose client libraries cannot load inside the App Store sandbox are excluded.
    pub const fn supports_engine(self, kind: EngineKind) -> bool {
        match self {
            Self::Direct => true,
            Self::AppStore => !matches!(kind, EngineKind::Oracle),
        }
    }
}

/// HTTPS destinations (host, path prefix) an App Store build may open.
const APP_STORE_HTTPS_ALLOWLIST: &[(&str, &str)] = &[("github.com", "/politedb/PoliteDB/issues")];

fn is_app_store_safe_url(raw: &str) -> bool {
    // Parsing normalizes dot segments, so `/issues/../../sponsors` cannot slip past the prefix.
    let Ok(url) = url::Url::parse(raw.trim()) else {
        return false;
    };
    match url.scheme() {
        "mailto" => true,
        "https" => {
            if !url.username().is_empty() || url.password().is_some() || url.port().is_some() {
                return false;
            }
            let host = url.host_str().unwrap_or_default();
            let path = url.path();
            APP_STORE_HTTPS_ALLOWLIST
                .iter()
                .any(|(allowed_host, prefix)| {
                    host.eq_ignore_ascii_case(allowed_host)
                        && (path == *prefix
                            || path
                                .strip_prefix(prefix)
                                .is_some_and(|rest| rest.starts_with('/')))
                })
        }
        _ => false,
    }
}

/// Returns `FEATURE_UNAVAILABLE` when `allowed` is false, for use at command boundaries.
pub fn ensure(allowed: bool) -> Result<(), String> {
    if allowed {
        Ok(())
    } else {
        Err(FEATURE_UNAVAILABLE.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn direct_allows_everything() {
        let d = Distribution::Direct;
        assert!(d.supports_self_update());
        assert!(d.supports_engine(EngineKind::Oracle));
        assert!(d.supports_engine(EngineKind::Postgres));
    }

    #[test]
    fn app_store_disables_updater_and_oracle() {
        let d = Distribution::AppStore;
        assert!(!d.supports_self_update());
        assert!(!d.supports_engine(EngineKind::Oracle));
        assert!(d.supports_engine(EngineKind::Postgres));
        assert!(d.supports_engine(EngineKind::Sqlite));
    }

    #[test]
    fn local_trial_only_in_direct() {
        assert!(Distribution::Direct.supports_local_trial());
        assert!(!Distribution::AppStore.supports_local_trial());
    }

    #[test]
    fn direct_opens_any_url_as_before() {
        let d = Distribution::Direct;
        assert!(d.allows_external_url("https://politedb.com/pricing"));
        assert!(d.allows_external_url("https://github.com/sponsors/tonyphamvn"));
    }

    #[test]
    fn app_store_blocks_purchase_and_donation_urls() {
        let d = Distribution::AppStore;
        for url in [
            "https://politedb.com/pricing",
            "https://politedb.com/checkout?plan=pro",
            "https://github.com/sponsors/tonyphamvn",
            "https://github.com/politedb/PoliteDB/issues/../../../sponsors/tonyphamvn",
            "https://github.com/politedb/PoliteDB/issues/%2e%2e/%2e%2e/%2e%2e/sponsors/x",
            "https://github.com/politedb/PoliteDB/issuesX",
            "https://evil.example/politedb/PoliteDB/issues/new",
            "https://user@github.com/politedb/PoliteDB/issues/new",
            "https://github.com:8443/politedb/PoliteDB/issues/new",
            "http://github.com/politedb/PoliteDB/issues/new",
            "file:///etc/passwd",
            "javascript:alert(1)",
            "not a url",
            "",
        ] {
            assert!(!d.allows_external_url(url), "{url} should be blocked");
        }
    }

    #[test]
    fn app_store_allows_support_destinations() {
        let d = Distribution::AppStore;
        assert!(d.allows_external_url(
            "https://github.com/politedb/PoliteDB/issues/new?template=bug_report.md"
        ));
        assert!(d.allows_external_url(
            "https://github.com/politedb/PoliteDB/issues/new?template=feature_request.md"
        ));
        assert!(d.allows_external_url("mailto:support@politedb.com?subject=Lost%20key&body=hi"));
    }

    #[test]
    fn current_matches_cargo_feature() {
        let expected = if cfg!(feature = "app-store") {
            Distribution::AppStore
        } else {
            Distribution::Direct
        };
        assert_eq!(Distribution::current(), expected);
    }

    #[test]
    fn ensure_maps_disabled_to_error_code() {
        assert!(ensure(true).is_ok());
        assert_eq!(ensure(false).unwrap_err(), FEATURE_UNAVAILABLE);
    }
}

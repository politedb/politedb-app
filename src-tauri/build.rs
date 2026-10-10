fn main() {
    check_distribution_consistency();
    tauri_build::build()
}

/// The `app-store` Cargo feature and `tauri.appstore.conf.json` must be used together.
/// Tauri CLI passes the `--config` override in `TAURI_CONFIG`; the MAS config is the one
/// that selects the `appstore` capability. tauri-build then rejects any mismatch between
/// `macOSPrivateApi` and the `tauri` crate features, so a consistent pair also guarantees
/// the private API is compiled out of App Store artifacts.
fn check_distribution_consistency() {
    println!("cargo:rerun-if-env-changed=TAURI_CONFIG");
    let feature_enabled = std::env::var_os("CARGO_FEATURE_APP_STORE").is_some();

    let Ok(raw) = std::env::var("TAURI_CONFIG") else {
        if feature_enabled {
            println!(
                "cargo:warning=`app-store` built without Tauri CLI: macos-private-api stays enabled. \
                 Use scripts/tauri-appstore.sh for App Store artifacts."
            );
        }
        return;
    };

    let config_is_app_store = serde_json::from_str::<serde_json::Value>(&raw)
        .ok()
        .and_then(|config| {
            config
                .pointer("/app/security/capabilities")
                .and_then(|caps| caps.as_array())
                .map(|caps| caps.iter().any(|cap| cap == "appstore"))
        })
        .unwrap_or(false);

    if feature_enabled != config_is_app_store {
        panic!(
            "Distribution mismatch: `app-store` Cargo feature is {} but tauri.appstore.conf.json is {}. \
             Build the App Store flavor with scripts/tauri-appstore.sh.",
            if feature_enabled { "on" } else { "off" },
            if config_is_app_store { "in use" } else { "not in use" },
        );
    }
}

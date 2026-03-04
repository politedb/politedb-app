use anyhow::anyhow;

use crate::types::RedisConnectInput;

pub fn build_redis_url(input: &RedisConnectInput, password: &str) -> anyhow::Result<String> {
    if input.host.trim().is_empty() {
        return Err(anyhow!("REDIS_HOST_REQUIRED"));
    }
    if input.port == 0 {
        return Err(anyhow!("REDIS_PORT_INVALID"));
    }

    let ssl_mode = input.ssl_mode.as_deref().unwrap_or("disable");
    let scheme = match ssl_mode {
        "disable" => "redis",
        "prefer" | "require" => "rediss",
        _ => return Err(anyhow!("INVALID_SSL_MODE")),
    };

    // Redis ACL user (optional)
    let user = input.user.as_deref().unwrap_or("");
    let db = input.db.unwrap_or(0);

    // URL-encode password (IMPORTANT)
    let pw_enc = urlencoding::encode(password);

    // ACL: redis://user:pass@host:port/db
    // No ACL: redis://:pass@host:port/db
    let auth = if !user.is_empty() {
        format!("{user}:{pw_enc}@")
    } else {
        format!(":{pw_enc}@")
    };

    Ok(format!(
        "{scheme}://{auth}{}:{}/{}",
        input.host, input.port, db
    ))
}

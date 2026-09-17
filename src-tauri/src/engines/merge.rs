use crate::{
    ssh_tunnel::types::SshAuth,
    types::{ConnectionCreateInput, ConnectionTestSecrets, SecretRef, SecretRefKind},
};

fn non_empty(s: &Option<String>) -> Option<String> {
    s.as_ref()
        .map(|x| x.trim().to_string())
        .filter(|x| !x.is_empty())
}

pub fn inline_db_pw(secrets: &Option<ConnectionTestSecrets>) -> Option<String> {
    secrets.as_ref().and_then(|s| non_empty(&s.db_password))
}

// pub fn inline_ssh_pw(secrets: &Option<ConnectionTestSecrets>) -> Option<String> {
//     secrets.as_ref().and_then(|s| non_empty(&s.ssh_password))
// }

// password override rule:
// 1) if secrets provides plaintext => force Inline
// 2) else if ov is Inline and non-empty => use ov
// 3) else keep base (usually Keychain ref)
pub fn merge_secret_ref_for_test(
    base: &mut SecretRef,
    ov: &SecretRef,
    inline_override: Option<&String>,
) {
    if let Some(pw) = inline_override {
        *base = SecretRef {
            kind: SecretRefKind::Inline,
            value: pw.clone(),
        };
        return;
    }

    if ov.kind == SecretRefKind::Inline && !ov.value.trim().is_empty() {
        *base = ov.clone();
    }
}

fn merge_ssh_auth_for_test(
    base: &mut SshAuth,
    ov: SshAuth,
    secrets: &Option<ConnectionTestSecrets>,
) {
    match (base, ov) {
        // ===== Password -> Password =====
        (SshAuth::Password { password: base_pw }, SshAuth::Password { password: ov_pw }) => {
            if let Some(secrets_pw) = secrets
                .as_ref()
                .and_then(|s| s.ssh_password.as_ref())
                .map(|s| s.trim())
                .filter(|s| !s.is_empty())
            {
                // 1️⃣ plaintext from secrets (test-only)
                *base_pw = secrets_pw.to_string();
            } else if !ov_pw.trim().is_empty() {
                // 2️⃣ override from FE
                *base_pw = ov_pw;
            }
            // 3️⃣ else: keep base_pw
        }

        // ===== Auth type changed (Password <-> PrivateKey) =====
        // FE changed auth type → follow FE
        (base_auth, ov_auth) => {
            *base_auth = ov_auth;

            if let SshAuth::Password { password } = base_auth {
                if let Some(secrets_pw) = secrets
                    .as_ref()
                    .and_then(|s| s.ssh_password.as_ref())
                    .map(|s| s.trim())
                    .filter(|s| !s.is_empty())
                {
                    *password = secrets_pw.to_string();
                }
            }
        }
    }
}

// SSH merge: common across all engines

pub fn merge_ssh_for_test(
    mut base: ConnectionCreateInput,
    ov: &ConnectionCreateInput,
    secrets: &Option<ConnectionTestSecrets>,
) -> ConnectionCreateInput {
    let Some(mut ssh_base) = base.ssh.take() else {
        if let Some(mut s) = ov.ssh.clone() {
            if let SshAuth::Password { password } = &mut s.auth {
                if let Some(pw) = secrets
                    .as_ref()
                    .and_then(|s| s.ssh_password.as_ref())
                    .map(|s| s.trim())
                    .filter(|s| !s.is_empty())
                {
                    *password = pw.to_string();
                }
            }
            base.ssh = Some(s);
        }
        return base;
    };

    if let Some(ssh_ov) = ov.ssh.clone() {
        // override
        ssh_base.ssh_host = ssh_ov.ssh_host;
        ssh_base.ssh_port = ssh_ov.ssh_port;
        ssh_base.ssh_user = ssh_ov.ssh_user;
        ssh_base.remote_host = ssh_ov.remote_host;
        ssh_base.remote_port = ssh_ov.remote_port;
        ssh_base.strict_host_key_checking = ssh_ov.strict_host_key_checking;
        ssh_base.connect_timeout_ms = ssh_ov.connect_timeout_ms;

        // merge auth
        merge_ssh_auth_for_test(&mut ssh_base.auth, ssh_ov.auth, secrets);
    } else if let SshAuth::Password { password } = &mut ssh_base.auth {
        if let Some(pw) = secrets
            .as_ref()
            .and_then(|s| s.ssh_password.as_ref())
            .map(|s| s.trim())
            .filter(|s| !s.is_empty())
        {
            *password = pw.to_string();
        }
    }

    base.ssh = Some(ssh_base);
    base
}

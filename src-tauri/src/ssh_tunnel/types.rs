use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SshAuth {
    /// Authenticate using an identity file (private key).
    PrivateKey {
        /// Path to private key file, e.g. ~/.ssh/id_ed25519
        identity_file: String,
        /// Optional passphrase for encrypted private key (NOT the SSH password).
        passphrase: Option<String>,
    },

    /// Authenticate using username + password (no interactive prompt).
    Password { password: String },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SshTunnelInput {
    pub ssh_host: String,
    pub ssh_port: u16,
    pub ssh_user: Option<String>,

    pub auth: SshAuth,

    pub remote_host: String,
    pub remote_port: u16,

    /// "accept-new" | "yes" | "no"
    pub strict_host_key_checking: Option<String>,

    /// Connect timeout for SSH handshake + auth.
    pub connect_timeout_ms: Option<u64>,
}

impl SshTunnelInput {
    pub fn validate(&self) -> Result<(), String> {
        if self.ssh_host.trim().is_empty() {
            return Err("ssh_host is required".into());
        }
        if self.ssh_port == 0 {
            return Err("ssh_port is invalid".into());
        }
        if self.remote_host.trim().is_empty() {
            return Err("remote_host is required".into());
        }
        if self.remote_port == 0 {
            return Err("remote_port is invalid".into());
        }

        match &self.auth {
            SshAuth::PrivateKey { identity_file, .. } => {
                if identity_file.trim().is_empty() {
                    return Err("identity_file is required for public_key auth".into());
                }
            }
            SshAuth::Password { password } => {
                if password.is_empty() {
                    return Err("password is required for password auth".into());
                }
            }
        }

        Ok(())
    }
}

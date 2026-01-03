use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SshTunnelInput {
    pub ssh_host: String,
    pub ssh_port: u16,

    pub ssh_user: Option<String>,

    pub remote_host: String,
    pub remote_port: u16,

    pub identity_file: Option<String>,

    // "accept-new" | "yes" | "no"
    pub strict_host_key_checking: Option<String>,

    // Optional extra options
    pub connect_timeout_ms: Option<u64>,
}

impl SshTunnelInput {
    pub fn validate(&self) -> Result<(), String> {
        if self.ssh_host.trim().is_empty() {
            return Err("SSH_HOST_REQUIRED".into());
        }
        if self.ssh_port == 0 {
            return Err("SSH_PORT_INVALID".into());
        }
        if self.remote_host.trim().is_empty() {
            return Err("SSH_REMOTE_HOST_REQUIRED".into());
        }
        if self.remote_port == 0 {
            return Err("SSH_REMOTE_PORT_INVALID".into());
        }
        Ok(())
    }
}

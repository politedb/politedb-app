use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::profiles::types::ConnectionProfile;
use crate::types::{ConnectionCreateInput, ConnectionInfo as AppConnectionInfo};

#[derive(Deserialize)]
#[serde(tag = "mode", rename_all = "snake_case")]
pub enum ProfileSaveAndConnectInput {
    Create {
        profile_id: Uuid,
        persist_secrets: bool,
        input: ConnectionCreateInput,
    },
    Update {
        profile_id: Uuid,
        persist_secrets: bool,
        input: ConnectionCreateInput,
    },
}

#[derive(Deserialize)]
#[serde(tag = "mode", rename_all = "snake_case")]
pub enum ProfileSaveInput {
    Create {
        profile_id: Uuid,
        persist_secrets: bool,
        input: ConnectionCreateInput,
    },
    Update {
        profile_id: Uuid,
        persist_secrets: bool,
        input: ConnectionCreateInput,
    },
}

#[derive(serde::Serialize)]
pub struct ProfileSaveAndConnectResult {
    pub profile: ConnectionProfile,
    pub connection: AppConnectionInfo,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProfileExportFile {
    pub version: u32,
    pub exported_at: i64,
    pub profiles: Vec<ConnectionProfile>,

    /// `sharing` when secrets were redacted for cross-device handoff.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub export_mode: Option<String>,

    #[serde(default)]
    pub secrets_redacted: bool,

    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub sharing_checklist: Vec<String>,

    #[serde(default)]
    pub included_db_password: bool,

    #[serde(default)]
    pub included_ssh_password: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProfileImportPayload {
    pub json: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProfileImportResult {
    pub created: usize,
    pub updated: usize,
    pub total: usize,
    pub profiles: Vec<ConnectionProfile>,
}

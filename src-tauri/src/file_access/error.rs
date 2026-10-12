//! Path-free error codes shared with the frontend (`src/lib/file-access`).

use serde::{Deserialize, Serialize};

/// What a grant is for. Database grants cover the folder holding the database (its
/// journal/WAL files live next to it, plan D17); SSH key grants are read-only.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Role {
    DatabaseFolder,
    SshKey,
}

impl Role {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::DatabaseFolder => "database_folder",
            Self::SshKey => "ssh_key",
        }
    }

    pub const fn read_only(self) -> bool {
        matches!(self, Self::SshKey)
    }
}

/// No usable grant: the frontend offers the picker and retries once (plan D19).
pub fn required(role: Role) -> String {
    format!(r#"FILE_ACCESS_REQUIRED:{{"role":"{}"}}"#, role.as_str())
}

/// The granted file or its volume is gone; picking again would not help.
pub fn unavailable(role: Role) -> String {
    format!(r#"FILE_ACCESS_UNAVAILABLE:{{"role":"{}"}}"#, role.as_str())
}

pub const DENIED: &str = "FILE_ACCESS_DENIED";
pub const WRONG_FILE: &str = "FILE_ACCESS_WRONG_FILE";
pub const FOLDER_TOO_BROAD: &str = "FILE_ACCESS_FOLDER_TOO_BROAD";
pub const UNSUPPORTED_ITEM: &str = "FILE_ACCESS_UNSUPPORTED_ITEM";
pub const INVALID_PATH: &str = "FILE_ACCESS_INVALID_PATH";
pub const STORE_IO: &str = "FILE_ACCESS_STORE_IO";
pub const STORE_CORRUPT: &str = "FILE_ACCESS_STORE_CORRUPT";
pub const PANEL_FAILED: &str = "FILE_ACCESS_PANEL_FAILED";

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn codes_are_path_free_json() {
        assert_eq!(
            required(Role::DatabaseFolder),
            r#"FILE_ACCESS_REQUIRED:{"role":"database_folder"}"#
        );
        assert_eq!(
            unavailable(Role::SshKey),
            r#"FILE_ACCESS_UNAVAILABLE:{"role":"ssh_key"}"#
        );
    }
}

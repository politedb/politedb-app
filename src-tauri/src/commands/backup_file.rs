//! Thin commands for backup files (see `backup_file`). Each runs its file
//! work with `block_in_place`, off the IPC thread and without copying the
//! backup's bytes.

use std::path::PathBuf;

use tauri::ipc::{InvokeBody, Request};
use uuid::Uuid;

use crate::backup_file::{backup_files, NOT_FOUND};

fn blocking<T>(f: impl FnOnce() -> T) -> T {
    tokio::task::block_in_place(f)
}

#[tauri::command]
pub async fn backup_file_begin(path: String) -> Result<Uuid, String> {
    blocking(|| backup_files().begin(PathBuf::from(path)))
}

/// The session id in the `x-session-id` header and the bytes as the raw
/// body (no JSON number array for a large backup).
fn write_request<'a>(
    session_header: Option<&str>,
    body: &'a InvokeBody,
) -> Result<(Uuid, &'a [u8]), String> {
    let id = session_header
        .and_then(|v| Uuid::parse_str(v).ok())
        .ok_or(NOT_FOUND)?;
    match body {
        InvokeBody::Raw(bytes) => Ok((id, bytes)),
        InvokeBody::Json(_) => Err("BACKUP_FILE_BODY_INVALID".into()),
    }
}

#[tauri::command]
pub async fn backup_file_write(request: Request<'_>) -> Result<(), String> {
    let header = request
        .headers()
        .get("x-session-id")
        .and_then(|v| v.to_str().ok());
    let (id, bytes) = write_request(header, request.body())?;
    blocking(|| backup_files().write(id, bytes))
}

#[tauri::command]
pub async fn backup_file_publish(session_id: Uuid) -> Result<(), String> {
    blocking(|| backup_files().publish(session_id))
}

#[tauri::command]
pub async fn backup_file_abort(session_id: Uuid) -> Result<(), String> {
    blocking(|| backup_files().abort(session_id))
}

#[tauri::command]
pub async fn backup_file_forget(session_id: Uuid) -> Result<(), String> {
    blocking(|| backup_files().forget(session_id))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_write_needs_a_session_header_and_a_raw_body() {
        let id = Uuid::new_v4();
        let raw = InvokeBody::Raw(vec![0, 159, 255]);
        let (got, bytes) = write_request(Some(&id.to_string()), &raw).unwrap();
        assert_eq!(got, id);
        assert_eq!(bytes, &[0, 159, 255]);
        assert_eq!(write_request(None, &raw), Err(NOT_FOUND.to_string()));
        assert_eq!(
            write_request(Some("not-a-uuid"), &raw),
            Err(NOT_FOUND.to_string())
        );
        let json = InvokeBody::Json(serde_json::json!([1, 2, 3]));
        assert_eq!(
            write_request(Some(&id.to_string()), &json),
            Err("BACKUP_FILE_BODY_INVALID".to_string())
        );
    }

    /// The file work runs inside block_in_place: with a single runtime
    /// worker, an unrelated task still runs while that work is held. A
    /// plain synchronous call there would hold the only worker, and the
    /// unrelated task would never run.
    #[tokio::test(flavor = "multi_thread", worker_threads = 1)]
    async fn file_work_does_not_hold_the_only_worker() {
        use std::sync::mpsc;
        use std::time::Duration;

        let (entered_tx, entered_rx) = mpsc::channel::<()>();
        let (release_tx, release_rx) = mpsc::channel::<()>();
        // Lets the held work go even if an assertion fails first.
        struct Release(mpsc::Sender<()>);
        impl Drop for Release {
            fn drop(&mut self) {
                let _ = self.0.send(());
            }
        }
        let release = Release(release_tx);

        let held = tokio::spawn(async move {
            blocking(move || {
                entered_tx.send(()).unwrap();
                let _ = release_rx.recv_timeout(Duration::from_secs(10));
            })
        });
        tokio::task::spawn_blocking(move || entered_rx.recv_timeout(Duration::from_secs(5)))
            .await
            .unwrap()
            .expect("the held work started");

        let other = tokio::spawn(async { "ran" });
        let ran = tokio::time::timeout(Duration::from_secs(5), other).await;
        assert_eq!(
            ran.map(|r| r.unwrap()),
            Ok("ran"),
            "an unrelated task ran while the file work was held"
        );
        assert!(!held.is_finished(), "still held");
        drop(release);
        held.await.unwrap();
    }
}

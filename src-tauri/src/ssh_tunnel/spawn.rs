use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::time::Duration;

use anyhow::anyhow;
use tokio::io::AsyncReadExt;
use tokio::net::{TcpListener, TcpStream};
use tokio::process::Command;

use super::handle::SshTunnelHandle;
use super::types::SshTunnelInput;

async fn pick_free_local_addr() -> anyhow::Result<SocketAddr> {
    let addr = SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 0);
    let listener = TcpListener::bind(addr).await?;
    Ok(listener.local_addr()?)
}

fn strict_mode(s: Option<&str>) -> &str {
    match s.unwrap_or("accept-new") {
        "accept-new" => "accept-new",
        "yes" => "yes",
        "no" => "no",
        _ => "accept-new",
    }
}

pub async fn open_tunnel(input: &SshTunnelInput) -> anyhow::Result<SshTunnelHandle> {
    input.validate().map_err(|e| anyhow!(e))?;

    let local_addr = pick_free_local_addr().await?;
    let local_bind = format!("127.0.0.1:{}", local_addr.port());

    let forward = format!(
        "{local_bind}:{}:{}",
        input.remote_host.trim(),
        input.remote_port
    );

    let mut cmd = Command::new("ssh");

    cmd.arg("-N");

    // Local forward
    cmd.arg("-L").arg(forward);

    // Port SSH
    cmd.arg("-p").arg(input.ssh_port.to_string());

    cmd.arg("-o").arg("BatchMode=yes");
    cmd.arg("-o").arg("NumberOfPasswordPrompts=0");
    cmd.arg("-o").arg("PasswordAuthentication=no");
    cmd.arg("-o").arg("KbdInteractiveAuthentication=no");
    cmd.arg("-o").arg("PreferredAuthentications=publickey");

    // Fail-fast + keepalive
    cmd.arg("-o").arg("ExitOnForwardFailure=yes");
    cmd.arg("-o").arg("ConnectTimeout=5");
    cmd.arg("-o").arg("ServerAliveInterval=30");
    cmd.arg("-o").arg("ServerAliveCountMax=3");
    cmd.arg("-o").arg("TCPKeepAlive=yes");
    cmd.arg("-o").arg("LogLevel=ERROR");

    // Host key policy
    let strict = strict_mode(input.strict_host_key_checking.as_deref());
    cmd.arg("-o").arg(format!("StrictHostKeyChecking={strict}"));

    // Optional identity file
    if let Some(p) = input.identity_file.as_deref() {
        let p = p.trim();
        if !p.is_empty() {
            cmd.arg("-i").arg(p);
            cmd.arg("-o").arg("IdentitiesOnly=yes");
        }
    }

    // user@host
    let dest = match input.ssh_user.as_deref() {
        Some(u) if !u.trim().is_empty() => format!("{}@{}", u.trim(), input.ssh_host.trim()),
        _ => input.ssh_host.trim().to_string(),
    };
    cmd.arg(dest);

    cmd.stdout(std::process::Stdio::null());
    cmd.stderr(std::process::Stdio::piped());

    let mut child = cmd.spawn()?;

    let timeout = input.connect_timeout_ms.unwrap_or(5_000).clamp(500, 30_000);
    let deadline = tokio::time::Instant::now() + Duration::from_millis(timeout);

    loop {
        if let Some(status) = child.try_wait()? {
            let err = if let Some(mut stderr) = child.stderr.take() {
                let mut buf = Vec::new();
                let _ = stderr.read_to_end(&mut buf).await;
                String::from_utf8_lossy(&buf).to_string()
            } else {
                "".to_string()
            };

            return Err(anyhow!(
                "SSH_TUNNEL_FAILED: status={status}, stderr={}",
                err.trim()
            ));
        }

        // Tunnel OK => break
        match TcpStream::connect(local_addr).await {
            Ok(s) => {
                drop(s);
                break;
            }
            Err(_) => {
                if tokio::time::Instant::now() >= deadline {
                    let _ = child.kill().await;
                    let _ = child.wait().await;
                    return Err(anyhow!("SSH_TUNNEL_TIMEOUT"));
                }
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
        }
    }

    Ok(SshTunnelHandle::new(local_addr, child))
}

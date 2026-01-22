use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::{IpAddr, Ipv4Addr, SocketAddr, TcpListener, TcpStream, ToSocketAddrs};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use anyhow::anyhow;
use ssh2::{CheckResult, HostKeyType, Session};

use super::handle::SshTunnelHandle;
use super::types::{SshAuth, SshTunnelInput};

// =============================================================================
// Constants & Configuration
// =============================================================================

const MAX_CHANNELS: usize = 1024;
const IO_BUF_CAP: usize = 256 * 1024;
const LOCAL_READ_CHUNK: usize = 32 * 1024;
const SSH_READ_CHUNK: usize = 32 * 1024;

const OPEN_CHANNEL_TIMEOUT: Duration = Duration::from_millis(5_000);

const TICK_SLEEP_IDLE: Duration = Duration::from_millis(5);
const TICK_SLEEP_ACTIVE: Duration = Duration::from_micros(50);

const ACCEPT_QUEUE_CAP: usize = 1024;

// =============================================================================
// Helpers: Network & SSH Policy
// =============================================================================

fn pick_free_local_addr() -> anyhow::Result<(TcpListener, SocketAddr)> {
    let addr = SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 0);
    let listener = TcpListener::bind(addr)?;
    listener.set_nonblocking(true)?;
    let local_addr = listener.local_addr()?;
    Ok((listener, local_addr))
}

fn strict_mode(s: Option<&str>) -> &str {
    match s.unwrap_or("accept-new") {
        "accept-new" => "accept-new",
        "yes" => "yes",
        "no" => "no",
        _ => "accept-new",
    }
}

fn known_host_format_from_hostkey_type(t: HostKeyType) -> ssh2::KnownHostKeyFormat {
    match t {
        HostKeyType::Ed25519 => ssh2::KnownHostKeyFormat::Ed25519,
        HostKeyType::Ecdsa256 => ssh2::KnownHostKeyFormat::Ecdsa256,
        HostKeyType::Ecdsa384 => ssh2::KnownHostKeyFormat::Ecdsa384,
        HostKeyType::Ecdsa521 => ssh2::KnownHostKeyFormat::Ecdsa521,
        HostKeyType::Rsa => ssh2::KnownHostKeyFormat::SshRsa,
        HostKeyType::Dss => ssh2::KnownHostKeyFormat::SshDss,
        _ => ssh2::KnownHostKeyFormat::Unknown,
    }
}

fn known_hosts_path() -> Option<PathBuf> {
    let home = dirs::home_dir()?;
    Some(home.join(".politedb").join("ssh_known_hosts"))
}

fn remove_known_hosts_entry(path: &Path, host: &str, port: u16) -> std::io::Result<()> {
    let host = host.trim();
    let hostport = format!("[{}]:{}", host, port);

    let mut s = String::new();
    if let Ok(mut f) = std::fs::File::open(path) {
        f.read_to_string(&mut s)?;
    }

    let mut out = String::with_capacity(s.len());
    for line in s.lines() {
        let t = line.trim();
        if t.is_empty() || t.starts_with('#') {
            out.push_str(line);
            out.push('\n');
            continue;
        }

        let first = t.split_whitespace().next().unwrap_or("");
        if first.contains(&hostport) || first.contains(host) {
            continue;
        }
        out.push_str(line);
        out.push('\n');
    }

    let tmp = path.with_extension("tmp");
    {
        let mut f = std::fs::File::create(&tmp)?;
        f.write_all(out.as_bytes())?;
        f.flush()?;
    }
    std::fs::rename(tmp, path)?;
    Ok(())
}

fn apply_hostkey_policy(
    sess: &Session,
    ssh_host: &str,
    ssh_port: u16,
    strict: &str,
) -> anyhow::Result<()> {
    if strict == "no" {
        return Ok(());
    }

    let Some(path) = known_hosts_path() else {
        return Ok(());
    };

    let mut kh = sess.known_hosts()?;
    if path.exists() {
        let _ = kh.read_file(&path, ssh2::KnownHostFileKind::OpenSSH);
    }

    let (key, key_type) = sess
        .host_key()
        .ok_or_else(|| anyhow!("SSH_HOSTKEY_MISSING"))?;
    let host = ssh_host.trim();
    let hostport = format!("[{}]:{}", host, ssh_port);
    let fmt = known_host_format_from_hostkey_type(key_type);

    match kh.check_port(host, ssh_port, key) {
        CheckResult::Match => Ok(()),
        CheckResult::NotFound => {
            if strict == "yes" {
                return Err(anyhow!("SSH_HOSTKEY_NOT_FOUND"));
            }
            kh.add(&hostport, key, "", fmt)?;
            if let Some(dir) = path.parent() {
                let _ = std::fs::create_dir_all(dir);
            }
            kh.write_file(&path, ssh2::KnownHostFileKind::OpenSSH)?;
            Ok(())
        }
        CheckResult::Mismatch => {
            // Auto replace strategy
            if path.exists() {
                let _ = remove_known_hosts_entry(&path, host, ssh_port);
            }
            // Reload to clear in-memory state
            let mut kh2 = sess.known_hosts()?;
            if path.exists() {
                let _ = kh2.read_file(&path, ssh2::KnownHostFileKind::OpenSSH);
            }
            kh2.add(&hostport, key, "", fmt)?;
            if let Some(dir) = path.parent() {
                let _ = std::fs::create_dir_all(dir);
            }
            kh2.write_file(&path, ssh2::KnownHostFileKind::OpenSSH)?;

            tracing::warn!(
                ssh_host = %host,
                ssh_port = ssh_port,
                "ssh_tunnel: host key mismatch -> auto-replaced (UX mode)"
            );
            Ok(())
        }
        CheckResult::Failure => Err(anyhow!("SSH_HOSTKEY_CHECK_FAILED")),
    }
}

fn is_io_wouldblock(e: &std::io::Error) -> bool {
    e.kind() == std::io::ErrorKind::WouldBlock
}

fn is_ssh_wouldblock(e: &ssh2::Error) -> bool {
    match e.code() {
        ssh2::ErrorCode::Session(code) => code == -37,
        ssh2::ErrorCode::SFTP(code) => code == -37,
        #[allow(unreachable_patterns)]
        _ => {
            let msg = e.message();
            msg.contains("EAGAIN") || msg.contains("would block")
        }
    }
}

fn set_local_nonblocking(s: &TcpStream) {
    let _ = s.set_nonblocking(true);
    let _ = s.set_nodelay(true);
}

// =============================================================================
// Blocking Setup (Fail-Fast)
// =============================================================================

fn connect_ssh_session_blocking(input: &SshTunnelInput) -> anyhow::Result<Session> {
    let timeout_ms = input.connect_timeout_ms.unwrap_or(5_000).clamp(500, 30_000);

    let addr = (input.ssh_host.trim(), input.ssh_port)
        .to_socket_addrs()?
        .next()
        .ok_or_else(|| anyhow!("SSH_DNS_RESOLVE_FAILED"))?;

    let tcp = TcpStream::connect_timeout(&addr, Duration::from_millis(timeout_ms))?;
    tcp.set_nodelay(true)?;
    tcp.set_read_timeout(Some(Duration::from_secs(60)))?;
    tcp.set_write_timeout(Some(Duration::from_secs(60)))?;

    let mut sess = Session::new()?;
    sess.set_tcp_stream(tcp);
    sess.set_blocking(true);
    sess.handshake()?;

    let strict = strict_mode(input.strict_host_key_checking.as_deref());
    apply_hostkey_policy(&sess, &input.ssh_host, input.ssh_port, strict)?;

    let user = input
        .ssh_user
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("root");

    match &input.auth {
        SshAuth::PrivateKey {
            identity_file,
            passphrase,
        } => {
            sess.userauth_pubkey_file(user, None, Path::new(identity_file), passphrase.as_deref())?;
        }
        SshAuth::Password { password } => {
            sess.userauth_password(user, password)?;
        }
    }

    if !sess.authenticated() {
        return Err(anyhow!("SSH_AUTH_FAILED"));
    }

    sess.set_keepalive(true, 30);
    Ok(sess)
}

// =============================================================================
// Buffer & Pipe Structures
// =============================================================================

struct Pending {
    buf: Vec<u8>,
    off: usize,
}

impl Pending {
    fn new() -> Self {
        Self {
            buf: Vec::with_capacity(LOCAL_READ_CHUNK * 2),
            off: 0,
        }
    }

    fn len(&self) -> usize {
        self.buf.len().saturating_sub(self.off)
    }

    fn is_empty(&self) -> bool {
        self.len() == 0
    }

    fn push_bytes(&mut self, src: &[u8], cap: usize) {
        if src.is_empty() {
            return;
        }
        if self.len() >= cap {
            return;
        }

        // Optimization: Only compact if we have significant wasted space (50%)
        if self.off > 0 && self.off >= (self.buf.capacity() / 2) {
            self.buf.drain(0..self.off);
            self.off = 0;
        }

        let remain = cap.saturating_sub(self.len());
        let take = remain.min(src.len());
        if take > 0 {
            self.buf.extend_from_slice(&src[..take]);
        }
    }

    fn slice(&self) -> &[u8] {
        &self.buf[self.off..]
    }

    fn advance(&mut self, n: usize) {
        self.off = (self.off + n).min(self.buf.len());
        if self.off == self.buf.len() {
            self.buf.clear();
            self.off = 0;
        }
    }
}

enum PipeState {
    Handshaking,
    Active(ssh2::Channel),
}

struct Pipe {
    local: TcpStream,
    state: PipeState,

    l2r: Pending, // Local -> Remote
    r2l: Pending, // Remote -> Local

    local_eof: bool,
    ssh_eof: bool,
    sent_ssh_eof: bool,
    closed_local_write: bool,

    // Time tracking for handshake timeout
    started_at: Instant,
}

// =============================================================================
// Multiplex Logic
// =============================================================================

/// Reads/Writes data for an ACTIVE channel. Returns true if activity occurred.
/// Reads/Writes data for an ACTIVE channel. Returns true if activity occurred.
fn pump_active_channel(sess: &Session, p: &mut Pipe) -> bool {
    let ch = match &mut p.state {
        PipeState::Active(c) => c,
        _ => return false,
    };

    let mut progressed = false;

    // 1. READ Local -> Buffer
    if !p.local_eof && p.l2r.len() < IO_BUF_CAP {
        let mut tmp = [0u8; LOCAL_READ_CHUNK];
        match p.local.read(&mut tmp) {
            Ok(0) => {
                p.local_eof = true;
                progressed = true;
            }
            Ok(n) => {
                p.l2r.push_bytes(&tmp[..n], IO_BUF_CAP);
                progressed = true;
            }
            Err(e) if is_io_wouldblock(&e) => {}
            Err(_) => {
                p.local_eof = true;
            }
        }
    }

    // 2. WRITE Buffer -> SSH
    if !p.l2r.is_empty() {
        match ch.write(p.l2r.slice()) {
            Ok(0) => {}
            Ok(n) => {
                p.l2r.advance(n);
                progressed = true;
            }
            Err(e) if is_io_wouldblock(&e) => {}
            Err(_) => {
                p.ssh_eof = true;
            }
        }
    }

    // 3. SEND SSH EOF
    if p.local_eof && p.l2r.is_empty() && !p.sent_ssh_eof {
        match ch.send_eof() {
            Ok(_) => {
                p.sent_ssh_eof = true;
                progressed = true;
            }
            Err(e) if is_ssh_wouldblock(&e) => {}
            Err(_) => {
                p.sent_ssh_eof = true;
            }
        }
    }

    // 4. READ SSH -> Buffer
    if !p.ssh_eof && p.r2l.len() < IO_BUF_CAP {
        let mut tmp = [0u8; SSH_READ_CHUNK];
        match ch.read(&mut tmp) {
            Ok(0) => {
                p.ssh_eof = true;
                progressed = true;
            }
            Ok(n) => {
                p.r2l.push_bytes(&tmp[..n], IO_BUF_CAP);
                progressed = true;
            }
            Err(e) if is_io_wouldblock(&e) => {}
            Err(_) => {
                p.ssh_eof = true;
            }
        }
    }

    // 5. WRITE Buffer -> Local
    if !p.r2l.is_empty() {
        match p.local.write(p.r2l.slice()) {
            Ok(0) => {}
            Ok(n) => {
                p.r2l.advance(n);
                progressed = true;
            }
            Err(e) if is_io_wouldblock(&e) => {}
            Err(_) => {
                p.local_eof = true;
            }
        }
    }

    // 6. CLOSE Local Write
    if p.ssh_eof && p.r2l.is_empty() && !p.closed_local_write {
        let _ = p.local.shutdown(std::net::Shutdown::Write);
        p.closed_local_write = true;
        progressed = true;
    }

    // Tick the session
    if progressed {
        let _ = sess;
    }

    progressed
}
fn should_remove_pipe(p: &Pipe) -> bool {
    // Timeout for handshaking pipes
    if let PipeState::Handshaking = p.state {
        if p.started_at.elapsed() > OPEN_CHANNEL_TIMEOUT {
            return true;
        }
        return false;
    }

    // Drain check for active pipes
    let drained = p.l2r.is_empty() && p.r2l.is_empty();
    let done_eof = p.local_eof && p.ssh_eof;
    drained && done_eof
}

fn spawn_session_thread(
    sess: Session,
    input: SshTunnelInput,
    rx: mpsc::Receiver<TcpStream>,
    shutdown: Arc<AtomicBool>,
) -> JoinHandle<()> {
    std::thread::spawn(move || {
        // Critical: Set session non-blocking for multiplexing
        sess.set_blocking(false);

        let mut pipes: HashMap<u64, Pipe> = HashMap::with_capacity(128);
        let mut next_id: u64 = 1;

        let remote_host = input.remote_host.trim().to_string();
        let remote_port = input.remote_port;

        while !shutdown.load(Ordering::SeqCst) {
            let mut any_activity = false;

            // 1. Accept new local connections
            while let Ok(local) = rx.try_recv() {
                any_activity = true;

                if pipes.len() >= MAX_CHANNELS {
                    let _ = local.shutdown(std::net::Shutdown::Both);
                    continue;
                }

                set_local_nonblocking(&local);

                pipes.insert(
                    next_id,
                    Pipe {
                        local,
                        state: PipeState::Handshaking,
                        l2r: Pending::new(),
                        r2l: Pending::new(),
                        local_eof: false,
                        ssh_eof: false,
                        sent_ssh_eof: false,
                        closed_local_write: false,
                        started_at: Instant::now(),
                    },
                );
                next_id += 1;
            }

            // 2. Process all pipes
            let mut remove_ids: Vec<u64> = Vec::new();

            for (id, p) in pipes.iter_mut() {
                // FIX: Xử lý Handshake riêng
                // Dùng if let để kiểm tra state mà không giữ borrow lâu
                let is_handshaking = matches!(p.state, PipeState::Handshaking);

                if is_handshaking {
                    match sess.channel_direct_tcpip(&remote_host, remote_port, None) {
                        Ok(ch) => {
                            p.state = PipeState::Active(ch);
                            any_activity = true;
                        }
                        Err(e) if is_ssh_wouldblock(&e) => {
                            // wait next tick
                        }
                        Err(e) => {
                            eprintln!("[ssh_tunnel] Handshake failed id {id}: {e}");
                            remove_ids.push(*id);
                        }
                    }
                }

                // FIX: Xử lý Pump riêng (Sau khi handshake có thể đã thành Active ngay lập tức)
                // Lúc này ta truyền `p` vào hàm, hàm sẽ tự tách `p.state` ra.
                if let PipeState::Active(_) = p.state {
                    if pump_active_channel(&sess, p) {
                        any_activity = true;
                    }
                }

                if should_remove_pipe(p) {
                    remove_ids.push(*id);
                }
            }

            // 3. Cleanup removed pipes
            for id in remove_ids {
                if let Some(mut p) = pipes.remove(&id) {
                    if let PipeState::Active(ref mut ch) = p.state {
                        let _ = ch.close();
                    }
                    let _ = p.local.shutdown(std::net::Shutdown::Both);
                }
            }

            // 4. Adaptive Sleep
            if any_activity {
                if !TICK_SLEEP_ACTIVE.is_zero() {
                    std::thread::sleep(TICK_SLEEP_ACTIVE);
                }
            } else {
                std::thread::sleep(TICK_SLEEP_IDLE);
            }
        }

        // Final cleanup
        for (_id, mut p) in pipes.drain() {
            if let PipeState::Active(ref mut ch) = p.state {
                let _ = ch.close();
            }
            let _ = p.local.shutdown(std::net::Shutdown::Both);
        }
        let _ = sess.disconnect(None, "bye", None);
    })
}
// =============================================================================
// Main Entry Point
// =============================================================================

pub async fn open_tunnel(input: &SshTunnelInput) -> anyhow::Result<SshTunnelHandle> {
    input.validate().map_err(|e| anyhow!(e))?;

    tracing::info!(
        ssh_host = %input.ssh_host,
        ssh_port = input.ssh_port,
        remote = %format!("{}:{}", input.remote_host, input.remote_port),
        "ssh_tunnel: Starting..."
    );

    // 1. Initial Connection (Blocking) for Fail-Fast
    let sess = connect_ssh_session_blocking(input)?;

    // 2. Bind Local Listener
    let (listener, local_addr) = pick_free_local_addr()?;

    // 3. Setup Orchestration
    let shutdown = Arc::new(AtomicBool::new(false));
    let (tx, rx) = mpsc::sync_channel::<TcpStream>(ACCEPT_QUEUE_CAP);

    let input_for_session = input.clone();
    let shutdown_session = shutdown.clone();

    let session_thread = spawn_session_thread(sess, input_for_session, rx, shutdown_session);

    let shutdown_accept = shutdown.clone();
    let accept_thread = std::thread::spawn(move || {
        while !shutdown_accept.load(Ordering::SeqCst) {
            match listener.accept() {
                Ok((local_stream, _peer)) => {
                    // Backpressure drop
                    match tx.try_send(local_stream) {
                        Ok(_) => {}
                        Err(mpsc::TrySendError::Full(s)) => {
                            let _ = s.shutdown(std::net::Shutdown::Both);
                        }
                        Err(mpsc::TrySendError::Disconnected(s)) => {
                            let _ = s.shutdown(std::net::Shutdown::Both);
                            break;
                        }
                    }
                }
                Err(e) if is_io_wouldblock(&e) => {
                    std::thread::sleep(Duration::from_millis(10));
                }
                Err(e) => {
                    eprintln!("[ssh_tunnel] Accept error: {e:?}");
                    std::thread::sleep(Duration::from_millis(50));
                }
            }
        }
    });

    Ok(SshTunnelHandle::new(
        local_addr,
        shutdown,
        accept_thread,
        session_thread,
    ))
}

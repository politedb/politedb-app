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

const MAX_CHANNELS: usize = 1024;
const IO_BUF_CAP: usize = 256 * 1024; // per-direction pending cap
const LOCAL_READ_CHUNK: usize = 32 * 1024;
const SSH_READ_CHUNK: usize = 32 * 1024;
const OPEN_CHANNEL_TIMEOUT: Duration = Duration::from_millis(3_000);

// Adaptive sleep
const TICK_SLEEP_IDLE: Duration = Duration::from_millis(3);
const TICK_SLEEP_ACTIVE: Duration = Duration::from_millis(0);

// If accept queue is full, we drop the local socket (backpressure)
const ACCEPT_QUEUE_CAP: usize = 1024;

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
    std::fs::File::open(path)?.read_to_string(&mut s)?;

    let mut out = String::with_capacity(s.len());
    for line in s.lines() {
        let t = line.trim();
        if t.is_empty() || t.starts_with('#') {
            out.push_str(line);
            out.push('\n');
            continue;
        }

        let first = t.split_whitespace().next().unwrap_or("");
        let mut hit = false;
        for h in first.split(',') {
            if h == hostport {
                hit = true;
                break;
            }
        }

        if !hit {
            out.push_str(line);
            out.push('\n');
        }
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
            // TablePlus-style: auto replace, no error to UI
            if path.exists() {
                let _ = remove_known_hosts_entry(&path, host, ssh_port);
            }

            // reload after removal (avoid duplicate state)
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
                "ssh_tunnel: host key mismatch -> auto-replaced (tableplus mode)"
            );

            Ok(())
        }

        CheckResult::Failure => Err(anyhow!("SSH_HOSTKEY_CHECK_FAILED")),
    }
}

fn is_io_wouldblock(e: &std::io::Error) -> bool {
    e.kind() == std::io::ErrorKind::WouldBlock
}

// libssh2 EAGAIN is -37 (SSH2_ERROR_EAGAIN)
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

fn connect_ssh_session_blocking(input: &SshTunnelInput) -> anyhow::Result<Session> {
    let timeout_ms = input.connect_timeout_ms.unwrap_or(5_000).clamp(500, 30_000);

    let addr = (input.ssh_host.trim(), input.ssh_port)
        .to_socket_addrs()?
        .next()
        .ok_or_else(|| anyhow!("SSH_DNS_RESOLVE_FAILED"))?;

    let tcp = TcpStream::connect_timeout(&addr, Duration::from_millis(timeout_ms))?;
    tcp.set_read_timeout(Some(Duration::from_secs(60)))?;
    tcp.set_write_timeout(Some(Duration::from_secs(60)))?;
    tcp.set_nodelay(true)?;

    let mut sess = Session::new()?;
    sess.set_tcp_stream(tcp);

    // blocking for handshake + auth
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

fn set_local_nonblocking(s: &TcpStream) {
    let _ = s.set_nonblocking(true);
    let _ = s.set_nodelay(true);
}

struct Pending {
    buf: Vec<u8>,
    off: usize,
}

impl Pending {
    fn new() -> Self {
        Self {
            buf: Vec::new(),
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

        // compact
        if self.off > 0 && self.off >= (self.buf.len() / 2) {
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

struct Pipe {
    local: TcpStream,
    ch: ssh2::Channel,

    l2r: Pending,
    r2l: Pending,

    local_eof: bool,
    ssh_eof: bool,
    sent_ssh_eof: bool,
    closed_local_write: bool,

    last_active: Instant,
}

fn open_direct_channel_nonblocking(
    sess: &Session,
    host: &str,
    port: u16,
    timeout: Duration,
) -> anyhow::Result<ssh2::Channel> {
    let start = Instant::now();
    loop {
        match sess.channel_direct_tcpip(host, port, None) {
            Ok(ch) => return Ok(ch),
            Err(e) => {
                if is_ssh_wouldblock(&e) {
                    if start.elapsed() >= timeout {
                        return Err(anyhow!("SSH_OPEN_CHANNEL_TIMEOUT"));
                    }
                    std::thread::sleep(Duration::from_millis(2));
                    continue;
                }
                return Err(anyhow!("SSH_OPEN_CHANNEL_FAILED: {e}"));
            }
        }
    }
}

/// Returns true if this pipe made progress this tick.
fn pump_pipe(sess: &Session, p: &mut Pipe) -> bool {
    let now = Instant::now();
    let mut progressed = false;

    // 1) local -> l2r
    if !p.local_eof && p.l2r.len() < IO_BUF_CAP {
        let mut tmp = [0u8; LOCAL_READ_CHUNK];
        match p.local.read(&mut tmp) {
            Ok(0) => {
                p.local_eof = true;
                progressed = true;
            }
            Ok(n) => {
                p.l2r.push_bytes(&tmp[..n], IO_BUF_CAP);
                p.last_active = now;
                progressed = true;
            }
            Err(e) => {
                if !is_io_wouldblock(&e) {
                    p.local_eof = true;
                }
            }
        }
    }

    // 2) l2r -> ssh
    if !p.l2r.is_empty() {
        match p.ch.write(p.l2r.slice()) {
            Ok(0) => {}
            Ok(n) => {
                p.l2r.advance(n);
                let _ = p.ch.flush();
                p.last_active = now;
                progressed = true;
            }
            Err(e) => {
                if !is_io_wouldblock(&e) {
                    p.ssh_eof = true;
                }
            }
        }
    }

    // 3) local eof -> send_eof
    if p.local_eof && p.l2r.is_empty() && !p.sent_ssh_eof {
        match p.ch.send_eof() {
            Ok(_) => {
                p.sent_ssh_eof = true;
                progressed = true;
            }
            Err(e) => {
                if !is_ssh_wouldblock(&e) {
                    p.sent_ssh_eof = true;
                }
            }
        }
    }

    // 4) ssh -> r2l
    if !p.ssh_eof && p.r2l.len() < IO_BUF_CAP {
        let mut tmp = [0u8; SSH_READ_CHUNK];
        match p.ch.read(&mut tmp) {
            Ok(0) => {
                p.ssh_eof = true;
                progressed = true;
            }
            Ok(n) => {
                p.r2l.push_bytes(&tmp[..n], IO_BUF_CAP);
                p.last_active = now;
                progressed = true;
            }
            Err(e) => {
                if !is_io_wouldblock(&e) {
                    p.ssh_eof = true;
                }
            }
        }
    }

    // 5) r2l -> local
    if !p.r2l.is_empty() {
        match p.local.write(p.r2l.slice()) {
            Ok(0) => {}
            Ok(n) => {
                p.r2l.advance(n);
                p.last_active = now;
                progressed = true;
            }
            Err(e) => {
                if !is_io_wouldblock(&e) {
                    p.local_eof = true;
                }
            }
        }
    }

    // 6) ssh eof -> shutdown local write
    if p.ssh_eof && p.r2l.is_empty() && !p.closed_local_write {
        let _ = p.local.shutdown(std::net::Shutdown::Write);
        p.closed_local_write = true;
        progressed = true;
    }

    // keep sess in signature for future poll integration
    if progressed {
        let _ = sess;
    }

    progressed
}

fn should_remove(p: &Pipe) -> bool {
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
        // Switch session to nonblocking for multiplex
        sess.set_blocking(false);

        let mut pipes: HashMap<u64, Pipe> = HashMap::new();
        let mut next_id: u64 = 1;

        while !shutdown.load(Ordering::SeqCst) {
            let mut any_activity = false;

            // Drain locals
            while let Ok(local) = rx.try_recv() {
                any_activity = true;

                if pipes.len() >= MAX_CHANNELS {
                    let _ = local.shutdown(std::net::Shutdown::Both);
                    continue;
                }

                set_local_nonblocking(&local);

                let ch = match open_direct_channel_nonblocking(
                    &sess,
                    input.remote_host.trim(),
                    input.remote_port,
                    OPEN_CHANNEL_TIMEOUT,
                ) {
                    Ok(c) => c,
                    Err(e) => {
                        eprintln!("[ssh_tunnel] open channel failed: {e:?}");
                        let _ = local.shutdown(std::net::Shutdown::Both);
                        continue;
                    }
                };

                let id = next_id;
                next_id += 1;

                pipes.insert(
                    id,
                    Pipe {
                        local,
                        ch,
                        l2r: Pending::new(),
                        r2l: Pending::new(),
                        local_eof: false,
                        ssh_eof: false,
                        sent_ssh_eof: false,
                        closed_local_write: false,
                        last_active: Instant::now(),
                    },
                );
            }

            // Pump pipes
            let mut remove_ids: Vec<u64> = Vec::new();
            for (id, p) in pipes.iter_mut() {
                let progressed = pump_pipe(&sess, p);
                if progressed {
                    any_activity = true;
                }
                if should_remove(p) {
                    remove_ids.push(*id);
                }
            }

            // Cleanup removed pipes
            for id in remove_ids {
                if let Some(mut p) = pipes.remove(&id) {
                    let _ = p.ch.close();
                    let _ = p.ch.wait_close();
                    let _ = p.local.shutdown(std::net::Shutdown::Both);
                }
            }

            // Sleep (adaptive)
            if any_activity {
                if !TICK_SLEEP_ACTIVE.is_zero() {
                    std::thread::sleep(TICK_SLEEP_ACTIVE);
                }
            } else {
                std::thread::sleep(TICK_SLEEP_IDLE);
            }
        }

        // Best-effort cleanup
        for (_id, mut p) in pipes.drain() {
            let _ = p.ch.close();
            let _ = p.ch.wait_close();
            let _ = p.local.shutdown(std::net::Shutdown::Both);
        }

        let _ = sess.disconnect(None, "bye", None);
    })
}

pub async fn open_tunnel(input: &SshTunnelInput) -> anyhow::Result<SshTunnelHandle> {
    input.validate().map_err(|e| anyhow!(e))?;

    tracing::warn!(
        ssh_host = %input.ssh_host,
        ssh_port = input.ssh_port,
        remote = %format!("{}:{}", input.remote_host, input.remote_port),
        "ssh_tunnel: OPEN_TUNNEL CALLED"
    );

    // 0) Connect ONCE (blocking), and do fail-fast using the SAME session
    let sess = connect_ssh_session_blocking(input)?;

    {
        // still in blocking mode here
        let _ = sess.channel_direct_tcpip(input.remote_host.trim(), input.remote_port, None)?;
    }

    // 1) Bind local listener
    let (listener, local_addr) = pick_free_local_addr()?;

    // 2) Multiplex threads wiring
    let shutdown = Arc::new(AtomicBool::new(false));
    let (tx, rx) = mpsc::sync_channel::<TcpStream>(ACCEPT_QUEUE_CAP);

    let input_for_session = input.clone();
    let shutdown_session = shutdown.clone();

    // move the already-connected session into session thread
    let session_thread = spawn_session_thread(sess, input_for_session, rx, shutdown_session);

    let shutdown_accept = shutdown.clone();
    let accept_thread = std::thread::spawn(move || {
        while !shutdown_accept.load(Ordering::SeqCst) {
            match listener.accept() {
                Ok((local_stream, _peer)) => {
                    set_local_nonblocking(&local_stream);

                    // IMPORTANT: do not block accept thread if queue is full
                    match tx.try_send(local_stream) {
                        Ok(_) => {}
                        Err(mpsc::TrySendError::Full(s)) => {
                            // backpressure: drop connection
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
                    eprintln!("[ssh_tunnel] accept failed: {e:?}");
                    std::thread::sleep(Duration::from_millis(80));
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

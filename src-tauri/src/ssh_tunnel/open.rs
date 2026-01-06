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

const MAX_CHANNELS: usize = 256;
const IO_BUF_CAP: usize = 256 * 1024; // per-direction pending cap (tune)
const LOCAL_READ_CHUNK: usize = 32 * 1024;
const SSH_READ_CHUNK: usize = 32 * 1024;
const OPEN_CHANNEL_TIMEOUT: Duration = Duration::from_millis(3_000);
const TICK_SLEEP: Duration = Duration::from_millis(1);

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
        _ => ssh2::KnownHostKeyFormat::SshRsa,
    }
}

fn known_hosts_path() -> Option<PathBuf> {
    let home = dirs::home_dir()?;
    Some(home.join(".ssh").join("known_hosts"))
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
        // If no known_hosts path, degrade gracefully.
        return Ok(());
    };

    let mut kh = sess.known_hosts()?;
    if path.exists() {
        let _ = kh.read_file(&path, ssh2::KnownHostFileKind::OpenSSH);
    }

    let (key, key_type) = sess
        .host_key()
        .ok_or_else(|| anyhow!("SSH_HOSTKEY_MISSING"))?;

    match kh.check_port(ssh_host.trim(), ssh_port, key) {
        CheckResult::Match => Ok(()),
        CheckResult::Mismatch => Err(anyhow!("SSH_HOSTKEY_MISMATCH")),
        CheckResult::NotFound => {
            if strict == "yes" {
                return Err(anyhow!("SSH_HOSTKEY_NOT_FOUND"));
            }

            let hostport = format!("[{}]:{}", ssh_host.trim(), ssh_port);
            let fmt = known_host_format_from_hostkey_type(key_type);

            kh.add(&hostport, key, "", fmt)?;

            if let Some(dir) = path.parent() {
                let _ = std::fs::create_dir_all(dir);
            }
            kh.write_file(&path, ssh2::KnownHostFileKind::OpenSSH)?;
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
        _ => {
            // optional fallback, best-effort
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

        // Prevent unbounded growth
        if self.len() >= cap {
            return;
        }

        // If consumed a lot, compact
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

    // pending data
    l2r: Pending, // local -> ssh
    r2l: Pending, // ssh -> local

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

fn pump_pipe(sess: &Session, p: &mut Pipe) {
    let now = Instant::now();
    let mut progressed = false;

    // 1) Read from local into l2r
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

    // 2) Write l2r to ssh channel
    if !p.l2r.is_empty() {
        match p.ch.write(p.l2r.slice()) {
            Ok(0) => {}
            Ok(n) => {
                p.l2r.advance(n);
                // flush() might also EAGAIN; ignore
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

    // 3) If local eof and all l2r flushed => send EOF to ssh once
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

    // 4) Read ssh -> r2l
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
                    // other errors => treat as EOF/broken
                    p.ssh_eof = true;
                }
            }
        }
    }

    // 5) Write r2l to local
    if !p.r2l.is_empty() {
        match p.local.write(p.r2l.slice()) {
            Ok(0) => {}
            Ok(n) => {
                p.r2l.advance(n);
                // no need to flush a TcpStream
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

    // 6) If ssh eof and all r2l flushed => shutdown local write once
    if p.ssh_eof && p.r2l.is_empty() && !p.closed_local_write {
        let _ = p.local.shutdown(std::net::Shutdown::Write);
        p.closed_local_write = true;
        progressed = true;
    }

    // Note: with libssh2 nonblocking, progress happens via read/write calls above.
    // Keeping sess in signature lets you extend with socket polling later.
    if progressed {
        let _ = sess;
    }
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

        let mut next_id: u64 = 1;
        let mut pipes: HashMap<u64, Pipe> = HashMap::new();

        while !shutdown.load(Ordering::SeqCst) {
            // Drain new locals (bounded channel gives backpressure)
            while let Ok(local) = rx.try_recv() {
                if pipes.len() >= MAX_CHANNELS {
                    let _ = local.shutdown(std::net::Shutdown::Both);
                    continue;
                }

                set_local_nonblocking(&local);

                // Open direct-tcpip channel (nonblocking retry)
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

            // Pump each pipe
            let mut remove_ids: Vec<u64> = Vec::new();
            for (id, p) in pipes.iter_mut() {
                pump_pipe(&sess, p);
                if should_remove(p) {
                    remove_ids.push(*id);
                }
            }

            // Cleanup
            for id in remove_ids {
                if let Some(mut p) = pipes.remove(&id) {
                    let _ = p.ch.close();
                    let _ = p.ch.wait_close();
                    let _ = p.local.shutdown(std::net::Shutdown::Both);
                }
            }

            // Avoid busy spin
            std::thread::sleep(TICK_SLEEP);
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

    // 0) Fail-fast: verify we can open one channel and touch remote target
    {
        let sess = connect_ssh_session_blocking(input)?;
        let _ = sess.channel_direct_tcpip(input.remote_host.trim(), input.remote_port, None)?;
        let _ = sess.disconnect(None, "bye", None);
    }

    // 1) Bind local listener
    let (listener, local_addr) = pick_free_local_addr()?;

    // 2) Establish one authenticated SSH session (blocking auth), then hand it to session thread
    let sess = connect_ssh_session_blocking(input)?;

    // 3) Multiplex threads wiring
    let shutdown = Arc::new(AtomicBool::new(false));
    let (tx, rx) = mpsc::sync_channel::<TcpStream>(1024); // bounded for backpressure

    let input_for_session = input.clone();
    let shutdown_session = shutdown.clone();
    let session_thread = spawn_session_thread(sess, input_for_session, rx, shutdown_session);

    let shutdown_accept = shutdown.clone();
    let accept_thread = std::thread::spawn(move || {
        while !shutdown_accept.load(Ordering::SeqCst) {
            match listener.accept() {
                Ok((local_stream, _peer)) => {
                    set_local_nonblocking(&local_stream);
                    if tx.send(local_stream).is_err() {
                        break;
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

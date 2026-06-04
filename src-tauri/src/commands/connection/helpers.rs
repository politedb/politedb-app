pub(crate) fn parse_redis_version(info: &str) -> Option<String> {
    info.lines()
        .find_map(|line| line.strip_prefix("redis_version:"))
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .map(str::to_string)
}

pub(crate) async fn close_tunnel_quietly(tunnel: crate::ssh_tunnel::handle::SshTunnelHandle) {
    let _ = tunnel.close().await;
}

//! The console: a root-only unix socket (mode 0600; the peer must be root or the trunk's own
//! user) and the `trunk-ctl` client (`bifrost-net trunk-ctl …`, or argv[0] = `trunk-ctl`).
//!
//! Wire: the client sends one JSON line `{"args":[…]}`; the server answers one JSON object
//! `{"ok":bool,"out":"…"}` and closes. Secrets never travel as arguments: a command that needs
//! one (none in M1) reads it from stdin on the client side.

use std::io::{Read as _, Write as _};
use std::sync::Arc;

use tokio::io::{AsyncBufReadExt as _, AsyncWriteExt as _, BufReader};
use tokio::net::UnixListener;

use super::server::State;

pub const DEFAULT_SOCK: &str = "/run/trunk/ctl.sock";

fn own_uid() -> u32 {
    use std::os::unix::fs::MetadataExt as _;
    std::fs::metadata("/proc/self").map(|m| m.uid()).unwrap_or(u32::MAX)
}

pub async fn serve(st: Arc<State>) -> Result<(), String> {
    use std::os::unix::fs::{FileTypeExt as _, PermissionsExt as _};
    let path = st.cfg.ctl_socket.clone();
    let p = std::path::Path::new(&path);
    if let Some(d) = p.parent() {
        if !d.exists() {
            std::fs::create_dir_all(d).map_err(|e| format!("ctl_socket dir {}: {e}", d.display()))?;
            let _ = std::fs::set_permissions(d, std::fs::Permissions::from_mode(0o700));
        }
    }
    if let Ok(m) = std::fs::symlink_metadata(p) {
        if m.file_type().is_socket() {
            std::fs::remove_file(p).map_err(|e| format!("ctl_socket {path}: {e}"))?;
        } else {
            return Err(format!("ctl_socket {path} exists and is not a socket"));
        }
    }
    let l = UnixListener::bind(p).map_err(|e| format!("ctl_socket {path}: {e}"))?;
    std::fs::set_permissions(p, std::fs::Permissions::from_mode(0o600)).map_err(|e| format!("ctl_socket chmod: {e}"))?;
    println!("  trunk: console {path} (0600, root or uid {})", own_uid());
    let me = own_uid();
    tokio::spawn(async move {
        loop {
            let Ok((s, _)) = l.accept().await else {
                tokio::time::sleep(std::time::Duration::from_millis(50)).await;
                continue;
            };
            let st = st.clone();
            tokio::spawn(async move {
                let uid = s.peer_cred().map(|c| c.uid()).unwrap_or(u32::MAX);
                let (rd, mut wr) = s.into_split();
                if uid != 0 && uid != me {
                    let _ = wr.write_all(b"{\"ok\":false,\"out\":\"the console is root-only\"}\n").await;
                    return;
                }
                let mut line = String::new();
                let mut rd = BufReader::new(rd.take(64 * 1024));
                use tokio::io::AsyncReadExt as _;
                if rd.read_line(&mut line).await.is_err() {
                    return;
                }
                let args: Vec<String> = serde_json::from_str::<serde_json::Value>(&line)
                    .ok()
                    .and_then(|v| v.get("args").and_then(|a| a.as_array()).cloned())
                    .map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect())
                    .unwrap_or_default();
                let (ok, out) = super::idp::console::run(&st, &args).await;
                let resp = serde_json::json!({ "ok": ok, "out": out }).to_string() + "\n";
                let _ = wr.write_all(resp.as_bytes()).await;
                let _ = wr.shutdown().await;
            });
        }
    });
    Ok(())
}

/// `trunk-ctl [--sock PATH | -c trunk.toml] <cmd…>`
pub fn cmd_ctl(args: &[String]) -> i32 {
    let mut sock = std::env::var("TRUNK_CTL_SOCK").unwrap_or_else(|_| DEFAULT_SOCK.to_string());
    let mut rest: Vec<String> = vec![];
    let mut it = args.iter();
    while let Some(a) = it.next() {
        match a.as_str() {
            "--sock" if rest.is_empty() => match it.next() {
                Some(s) => sock = s.clone(),
                None => return usage(),
            },
            "-c" if rest.is_empty() => match it.next().map(|p| super::config::Config::load(p)) {
                Some(Ok(c)) => sock = c.ctl_socket,
                Some(Err(e)) => {
                    eprintln!("trunk-ctl: {e}");
                    return 2;
                }
                None => return usage(),
            },
            _ => rest.push(a.clone()),
        }
    }
    if rest.is_empty() || rest[0] == "--help" || rest[0] == "-h" {
        return usage();
    }
    match call(&sock, &rest) {
        Ok((ok, out)) => {
            if !out.is_empty() {
                if ok {
                    println!("{}", out.trim_end());
                } else {
                    eprintln!("{}", out.trim_end());
                }
            }
            if ok { 0 } else { 1 }
        }
        Err(e) => {
            eprintln!("trunk-ctl: {e}");
            1
        }
    }
}

pub fn call(sock: &str, args: &[String]) -> Result<(bool, String), String> {
    let mut s = std::os::unix::net::UnixStream::connect(sock).map_err(|e| format!("{sock}: {e} (is the trunk running? root only)"))?;
    let req = serde_json::json!({ "args": args }).to_string() + "\n";
    s.write_all(req.as_bytes()).map_err(|e| e.to_string())?;
    let mut buf = String::new();
    s.read_to_string(&mut buf).map_err(|e| e.to_string())?;
    let v: serde_json::Value = serde_json::from_str(buf.trim()).map_err(|_| format!("bad answer from the trunk: {}", buf.trim()))?;
    Ok((v["ok"].as_bool().unwrap_or(false), v["out"].as_str().unwrap_or("").to_string()))
}

fn usage() -> i32 {
    eprintln!("{}", super::idp::console::USAGE);
    2
}

//! RFC 6455 frames and HTTP heads over tokio streams, for `/t/root` (both ends).
//! Lifted from ap.rs (same limits: 32 KiB heads, 1 MiB frames, no fragmentation), so the
//! v0.9 path keeps its own copy until switchover.

use std::io;

use base64::Engine as _;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

pub const MAX_HEAD: usize = 32 * 1024;
pub const MAX_FRAME: u64 = 1 << 20;
pub const OP_BIN: u8 = 0x2;
pub const OP_CLOSE: u8 = 0x8;
pub const OP_PING: u8 = 0x9;
pub const OP_PONG: u8 = 0xA;
const WS_GUID: &str = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

/// A stream whose first bytes were already read (the bytes past an HTTP head).
pub struct Prefixed<S> {
    pre: Vec<u8>,
    at: usize,
    inner: S,
}

impl<S> Prefixed<S> {
    pub fn new(pre: Vec<u8>, inner: S) -> Prefixed<S> {
        Prefixed { pre, at: 0, inner }
    }
}

impl<S: AsyncRead + Unpin> AsyncRead for Prefixed<S> {
    fn poll_read(mut self: std::pin::Pin<&mut Self>, cx: &mut std::task::Context<'_>, buf: &mut tokio::io::ReadBuf<'_>) -> std::task::Poll<io::Result<()>> {
        if self.at < self.pre.len() {
            let n = (self.pre.len() - self.at).min(buf.remaining());
            let at = self.at;
            buf.put_slice(&self.pre[at..at + n]);
            self.at += n;
            return std::task::Poll::Ready(Ok(()));
        }
        std::pin::Pin::new(&mut self.inner).poll_read(cx, buf)
    }
}

impl<S: AsyncWrite + Unpin> AsyncWrite for Prefixed<S> {
    fn poll_write(mut self: std::pin::Pin<&mut Self>, cx: &mut std::task::Context<'_>, b: &[u8]) -> std::task::Poll<io::Result<usize>> {
        std::pin::Pin::new(&mut self.inner).poll_write(cx, b)
    }
    fn poll_flush(mut self: std::pin::Pin<&mut Self>, cx: &mut std::task::Context<'_>) -> std::task::Poll<io::Result<()>> {
        std::pin::Pin::new(&mut self.inner).poll_flush(cx)
    }
    fn poll_shutdown(mut self: std::pin::Pin<&mut Self>, cx: &mut std::task::Context<'_>) -> std::task::Poll<io::Result<()>> {
        std::pin::Pin::new(&mut self.inner).poll_shutdown(cx)
    }
}

/// Anything a link can ride (plain TCP, TLS either way).
pub trait Io: AsyncRead + AsyncWrite + Unpin + Send {}
impl<T: AsyncRead + AsyncWrite + Unpin + Send> Io for T {}

pub fn ws_accept(key: &str) -> String {
    use sha1::Digest as _;
    base64::engine::general_purpose::STANDARD.encode(sha1::Sha1::digest(format!("{}{WS_GUID}", key.trim()).as_bytes()))
}

/// Read up to the end of the HTTP head; returns (head, bytes already read past it).
pub async fn read_head<R: AsyncRead + Unpin>(r: &mut R) -> io::Result<Option<(Vec<u8>, Vec<u8>)>> {
    let mut buf = Vec::with_capacity(4096);
    let mut chunk = [0u8; 4096];
    loop {
        if let Some(p) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
            let rest = buf.split_off(p + 4);
            return Ok(Some((buf, rest)));
        }
        if buf.len() > MAX_HEAD {
            return Err(io::Error::new(io::ErrorKind::InvalidData, "request head too large"));
        }
        let n = r.read(&mut chunk).await?;
        if n == 0 {
            return Ok(None);
        }
        buf.extend_from_slice(&chunk[..n]);
    }
}

pub async fn ws_send<W: AsyncWrite + Unpin>(w: &mut W, op: u8, payload: &[u8], masked: bool) -> io::Result<()> {
    let n = payload.len();
    let mut f = Vec::with_capacity(n + 14);
    f.push(0x80 | op);
    let m = if masked { 0x80 } else { 0 };
    if n < 126 {
        f.push(m | n as u8);
    } else if n < 65536 {
        f.push(m | 126);
        f.extend_from_slice(&(n as u16).to_be_bytes());
    } else {
        f.push(m | 127);
        f.extend_from_slice(&(n as u64).to_be_bytes());
    }
    if masked {
        let key: [u8; 4] = super::proto::random_bytes();
        f.extend_from_slice(&key);
        f.extend(payload.iter().enumerate().map(|(i, b)| b ^ key[i % 4]));
    } else {
        f.extend_from_slice(payload);
    }
    w.write_all(&f).await?;
    w.flush().await
}

/// One frame: (opcode, payload). `want_masked`: Some(true) = the peer is a client (its frames
/// must be masked), Some(false) = a server (never masked), None = either.
pub async fn ws_recv<R: AsyncRead + Unpin>(r: &mut R, want_masked: Option<bool>) -> io::Result<(u8, Vec<u8>)> {
    let bad = |m: &str| io::Error::new(io::ErrorKind::InvalidData, m.to_string());
    let mut h = [0u8; 2];
    r.read_exact(&mut h).await?;
    if h[0] & 0x80 == 0 {
        return Err(bad("fragmented frames are not part of the channel"));
    }
    let masked = h[1] & 0x80 != 0;
    if want_masked.is_some_and(|w| w != masked) {
        return Err(bad(if masked { "a server frame is never masked" } else { "a client frame must be masked" }));
    }
    let mut n = (h[1] & 0x7f) as u64;
    if n == 126 {
        let mut b = [0u8; 2];
        r.read_exact(&mut b).await?;
        n = u16::from_be_bytes(b) as u64;
    } else if n == 127 {
        let mut b = [0u8; 8];
        r.read_exact(&mut b).await?;
        n = u64::from_be_bytes(b);
    }
    if n > MAX_FRAME {
        return Err(bad("frame too large"));
    }
    let mut key = [0u8; 4];
    if masked {
        r.read_exact(&mut key).await?;
    }
    let mut p = vec![0u8; n as usize];
    r.read_exact(&mut p).await?;
    if masked {
        for (i, b) in p.iter_mut().enumerate() {
            *b ^= key[i % 4];
        }
    }
    Ok((h[0] & 0x0f, p))
}

/// A parsed request head (method, path, headers lowercased).
#[derive(Debug, Clone)]
pub struct Head {
    pub method: String,
    pub path: String,
    pub version: String,
    pub headers: Vec<(String, String)>,
}

impl Head {
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers.iter().find(|(k, _)| k.eq_ignore_ascii_case(name)).map(|(_, v)| v.as_str())
    }
    pub fn headers_all<'a>(&'a self, name: &'a str) -> impl Iterator<Item = &'a str> + 'a {
        self.headers.iter().filter(move |(k, _)| k.eq_ignore_ascii_case(name)).map(|(_, v)| v.as_str())
    }
    pub fn cookie(&self, name: &str) -> Option<String> {
        self.headers_all("cookie").flat_map(|v| v.split(';')).filter_map(|c| c.trim().split_once('=')).find(|(k, _)| *k == name).map(|(_, v)| v.to_string())
    }
}

/// The same request-line and header rules as ap.rs `parse_head`.
pub fn parse_head(head: &[u8]) -> Result<Head, String> {
    let text = std::str::from_utf8(head).map_err(|_| "non-utf8 request head")?;
    let mut lines = text.split("\r\n");
    let first = lines.next().unwrap_or("");
    let mut parts = first.split(' ');
    let (Some(method), Some(path), Some(version), None) = (parts.next(), parts.next(), parts.next(), parts.next()) else {
        return Err("bad request line".into());
    };
    if method.is_empty() || !method.bytes().all(|b| b.is_ascii_uppercase()) || !path.starts_with('/') || !version.starts_with("HTTP/1.") {
        return Err("bad request line".into());
    }
    let mut headers = vec![];
    for line in lines {
        if line.is_empty() {
            break;
        }
        let (k, v) = line.split_once(':').ok_or("bad header")?;
        if k.is_empty() || k.bytes().any(|b| b <= b' ' || b == 0x7f) {
            return Err("bad header name".into());
        }
        headers.push((k.to_string(), v.trim().to_string()));
    }
    Ok(Head { method: method.into(), path: path.into(), version: version.into(), headers })
}

pub fn http_response(status: u16, reason: &str, ctype: &str, body: &str) -> Vec<u8> {
    format!("HTTP/1.1 {status} {reason}\r\nContent-Type: {ctype}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).into_bytes()
}

/// The upgrade answer for a websocket request (None = not a websocket upgrade).
pub fn upgrade_answer(h: &Head) -> Option<String> {
    let key = h.header("sec-websocket-key")?;
    if !h.header("upgrade").is_some_and(|u| u.eq_ignore_ascii_case("websocket")) {
        return None;
    }
    Some(format!("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: {}\r\n\r\n", ws_accept(key)))
}

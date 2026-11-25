//! HTTP/1.1 for the trunk's own answers and the relay — the P12 law (lifted from `ap.rs`, which keeps
//! its copy for v0.9 until switchover): one request per connection, `Connection: close`, chunked
//! request bodies → 411, conflicting Content-Length → 400, header hygiene on everything relayed.

use std::io;
use std::net::{IpAddr, SocketAddr};

use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

pub const MAX_HEAD: usize = 32 * 1024;
/// the largest body any `/t/*` call takes
pub const MAX_BODY: u64 = 64 * 1024;

pub trait Io: AsyncRead + AsyncWrite + Unpin + Send {}
impl<T: AsyncRead + AsyncWrite + Unpin + Send> Io for T {}

#[derive(Debug, Clone)]
pub struct Req {
    pub method: String,
    /// the raw request target (path + query)
    pub path: String,
    pub version: String,
    pub headers: Vec<(String, String)>,
}

impl Req {
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers.iter().find(|(k, _)| k.eq_ignore_ascii_case(name)).map(|(_, v)| v.as_str())
    }

    pub fn cookie(&self, name: &str) -> Option<String> {
        self.headers
            .iter()
            .filter(|(k, _)| k.eq_ignore_ascii_case("cookie"))
            .flat_map(|(_, v)| v.split(';'))
            .filter_map(|c| c.trim().split_once('='))
            .find(|(k, _)| *k == name)
            .map(|(_, v)| v.to_string())
    }

    /// the path without query or fragment, exactly as sent
    pub fn route(&self) -> &str {
        self.path.split(['?', '#']).next().unwrap_or("")
    }

    pub fn query(&self, key: &str) -> Option<String> {
        let q = self.path.split_once('?')?.1.split('#').next()?;
        q.split('&').filter_map(|kv| kv.split_once('=')).find(|(k, _)| *k == key).map(|(_, v)| percent_decode(v))
    }

    pub fn is_write(&self) -> bool {
        !matches!(self.method.as_str(), "GET" | "HEAD" | "OPTIONS")
    }

    pub fn is_upgrade(&self) -> bool {
        self.header("upgrade").is_some_and(|u| u.eq_ignore_ascii_case("websocket"))
    }
}

pub fn parse_head(head: &[u8]) -> Result<Req, String> {
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
    Ok(Req { method: method.into(), path: path.into(), version: version.into(), headers })
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

/// PROXY protocol v1 (sni-443 / nginx `proxy_protocol on`): the real client address.
pub async fn read_proxy_v1<R: AsyncRead + Unpin>(tcp: &mut R, local: SocketAddr) -> io::Result<SocketAddr> {
    let bad = |m: &str| io::Error::new(io::ErrorKind::InvalidData, m.to_string());
    let mut line = Vec::with_capacity(108);
    let mut b = [0u8; 1];
    while !line.ends_with(b"\r\n") {
        if line.len() >= 107 {
            return Err(bad("PROXY line too long"));
        }
        tcp.read_exact(&mut b).await?;
        line.push(b[0]);
    }
    let text = std::str::from_utf8(&line).map_err(|_| bad("PROXY line not utf8"))?.trim_end();
    match text.split(' ').collect::<Vec<_>>().as_slice() {
        ["PROXY", "UNKNOWN", ..] => Ok(local),
        ["PROXY", "TCP4" | "TCP6", src, _dst, sport, _dport] => Ok(SocketAddr::new(
            src.parse().map_err(|_| bad("PROXY src"))?,
            sport.parse().map_err(|_| bad("PROXY port"))?,
        )),
        _ => Err(bad("not a PROXY v1 line")),
    }
}

pub fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        let hex = |c: u8| (c as char).to_digit(16);
        if b[i] == b'%' && i + 2 < b.len() {
            if let (Some(h), Some(l)) = (hex(b[i + 1]), hex(b[i + 2])) {
                out.push((h * 16 + l) as u8);
                i += 3;
                continue;
            }
        }
        out.push(if b[i] == b'+' { b' ' } else { b[i] });
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// What the router classifies: a SUPERSET of how an upstream may resolve the path (repeated
/// percent-decoding, `\` as `/`, empty and dot segments resolved, case-folded) — so /x/../t,
/// //t, /%74 or /T can never slip past it.
pub fn normalize_path(raw: &str) -> String {
    let mut cur = raw.split(['?', '#']).next().unwrap_or("").to_string();
    for _ in 0..4 {
        let dec = percent_decode(&cur);
        if dec == cur {
            break;
        }
        cur = dec;
    }
    let cur = cur.replace('\\', "/").to_lowercase();
    let mut segs: Vec<&str> = vec![];
    for seg in cur.split('/') {
        match seg.trim() {
            "" | "." => {}
            ".." => {
                segs.pop();
            }
            _ => segs.push(seg),
        }
    }
    format!("/{}", segs.join("/"))
}

/// The P12 body law for a request about to be answered or relayed: chunked → 411, conflicting
/// Content-Length → 400; returns the declared length.
pub fn body_len(req: &Req) -> Result<u64, Resp> {
    if req.header("transfer-encoding").is_some() {
        return Err(Resp::text(411, "chunked request bodies are not accepted\n"));
    }
    let lens: Vec<&str> = req.headers.iter().filter(|(k, _)| k.eq_ignore_ascii_case("content-length")).map(|(_, v)| v.as_str()).collect();
    if lens.len() > 1 && lens.iter().any(|l| *l != lens[0]) {
        return Err(Resp::text(400, "conflicting content-length\n"));
    }
    lens.first().map(|l| l.parse::<u64>()).unwrap_or(Ok(0)).map_err(|_| Resp::text(400, "bad content-length\n"))
}

/// Header hygiene for a relayed request (P12): hop-by-hop and client-sent forwarding headers out,
/// every `X-Bifrost-*` out, then our own `Connection`, `X-Forwarded-For` (the real address) and
/// `X-Forwarded-Proto`; `edge` (the per-process edge key) is stamped when the hop vouches for XFF.
pub fn rewrite_head(req: &Req, ip: IpAddr, upgrade: bool, edge: Option<&str>) -> Vec<u8> {
    const DROP: &[&str] = &[
        "connection", "keep-alive", "proxy-connection", "forwarded", "x-forwarded-for",
        "x-forwarded-proto", "x-forwarded-host", "x-real-ip", "x-middleware-subrequest",
    ];
    let mut s = format!("{} {} {}\r\n", req.method, req.path, req.version);
    for (k, v) in &req.headers {
        let l = k.to_ascii_lowercase();
        if !DROP.contains(&l.as_str()) && !l.starts_with("x-bifrost-") {
            s.push_str(&format!("{k}: {v}\r\n"));
        }
    }
    s.push_str(if upgrade { "Connection: Upgrade\r\n" } else { "Connection: close\r\n" });
    s.push_str(&format!("X-Forwarded-For: {ip}\r\nX-Forwarded-Proto: https\r\n"));
    if let Some(h) = req.header("host") {
        s.push_str(&format!("X-Forwarded-Host: {h}\r\n"));
    }
    if let Some(k) = edge {
        s.push_str(&format!("X-Bifrost-Edge: {k}\r\n"));
    }
    s.push_str("\r\n");
    s.into_bytes()
}

// ---- responses -----------------------------------------------------------------------------------

pub const CSP_SHELL: &str = "default-src 'self'; script-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";
pub const CSP_API: &str = "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

#[derive(Debug, Clone)]
pub struct Resp {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

pub fn reason(status: u16) -> &'static str {
    match status {
        200 => "OK",
        201 => "Created",
        204 => "No Content",
        301 => "Moved Permanently",
        302 => "Found",
        304 => "Not Modified",
        400 => "Bad Request",
        401 => "Unauthorized",
        403 => "Forbidden",
        404 => "Not Found",
        405 => "Method Not Allowed",
        409 => "Conflict",
        410 => "Gone",
        411 => "Length Required",
        413 => "Payload Too Large",
        426 => "Upgrade Required",
        429 => "Too Many Requests",
        500 => "Internal Server Error",
        502 => "Bad Gateway",
        503 => "Service Unavailable",
        _ => "Status",
    }
}

impl Resp {
    pub fn new(status: u16, ctype: &str, body: impl Into<Vec<u8>>) -> Resp {
        Resp { status, headers: vec![("Content-Type".into(), ctype.into())], body: body.into() }
    }
    pub fn text(status: u16, body: &str) -> Resp {
        Resp::new(status, "text/plain; charset=utf-8", body)
    }
    pub fn json(status: u16, v: &serde_json::Value) -> Resp {
        Resp::new(status, "application/json", v.to_string())
    }
    pub fn html(status: u16, body: impl Into<Vec<u8>>) -> Resp {
        Resp::new(status, "text/html; charset=utf-8", body).header("Content-Security-Policy", CSP_SHELL)
    }
    pub fn redirect(to: &str) -> Resp {
        Resp::new(302, "text/plain; charset=utf-8", format!("→ {to}\n")).header("Location", to)
    }
    pub fn header(mut self, k: &str, v: &str) -> Resp {
        self.headers.push((k.into(), v.into()));
        self
    }
    pub fn has(&self, k: &str) -> bool {
        self.headers.iter().any(|(h, _)| h.eq_ignore_ascii_case(k))
    }
    /// A cookie (`Secure; HttpOnly; SameSite=Strict` always). `max_age` 0 = delete.
    pub fn cookie(self, name: &str, value: &str, path: &str, max_age: i64) -> Resp {
        let v = format!("{name}={value}; Path={path}; Max-Age={max_age}; HttpOnly; Secure; SameSite=Strict");
        self.header("Set-Cookie", &v)
    }

    /// The full response: our security headers on everything, `Connection: close` (P12).
    pub fn bytes(&self, head_only: bool) -> Vec<u8> {
        let mut s = format!("HTTP/1.1 {} {}\r\n", self.status, reason(self.status));
        for (k, v) in &self.headers {
            s.push_str(&format!("{k}: {v}\r\n"));
        }
        let std_headers: [(&str, &str); 5] = [
            ("Strict-Transport-Security", "max-age=31536000"),
            ("X-Content-Type-Options", "nosniff"),
            ("Referrer-Policy", "no-referrer"),
            ("Cache-Control", "no-store"),
            ("Content-Security-Policy", CSP_API),
        ];
        for (k, v) in std_headers {
            if !self.has(k) {
                s.push_str(&format!("{k}: {v}\r\n"));
            }
        }
        s.push_str(&format!("Content-Length: {}\r\nConnection: close\r\n\r\n", self.body.len()));
        let mut out = s.into_bytes();
        if !head_only {
            out.extend_from_slice(&self.body);
        }
        out
    }
}

pub async fn write_resp<W: AsyncWrite + Unpin + ?Sized>(w: &mut W, r: &Resp, head_only: bool) -> io::Result<()> {
    w.write_all(&r.bytes(head_only)).await?;
    w.flush().await?;
    let _ = w.shutdown().await;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn req(raw: &str) -> Req {
        parse_head(raw.as_bytes()).unwrap()
    }

    #[test]
    fn p12_body_law() {
        assert_eq!(body_len(&req("POST /t/x HTTP/1.1\r\nTransfer-Encoding: chunked\r\n\r\n")).unwrap_err().status, 411);
        assert_eq!(body_len(&req("POST /t/x HTTP/1.1\r\nContent-Length: 3\r\nContent-Length: 4\r\n\r\n")).unwrap_err().status, 400);
        assert_eq!(body_len(&req("POST /t/x HTTP/1.1\r\nContent-Length: 3\r\nContent-Length: 3\r\n\r\n")).unwrap(), 3);
        assert_eq!(body_len(&req("POST /t/x HTTP/1.1\r\nContent-Length: x\r\n\r\n")).unwrap_err().status, 400);
        assert_eq!(body_len(&req("GET / HTTP/1.1\r\n\r\n")).unwrap(), 0);
    }

    #[test]
    fn header_hygiene() {
        let r = req("GET /x HTTP/1.1\r\nHost: a\r\nX-Forwarded-For: 6.6.6.6\r\nForwarded: for=6.6.6.6\r\nX-Bifrost-Edge: forged\r\nX-Bifrost-Device: x\r\nConnection: keep-alive\r\nCookie: a=b\r\n\r\n");
        let out = String::from_utf8(rewrite_head(&r, "8.8.4.4".parse().unwrap(), false, Some("k1"))).unwrap();
        assert!(!out.contains("6.6.6.6") && !out.contains("forged") && !out.contains("X-Bifrost-Device"));
        assert!(out.contains("X-Forwarded-For: 8.8.4.4\r\n") && out.contains("Connection: close\r\n") && out.contains("X-Bifrost-Edge: k1\r\n"));
        assert!(out.contains("Cookie: a=b\r\n"));
    }

    #[test]
    fn normalize() {
        assert_eq!(normalize_path("/x/../T/%61uth//login?q"), "/t/auth/login");
        assert_eq!(normalize_path("/%2574"), "/t");
        assert_eq!(normalize_path("\\t\\root"), "/t/root");
    }

    #[test]
    fn response_has_the_security_headers() {
        let r = String::from_utf8(Resp::html(200, "<p>").bytes(false)).unwrap();
        for h in ["Strict-Transport-Security: max-age=31536000", "X-Content-Type-Options: nosniff", "Referrer-Policy: no-referrer", "Connection: close", "frame-ancestors 'none'"] {
            assert!(r.contains(h), "{h}");
        }
        assert!(r.contains(&format!("Content-Security-Policy: {CSP_SHELL}")));
        assert_eq!(r.matches("Content-Security-Policy").count(), 1);
    }

    #[test]
    fn query_and_cookies() {
        let r = req("GET /t/x?u=a%20b&v=2 HTTP/1.1\r\nCookie: bifrost_device=v4.public.x; other=1\r\n\r\n");
        assert_eq!(r.query("u").as_deref(), Some("a b"));
        assert_eq!(r.route(), "/t/x");
        assert_eq!(r.cookie("bifrost_device").as_deref(), Some("v4.public.x"));
    }
}

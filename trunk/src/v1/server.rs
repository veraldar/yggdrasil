//! The v1 trunk's listener and router (CONTRACTS.md C1 `v1/server.rs`).
//!
//! Listeners: `listen_http` (phase 1, plain http behind Caddy: XFF believed only from
//! `trusted_proxies`), `listen_tls` (phase 2, own TLS — the edge lifted from `ap.rs`; PROXY v1 first
//! when `proxy_protocol`, accepted only from `trusted_proxies`), `listen_ice` (WIRE), the ctl socket.
//!
//! Every connection carries exactly one request (P12). The router, in order:
//!   1. `relay::route` — WIRE's own routes (`/t/root`, `/t/roots*`, `/t/me/roots`, `/t/me/door`,
//!      `/t/ice/owner`); it hands back what is not its own;
//!   2. the trunk's namespace — `/t/*` (idp api, `/t/s/*` assets), the shell pages, `/install/*`,
//!      `/.well-known/acme-challenge/*` — matched on the canonical path only (a path that only
//!      normalizes into this namespace is a 404, never relayed);
//!   3. everything else: the C3 token check, then `relay::to_door` (302 `/login` for a page /
//!      401 `{"why","reauth"}` for anything else without a valid token).

use std::net::{IpAddr, SocketAddr};
use std::sync::{Arc, RwLock};
use std::time::Duration;

use rusqlite::OptionalExtension;
use tokio::net::TcpListener;
use tokio::time::timeout;

use super::config::{canon, Cidr, Config};
use super::crypto::{Kek, SigningKey};
use super::db::{now_ms, Db};
use super::http::{self, normalize_path, parse_head, read_head, read_proxy_v1, Io, Req, Resp};
use super::idp;
use super::install;
use super::paseto::{self, Claims, VerifyKey, Why};
use super::relay;
use super::shell;
use crate::region::region_of;

pub struct State {
    pub cfg: Config,
    pub db: Db,
    pub kek: Kek,
    /// `trk_…`, made at first start
    pub trunk_id: String,
    /// the trunk's identity key (C4 handshake + signed control messages; WIRE)
    pub trunk_key: SigningKey,
    signing: RwLock<Arc<SigningKey>>,
    verify_keys: RwLock<Vec<VerifyKey>>,
    pub idp: idp::Idp,
    pub relay: relay::Relay,
    /// TRUNK_TEST_FAST=1: rigs only — shorter timers (idp::Timers)
    pub fast: bool,
    /// a per-process secret stamped on relayed streams next to the XFF it vouches for
    pub edge_key: String,
    trusted: Vec<Cidr>,
}

/// One accepted request: the stream, its head, the bytes already read past the head, the real
/// client address (`ip`) and the socket peer (`peer`, the proxy when there is one).
pub struct Incoming {
    pub io: Box<dyn Io>,
    pub head: Vec<u8>,
    pub rest: Vec<u8>,
    pub req: Req,
    pub peer: SocketAddr,
    pub ip: IpAddr,
    pub tls: bool,
}

impl Incoming {
    /// The request body under the P12 law (chunked → 411, conflicting lengths → 400), at most `max`.
    pub async fn body(&mut self, max: u64) -> Result<Vec<u8>, Resp> {
        use tokio::io::AsyncReadExt as _;
        let n = http::body_len(&self.req)?;
        if n > max {
            return Err(Resp::text(413, "body too large\n"));
        }
        let mut b = std::mem::take(&mut self.rest);
        b.truncate(n as usize);
        let need = n as usize - b.len();
        if need > 0 {
            let mut more = vec![0u8; need];
            match timeout(Duration::from_secs(30), self.io.read_exact(&mut more)).await {
                Ok(Ok(_)) => b.extend_from_slice(&more),
                _ => return Err(Resp::text(400, "body incomplete\n")),
            }
        }
        Ok(b)
    }

    pub fn region(&self) -> String {
        region_of(self.ip)
    }

    pub async fn answer(mut self, r: Resp) {
        let head_only = self.req.method == "HEAD";
        let _ = http::write_resp(&mut self.io, &r, head_only).await;
    }
}

impl State {
    pub fn open(cfg: Config) -> Result<State, String> {
        let kek = Kek::load(&format!("{}/trunk-kek", cfg.cred_dir.trim_end_matches('/')))?;
        let db = Db::open(&cfg.db)?;
        State::with(cfg, db, kek)
    }

    pub fn with(cfg: Config, db: Db, kek: Kek) -> Result<State, String> {
        let trunk_id = match db.meta_get("trunk_id") {
            Some(id) => id,
            None => {
                let id = super::crypto::new_id("trk");
                db.meta_set("trunk_id", &id)?;
                db.meta_set("host", &cfg.host())?;
                id
            }
        };
        let trunk_key = match db.meta_get("trunk_key_enc").and_then(|s| super::crypto::unb64u(&s)) {
            Some(blob) => {
                let seed = kek.open("trunk_key", &blob)?;
                SigningKey::from_seed(seed.try_into().map_err(|_| "trunk_key: bad seed")?)
            }
            None => {
                let k = SigningKey::generate();
                db.meta_set("trunk_key_enc", &super::crypto::b64u(&kek.seal("trunk_key", k.seed())))?;
                db.meta_set("trunk_key_pub", &super::crypto::b64u(&k.public()))?;
                k
            }
        };
        let signing = load_signing(&db, &kek)?;
        let fast = std::env::var("TRUNK_TEST_FAST").is_ok_and(|v| v == "1");
        let trusted = cfg.trusted();
        let st = State {
            idp: idp::Idp::new(fast),
            cfg,
            db,
            kek,
            trunk_id,
            trunk_key,
            signing: RwLock::new(Arc::new(signing)),
            verify_keys: RwLock::new(vec![]),
            relay: relay::Relay::default(),
            fast,
            edge_key: super::crypto::hex(&super::crypto::random_bytes::<32>()),
            trusted,
        };
        st.reload_keys()?;
        Ok(st)
    }

    pub fn signing_key(&self) -> Arc<SigningKey> {
        self.signing.read().unwrap_or_else(|e| e.into_inner()).clone()
    }

    /// Every token key (C3 `keys[]`): kid, public, retired.
    pub fn verify_keys(&self) -> Vec<VerifyKey> {
        self.verify_keys.read().unwrap_or_else(|e| e.into_inner()).clone()
    }

    /// `keys[]` as the root side sees it (C5 `trunk-state.json`).
    pub fn keys_json(&self) -> serde_json::Value {
        let rows = self
            .db
            .with(|c| {
                let mut s = c.prepare("SELECT kid, alg, public, retired_at FROM signing_keys ORDER BY created_at")?;
                let v = s
                    .query_map([], |r| {
                        Ok(serde_json::json!({
                            "kid": r.get::<_, String>(0)?, "alg": r.get::<_, String>(1)?,
                            "public": super::crypto::b64u(&r.get::<_, Vec<u8>>(2)?), "retired_at": r.get::<_, Option<i64>>(3)?,
                        }))
                    })?
                    .collect::<Result<Vec<_>, _>>()?;
                Ok(v)
            })
            .unwrap_or_default();
        serde_json::Value::Array(rows)
    }

    pub fn reload_keys(&self) -> Result<(), String> {
        let keys = self.db.with(|c| {
            let mut s = c.prepare("SELECT kid, public, retired_at FROM signing_keys")?;
            let v = s
                .query_map([], |r| Ok(VerifyKey { kid: r.get(0)?, public: r.get(1)?, retired: r.get::<_, Option<i64>>(2)?.is_some() }))?
                .collect::<Result<Vec<_>, _>>()?;
            Ok(v)
        })?;
        *self.verify_keys.write().unwrap_or_else(|e| e.into_inner()) = keys;
        Ok(())
    }

    /// Generate a new Ed25519 access-token signing key, make it active, and push the updated key
    /// set to every connected root (`relay::keys_changed`). Old keys stay valid until retired.
    pub fn rotate_signing_key(st: &Arc<State>) -> Result<String, String> {
        let k = SigningKey::generate();
        let kid = k.kid();
        let blob = st.kek.seal(&format!("signing_key:{kid}"), k.seed());
        st.db.with(|c| {
            c.execute(
                "INSERT INTO signing_keys (kid, alg, public, private_enc, created_at) VALUES (?1, 'ed25519', ?2, ?3, ?4)",
                rusqlite::params![kid, k.public().to_vec(), blob, now_ms()],
            )
            .map(|_| ())
        })?;
        *st.signing.write().unwrap_or_else(|e| e.into_inner()) = Arc::new(k);
        st.reload_keys()?;
        relay::keys_changed(st);
        idp::audit(st, idp::audit::Entry::new("key.rotate").target("signing_key", &kid));
        Ok(kid)
    }

    pub fn kill_epoch(&self) -> u64 {
        self.db.meta_get("kill_epoch").and_then(|v| v.parse().ok()).unwrap_or(0)
    }

    pub fn lockdown(&self) -> bool {
        self.db.meta_get("lockdown").is_some_and(|v| v == "1")
    }

    pub fn claimed(&self) -> bool {
        self.db.meta_get("claimed_at").is_some()
    }

    /// The trunk's own deny check: a revoked (or unknown) device.
    pub fn device_denied(&self, did: &str) -> bool {
        self.db
            .with(|c| c.query_row("SELECT revoked_at FROM devices WHERE id = ?1", [did], |r| r.get::<_, Option<i64>>(0)).optional())
            .map(|r| !matches!(r, Some(None)))
            .unwrap_or(true)
    }

    /// The access token a request carries: the `bifrost_device` cookie, else `Authorization: Bearer`.
    pub fn token_of(req: &Req) -> Option<String> {
        req.cookie("bifrost_device").or_else(|| {
            req.header("authorization").and_then(|v| v.strip_prefix("Bearer ").map(|t| t.trim().to_string()))
        })
    }

    /// C3, in order, for a request from `ip`.
    pub fn check_access(&self, req: &Req, ip: IpAddr) -> Result<Claims, Why> {
        let tok = State::token_of(req);
        let region = region_of(ip);
        let keys = self.verify_keys();
        let issuers = self.cfg.write_origins();
        let denied = |did: &str| self.device_denied(did);
        let ctx = paseto::Ctx { now: now_ms() / 1000, region: &region, kill_epoch: self.kill_epoch(), denied: &denied, issuers: &issuers };
        paseto::verify_access(tok.as_deref(), &keys, &ctx)
    }

    /// The real client address: XFF's last hop only from a trusted proxy (plain http); the PROXY
    /// line already gave it on TLS.
    fn client_ip(&self, req: &Req, peer: SocketAddr, tls: bool) -> IpAddr {
        let p = canon(peer.ip());
        if !tls && self.trusted.iter().any(|c| c.contains(p)) {
            if let Some(ip) = req
                .header("x-forwarded-for")
                .and_then(|v| v.rsplit(',').next())
                .and_then(|s| s.trim().parse::<IpAddr>().ok())
            {
                return canon(ip);
            }
        }
        p
    }

    pub fn is_trusted_proxy(&self, ip: IpAddr) -> bool {
        self.trusted.iter().any(|c| c.contains(canon(ip)))
    }
}

fn load_signing(db: &Db, kek: &Kek) -> Result<SigningKey, String> {
    let row: Option<(String, Vec<u8>)> = db.with(|c| {
        c.query_row(
            "SELECT kid, private_enc FROM signing_keys WHERE retired_at IS NULL ORDER BY created_at DESC LIMIT 1",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()
    })?;
    if let Some((kid, blob)) = row {
        let seed = kek.open(&format!("signing_key:{kid}"), &blob)?;
        return Ok(SigningKey::from_seed(seed.try_into().map_err(|_| "signing key: bad seed")?));
    }
    let k = SigningKey::generate();
    let kid = k.kid();
    let blob = kek.seal(&format!("signing_key:{kid}"), k.seed());
    db.with(|c| {
        c.execute(
            "INSERT INTO signing_keys (kid, alg, public, private_enc, created_at) VALUES (?1, 'ed25519', ?2, ?3, ?4)",
            rusqlite::params![kid, k.public().to_vec(), blob, now_ms()],
        )
        .map(|_| ())
    })?;
    Ok(k)
}

// ---- run -------------------------------------------------------------------------------------

pub fn run(path: &str) -> Result<(), String> {
    let cfg = Config::load(path)?;
    let rt = tokio::runtime::Builder::new_multi_thread().enable_all().build().map_err(|e| e.to_string())?;
    rt.block_on(async move {
        let st = Arc::new(State::open(cfg)?);
        println!("bifrost-net trunk {} (config: {path}) — {}", env!("CARGO_PKG_VERSION"), st.cfg.origin());
        println!("  trunk: id {} · schema {} · {}", st.trunk_id, st.db.schema_version(), if st.claimed() { "claimed" } else { "UNCLAIMED" });
        if st.fast {
            println!("  trunk: TRUNK_TEST_FAST=1 — rig timers (never in production)");
        }
        println!("  trunk: passkeys for rp_id {} from {}", st.cfg.rp_id(), st.cfg.passkey_origins().join(", "));
        super::idp::oauth::log_startup(&st);
        serve(st).await
    })
}

/// Bind every configured listener and serve until the process ends. Returns only on a bind error.
pub async fn serve(st: Arc<State>) -> Result<(), String> {
    let ready = start(st).await?;
    drop(ready);
    std::future::pending::<()>().await;
    Ok(())
}

/// The bound addresses (tests and rigs ask for port 0).
pub struct Bound {
    pub http: Option<SocketAddr>,
    pub tls: Option<SocketAddr>,
    pub ice: Option<SocketAddr>,
}

pub async fn start(st: Arc<State>) -> Result<Bound, String> {
    let mut bound = Bound { http: None, tls: None, ice: None };
    super::ctl::serve(st.clone()).await?;
    idp::spawn_background(st.clone());
    if !st.cfg.listen_http.is_empty() {
        let l = TcpListener::bind(&st.cfg.listen_http).await.map_err(|e| format!("listen_http {}: {e}", st.cfg.listen_http))?;
        let a = l.local_addr().map_err(|e| e.to_string())?;
        println!("  trunk: http {a} (behind a proxy; XFF trusted from {:?})", st.cfg.trusted_proxies);
        bound.http = Some(a);
        let st = st.clone();
        tokio::spawn(async move {
            loop {
                let Ok((tcp, peer)) = l.accept().await else {
                    tokio::time::sleep(Duration::from_millis(50)).await;
                    continue;
                };
                let _ = tcp.set_nodelay(true);
                tokio::spawn(handle_conn(st.clone(), Box::new(tcp), peer, false));
            }
        });
    }
    if !st.cfg.listen_tls.is_empty() {
        let acceptor = tls_acceptor(&st.cfg)?;
        let l = TcpListener::bind(&st.cfg.listen_tls).await.map_err(|e| format!("listen_tls {}: {e}", st.cfg.listen_tls))?;
        let a = l.local_addr().map_err(|e| e.to_string())?;
        println!("  trunk: https {a}{}", if st.cfg.proxy_protocol { " (PROXY v1 first)" } else { "" });
        bound.tls = Some(a);
        let st = st.clone();
        tokio::spawn(async move {
            loop {
                let Ok((mut tcp, peer)) = l.accept().await else {
                    tokio::time::sleep(Duration::from_millis(50)).await;
                    continue;
                };
                let _ = tcp.set_nodelay(true);
                let (st, acceptor) = (st.clone(), acceptor.clone());
                tokio::spawn(async move {
                    let real = if st.cfg.proxy_protocol {
                        if !st.is_trusted_proxy(peer.ip()) {
                            return; // a PROXY line is believed only from the router
                        }
                        match timeout(Duration::from_secs(5), read_proxy_v1(&mut tcp, peer)).await {
                            Ok(Ok(p)) => p,
                            _ => return,
                        }
                    } else {
                        peer
                    };
                    let Ok(Ok(tls)) = timeout(Duration::from_secs(10), acceptor.accept(tcp)).await else { return };
                    handle_conn(st, Box::new(tls), real, true).await;
                });
            }
        });
    }
    if !st.cfg.listen_ice.is_empty() {
        let l = TcpListener::bind(&st.cfg.listen_ice).await.map_err(|e| format!("listen_ice {}: {e}", st.cfg.listen_ice))?;
        bound.ice = l.local_addr().ok();
        tokio::spawn(relay::serve_ice(st.clone(), l));
    }
    relay::spawn_ap_meter(&st);
    Ok(bound)
}

fn tls_acceptor(cfg: &Config) -> Result<tokio_rustls::TlsAcceptor, String> {
    use rustls::pki_types::pem::PemObject as _;
    use rustls::pki_types::{CertificateDer, PrivateKeyDer};
    let certs: Vec<CertificateDer<'static>> = CertificateDer::pem_file_iter(&cfg.cert_path)
        .map_err(|e| format!("cert_path {}: {e}", cfg.cert_path))?
        .collect::<Result<_, _>>()
        .map_err(|e| format!("cert_path {}: {e}", cfg.cert_path))?;
    let key = PrivateKeyDer::from_pem_file(&cfg.key_path).map_err(|e| format!("key_path {}: {e}", cfg.key_path))?;
    let mut sc = rustls::ServerConfig::builder_with_provider(Arc::new(rustls::crypto::ring::default_provider()))
        .with_protocol_versions(&[&rustls::version::TLS13, &rustls::version::TLS12])
        .map_err(|e| e.to_string())?
        .with_no_client_auth()
        .with_single_cert(certs, key)
        .map_err(|e| format!("cert/key: {e}"))?;
    sc.alpn_protocols = vec![b"http/1.1".to_vec()];
    Ok(tokio_rustls::TlsAcceptor::from(Arc::new(sc)))
}

async fn handle_conn(st: Arc<State>, mut io: Box<dyn Io>, peer: SocketAddr, tls: bool) {
    let (head, rest) = match timeout(Duration::from_secs(30), read_head(&mut io)).await {
        Ok(Ok(Some(x))) => x,
        _ => return,
    };
    let req = match parse_head(&head) {
        Ok(r) => r,
        Err(e) => {
            let _ = http::write_resp(&mut io, &Resp::text(400, &format!("{e}\n")), false).await;
            return;
        }
    };
    let ip = st.client_ip(&req, peer, tls);
    let inc = Incoming { io, head, rest, req, peer, ip, tls };
    dispatch(st, inc).await;
}

/// Is `p` (normalized) inside the trunk's own namespace (never relayed)?
pub fn trunk_namespace(p: &str) -> bool {
    p == "/t"
        || p.starts_with("/t/")
        || p.starts_with("/install/")
        || p == "/install"
        || p.starts_with("/.well-known/acme-challenge/")
        || shell::is_page(p)
}

pub async fn dispatch(st: Arc<State>, inc: Incoming) {
    // the P12 body law on everything, before any route sees the request
    if let Err(r) = http::body_len(&inc.req) {
        return inc.answer(r).await;
    }
    // 1. WIRE's routes
    let Some(inc) = relay::route(&st, inc).await else { return };
    let raw = inc.req.route().to_string();
    let np = normalize_path(&raw);
    // 2. the trunk's namespace, canonical paths only
    if trunk_namespace(&np) {
        // canonical = no encoding, no dot or empty segments (case is matched by each route itself)
        let low = raw.to_lowercase();
        if np != low && !(low.len() > 1 && low.trim_end_matches('/') == np) {
            return inc.answer(Resp::text(404, "not here\n")).await;
        }
        if np == "/t" || np.starts_with("/t/") {
            return idp::api::handle(st, inc).await;
        }
        if np.starts_with("/install") {
            let r = install::serve(&st, &raw);
            return inc.answer(r).await;
        }
        if np.starts_with("/.well-known/acme-challenge/") {
            let r = shell::acme(&st, &raw);
            return inc.answer(r).await;
        }
        return shell::page(st, inc).await;
    }
    // 3. everything else belongs to the door root, behind the token
    if !st.claimed() {
        let r = if shell::wants_page(&inc.req) { Resp::redirect("/claim") } else { Resp::json(401, &serde_json::json!({"why":"missing","reauth":"login"})) };
        return inc.answer(r).await;
    }
    match st.check_access(&inc.req, inc.ip) {
        Ok(who) => {
            if !relay::has_roots(&st) {
                let r = shell::empty_trunk_for(&st, &inc.req, &np);
                return inc.answer(r).await;
            }
            relay::to_door(&st, inc, who).await
        }
        Err(why) => {
            let r = if shell::wants_page(&inc.req) {
                // the login page first tries the refresh cookie, then comes back here
                let p = inc.req.path.clone();
                if p == "/" || p.contains(['\r', '\n']) || !p.starts_with('/') || p.starts_with("//") {
                    Resp::redirect("/login")
                } else {
                    Resp::redirect(&format!("/login?next={}", shell::url_enc(&p)))
                }
            } else {
                Resp::json(401, &serde_json::from_str(&why.body()).unwrap_or_default())
            };
            inc.answer(r).await
        }
    }
}

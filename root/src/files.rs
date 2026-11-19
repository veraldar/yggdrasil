//! Files are files (package 2, decision L5). A root keeps a content-addressed store under its data
//! dir, outside the artifacts gallery: `files/blobs/<sha256>`. A message carries a reference to a
//! file — `{type:"file", mime, filename, url:"/file/<hash>", hash, size, root}` — never its bytes.
//!
//! - The phone uploads a file in pieces to its home root (`POST /file/upload`, then
//!   `PUT /file/upload/{id}?offset=N`, ≤ 1 MiB each), so no hop on the way (Next's 10 MB body
//!   clone, the access point's 1 MB frame, the tunnel's 4 MB) ever sees a big body.
//! - A root that gets a message naming a file it lacks pulls it, piece by piece, from the root the
//!   reference names (`GET /file/{hash}?offset=&len=`), before the turn runs (`prepare`).
//! - The model gets images as images, small text files inline, everything else as a path; a
//!   harness session (Claude Code, opencode, agy, codex) gets one line per file with its path
//!   (`files/named/<hash>/<name>`, a hard link to the blob that keeps the file's own name).
//! - A file a session made for the owner on any root (its artifacts folder) is shared the same
//!   way: `POST /file/artifact {name, root?, session?}` stores it, pulls it home, answers a REF.
//!
//! One limit: YGG_FILE_MAX_MB per file (default 100). Messages with `data:` URLs still work: a
//! new one is stored as a file at the door (`ingest_data_urls`).

use std::{
    collections::HashMap,
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::Duration,
};

use axum::{
    Json,
    body::{Body, Bytes},
    extract::{Path as UrlPath, Query, State},
    http::{HeaderValue, StatusCode, header},
    response::{IntoResponse, Response},
};
use base64::Engine;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use crate::{AppState, now_ms};

/// The piece size, both ways: the phone's upload and a pull between roots.
pub const PIECE: u64 = 1 << 20;
/// A text file up to this size reaches a brain-native model inline, as text.
const INLINE_MAX: u64 = 100 * 1024;
const UPLOAD_TTL_MS: u64 = 3_600_000;

#[derive(Default)]
pub struct Files {
    uploads: Mutex<HashMap<String, Upload>>,
    /// one pull per hash at a time (a second asker waits, then finds it here)
    pulls: Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
}

struct Upload {
    name: String,
    mime: String,
    size: u64,
    have: u64,
    created: u64,
}

pub fn max_bytes() -> u64 {
    std::env::var("YGG_FILE_MAX_MB").ok().and_then(|v| v.trim().parse::<u64>().ok()).filter(|n| *n > 0).unwrap_or(100) << 20
}

fn root_dir(st: &AppState) -> PathBuf {
    st.data_dir.join("files")
}

pub fn blob(st: &AppState, hash: &str) -> PathBuf {
    root_dir(st).join("blobs").join(hash)
}

pub fn valid_hash(h: &str) -> bool {
    h.len() == 64 && h.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// A file name that is safe as one path segment, and still reads like the original.
pub fn safe_name(name: &str) -> String {
    let base = name.rsplit(['/', '\\']).next().unwrap_or_default();
    let mut out: String = base
        .chars()
        .map(|c| if c.is_alphanumeric() || "._- ()+,".contains(c) { c } else { '_' })
        .collect::<String>()
        .trim()
        .trim_start_matches('.')
        .chars()
        .take(120)
        .collect();
    if out.is_empty() {
        out = "file".into();
    }
    out
}

/// "6.1 MB", "512 KB", "37 bytes" — how a size reads in a line the model or the owner sees.
pub fn human_size(n: u64) -> String {
    match n {
        n if n >= 1 << 20 => format!("{:.1} MB", n as f64 / (1u64 << 20) as f64),
        n if n >= 1024 => format!("{} KB", n.div_ceil(1024)),
        n => format!("{n} bytes"),
    }
}

/// The limit, said plainly (the composer shows this text as it is).
pub fn too_big(name: &str, size: u64) -> String {
    format!("{} is {}. The limit is {} per file.", name, human_size(size), human_size(max_bytes()))
}

pub fn mime_of(name: &str) -> &'static str {
    let ext = name.rsplit_once('.').map(|(_, e)| e.to_ascii_lowercase()).unwrap_or_default();
    match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "heic" => "image/heic",
        "html" | "htm" => "text/html",
        "md" | "txt" | "log" | "csv" | "tsv" | "yaml" | "yml" | "toml" | "ini" | "conf" | "xml" | "css" | "js" | "mjs" | "ts" | "tsx"
        | "jsx" | "py" | "sh" | "rb" | "go" | "rs" | "java" | "c" | "h" | "cpp" | "diff" | "patch" => "text/plain",
        "json" => "application/json",
        "pdf" => "application/pdf",
        "zip" => "application/zip",
        "wav" => "audio/wav",
        "mp3" => "audio/mpeg",
        "m4a" => "audio/mp4",
        "mp4" => "video/mp4",
        "mov" => "video/quicktime",
        _ => "application/octet-stream",
    }
}

/// A mime type as a client states it: kept when it looks like one, else guessed from the name.
fn clean_mime(mime: Option<&str>, name: &str) -> String {
    match mime.map(str::trim) {
        Some(m) if !m.is_empty() && m.len() < 128 && m.contains('/') && m.bytes().all(|b| b.is_ascii_alphanumeric() || b"/+-.;= ".contains(&b)) => {
            m.to_string()
        }
        _ => mime_of(name).to_string(),
    }
}

fn is_text(mime: &str, name: &str) -> bool {
    mime.starts_with("text/") || matches!(mime, "application/json" | "application/xml" | "application/x-yaml") || mime_of(name) == "text/plain"
}

/// The part a message stores for a file.
pub fn file_part(hash: &str, name: &str, mime: &str, size: u64, root: &str) -> Value {
    json!({ "type": "file", "mime": mime, "filename": name, "url": format!("/file/{hash}"), "hash": hash, "size": size, "root": root })
}

fn reference(hash: &str, name: &str, mime: &str, size: u64, root: &str) -> Value {
    json!({ "hash": hash, "name": name, "mime": mime, "size": size, "root": root })
}

fn hash_file(path: &Path) -> std::io::Result<(String, u64)> {
    let mut f = std::fs::File::open(path)?;
    let mut h = Sha256::new();
    let mut buf = vec![0u8; 1 << 16];
    let mut n = 0u64;
    loop {
        let k = f.read(&mut buf)?;
        if k == 0 {
            break;
        }
        n += k as u64;
        h.update(&buf[..k]);
    }
    Ok((hex(&h.finalize()), n))
}

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

#[cfg(unix)]
fn private(path: &Path) {
    use std::os::unix::fs::PermissionsExt;
    let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
}
#[cfg(not(unix))]
fn private(_: &Path) {}

/// Moves a finished temp file into the store under its hash (a copy already there wins).
fn settle(st: &AppState, tmp: &Path, hash: &str) -> std::io::Result<()> {
    let to = blob(st, hash);
    std::fs::create_dir_all(to.parent().unwrap())?;
    if to.exists() {
        let _ = std::fs::remove_file(tmp);
        return Ok(());
    }
    private(tmp);
    std::fs::rename(tmp, &to)
}

fn tmp_path(st: &AppState, what: &str) -> PathBuf {
    let d = root_dir(st).join("tmp");
    let _ = std::fs::create_dir_all(&d);
    d.join(format!("{what}.{}", uuid::Uuid::new_v4().simple()))
}

/// Stores bytes; returns their hash.
pub fn put_bytes(st: &AppState, bytes: &[u8]) -> std::io::Result<String> {
    let hash = hex(&Sha256::digest(bytes));
    if blob(st, &hash).exists() {
        return Ok(hash);
    }
    let tmp = tmp_path(st, "put");
    std::fs::write(&tmp, bytes)?;
    settle(st, &tmp, &hash)?;
    Ok(hash)
}

pub fn size_of(st: &AppState, hash: &str) -> Option<u64> {
    if !valid_hash(hash) {
        return None;
    }
    std::fs::metadata(blob(st, hash)).ok().filter(|m| m.is_file()).map(|m| m.len())
}

/// The file under its own name, for a tool or a harness to open (a hard link to the blob).
pub fn named(st: &AppState, hash: &str, name: &str) -> std::io::Result<PathBuf> {
    let d = root_dir(st).join("named").join(hash);
    std::fs::create_dir_all(&d)?;
    let p = d.join(safe_name(name));
    if !p.exists() {
        let b = blob(st, hash);
        if std::fs::hard_link(&b, &p).is_err() {
            std::fs::copy(&b, &p)?;
            private(&p);
        }
    }
    Ok(p)
}

/// At startup: half-done uploads and pulls are gone with the process that made them.
pub fn sweep(st: &AppState) {
    for d in ["tmp", "up"] {
        let _ = std::fs::remove_dir_all(root_dir(st).join(d));
    }
}

// ---- the phone's upload, in pieces --------------------------------------------------------

/// `POST /file/upload` `{name, mime, size}` → `{upload, piece}` (a 0-byte file: `{…, file}` at once).
pub async fn upload_start(State(st): State<AppState>, Json(b): Json<Value>) -> Response {
    let name = safe_name(b["name"].as_str().unwrap_or("file"));
    let Some(size) = b["size"].as_u64() else { return err(StatusCode::BAD_REQUEST, "size required") };
    if size > max_bytes() {
        return (StatusCode::PAYLOAD_TOO_LARGE, Json(json!({ "error": too_big(&name, size), "limit": max_bytes() }))).into_response();
    }
    let mime = clean_mime(b["mime"].as_str(), &name);
    let id = format!("up_{}", uuid::Uuid::new_v4().simple());
    {
        let mut ups = st.files.uploads.lock().unwrap();
        let now = now_ms();
        let stale: Vec<String> = ups.iter().filter(|(_, u)| now.saturating_sub(u.created) > UPLOAD_TTL_MS).map(|(k, _)| k.clone()).collect();
        for k in stale {
            ups.remove(&k);
            let _ = std::fs::remove_file(root_dir(&st).join("up").join(&k));
        }
        ups.insert(id.clone(), Upload { name: name.clone(), mime: mime.clone(), size, have: 0, created: now });
    }
    if size == 0 {
        return match put_bytes(&st, &[]) {
            Ok(hash) => {
                st.files.uploads.lock().unwrap().remove(&id);
                Json(json!({ "upload": id, "piece": PIECE, "have": 0, "file": reference(&hash, &name, &mime, 0, &st.config.peers.me) })).into_response()
            }
            Err(e) => err(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()),
        };
    }
    Json(json!({ "upload": id, "piece": PIECE })).into_response()
}

/// `PUT /file/upload/{id}?offset=N` — one piece, in order. A piece sent again is acknowledged;
/// a gap answers 409 `{have}` (go on from there). The last piece answers `{have, file}`.
pub async fn upload_piece(State(st): State<AppState>, UrlPath(id): UrlPath<String>, Query(q): Query<HashMap<String, String>>, body: Bytes) -> Response {
    let offset = q.get("offset").and_then(|o| o.parse::<u64>().ok()).unwrap_or(0);
    let len = body.len() as u64;
    if len > PIECE {
        return err(StatusCode::PAYLOAD_TOO_LARGE, &format!("a piece is at most {} bytes", PIECE));
    }
    let path = root_dir(&st).join("up").join(&id);
    let done = {
        let mut ups = st.files.uploads.lock().unwrap();
        let Some(u) = ups.get_mut(&id) else { return err(StatusCode::NOT_FOUND, "no such upload (it may have expired: start it again)") };
        if offset != u.have {
            if offset + len <= u.have {
                return Json(json!({ "have": u.have })).into_response();
            }
            return (StatusCode::CONFLICT, Json(json!({ "error": "out of order", "have": u.have }))).into_response();
        }
        if u.have + len > u.size {
            return err(StatusCode::BAD_REQUEST, "more bytes than the size given at the start");
        }
        let wrote = std::fs::create_dir_all(path.parent().unwrap())
            .and_then(|_| std::fs::OpenOptions::new().create(true).append(true).open(&path))
            .and_then(|mut f| f.write_all(&body));
        if let Err(e) = wrote {
            return err(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string());
        }
        u.have += len;
        if u.have < u.size {
            return Json(json!({ "have": u.have })).into_response();
        }
        let u = ups.remove(&id).unwrap();
        (u.name, u.mime, u.size)
    };
    let (name, mime, size) = done;
    let st2 = st.clone();
    let settled = tokio::task::spawn_blocking(move || {
        let (hash, n) = hash_file(&path)?;
        if n != size {
            return Err(std::io::Error::other(format!("got {n} bytes, expected {size}")));
        }
        settle(&st2, &path, &hash)?;
        Ok(hash)
    })
    .await;
    match settled {
        Ok(Ok(hash)) => {
            let _ = named(&st, &hash, &name);
            Json(json!({ "have": size, "file": reference(&hash, &name, &mime, size, &st.config.peers.me) })).into_response()
        }
        Ok(Err(e)) => err(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()),
        Err(e) => err(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()),
    }
}

fn err(code: StatusCode, msg: &str) -> Response {
    (code, Json(json!({ "error": msg }))).into_response()
}

// ---- serving, and pulling from another root --------------------------------------------

/// `GET /file/{hash}/info` → `{size}`.
pub async fn file_info(State(st): State<AppState>, UrlPath(hash): UrlPath<String>) -> Response {
    match size_of(&st, &hash) {
        Some(n) => Json(json!({ "size": n })).into_response(),
        None => err(StatusCode::NOT_FOUND, "no such file here"),
    }
}

/// `GET /file/{hash}` — the bytes (`?offset=&len=`: one piece, for a root pulling it). With
/// `?root=R` a file not here yet is pulled from R first.
pub async fn get_file(State(st): State<AppState>, UrlPath(hash): UrlPath<String>, Query(q): Query<HashMap<String, String>>) -> Response {
    if !valid_hash(&hash) {
        return err(StatusCode::BAD_REQUEST, "not a file hash");
    }
    if size_of(&st, &hash).is_none() {
        match q.get("root").filter(|r| !r.is_empty() && **r != st.config.peers.me) {
            Some(r) => {
                if let Err(e) = pull(&st, r, &hash).await {
                    return err(StatusCode::BAD_GATEWAY, &e);
                }
            }
            None => return err(StatusCode::NOT_FOUND, "no such file here"),
        }
    }
    let path = blob(&st, &hash);
    let Ok(mut f) = tokio::fs::File::open(&path).await else { return err(StatusCode::NOT_FOUND, "no such file here") };
    let size = f.metadata().await.map(|m| m.len()).unwrap_or(0);
    let name = q.get("name").map(|n| safe_name(n)).unwrap_or_else(|| "file".into());
    let mime = clean_mime(q.get("mime").map(String::as_str), &name);
    use tokio::io::{AsyncReadExt, AsyncSeekExt};
    if let Some(off) = q.get("offset").and_then(|o| o.parse::<u64>().ok()) {
        let len = q.get("len").and_then(|l| l.parse::<u64>().ok()).unwrap_or(PIECE).min(PIECE).min(size.saturating_sub(off));
        let mut buf = vec![0u8; len as usize];
        if f.seek(std::io::SeekFrom::Start(off)).await.is_err() || f.read_exact(&mut buf).await.is_err() {
            return err(StatusCode::RANGE_NOT_SATISFIABLE, "offset past the end");
        }
        return ([(header::CONTENT_TYPE, "application/octet-stream")], buf).into_response();
    }
    let stream = futures::stream::unfold(f, |mut f| async move {
        let mut buf = vec![0u8; 1 << 16];
        match f.read(&mut buf).await {
            Ok(0) => None,
            Ok(n) => {
                buf.truncate(n);
                Some((Ok::<_, std::io::Error>(Bytes::from(buf)), f))
            }
            Err(e) => Some((Err(e), f)),
        }
    });
    let mut r = Body::from_stream(stream).into_response();
    let h = r.headers_mut();
    h.insert(header::CONTENT_TYPE, HeaderValue::from_str(&mime).unwrap_or(HeaderValue::from_static("application/octet-stream")));
    h.insert(header::CONTENT_LENGTH, HeaderValue::from(size));
    h.insert("x-content-type-options", HeaderValue::from_static("nosniff"));
    if let Ok(v) = HeaderValue::from_str(&format!("inline; filename=\"{}\"", name.replace('"', "_"))) {
        h.insert(header::CONTENT_DISPOSITION, v);
    }
    r
}

/// The bytes of one GET to a peer (the JSON `peers::call` can't carry them).
async fn peer_bytes(st: &AppState, root: &str, path: &str) -> Result<Vec<u8>, String> {
    let p = &st.config.peers;
    let base = p.url(root).ok_or_else(|| format!("unknown root {root:?}"))?;
    let mut req = st.http.get(format!("{base}{path}")).timeout(Duration::from_secs(90));
    if let Some(t) = &p.token {
        req = req.header("x-ygg-peer", t);
    }
    let resp = req.send().await.map_err(|e| format!("no answer from {root}: {e}"))?;
    let status = resp.status();
    let bytes = resp.bytes().await.map_err(|e| format!("no answer from {root}: {e}"))?;
    if !status.is_success() {
        return Err(format!("{root}: {status} {}", String::from_utf8_lossy(&bytes).chars().take(200).collect::<String>()));
    }
    Ok(bytes.to_vec())
}

/// Brings a file here from `root`, in pieces under the tunnel's limit; checks its hash.
pub async fn pull(st: &AppState, root: &str, hash: &str) -> Result<u64, String> {
    if !valid_hash(hash) {
        return Err("not a file hash".into());
    }
    if let Some(n) = size_of(st, hash) {
        return Ok(n);
    }
    let lock = st.files.pulls.lock().unwrap().entry(hash.to_string()).or_default().clone();
    let _one = lock.lock().await;
    if let Some(n) = size_of(st, hash) {
        return Ok(n);
    }
    // peers::call learns a root linked a moment ago, and keeps the [roots] view fresh
    let info = crate::peers::call(st, root, "GET", &format!("/file/{hash}/info"), None, 30).await.map_err(|e| no_answer(root, &e))?;
    let size = info["size"].as_u64().ok_or_else(|| format!("{root} does not have that file"))?;
    if size > max_bytes() {
        return Err(too_big("the file", size));
    }
    let tmp = tmp_path(st, hash);
    let res: Result<(), String> = async {
        let mut f = std::fs::File::create(&tmp).map_err(|e| e.to_string())?;
        let mut h = Sha256::new();
        let mut off = 0u64;
        while off < size {
            let want = PIECE.min(size - off);
            let mut tries = 0;
            let piece = loop {
                match peer_bytes(st, root, &format!("/file/{hash}?offset={off}&len={want}")).await {
                    Ok(b) if b.len() as u64 == want => break b,
                    Ok(b) => return Err(format!("{root} sent {} bytes for a piece of {want}", b.len())),
                    Err(e) if tries < 2 => {
                        tries += 1;
                        eprintln!("files: pull {hash} piece at {off} from {root}: {e} — again");
                        tokio::time::sleep(Duration::from_secs(2)).await;
                    }
                    Err(e) => return Err(e),
                }
            };
            h.update(&piece);
            f.write_all(&piece).map_err(|e| e.to_string())?;
            off += want;
        }
        f.flush().map_err(|e| e.to_string())?;
        let got = hex(&h.finalize());
        if got != hash {
            return Err(format!("the file from {root} did not match its hash"));
        }
        settle(st, &tmp, hash).map_err(|e| e.to_string())
    }
    .await;
    st.files.pulls.lock().unwrap().remove(hash);
    match res {
        Ok(()) => {
            eprintln!("files: pulled {hash} ({}) from {root}", human_size(size));
            Ok(size)
        }
        Err(e) => {
            let _ = std::fs::remove_file(&tmp);
            Err(e)
        }
    }
}

fn no_answer(root: &str, e: &str) -> String {
    if e.contains("unreachable") || e.contains(" 502 ") || e.contains(" 503 ") || e.contains(" 504 ") {
        format!("no answer from {root}")
    } else {
        e.to_string()
    }
}

// ---- artifacts: a file a session made for the owner -------------------------------------

/// The same name rule the app's gallery uses: a bare file name, nothing else.
pub fn safe_artifact_name(name: &str) -> bool {
    let mut b = name.bytes();
    b.next().is_some_and(|c| c.is_ascii_alphanumeric())
        && name.bytes().all(|c| c.is_ascii_alphanumeric() || b"._-".contains(&c))
        && !name.contains("..")
        && name.len() <= 200
}

/// Where this root's sessions leave files for the owner: YGG_ARTIFACTS_DIR (`:`-separated), the
/// project's `artifacts/`, the session's own folder's `artifacts/`, the data dir's `artifacts/`.
fn artifact_dirs(st: &AppState, session: Option<&str>) -> Vec<PathBuf> {
    let mut v: Vec<PathBuf> = std::env::var("YGG_ARTIFACTS_DIR").unwrap_or_default().split(':').filter(|s| !s.trim().is_empty()).map(PathBuf::from).collect();
    v.push(st.tools.project_dir.join("artifacts"));
    if let Some(cwd) = session.and_then(|s| st.sessions.lock().unwrap().get(s).and_then(|s| s.info["cwd"].as_str().map(PathBuf::from))) {
        v.push(cwd.join("artifacts"));
    }
    v.push(st.data_dir.join("artifacts"));
    v
}

/// `POST /file/artifact {name, root?, session?}` → REF: the artifact stored as a file here (when
/// it lives on another root, that root stores it and this one pulls it).
pub async fn share_artifact(State(st): State<AppState>, Json(b): Json<Value>) -> Response {
    let name = b["name"].as_str().unwrap_or_default().to_string();
    if !safe_artifact_name(&name) {
        return err(StatusCode::BAD_REQUEST, "not an artifact name");
    }
    let session = b["session"].as_str().filter(|s| !s.is_empty()).map(String::from);
    if let Some(root) = b["root"].as_str().filter(|r| !r.is_empty() && *r != st.config.peers.me) {
        let body = json!({ "name": name, "session": session });
        let r = match crate::peers::call(&st, root, "POST", "/file/artifact", Some(body), 60).await {
            Ok(r) => r,
            Err(e) if e.contains(" 404 ") => return err(StatusCode::NOT_FOUND, &format!("{name} is not on {root}")),
            Err(e) => return err(StatusCode::BAD_GATEWAY, &no_answer(root, &e)),
        };
        let Some(hash) = r["hash"].as_str().filter(|h| valid_hash(h)).map(String::from) else { return err(StatusCode::BAD_GATEWAY, "bad answer") };
        if let Err(e) = pull(&st, root, &hash).await {
            return err(StatusCode::BAD_GATEWAY, &e);
        }
        let mut out = r.clone();
        out["root"] = json!(root);
        return Json(out).into_response();
    }
    let Some(path) = artifact_dirs(&st, session.as_deref()).into_iter().map(|d| d.join(&name)).find(|p| p.is_file()) else {
        return err(StatusCode::NOT_FOUND, &format!("{name} is not on {}", st.config.peers.me));
    };
    let st2 = st.clone();
    let stored = tokio::task::spawn_blocking(move || -> std::io::Result<(String, u64)> {
        let size = std::fs::metadata(&path)?.len();
        if size > max_bytes() {
            return Err(std::io::Error::other(too_big(path.file_name().and_then(|n| n.to_str()).unwrap_or("file"), size)));
        }
        let (hash, _) = hash_file(&path)?;
        if size_of(&st2, &hash).is_none() {
            let tmp = tmp_path(&st2, "art");
            std::fs::copy(&path, &tmp)?;
            let (h2, _) = hash_file(&tmp)?;
            if h2 != hash {
                let _ = std::fs::remove_file(&tmp);
                return Err(std::io::Error::other("the file changed while it was read — try again"));
            }
            settle(&st2, &tmp, &hash)?;
        }
        Ok((hash, size))
    })
    .await;
    match stored {
        Ok(Ok((hash, size))) => Json(reference(&hash, &name, mime_of(&name), size, &st.config.peers.me)).into_response(),
        Ok(Err(e)) => err(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()),
        Err(e) => err(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()),
    }
}

/// `/api/artifact/<name>` links in a reply that came from `root`'s session `rid`: they get
/// `?root=<root>&session=<rid>`, so the phone's tap opens the file where it was made.
pub fn point_artifact_links(text: &str, root: &str, rid: &str) -> String {
    const AT: &str = "/api/artifact/";
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(i) = rest.find(AT) {
        let (head, tail) = rest.split_at(i + AT.len());
        out.push_str(head);
        let n = tail.find(|c: char| !(c.is_ascii_alphanumeric() || "._-".contains(c))).unwrap_or(tail.len());
        let (name, after) = tail.split_at(n);
        out.push_str(name);
        if !name.is_empty() && !after.starts_with('?') {
            // a sentence's full stop is not part of the name
            let dot = name.ends_with('.') as usize;
            if dot == 1 {
                out.pop();
            }
            out.push_str(&format!("?root={root}&session={rid}"));
            if dot == 1 {
                out.push('.');
            }
        }
        rest = after;
    }
    out.push_str(rest);
    out
}

// ---- messages: files in, files out --------------------------------------------------------

fn is_ref(p: &Value) -> bool {
    p["type"] == "file" && p["hash"].as_str().is_some_and(valid_hash)
}

/// A new message's `data:` file parts become files in the store (the part keeps its name and mime,
/// loses the bytes). A part that does not decode is left as it was.
pub fn ingest_data_urls(st: &AppState, parts: &mut [Value]) {
    for p in parts.iter_mut().filter(|p| p["type"] == "file") {
        let Some(url) = p["url"].as_str() else { continue };
        let Some((head, data)) = url.strip_prefix("data:").and_then(|u| u.split_once(',')) else { continue };
        if !head.ends_with(";base64") {
            continue;
        }
        let Ok(bytes) = base64::engine::general_purpose::STANDARD.decode(data.trim()) else { continue };
        let mime = clean_mime(p["mime"].as_str().or(head.strip_suffix(";base64")), "");
        let ext = mime.split('/').nth(1).unwrap_or("bin").split(['+', ';']).next().unwrap_or("bin").to_string();
        let name = p["filename"].as_str().map(safe_name).unwrap_or_else(|| format!("{}.{ext}", if mime.starts_with("image/") { "image" } else { "file" }));
        match put_bytes(st, &bytes) {
            Ok(hash) => *p = file_part(&hash, &name, &mime, bytes.len() as u64, &st.config.peers.me),
            Err(e) => eprintln!("files: could not store an attached file: {e}"),
        }
    }
}

/// The parts that go to another root: every file part a reference it can pull (`root` set).
pub fn outgoing(st: &AppState, parts: &[Value]) -> Vec<Value> {
    parts
        .iter()
        .map(|p| {
            let mut p = p.clone();
            if is_ref(&p) {
                if p["root"].as_str().is_none_or(str::is_empty) {
                    p["root"] = json!(st.config.peers.me);
                }
                if let Some(o) = p.as_object_mut() {
                    for k in ["path", "inline", "missing"] {
                        o.remove(k);
                    }
                }
            }
            p
        })
        .collect()
}

/// Before a turn runs: every file its message names is here (pulled from the root that has it),
/// with a path a tool can open; a small text file also inline. Written onto the stored parts
/// (`path`, `inline`, or `missing` with the reason), once, before anything reads them.
pub async fn prepare(st: &AppState, sid: &str, msg_id: &str) {
    let parts: Vec<Value> = {
        let sessions = st.sessions.lock().unwrap();
        let Some(m) = sessions.get(sid).and_then(|s| s.messages.iter().find(|m| m["info"]["id"] == msg_id)) else { return };
        m["parts"].as_array().cloned().unwrap_or_default()
    };
    if !parts.iter().any(|p| is_ref(p) && p["path"].is_null() && p["missing"].is_null()) {
        return;
    }
    let mut out = parts.clone();
    for p in out.iter_mut().filter(|p| is_ref(p) && p["path"].is_null() && p["missing"].is_null()) {
        let hash = p["hash"].as_str().unwrap_or_default().to_string();
        let name = p["filename"].as_str().map(safe_name).unwrap_or_else(|| "file".into());
        if size_of(st, &hash).is_none() {
            let from = p["root"].as_str().unwrap_or_default().to_string();
            let got = if from.is_empty() || from == st.config.peers.me { Err("it is not on this root".to_string()) } else { pull(st, &from, &hash).await };
            if let Err(e) = got {
                p["missing"] = json!(if from.is_empty() { e } else { format!("could not be fetched from {from}: {e}") });
                continue;
            }
        }
        match named(st, &hash, &name) {
            Ok(path) => p["path"] = json!(path.to_string_lossy()),
            Err(e) => {
                p["missing"] = json!(e.to_string());
                continue;
            }
        }
        let mime = p["mime"].as_str().unwrap_or_default().to_string();
        let size = size_of(st, &hash).unwrap_or(0);
        if !mime.starts_with("image/") && is_text(&mime, &name) && size <= INLINE_MAX {
            if let Ok(t) = std::fs::read(blob(st, &hash)).map(|b| String::from_utf8_lossy(&b).into_owned()) {
                p["inline"] = json!(t);
            }
        }
    }
    crate::with_session(st, sid, |s| {
        if let Some(m) = s.messages.iter_mut().find(|m| m["info"]["id"] == msg_id) {
            m["parts"] = Value::Array(out);
        }
    });
}

/// The line a model or a harness reads for one file part (`None`: not a stored file).
pub fn line(p: &Value) -> Option<String> {
    if !is_ref(p) {
        return None;
    }
    let name = p["filename"].as_str().unwrap_or("file");
    let mime = p["mime"].as_str().unwrap_or("application/octet-stream");
    let size = human_size(p["size"].as_u64().unwrap_or(0));
    Some(match (p["path"].as_str(), p["missing"].as_str()) {
        (Some(path), _) => format!("[attached: {name} ({mime}, {size}) — {path} — open it with your file tools]"),
        (None, Some(why)) => format!("[attached: {name} ({mime}, {size}) — {why}]"),
        _ => format!("[attached: {name} ({mime}, {size})]"),
    })
}

/// What a harness gets after the message text: one line per attached file.
pub fn harness_lines(msg: &Value) -> String {
    msg["parts"].as_array().into_iter().flatten().filter_map(line).collect::<Vec<_>>().join("\n")
}

/// A brain-native model's view of a non-image file: the line, and a small text file inline.
pub fn model_text(p: &Value) -> Option<String> {
    let l = line(p)?;
    Some(match p["inline"].as_str() {
        Some(t) => format!("{l}\n--- {} ---\n```\n{t}\n```", p["filename"].as_str().unwrap_or("file")),
        None => l,
    })
}

/// An image stored as a file, as the data URL the model is sent (`None`: not here).
pub fn image_data_url(st: &AppState, p: &Value) -> Option<String> {
    let hash = p["hash"].as_str().filter(|h| valid_hash(h))?;
    let bytes = std::fs::read(blob(st, hash)).ok()?;
    let mime = p["mime"].as_str().unwrap_or("image/png");
    Some(format!("data:{mime};base64,{}", base64::engine::general_purpose::STANDARD.encode(bytes)))
}

/// The marker an image file part leaves in the upstream view until `resolve_images` reads it.
pub const IMAGE_MARK: &str = "ygg-file:";

/// Every `ygg-file:<hash>` image in an upstream conversation becomes its data URL (one that is not
/// here becomes a line saying so).
pub fn resolve_images(st: &AppState, convo: &mut [Value]) {
    for m in convo.iter_mut() {
        let Some(parts) = m["content"].as_array_mut() else { continue };
        for p in parts.iter_mut() {
            let Some(url) = p["image_url"]["url"].as_str() else { continue };
            let Some(rest) = url.strip_prefix(IMAGE_MARK) else { continue };
            let (hash, mime) = rest.split_once(':').unwrap_or((rest, "image/png"));
            match image_data_url(st, &json!({ "hash": hash, "mime": mime })) {
                Some(d) => p["image_url"]["url"] = json!(d),
                None => *p = json!({ "type": "text", "text": "[an attached image is not on this root]" }),
            }
        }
    }
}

/// The file parts of the turn `sid` is answering now (its reply in progress names it), else of
/// its newest user message — what the tree tools' `attach: true` sends on. Local paths are
/// dropped: the receiving session's root sets its own.
pub fn turn_files(st: &AppState, sid: &str) -> Vec<Value> {
    let parts: Vec<Value> = {
        let sessions = st.sessions.lock().unwrap();
        let Some(s) = sessions.get(sid) else { return vec![] };
        let answering = s.messages.iter().rev().find(|m| m["info"]["role"] == "assistant" && m["info"]["time"]["completed"].is_null()).and_then(|m| m["info"]["parentID"].as_str());
        let turn = match answering {
            Some(t) => s.messages.iter().find(|m| m["info"]["id"] == t),
            None => s.messages.iter().rev().find(|m| m["info"]["role"] == "user" && m["info"]["meta"]["auto"] != true),
        };
        turn.and_then(|m| m["parts"].as_array()).into_iter().flatten().filter(|p| p["type"] == "file").cloned().collect()
    };
    outgoing(st, &parts)
        .into_iter()
        .map(|mut p| {
            if let Some(o) = p.as_object_mut() {
                for k in ["id", "messageID", "sessionID"] {
                    o.remove(k);
                }
            }
            p
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_and_sizes_read_plainly() {
        assert_eq!(safe_name("../../etc/passwd"), "passwd");
        assert_eq!(safe_name("Report Q3 (final).pdf"), "Report Q3 (final).pdf");
        assert_eq!(safe_name(".hidden"), "hidden");
        assert_eq!(safe_name("a/b\\c:d*e"), "c_d_e");
        assert_eq!(safe_name(""), "file");
        assert_eq!(human_size(6 * (1 << 20) + 100_000), "6.1 MB");
        assert_eq!(human_size(2000), "2 KB");
        assert_eq!(human_size(37), "37 bytes");
        assert!(valid_hash(&"a".repeat(64)) && !valid_hash(&"A".repeat(64)) && !valid_hash("abc"));
        assert!(safe_artifact_name("marker.html") && !safe_artifact_name("../x") && !safe_artifact_name(".x") && !safe_artifact_name("a/b"));
    }

    #[test]
    fn artifact_links_point_at_their_root() {
        let t = "see /api/artifact/report.html and [x](/api/artifact/a.png). Done /api/artifact/b.md.";
        assert_eq!(
            point_artifact_links(t, "lab", "ses_1"),
            "see /api/artifact/report.html?root=lab&session=ses_1 and [x](/api/artifact/a.png?root=lab&session=ses_1). Done /api/artifact/b.md?root=lab&session=ses_1."
        );
        // a link that already says where it is stays as it is
        let t = "/api/artifact/x.html?root=mac";
        assert_eq!(point_artifact_links(t, "lab", "s"), t);
        assert_eq!(point_artifact_links("no links", "lab", "s"), "no links");
    }

    #[test]
    fn lines_say_what_the_file_is_and_where() {
        let mut p = file_part(&"a".repeat(64), "report.pdf", "application/pdf", 6 * (1 << 20), "home");
        assert_eq!(line(&p).unwrap(), "[attached: report.pdf (application/pdf, 6.0 MB)]");
        p["path"] = json!("/d/files/named/x/report.pdf");
        assert_eq!(line(&p).unwrap(), "[attached: report.pdf (application/pdf, 6.0 MB) — /d/files/named/x/report.pdf — open it with your file tools]");
        p["inline"] = json!("hello");
        assert!(model_text(&p).unwrap().ends_with("--- report.pdf ---\n```\nhello\n```"));
        assert!(line(&json!({ "type": "text", "text": "x" })).is_none());
        // a data-URL image is not a stored file (the model gets it as an image)
        assert!(line(&json!({ "type": "file", "url": "data:image/png;base64,AA" })).is_none());
    }

    #[test]
    fn mime_is_kept_when_sane_else_guessed() {
        assert_eq!(clean_mime(Some("application/pdf"), "x.bin"), "application/pdf");
        assert_eq!(clean_mime(Some("<script>"), "x.pdf"), "application/pdf");
        assert_eq!(clean_mime(None, "notes.md"), "text/plain");
        assert_eq!(clean_mime(Some(""), "a.weird"), "application/octet-stream");
    }
}

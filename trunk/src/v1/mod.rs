//! The v1 trunk (spec rev 3): `bifrost-net trunk -c trunk.toml` and `bifrost-net trunk-ctl`.
//!
//! Module owners (CONTRACTS.md C1): config, db, crypto, paseto, http, server, ctl, idp, shell —
//! IDP; relay (and later proto, roots) — WIRE.

#![allow(dead_code)] // the skeleton exposes what WIRE and APP build on

// WIRE, shared by every build: the proto-2 codec and signatures, trunk-state.json, websocket
// frames for `/t/root`, and the root's `[trunk]` link (so light roots on the root build dial
// out identically to full roots)
pub mod proto;
pub mod state;
pub mod wsio;
pub mod link;

#[cfg(feature = "trunk")]
pub mod config;
#[cfg(feature = "trunk")]
pub mod crypto;
#[cfg(feature = "trunk")]
pub mod ctl;
#[cfg(feature = "trunk")]
pub mod db;
#[cfg(feature = "trunk")]
pub mod http;
#[cfg(feature = "trunk")]
pub mod idp;
#[cfg(feature = "trunk")]
pub mod paseto;
#[cfg(feature = "trunk")]
pub mod relay;
#[cfg(feature = "trunk")]
pub mod roots;
#[cfg(feature = "trunk")]
pub mod import;
#[cfg(feature = "trunk")]
pub mod rig;
#[cfg(feature = "trunk")]
pub mod install;
#[cfg(feature = "trunk")]
pub mod server;
#[cfg(feature = "trunk")]
pub mod shell;

/// `bifrost-net trunk -c trunk.toml`
#[cfg(feature = "trunk")]
pub fn cmd_trunk(args: &[String]) -> i32 {
    let mut cfg_path = None;
    let mut it = args.iter();
    while let Some(a) = it.next() {
        match a.as_str() {
            "-c" | "--config" => cfg_path = it.next().cloned(),
            other => {
                eprintln!("trunk: unknown argument '{other}' (usage: bifrost-net trunk -c trunk.toml)");
                return 2;
            }
        }
    }
    let Some(p) = cfg_path else {
        eprintln!("trunk: missing -c trunk.toml");
        return 2;
    };
    match server::run(&p) {
        Ok(()) => 0,
        Err(e) => {
            eprintln!("trunk: {e}");
            1
        }
    }
}

/// `bifrost-net trunk-kek FILE`: a fresh 32-byte key-encryption key, mode 0600, never overwritten.
#[cfg(feature = "trunk")]
pub fn cmd_trunk_kek(args: &[String]) -> i32 {
    let Some(p) = args.first() else {
        eprintln!("trunk-kek: FILE (created mode 600 if missing; never overwritten)");
        return 2;
    };
    match crypto::Kek::create_file(p) {
        Ok(true) => {
            println!("trunk-kek: created {p}");
            0
        }
        Ok(false) => {
            println!("trunk-kek: {p} exists (kept)");
            0
        }
        Err(e) => {
            eprintln!("trunk-kek: {e}");
            1
        }
    }
}

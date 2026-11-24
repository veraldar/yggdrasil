//! Stamps the brain with the build it is (src/build_id.rs): the root-part id, commit, commit time
//! and describe, from git at compile time — every build, a plain `cargo build` in a worktree too.
//! A copy without git (release.sh's Debian-11 and macOS builds compile a `git archive`) takes
//! YGG_BUILD_ID / _COMMIT / _EPOCH / _DESCRIBE (scripts/root-part-id.sh prints them); a checkout
//! always uses its own git, whatever those say. Neither: "dev". The brain reads the stamp with
//! env!("YGG_STAMP_…") (peers::build_info) — never from a file beside the binary.

#[path = "src/build_id.rs"]
mod build_id;

use build_id::Stamp;
use std::path::PathBuf;

const INPUTS: [&str; 4] = ["YGG_BUILD_ID", "YGG_BUILD_COMMIT", "YGG_BUILD_EPOCH", "YGG_BUILD_DESCRIBE"];

fn from_env() -> Option<Stamp> {
    let id = std::env::var("YGG_BUILD_ID").ok().filter(|s| !s.is_empty())?;
    let id = if build_id::valid_id(&id) {
        id
    } else {
        println!("cargo::warning=YGG_BUILD_ID={id:?} is no root-part id (12 hex, dirty-<12 hex>, dev): stamped dev");
        build_id::DEV.to_string()
    };
    let var = |k: &str| std::env::var(k).unwrap_or_default();
    let describe = var("YGG_BUILD_DESCRIBE");
    Some(Stamp {
        commit: var("YGG_BUILD_COMMIT"),
        epoch: var("YGG_BUILD_EPOCH").trim().parse().unwrap_or(0),
        describe: if describe.is_empty() { id.clone() } else { describe },
        id,
    })
}

fn main() {
    for k in INPUTS {
        println!("cargo::rerun-if-env-changed={k}");
    }
    println!("cargo::rerun-if-changed=build.rs");
    let dir = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR"));
    let env = from_env();
    let git = build_id::repo_top(&dir).and_then(|top| {
        for p in build_id::watch_list(&top) {
            println!("cargo::rerun-if-changed={}", p.display());
        }
        build_id::from_git(&top)
    });
    let s = match (git, env) {
        (Some(g), Some(e)) if e.id != g.id => {
            println!("cargo::warning=YGG_BUILD_ID={} ignored: this checkout is {}", e.id, g.id);
            g
        }
        (Some(g), _) => g,
        (None, Some(e)) => e,
        (None, None) => Stamp::dev(),
    };
    println!("cargo::rustc-env=YGG_STAMP_ID={}", s.id);
    println!("cargo::rustc-env=YGG_STAMP_COMMIT={}", s.commit);
    println!("cargo::rustc-env=YGG_STAMP_EPOCH={}", s.epoch);
    println!("cargo::rustc-env=YGG_STAMP_DESCRIBE={}", s.describe.replace(['\n', '\r'], " "));
}

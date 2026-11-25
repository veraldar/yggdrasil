//! The root-part id: which build of the parts a joined root runs (its brain, its WireGuard node, its
//! installer and dialer). Computed at compile time by `root/build.rs` (which `#[path]`-includes
//! this file) and compiled into the brain; `GET /root` reports it as `build` (peers::build_info).
//!
//! id = the first 12 hex of sha256 over `git ls-tree -r <commit> -- PATHS` — the same as
//! `git ls-tree -r <commit> -- <PATHS> | sha256sum | cut -c1-12` (scripts/root-part-id.sh). Two
//! commits that differ only outside PATHS (an app-only release) give the same id, so nobody is
//! marked "not up to date" for it.
//!
//! A tree with changes in PATHS (tracked or untracked) never claims a clean id: it gets
//! `dirty-<12 hex>` over HEAD's listing plus the changes. Unknown (no git, not this repo): "dev".
//! Only std and sha2 (a build-dependency) — this file is compiled into the build script.

use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::process::Command;

/// What a joined root runs, relative to the repo top. root/build.rs stamps the brain (it is in no
/// commit before this one, so earlier commits keep their id).
pub const PATHS: &[&str] = &[
    "root/build.rs",
    "root/src",
    "root/Cargo.toml",
    "root/Cargo.lock",
    "trunk/src",
    "trunk/Cargo.toml",
    "trunk/Cargo.lock",
    "root/install/join.sh",
    "root/install/rootjoin.py",
    "trunk/scripts/root-dial.py",
];

/// The id of a build nobody can name (no git, or not this repo, and no YGG_BUILD_ID).
pub const DEV: &str = "dev";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Stamp {
    /// 12 hex (a clean commit), `dirty-<12 hex>`, or "dev"
    pub id: String,
    /// the full commit sha it was built from ("" when unknown)
    pub commit: String,
    /// that commit's committer time, seconds (0 when unknown)
    pub epoch: u64,
    /// `git describe --tags --always --dirty` (the whole tree), or "dev"
    pub describe: String,
}

impl Stamp {
    pub fn dev() -> Stamp {
        Stamp { id: DEV.into(), commit: String::new(), epoch: 0, describe: DEV.into() }
    }
}

/// `git -C top <args>` with a fixed path quoting (the id must not depend on someone's git config);
/// None when git is missing or fails.
fn git(top: &Path, args: &[&str]) -> Option<Vec<u8>> {
    let out = Command::new("git")
        .arg("-C")
        .arg(top)
        .args(["-c", "core.quotePath=true"])
        .args(args)
        .env_remove("GIT_DIR")
        .env_remove("GIT_WORK_TREE")
        .env_remove("GIT_INDEX_FILE")
        // a build only reads: `git status` must not rewrite the index of a checkout someone works in
        .env("GIT_OPTIONAL_LOCKS", "0")
        .output()
        .ok()?;
    out.status.success().then_some(out.stdout)
}

fn git_line(top: &Path, args: &[&str]) -> Option<String> {
    let out = String::from_utf8(git(top, args)?).ok()?;
    let line = out.trim().to_string();
    (!line.is_empty()).then_some(line)
}

fn hex12(bytes: &[u8]) -> String {
    Sha256::digest(bytes).iter().take(6).map(|b| format!("{b:02x}")).collect()
}

/// `git ls-tree -r <commit> -- PATHS` — what the id hashes.
fn listing(top: &Path, commit: &str) -> Option<Vec<u8>> {
    let mut args = vec!["ls-tree", "-r", commit, "--"];
    args.extend_from_slice(PATHS);
    git(top, &args)
}

/// The root-part id of `commit`: the first 12 hex of sha256 over its listing of PATHS.
pub fn clean_id(top: &Path, commit: &str) -> Option<String> {
    Some(hex12(&listing(top, commit)?))
}

/// The repo top for the crate at `manifest_dir` (= `<top>/root`), or None when that is not a git
/// checkout of this repo (a `git archive` copy, a tarball, a folder inside some other repo).
pub fn repo_top(manifest_dir: &Path) -> Option<PathBuf> {
    let top = PathBuf::from(git_line(manifest_dir, &["rev-parse", "--show-toplevel"])?);
    let a = std::fs::canonicalize(top.join("root")).ok()?;
    let b = std::fs::canonicalize(manifest_dir).ok()?;
    (a == b).then_some(top)
}

/// What differs from HEAD in PATHS — tracked changes (staged or not) and untracked files (not
/// ignored ones) — as bytes to hash; None when that part of the tree is clean.
pub fn dirt(top: &Path) -> Option<Vec<u8>> {
    let mut status = vec!["status", "--porcelain=v1", "-z", "--untracked-files=all", "--"];
    status.extend_from_slice(PATHS);
    // git failing here is not "clean": a tree we cannot read never claims a clean id
    let Some(st) = git(top, &status) else { return Some(b"status failed".to_vec()) };
    if st.is_empty() {
        return None;
    }
    // the changes themselves, not how they are staged: the build is what the files are
    let mut out = Vec::new();
    let mut diff = vec!["diff", "--no-color", "--no-ext-diff", "--no-renames", "--binary", "HEAD", "--"];
    diff.extend_from_slice(PATHS);
    out.extend(git(top, &diff).unwrap_or_default());
    let mut others = vec!["ls-files", "-z", "--others", "--exclude-standard", "--"];
    others.extend_from_slice(PATHS);
    for p in git(top, &others).unwrap_or_default().split(|b| *b == 0).filter(|p| !p.is_empty()) {
        out.extend_from_slice(p);
        out.push(0);
        out.extend(std::fs::read(top.join(String::from_utf8_lossy(p).as_ref())).unwrap_or_default());
    }
    if out.is_empty() {
        out = st; // changed, but neither diff nor ls-files could say how: still not clean
    }
    Some(out)
}

/// The stamp of the checkout at `top`: HEAD's id when PATHS are clean, `dirty-…` otherwise. None
/// when git cannot tell (no HEAD yet).
pub fn from_git(top: &Path) -> Option<Stamp> {
    let commit = git_line(top, &["rev-parse", "--verify", "HEAD^{commit}"])?;
    let list = listing(top, &commit)?;
    let id = match dirt(top) {
        None => hex12(&list),
        Some(d) => {
            let mut all = list;
            all.extend(d);
            format!("dirty-{}", hex12(&all))
        }
    };
    let epoch = git_line(top, &["log", "-1", "--format=%ct", &commit]).and_then(|s| s.parse().ok()).unwrap_or(0);
    let describe = git_line(top, &["describe", "--tags", "--always", "--dirty"]).unwrap_or_else(|| commit[..commit.len().min(8)].into());
    Some(Stamp { id, commit, epoch, describe })
}

/// A plausible id from outside (YGG_BUILD_ID): 12 hex, `dirty-<12 hex>` or "dev".
pub fn valid_id(id: &str) -> bool {
    let hex = |s: &str| s.len() == 12 && s.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b));
    id == DEV || hex(id) || id.strip_prefix("dirty-").is_some_and(hex)
}

/// The files whose change must make cargo run the build script again: PATHS, and git's record of
/// what HEAD is (a commit, a checkout, a reset). Only existing ones (a missing one would make
/// cargo rebuild the brain every time).
pub fn watch_list(top: &Path) -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = PATHS.iter().map(|p| top.join(p)).collect();
    let mut gitp = vec!["HEAD".to_string(), "logs/HEAD".into(), "packed-refs".into()];
    if let Some(r) = git_line(top, &["symbolic-ref", "-q", "HEAD"]) {
        gitp.push(r);
    }
    for g in gitp {
        if let Some(p) = git_line(top, &["rev-parse", "--git-path", &g]) {
            let p = PathBuf::from(p);
            out.push(if p.is_absolute() { p } else { top.join(p) });
        }
    }
    out.retain(|p| p.exists());
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A throwaway repo holding the shape of this one (root/src, trunk/src, an app outside PATHS).
    struct Repo(PathBuf);
    impl Repo {
        fn new(tag: &str) -> Repo {
            let dir = std::env::temp_dir().join(format!("ygg-build-id-{tag}-{}", std::process::id()));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).unwrap();
            let r = Repo(dir);
            r.git(&["init", "-q", "-b", "main"]);
            r.write("root/src/main.rs", "fn main() {}\n");
            r.write("root/Cargo.toml", "[package]\nname = \"x\"\n");
            r.write("trunk/src/main.rs", "fn main() {}\n");
            r.write("root/install/join.sh", "#!/bin/sh\n");
            r.write("branch/app/page.tsx", "export default 1;\n");
            r.write(".gitignore", "/root/target\n");
            r.commit("one");
            r
        }
        fn git(&self, args: &[&str]) -> String {
            let out = Command::new("git")
                .arg("-C")
                .arg(&self.0)
                .args(["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "-c", "tag.gpgsign=false"])
                .args(args)
                .env_remove("GIT_DIR")
                .env_remove("GIT_WORK_TREE")
                .env_remove("GIT_INDEX_FILE")
                .output()
                .unwrap();
            assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
            String::from_utf8(out.stdout).unwrap().trim().to_string()
        }
        fn write(&self, p: &str, s: &str) {
            let f = self.0.join(p);
            std::fs::create_dir_all(f.parent().unwrap()).unwrap();
            std::fs::write(f, s).unwrap();
        }
        fn commit(&self, m: &str) -> String {
            self.git(&["add", "-A"]);
            self.git(&["commit", "-q", "--no-verify", "--allow-empty", "-m", m]);
            self.git(&["rev-parse", "HEAD"])
        }
        fn stamp(&self) -> Stamp {
            from_git(&self.0).unwrap()
        }
    }
    impl Drop for Repo {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn same_id_when_only_files_outside_the_root_part_change() {
        let r = Repo::new("outside");
        let a = r.stamp();
        r.write("branch/app/page.tsx", "export default 2;\n");
        r.write("NOTES.md", "notes\n");
        let c2 = r.commit("app only");
        let b = r.stamp();
        assert_ne!(a.commit, b.commit);
        assert_eq!(b.commit, c2);
        assert_eq!(a.id, b.id, "an app-only commit keeps the root-part id");
        assert_eq!(a.id.len(), 12);
        assert!(valid_id(&a.id));
    }

    #[test]
    fn id_changes_with_root_src_trunk_and_the_installer() {
        let r = Repo::new("inside");
        let mut ids = vec![r.stamp().id];
        for (f, s) in [("root/src/main.rs", "fn main() { let _ = 1; }\n"), ("trunk/src/wg.rs", "// new\n"), ("root/install/join.sh", "#!/bin/sh\necho\n")] {
            r.write(f, s);
            r.commit(f);
            let id = r.stamp().id;
            assert!(!ids.contains(&id), "{f} changed, id {id} did not");
            ids.push(id);
        }
    }

    #[test]
    fn a_dirty_tree_never_claims_a_clean_id() {
        let r = Repo::new("dirty");
        let clean = r.stamp();
        // a tracked file changed, not committed
        r.write("root/src/main.rs", "fn main() { panic!() }\n");
        let d1 = r.stamp();
        assert!(d1.id.starts_with("dirty-"), "{}", d1.id);
        assert_ne!(d1.id, clean.id);
        assert!(valid_id(&d1.id));
        assert_eq!(d1.commit, clean.commit);
        assert!(d1.describe.ends_with("-dirty"), "{}", d1.describe);
        // staged is still not committed
        r.git(&["add", "-A"]);
        assert_eq!(r.stamp().id, d1.id, "staging changes nothing: the build is what the files are");
        // another change, another dirty id
        r.write("root/src/main.rs", "fn main() { panic!(\"x\") }\n");
        let d2 = r.stamp();
        assert!(d2.id.starts_with("dirty-") && d2.id != d1.id);
        // put back: clean again, same id as before
        r.git(&["checkout", "-q", "HEAD", "--", "root/src/main.rs"]);
        assert_eq!(r.stamp().id, clean.id);
        // an untracked file in root/src is a change too; an ignored one (root/target) is not
        r.write("root/target/release/junk", "x");
        assert_eq!(r.stamp().id, clean.id);
        r.write("root/src/new.rs", "pub fn f() {}\n");
        assert!(r.stamp().id.starts_with("dirty-"));
        // a change outside the root part leaves the id clean (describe says dirty)
        std::fs::remove_file(r.0.join("root/src/new.rs")).unwrap();
        r.write("branch/app/page.tsx", "export default 3;\n");
        let s = r.stamp();
        assert_eq!(s.id, clean.id);
        assert!(s.describe.ends_with("-dirty"));
    }

    #[test]
    fn same_as_the_shell_formula() {
        // git ls-tree -r <commit> -- PATHS | sha256sum | cut -c1-12 (NOTES §1, scripts/root-part-id.sh)
        let r = Repo::new("shell");
        let c = r.git(&["rev-parse", "HEAD"]);
        let cmd = format!("git ls-tree -r {c} -- {} | sha256sum | cut -c1-12", PATHS.join(" "));
        let out = Command::new("sh").arg("-c").arg(&cmd).current_dir(&r.0).output().unwrap();
        assert_eq!(String::from_utf8_lossy(&out.stdout).trim(), clean_id(&r.0, &c).unwrap());
        assert_eq!(r.stamp().id, clean_id(&r.0, &c).unwrap());
    }

    #[test]
    fn the_shell_script_hashes_the_same_paths() {
        // scripts/root-part-id.sh gives release.sh's git-less builds their id: same list, same order
        let f = Path::new(env!("CARGO_MANIFEST_DIR")).join("../scripts/root-part-id.sh");
        let Ok(sh) = std::fs::read_to_string(&f) else { return }; // a copy holding root/ alone
        let line = sh.lines().find_map(|l| l.strip_prefix("PATHS=\"")).expect("PATHS= in root-part-id.sh");
        assert_eq!(line.trim_end_matches('"').split(' ').collect::<Vec<_>>(), PATHS);
    }

    #[test]
    fn this_repo_gives_the_ids_of_record() {
        // NOTES (root-updates-design §1): 25c54c2f and b3258d03 → 1481715ef90f. Skipped where the
        // sources are not a checkout holding those commits (a git archive copy).
        let Some(top) = repo_top(Path::new(env!("CARGO_MANIFEST_DIR"))) else { return };
        for c in ["25c54c2f", "b3258d03"] {
            if git(&top, &["cat-file", "-e", &format!("{c}^{{commit}}")]).is_none() {
                return;
            }
            assert_eq!(clean_id(&top, c).as_deref(), Some("1481715ef90f"), "{c}");
        }
    }

    #[test]
    fn not_a_checkout_of_this_repo_is_dev() {
        let dir = std::env::temp_dir().join(format!("ygg-build-id-nogit-{}", std::process::id()));
        std::fs::create_dir_all(dir.join("root")).unwrap();
        // a plain folder (a `git archive` copy): no top
        assert!(repo_top(&dir.join("root")).is_none());
        let _ = std::fs::remove_dir_all(&dir);
        // a repo whose top/root is not the crate dir
        let r = Repo::new("other");
        assert!(repo_top(&r.0.join("root/src")).is_none());
        assert_eq!(repo_top(&r.0.join("root")).map(|p| std::fs::canonicalize(p).unwrap()), Some(std::fs::canonicalize(&r.0).unwrap()));
        assert!(valid_id("dev") && !valid_id("1481715ef90") && !valid_id("1481715EF90F") && !valid_id("dirty-x"));
    }

    #[test]
    fn watch_list_holds_head_and_only_existing_files() {
        let r = Repo::new("watch");
        let w = watch_list(&r.0);
        assert!(w.iter().all(|p| p.exists()));
        assert!(w.iter().any(|p| p.ends_with("HEAD")), "{w:?}");
        assert!(w.iter().any(|p| p.ends_with("root/src")));
        assert!(!w.iter().any(|p| p.ends_with("trunk/Cargo.lock")), "missing files are left out");
    }
}

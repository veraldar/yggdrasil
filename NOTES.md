# P4 — installers and release v0.9.1 (branch p4-release)

RULE: long runs (rigs, release builds) run from the frozen worktree ~/Work/p4-run (git -C ~/Work/p4-run checkout --detach <commit>),
never from this one — bash reads scripts as it goes, an edit here breaks a running job.

## Done (committed)
- release.sh: tag guard AP-30 (makes vX at HEAD; stops on a local/origin tag elsewhere), private-key guard AP-21
  (file:line only), --mac-host (cargo on the Mac in ~/.cache/yggdrasil-release-mac, own CARGO_HOME; Mach-O check;
  yggdrasil-VER-macos-aarch64.tar.gz), build-win.sh hook before signing, notes line for v0.9.0's tag
- join.sh: PLAT linux-x86_64|macos-aarch64, shasum fallback, no glibc check on macOS
- trunk.sh --adopt /etc/trunk-ap (key/pin, token hash, LE cert + webroot, port/PROXY, ICE, sni conf; stops+disables
  trunk-ap only once ours answers; puts it back if not; folder left as is; firewall untouched)
- sim/own-trunk-e2e.sh OT_JOINER=deb443; sim/own-trunk/adopt-test.sh
- Mac M1/M2 looked (see below); trial build on the Mac: brain 30 s, node 14 s, both Mach-O arm64

## Mac facts (23:45, read-only)
- macOS 26.6.2 arm64, Xcode CLT, rustc 1.99, python3 3.9.6 (/usr/bin), shasum, no sha256sum, 58 GB free
- 4180/4181 free; no org.veraldar.* agents; listeners noted in the turn log
- COLLISION: ~/.local/share/yggdrasil-root EXISTS (Nov 14, a stalled join.sh run: NAME=mac, hub ap.veraldar.org,
  brain.env with a model upstream, bin/yggdrasil, never joined: no root.json, no bifrost-net, no agents).
  join.sh's default --dir. Not touched. Reported; M4 waits for a decision.

## Proven 11-20 ~00:30 (artifact p4-proofs-1120.md)
- S11 Linux in the rig: deb443 joiner, rc release, OWN-TRUNK GREEN 32/0 (state ~/.cache/p4-rig/s11-linux)
- adopt-test.sh 10/10 (found + fixed trunk.sh behind-proxy probe bug: -w took --haproxy-protocol)
- Mac pre-test: join.sh bootstrap on the real Mac with a test release incl. macos archive — up to the hub ask
- tree-next 4060a9fb merged

## Review (independent sub-agent, 01:00): 5 real bugs + 4 small — all fixed, commit "p4: fixes from the independent review"
- retested: adopt-test 11/11 (+ PROXY mismatch refused, backup timer left alone); key guard unit test; tag guard
  (local tag elsewhere, origin tag elsewhere) stops before any build, in a scratch clone with a stand-in key
- not yet re-run after the fixes: the full S11 rig (join.sh change is macOS/Rosetta + one message only)
- make_tag (after signing) is exercised only by a full real-path run: do the dress rehearsal (scratch clone, stand-in
  key, --mac-host, Windows exe) once p4-win is merged

## Half done
- Windows installer: sub-agent in ~/Work/p4-win (branch p4-win)

## Asked the owner (00:30)
- model for new computers: same as omarchy (z.ai glm-5.3-flash, handed over on approval) or paste a key per installer
- Mac: may the stale ~/.local/share/yggdrasil-root (Nov 14, never joined) be removed before M4

## Next
- Mac pre-test: test release with --mac-host, join.sh bootstrap on the Mac in an isolated XDG_DATA_HOME/--dir, --no-start
- the model question (Windows/Mac need an upstream) — asked the owner
- release itself: waits for the integrator

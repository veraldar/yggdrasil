# SURFACE-CHECK — site ↔ github ↔ canon

*Steward artifact, 11-02. Canon: `docs/CONSTRUCT.md` (10-30, binding) —
veraldar = the org; yggdrasil = the tree (one product); root = the brain;
trunk = the private line; branch = the end-user app. Read-only pass over
`~/Work/veraldar-site-rebuild` @ `ff25505`; no site edits.*

## method

README claims ↔ repo reality ↔ canon, claim by claim. Drift = a claim
that was true at write time and has since moved, or a canon mislabel.

## claims audited

| surface claim | repo/canon reality | verdict |
|---|---|---|
| tree: `veraldar/ yggdrasil/ llm key · speech models · bifrost → tailnet → phone` | true 10-06; canon now: yggdrasil = the tree (product), root = the brain, trunk = the private line | **DRIFT (canon age)** — structure-level rewrite stale: box-trunk map dead per CONSTRUCT.md |
| "yggdrasil: your box — the trunk everything runs on" | canon: trunk = the private line (tailscale today → webrtc → wireguard) | **DRIFT (canon mislabel)** — "the trunk" used as the box; canon reserves it for the line |
| "bifrost: the first product" | canon: bifrost is the branch app, first **branch** (construct calls it "the first branch", a Veraldar product) | **DRIFT (canon mislabel)** |
| "llm key — yours, bring it" | matches canon: the root's key is the user's provider key; the brain port/unit env-owned | MATCH |
| "speech models — local, on your LAN" | was true 10-06; 11-02 reality: Mac-Studio-LAN **and** VPS speaches stack (off-LAN voice landed via TURN-over-443, 11-02) | **DRIFT (incomplete)** — not wrong, now half-true |
| "tailnet — private, never public" | trunk today = tailscale; the VPS lane also serves public-style origins via caddy | DRIFT-risk (edge case, low priority) |
| "the org — everything lives inside it" / loyalty / state-law / feelings rules | canon brand law, verbatim-aligned | MATCH |
| `tokens.css` palette contract (aether · terminus · drift) | same tokens, one attribute flip | MATCH |
| AGPL-3.0 "your hardware, your words" | repo licenses | MATCH |

## drift summary (report only; no site edits)

1. **structure-level rewrite is one canon generation old.** The `$ tree
   veraldar` block and the world-table call yggdrasil "your box" / "the
   trunk" and bifrost "the first product" — the dead 09-30 map.
   CONSTRUCT.md supersedes it: org → tree (root/trunk/branch) → branch.
   Highest-value fix, one block.
2. **speech models line is half-true.** True for the Mac/LAN lane;
   VPS speech stack now also true (11-02). Add "or a VPS you own" —
   or generalize: "models run on hardware you own — LAN or VPS".
3. Everything else (llm key, tokens, license, brand rules) matches.

## matched claims (keep as-is)

"llm key — yours, bring it" — canon-true. The tree's rules-we-ship-by
(loyalty, state law, no-feelings) — canon-aligned. Palette contract —
one source, `tokens.css`. AGPL — clean.

## where the fix lands (when the owner says go)

`~/Work/veraldar-site-rebuild/README.md` + `index.html` world-table row
for yggdrasil/bifrost — repo is clean (no pending edits), so a one-block
canon-alignment commit is safe and cheap.

# Job: prove the installer's model step, one container per provider, against a fake upstream

You work for P4 (installers, release v0.9.1). Your worktree is `~/Work/p4-msmatrix` (git branch `p4-msmatrix`).
Write there only. Commit your work on that branch as you go (small commits). When done, your last message is the
report described at the end.

## Rules (hard)
- Only `~/Work/p4-msmatrix` and files you create under `~/.cache/p4-msmatrix/`. Never edit `~/Work/tree-next`,
  never touch another worktree.
- No deploys, no brain restarts, no `systemctl` on this machine, no `pkill`/`killall`. Stop only containers and
  processes you started, by their id/PID. Name every container `msm-…` and the docker network `msm-net`.
- Run docker builds and tests under `nice -n 10`.
- No real provider is ever called: inside the test containers the provider host names must resolve to your fake
  upstream. Use made-up keys only (e.g. `sk-test-zai-0123456789abcdef`). Never print or store a real key.
- If something in the installer itself looks wrong, do NOT fix `root/install/*`: write it in your report.

## What is being proven
`root/install/model-step.sh` is the model step shared by `root/install/install.sh` (the home computer) and
`root/install/join.sh`. Read it first (60 lines), then the "the model" section of install.sh (search
`model-step.sh`). Choices: Z AI · OpenRouter · Anthropic · OpenAI · Other (on a home install; a provider asks only
its key and fills in address + kind + a default model that can be changed; Other asks address, kind, model, key).
Without a terminal: `--model-provider zai|openrouter|anthropic|openai` with the key in the environment variable
`YGG_UPSTREAM_API_KEY`, and `--model M` for another model.

The brain (`yggdrasil`) then calls the provider: kind `anthropic` → `POST {address}/v1/messages` with the key as
`x-api-key` (and `Authorization: Bearer`); kind `openai` → `POST {address}/chat/completions` with
`Authorization: Bearer`. The model name is in the JSON body (`"model"`).

## What to build: `sim/model-step-e2e.sh` (+ helpers under `sim/model-step/`)
One run, all cases, a PASS/FAIL table, exit 0 only when all pass. Everything in docker on network `msm-net`.

1. **The release under test** — already built, do not rebuild: `~/.cache/p4-rig/ms-dist/0.9.1-rc.2/` (a TEST
   release). Unpack `yggdrasil-0.9.1-rc.2-linux-x86_64.tar.gz`; inside it `root/install/install.sh` runs with the
   prebuilt `bin/yggdrasil` (no download, no signature step needed when run from the unpacked folder — check how
   install.sh finds its files: `HERE`, `rootjoin.py` beside it). If install.sh insists on fetching, serve the dist
   from a local http container and set `YGG_RELEASES=http://…/releases` + `YGG_RELEASE_TEST_SIGNERS=<file with the
   line: release@yggdrasil namespaces="yggdrasil-release" $(cut -d' ' -f1-2 ~/.cache/p4-rig/ms-key/k.pub)>` the way
   `sim/own-trunk-e2e.sh` does (search `mkrel`, `HREL=`).
2. **A fake upstream container** `msm-upstream`: HTTPS on 443 with a certificate from a CA you make for the run,
   valid for `api.z.ai`, `openrouter.ai`, `api.anthropic.com`, `api.openai.com` and `other.tree.test`; plus plain
   http on 8080 (for "a model on your own network"). Behind it the repo's `root/mock/mock_upstream.py` (it speaks
   both dialects; read its header) or your own small server — it must **log every request**: Host header, path,
   the `x-api-key` and `Authorization` header values, and the body's `"model"`. The log is how each case is judged.
3. **One fresh `debian:12` container per case** (`msm-<case>`), with `--add-host` entries pointing the five names at
   `msm-upstream`, the run's CA added to the system trust store (`update-ca-certificates`), a normal user, and
   only what install.sh asks for. In it, run the home install **in a terminal** (drive it with a pty — python's
   `pty`/`pexpect`-style loop — typing the answers a person would type), brain only:
   `bash install.sh --brain-only --now` (read install.sh's `--brain-only` section for what `--now` needs; a
   container has no systemd user session, so see how it starts the brain there, or start the installed binary
   with the env file it wrote: `~/.config/yggdrasil/yggdrasil.env`).
   Then make the brain do **one model turn** (see `root/mock/context-e2e.sh` or any `root/mock/*-e2e.sh` for the
   two calls: create a session, post a message) and read the fake upstream's log.

### Cases (each its own container)
| case | typed / given | expected in the env file | expected at the fake upstream |
|---|---|---|---|
| zai | choice "Z AI", key, Enter for the model | `https://api.z.ai/api/anthropic`, anthropic, `glm-5.3-flash`, the key | Host api.z.ai, `POST /api/anthropic/v1/messages`, `x-api-key` = key, model glm-5.3-flash |
| zai-model | "Z AI", key, model `glm-5.3` | … `glm-5.3` | model glm-5.3 |
| openrouter | "OpenRouter", key, Enter | `https://openrouter.ai/api/v1`, openai, `openai/gpt-4o-mini` | Host openrouter.ai, `POST /api/v1/chat/completions`, `Authorization: Bearer` key |
| anthropic | "Anthropic", key, Enter | `https://api.anthropic.com`, anthropic, `claude-fable-5-2` | Host api.anthropic.com, `POST /v1/messages`, `x-api-key` = key |
| openai | "OpenAI", key, Enter | `https://api.openai.com/v1`, openai, `gpt-4o-mini` | Host api.openai.com, `POST /v1/chat/completions`, Bearer key |
| other-key | "Other", `https://other.tree.test/v1`, kind anthropic… (pick one), a model name, a key | as typed | as typed |
| other-local | "Other", `http://msm-upstream:8080/v1`, Enter (openai), a model, **empty key** | as typed, empty key | request arrives with no key header (or an empty one — report which) |
| flag-zai | no terminal: `YGG_UPSTREAM_API_KEY=… bash install.sh --brain-only --now --model-provider zai </dev/null` | as zai | as zai |
| flag-model | no terminal: `--model-provider anthropic --model claude-haiku-5-5` | … `claude-haiku-5-5` | model claude-haiku-5-5 |
| flag-nokey | no terminal: `--model-provider openai` with no key in the environment | nothing written | exit 64 and a message naming `YGG_UPSTREAM_API_KEY`; no request |

### Checks in every case that types or gives a key
- the env file is mode 600 and holds the key exactly once;
- **the key is nowhere else**: not in the pty transcript of the install (it is typed without echo), not in any
  other file under the user's home, `/tmp`, or the container's logs (`grep -r` for the key; the env file is the
  only hit);
- what the menu showed: for a home install the list is exactly `Z AI, OpenRouter, Anthropic, OpenAI, Other` in
  that order and there is **no** "Same as the home root" line (that one is for a computer that joins).

A fact to establish first (it decides how the CA is trusted): does the brain accept the run's CA once it is in
the container's system store (`update-ca-certificates`)? `root/Cargo.toml` has `reqwest 0.13`. If it does not,
find what it honours (`SSL_CERT_FILE`?) and say so in the report — it matters to people behind a company proxy.

## Report (your final message, under 50 lines)
The table (case → PASS/FAIL, one line of evidence each: the upstream log line with the key replaced by
`<key>`), the CA finding, anything in the installer that looked wrong (file:line, what happens), the commits on
`p4-msmatrix`, and the path of the full run log. Also write the table to
`~/Work/root-coord-pwa/artifacts/p4-model-step-matrix.md`.

# NOTES-win — Windows installer for v0.9.1 (branch p4-win)

## Done
- `win/veraldar.nsi`: one exe, per-user, the 7 steps of the plan. Step 1 in .onInit (W-OS message, quit);
  step 2 in the instfiles page (probe the default distribution, else `-d Ubuntu`; else one elevated
  `wsl --install -d Ubuntu --no-launch`, then `ubuntu.exe install --root` if Ubuntu is an unregistered app;
  still nothing -> "Windows must restart" page + HKCU RunOnce -> `%LOCALAPPDATA%\Veraldar\Veraldar-Setup.exe
  /continue`); `wsl -u root wsl-bootstrap.sh --setup` makes the Linux user without a password when the default
  user is root (named after the Windows user, else "veraldar"; uid 1000 when free; `/etc/wsl.conf [user]
  default=`, `wsl --manage --set-default-user`, `ubuntu.exe config --default-user`) and apt-installs curl,
  python3, openssh-client, ca-certificates. Step 3 address page (pre-filled, validated). Steps 4-5: the join
  runs hidden (CreateProcess CREATE_NO_WINDOW), the page polls status.ini every 500 ms and shows the code
  (26 pt) + the QR BMP; 11 min after the code it gives up (W-JOIN), 40 min without a code (W-NET); Cancel
  stops it inside WSL (`--cancel`, its process group). Step 6: Startup shortcut "Veraldar" (wscript
  keepalive.vbs -> launcher.bat -> `wsl -d D -u U ... bin/start --hold`), started at once. Step 7:
  install-report.txt (versions, distro, each step, last 40 lines of setup.log). Uninstaller: bin/stop, removes
  the Startup entry, files, Apps entry; leaves WSL; last screen: remove the PC in the roots sheet.
- `win/wsl-bootstrap.sh`: no git clone. `--setup` (root), the join (status.ini, QR PNG -> BMP, step codes from
  join.sh's exit code + die lines), `--cancel`, `--mask`, `--png2bmp`. The model in ONE place: `upstream_args()`
  passes `--upstream-env` only when the installer wrote `upstream.env` (no installer page for it).
  Masking happens here, before any line reaches the Windows side: setup.log is ASCII, keys/tokens -> ***.
- `scripts/build-win.sh VERSION JOIN_SH OUTDIR` (docker `veraldar-nsis:local`, debian:stable-slim + nsis 3.11):
  `Veraldar-Setup-VERSION.exe`, version in the file properties/Apps list; join.sh embedded byte for byte
  (a stamped join.sh checks its own sha256 against SHA256SUMS). p4-release's release.sh already calls it.
- The exe is no longer committed (`win/.gitignore: *.exe`).
- Tests, all green: `win/bootstrap-test.sh` (30/30, ubuntu:24.04: real useradd + apt-get, every step code,
  BMP decodes, mask, cancel); `win/launcher-test.sh` (30/30, wine 10 + Xvfb + xdotool, fake wsl.exe running the
  REAL wsl-bootstrap.sh); `root/install/join-test.py` bootstrap part rewritten for the new interface (real
  join.sh vs the fake hub). Screens: ~/Work/root-coord-pwa/artifacts/win-installer-*.png.

## Half done
- nothing

## Next (needs a real Windows PC — the owner's run is the proof)
What wine cannot prove:
- real WSL: wsl.exe's own argument handling, `wslpath`, writes to /mnt/c (drvfs), `setsid` under wsl.exe,
  whether WSL shuts the distro down in the ~0.5 s between the join's wsl.exe ending and keepalive starting;
- UAC: the "runas" prompt from the installer's worker thread; `wsl --install -d Ubuntu --no-launch` exit codes
  (0, 3010, 1641 taken as "installed"); whether it registers Ubuntu at once (modern .wsl) or needs
  `ubuntu.exe install --root` (appx); Ubuntu's own first-run (OOBE) staying quiet with our uid-1000 user;
- RunOnce after a real restart; SmartScreen on an unsigned exe ("More info" -> "Run anyway");
- CREATE_NO_WINDOW with Windows Terminal as the default console (no window expected);
- Windows' fonts and DPI scaling (layout measured with wine's fonts; the QR is at most 215 px, the window
  is not DPI-aware, so Windows scales it);
- the 32-bit installer reaching wsl.exe through Sysnative; wscript/VBScript being present.

## For the lead to decide
- The hub sees `os=wsl` (join.sh reports it); nothing changed in the brain/hub. If the roots sheet must say
  `windows`, that is a join.sh/hub change.
- THE MODEL: until it is decided every real run ends at W-MODEL (join.sh stops before the join without one).
  When decided: the installer writes `%LOCALAPPDATA%\Veraldar\upstream.env` (or the approval hands it over)
  and `upstream_args()` already passes it on.
- Signing the exe (SmartScreen warning otherwise).
- VBScript is a Windows "feature on demand" Microsoft plans to switch off by default; keepalive.vbs then stops
  working at logon. A replacement (Task Scheduler entry, or a tiny exe) would be a separate change.
- Over-the-shoulder elevation (a standard user typing another account's admin password): the elevated
  `wsl --install` registers Ubuntu for that admin account; the /continue run then installs Ubuntu again for
  the user (no admin needed then). Not seen on a home PC where the owner is admin.
- README.md line 60 still says "Windows is not part of v0.9.0"; its wording for v0.9.1 is yours.

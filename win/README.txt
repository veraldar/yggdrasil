Veraldar for Windows - Veraldar-Setup-<version>.exe
====================================================

One file. Run it, click through, approve on your phone. This PC then becomes one
more root of your tree: its own brain, inside WSL2 (Ubuntu), dialing out to your
trunk. Nothing listens on your network.

What it does, in one window (no terminal, no typing except the phone)
  1. Checks Windows: 10 version 2004 (build 19041) or newer, or 11; 64-bit.
  2. Checks WSL2 with Ubuntu or Debian. If WSL is missing, Windows asks for
     permission once, installs it, and must restart; Setup then goes on by
     itself. No Linux user name or password is asked.
  3. Asks for the trunk address (already filled in: https://ap.veraldar.org).
  4. Downloads the signed release inside WSL and checks its signature.
  5. Shows a code and a QR. Approve it on your phone (10 minutes).
  6. Starts Veraldar, and again at every logon (Startup: "Veraldar").

If something fails, the last screen shows a step code:
  W-OS     this Windows is too old, or not 64-bit Intel/AMD
  W-WSL    WSL or Ubuntu could not be set up
  W-NET    the trunk or the release could not be reached
  W-SIG    the download failed its signature check (nothing installed)
  W-JOIN   refused on the phone, not approved in time, or the trunk said no
  W-MODEL  this PC has no AI model to use yet
  W-RUN    joined, but Veraldar did not start
Details: %LOCALAPPDATA%\Veraldar\install-report.txt (no keys or tokens in it).

Remove: Settings > Apps > Veraldar. It stops Veraldar and removes it; Ubuntu
stays. Then remove this PC in the roots sheet on your phone.

For developers
  Build:  scripts/build-win.sh VERSION JOIN_SH OUTDIR   (makensis in docker)
  Tests:  win/bootstrap-test.sh   (the Linux half, in an Ubuntu container)
          win/launcher-test.sh    (the installer under wine, a fake wsl.exe)
  Notes:  win/NOTES-win.md        (what wine cannot prove)

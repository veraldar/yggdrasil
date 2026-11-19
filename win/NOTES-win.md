# NOTES-win — Windows installer for v0.9.1 (branch p4-win)

## Done
- wsl-bootstrap.sh rewritten: no git clone; modes --setup (root: user + apt-get), join (status.ini for the
  installer window, QR PNG->BMP, step codes), --cancel, --mask, --png2bmp. Model in one place: upstream_args().
- win/bootstrap-test.sh: 29/29 green in ubuntu:24.04 (setup, QR BMP decodes, mask, every step code, cancel).

## Half done
- veraldar.nsi (7 steps), launcher.bat/keepalive.vbs (no prompts), scripts/build-win.sh, launcher-test.sh (wine).

## Next
- wine test + screenshots, join-test.py bootstrap part, README.txt, review.

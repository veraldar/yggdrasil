`common-passwords.txt.gz` — the passwords a new password may not be (spec §8: "12–128 characters plus an
embedded top-100k list").

Source: SecLists `Passwords/Common-Credentials/100k-most-used-passwords-NCSC.txt` (the UK NCSC list of the
100,000 most used passwords seen in breaches, from Have I Been Pwned; SecLists is MIT-licensed),
fetched 2026-11-25. Kept as: every line lowercased, de-duplicated, sorted, one per line, gzip -9 (mtime 0).
The check is case-insensitive. Regenerate with the same steps if the list is ever refreshed.

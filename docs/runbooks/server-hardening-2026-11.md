# Server hardening, November 2026 — applying it to the existing server

Applies, on the server that already runs (`padmakara@admin.padmakara.pt`), what
branch `chore/infra-hardening` changed in `deploy/`:

1. `sudo cp` is replaced by `/usr/local/sbin/padmakara-install-config`.
2. The API `.env` (and the app's env files) become mode 600.
3. The hourly backup uses the put-only AWS profile, `umask 077` and `mktemp`.
4. The Caddy site gets HSTS, a Report-Only CSP and `?Referrer-Policy`.

Run every command on its own, one per `ssh`, and read its output before the
next one. Nothing here is chained on purpose.

**Order matters.** Do this after the branch is merged and pushed, and **before**
the next `deploy/deploy.sh`: the new deploy script calls the helper, which is
not allowed by sudo until step B is done. Until then a deploy that needs to
install a Caddy file would stop at that point.

**There is no root login and no other sudo account on this box** (as far as the
repository knows). After step B5, padmakara can no longer write `/etc` with
`cp`, so a mistake in sudoers can only be undone from the Hetzner console
(rescue system). That is why B validates every file with `visudo -c` and why the
new rules are tested (B3–B4) while `cp` still works.

## A. Get the code onto the server

A1. Update the checkout without deploying (this is what `deploy.sh` does first):

```bash
ssh padmakara@admin.padmakara.pt 'cd ~/padmakara-api && git fetch origin main'
ssh padmakara@admin.padmakara.pt 'cd ~/padmakara-api && git reset --hard origin/main'
```

A2. Check that `uploads/` still exists (the unit lists it in `ReadWritePaths`;
the branch removed the tracked CSVs and keeps `uploads/.gitkeep`):

```bash
ssh padmakara@admin.padmakara.pt 'ls -ld ~/padmakara-api/uploads'
```

A3. Check the helper arrived executable:

```bash
ssh padmakara@admin.padmakara.pt 'ls -l ~/padmakara-api/deploy/padmakara-install-config'
```

Expect `-rwxr-xr-x`.

## B. Replace `sudo cp` with the helper

B0. Look at the sudoers file in use and compare it with the one in the repo.
If the server's file has lines the repo's version lacks, **stop** and add them
to the new file in B1 before going on:

```bash
ssh padmakara@admin.padmakara.pt 'cat /etc/sudoers.d/padmakara'
```

B1. Install the helper as root, using `sudo cp` one last time:

```bash
ssh padmakara@admin.padmakara.pt 'sudo cp ~/padmakara-api/deploy/padmakara-install-config /usr/local/sbin/padmakara-install-config'
ssh padmakara@admin.padmakara.pt 'ls -l /usr/local/sbin/padmakara-install-config'
```

Expect owner `root root`, mode `-rwxr-xr-x`. A root-owned file that padmakara
cannot write is the whole point: if the owner is not root, stop.

B2. Build the two sudoers files from the repo — the final one, and a
transitional one that also keeps `cp` for the test in B3:

```bash
ssh padmakara@admin.padmakara.pt "sed -n '/<<.SUDOERS./,/^SUDOERS\$/p' ~/padmakara-api/deploy/setup-server.sh | sed '1d;\$d' > ~/sudoers.final"
ssh padmakara@admin.padmakara.pt 'cp ~/sudoers.final ~/sudoers.transition'
ssh padmakara@admin.padmakara.pt "echo 'padmakara ALL=(ALL) NOPASSWD: /usr/bin/cp' >> ~/sudoers.transition"
ssh padmakara@admin.padmakara.pt 'cat ~/sudoers.final'
```

The final file must list the `systemctl` lines and the three
`padmakara-install-config unit|site|entry` lines, and no `cp`.

B3. Validate both files (padmakara can run `visudo -c -f` on a file it can
read). Both must print `parsed OK`; if either does not, or visudo refuses to
run, stop here — nothing has changed yet:

```bash
ssh padmakara@admin.padmakara.pt '/usr/sbin/visudo -c -f ~/sudoers.final'
ssh padmakara@admin.padmakara.pt '/usr/sbin/visudo -c -f ~/sudoers.transition'
```

B4. Install the transitional file and test the helper while `cp` still works:

```bash
ssh padmakara@admin.padmakara.pt 'sudo cp ~/sudoers.transition /etc/sudoers.d/padmakara'
ssh padmakara@admin.padmakara.pt 'sudo -l'
ssh padmakara@admin.padmakara.pt 'sudo -n /usr/local/sbin/padmakara-install-config site'
```

The last command validates the new Caddy site file as the caddy user and
installs it (item 4). Expect
`installed /etc/caddy/sites/padmakara-api.caddy (reload caddy to apply)`.
If it fails, `cp` still works: fix the cause, or put the old file back (see
Rollback) before going further.

Apply it:

```bash
ssh padmakara@admin.padmakara.pt 'sudo systemctl reload caddy'
ssh padmakara@admin.padmakara.pt 'systemctl is-active caddy'
```

B5. Install the final file — the last use of `sudo cp`:

```bash
ssh padmakara@admin.padmakara.pt 'sudo cp ~/sudoers.final /etc/sudoers.d/padmakara'
```

B6. Verify:

```bash
ssh padmakara@admin.padmakara.pt 'sudo -l'
ssh padmakara@admin.padmakara.pt 'sudo -n /usr/bin/cp --version'
ssh padmakara@admin.padmakara.pt 'ls -l /etc/sudoers.d/padmakara'
```

`sudo -l` lists no `cp`; the `cp --version` call must fail with "a password is
required" (padmakara has no password, so it cannot be given); the file stays
`-r--r----- root root`.

B7. Clean up:

```bash
ssh padmakara@admin.padmakara.pt 'rm ~/sudoers.final ~/sudoers.transition'
```

## C. Env files at mode 600

```bash
ssh padmakara@admin.padmakara.pt 'chmod 600 ~/padmakara-api/.env'
ssh padmakara@admin.padmakara.pt 'ls -l ~/padmakara-api/.env ~/padmakara-app/.env ~/padmakara-app/.env.local'
```

Then `chmod 600` whichever of the two app files the `ls` shows exist. While at
it, the AWS credentials file:

```bash
ssh padmakara@admin.padmakara.pt 'chmod 600 ~/.aws/credentials'
```

The unit reads `EnvironmentFile` through systemd (root) and Bun reads `.env` as
padmakara, its owner, so nothing loses access. Check the API after the next
restart, or now:

```bash
ssh padmakara@admin.padmakara.pt 'sudo systemctl restart padmakara-api'
ssh padmakara@admin.padmakara.pt 'curl -sf http://localhost:3000/health'
```

From then on `deploy.sh` re-applies the modes on every deploy.

## D. Backups

The AWS side was done on 2026-11-16 (see the header of `deploy/backup-db.sh`):
IAM user `padmakara-db-backup`, allowed only `s3:PutObject` and
`s3:AbortMultipartUpload` on `padmakara-pt-database-backups/db-backups/*`, its
key on the server as profile `[padmakara-db-backup]`, and a lifecycle rule that
expires `db-backups/` objects after 30 days (noncurrent versions 30 more days).
The script no longer deletes old backups; it could not anyway.

D1. Check the profile is there:

```bash
ssh padmakara@admin.padmakara.pt "grep -c '^\[padmakara-db-backup\]' ~/.aws/credentials"
```

Expect `1`.

D2. The cron runs a copy, not the repo file. Keep the old copy, install the new:

```bash
ssh padmakara@admin.padmakara.pt 'cp ~/backup-db.sh ~/backup-db.sh.bak-2026-11'
ssh padmakara@admin.padmakara.pt 'cp ~/padmakara-api/deploy/backup-db.sh ~/backup-db.sh'
ssh padmakara@admin.padmakara.pt 'chmod 700 ~/backup-db.sh'
```

D3. Check the cron entry still points at it:

```bash
ssh padmakara@admin.padmakara.pt 'crontab -l'
```

Expect `0 * * * * /home/padmakara/backup-db.sh >> /home/padmakara/backup.log 2>&1`.

D4. Run it once by hand:

```bash
ssh padmakara@admin.padmakara.pt '~/backup-db.sh'
```

Expect `Uploaded to s3://padmakara-pt-database-backups/db-backups/<timestamp>.sql.gz`
and `Backup complete.` An `AccessDenied` means the profile or its policy is
wrong (the profile cannot list, so do not use `aws s3 ls` to test it).

D5. After the next full hour: the new object appears under `db-backups/` in the
bucket (check with an identity that can list, e.g. the console), and the log
shows no error:

```bash
ssh padmakara@admin.padmakara.pt 'tail -n 20 ~/backup.log'
```

D6. Nothing is left in `/tmp`:

```bash
ssh padmakara@admin.padmakara.pt 'ls -l /tmp/padmakara*'
```

Old runs left `padmakara_<timestamp>.sql.gz` only when they failed mid-way;
delete any you find. New runs use `padmakara-backup.XXXXXXXXXX` (mode 600) and
remove it on exit.

## E. Caddy headers

Already installed in B4. Check them:

```bash
curl -sI https://app.padmakara.pt/ | grep -iE 'strict-transport|content-security'
curl -sI https://admin.padmakara.pt/ | grep -iE 'strict-transport|content-security'
curl -sI https://api.padmakara.pt/health | grep -i referrer-policy
```

The API must now answer `Referrer-Policy: no-referrer` (the application's own
value, no longer overwritten).

The CSP is **Report-Only**. Before switching it to enforcing, open the web app
and the admin in a browser with the console open and go through the screens
listed in the comments of `deploy/padmakara-api.caddy`; every
`[Report Only] Refused to ...` line names a source to add (or a bug). Also
confirm which object store prod uses (`S3_ENDPOINT` set means R2) and drop the
unused storage host from both policies.

## Rollback

- **Caddy file:** `git revert` the Caddy commit, push, pull on the server
  (A1), then `sudo -n /usr/local/sbin/padmakara-install-config site` and
  `sudo systemctl reload caddy`.
- **Sudoers, before B5:** `sudo cp` still works; put back a file with the old
  content (B0's output) the same way as B4.
- **Sudoers, after B5:** padmakara cannot write `/etc` any more, by design.
  Roll back from the Hetzner console (rescue system, or a root console) by
  restoring B0's content into `/etc/sudoers.d/padmakara` (mode 0440, then
  `visudo -c`). Restoring the `cp` line is not recommended.
- **Helper:** removing it needs root (same as above); without its sudoers
  lines it is inert.
- **Env file modes:** `chmod 644 <file>` as padmakara (not recommended).
- **Backups:** `cp ~/backup-db.sh.bak-2026-11 ~/backup-db.sh`. Note that the old
  script uses the default profile, which loses its rights on `db-backups/*`
  once the IAM change is complete, and its retention loop would fail.

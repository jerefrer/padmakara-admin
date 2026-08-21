# Runbook: video-burn AWS provisioning

One-time AWS setup for the title-slide burn-in pipeline. The application
code (`src/services/video-burn.ts`, `POST /api/webhooks/video-burn`, the
container in `containers/video-burn/`) is already built and cannot be
provisioned automatically — it needs account access. Follow this in order.

Related reading:
- Design: `docs/superpowers/specs/2026-08-21-video-slides-burn-in-design.md`
  (repo root, one level above `padmakara-api/`)
- Container internals: `containers/video-burn/README.md`

This assumes an existing AWS Batch setup already runs the read-along and
subtitle-generation jobs (`BATCH_JOB_DEFINITION` / `BATCH_JOB_QUEUE` in the
server `.env`) — the video-burn job reuses the same compute environment and
job queue by default, and only needs its own job **definition**.

---

## 1. Build and push the image to ECR

```bash
# One-time: create the repository if it doesn't exist yet.
aws ecr create-repository --repository-name padmakara-video-burn --region eu-west-3

# Build. MUST run from the padmakara-api repo root (not containers/video-burn/) —
# the image needs src/lib/slides/, which lives outside the container's own directory.
cd padmakara-api
docker build -f containers/video-burn/Dockerfile -t padmakara-video-burn:latest .

# Tag + push.
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
aws ecr get-login-password --region eu-west-3 | docker login --username AWS --password-stdin "$ACCOUNT_ID.dkr.ecr.eu-west-3.amazonaws.com"
docker tag padmakara-video-burn:latest "$ACCOUNT_ID.dkr.ecr.eu-west-3.amazonaws.com/padmakara-video-burn:latest"
docker push "$ACCOUNT_ID.dkr.ecr.eu-west-3.amazonaws.com/padmakara-video-burn:latest"
```

Re-run the build + push (no other steps) whenever `containers/video-burn/`
or `src/lib/slides/` changes. The job definition (below) references the
image by tag; if you push to a fixed tag like `:latest`, a NEW job picks up
the new image automatically — Batch does not re-pull for jobs already
queued/running.

## 2. Create the Batch job definition

```bash
aws batch register-job-definition \
  --job-definition-name padmakara-video-burn \
  --type container \
  --platform-capabilities FARGATE \
  --container-properties '{
    "image": "'"$ACCOUNT_ID"'.dkr.ecr.eu-west-3.amazonaws.com/padmakara-video-burn:latest",
    "jobRoleArn": "arn:aws:iam::'"$ACCOUNT_ID"':role/padmakara-video-burn-job-role",
    "executionRoleArn": "arn:aws:iam::'"$ACCOUNT_ID"':role/padmakara-batch-execution-role",
    "resourceRequirements": [
      { "type": "VCPU", "value": "4" },
      { "type": "MEMORY", "value": "8192" }
    ],
    "ephemeralStorage": { "sizeInGiB": 50 },
    "environment": [
      { "name": "BUNNY_STREAM_LIBRARY_ID", "value": "REPLACE_ME" },
      { "name": "BUNNY_STREAM_API_KEY", "value": "REPLACE_ME" }
    ],
    "networkConfiguration": { "assignPublicIp": "ENABLED" },
    "fargatePlatformConfiguration": { "platformVersion": "LATEST" }
  }' \
  --retry-strategy '{"attempts": 1}' \
  --timeout '{"attemptDurationSeconds": 10800}'
```

Adjust `jobRoleArn` / `executionRoleArn` / networking to match whatever
your existing read-along/subtitle job definitions use — the burn job
should sit in the same VPC/subnets/security groups so its S3 access works
identically. `--retry-strategy attempts: 1` is intentional: a failed burn
should surface as `failed` in the admin (via the webhook or
`reconcileVideoBurnRows`), not silently retry and potentially double-charge
a multi-GB re-encode.

### Sizing rationale — 4 vCPU / 8 GB memory / 50 GB ephemeral storage

This job's cost profile is unlike the read-along/subtitle jobs it shares a
queue with: those stream audio through Whisper; this one **streams
multi-GB video files** and occasionally has to fully re-encode one.

- **vCPU: 4.** The common path (stream-copy concat, `-c copy`) is nearly
  free on CPU — no re-encoding happens for the master itself, only for the
  few short intro/outro slide segments (seconds each). The expensive case
  is the **fallback**: a full re-encode of the whole merged file when
  duration validation fails on the stream-copy path. `libx264` scales
  well up to ~4 threads with diminishing returns beyond that for a single
  job; 4 vCPU keeps a worst-case fallback re-encode of a 1–2 hour 1080p
  retreat recording in the tens-of-minutes range rather than hours,
  without paying for idle capacity on the (typical) fast path.
- **Memory: 8192 MB.** Headless Chromium (a handful of slide screenshots,
  not a heavy page) and ffmpeg's own buffers are modest individually, but
  they run against files that are being streamed through `/tmp` at
  multi-GB scale — leave real headroom over the theoretical minimum so an
  unusually large master (a full-day recording) doesn't OOM mid-job.
- **Ephemeral storage: 50 GiB (Fargate `ephemeralStorage`, needs platform
  version ≥ 1.4.0, set above).** The container simultaneously holds, in
  `/tmp`: the downloaded master, all intro/outro slide segments, AND the
  merged output — the master and the merged output alone can each be
  several GB for a multi-hour recording, and if the fallback re-encode
  path runs, the original stream-copy attempt's (bad) output should also
  be accounted for as a still-present file until cleanup. 50 GiB gives
  comfortable headroom for a ~2× master size plus scratch, for any master
  up to roughly 20 GB. If your retreat recordings regularly exceed that
  (e.g. multi-day single-file masters), scale this up accordingly —
  running out of ephemeral storage mid-job fails ugly (a disk-full I/O
  error, not a clean validation failure).

Revisit these numbers once real burn jobs have run — `aws batch
describe-jobs` reports actual CPU/memory utilization per job, which is a
better basis for tuning than this a priori estimate.

## 3. Attach to the existing job queue

If the video-burn job definition targets the SAME compute environment as
the read-along/subtitle jobs (recommended — avoids provisioning a second
compute environment for occasional bursty work), no queue changes are
needed: `config.videoBurn.jobQueue` defaults to `BATCH_JOB_QUEUE` (the same
env var the read-along/subtitle jobs already use). Only set
`BURN_JOB_QUEUE` in the server `.env` if you deliberately want burn jobs on
a separate queue (e.g. to isolate their resource profile from the
Whisper-based jobs) — then create that queue and attach the same compute
environment(s), or a dedicated one, to it:

```bash
aws batch create-job-queue \
  --job-queue-name padmakara-video-burn-queue \
  --priority 1 \
  --compute-environment-order order=1,computeEnvironment=<existing-or-new-compute-env-arn>
```

## 4. IAM policy for the job role

The job role (`jobRoleArn` above — distinct from the execution role, which
only needs ECR pull + CloudWatch Logs permissions) needs S3 access to:

- **Read** the master recording (`events/*/masters/*`) and any admin-set
  slide image assets — slide image lines are NOT restricted to one prefix
  (an admin can reference any object key already in the bucket), so the
  read grant covers the whole bucket rather than guessing at a subset.
- **Read/write** its own scratch prefix (`video-burn/*`) — slide document
  JSON, the merged output, and the extracted thumbnail all live there.

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "VideoBurnReadBucket",
      "Effect": "Allow",
      "Action": ["s3:GetObject"],
      "Resource": "arn:aws:s3:::padmakara-pt-app/*"
    },
    {
      "Sid": "VideoBurnReadWriteScratch",
      "Effect": "Allow",
      "Action": ["s3:GetObject", "s3:PutObject"],
      "Resource": "arn:aws:s3:::padmakara-pt-app/video-burn/*"
    },
    {
      "Sid": "VideoBurnListBucket",
      "Effect": "Allow",
      "Action": ["s3:ListBucket"],
      "Resource": "arn:aws:s3:::padmakara-pt-app"
    }
  ]
}
```

Replace `padmakara-pt-app` with the actual bucket name (`S3_BUCKET` /
`config.storage.bucket`) if it differs per environment. If the bucket
later migrates to R2 (tracked elsewhere in this codebase — see
`docs/superpowers/plans/2026-07-28-s3-to-r2-audio-migration.md`), this
container already reads its S3 endpoint from `S3_ENDPOINT` like every
other pipeline container, so no code change is needed here — only the
credentials/policy attached to whatever principal that endpoint uses.

Attach this policy to the job role, and confirm the trust policy allows
`ecs-tasks.amazonaws.com` to assume it (standard for Batch-on-Fargate job
roles).

## 5. Env vars to set on the server

In the backend's `.env` (`padmakara-api` production host):

```bash
BURN_JOB_DEFINITION=padmakara-video-burn
# Omit BURN_JOB_QUEUE entirely unless you created a dedicated queue in step 3 —
# it defaults to the same value as BATCH_JOB_QUEUE.
# BURN_JOB_QUEUE=padmakara-video-burn-queue

# Optional — only set this to override the container's bundled default
# outro logo (@builtin/padmakara-logo.png) with one stored in the bucket.
# Leave unset/blank to use the builtin.
# BURN_OUTRO_LOGO_S3_KEY=
```

`READ_ALONG_WEBHOOK_SECRET` is reused for the video-burn webhook's HMAC —
no new secret to configure.

On the **job definition** itself (step 2 above, NOT the server `.env` —
these are static credentials shared by every job, not per-invocation data
the backend passes through `containerOverrides`):

```
BUNNY_STREAM_LIBRARY_ID=<same value as the backend's BUNNY_STREAM_LIBRARY_ID>
BUNNY_STREAM_API_KEY=<same value as the backend's BUNNY_STREAM_API_KEY>
```

Restart the `padmakara-api` systemd service after editing `.env`:

```bash
ssh padmakara@admin.padmakara.pt
sudo systemctl restart padmakara-api
journalctl -u padmakara-api --no-pager -n 50   # do NOT use -f, it hangs
```

## 6. Verification checklist

After the first real burn job runs (trigger one from the admin UI once
it exposes a "burn" action, or call `submitVideoBurnJob` directly):

- [ ] `aws batch describe-jobs --jobs <id>` shows `SUCCEEDED`.
- [ ] The backend received the completion webhook — check
      `journalctl -u padmakara-api` for `[webhook] Video burn completed for
      video <id>`.
- [ ] `event_videos.burn_status` is `done`, `bunny_video_id` was replaced,
      `burned_intro_ms` is set, `burn_error` is null.
- [ ] **Confirm the poster is NOT black.** Open the video in the app's
      grid (`padmakara-app/components/VideoGrid.tsx`) or fetch the video's
      metadata from Bunny directly and view `thumbnailFileName` — it must
      show real content, not a black or black-with-text frame. This is
      the specific failure mode the thumbnail-extraction step
      (`containers/video-burn/README.md` → "Why the poster thumbnail step
      exists") was built to prevent; if it's still black, check the job's
      logs for a `Thumbnail extraction/upload failed:` warning line rather
      than assuming the whole job failed.
- [ ] Play the video from the start — the intro should be visible, fade in
      cleanly, and hand off to the real recording without a visible glitch
      or audio pop at the boundary.
- [ ] If this was a RE-burn: confirm existing `video_progress` rows for
      that video still resume at roughly the right point (shifted by the
      intro-length delta, not left pointing at the old timeline), and any
      existing `video_subtitles` rows are now flagged `stale = true` in
      the admin.
- [ ] Trigger a deliberately-broken job (e.g. an invalid `MASTER_S3_KEY`)
      and confirm `event_videos.burn_status` ends up `failed` with a
      readable `burn_error`, either via the webhook or — if you kill the
      job before it can call the webhook at all —
      `reconcileVideoBurnRows()` picking it up as aged-out within ~15
      minutes.

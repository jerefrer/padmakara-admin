# data/

`s3-inventory.json` — catalog of the legacy `padmakara-pt` S3 bucket
(every event, loose file, and ZIP's contents). Generated once during the
2026 migration; used by the event-import system as the source-of-truth map.
Read-only at runtime. Regenerate only if the legacy bucket changes.

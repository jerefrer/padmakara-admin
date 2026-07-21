# Event Documents Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the single per-event transcript into a general Documents feature (transcript + images/PDF/Office files) with easy admin upload, an app Documents tab, admin content-presence icons, and a search icon.

**Architecture:** Keep the `transcripts` table untouched and revive the dormant `event_files` table as the generic document store. The app merges both into one Documents list (transcript pinned first, featured). Generic file bytes are served by a new access-controlled media endpoint that watermarks only PDFs flagged `sensitive`. Admin uploads persist rows through two new react-admin resources (`event-files`, `transcripts`), which also fixes the existing transcript-persistence gap.

**Tech Stack:** Bun, Hono, Drizzle ORM (Postgres), Zod v4, Vitest (backend); React-admin + Vite + MUI + @dnd-kit (admin); React Native / Expo + Jest (app).

**Design spec:** `docs/superpowers/specs/2026-07-21-event-documents-design.md`

## Global Constraints

- **Repos:** backend + admin in `padmakara-api/`, app in `padmakara-app/`. Both are separate git repos on `main`. Commit to `main` in the relevant repo per task.
- **Migrations only:** never `db:push`. Hand-write `src/db/migrations/NNNN_*.sql` (`IF NOT EXISTS` / `IF EXISTS`), append to `src/db/migrations/meta/_journal.json`, apply with `bun db:migrate`. The **test DB `padmakara_test` is separate** — apply the migration SQL there too before running tests that touch new columns.
- **zoxide** hijacks `cd`: always run subdir commands as `sh -c 'cd /abs/path && <cmd>'`.
- **Backend tests:** Vitest, mocked-db pattern. Run: `sh -c 'cd /Users/jeremy/Documents/Programming/padmakara-backend-frontend/padmakara-api && bunx vitest run <file>'`. Typecheck: `bun run typecheck`.
- **Admin build/typecheck:** `sh -c 'cd /Users/jeremy/Documents/Programming/padmakara-backend-frontend/padmakara-api/admin && bunx tsc -b'` (full build: `bunx vite build`).
- **App:** typecheck `sh -c 'cd /Users/jeremy/Documents/Programming/padmakara-backend-frontend/padmakara-app && bunx tsc --noEmit'`; tests `... && bunx jest <file>`; lint `... && npx expo lint`.
- **Localization:** every new app-facing string uses `t('documents.x') || 'Fallback'`, added to BOTH `locales/en.json` and `locales/pt.json`. Never hardcode English. The word "subscription"/"subscrição" must never appear in app UI.
- **Visible-document rule (used everywhere):** an `event_files` row is a user-visible document iff `fileType IN ('document','image','other')`. `subtitle`/`design` are admin-internal.
- **Deploy:** after backend/admin changes land, run `deploy/deploy.sh padmakara@admin.padmakara.pt` and apply the migration to prod (see spec §12). Deploy is a final step, not per-task.

---

## File Structure

**padmakara-api (backend):**
- `src/db/schema/event-files.ts` — add `sensitive`, `title`, `sortOrder`; ensure events relation.
- `src/db/schema/retreats.ts` — ensure `eventFiles: many(eventFiles)` on events relations.
- `src/db/migrations/0033_event_files_documents.sql` + `meta/_journal.json`.
- `src/lib/schemas.ts` — `presignFileSchema`, `createEventFileSchema`, `updateEventFileSchema`, `createTranscriptSchema`, `updateTranscriptSchema`.
- `src/services/s3.ts` — `buildEventFileS3Key`.
- `src/routes/admin/upload.ts` — `POST /presign-file`.
- `src/routes/admin/event-files.ts` (new) + mount in `src/routes/admin/index.ts`.
- `src/routes/admin/transcripts.ts` (new) + mount.
- `src/routes/admin/events.ts` — `hasVideo/hasAudio/hasDocuments` on list rows.
- `src/routes/events.ts` — load visible `eventFiles` in `eventWithSessions`.
- `src/routes/media.ts` — shared `watermarkPdf` helper + `GET /file/:id`.

**padmakara-api (admin UI):**
- `admin/src/App.tsx` — register `event-files` + `transcripts` resources.
- `admin/src/utils/uploadManager.ts` — `presignFile` + `uploadFile`.
- `admin/src/resources/events.tsx` — `DocumentsSection` in create/edit; transcript handlers persist; content-icons column; `SearchInput`.

**padmakara-app (frontend):**
- `types/index.ts`, `services/apiConfig.ts`, `services/retreatService.ts` — model + merge + file URL.
- `app/(tabs)/(groups)/retreat/[id].tsx` — Documents tab + handlers.
- `components/DocumentImageViewer.tsx` (new).
- `locales/en.json`, `locales/pt.json`.

---

# PHASE 1 — Backend (padmakara-api)

### Task 1: Schema columns + migration for `event_files`

**Files:**
- Modify: `src/db/schema/event-files.ts`
- Modify: `src/db/schema/retreats.ts` (events relations — add `eventFiles: many(eventFiles)` if missing)
- Create: `src/db/migrations/0033_event_files_documents.sql`
- Modify: `src/db/migrations/meta/_journal.json`

**Interfaces:**
- Produces: `eventFiles` table with new columns `sensitive: boolean` (default false), `title: text | null`, `sortOrder: integer` (default 0). Events relation exposes `eventFiles` for `db.query.events.findMany({ with: { eventFiles: ... } })`.

- [ ] **Step 1: Add columns to the schema**

In `src/db/schema/event-files.ts`, add `boolean` to the drizzle import and add three columns after `language`:

```typescript
import {
  pgTable,
  serial,
  text,
  integer,
  bigint,
  boolean,
  timestamp,
} from "drizzle-orm/pg-core";
```
```typescript
  language: text("language"), // Optional language for subtitles, docs, etc.

  // Documents feature
  sensitive: boolean("sensitive").notNull().default(false),
  title: text("title"),
  sortOrder: integer("sort_order").notNull().default(0),
```

- [ ] **Step 2: Ensure events → eventFiles relation**

Open `src/db/schema/retreats.ts`, find `eventsRelations` (it already declares `transcripts` and `videos`). If `eventFiles` is not present, add it. It needs the import of `eventFiles` from `./event-files.ts` (add if absent — watch for circular import: `event-files.ts` imports `events` from `retreats.ts`, which is fine since relations are lazy):

```typescript
  eventFiles: many(eventFiles),
```

- [ ] **Step 3: Write the migration SQL**

Create `src/db/migrations/0033_event_files_documents.sql`:

```sql
-- Event Documents: revive event_files as the generic document store.
-- The table may exist only via a setup script in some environments, so create
-- it defensively, then add the new Documents columns.

CREATE TABLE IF NOT EXISTS event_files (
  id serial PRIMARY KEY,
  event_id integer NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  session_id integer REFERENCES sessions(id) ON DELETE SET NULL,
  original_filename text NOT NULL,
  s3_key text NOT NULL,
  file_type text NOT NULL,
  extension text NOT NULL,
  file_size_bytes bigint,
  language text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE event_files ADD COLUMN IF NOT EXISTS sensitive boolean NOT NULL DEFAULT false;
ALTER TABLE event_files ADD COLUMN IF NOT EXISTS title text;
ALTER TABLE event_files ADD COLUMN IF NOT EXISTS sort_order integer NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS event_files_event_id_idx ON event_files(event_id);
```

- [ ] **Step 4: Append the journal entry**

In `src/db/migrations/meta/_journal.json`, append after the `idx: 32` entry (mind the comma):

```json
    {
      "idx": 33,
      "version": "7",
      "when": 1811209600000,
      "tag": "0033_event_files_documents",
      "breakpoints": true
    }
```

- [ ] **Step 5: Apply the migration (dev + test DB)**

Run:
```bash
sh -c 'cd /Users/jeremy/Documents/Programming/padmakara-backend-frontend/padmakara-api && bun db:migrate'
```
Then apply to the test DB (which `db:migrate` does not touch). Find the test DATABASE_URL (check `.env.test` / `vitest` setup); apply the SQL:
```bash
sh -c 'cd /Users/jeremy/Documents/Programming/padmakara-backend-frontend/padmakara-api && psql "$TEST_DATABASE_URL" -f src/db/migrations/0033_event_files_documents.sql'
```
Expected: both succeed (idempotent — safe if the table already existed).

- [ ] **Step 6: Typecheck**

Run: `sh -c 'cd /Users/jeremy/Documents/Programming/padmakara-backend-frontend/padmakara-api && bun run typecheck'`
Expected: no new errors.

- [ ] **Step 7: Commit**

```bash
git -C padmakara-api add src/db/schema/event-files.ts src/db/schema/retreats.ts src/db/migrations/0033_event_files_documents.sql src/db/migrations/meta/_journal.json
git -C padmakara-api commit -m "feat(api): add sensitive/title/sortOrder columns to event_files

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Zod schemas + S3 key builder

**Files:**
- Modify: `src/lib/schemas.ts`
- Modify: `src/services/s3.ts`
- Test: `tests/services/event-file-s3.test.ts` (new)

**Interfaces:**
- Produces:
  - `presignFileSchema` = `{ eventCode: string, filename: safeFilename, contentType: string, fileType: "image"|"document"|"other"|"subtitle"|"design" }`
  - `createEventFileSchema` = `{ eventId: number, originalFilename: string, s3Key: string, fileType: <enum>, extension: string, fileSizeBytes?: number|null, language?: string|null, title?: string|null, sensitive?: boolean(=false), sortOrder?: number(=0) }`
  - `updateEventFileSchema` = partial of `{ title, sensitive, sortOrder, language, fileType }`
  - `createTranscriptSchema` = `{ eventId: number, language: string, s3Key: string, originalFilename?: string|null, fileSizeBytes?: number|null, pageCount?: number|null, status?: string(="published") }`
  - `updateTranscriptSchema` = partial of `{ language, status }`
  - `buildEventFileS3Key(eventCode, fileType, filename): string` → `events/{eventCode}/{fileType}/{filename}`

- [ ] **Step 1: Write the failing test for the key builder + schemas**

Create `tests/services/event-file-s3.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { buildEventFileS3Key } from "../../src/services/s3.ts";
import {
  presignFileSchema,
  createEventFileSchema,
  createTranscriptSchema,
} from "../../src/lib/schemas.ts";

describe("buildEventFileS3Key", () => {
  it("builds events/{code}/{type}/{file}", () => {
    expect(buildEventFileS3Key("EVT-01", "document", "notes.pdf")).toBe(
      "events/EVT-01/document/notes.pdf",
    );
  });
});

describe("event file schemas", () => {
  it("accepts a valid presign-file body", () => {
    const r = presignFileSchema.safeParse({
      eventCode: "EVT-01",
      filename: "slides.pptx",
      contentType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      fileType: "document",
    });
    expect(r.success).toBe(true);
  });

  it("rejects an unknown fileType", () => {
    const r = presignFileSchema.safeParse({
      eventCode: "EVT-01",
      filename: "x.pdf",
      contentType: "application/pdf",
      fileType: "video",
    });
    expect(r.success).toBe(false);
  });

  it("defaults sensitive=false and sortOrder=0 on create", () => {
    const r = createEventFileSchema.parse({
      eventId: 5,
      originalFilename: "photo.jpg",
      s3Key: "events/EVT/image/photo.jpg",
      fileType: "image",
      extension: "jpg",
    });
    expect(r.sensitive).toBe(false);
    expect(r.sortOrder).toBe(0);
  });

  it("defaults transcript status to published", () => {
    const r = createTranscriptSchema.parse({
      eventId: 5,
      language: "en",
      s3Key: "events/EVT/transcripts/t.pdf",
    });
    expect(r.status).toBe("published");
  });
});
```

- [ ] **Step 2: Run it — expect failure**

Run: `sh -c 'cd /Users/jeremy/Documents/Programming/padmakara-backend-frontend/padmakara-api && bunx vitest run tests/services/event-file-s3.test.ts'`
Expected: FAIL (`buildEventFileS3Key` / schemas not exported).

- [ ] **Step 3: Add the S3 key builder**

In `src/services/s3.ts`, after `buildTranscriptS3Key`:

```typescript
/**
 * Build a consistent S3 key for generic event document files.
 * Format: events/{event_code}/{file_type}/{filename}
 */
export function buildEventFileS3Key(
  eventCode: string,
  fileType: string,
  filename: string,
): string {
  return `events/${eventCode}/${fileType}/${filename}`;
}
```

- [ ] **Step 4: Add the Zod schemas**

In `src/lib/schemas.ts`, after `presignTranscriptSchema`:

```typescript
const eventFileTypeSchema = z.enum([
  "image",
  "document",
  "other",
  "subtitle",
  "design",
]);

// Presign upload for a generic event document.
export const presignFileSchema = z.object({
  eventCode: z.string().min(1).max(200),
  filename: safeFilenameSchema,
  contentType: z.string().min(1).max(200),
  fileType: eventFileTypeSchema,
});

// Persist an event_files row after the S3 PUT completes.
export const createEventFileSchema = z.object({
  eventId: z.number().int(),
  originalFilename: z.string().min(1).max(500),
  s3Key: z.string().min(1).max(1000),
  fileType: eventFileTypeSchema,
  extension: z.string().min(1).max(20),
  fileSizeBytes: z.number().int().min(0).optional().nullable(),
  language: z.string().max(20).optional().nullable(),
  title: z.string().max(300).optional().nullable(),
  sensitive: z.boolean().optional().default(false),
  sortOrder: z.number().int().min(0).optional().default(0),
});

export const updateEventFileSchema = z.object({
  title: z.string().max(300).optional().nullable(),
  sensitive: z.boolean().optional(),
  sortOrder: z.number().int().min(0).optional(),
  language: z.string().max(20).optional().nullable(),
  fileType: eventFileTypeSchema.optional(),
});

// Persist a transcripts row from the admin (fixes the persistence gap).
export const createTranscriptSchema = z.object({
  eventId: z.number().int(),
  language: z.string().min(1).max(20),
  s3Key: z.string().min(1).max(1000),
  originalFilename: z.string().max(500).optional().nullable(),
  fileSizeBytes: z.number().int().min(0).optional().nullable(),
  pageCount: z.number().int().min(0).optional().nullable(),
  status: z.string().max(20).optional().default("published"),
});

export const updateTranscriptSchema = z.object({
  language: z.string().min(1).max(20).optional(),
  status: z.string().max(20).optional(),
});
```

- [ ] **Step 5: Run the test — expect pass**

Run: `sh -c 'cd /Users/jeremy/Documents/Programming/padmakara-backend-frontend/padmakara-api && bunx vitest run tests/services/event-file-s3.test.ts'`
Expected: PASS (5 tests).

- [ ] **Step 6: Commit**

```bash
git -C padmakara-api add src/lib/schemas.ts src/services/s3.ts tests/services/event-file-s3.test.ts
git -C padmakara-api commit -m "feat(api): event-file schemas + S3 key builder

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: `POST /api/admin/upload/presign-file`

**Files:**
- Modify: `src/routes/admin/upload.ts`
- Test: `tests/routes/admin/presign-file.test.ts` (new)

**Interfaces:**
- Consumes: `presignFileSchema`, `buildEventFileS3Key`, `generatePresignedUploadUrl`.
- Produces: `POST /api/admin/upload/presign-file` → `{ s3Key, uploadUrl }`.

- [ ] **Step 1: Write the failing test**

Create `tests/routes/admin/presign-file.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import { testJson } from "../../helpers.ts";

vi.mock("../../../src/services/s3.ts", async (orig) => ({
  ...(await orig<typeof import("../../../src/services/s3.ts")>()),
  generatePresignedUploadUrl: vi.fn(() => Promise.resolve("https://s3/put-url")),
}));

import { createAccessToken } from "../../../src/services/auth.ts";

async function adminToken() {
  return createAccessToken({ sub: 1, email: "admin@test.com", role: "admin" });
}

describe("POST /api/admin/upload/presign-file", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns a deterministic s3Key + uploadUrl", async () => {
    const token = await adminToken();
    const { status, body } = await testJson("/api/admin/upload/presign-file", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        eventCode: "EVT-01",
        filename: "notes.pdf",
        contentType: "application/pdf",
        fileType: "document",
      }),
    });
    expect(status).toBe(200);
    expect(body.s3Key).toBe("events/EVT-01/document/notes.pdf");
    expect(body.uploadUrl).toBe("https://s3/put-url");
  });

  it("returns 400 on invalid body", async () => {
    const token = await adminToken();
    const { status } = await testJson("/api/admin/upload/presign-file", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ eventCode: "EVT-01" }),
    });
    expect(status).toBe(400);
  });

  it("returns 401 without auth", async () => {
    const { status } = await testJson("/api/admin/upload/presign-file", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ eventCode: "E", filename: "a.pdf", contentType: "application/pdf", fileType: "document" }),
    });
    expect(status).toBe(401);
  });
});
```

- [ ] **Step 2: Run — expect failure** (`sh -c '... bunx vitest run tests/routes/admin/presign-file.test.ts'`). Expected: 404/failure because the route doesn't exist.

- [ ] **Step 3: Implement the route**

In `src/routes/admin/upload.ts`, add `presignFileSchema` + `buildEventFileS3Key` to the imports, then add after the `presign-transcript` handler:

```typescript
/**
 * POST /api/admin/upload/presign-file — presigned PUT for a generic document.
 */
uploadRoutes.post("/presign-file", async (c) => {
  const parsed = presignFileSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    throw AppError.badRequest("Invalid request body", "VALIDATION_ERROR");
  }
  const { eventCode, filename, contentType, fileType } = parsed.data;
  const s3Key = buildEventFileS3Key(eventCode, fileType, filename);
  const uploadUrl = await generatePresignedUploadUrl(s3Key, contentType);
  return c.json({ s3Key, uploadUrl });
});
```

Update the import line:
```typescript
import { generatePresignedUploadUrl, buildTrackS3Key, buildTranscriptS3Key, buildEventFileS3Key } from "../../services/s3.ts";
import { presignUploadSchema, presignTranscriptSchema, presignFileSchema, aiAssistSchema } from "../../lib/schemas.ts";
```

- [ ] **Step 4: Run — expect pass** (same command). Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git -C padmakara-api add src/routes/admin/upload.ts tests/routes/admin/presign-file.test.ts
git -C padmakara-api commit -m "feat(api): presign-file upload endpoint for documents

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: `event-files` admin resource

**Files:**
- Create: `src/routes/admin/event-files.ts`
- Modify: `src/routes/admin/index.ts` (mount)
- Test: `tests/routes/admin/event-files.test.ts` (new)

**Interfaces:**
- Consumes: `createEventFileSchema`, `updateEventFileSchema`, `deleteObject`, admin `helpers.ts`.
- Produces: `GET/POST /api/admin/event-files`, `GET/PATCH/DELETE /api/admin/event-files/:id`. `GET /` accepts `?eventId=` and orders by `sortOrder, id`. DELETE also best-effort deletes the S3 object.

> **Convention note:** the custom admin data provider issues **PATCH** for updates (see `videos.ts`). Use `.patch("/:id")`, matching `videos.ts` exactly.

- [ ] **Step 1: Write the failing test** — create `tests/routes/admin/event-files.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import { testJson } from "../../helpers.ts";

vi.mock("../../../src/db/index.ts", () => {
  const mockReturning = vi.fn();
  const mockWhere = vi.fn(() => ({ returning: mockReturning }));
  const mockValues = vi.fn(() => ({ returning: mockReturning }));
  const mockInsert = vi.fn(() => ({ values: mockValues }));
  const mockSet = vi.fn(() => ({ where: mockWhere }));
  const mockUpdate = vi.fn(() => ({ set: mockSet }));
  const mockDelete = vi.fn(() => ({ where: mockWhere }));
  return {
    db: {
      insert: mockInsert,
      update: mockUpdate,
      delete: mockDelete,
      query: { eventFiles: { findFirst: vi.fn(() => Promise.resolve(null)) } },
      _returning: mockReturning,
    },
  };
});

vi.mock("../../../src/services/s3.ts", () => ({
  deleteObject: vi.fn(() => Promise.resolve()),
}));

vi.mock("../../../src/services/sync-versions.ts", () => ({
  bumpVersion: vi.fn(() => Promise.resolve()),
}));

import { db } from "../../../src/db/index.ts";
import { deleteObject } from "../../../src/services/s3.ts";
import { createAccessToken } from "../../../src/services/auth.ts";

const mockReturning = (db as any)._returning as ReturnType<typeof vi.fn>;
const mockDeleteObject = deleteObject as ReturnType<typeof vi.fn>;
const adminToken = () => createAccessToken({ sub: 1, email: "a@test.com", role: "admin" });

describe("event-files admin resource", () => {
  beforeEach(() => vi.clearAllMocks());

  it("creates a row (201)", async () => {
    mockReturning.mockResolvedValueOnce([{ id: 7, eventId: 3, originalFilename: "n.pdf" }]);
    const token = await adminToken();
    const { status, body } = await testJson("/api/admin/event-files", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        eventId: 3, originalFilename: "n.pdf", s3Key: "events/E/document/n.pdf",
        fileType: "document", extension: "pdf",
      }),
    });
    expect(status).toBe(201);
    expect(body).toMatchObject({ id: 7, eventId: 3 });
  });

  it("deletes the row and the S3 object", async () => {
    mockReturning.mockResolvedValueOnce([{ id: 7, eventId: 3, s3Key: "events/E/document/n.pdf" }]);
    const token = await adminToken();
    const { status } = await testJson("/api/admin/event-files/7", {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(status).toBe(200);
    expect(mockDeleteObject).toHaveBeenCalledWith("events/E/document/n.pdf");
  });

  it("returns 404 deleting a missing row", async () => {
    mockReturning.mockResolvedValueOnce([]);
    const token = await adminToken();
    const { status } = await testJson("/api/admin/event-files/999", {
      method: "DELETE", headers: { Authorization: `Bearer ${token}` },
    });
    expect(status).toBe(404);
  });

  it("rejects non-admins (403)", async () => {
    const token = await createAccessToken({ sub: 2, email: "u@test.com", role: "user" });
    const { status } = await testJson("/api/admin/event-files", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ eventId: 3, originalFilename: "n.pdf", s3Key: "x", fileType: "document", extension: "pdf" }),
    });
    expect(status).toBe(403);
  });
});
```

- [ ] **Step 2: Run — expect failure** (`... bunx vitest run tests/routes/admin/event-files.test.ts`).

- [ ] **Step 3: Implement the resource** — create `src/routes/admin/event-files.ts`:

```typescript
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { db } from "../../db/index.ts";
import { eventFiles } from "../../db/schema/event-files.ts";
import { events } from "../../db/schema/retreats.ts";
import { createEventFileSchema, updateEventFileSchema } from "../../lib/schemas.ts";
import { AppError } from "../../lib/errors.ts";
import { parsePagination, listResponse, countRows } from "./helpers.ts";
import { deleteObject } from "../../services/s3.ts";
import { bumpVersion } from "../../services/sync-versions.ts";

const eventFileRoutes = new Hono();

async function touchParentEvent(eventId: number) {
  await db.update(events).set({ updatedAt: new Date() }).where(eq(events.id, eventId));
  bumpVersion("events").catch((err) =>
    console.error("[sync] failed to bump events version:", err),
  );
}

eventFileRoutes.get("/", async (c) => {
  const { limit, offset } = parsePagination(c);
  const eventId = c.req.query("eventId");
  const where = eventId ? eq(eventFiles.eventId, parseInt(eventId, 10)) : undefined;
  const [data, total] = await Promise.all([
    db.query.eventFiles.findMany({
      where,
      orderBy: (f, { asc }) => [asc(f.sortOrder), asc(f.id)],
      limit,
      offset,
    }),
    countRows(eventFiles, where),
  ]);
  return listResponse(c, data, total, offset, offset + limit, "event-files");
});

eventFileRoutes.get("/:id", async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  const file = await db.query.eventFiles.findFirst({ where: eq(eventFiles.id, id) });
  if (!file) throw AppError.notFound("Event file not found");
  return c.json(file);
});

eventFileRoutes.post("/", async (c) => {
  const data = createEventFileSchema.parse(await c.req.json());
  const [file] = await db.insert(eventFiles).values(data).returning();
  await touchParentEvent(file!.eventId);
  return c.json(file!, 201);
});

eventFileRoutes.patch("/:id", async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  const parsed = updateEventFileSchema.parse(await c.req.json());
  const patch: Record<string, unknown> = { updatedAt: new Date() };
  for (const [k, v] of Object.entries(parsed)) if (v !== undefined) patch[k] = v;
  const [file] = await db.update(eventFiles).set(patch).where(eq(eventFiles.id, id)).returning();
  if (!file) throw AppError.notFound("Event file not found");
  await touchParentEvent(file.eventId);
  return c.json(file);
});

eventFileRoutes.delete("/:id", async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  const [file] = await db.delete(eventFiles).where(eq(eventFiles.id, id)).returning();
  if (!file) throw AppError.notFound("Event file not found");
  if (file.s3Key) {
    deleteObject(file.s3Key).catch((err) =>
      console.error(`Failed to delete S3 object ${file.s3Key}:`, err),
    );
  }
  await touchParentEvent(file.eventId);
  return c.json(file);
});

export { eventFileRoutes };
```

- [ ] **Step 4: Mount it** — in `src/routes/admin/index.ts`, import and mount (place near `videos`):

```typescript
import { eventFileRoutes } from "./event-files.ts";
```
```typescript
admin.route("/event-files", eventFileRoutes);
```

- [ ] **Step 5: Run — expect pass** (same command). Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
git -C padmakara-api add src/routes/admin/event-files.ts src/routes/admin/index.ts tests/routes/admin/event-files.test.ts
git -C padmakara-api commit -m "feat(api): event-files admin resource (CRUD + S3 cleanup)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: `transcripts` admin resource (fix persistence)

**Files:**
- Create: `src/routes/admin/transcripts.ts`
- Modify: `src/routes/admin/index.ts` (mount)
- Test: `tests/routes/admin/transcripts.test.ts` (new)

**Interfaces:**
- Consumes: `createTranscriptSchema`, `updateTranscriptSchema`, `deleteObject`.
- Produces: `GET/POST /api/admin/transcripts`, `PATCH/DELETE /api/admin/transcripts/:id`. POST inserts a row (regression fix for the persistence gap). DELETE best-effort deletes the S3 object.

- [ ] **Step 1: Write the failing test** — create `tests/routes/admin/transcripts.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import { testJson } from "../../helpers.ts";

vi.mock("../../../src/db/index.ts", () => {
  const mockReturning = vi.fn();
  const mockWhere = vi.fn(() => ({ returning: mockReturning }));
  const mockValues = vi.fn(() => ({ returning: mockReturning }));
  const mockInsert = vi.fn(() => ({ values: mockValues }));
  const mockSet = vi.fn(() => ({ where: mockWhere }));
  const mockUpdate = vi.fn(() => ({ set: mockSet }));
  const mockDelete = vi.fn(() => ({ where: mockWhere }));
  return {
    db: {
      insert: mockInsert, update: mockUpdate, delete: mockDelete,
      query: { transcripts: { findFirst: vi.fn(() => Promise.resolve(null)) } },
      _returning: mockReturning, _values: mockValues,
    },
  };
});
vi.mock("../../../src/services/s3.ts", () => ({ deleteObject: vi.fn(() => Promise.resolve()) }));
vi.mock("../../../src/services/sync-versions.ts", () => ({ bumpVersion: vi.fn(() => Promise.resolve()) }));

import { db } from "../../../src/db/index.ts";
import { deleteObject } from "../../../src/services/s3.ts";
import { createAccessToken } from "../../../src/services/auth.ts";

const mockReturning = (db as any)._returning as ReturnType<typeof vi.fn>;
const mockValues = (db as any)._values as ReturnType<typeof vi.fn>;
const mockDeleteObject = deleteObject as ReturnType<typeof vi.fn>;
const adminToken = () => createAccessToken({ sub: 1, email: "a@test.com", role: "admin" });

describe("transcripts admin resource", () => {
  beforeEach(() => vi.clearAllMocks());

  it("persists a transcript row with default status=published", async () => {
    mockReturning.mockResolvedValueOnce([{ id: 11, eventId: 3, language: "en" }]);
    const token = await adminToken();
    const { status, body } = await testJson("/api/admin/transcripts", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ eventId: 3, language: "en", s3Key: "events/E/transcripts/t.pdf" }),
    });
    expect(status).toBe(201);
    expect(body).toMatchObject({ id: 11, eventId: 3 });
    expect(mockValues).toHaveBeenCalledWith(expect.objectContaining({ status: "published" }));
  });

  it("deletes the row and S3 object", async () => {
    mockReturning.mockResolvedValueOnce([{ id: 11, eventId: 3, s3Key: "events/E/transcripts/t.pdf" }]);
    const token = await adminToken();
    const { status } = await testJson("/api/admin/transcripts/11", {
      method: "DELETE", headers: { Authorization: `Bearer ${token}` },
    });
    expect(status).toBe(200);
    expect(mockDeleteObject).toHaveBeenCalledWith("events/E/transcripts/t.pdf");
  });

  it("rejects non-admins", async () => {
    const token = await createAccessToken({ sub: 2, email: "u@test.com", role: "user" });
    const { status } = await testJson("/api/admin/transcripts", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ eventId: 3, language: "en", s3Key: "x" }),
    });
    expect(status).toBe(403);
  });
});
```

- [ ] **Step 2: Run — expect failure.**

- [ ] **Step 3: Implement** — create `src/routes/admin/transcripts.ts`:

```typescript
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { db } from "../../db/index.ts";
import { transcripts } from "../../db/schema/transcripts.ts";
import { events } from "../../db/schema/retreats.ts";
import { createTranscriptSchema, updateTranscriptSchema } from "../../lib/schemas.ts";
import { AppError } from "../../lib/errors.ts";
import { parsePagination, listResponse, countRows } from "./helpers.ts";
import { deleteObject } from "../../services/s3.ts";
import { bumpVersion } from "../../services/sync-versions.ts";

const transcriptRoutes = new Hono();

async function touchParentEvent(eventId: number) {
  await db.update(events).set({ updatedAt: new Date() }).where(eq(events.id, eventId));
  bumpVersion("events").catch((err) =>
    console.error("[sync] failed to bump events version:", err),
  );
}

transcriptRoutes.get("/", async (c) => {
  const { limit, offset } = parsePagination(c);
  const eventId = c.req.query("eventId");
  const where = eventId ? eq(transcripts.eventId, parseInt(eventId, 10)) : undefined;
  const [data, total] = await Promise.all([
    db.query.transcripts.findMany({
      where,
      orderBy: (t, { asc }) => [asc(t.id)],
      limit,
      offset,
    }),
    countRows(transcripts, where),
  ]);
  return listResponse(c, data, total, offset, offset + limit, "transcripts");
});

transcriptRoutes.post("/", async (c) => {
  const data = createTranscriptSchema.parse(await c.req.json());
  const [row] = await db.insert(transcripts).values(data).returning();
  await touchParentEvent(row!.eventId);
  return c.json(row!, 201);
});

transcriptRoutes.patch("/:id", async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  const parsed = updateTranscriptSchema.parse(await c.req.json());
  const patch: Record<string, unknown> = { updatedAt: new Date() };
  for (const [k, v] of Object.entries(parsed)) if (v !== undefined) patch[k] = v;
  const [row] = await db.update(transcripts).set(patch).where(eq(transcripts.id, id)).returning();
  if (!row) throw AppError.notFound("Transcript not found");
  await touchParentEvent(row.eventId);
  return c.json(row);
});

transcriptRoutes.delete("/:id", async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  const [row] = await db.delete(transcripts).where(eq(transcripts.id, id)).returning();
  if (!row) throw AppError.notFound("Transcript not found");
  if (row.s3Key) {
    deleteObject(row.s3Key).catch((err) =>
      console.error(`Failed to delete S3 object ${row.s3Key}:`, err),
    );
  }
  await touchParentEvent(row.eventId);
  return c.json(row);
});

export { transcriptRoutes };
```

- [ ] **Step 4: Mount** — in `src/routes/admin/index.ts`:
```typescript
import { transcriptRoutes } from "./transcripts.ts";
```
```typescript
admin.route("/transcripts", transcriptRoutes);
```

- [ ] **Step 5: Run — expect pass** (3 tests).

- [ ] **Step 6: Commit**

```bash
git -C padmakara-api add src/routes/admin/transcripts.ts src/routes/admin/index.ts tests/routes/admin/transcripts.test.ts
git -C padmakara-api commit -m "feat(api): transcripts admin resource — persist rows on upload

Fixes the gap where admin transcript uploads never created a DB row.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Content-presence flags on the admin event list

**Files:**
- Modify: `src/routes/admin/events.ts` (the `GET /` list handler)
- Test: `tests/routes/admin/events-content-flags.test.ts` (new)

**Interfaces:**
- Produces: each row in `GET /api/admin/events` gains `hasVideo: boolean`, `hasAudio: boolean`, `hasDocuments: boolean`. `hasDocuments` = has a transcript OR has an `event_files` row with `fileType IN ('document','image','other')`.

- [ ] **Step 1: Read the current handler.** Open `src/routes/admin/events.ts` and locate the `GET /` handler (~lines 33–124): it fetches `data` via `db.query.events.findMany({...})`, computes `total`, then returns via `listResponse`. You will insert the enrichment between fetching `data` and the response.

- [ ] **Step 2: Write the failing test** — create `tests/routes/admin/events-content-flags.test.ts`. Mock `db` so `query.events.findMany` returns two events and the four content-existence selects return presence for event 1 only:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import { testJson } from "../../helpers.ts";

const eventsPage = [
  { id: 1, eventCode: "E1", eventTeachers: [], eventRetreatGroups: [], eventPlaces: [], eventPublications: [] },
  { id: 2, eventCode: "E2", eventTeachers: [], eventRetreatGroups: [], eventPlaces: [], eventPublications: [] },
];

vi.mock("../../../src/db/index.ts", () => {
  // db.select(...).from(...).innerJoin?(...).where(...).groupBy(...) → rows
  const makeChain = (rows: any[]) => {
    const chain: any = {};
    chain.from = () => chain;
    chain.innerJoin = () => chain;
    chain.where = () => chain;
    chain.groupBy = () => Promise.resolve(rows);
    return chain;
  };
  // Return presence for event 1 across all four selects.
  const selectImpl = vi.fn(() => makeChain([{ id: 1 }]));
  return {
    db: {
      query: {
        events: {
          findMany: vi.fn(() => Promise.resolve(eventsPage)),
        },
      },
      select: selectImpl,
    },
  };
});

// countRows uses db.select().from().where() → make it resolve a count too.
// (The generic select mock above returns a chain; countRows awaits the array's [0].)

import { createAccessToken } from "../../../src/services/auth.ts";
const adminToken = () => createAccessToken({ sub: 1, email: "a@test.com", role: "admin" });

describe("GET /api/admin/events content flags", () => {
  beforeEach(() => vi.clearAllMocks());

  it("sets hasVideo/hasAudio/hasDocuments per event", async () => {
    const token = await adminToken();
    const { status, body } = await testJson("/api/admin/events", {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(status).toBe(200);
    const e1 = body.find((e: any) => e.id === 1);
    const e2 = body.find((e: any) => e.id === 2);
    expect(e1).toMatchObject({ hasVideo: true, hasAudio: true, hasDocuments: true });
    expect(e2).toMatchObject({ hasVideo: false, hasAudio: false, hasDocuments: false });
  });
});
```

> **Note for the implementer:** the exact `db` mock shape must match how `countRows` (in `helpers.ts`) and the enrichment queries chain. `countRows` does `db.select({count}).from(table).where(where)` and awaits `[0]`. If the shared mock above makes `.where()` return the chain (thenable via groupBy only), adjust so `countRows`'s `await` resolves to `[{ count: 2 }]`. Prefer giving the mock's `.where()` a `then`/array resolution, or special-case by inspecting `.from` argument. Keep the test green by shaping the mock; do not weaken the assertions.

- [ ] **Step 3: Run — expect failure** (flags undefined).

- [ ] **Step 4: Implement the enrichment.** At the top of `src/routes/admin/events.ts`, ensure these imports exist:

```typescript
import { and, eq, inArray } from "drizzle-orm";
import { eventVideos } from "../../db/schema/event-videos.ts";
import { sessions } from "../../db/schema/sessions.ts";
import { tracks } from "../../db/schema/tracks.ts";
import { transcripts } from "../../db/schema/transcripts.ts";
import { eventFiles } from "../../db/schema/event-files.ts";
```

Between the `data` fetch and the `listResponse(...)` return in `GET /`, insert:

```typescript
  // Content-presence flags for the list icons (cheap grouped existence scans).
  const ids = data.map((e: { id: number }) => e.id);
  const hasVideo = new Set<number>();
  const hasAudio = new Set<number>();
  const hasDocs = new Set<number>();
  if (ids.length) {
    const [vids, auds, trs, files] = await Promise.all([
      db.select({ id: eventVideos.eventId }).from(eventVideos)
        .where(inArray(eventVideos.eventId, ids)).groupBy(eventVideos.eventId),
      db.select({ id: sessions.eventId }).from(tracks)
        .innerJoin(sessions, eq(tracks.sessionId, sessions.id))
        .where(inArray(sessions.eventId, ids)).groupBy(sessions.eventId),
      db.select({ id: transcripts.eventId }).from(transcripts)
        .where(inArray(transcripts.eventId, ids)).groupBy(transcripts.eventId),
      db.select({ id: eventFiles.eventId }).from(eventFiles)
        .where(and(
          inArray(eventFiles.eventId, ids),
          inArray(eventFiles.fileType, ["document", "image", "other"]),
        )).groupBy(eventFiles.eventId),
    ]);
    vids.forEach((r) => hasVideo.add(r.id));
    auds.forEach((r) => hasAudio.add(r.id));
    trs.forEach((r) => hasDocs.add(r.id));
    files.forEach((r) => hasDocs.add(r.id));
  }
  const enriched = data.map((e: { id: number }) => ({
    ...e,
    hasVideo: hasVideo.has(e.id),
    hasAudio: hasAudio.has(e.id),
    hasDocuments: hasDocs.has(e.id),
  }));
```

Then return `enriched` instead of `data` in the `listResponse(...)` call.

- [ ] **Step 5: Run — expect pass.**

- [ ] **Step 6: Commit**

```bash
git -C padmakara-api add src/routes/admin/events.ts tests/routes/admin/events-content-flags.test.ts
git -C padmakara-api commit -m "feat(api): hasVideo/hasAudio/hasDocuments flags on admin event list

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: Serve generic file bytes — `GET /api/media/file/:id`

**Files:**
- Modify: `src/routes/media.ts`
- Test: `tests/routes/media-file.test.ts` (new)

**Interfaces:**
- Consumes: `getOptionalUser`, `getUserForAccess`, `checkEventAccess`, `denialToHttpError`, `generatePresignedDownloadUrl`, `generatePresignedAttachmentUrl`.
- Produces: `watermarkPdf(bytes: Uint8Array, text: string): Promise<Uint8Array>` (extracted helper) and `GET /api/media/file/:id` (auth required; sensitive PDFs streamed watermarked; everything else 302-redirects to a presigned S3 URL; `?download=true` → attachment).

- [ ] **Step 1: Write the failing test** — create `tests/routes/media-file.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import { testJson } from "../helpers.ts";

const findFirst = vi.fn();

vi.mock("../../src/db/index.ts", () => ({
  db: { query: {
    eventFiles: { findFirst: (...a: any[]) => findFirst(...a) },
    users: { findFirst: vi.fn(() => Promise.resolve({ id: 1, firstName: "Ann", lastName: "Lee" })) },
  } },
}));

vi.mock("../../src/services/access.ts", () => ({
  checkEventAccess: vi.fn(() => Promise.resolve({ allowed: true })),
  denialToHttpError: vi.fn(() => { throw new Error("denied"); }),
}));

vi.mock("../../src/services/s3.ts", () => ({
  generatePresignedDownloadUrl: vi.fn(() => Promise.resolve("https://s3/get")),
  generatePresignedAttachmentUrl: vi.fn(() => Promise.resolve("https://s3/get?attach")),
  getObjectText: vi.fn(),
}));

import { createAccessToken } from "../../src/services/auth.ts";
const userToken = () => createAccessToken({ sub: 1, email: "u@test.com", role: "user" });

describe("GET /api/media/file/:id", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("401 without auth", async () => {
    findFirst.mockResolvedValueOnce({ id: 5, eventId: 3, extension: "png", sensitive: false, s3Key: "k", originalFilename: "p.png", event: { id: 3, audience: null } });
    const { status } = await testJson("/api/media/file/5");
    expect(status).toBe(401);
  });

  it("redirects a non-sensitive image to a presigned URL", async () => {
    findFirst.mockResolvedValueOnce({ id: 5, eventId: 3, extension: "png", sensitive: false, s3Key: "events/E/image/p.png", originalFilename: "p.png", event: { id: 3, audience: null } });
    const token = await userToken();
    const res = await fetch("http://x"); // placeholder to keep types happy — replaced below
    // Use testJson's underlying app via redirect check:
    const { status, headers } = await testJson("/api/media/file/5", {
      headers: { Authorization: `Bearer ${token}` }, redirect: "manual",
    } as any);
    expect([301, 302]).toContain(status);
  });

  it("404 for a missing file", async () => {
    findFirst.mockResolvedValueOnce(null);
    const token = await userToken();
    const { status } = await testJson("/api/media/file/999", { headers: { Authorization: `Bearer ${token}` } });
    expect(status).toBe(404);
  });
});
```

> **Note:** if `testJson` auto-follows redirects, assert on the resolved S3 response or add a `redirect: "manual"` passthrough. The implementer should confirm `testJson`'s options in `tests/helpers.ts` and adjust the redirect assertion accordingly (the behaviour under test is "non-sensitive files do not stream through the API"). Keep the 401 and 404 assertions intact.

- [ ] **Step 2: Run — expect failure.**

- [ ] **Step 3: Refactor the watermark into a helper.** In `src/routes/media.ts`, add near the top helpers:

```typescript
async function watermarkPdf(originalPdfBytes: Uint8Array, watermarkText: string): Promise<Uint8Array> {
  const pdfDoc = await PDFDocument.load(originalPdfBytes);
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const fontSize = 9;
  const textWidth = font.widthOfTextAtSize(watermarkText, fontSize);
  for (const page of pdfDoc.getPages()) {
    const { width } = page.getSize();
    page.drawText(watermarkText, {
      x: (width - textWidth) / 2,
      y: 20,
      size: fontSize,
      font,
      color: rgb(0.75, 0.75, 0.75),
      opacity: 0.5,
    });
  }
  return await pdfDoc.save();
}
```

Then in the existing `/transcript/:transcriptId` handler, replace the inline `PDFDocument.load(...)` … `pdfDoc.save()` block (lines ~436–453) with:
```typescript
  const watermarkedPdfBytes = await watermarkPdf(originalPdfBytes, watermarkText);
```

- [ ] **Step 4: Add the file route.** Add the `eventFiles` import and `generatePresignedAttachmentUrl` to the s3 import, then a `getEventForFile` helper and the route:

```typescript
import { eventFiles } from "../db/schema/event-files.ts";
import { generatePresignedDownloadUrl, generatePresignedAttachmentUrl, getObjectText } from "../services/s3.ts";
```
```typescript
async function getEventForFile(fileId: number) {
  const file = await db.query.eventFiles.findFirst({
    where: eq(eventFiles.id, fileId),
    with: { event: { with: { audience: true } } },
  });
  if (!file) return null;
  return { file, event: file.event ?? null };
}

const FILE_CONTENT_TYPES: Record<string, string> = {
  pdf: "application/pdf",
  jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif",
  webp: "image/webp", heic: "image/heic", heif: "image/heif", bmp: "image/bmp", svg: "image/svg+xml",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

/**
 * GET /api/media/file/:id — serve a generic event document.
 * Requires auth (same event access check as transcripts). Sensitive PDFs are
 * watermarked per-user and streamed; everything else redirects to a short-lived
 * presigned S3 URL. ?download=true forces attachment disposition.
 */
mediaRoutes.get("/file/:id", async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  const authUser = getOptionalUser(c);
  if (!authUser) throw AppError.unauthorized("Authentication required to view files");

  const result = await getEventForFile(id);
  if (!result?.file) throw AppError.notFound("File not found");

  if (result.event) {
    const userForAccess = await getUserForAccess(authUser);
    const accessResult = await checkEventAccess(userForAccess, result.event);
    if (!accessResult.allowed) denialToHttpError(accessResult.reason);
  }

  const ext = (result.file.extension || "").replace(/^\./, "").toLowerCase();
  const isPdf = ext === "pdf";
  const isDownload = c.req.query("download") === "true";
  const rawFilename = result.file.originalFilename;
  const asciiFilename = rawFilename.replace(/[^\x20-\x7E]/g, "_").replace(/"/g, "'");
  const utf8Filename = encodeURIComponent(rawFilename);

  // Sensitive PDFs → per-user watermark (same treatment as transcripts).
  if (isPdf && result.file.sensitive) {
    const fullUser = await db.query.users.findFirst({ where: eq(users.id, authUser.id) });
    const userName = fullUser
      ? [fullUser.firstName, fullUser.lastName].filter(Boolean).join(" ") || authUser.email
      : authUser.email;
    const presignedUrl = await generatePresignedDownloadUrl(result.file.s3Key);
    const pdfResponse = await fetch(presignedUrl);
    if (!pdfResponse.ok) throw AppError.internal("Failed to fetch file from storage");
    const bytes = await watermarkPdf(
      new Uint8Array(await pdfResponse.arrayBuffer()),
      `${userName} — ${authUser.email}`,
    );
    const disposition = isDownload ? "attachment" : "inline";
    return new Response(bytes, {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `${disposition}; filename="${asciiFilename}"; filename*=UTF-8''${utf8Filename}`,
        "Content-Length": String(bytes.byteLength),
      },
    });
  }

  // Everything else → redirect to a presigned S3 URL (offloads bytes to S3).
  const url = isDownload
    ? await generatePresignedAttachmentUrl(result.file.s3Key, rawFilename)
    : await generatePresignedDownloadUrl(result.file.s3Key);
  return c.redirect(url, 302);
});
```

- [ ] **Step 5: Run — expect pass** (401 / redirect / 404). Also run the existing media test to confirm no regression: `... bunx vitest run tests/routes/media.test.ts`.

- [ ] **Step 6: Commit**

```bash
git -C padmakara-api add src/routes/media.ts tests/routes/media-file.test.ts
git -C padmakara-api commit -m "feat(api): serve event documents via /media/file/:id (watermark sensitive PDFs)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: Include visible `eventFiles` in the event detail payload

**Files:**
- Modify: `src/routes/events.ts` (the `eventWithSessions` `with` clause, ~line 82)
- Test: `tests/routes/events.test.ts` (extend, or add `tests/routes/events-documents.test.ts`)

**Interfaces:**
- Produces: event detail responses (`/api/events/:id`, `/api/events/public/:id`, etc.) include `eventFiles: [...]` limited to `fileType IN ('document','image','other')`, ordered by `sortOrder, id`, alongside the existing `transcripts`.

- [ ] **Step 1: Read `src/routes/events.ts`** and find `eventWithSessions` — the shared object passed as `with` to `db.query.events.findMany`/`findFirst`. It already contains `transcripts: true` and `videos: true`.

- [ ] **Step 2: Add the `eventFiles` relation to the clause:**

```typescript
    eventFiles: {
      where: (f, { inArray }) => inArray(f.fileType, ["document", "image", "other"]),
      orderBy: (f, { asc }) => [asc(f.sortOrder), asc(f.id)],
    },
```

(Drizzle relational `with` supports a nested config with `where`/`orderBy`. This relies on the `events → eventFiles` relation added in Task 1 Step 2.)

- [ ] **Step 3: Write/extend a test** asserting the payload carries `eventFiles`. In `tests/routes/events-documents.test.ts` (new), mock `db.query.events.findFirst` to return an event whose `eventFiles` is a two-item array and assert the endpoint echoes it. Mirror the existing `tests/routes/events.test.ts` mock setup (read it first for the exact `db` mock shape and route path used there):

```typescript
// Follow tests/routes/events.test.ts's db-mock + auth setup exactly.
// Return an event with eventFiles: [{ id: 1, fileType: "document", ... }] and
// assert response body.eventFiles has length 1 and the expected id.
```

- [ ] **Step 4: Run — expect pass.** Also run `tests/routes/events.test.ts` for no regression.

- [ ] **Step 5: Commit**

```bash
git -C padmakara-api add src/routes/events.ts tests/routes/events-documents.test.ts
git -C padmakara-api commit -m "feat(api): embed visible event documents in event detail payload

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 9: Backend gate — full suite + typecheck

**Files:** none (verification task).

- [ ] **Step 1: Typecheck** — `sh -c 'cd /Users/jeremy/Documents/Programming/padmakara-backend-frontend/padmakara-api && bun run typecheck'`. Expected: clean.
- [ ] **Step 2: Full test suite** — `sh -c 'cd /Users/jeremy/Documents/Programming/padmakara-backend-frontend/padmakara-api && bunx vitest run'`. Expected: all pass except the 6 known-pre-existing `payment.test.ts` env failures (do NOT try to fix those — see project memory). If any NEW test fails, stop and investigate (systematic-debugging).
- [ ] **Step 3:** No commit (nothing changed). Report results.

---

# PHASE 2 — Admin UI (padmakara-api/admin)

> These tasks touch React-admin components with no unit-test harness. Verification = `bunx tsc -b` (typecheck) + a described manual smoke check. Read each target file fully before editing (Rule: Read Before Touch).

### Task 10: Register resources + upload manager helpers

**Files:**
- Modify: `admin/src/App.tsx`
- Modify: `admin/src/utils/uploadManager.ts`

**Interfaces:**
- Produces:
  - React-admin resources `event-files` and `transcripts` registered (list-less; used programmatically by the data provider).
  - `presignFile(eventCode, filename, contentType, fileType): Promise<{ s3Key: string; uploadUrl: string }>`
  - `uploadFile(eventCode, file, fileType, onProgress?): Promise<{ s3Key: string }>`

- [ ] **Step 1: Read** `admin/src/App.tsx` and `admin/src/utils/uploadManager.ts` (note the existing `presignTranscript`/`uploadTranscript` shape and the `apiUrl`/auth-header helper they use).

- [ ] **Step 2: Register resources.** In `App.tsx`, add two list-less resources inside `<Admin>` (a resource with no props still enables `dataProvider` calls):

```tsx
<Resource name="event-files" />
<Resource name="transcripts" />
```

- [ ] **Step 3: Add `presignFile` + `uploadFile`** to `uploadManager.ts`, mirroring `presignTranscript`/`uploadTranscript` but posting to `/api/admin/upload/presign-file` with a `fileType` field. Reuse the same `XMLHttpRequest` PUT + progress code:

```typescript
export async function presignFile(
  eventCode: string,
  filename: string,
  contentType: string,
  fileType: string,
): Promise<{ s3Key: string; uploadUrl: string }> {
  // Same auth header + fetch pattern as presignTranscript, but body includes fileType
  // and the URL is `${API_URL}/admin/upload/presign-file`.
  // Return the parsed { s3Key, uploadUrl }.
}

export async function uploadFile(
  eventCode: string,
  file: File,
  fileType: string,
  onProgress?: (pct: number) => void,
): Promise<{ s3Key: string }> {
  const { s3Key, uploadUrl } = await presignFile(eventCode, file.name, file.type || "application/octet-stream", fileType);
  // Reuse the exact XHR PUT-with-progress block from uploadTranscript.
  return { s3Key };
}
```

- [ ] **Step 4: Typecheck** — `sh -c 'cd /Users/jeremy/Documents/Programming/padmakara-backend-frontend/padmakara-api/admin && bunx tsc -b'`. Expected: clean.

- [ ] **Step 5: Commit**

```bash
git -C padmakara-api add admin/src/App.tsx admin/src/utils/uploadManager.ts
git -C padmakara-api commit -m "feat(admin): register event-files/transcripts resources + file upload helpers

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 11: Documents section in the Event form + transcript persistence

**Files:**
- Modify: `admin/src/resources/events.tsx`
- (Possibly) Modify: `admin/src/components/EventFilesPreview.tsx`

**Interfaces:**
- Consumes: `presignFile`/`uploadFile`, `useDataProvider()` (`create('event-files', …)`, `getList('event-files', { filter: { eventId } })`, `update`, `delete`), `create('transcripts', …)`.
- Produces: a Documents drop-zone + list in both `EventCreate` and `EventEdit`; the transcript handlers now `create('transcripts', …)` after upload.

**Behaviour spec:**
- **Documents drop-zone:** accepts images, `.pdf`, `.doc/.docx`, `.xls/.xlsx`, `.ppt/.pptx`. Requires the event saved first (needs `eventCode`) — reuse the existing `transcript.saveFirst`-style guard. Per file: derive `fileType` (`image` if image ext, else `document`) + `extension`; `uploadFile(eventCode, file, fileType, onProgress)`; then `dataProvider.create('event-files', { data: { eventId, originalFilename: file.name, s3Key, fileType, extension, fileSizeBytes: file.size, title: null, sensitive: false, sortOrder: <next> } })`.
- **Documents list:** `getList('event-files', { pagination, sort: { field: 'sortOrder', order: 'ASC' }, filter: { eventId } })`. Each row: editable `title`, `sensitive` toggle (`update('event-files', { id, data: { sensitive } })`), reorder via `@dnd-kit/sortable` writing `sortOrder` (mirror how tracks/videos reorder — search the file for existing `@dnd-kit` usage and copy the pattern), delete (`dataProvider.delete('event-files', { id })`).
- **Transcript handlers:** in `handleTranscriptFilesDropped` and `handleEditTranscriptFilesDropped`, after the existing `uploadTranscript(...)` call, add `await dataProvider.create('transcripts', { data: { eventId, language, s3Key, originalFilename: file.name, fileSizeBytes: file.size } })` (default `status` is server-side). Keep the existing local-UI-state update for immediate feedback.

- [ ] **Step 1: Read** `admin/src/resources/events.tsx` around the transcript sections (`TranscriptDropZone` render in EventCreate ~2245 and EventEdit ~2365; handlers ~1932 and ~2765) and `EventFilesPreview.tsx`. Identify the existing `@dnd-kit` reorder pattern (used by tracks/videos) to copy for documents.

- [ ] **Step 2: Build `DocumentsSection`** (a component in `events.tsx` or a new `admin/src/components/DocumentsSection.tsx`) implementing the behaviour spec. Localize labels via the admin i18n (`useTranslate()` + keys under an `documents.*` admin namespace in `admin/src/i18n/*`).

- [ ] **Step 3: Render it** in both `EventCreate` and `EventEdit`, beside the Transcript section.

- [ ] **Step 4: Add transcript persistence** to both transcript drop handlers (the `create('transcripts', …)` call).

- [ ] **Step 5: Typecheck** — `... admin && bunx tsc -b`. Expected: clean.

- [ ] **Step 6: Manual smoke** (dev servers). Start API (`bun run dev`) + admin (`bun run dev:admin`). Open an event's edit page, drop a PDF and a JPG into Documents → both appear in the list; toggle `sensitive`; reorder; delete one. Drop a transcript → confirm a `transcripts` row now exists (check via `bun db:studio` or the app). Note: if you cannot run a full manual pass in this environment, at minimum confirm the build succeeds and describe the manual steps for the user to verify.

- [ ] **Step 7: Commit**

```bash
git -C padmakara-api add admin/src/resources/events.tsx admin/src/components/ admin/src/i18n/
git -C padmakara-api commit -m "feat(admin): Documents section on event form + persist transcript rows

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 12: Content-presence icons column on the event list

**Files:**
- Modify: `admin/src/resources/events.tsx` (`EventList` `<Datagrid>`)

**Interfaces:**
- Consumes: `record.hasVideo/hasAudio/hasDocuments` (from Task 6).

- [ ] **Step 1: Add a column.** In `EventList`'s `<Datagrid>`, add a `<FunctionField label="admin.content">` rendering three MUI icons, each shown only when its flag is true:

```tsx
import Videocam from "@mui/icons-material/Videocam";
import Audiotrack from "@mui/icons-material/Audiotrack";
import Description from "@mui/icons-material/Description";
import Tooltip from "@mui/material/Tooltip";
import Box from "@mui/material/Box";
```
```tsx
<FunctionField
  label="Content"
  render={(record: any) => (
    <Box sx={{ display: "flex", gap: 0.5, color: "text.secondary" }}>
      {record.hasVideo && <Tooltip title={translate("resources.events.content.video")}><Videocam fontSize="small" /></Tooltip>}
      {record.hasAudio && <Tooltip title={translate("resources.events.content.audio")}><Audiotrack fontSize="small" /></Tooltip>}
      {record.hasDocuments && <Tooltip title={translate("resources.events.content.documents")}><Description fontSize="small" /></Tooltip>}
    </Box>
  )}
/>
```

Add the three tooltip keys to `admin/src/i18n/en.*` and `pt.*`. (Use whatever `translate`/`useTranslate` access `EventList` already has; if none, import `useTranslate` at the top of the component.)

- [ ] **Step 2: Typecheck** — `... admin && bunx tsc -b`. Expected: clean.

- [ ] **Step 3: Manual smoke** — the event list shows icons only for events that have each content type. (Or confirm build + describe for user.)

- [ ] **Step 4: Commit**

```bash
git -C padmakara-api add admin/src/resources/events.tsx admin/src/i18n/
git -C padmakara-api commit -m "feat(admin): content-presence icons on event list

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 13: Magnifying-glass search icon

**Files:**
- Modify: `admin/src/resources/events.tsx` (line ~273 + imports)

- [ ] **Step 1: Swap the input.** Replace `<TextInput key="q" label="ra.action.search" source="q" alwaysOn />` with react-admin's `<SearchInput source="q" alwaysOn />` (it ships the magnifying-glass adornment + clear button). Update the import: add `SearchInput` to the `react-admin` import and remove `TextInput` only if it's now unused elsewhere in the file (check first — it's likely still used).

```tsx
<SearchInput key="q" source="q" alwaysOn />
```

- [ ] **Step 2: Typecheck** — `... admin && bunx tsc -b`. Expected: clean.

- [ ] **Step 3: Commit**

```bash
git -C padmakara-api add admin/src/resources/events.tsx
git -C padmakara-api commit -m "feat(admin): search icon on event-list search field

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

# PHASE 3 — App (padmakara-app)

### Task 14: Types + document merge helper + file URL

**Files:**
- Modify: `types/index.ts`
- Modify: `services/apiConfig.ts`
- Modify: `services/retreatService.ts`
- Test: `services/__tests__/documentMerge.test.ts` (new; place per the app's jest config — check for an existing `__tests__` dir first)

**Interfaces:**
- Produces:
  - Types: `EventFile = { id: number; title?: string|null; originalFilename: string; fileType: string; extension: string; language?: string|null; sensitive?: boolean; sortOrder?: number }`; event type gains `eventFiles?: EventFile[]`.
  - `EventDocument = { key: string; kind: 'transcript'|'file'; id: number; title: string; language?: string|null; extension: string; viewer: 'pdf'|'image'|'download'; featured: boolean }`.
  - `buildEventDocuments(event): EventDocument[]` — transcript(s) first (`featured: true`, `viewer: 'pdf'`), then `eventFiles` by `sortOrder`, `viewer` from extension.
  - `getFileUrl(fileId, opts): string` (mirrors `getTranscriptPdfUrl`).
  - `apiConfig.FILE_URL = (id) => \`/media/file/${id}\``.

- [ ] **Step 1: Write the failing test** — `services/__tests__/documentMerge.test.ts`:

```typescript
import { buildEventDocuments } from "../retreatService";

describe("buildEventDocuments", () => {
  it("pins the transcript first as a featured pdf", () => {
    const docs = buildEventDocuments({
      id: 9,
      transcripts: [{ id: 1, language: "en", originalFilename: "t.pdf" }],
      eventFiles: [
        { id: 5, title: "Slides", originalFilename: "s.pptx", extension: "pptx", fileType: "document", sortOrder: 1 },
        { id: 4, title: "Photo", originalFilename: "p.jpg", extension: "jpg", fileType: "image", sortOrder: 0 },
      ],
    } as any);
    expect(docs[0]).toMatchObject({ kind: "transcript", featured: true, viewer: "pdf" });
    // files after transcript, ordered by sortOrder
    expect(docs[1]).toMatchObject({ kind: "file", id: 4, viewer: "image" });
    expect(docs[2]).toMatchObject({ kind: "file", id: 5, viewer: "download" });
  });

  it("returns only files when there is no transcript", () => {
    const docs = buildEventDocuments({
      id: 9, transcripts: [],
      eventFiles: [{ id: 4, originalFilename: "p.jpg", extension: "jpg", fileType: "image", sortOrder: 0 }],
    } as any);
    expect(docs).toHaveLength(1);
    expect(docs[0]).toMatchObject({ kind: "file", viewer: "image" });
  });

  it("marks pdf files as pdf viewer", () => {
    const docs = buildEventDocuments({
      id: 9, transcripts: [],
      eventFiles: [{ id: 4, originalFilename: "n.pdf", extension: "pdf", fileType: "document", sortOrder: 0 }],
    } as any);
    expect(docs[0].viewer).toBe("pdf");
  });
});
```

- [ ] **Step 2: Run — expect failure** — `sh -c 'cd /Users/jeremy/Documents/Programming/padmakara-backend-frontend/padmakara-app && bunx jest services/__tests__/documentMerge.test.ts'`.

- [ ] **Step 3: Add types** to `types/index.ts` (`EventFile`, `EventDocument`, and `eventFiles?: EventFile[]` on the event type near the existing `transcripts?` field).

- [ ] **Step 4: Implement `buildEventDocuments` + `getFileUrl`** in `services/retreatService.ts`:

```typescript
const IMAGE_EXTS = new Set(["jpg", "jpeg", "png", "gif", "webp", "heic", "heif", "bmp", "svg"]);

function viewerForExt(ext: string): "pdf" | "image" | "download" {
  const e = (ext || "").replace(/^\./, "").toLowerCase();
  if (e === "pdf") return "pdf";
  if (IMAGE_EXTS.has(e)) return "image";
  return "download";
}

function cleanName(filename: string): string {
  return filename.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ").trim();
}

export function buildEventDocuments(event: any): EventDocument[] {
  const docs: EventDocument[] = [];
  for (const t of event.transcripts ?? []) {
    docs.push({
      key: `t-${t.id}`, kind: "transcript", id: t.id,
      title: cleanName(t.originalFilename || `Transcript`), language: t.language ?? null,
      extension: "pdf", viewer: "pdf", featured: true,
    });
  }
  const files = [...(event.eventFiles ?? [])].sort(
    (a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || a.id - b.id,
  );
  for (const f of files) {
    docs.push({
      key: `f-${f.id}`, kind: "file", id: f.id,
      title: f.title || cleanName(f.originalFilename), language: f.language ?? null,
      extension: (f.extension || "").replace(/^\./, "").toLowerCase(),
      viewer: viewerForExt(f.extension), featured: false,
    });
  }
  return docs;
}
```

`getFileUrl` mirrors the existing `getTranscriptPdfUrl` (web: `${API}/media/file/${id}?token=${token}`; native: fetch/stream — for `download` viewer, return the `?download=true` URL). Reuse the exact auth/token logic already in `getTranscriptPdfUrl`.

Add to `services/apiConfig.ts`:
```typescript
export const FILE_URL = (id: number) => `/media/file/${id}`;
```

- [ ] **Step 5: Run — expect pass** (3 tests).

- [ ] **Step 6: Typecheck** — `... padmakara-app && bunx tsc --noEmit`. Expected: clean.

- [ ] **Step 7: Commit**

```bash
git -C padmakara-app add types/index.ts services/apiConfig.ts services/retreatService.ts services/__tests__/documentMerge.test.ts
git -C padmakara-app commit -m "feat(app): event document model, merge helper, file URL

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 15: Documents tab UI + viewers

**Files:**
- Modify: `app/(tabs)/(groups)/retreat/[id].tsx`
- Create: `components/DocumentImageViewer.tsx`
- (Reuse) `components/PDFViewer.tsx`, existing transcript route.

**Interfaces:**
- Consumes: `buildEventDocuments`, `getFileUrl`, `getTranscriptPdfUrl`.

**Behaviour spec:**
- Replace the transcript pseudo-tab with a real **Documents** tab. The tab is present iff `buildEventDocuments(event).length > 0`. Update `contentTypeCount` / `effectiveTab` so "documents" counts as a content type (video / audio / documents).
- Documents tab content: the featured transcript(s) rendered as a distinct top card; other documents as a list below.
- Tap by `viewer`:
  - `pdf` + `kind === 'transcript'` → existing transcript route/flow (`router.push('/(tabs)/(groups)/transcript/${event.id}')` or the desktop player-bar handler — keep current behaviour).
  - `pdf` + `kind === 'file'` → `PDFViewer` fed by `getFileUrl(id)`.
  - `image` → `DocumentImageViewer` (full-screen modal `<Image>` fed by `getFileUrl(id)`).
  - `download` → `Linking.openURL(getFileUrl(id, { download: true }))` on web; on native use `expo-sharing`/`FileSystem` to download then share (guard `Platform.OS`).
- All strings localized (`documents.*`).

- [ ] **Step 1: Read** `app/(tabs)/(groups)/retreat/[id].tsx` — the tab bar (~1386–1431), `activeContentTab`/`effectiveTab` (~244, ~1298), `hasTranscript`/`contentTypeCount` (~1273, ~1288), and the desktop transcript handler (~906). Read `components/PDFViewer.tsx` props.

- [ ] **Step 2: Build `components/DocumentImageViewer.tsx`** — a themed full-screen modal showing an `<Image source={{ uri }}>` with a close button. Import colors/spacing from the app theme (no inline colors). Localize the close/label strings.

- [ ] **Step 3: Wire the Documents tab** in `retreat/[id].tsx` per the behaviour spec: compute `documents = buildEventDocuments(retreat)`, add a `documents` tab to the tab set, render featured transcript card + list, and route taps to the right handler. Update the tab-visibility count logic.

- [ ] **Step 4: Typecheck + lint** — `... padmakara-app && bunx tsc --noEmit` then `npx expo lint`. Expected: clean.

- [ ] **Step 5: Manual smoke** (if runnable): open an event with a transcript + an image + a Word doc → Documents tab shows transcript featured first, image opens in the viewer, Word triggers download/share. Otherwise confirm typecheck/lint and describe steps for the user.

- [ ] **Step 6: Commit**

```bash
git -C padmakara-app add "app/(tabs)/(groups)/retreat/[id].tsx" components/DocumentImageViewer.tsx
git -C padmakara-app commit -m "feat(app): Documents tab with featured transcript + image/download viewers

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 16: Localization strings

**Files:**
- Modify: `locales/en.json`, `locales/pt.json`

- [ ] **Step 1: Add a `documents` section** to BOTH files with the same keys. English:

```json
"documents": {
  "tab": "Documents",
  "transcript": "Transcript",
  "empty": "No documents available",
  "open": "Open",
  "download": "Download",
  "downloading": "Downloading…",
  "openError": "Could not open this document",
  "close": "Close",
  "image": "Image",
  "document": "Document"
}
```
Portuguese (`pt.json`): `"tab": "Documentos"`, `"transcript": "Transcrição"`, `"empty": "Nenhum documento disponível"`, `"open": "Abrir"`, `"download": "Descarregar"`, `"downloading": "A descarregar…"`, `"openError": "Não foi possível abrir este documento"`, `"close": "Fechar"`, `"image": "Imagem"`, `"document": "Documento"`.

- [ ] **Step 2: Verify JSON validity** — `sh -c 'cd /Users/jeremy/Documents/Programming/padmakara-backend-frontend/padmakara-app && node -e "JSON.parse(require(\"fs\").readFileSync(\"locales/en.json\"));JSON.parse(require(\"fs\").readFileSync(\"locales/pt.json\"));console.log(\"ok\")"'`. Expected: `ok`. Confirm every `documents.*` key used in Tasks 14–15 exists in both files.

- [ ] **Step 3: Commit**

```bash
git -C padmakara-app add locales/en.json locales/pt.json
git -C padmakara-app commit -m "feat(app): documents tab localization (en/pt)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

# PHASE 4 — Deploy

### Task 17: Deploy backend/admin + migrate prod

**Files:** none.

- [ ] **Step 1:** Confirm Phase 1 gate (Task 9) is green and Phases 2–3 typecheck/build.
- [ ] **Step 2: Apply the migration to prod** per spec §12 / `padmakara-api/CLAUDE.md`: SSH, `git pull`, `psql "$DATABASE_URL" -f src/db/migrations/0033_event_files_documents.sql`, insert the sha256 into `drizzle.__drizzle_migrations`.
- [ ] **Step 3: Deploy** — `sh -c 'cd /Users/jeremy/Documents/Programming/padmakara-backend-frontend/padmakara-api && deploy/deploy.sh padmakara@admin.padmakara.pt'` then `sudo systemctl restart padmakara-api` (per the deploy script; confirm the script handles restart).
- [ ] **Step 4: Verify prod** — admin event list shows content icons + search icon; upload a document + transcript on a staging/test event; confirm the app fetches them. Report status to the user.

> The app itself ships via the normal Expo flow (not this script). Flag to the user that app changes need an Expo build/publish.

---

## Self-Review notes

- **Spec coverage:** Documents model (T1–T5, T8, T11, T14–T16), watermark/sensitive (T7), content icons (T6, T12), search icon (T13), transcript persistence fix (T5, T11) — all mapped.
- **Type consistency:** `buildEventFileS3Key(eventCode, fileType, filename)`, `buildEventDocuments(event)`, `EventDocument.viewer ∈ {pdf,image,download}`, resource names `event-files`/`transcripts` used consistently across tasks.
- **Known risk flagged inline:** the admin data provider's update verb (PATCH, per `videos.ts`) and the `events.test.ts`/`media.test.ts` mock shapes must be matched by reading those files — called out in the affected tasks rather than assumed.

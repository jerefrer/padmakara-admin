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

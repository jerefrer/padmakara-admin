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

import { Hono } from "hono";
import { eq, and } from "drizzle-orm";
import { db } from "../db/index.ts";
import { userProgress, bookmarks, userNotes } from "../db/schema/user-content.ts";
import { updateProgressSchema, createBookmarkSchema, createNoteSchema, updateNoteSchema } from "../lib/schemas.ts";
import { AppError } from "../lib/errors.ts";
import { authMiddleware, getUser } from "../middleware/auth.ts";

const contentRoutes = new Hono();

contentRoutes.use("*", authMiddleware);

// --- Progress ---

/**
 * POST /api/content/progress - Save/update listening progress
 */
contentRoutes.post("/progress", async (c) => {
  const user = getUser(c);
  const body = await c.req.json();
  const data = updateProgressSchema.parse(body);

  const completionPct = data.durationSeconds
    ? Math.min(100, Math.round((data.positionSeconds / data.durationSeconds) * 100))
    : 0;
  const isCompleted = completionPct >= 95;

  // Upsert progress
  const existing = await db.query.userProgress.findFirst({
    where: and(
      eq(userProgress.userId, user.id),
      eq(userProgress.trackId, data.trackId),
    ),
  });

  if (existing) {
    const [updated] = await db
      .update(userProgress)
      .set({
        positionSeconds: data.positionSeconds,
        completionPct,
        isCompleted,
        playCount: existing.playCount + (isCompleted && !existing.isCompleted ? 1 : 0),
        totalListenSeconds: existing.totalListenSeconds + (data.positionSeconds - existing.positionSeconds),
        lastPlayed: new Date(),
        completedAt: isCompleted && !existing.isCompleted ? new Date() : existing.completedAt,
      })
      .where(eq(userProgress.id, existing.id))
      .returning();
    return c.json(updated!);
  }

  const [progress] = await db
    .insert(userProgress)
    .values({
      userId: user.id,
      trackId: data.trackId,
      positionSeconds: data.positionSeconds,
      completionPct,
      isCompleted,
      playCount: 1,
      totalListenSeconds: data.positionSeconds,
      lastPlayed: new Date(),
      completedAt: isCompleted ? new Date() : null,
    })
    .returning();

  return c.json(progress!, 201);
});

/**
 * GET /api/content/progress/:trackId - Get progress for a track
 */
contentRoutes.get("/progress/:trackId", async (c) => {
  const user = getUser(c);
  const trackId = parseInt(c.req.param("trackId"), 10);

  const progress = await db.query.userProgress.findFirst({
    where: and(
      eq(userProgress.userId, user.id),
      eq(userProgress.trackId, trackId),
    ),
  });

  if (!progress) {
    return c.json({ positionSeconds: 0, completionPct: 0, isCompleted: false });
  }

  return c.json(progress);
});

// --- Bookmarks ---

contentRoutes.get("/bookmarks", async (c) => {
  const user = getUser(c);
  const data = await db.query.bookmarks.findMany({
    where: eq(bookmarks.userId, user.id),
    orderBy: (b, { desc }) => [desc(b.createdAt)],
    with: { track: true },
  });
  return c.json(data);
});

contentRoutes.post("/bookmarks", async (c) => {
  const user = getUser(c);
  const body = await c.req.json();
  const data = createBookmarkSchema.parse(body);

  const [bookmark] = await db
    .insert(bookmarks)
    .values({ ...data, userId: user.id })
    .returning();

  return c.json(bookmark!, 201);
});

contentRoutes.delete("/bookmarks/:id", async (c) => {
  const user = getUser(c);
  const id = parseInt(c.req.param("id"), 10);

  const [bookmark] = await db
    .delete(bookmarks)
    .where(and(eq(bookmarks.id, id), eq(bookmarks.userId, user.id)))
    .returning();

  if (!bookmark) throw AppError.notFound("Bookmark not found");
  return c.json(bookmark);
});

// --- Notes ---

contentRoutes.get("/notes", async (c) => {
  const user = getUser(c);
  const data = await db.query.userNotes.findMany({
    where: eq(userNotes.userId, user.id),
    orderBy: (n, { desc }) => [desc(n.updatedAt)],
  });
  return c.json(data);
});

contentRoutes.post("/notes", async (c) => {
  const user = getUser(c);
  const body = await c.req.json();
  const data = createNoteSchema.parse(body);

  const [note] = await db
    .insert(userNotes)
    .values({ ...data, userId: user.id })
    .returning();

  return c.json(note!, 201);
});

contentRoutes.put("/notes/:id", async (c) => {
  const user = getUser(c);
  const id = parseInt(c.req.param("id"), 10);
  const body = await c.req.json();
  const data = updateNoteSchema.parse(body);

  const [note] = await db
    .update(userNotes)
    .set({ ...data, updatedAt: new Date() })
    .where(and(eq(userNotes.id, id), eq(userNotes.userId, user.id)))
    .returning();

  if (!note) throw AppError.notFound("Note not found");
  return c.json(note);
});

contentRoutes.delete("/notes/:id", async (c) => {
  const user = getUser(c);
  const id = parseInt(c.req.param("id"), 10);

  const [note] = await db
    .delete(userNotes)
    .where(and(eq(userNotes.id, id), eq(userNotes.userId, user.id)))
    .returning();

  if (!note) throw AppError.notFound("Note not found");
  return c.json(note);
});

export { contentRoutes };

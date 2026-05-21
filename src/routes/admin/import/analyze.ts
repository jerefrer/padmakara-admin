import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import { db } from "../../../db/index.ts";
import { AppError } from "../../../lib/errors.ts";
import { analyzeFolder } from "../../../services/track-analysis.ts";

const bodySchema = z.object({
  folderName: z.string().min(1),
  files: z
    .array(
      z.object({
        relativePath: z.string().min(1),
        sizeBytes: z.number().int().nonnegative(),
      }),
    )
    .min(1),
});

export const analyzeRoutes = new Hono();

analyzeRoutes.post("/", async (c) => {
  // Auth + admin role enforced by parent middleware (src/routes/admin/index.ts).
  const parsed = bodySchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    throw AppError.badRequest("Invalid payload", "VALIDATION_ERROR");
  }
  const { folderName, files } = parsed.data;

  const [groupRows, teacherRows, placeRows] = await Promise.all([
    db.query.retreatGroups.findMany({
      columns: { id: true, nameEn: true, namePt: true, slug: true, abbreviation: true },
    }),
    db.query.teachers.findMany({
      columns: { id: true, name: true, abbreviation: true },
    }),
    db.query.places.findMany({
      columns: { id: true, name: true, abbreviation: true },
    }),
  ]);

  return streamSSE(c, async (stream) => {
    const ac = new AbortController();
    const onAbort = () => ac.abort();
    c.req.raw.signal.addEventListener("abort", onAbort);

    // SSE heartbeat: emit a comment line every 10 s while Claude is thinking.
    // Without this, a long gap between real progress events (often >30 s for a
    // single Claude chunk) lets intermediate proxies / Bun's idle timeout close
    // the connection, producing ERR_INCOMPLETE_CHUNKED_ENCODING on the client.
    const heartbeat = setInterval(() => {
      stream.write(": keepalive\n\n").catch(() => {});
    }, 10_000);

    try {
      const result = await analyzeFolder(
        {
          folderName,
          files,
          knownGroups: groupRows.map((r) => ({
            id: String(r.id),
            nameEn: r.nameEn,
            namePt: r.namePt ?? r.nameEn,
            slug: r.slug,
            abbreviation: r.abbreviation ?? "",
          })),
          knownTeachers: teacherRows.map((r) => ({
            id: String(r.id),
            name: r.name,
            abbreviation: r.abbreviation ?? "",
          })),
          knownPlaces: placeRows.map((r) => ({
            id: String(r.id),
            name: r.name,
            abbreviation: r.abbreviation ?? "",
          })),
        },
        async (event) => {
          await stream.writeSSE({ event: (event as { type: string }).type, data: JSON.stringify(event) });
        },
        ac.signal,
      );
      await stream.writeSSE({ event: "result", data: JSON.stringify(result) });
    } catch (err) {
      await stream.writeSSE({
        event: "error",
        data: JSON.stringify({ message: (err as Error).message }),
      });
    } finally {
      clearInterval(heartbeat);
      c.req.raw.signal.removeEventListener("abort", onAbort);
    }
  });
});

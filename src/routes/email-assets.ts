import { Hono } from "hono";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { AppError } from "../lib/errors.ts";

/**
 * The images Padmakara emails point at.
 *
 * Mail clients cannot render an SVG and will not load a data: URI, so the mark
 * in an email has to be a PNG at a public URL. It is served from here rather
 * than from the app because api.padmakara.pt is up whenever an email can be
 * sent at all, while the app's web bundle is deployed on its own schedule.
 *
 * Public on purpose: it is a logo in a message that has already been delivered
 * to someone's inbox, and gating it behind a token would only mean the mark
 * never appears.
 */
const emailAssetRoutes = new Hono();

/** Nothing here is user-supplied, so the set of files is a literal map. */
const ASSETS: Record<string, { file: string; type: string }> = {
  "mark.png": { file: "../assets/email/mark.png", type: "image/png" },
};

/** Read once per process: these are small, immutable and sent on every email. */
const cache = new Map<string, Buffer>();

async function load(name: string): Promise<Buffer> {
  const cached = cache.get(name);
  if (cached) return cached;

  const asset = ASSETS[name]!;
  const bytes = await readFile(fileURLToPath(new URL(asset.file, import.meta.url)));
  cache.set(name, bytes);
  return bytes;
}

emailAssetRoutes.get("/:name", async (c) => {
  const name = c.req.param("name");
  const asset = ASSETS[name];
  if (!asset) throw AppError.notFound("Unknown email asset");

  const bytes = await load(name);
  return c.body(new Uint8Array(bytes), 200, {
    "Content-Type": asset.type,
    // The file only changes when the brand does, and then under a new name.
    "Cache-Control": "public, max-age=31536000, immutable",
  });
});

export { emailAssetRoutes };

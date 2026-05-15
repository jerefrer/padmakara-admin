import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { db } from "../db/index.ts";
import { downloadRequests } from "../db/schema/index.ts";
import { events } from "../db/schema/retreats.ts";
import { AppError } from "../lib/errors.ts";
import { optionalAuthMiddleware, getOptionalUser } from "../middleware/auth.ts";
import { generatePresignedDownloadUrl } from "../services/s3.ts";
import { AUDIENCE_SLUGS } from "../services/access.ts";

const downloadsRoutes = new Hono();

downloadsRoutes.use("*", optionalAuthMiddleware);

/**
 * Re-verify that the event associated with an anonymous download request is
 * still publicly accessible (status "published" + audience slug "free-anyone").
 * Throws AppError.forbidden if the event is no longer public.
 */
async function verifyEventStillPublic(eventId: number): Promise<void> {
  const event = await db.query.events.findFirst({
    where: eq(events.id, eventId),
    with: { audience: true },
  });

  const isPublic =
    event?.status === "published" &&
    event?.audience?.slug === AUDIENCE_SLUGS.PUBLIC;

  if (!isPublic) {
    throw AppError.forbidden("This content is no longer publicly available");
  }
}

/**
 * Verify the caller has access to a download request.
 * - Authenticated requests require ownership.
 * - Anonymous requests (userId is null) require that the associated event is
 *   still publicly accessible right now (re-verified on every call).
 */
async function verifyDownloadAccess(
  request: { userId: number | null; eventId: number },
  callerId: number | undefined,
): Promise<void> {
  if (request.userId === null) {
    // Anonymous request: re-verify the event is still public
    await verifyEventStillPublic(request.eventId);
    return;
  }
  if (callerId && request.userId === callerId) return; // owner match
  throw AppError.forbidden("Access denied");
}

/**
 * GET /api/download-requests/:id/status - Get ZIP generation status
 */
downloadsRoutes.get("/:id/status", async (c) => {
  const user = getOptionalUser(c);
  const requestId = c.req.param("id");

  // Fetch download request
  const request = await db.query.downloadRequests.findFirst({
    where: eq(downloadRequests.id, requestId),
  });

  if (!request) {
    throw AppError.notFound("Download request not found");
  }

  await verifyDownloadAccess(request, user?.id);

  // Check if expired (status is ready but past expiration time)
  if (
    request.status === "ready" &&
    request.expiresAt &&
    new Date() > request.expiresAt
  ) {
    // Update status to expired
    await db
      .update(downloadRequests)
      .set({ status: "expired", updatedAt: new Date() })
      .where(eq(downloadRequests.id, requestId));

    return c.json({
      status: "expired",
      progress_percent: request.progressPercent,
      error_message: "Download link has expired. Please request a new download.",
    });
  }

  // Return current status
  return c.json({
    status: request.status,
    progress_percent: request.progressPercent,
    error_message: request.errorMessage || undefined,
    total_files: request.totalFiles || undefined,
    processed_files: request.processedFiles,
  });
});

/**
 * GET /api/download-requests/:id/download - Get presigned download URL
 */
downloadsRoutes.get("/:id/download", async (c) => {
  const user = getOptionalUser(c);
  const requestId = c.req.param("id");

  // Fetch download request
  const request = await db.query.downloadRequests.findFirst({
    where: eq(downloadRequests.id, requestId),
  });

  if (!request) {
    throw AppError.notFound("Download request not found");
  }

  await verifyDownloadAccess(request, user?.id);

  // Check status
  if (request.status !== "ready") {
    throw AppError.badRequest(
      `Download is not ready yet. Current status: ${request.status}`,
      "NOT_READY"
    );
  }

  // Check if expired
  if (request.expiresAt && new Date() > request.expiresAt) {
    await db
      .update(downloadRequests)
      .set({ status: "expired", updatedAt: new Date() })
      .where(eq(downloadRequests.id, requestId));

    throw new AppError(
      410,
      "Download link has expired. Please request a new download.",
      "EXPIRED"
    );
  }

  // Generate fresh presigned URL (1 hour expiry)
  if (!request.s3Key) {
    throw new AppError(500, "S3 key not found for this request", "INTERNAL_ERROR");
  }

  const downloadUrl = await generatePresignedDownloadUrl(request.s3Key, 3600);

  // Return download URL
  return c.json({
    success: true,
    download_url: downloadUrl,
  });
});

export { downloadsRoutes };

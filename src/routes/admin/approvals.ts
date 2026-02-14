import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { db } from "../../db/index.ts";
import { users } from "../../db/schema/users.ts";
import {
  userApprovalRequests,
  magicLinkTokens,
} from "../../db/schema/auth.ts";
import { getUser } from "../../middleware/auth.ts";
import { AppError } from "../../lib/errors.ts";
import {
  generateMagicLinkToken,
  hashToken,
  magicLinkExpiresAt,
} from "../../services/auth.ts";
import { sendEmail, buildMagicLinkEmail } from "../../services/email.ts";
import { config } from "../../config.ts";
import {
  parsePagination,
  buildOrderBy,
  listResponse,
  countRows,
} from "./helpers.ts";

const approvalRoutes = new Hono();

const columns: Record<string, any> = {
  id: userApprovalRequests.id,
  email: userApprovalRequests.email,
  status: userApprovalRequests.status,
  requestedAt: userApprovalRequests.requestedAt,
  reviewedAt: userApprovalRequests.reviewedAt,
};

/**
 * GET /api/admin/approvals - List all approval requests (React Admin compatible)
 */
approvalRoutes.get("/", async (c) => {
  const { limit, offset, _sort, _order } = parsePagination(c);
  const orderBy = buildOrderBy(_sort, _order, columns);

  const [data, total] = await Promise.all([
    db.query.userApprovalRequests.findMany({
      orderBy: orderBy ? [orderBy] : undefined,
      limit,
      offset,
      with: {
        reviewedBy: {
          columns: { id: true, email: true, firstName: true, lastName: true },
        },
      },
    }),
    countRows(userApprovalRequests),
  ]);

  return listResponse(c, data, total, offset, offset + limit, "approvals");
});

/**
 * GET /api/admin/approvals/:id - Get single approval request
 */
approvalRoutes.get("/:id", async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  const request = await db.query.userApprovalRequests.findFirst({
    where: eq(userApprovalRequests.id, id),
    with: {
      reviewedBy: {
        columns: { id: true, email: true, firstName: true, lastName: true },
      },
    },
  });
  if (!request) throw AppError.notFound("Approval request not found");
  return c.json(request);
});

/**
 * POST /api/admin/approvals/:id/approve
 *
 * Approves the request:
 * 1. Creates a new user account
 * 2. Generates a magic link token
 * 3. Sends welcome email with activation link
 * 4. Marks request as approved
 */
approvalRoutes.post("/:id/approve", async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  const admin = getUser(c);

  const request = await db.query.userApprovalRequests.findFirst({
    where: eq(userApprovalRequests.id, id),
  });
  if (!request) throw AppError.notFound("Approval request not found");
  if (request.status !== "pending") {
    throw AppError.badRequest(`Request already ${request.status}`);
  }

  // Check if user already exists (may have been created via another path)
  const existingUser = await db.query.users.findFirst({
    where: eq(users.email, request.email),
  });

  let userId: number;

  if (existingUser) {
    userId = existingUser.id;
    // Ensure account is active
    await db
      .update(users)
      .set({ isActive: true, isVerified: true, updatedAt: new Date() })
      .where(eq(users.id, existingUser.id));
  } else {
    // Create new user
    const [newUser] = await db
      .insert(users)
      .values({
        email: request.email,
        firstName: request.firstName,
        lastName: request.lastName,
        isActive: true,
        isVerified: true,
        role: "user",
        preferredLanguage: request.language ?? "en",
      })
      .returning({ id: users.id });
    userId = newUser.id;
  }

  // Generate magic link so the user can activate their device
  const token = generateMagicLinkToken();
  const tokenHash = await hashToken(token);

  await db.insert(magicLinkTokens).values({
    email: request.email,
    tokenHash,
    expiresAt: magicLinkExpiresAt(),
    deviceFingerprint: request.deviceFingerprint,
    deviceName: request.deviceName,
    deviceType: request.deviceType,
    language: request.language ?? "en",
  });

  // Send welcome/activation email
  const magicLinkUrl = `${config.urls.backend}/api/auth/activate/${token}?lang=${request.language ?? "en"}`;
  const emailContent = buildMagicLinkEmail(
    magicLinkUrl,
    request.language ?? "en",
  );
  await sendEmail({
    to: request.email,
    subject: emailContent.subject,
    html: emailContent.html,
  });

  // Mark request as approved
  await db
    .update(userApprovalRequests)
    .set({
      status: "approved",
      reviewedAt: new Date(),
      reviewedById: admin.id,
    })
    .where(eq(userApprovalRequests.id, id));

  return c.json({
    message: "Request approved — activation email sent",
    userId,
  });
});

/**
 * POST /api/admin/approvals/:id/reject
 *
 * Rejects the request with an optional admin message.
 */
approvalRoutes.post("/:id/reject", async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  const admin = getUser(c);
  const body = await c.req.json().catch(() => ({}));
  const adminMessage = body.adminMessage as string | undefined;

  const request = await db.query.userApprovalRequests.findFirst({
    where: eq(userApprovalRequests.id, id),
  });
  if (!request) throw AppError.notFound("Approval request not found");
  if (request.status !== "pending") {
    throw AppError.badRequest(`Request already ${request.status}`);
  }

  await db
    .update(userApprovalRequests)
    .set({
      status: "rejected",
      adminMessage: adminMessage ?? null,
      reviewedAt: new Date(),
      reviewedById: admin.id,
    })
    .where(eq(userApprovalRequests.id, id));

  return c.json({ message: "Request rejected" });
});

export { approvalRoutes };

import { Hono } from "hono";
import { eq, or, and, ilike, inArray } from "drizzle-orm";
import { db } from "../../db/index.ts";
import { retreatGroups } from "../../db/schema/retreat-groups.ts";
import { events, eventRetreatGroups } from "../../db/schema/retreats.ts";
import { userGroupMemberships } from "../../db/schema/users.ts";
import { createRetreatGroupSchema, updateRetreatGroupSchema } from "../../lib/schemas.ts";
import { AppError } from "../../lib/errors.ts";
import { parsePagination, buildOrderBy, listResponse, countRows } from "./helpers.ts";
import {
  putObject,
  deleteObject,
  buildGroupAvatarS3Key,
  buildGroupHeroS3Key,
  buildGroupHeroMobileS3Key,
} from "../../services/s3.ts";
import {
  processAvatar,
  processHero,
  processHeroMobile,
} from "../../services/image-pipeline.ts";
import { resolveGroupUrls } from "../../lib/group-utils.ts";
import { loadImageSource, imageSourceResponse } from "../../lib/image-source.ts";
import { bumpVersion, bumpUserAccessVersion } from "../../services/sync-versions.ts";

const groupRoutes = new Hono();

const columns: Record<string, any> = {
  id: retreatGroups.id,
  nameEn: retreatGroups.nameEn,
  namePt: retreatGroups.namePt,
  abbreviation: retreatGroups.abbreviation,
  slug: retreatGroups.slug,
  displayOrder: retreatGroups.displayOrder,
  createdAt: retreatGroups.createdAt,
};

groupRoutes.get("/", async (c) => {
  const { limit, offset, _sort, _order } = parsePagination(c);
  const orderBy = buildOrderBy(_sort, _order, columns);
  const q = c.req.query("q");

  const where = q
    ? or(
        ilike(retreatGroups.nameEn, `%${q}%`),
        ilike(retreatGroups.namePt, `%${q}%`),
        ilike(retreatGroups.abbreviation, `%${q}%`),
      )
    : undefined;

  const [data, total] = await Promise.all([
    db.select().from(retreatGroups).where(where).orderBy(orderBy!).limit(limit).offset(offset),
    countRows(retreatGroups, where),
  ]);

  const resolved = await Promise.all(
    data.map(async (g) => ({ ...g, ...(await resolveGroupUrls(g)) })),
  );
  return listResponse(c, resolved, total, offset, offset + limit, "groups");
});

groupRoutes.put("/reorder", async (c) => {
  const { ids } = await c.req.json<{ ids: number[] }>();
  for (let i = 0; i < ids.length; i++) {
    await db
      .update(retreatGroups)
      .set({ displayOrder: i, updatedAt: new Date() })
      .where(eq(retreatGroups.id, ids[i]!));
  }
  bumpVersion("groups").catch((err) =>
    console.error("[sync] failed to bump groups version:", err),
  );
  return c.json({ success: true });
});

/**
 * GET /:id/avatar/source and GET /:id/hero/source — the current image bytes,
 * served through the API so the admin can re-crop it without the browser
 * having to read a cross-origin URL. See lib/image-source.ts.
 */
groupRoutes.get("/:id/avatar/source", async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (isNaN(id)) throw AppError.badRequest("Invalid group ID");

  const group = await db.query.retreatGroups.findFirst({
    where: eq(retreatGroups.id, id),
  });
  if (!group) throw AppError.notFound("Group not found");

  return imageSourceResponse(
    await loadImageSource({ s3Key: group.avatarS3Key, fallbackUrl: group.logoUrl }),
  );
});

groupRoutes.get("/:id/hero/source", async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (isNaN(id)) throw AppError.badRequest("Invalid group ID");

  const group = await db.query.retreatGroups.findFirst({
    where: eq(retreatGroups.id, id),
  });
  if (!group) throw AppError.notFound("Group not found");

  return imageSourceResponse(
    await loadImageSource({ s3Key: group.heroS3Key, fallbackUrl: null }),
  );
});

/**
 * POST /:id/avatar — Upload and resize a retreat-group avatar.
 *
 * Accepts multipart/form-data with a `file` field. The server resizes to
 * 400×400 (sharp center-cover) before storing on S3.
 */
groupRoutes.post("/:id/avatar", async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (isNaN(id)) throw AppError.badRequest("Invalid group ID");

  const form = await c.req.formData();
  const file = form.get("file");
  if (!(file instanceof File)) throw AppError.badRequest("Missing file");

  const buffer = Buffer.from(await file.arrayBuffer());
  const resized = await processAvatar(buffer);

  const s3Key = buildGroupAvatarS3Key(id, "webp");
  await putObject(s3Key, resized, "image/webp");

  const existing = await db.query.retreatGroups.findFirst({
    where: eq(retreatGroups.id, id),
  });
  if (existing?.avatarS3Key && existing.avatarS3Key !== s3Key) {
    await deleteObject(existing.avatarS3Key).catch(() => {});
  }

  const now = new Date();
  const [group] = await db
    .update(retreatGroups)
    .set({ avatarS3Key: s3Key, avatarUpdatedAt: now, updatedAt: now })
    .where(eq(retreatGroups.id, id))
    .returning();
  if (!group) throw AppError.notFound("Group not found");

  const resolved = await resolveGroupUrls(group);
  bumpVersion("groups").catch((err) =>
    console.error("[sync] failed to bump groups version:", err),
  );
  return c.json({ ...group, ...resolved });
});

/**
 * POST /:id/hero — Upload and resize a retreat-group hero banner.
 *
 * Accepts multipart/form-data with `file` and optional `focalX`/`focalY`
 * (0–100, default 50). The server generates two WebP variants — desktop
 * (2400px wide) and mobile (1200px wide) — both with aspect ratio
 * preserved and no enlargement. Frontend picks the right one from the
 * viewport width.
 */
groupRoutes.post("/:id/hero", async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (isNaN(id)) throw AppError.badRequest("Invalid group ID");

  const form = await c.req.formData();
  const file = form.get("file");
  if (!(file instanceof File)) throw AppError.badRequest("Missing file");
  const focalX = clampPercent(form.get("focalX"));
  const focalY = clampPercent(form.get("focalY"));

  const buffer = Buffer.from(await file.arrayBuffer());
  const [desktopBuf, mobileBuf] = await Promise.all([
    processHero(buffer),
    processHeroMobile(buffer),
  ]);

  const desktopKey = buildGroupHeroS3Key(id, "webp");
  const mobileKey = buildGroupHeroMobileS3Key(id, "webp");
  await Promise.all([
    putObject(desktopKey, desktopBuf, "image/webp"),
    putObject(mobileKey, mobileBuf, "image/webp"),
  ]);

  const existing = await db.query.retreatGroups.findFirst({
    where: eq(retreatGroups.id, id),
  });
  if (existing?.heroS3Key && existing.heroS3Key !== desktopKey) {
    await deleteObject(existing.heroS3Key).catch(() => {});
  }
  if (existing?.heroMobileS3Key && existing.heroMobileS3Key !== mobileKey) {
    await deleteObject(existing.heroMobileS3Key).catch(() => {});
  }

  const now = new Date();
  const [group] = await db
    .update(retreatGroups)
    .set({
      heroS3Key: desktopKey,
      heroMobileS3Key: mobileKey,
      heroFocalX: focalX,
      heroFocalY: focalY,
      heroScale: 100,
      heroUpdatedAt: now,
      updatedAt: now,
    })
    .where(eq(retreatGroups.id, id))
    .returning();
  if (!group) throw AppError.notFound("Group not found");

  const resolved = await resolveGroupUrls(group);
  bumpVersion("groups").catch((err) =>
    console.error("[sync] failed to bump groups version:", err),
  );
  return c.json({ ...group, ...resolved });
});

// FormDataEntryValue = File | string per Web API spec; avoid DOM lib dependency
function clampPercent(raw: File | string | null): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return 50;
  return Math.max(0, Math.min(100, Math.round(n)));
}

/**
 * GET /:id/events — Slim list of events linked to this group.
 *
 * Used by the admin delete dialog to show what is attached to the group
 * before the user confirms a delete-or-reassign decision. Returns just
 * enough to render a preview list — full event detail goes through the
 * events resource.
 */
groupRoutes.get("/:id/events", async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (isNaN(id)) throw AppError.badRequest("Invalid group ID");

  const rows = await db
    .select({
      id: events.id,
      eventCode: events.eventCode,
      titleEn: events.titleEn,
      titlePt: events.titlePt,
      startDate: events.startDate,
    })
    .from(eventRetreatGroups)
    .innerJoin(events, eq(events.id, eventRetreatGroups.eventId))
    .where(eq(eventRetreatGroups.retreatGroupId, id))
    .orderBy(events.startDate);

  return c.json({ events: rows, total: rows.length });
});

groupRoutes.get("/:id", async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  const group = await db.query.retreatGroups.findFirst({
    where: eq(retreatGroups.id, id),
  });
  if (!group) throw AppError.notFound("Group not found");
  const resolved = await resolveGroupUrls(group);
  return c.json({ ...group, ...resolved });
});

groupRoutes.post("/", async (c) => {
  const body = await c.req.json();
  const data = createRetreatGroupSchema.parse(body);
  const [group] = await db.insert(retreatGroups).values(data).returning();
  bumpVersion("groups").catch((err) =>
    console.error("[sync] failed to bump groups version:", err),
  );
  return c.json(group!, 201);
});

groupRoutes.put("/:id", async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  const body = await c.req.json();
  const data = updateRetreatGroupSchema.parse(body);

  // If S3 keys are changing, delete the previous objects.
  if (data.avatarS3Key !== undefined || data.heroS3Key !== undefined) {
    const existing = await db.query.retreatGroups.findFirst({
      where: eq(retreatGroups.id, id),
    });

    if (existing) {
      if (data.avatarS3Key !== existing.avatarS3Key && existing.avatarS3Key) {
        await deleteObject(existing.avatarS3Key).catch(() => {});
      }
      if (data.heroS3Key !== existing.heroS3Key && existing.heroS3Key) {
        await deleteObject(existing.heroS3Key).catch(() => {});
      }
    }
  }

  const updateData: Record<string, any> = { ...data, updatedAt: new Date() };

  if (data.avatarS3Key !== undefined) {
    updateData.avatarUpdatedAt = new Date();
  }
  if (data.heroS3Key !== undefined) {
    updateData.heroUpdatedAt = new Date();
    // Group hero images are generic (Buddha statues, mandalas, etc.) — no
    // automatic face/focal-point detection. The admin sets focal+scale by
    // hand from the crop dialog; defaults to centered if unset.
  }

  const [group] = await db
    .update(retreatGroups)
    .set(updateData)
    .where(eq(retreatGroups.id, id))
    .returning();
  if (!group) throw AppError.notFound("Group not found");
  bumpVersion("groups").catch((err) =>
    console.error("[sync] failed to bump groups version:", err),
  );
  return c.json(group);
});

/**
 * DELETE /:id — Delete a retreat group, optionally reassigning its events
 * and user memberships.
 *
 * Query params:
 *   reassignTo (optional) — id of another retreat group to receive both
 *     events and user memberships currently attached to the deleted
 *     group. Each junction row is moved to the target group; rows whose
 *     (event,group) or (user,group) pair already exists in the target
 *     are left alone and get cascade-deleted with the group (the unique
 *     primary keys prevent updating them in place).
 *
 * When reassignTo is omitted, events and memberships are simply unlinked
 * from this group via the FK cascade.
 */
groupRoutes.delete("/:id", async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (isNaN(id)) throw AppError.badRequest("Invalid group ID");

  const reassignToRaw = c.req.query("reassignTo");
  let reassignTo: number | null = null;
  if (reassignToRaw !== undefined && reassignToRaw !== "") {
    const parsed = parseInt(reassignToRaw, 10);
    if (isNaN(parsed)) throw AppError.badRequest("Invalid reassignTo");
    if (parsed === id)
      throw AppError.badRequest("Cannot reassign to the group being deleted");
    const target = await db.query.retreatGroups.findFirst({
      where: eq(retreatGroups.id, parsed),
    });
    if (!target) throw AppError.badRequest("Reassignment target group not found");
    reassignTo = parsed;
  }

  let reassignedEventCount = 0;
  let reassignedMembershipCount = 0;
  const affectedUserIds = new Set<number>();

  if (reassignTo !== null) {
    // Move event junction rows.
    const sourceEventRows = await db
      .select({ eventId: eventRetreatGroups.eventId })
      .from(eventRetreatGroups)
      .where(eq(eventRetreatGroups.retreatGroupId, id));

    if (sourceEventRows.length > 0) {
      const targetEventRows = await db
        .select({ eventId: eventRetreatGroups.eventId })
        .from(eventRetreatGroups)
        .where(eq(eventRetreatGroups.retreatGroupId, reassignTo));
      const eventsAlreadyInTarget = new Set(targetEventRows.map((r) => r.eventId));

      const eventsToMove = sourceEventRows
        .map((r) => r.eventId)
        .filter((eventId) => !eventsAlreadyInTarget.has(eventId));

      if (eventsToMove.length > 0) {
        await db
          .update(eventRetreatGroups)
          .set({ retreatGroupId: reassignTo })
          .where(
            and(
              eq(eventRetreatGroups.retreatGroupId, id),
              inArray(eventRetreatGroups.eventId, eventsToMove),
            ),
          );
        reassignedEventCount = eventsToMove.length;
      }
    }

    // Move user membership rows.
    const sourceMemberRows = await db
      .select({ userId: userGroupMemberships.userId })
      .from(userGroupMemberships)
      .where(eq(userGroupMemberships.retreatGroupId, id));

    if (sourceMemberRows.length > 0) {
      const targetMemberRows = await db
        .select({ userId: userGroupMemberships.userId })
        .from(userGroupMemberships)
        .where(eq(userGroupMemberships.retreatGroupId, reassignTo));
      const usersAlreadyInTarget = new Set(targetMemberRows.map((r) => r.userId));

      const usersToMove = sourceMemberRows
        .map((r) => r.userId)
        .filter((userId) => !usersAlreadyInTarget.has(userId));

      if (usersToMove.length > 0) {
        await db
          .update(userGroupMemberships)
          .set({ retreatGroupId: reassignTo })
          .where(
            and(
              eq(userGroupMemberships.retreatGroupId, id),
              inArray(userGroupMemberships.userId, usersToMove),
            ),
          );
        reassignedMembershipCount = usersToMove.length;
        for (const userId of usersToMove) affectedUserIds.add(userId);
      }
    }
  }

  const [group] = await db
    .delete(retreatGroups)
    .where(eq(retreatGroups.id, id))
    .returning();
  if (!group) throw AppError.notFound("Group not found");

  bumpVersion("groups").catch((err) =>
    console.error("[sync] failed to bump groups version:", err),
  );
  if (reassignedEventCount > 0) {
    bumpVersion("events").catch((err) =>
      console.error("[sync] failed to bump events version:", err),
    );
  }
  for (const userId of affectedUserIds) {
    bumpUserAccessVersion(userId).catch((err) =>
      console.error("[sync] failed to bump user access version:", err),
    );
  }

  return c.json({ ...group, reassignedEventCount, reassignedMembershipCount });
});

export { groupRoutes };

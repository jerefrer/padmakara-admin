import { Hono } from "hono";
import { eq, inArray } from "drizzle-orm";
import { db } from "../db/index.ts";
import { events } from "../db/schema/retreats.ts";
import { users } from "../db/schema/users.ts";
import { teachingOrders, eventAccessGrants } from "../db/schema/event-access.ts";
import { authMiddleware, getUser } from "../middleware/auth.ts";
import { authIpLimiter } from "../middleware/rate-limit.ts";
import { AppError } from "../lib/errors.ts";
import { teachingCheckoutSchema } from "../lib/schemas.ts";
import { config } from "../config.ts";
import { checkEventAccess, hasEventGrant } from "../services/access.ts";
import { findOrCreateUserByEmail } from "../services/users-lookup.ts";
import { grantEventAccess } from "../services/event-access.ts";
import {
  finalizeOrder,
  lookupSinglePayment,
  type SinglePaymentInfo,
  type TeachingOrder,
  refreshOrderFromEasypay,
  sendTeachingAvailableEmail,
  teachingOrderKey,
} from "../services/teaching-orders.ts";
import { easypayFetch, isMockMode } from "./payment.ts";
import { eventListWith } from "./events.ts";
import { resolveEventsTeacherUrls } from "../lib/teacher-utils.ts";
import { resolveEventsGroupUrls } from "../lib/group-utils.ts";
import { applyEventsOrganizers } from "../lib/organizer-utils.ts";
import { applyEventsVideoThumbnails } from "../lib/video-utils.ts";

const teachingRoutes = new Hono();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A pending order is re-read from Easypay once it is older than this (the webhook had its chance). */
const REFRESH_AFTER_MS = 10_000;

const pollCache = new Map<string, { at: number; info: SinglePaymentInfo | null }>();

/** Test hook: forget cached Easypay lookups. */
export function resetOrderPollCache(): void {
  pollCache.clear();
}

async function cachedLookup(order: TeachingOrder): Promise<SinglePaymentInfo | null> {
  const hit = pollCache.get(order.publicId);
  if (hit && Date.now() - hit.at < REFRESH_AFTER_MS) return hit.info;
  const info = await lookupSinglePayment(order);
  if (pollCache.size > 1000) pollCache.clear();
  pollCache.set(order.publicId, { at: Date.now(), info });
  return info;
}

function parseEventId(raw: string): number {
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) throw AppError.notFound("Teaching not found");
  return id;
}

/** The event for a sale page: on sale (free or paid) and not archived, else 404. */
async function findSaleEvent(id: number) {
  const event = await db.query.events.findFirst({
    where: eq(events.id, id),
    with: {
      audience: true,
      eventTeachers: { with: { teacher: true } },
      eventPlaces: { with: { place: true } },
      sessions: { columns: { id: true } },
    },
  });
  if (!event || event.saleMode === "none" || event.status === "archived") {
    throw AppError.notFound("Teaching not found");
  }
  return event;
}

// ─── Authenticated ───

/** GET /api/teachings/mine: published events the user holds a grant for, newest grant first. */
teachingRoutes.get("/mine", authMiddleware, async (c) => {
  const user = getUser(c);
  const grants = await db.query.eventAccessGrants.findMany({
    where: eq(eventAccessGrants.userId, user.id),
  });
  if (grants.length === 0) return c.json([]);

  const rank = new Map(grants.map((g) => [g.eventId, g.createdAt.getTime()]));
  const rows = await db.query.events.findMany({
    where: inArray(events.id, [...rank.keys()]),
    with: eventListWith,
  });
  const data = rows
    .filter((e) => e.status === "published")
    .sort((a, b) => (rank.get(b.id) ?? 0) - (rank.get(a.id) ?? 0));

  await resolveEventsTeacherUrls(data);
  await resolveEventsGroupUrls(data);
  applyEventsVideoThumbnails(data);
  applyEventsOrganizers(data);
  return c.json(data);
});

// ─── Public ───

/** GET /api/teachings/orders/:publicId: confirmation-page polling target. */
teachingRoutes.get("/orders/:publicId", async (c) => {
  const publicId = c.req.param("publicId");
  if (!UUID_RE.test(publicId)) throw AppError.notFound("Order not found");

  let order = await db.query.teachingOrders.findFirst({
    where: eq(teachingOrders.publicId, publicId),
  });
  if (!order) throw AppError.notFound("Order not found");

  let mbReference: { entity: string; reference: string; amount: number } | undefined;
  // Unauthenticated and unlimited: Easypay is only asked once the webhook has had its
  // chance (order older than REFRESH_AFTER_MS), and at most once per window per order.
  if (order.status === "pending" && Date.now() - order.createdAt.getTime() > REFRESH_AFTER_MS) {
    const info = await cachedLookup(order);
    await refreshOrderFromEasypay(order, info);
    const fresh = await db.query.teachingOrders.findFirst({
      where: eq(teachingOrders.publicId, publicId),
    });
    if (fresh) order = fresh;
    if (order.status === "pending" && info?.methodType?.toUpperCase() === "MB" && info.entity && info.reference) {
      mbReference = { entity: info.entity, reference: info.reference, amount: order.amountCents / 100 };
    }
  }

  return c.json({
    status: order.status,
    eventId: order.eventId,
    method: order.method ?? lookupMethod(order.status, mbReference),
    amountCents: order.amountCents,
    ...(mbReference ? { mbReference } : {}),
  });
});

/** While pending the order has no stored method; a Multibanco reference implies "mb". */
function lookupMethod(status: string, mb: unknown): string | null {
  return status === "pending" && mb ? "mb" : null;
}

/** GET /api/teachings/:eventId: what the public sale page shows. */
teachingRoutes.get("/:eventId", async (c) => {
  const event = await findSaleEvent(parseEventId(c.req.param("eventId")));
  return c.json({
    id: event.id,
    titleEn: event.titleEn ?? null,
    titlePt: event.titlePt ?? null,
    startDate: event.startDate ?? null,
    endDate: event.endDate ?? null,
    imageUrl: event.imageUrl ?? null,
    teachers: (event.eventTeachers ?? []).flatMap((et) => (et.teacher ? [{ name: et.teacher.name }] : [])),
    places: (event.eventPlaces ?? []).flatMap((ep) => (ep.place ? [{ name: ep.place.name }] : [])),
    sessionCount: event.sessions?.length ?? 0,
    published: event.status === "published",
    saleMode: event.saleMode,
    priceCents: event.priceCents ?? null,
  });
});

/**
 * POST /api/teachings/:eventId/checkout
 * Free: grant now. Paid: create a pending order and an Easypay single-payment checkout.
 * Unauthenticated by design (the buyer may not have an account), hence the IP limiter.
 */
teachingRoutes.post("/:eventId/checkout", authIpLimiter(), async (c) => {
  const eventId = parseEventId(c.req.param("eventId"));
  const input = teachingCheckoutSchema.parse(await c.req.json().catch(() => ({})));
  const event = await findSaleEvent(eventId);

  const priceCents = event.priceCents ?? 0;
  if (event.saleMode === "paid" && priceCents < 100) {
    console.error(`[TEACHINGS] event ${event.id} is on paid sale without a valid price (${event.priceCents})`);
    throw AppError.internal("This teaching is not available right now");
  }

  const { user } = await findOrCreateUserByEmail({
    email: input.email,
    firstName: input.firstName,
    lastName: input.lastName,
    language: input.language,
  });

  // A grant counts even on a draft (the status gate would hide it from checkEventAccess).
  const fullUser = await db.query.users.findFirst({ where: eq(users.id, user.id) });
  const alreadyHasAccess =
    (await hasEventGrant(user.id, event.id)) ||
    (fullUser ? (await checkEventAccess(fullUser, event)).allowed : false);
  if (alreadyHasAccess) {
    throw new AppError(409, "You already have access to these recordings", "ALREADY_HAS_ACCESS");
  }

  const buyer = {
    email: user.email,
    firstName: input.firstName,
    lastName: input.lastName,
    language: input.language,
  };

  if (event.saleMode === "free") {
    await grantEventAccess({ userId: user.id, eventId: event.id, source: "free" });
    await sendTeachingAvailableEmail({ eventId: event.id, ...buyer });
    return c.json({ status: "granted" });
  }

  // Mock mode (no Easypay account) is a dev convenience that marks orders paid. It must
  // never run in production: a missing EASYPAY_ACCOUNT_ID would give paid teachings away.
  if (isMockMode && config.nodeEnv === "production") {
    console.error("[TEACHINGS] EASYPAY_ACCOUNT_ID is not configured in production; refusing paid checkout.");
    throw new AppError(503, "Payments are temporarily unavailable", "PAYMENTS_UNAVAILABLE");
  }

  const [order] = await db
    .insert(teachingOrders)
    .values({ eventId: event.id, userId: user.id, ...buyer, amountCents: priceCents, status: "pending" })
    .returning({ id: teachingOrders.id, publicId: teachingOrders.publicId });
  if (!order) throw AppError.internal("Could not create the order");

  if (isMockMode) {
    console.log(`[MOCK PAYMENT] Marking teaching order ${order.id} paid`);
    const result = await finalizeOrder(order.id, {
      paymentId: `mock_${order.publicId}`,
      method: "mock",
      amountCents: priceCents,
    });
    if (result !== "finalized") {
      console.error(`[MOCK PAYMENT] teaching order ${order.id} not finalized: ${result}`);
      throw AppError.internal("Could not complete the mock payment");
    }
    return c.json({
      status: "checkout",
      orderId: order.publicId,
      checkout: { id: "mock_session", session: "mock" },
      testing: true,
    });
  }

  const key = teachingOrderKey(order.publicId);
  const title = (input.language === "pt" ? event.titlePt || event.titleEn : event.titleEn || event.titlePt) ?? `Event ${event.id}`;
  const value = priceCents / 100;
  let checkout: { id: string; session: string };
  try {
    checkout = await easypayFetch<{ id: string; session: string }>("/checkout", {
      method: "POST",
      body: JSON.stringify({
        type: ["single"],
        payment: {
          methods: config.teachings.singleMethods,
          type: "sale",
          currency: "EUR",
          key,
          capture: { descriptive: "Padmakara" },
        },
        order: {
          items: [{ description: title, quantity: 1, key: `event-${event.id}`, value }],
          key,
          value,
        },
        customer: {
          name: `${input.firstName} ${input.lastName}`,
          email: user.email,
          key: `user-${user.id}`,
          // Easypay accepts "PT" | "EN" | "ES" (docs.easypay.pt, customer.language).
          language: input.language.toUpperCase(),
        },
      }),
    });
  } catch (err) {
    await db.update(teachingOrders).set({ status: "failed" }).where(eq(teachingOrders.id, order.id));
    throw err;
  }

  await db.update(teachingOrders).set({ easypayCheckoutId: checkout.id }).where(eq(teachingOrders.id, order.id));

  return c.json({
    status: "checkout",
    orderId: order.publicId,
    checkout: { id: checkout.id, session: checkout.session },
    testing: config.easypay.testing,
  });
});

export { teachingRoutes };

import { eq, sql } from "drizzle-orm";
import { db } from "../db/index.ts";
import { users, userGroupMemberships, userEventAttendance } from "../db/schema/users.ts";
import {
  refreshTokens,
  magicLinkTokens,
  accountDeletionTokens,
  deviceActivations,
  userApprovalRequests,
} from "../db/schema/auth.ts";
import {
  userProgress,
  bookmarks,
  eventBookmarks,
  trackBookmarks,
  videoBookmarks,
} from "../db/schema/user-content.ts";
import { videoProgress } from "../db/schema/video-progress.ts";
import { downloadRequests } from "../db/schema/download-requests.ts";
import { publicationAccessUsers } from "../db/schema/publications.ts";
import { userSyncVersions } from "../db/schema/user-sync-versions.ts";
import { paymentTransactions } from "../db/schema/payment-transactions.ts";
import { config } from "../config.ts";
import { AppError } from "../lib/errors.ts";
import { deactivateAtEasypay } from "../routes/payment.ts";

/**
 * Permanently delete a user and everything personal about them.
 *
 * PROVISIONAL (see DECISIONS.md, "Account deletion and payment records"):
 *  - Payment ledger rows are KEPT (Portuguese bookkeeping law: ~10 years). They are
 *    detached from the user (`user_id` NULL) and the customer block (name, email,
 *    phone, tax number) is stripped from the stored Easypay payloads. Amounts, dates,
 *    Easypay ids, actions and notes stay.
 *  - A live Easypay subscription is stopped BEFORE anything is deleted. If Easypay
 *    cannot be reached the deletion is refused (502) rather than leaving a card
 *    charging a member who no longer exists. Retrying is safe.
 *  - Admins cannot delete themselves this way (409), so the last admin cannot lock
 *    everyone out.
 */
export async function deleteUserAccount(userId: number): Promise<void> {
  const user = await db.query.users.findFirst({ where: eq(users.id, userId) });
  if (!user) throw AppError.notFound("User not found");

  if (user.role === "admin" || user.role === "superadmin") {
    throw new AppError(
      409,
      "Admin accounts cannot be deleted from the app. Ask another administrator.",
      "ADMIN_ACCOUNT",
    );
  }

  await stopRecurringPayment(user);

  const email = user.email;
  await db.transaction(async (tx) => {
    // Accounting records survive; the person does not.
    await tx
      .update(paymentTransactions)
      .set({
        userId: null,
        rawPayload: sql`${paymentTransactions.rawPayload} - 'customer'`,
        rawSubscription: sql`${paymentTransactions.rawSubscription} - 'customer'`,
      })
      .where(eq(paymentTransactions.userId, userId));

    // Rows that reference the user without ON DELETE CASCADE, or by email.
    await tx
      .update(userApprovalRequests)
      .set({ reviewedById: null })
      .where(eq(userApprovalRequests.reviewedById, userId));
    await tx.delete(userApprovalRequests).where(eq(userApprovalRequests.email, email));
    await tx.delete(magicLinkTokens).where(eq(magicLinkTokens.email, email));
    await tx.delete(accountDeletionTokens).where(eq(accountDeletionTokens.email, email));

    // Children. All of these also cascade from the FK; deleting them explicitly keeps
    // the behaviour visible here and independent of the constraint definitions.
    await tx.delete(refreshTokens).where(eq(refreshTokens.userId, userId));
    await tx.delete(deviceActivations).where(eq(deviceActivations.userId, userId));
    await tx.delete(userGroupMemberships).where(eq(userGroupMemberships.userId, userId));
    await tx.delete(userEventAttendance).where(eq(userEventAttendance.userId, userId));
    await tx.delete(userProgress).where(eq(userProgress.userId, userId));
    await tx.delete(bookmarks).where(eq(bookmarks.userId, userId));
    await tx.delete(eventBookmarks).where(eq(eventBookmarks.userId, userId));
    await tx.delete(trackBookmarks).where(eq(trackBookmarks.userId, userId));
    await tx.delete(videoBookmarks).where(eq(videoBookmarks.userId, userId));
    await tx.delete(videoProgress).where(eq(videoProgress.userId, userId));
    await tx.delete(downloadRequests).where(eq(downloadRequests.userId, userId));
    await tx.delete(publicationAccessUsers).where(eq(publicationAccessUsers.userId, userId));
    await tx.delete(userSyncVersions).where(eq(userSyncVersions.userId, userId));

    await tx.delete(users).where(eq(users.id, userId));
  });
}

/**
 * Stop the member's Easypay subscription. Reuses the webhook's deactivation call
 * (PATCH status=inactive, 404 treated as already gone). Nothing to do for members who
 * never paid through Easypay, for mock subscriptions, in mock mode, or when the member
 * already cancelled (that call already stopped it at Easypay).
 */
async function stopRecurringPayment(user: {
  easypaySubscriptionId: string | null;
  subscriptionCancelledAt: Date | null;
}): Promise<void> {
  const id = user.easypaySubscriptionId;
  if (!id || id.startsWith("mock_") || !config.easypay.accountId) return;
  if (user.subscriptionCancelledAt) return;

  const result = await deactivateAtEasypay(id);
  if (result === "failed") {
    throw new AppError(
      502,
      "We could not cancel your recurring payment, so your account was not deleted. Please try again in a few minutes.",
      "PAYMENT_CANCEL_FAILED",
    );
  }
}

import { eq } from "drizzle-orm";
import { db } from "../db/index.ts";
import { users } from "../db/schema/users.ts";
import { deviceActivations } from "../db/schema/auth.ts";
import { hashDeviceFingerprint } from "../lib/device-fingerprint.ts";

export interface DeviceInfo {
  /** As the app sends it; only its hash is stored. */
  fingerprint: string;
  name: string;
  type: string;
  ipAddress: string | null;
  userAgent: string | null;
}

/**
 * Activate a device for a user, exactly as a clicked magic link does: mark the
 * user verified, create the device activation or reactivate (and re-assign) an
 * existing one, and refresh the user's last activity. Shared by the in-app
 * sign-in routes (`/verify-code`, `/review-login`).
 */
export async function activateDeviceForUser(
  user: { id: number; isVerified: boolean },
  device: DeviceInfo,
): Promise<void> {
  if (!user.isVerified) {
    await db
      .update(users)
      .set({ isVerified: true, updatedAt: new Date() })
      .where(eq(users.id, user.id));
  }

  const fingerprintHash = hashDeviceFingerprint(device.fingerprint);
  const existingDevice = await db.query.deviceActivations.findFirst({
    where: eq(deviceActivations.deviceFingerprint, fingerprintHash),
  });

  if (existingDevice) {
    await db
      .update(deviceActivations)
      .set({
        isActive: true,
        userId: user.id,
        deviceName: device.name,
        deviceType: device.type,
        lastUsed: new Date(),
        ipAddress: device.ipAddress,
        userAgent: device.userAgent,
        // This sign-in hands its tokens over directly: nothing is left for discover.
        pendingClaim: false,
      })
      .where(eq(deviceActivations.id, existingDevice.id));
  } else {
    await db.insert(deviceActivations).values({
      userId: user.id,
      deviceFingerprint: fingerprintHash,
      deviceName: device.name,
      deviceType: device.type,
      ipAddress: device.ipAddress,
      userAgent: device.userAgent,
    });
  }

  await db
    .update(users)
    .set({ lastActivity: new Date(), updatedAt: new Date() })
    .where(eq(users.id, user.id));
}

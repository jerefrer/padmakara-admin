import { eq } from "drizzle-orm";
import { db } from "../db/index.ts";
import { users } from "../db/schema/users.ts";
import { deviceActivations } from "../db/schema/auth.ts";

export interface DeviceInfo {
  fingerprint: string;
  name: string;
  type: string;
  ipAddress: string | null;
  userAgent: string | null;
}

/**
 * Activate a device for a user, exactly as a clicked magic link does: mark the
 * user verified, create the device activation or reactivate (and re-assign) an
 * existing one, and refresh the user's last activity. Shared by
 * `/auto-activate` and `/review-login`.
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

  const existingDevice = await db.query.deviceActivations.findFirst({
    where: eq(deviceActivations.deviceFingerprint, device.fingerprint),
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
      })
      .where(eq(deviceActivations.id, existingDevice.id));
  } else {
    await db.insert(deviceActivations).values({
      userId: user.id,
      deviceFingerprint: device.fingerprint,
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

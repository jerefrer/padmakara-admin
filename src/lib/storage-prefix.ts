import { eq } from "drizzle-orm";
import { db } from "../db/index.ts";
import { events } from "../db/schema/retreats.ts";

/**
 * The `events/<folder>/` folder to upload under for an event code the admin sends.
 *
 * An event's folder is fixed when it is created (`events.storage_prefix`) while its
 * code stays editable, so the code the admin page holds may differ from the folder.
 * An unknown code is an event that is not saved yet: it gets its code as folder,
 * which is exactly what the create route stores as its `storage_prefix`.
 */
export async function resolveStoragePrefix(eventCode: string): Promise<string> {
  const row = await db.query.events.findFirst({
    where: eq(events.eventCode, eventCode),
    columns: { storagePrefix: true },
  });
  return row?.storagePrefix ?? eventCode;
}

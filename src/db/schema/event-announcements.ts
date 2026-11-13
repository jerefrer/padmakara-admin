import { pgTable, serial, integer, text, timestamp, index } from "drizzle-orm/pg-core";
import { events } from "./retreats.ts";
import { users } from "./users.ts";

/**
 * One row per "new content" email sent for an event (transcripts, videos with subtitles,
 * related texts). Used to warn before announcing the same kind twice and to show the history.
 */
export const eventAnnouncements = pgTable(
  "event_announcements",
  {
    id: serial("id").primaryKey(),
    eventId: integer("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    /** Subset of "transcripts" | "videos" | "texts" (see lib/announcement-kinds.ts). */
    kinds: text("kinds").array().notNull(),
    message: text("message"),
    recipientCount: integer("recipient_count").notNull(),
    sentBy: integer("sent_by").references(() => users.id, { onDelete: "set null" }),
    sentAt: timestamp("sent_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("event_announcements_event_id_idx").on(t.eventId)],
);

import { pgTable, serial, text, integer, date, timestamp, index, boolean, jsonb } from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { events } from "./retreats.ts";
import type { SlideDocument } from "../../lib/slides/types.ts";

export const eventVideos = pgTable(
  "event_videos",
  {
    id: serial("id").primaryKey(),
    eventId: integer("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    // Bunny Stream video GUID. One recording file = one row.
    // Null until the slide burn-in pipeline completes and the webhook
    // supplies the guid — the row exists from upload time so slides and
    // burn status have somewhere to live. See migration 0037.
    bunnyVideoId: text("bunny_video_id"),
    // Playback order within the event (0-based).
    position: integer("position").notNull().default(0),
    // Optional human labels. Null → clients derive a fallback from
    // videoDate / position ("Part N").
    titleEn: text("title_en"),
    titlePt: text("title_pt"),
    // Optional recording date — labeling/ordering hint only. A video may
    // cover any slice of the event (one session, a morning, a full day).
    videoDate: date("video_date", { mode: "string" }),
    durationSeconds: integer("duration_seconds"),
    posterUrl: text("poster_url"),
    // Title-slide document (intro/outro), authored in the admin and shared
    // verbatim with the burn container via src/lib/slides/render.ts. Null
    // until an admin defines slides for this video.
    slides: jsonb("slides").$type<SlideDocument>(),
    // Admin assertion that the uploaded file already has slides burnt in —
    // skips the burn pipeline entirely for this video.
    hasBurnedSlides: boolean("has_burned_slides").notNull().default(false),
    // Burn pipeline lifecycle: none | pending | queued | running | done | failed.
    // Mirrors subtitle_jobs / read_along_jobs. "pending" also means "slides
    // changed since the last successful burn — needs a re-burn".
    burnStatus: text("burn_status").notNull().default("none"),
    // AWS Batch job id for the in-flight (or most recent) burn, for reconciliation.
    burnJobId: text("burn_job_id"),
    // Retained master recording's S3 key, so a slide edit can re-burn without
    // re-uploading the source file.
    masterS3Key: text("master_s3_key"),
    burnError: text("burn_error"),
    // Duration of the burned-in intro, so a later re-burn with a different
    // intro length can offset saved resume positions by the delta.
    burnedIntroMs: integer("burned_intro_ms"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("event_videos_event_id_idx").on(t.eventId),
    // Webhook + playback look videos up by their Bunny GUID.
    index("event_videos_bunny_video_id_idx").on(t.bunnyVideoId),
  ],
);

export const eventVideosRelations = relations(eventVideos, ({ one }) => ({
  event: one(events, {
    fields: [eventVideos.eventId],
    references: [events.id],
  }),
}));

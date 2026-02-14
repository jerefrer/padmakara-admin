/**
 * Test that event query includes transcripts
 */

import { db } from "../db/index.ts";
import { events } from "../db/schema/retreats.ts";
import { eq } from "drizzle-orm";

const eventId = 610; // 202012-KPS-PP3-VID

console.log(`\nQuerying event ${eventId}...\n`);

const event = await db.query.events.findFirst({
  where: eq(events.id, eventId),
  with: {
    eventType: true,
    audience: true,
    sessions: {
      with: { tracks: true },
      orderBy: (s: any, { asc }: any) => [asc(s.sessionNumber)],
    },
    transcripts: true,
    eventFiles: true,
    eventTeachers: { with: { teacher: true } },
    eventRetreatGroups: { with: { retreatGroup: true } },
    eventPlaces: { with: { place: true } },
  },
});

if (!event) {
  console.log("Event not found!");
  process.exit(1);
}

console.log("Event Code:", event.eventCode);
console.log("Event Title:", event.titleEn);
console.log("\nTranscripts:", event.transcripts?.length || 0);

if (event.transcripts && event.transcripts.length > 0) {
  console.log("\nTranscript details:");
  for (const t of event.transcripts) {
    console.log(`  - [${t.language}] ${t.originalFilename} (${t.fileSizeBytes} bytes)`);
  }
} else {
  console.log("\n❌ No transcripts returned!");
}

console.log("\nSessions:", event.sessions?.length || 0);
console.log("Event Files:", event.eventFiles?.length || 0);

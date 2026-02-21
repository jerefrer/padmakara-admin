import { db } from "../db/index.ts";

const canonicalCode = process.argv[2];
if (!canonicalCode) {
  console.error("Usage: bun run src/scripts/check-event.ts <canonicalCode>");
  process.exit(1);
}

// Use db.query API which is simpler
const event = await db.query.events.findFirst({
  where: (e, { eq }) => eq(e.eventCode, canonicalCode),
  with: {
    sessions: {
      with: {
        tracks: true,
      },
    },
    transcripts: true,
  },
});

if (!event) {
  console.log(`Event not found: ${canonicalCode}`);
  process.exit(0);
}

console.log(`\nEvent: ${event.titleEn} (id: ${event.id})`);
console.log(`Sessions: ${event.sessions.length}`);

console.log("\n=== TRACKS ===");
for (const session of event.sessions) {
  console.log(`\nSession ${session.sessionNumber}: ${session.titleEn}`);
  for (const track of session.tracks) {
    console.log(`  #${track.trackNumber} [${track.language}] ${track.originalFilename}`);
  }
}

const transcripts = event.transcripts || [];
console.log(`\n=== TRANSCRIPTS (${transcripts.length}) ===`);
for (const t of transcripts) {
  console.log(`  [${t.language}] ${t.originalFilename} (sessionId: ${t.sessionId || "none"})`);
}

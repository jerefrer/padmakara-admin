/**
 * Test the admin API endpoint directly
 */

const API_URL = "http://localhost:3000";
const eventId = 610;

console.log(`\nTesting API endpoint: GET /api/admin/events/${eventId}\n`);

try {
  const response = await fetch(`${API_URL}/api/admin/events/${eventId}`, {
    headers: {
      // No auth for testing - will fail but shows us the endpoint behavior
    },
  });

  console.log("Status:", response.status);
  console.log("Status Text:", response.statusText);

  const data = await response.json();

  if (response.status === 401) {
    console.log("\n❌ Unauthorized (expected without auth token)");
    console.log("Error:", data);
  } else if (response.ok) {
    console.log("\n✅ Success!");
    console.log("Event Code:", data.eventCode);
    console.log("Event Title:", data.titleEn);
    console.log("Transcripts:", data.transcripts?.length || 0);
    console.log("Sessions:", data.sessions?.length || 0);
    console.log("Event Files:", data.eventFiles?.length || 0);

    if (data.transcripts && data.transcripts.length > 0) {
      console.log("\nTranscript details:");
      for (const t of data.transcripts) {
        console.log(`  - [${t.language}] ${t.originalFilename}`);
      }
    } else {
      console.log("\n⚠️ No transcripts in API response");
    }
  } else {
    console.log("\n❌ API Error");
    console.log("Response:", data);
  }
} catch (error) {
  console.error("\n❌ Request failed:", error);
}

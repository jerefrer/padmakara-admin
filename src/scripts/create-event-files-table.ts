import { sql } from "drizzle-orm";
import { db } from "../db/index.ts";

console.log("Creating event_files table...");

await db.execute(sql`
  CREATE TABLE IF NOT EXISTS event_files (
    id SERIAL PRIMARY KEY,
    event_id INTEGER NOT NULL REFERENCES retreats(id) ON DELETE CASCADE,
    session_id INTEGER REFERENCES sessions(id) ON DELETE SET NULL,
    original_filename TEXT NOT NULL,
    s3_key TEXT NOT NULL,
    file_type TEXT NOT NULL,
    extension TEXT NOT NULL,
    file_size_bytes BIGINT,
    language TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW() NOT NULL,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW() NOT NULL
  );
`);

console.log("✓ Table created successfully");

process.exit(0);

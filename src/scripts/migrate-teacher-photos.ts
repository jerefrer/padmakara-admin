/**
 * One-time migration: download existing teacher photoUrl images,
 * create avatar (400x400 center crop) and hero (1200px wide) versions,
 * upload to S3, and update DB records.
 *
 * Usage: bun src/scripts/migrate-teacher-photos.ts
 */
import { db } from "../db/index.ts";
import { teachers } from "../db/schema/teachers.ts";
import { putObject, buildTeacherAvatarS3Key, buildTeacherHeroS3Key } from "../services/s3.ts";
import { isNotNull, eq } from "drizzle-orm";
import sharp from "sharp";

async function main() {
  console.log("Starting teacher photo migration...");

  const teachersWithPhotos = await db
    .select()
    .from(teachers)
    .where(isNotNull(teachers.photoUrl));

  console.log(`Found ${teachersWithPhotos.length} teachers with photos`);

  for (const teacher of teachersWithPhotos) {
    console.log(`\nProcessing: ${teacher.name} (${teacher.abbreviation})`);
    console.log(`  photoUrl: ${teacher.photoUrl}`);

    try {
      const response = await fetch(teacher.photoUrl!);
      if (!response.ok) {
        console.error(`  FAILED: HTTP ${response.status} downloading image`);
        continue;
      }

      const arrayBuffer = await response.arrayBuffer();
      const imageBuffer = Buffer.from(arrayBuffer);
      console.log(`  Downloaded: ${imageBuffer.length} bytes`);

      // Create avatar: 400x400 center crop
      const avatarBuffer = await sharp(imageBuffer)
        .resize(400, 400, { fit: "cover", position: "centre" })
        .jpeg({ quality: 90 })
        .toBuffer();

      const avatarS3Key = buildTeacherAvatarS3Key(teacher.id, "jpg");
      await putObject(avatarS3Key, avatarBuffer, "image/jpeg");
      console.log(`  Avatar uploaded: ${avatarS3Key} (${avatarBuffer.length} bytes)`);

      // Create hero: 1200px wide, maintain aspect ratio
      const heroBuffer = await sharp(imageBuffer)
        .resize(1200, null, { fit: "inside", withoutEnlargement: true })
        .jpeg({ quality: 85 })
        .toBuffer();

      const heroS3Key = buildTeacherHeroS3Key(teacher.id, "jpg");
      await putObject(heroS3Key, heroBuffer, "image/jpeg");
      console.log(`  Hero uploaded: ${heroS3Key} (${heroBuffer.length} bytes)`);

      // Update DB
      const now = new Date();
      await db
        .update(teachers)
        .set({
          avatarS3Key,
          heroS3Key,
          avatarUpdatedAt: now,
          heroUpdatedAt: now,
          updatedAt: now,
        })
        .where(eq(teachers.id, teacher.id));

      console.log(`  DB updated successfully`);
    } catch (err) {
      console.error(`  FAILED: ${err instanceof Error ? err.message : err}`);
    }
  }

  console.log("\nMigration complete!");
  process.exit(0);
}

main();

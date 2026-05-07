/**
 * Reprocess every avatar / hero image already in S3 through the current
 * `services/image-pipeline.ts` config. Brings legacy uploads (full-size
 * JPEGs from before the server-side resize landed) down to the canonical
 * 400×400 avatar / 2400px desktop hero / 1200px mobile hero WebPs, and
 * back-fills `hero_mobile_s3_key` for records that pre-date the variant
 * rollout.
 *
 * Sharp can only downscale — sources already smaller than the canonical
 * dimensions stay at their native size (`withoutEnlargement: true`).
 *
 * Usage:
 *   bun src/scripts/reprocess-images.ts          # do the work
 *   bun src/scripts/reprocess-images.ts --dry    # report only, no writes
 */
import { eq, isNotNull, or } from "drizzle-orm";
import { db } from "../db/index.ts";
import { teachers } from "../db/schema/teachers.ts";
import { retreatGroups } from "../db/schema/retreat-groups.ts";
import {
  generatePresignedDownloadUrl,
  putObject,
  deleteObject,
  buildTeacherAvatarS3Key,
  buildTeacherHeroS3Key,
  buildTeacherHeroMobileS3Key,
  buildGroupAvatarS3Key,
  buildGroupHeroS3Key,
  buildGroupHeroMobileS3Key,
} from "../services/s3.ts";
import {
  processAvatar,
  processHero,
  processHeroMobile,
} from "../services/image-pipeline.ts";

const DRY_RUN = process.argv.includes("--dry");

async function downloadFromS3(key: string): Promise<Buffer> {
  const url = await generatePresignedDownloadUrl(key, 300);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} downloading ${key}`);
  return Buffer.from(await res.arrayBuffer());
}

interface Counters {
  avatarsProcessed: number;
  heroesProcessed: number;
  mobileVariantsAdded: number;
  bytesIn: number;
  bytesOut: number;
  failures: number;
}

const counters: Counters = {
  avatarsProcessed: 0,
  heroesProcessed: 0,
  mobileVariantsAdded: 0,
  bytesIn: 0,
  bytesOut: 0,
  failures: 0,
};

function log(line: string): void {
  process.stdout.write(line + "\n");
}

async function reprocessTeachers(): Promise<void> {
  const rows = await db
    .select()
    .from(teachers)
    .where(or(isNotNull(teachers.avatarS3Key), isNotNull(teachers.heroS3Key)));

  log(`\n=== Teachers (${rows.length} with images) ===`);

  for (const t of rows) {
    log(`\n• ${t.name} (#${t.id})`);

    if (t.avatarS3Key) {
      try {
        const src = await downloadFromS3(t.avatarS3Key);
        counters.bytesIn += src.length;
        const out = await processAvatar(src);
        counters.bytesOut += out.length;
        const newKey = buildTeacherAvatarS3Key(t.id, "webp");
        log(`    avatar: ${src.length}→${out.length}B  ${t.avatarS3Key} → ${newKey}`);

        if (!DRY_RUN) {
          await putObject(newKey, out, "image/webp");
          await db
            .update(teachers)
            .set({ avatarS3Key: newKey, avatarUpdatedAt: new Date(), updatedAt: new Date() })
            .where(eq(teachers.id, t.id));
          if (t.avatarS3Key !== newKey) {
            await deleteObject(t.avatarS3Key).catch(() => {});
          }
        }
        counters.avatarsProcessed++;
      } catch (err) {
        log(`    avatar FAILED: ${err instanceof Error ? err.message : err}`);
        counters.failures++;
      }
    }

    if (t.heroS3Key) {
      try {
        const src = await downloadFromS3(t.heroS3Key);
        counters.bytesIn += src.length;
        const [desktop, mobile] = await Promise.all([
          processHero(src),
          processHeroMobile(src),
        ]);
        counters.bytesOut += desktop.length + mobile.length;
        const newDesktopKey = buildTeacherHeroS3Key(t.id, "webp");
        const newMobileKey = buildTeacherHeroMobileS3Key(t.id, "webp");
        log(
          `    hero  : ${src.length}B → desktop ${desktop.length}B + mobile ${mobile.length}B`,
        );

        if (!DRY_RUN) {
          await Promise.all([
            putObject(newDesktopKey, desktop, "image/webp"),
            putObject(newMobileKey, mobile, "image/webp"),
          ]);
          await db
            .update(teachers)
            .set({
              heroS3Key: newDesktopKey,
              heroMobileS3Key: newMobileKey,
              heroUpdatedAt: new Date(),
              updatedAt: new Date(),
            })
            .where(eq(teachers.id, t.id));
          if (t.heroS3Key !== newDesktopKey) {
            await deleteObject(t.heroS3Key).catch(() => {});
          }
          if (t.heroMobileS3Key && t.heroMobileS3Key !== newMobileKey) {
            await deleteObject(t.heroMobileS3Key).catch(() => {});
          }
        }
        counters.heroesProcessed++;
        if (!t.heroMobileS3Key) counters.mobileVariantsAdded++;
      } catch (err) {
        log(`    hero FAILED: ${err instanceof Error ? err.message : err}`);
        counters.failures++;
      }
    }
  }
}

async function reprocessGroups(): Promise<void> {
  const rows = await db
    .select()
    .from(retreatGroups)
    .where(
      or(isNotNull(retreatGroups.avatarS3Key), isNotNull(retreatGroups.heroS3Key)),
    );

  log(`\n=== Groups (${rows.length} with images) ===`);

  for (const g of rows) {
    log(`\n• ${g.nameEn} (#${g.id})`);

    if (g.avatarS3Key) {
      try {
        const src = await downloadFromS3(g.avatarS3Key);
        counters.bytesIn += src.length;
        const out = await processAvatar(src);
        counters.bytesOut += out.length;
        const newKey = buildGroupAvatarS3Key(g.id, "webp");
        log(`    avatar: ${src.length}→${out.length}B  ${g.avatarS3Key} → ${newKey}`);

        if (!DRY_RUN) {
          await putObject(newKey, out, "image/webp");
          await db
            .update(retreatGroups)
            .set({ avatarS3Key: newKey, avatarUpdatedAt: new Date(), updatedAt: new Date() })
            .where(eq(retreatGroups.id, g.id));
          if (g.avatarS3Key !== newKey) {
            await deleteObject(g.avatarS3Key).catch(() => {});
          }
        }
        counters.avatarsProcessed++;
      } catch (err) {
        log(`    avatar FAILED: ${err instanceof Error ? err.message : err}`);
        counters.failures++;
      }
    }

    if (g.heroS3Key) {
      try {
        const src = await downloadFromS3(g.heroS3Key);
        counters.bytesIn += src.length;
        const [desktop, mobile] = await Promise.all([
          processHero(src),
          processHeroMobile(src),
        ]);
        counters.bytesOut += desktop.length + mobile.length;
        const newDesktopKey = buildGroupHeroS3Key(g.id, "webp");
        const newMobileKey = buildGroupHeroMobileS3Key(g.id, "webp");
        log(
          `    hero  : ${src.length}B → desktop ${desktop.length}B + mobile ${mobile.length}B`,
        );

        if (!DRY_RUN) {
          await Promise.all([
            putObject(newDesktopKey, desktop, "image/webp"),
            putObject(newMobileKey, mobile, "image/webp"),
          ]);
          await db
            .update(retreatGroups)
            .set({
              heroS3Key: newDesktopKey,
              heroMobileS3Key: newMobileKey,
              heroUpdatedAt: new Date(),
              updatedAt: new Date(),
            })
            .where(eq(retreatGroups.id, g.id));
          if (g.heroS3Key !== newDesktopKey) {
            await deleteObject(g.heroS3Key).catch(() => {});
          }
          if (g.heroMobileS3Key && g.heroMobileS3Key !== newMobileKey) {
            await deleteObject(g.heroMobileS3Key).catch(() => {});
          }
        }
        counters.heroesProcessed++;
        if (!g.heroMobileS3Key) counters.mobileVariantsAdded++;
      } catch (err) {
        log(`    hero FAILED: ${err instanceof Error ? err.message : err}`);
        counters.failures++;
      }
    }
  }
}

async function main(): Promise<void> {
  log(`reprocess-images${DRY_RUN ? " (DRY RUN — no S3 writes, no DB updates)" : ""}`);

  await reprocessTeachers();
  await reprocessGroups();

  const savedBytes = counters.bytesIn - counters.bytesOut;
  const ratio =
    counters.bytesIn > 0 ? (savedBytes / counters.bytesIn) * 100 : 0;

  log("\n=== Summary ===");
  log(`  avatars processed     : ${counters.avatarsProcessed}`);
  log(`  heroes processed      : ${counters.heroesProcessed}`);
  log(`  mobile variants added : ${counters.mobileVariantsAdded}`);
  log(`  bytes in              : ${counters.bytesIn}`);
  log(`  bytes out             : ${counters.bytesOut}`);
  log(`  saved                 : ${savedBytes} (${ratio.toFixed(1)}%)`);
  log(`  failures              : ${counters.failures}`);

  process.exit(counters.failures > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});

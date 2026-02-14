# Wix to Padmakara API Migration Guide

## 📋 Overview

This guide covers the complete data migration from Wix to the new Padmakara API system. The migration consists of three phases:

1. **Validation Phase**: Verify data quality, S3 files, and reference integrity (READ-ONLY)
2. **Extraction Phase**: Extract individual MP3 files from ZIP archives to new bucket
3. **Migration Phase**: Import events, sessions, tracks, and transcripts into PostgreSQL

## 🔒 Safety Guarantees

### Validation Mode (--validate-only)
**GUARANTEED READ-ONLY**: No writes to database or S3
- ✅ Reads S3 metadata (list files, check existence)
- ✅ Reads CSV data
- ✅ Validates mappings
- ❌ **NEVER** writes to database
- ❌ **NEVER** writes to S3
- ❌ **NEVER** triggers Lambda extraction

### Dry Run Mode (--dry-run)
**GUARANTEED READ-ONLY**: No writes to database
- ✅ Simulates full migration logic
- ✅ Reads S3 metadata
- ✅ Shows what would be created
- ❌ **NEVER** writes to database
- ❌ Does not verify S3 in detail (faster)

## 🪣 S3 Bucket Strategy

**Source**: `padmakara-pt` (old production bucket)
**Target**: `padmakara-pt-sample` (migration target, configured in .env)

### Migration Flow
1. ZIPs remain in `padmakara-pt` (untouched)
2. Lambda extracts to `padmakara-pt-sample` with new structure
3. Database records point to `padmakara-pt-sample`
4. When ready for production, swap bucket or copy files

## 🏗️ Architecture & Terminology

**Important**: We use "events" terminology consistently throughout (not "retreats"). The database table is `retreats` for historical reasons, but code references use `events`.

### Data Flow

```
Wix CSV Export
    ↓
Validation (--validate-only)
    ↓
S3 State Check (ZIP → individual MP3s)
    ↓
Database Migration
    ↓
Event Records + Sessions + Tracks + Transcripts
```

## 📁 New Files Created

1. **[s3-utils.ts](padmakara-api/src/scripts/s3-utils.ts)** - S3 verification and Lambda integration
2. **[migrate-from-wix-v2.ts](padmakara-api/src/scripts/migrate-from-wix-v2.ts)** - Enhanced migration script
3. **[csv-parser.ts](padmakara-api/src/scripts/csv-parser.ts)** - Updated with field mapping utilities

## 🚀 Quick Start

### Prerequisites

```bash
# 1. Install dependencies
cd padmakara-api
bun install

# 2. Ensure database is migrated
bun run db:migrate

# 3. Run seed script to populate reference data
bun run src/scripts/seed-from-csv.ts wix-export-20250821.csv
```

### Step 1: Validation

```bash
# Run validation-only mode to check data quality
bun run src/scripts/migrate-from-wix-v2.ts wix-export-20250821.csv --validate-only

# Review the generated report
cat migration-report.json | jq '.issues[] | select(.severity=="error")'
```

### Step 2: Dry Run

```bash
# Test migration without database writes
bun run src/scripts/migrate-from-wix-v2.ts wix-export-20250821.csv --dry-run
```

### Step 3: Phased Migration

```bash
# Process first 10 events as test
bun run src/scripts/migrate-from-wix-v2.ts wix-export-20250821.csv --limit 10

# Check results in database
psql $DATABASE_URL -c "SELECT event_code, title_en, status FROM retreats ORDER BY created_at DESC LIMIT 10;"

# Continue with next batch
bun run src/scripts/migrate-from-wix-v2.ts wix-export-20250821.csv --skip 10 --limit 20

# Full migration (processes all remaining events)
bun run src/scripts/migrate-from-wix-v2.ts wix-export-20250821.csv
```

### Step 4: Resume After Interruption

```bash
# If migration stops, resume from last checkpoint
bun run src/scripts/migrate-from-wix-v2.ts wix-export-20250821.csv --resume migration-state.json
```

## 🎛️ Command-Line Options

| Option | Description | Example |
|--------|-------------|---------|
| `--dry-run` | Simulate without DB writes | `--dry-run` |
| `--validate-only` | Validate data and S3, no migration | `--validate-only` |
| `--limit N` | Process only N events | `--limit 10` |
| `--skip N` | Skip first N events | `--skip 50` |
| `--resume FILE` | Resume from state file | `--resume migration-state.json` |
| `--output FILE` | Custom report filename | `--output my-report.json` |

## 📊 Validation Report Structure

The `migration-report.json` file contains:

```json
{
  "totalEvents": 192,
  "processedEvents": 192,
  "validEvents": 185,
  "issues": [
    {
      "severity": "error|warning|info",
      "category": "s3|mapping|data|count",
      "message": "Description of issue",
      "eventCode": "20100308-MTR-CFR-ACM",
      "details": { ... }
    }
  ],
  "unmappedEventTypes": ["Conferência Special", ...],
  "unmappedAudiences": ["Custom Audience", ...],
  "s3States": {
    "20100308-MTR-CFR-ACM": {
      "state": "EXTRACTED|ZIP_ONLY|PARTIAL|MISSING",
      "extractedFiles": [...],
      "missingFiles": [...],
      "expectedTrackCount": 13,
      "actualFileCount": 13
    }
  },
  "trackCountMismatches": [...],
  "migrationState": { ... }
}
```

## 🔍 Key Features

### 1. Events Terminology

Uses "events" consistently instead of mixed "retreats/events" terminology.

### 2. Field Mapping

**Event Types**: Maps CSV `currentDesignation` → database `eventTypeId`
- Uses fuzzy matching (Portuguese/English, partial matches)
- Reports unmapped values for team review

**Audiences**: Maps CSV `distributionAudience` → database `audienceId`
- Same fuzzy matching approach
- Tracks unmapped audience strings

### 3. S3 Verification

Checks S3 state for each event:
- **EXTRACTED**: Individual MP3s ready to use ✅
- **ZIP_ONLY**: ZIPs exist, extraction needed ⚠️
- **PARTIAL**: Some files missing 🔶
- **MISSING**: No files found ❌

### 4. Transactional & Resumable

- Saves state every 10 events to `migration-state.json`
- Resume from exact position after interruption
- No duplicate processing
- Failed events tracked separately

### 5. Progress Tracking

```
🔄 [45/192] 20171114_20-KPS-WFL-ENS-VLH: O Nono Capítulo da Via do Bodhisattva
   🔍 Inferred teacher: Khenchen Pema Sherab Rinpoche
   ✓ Event created (ID: 123)
   ✓ Created 15 sessions, 356 tracks
```

### 6. Track Count Verification

Compares CSV track count field with parsed filenames:
- Reports mismatches as warnings
- Helps identify parsing issues or incomplete data

### 7. Teacher/Place Inference

Attempts to infer missing teachers and places from event codes:
- Event code `20100308-MTR-CFR-ACM` → Teacher "MTR" (Matthieu Ricard)
- Event code `20171114-LIS-...` → Place "Lisboa"

### 8. Latest Events First

Processes events in reverse chronological order:
- Latest events (2025, 2024, 2023...) processed first
- Ensures recent content available quickly
- Older events (with potentially different patterns) handled last

## 🗂️ S3 Data Strategy

### Current State

CSV contains URLs to ZIP files:
```
https://padmakara-pt.s3.eu-west-3.amazonaws.com/mediateca/EVENT-CODE/Audio1/file.zip
```

### Recommended Approach

**Use existing Lambda** (`padmakara-zip-generator` from .env):

1. **Validation identifies** events with ZIP_ONLY state
2. **Trigger Lambda** to extract individual MP3s
3. **Lambda reads ZIP** from S3 (no bandwidth cost)
4. **Lambda writes MP3s** back to S3 at expected paths
5. **Migration creates** DB records pointing to extracted files

### Cost Analysis

| Approach | Bandwidth Cost | Processing Cost | Total |
|----------|----------------|-----------------|-------|
| Download/Reupload | ~$35 | Minimal | ~$35 |
| Lambda Extraction | $0 (internal) | ~$1 | ~$1 |

**Recommendation**: Lambda extraction saves ~$34 and enables parallel processing.

### S3 Path Structure

**Old Bucket** (`padmakara-pt`):
```
padmakara-pt/
├── mediateca/
│   └── 2010-03-08-MTR-CFR-ACM/
│       ├── Audio1/
│       │   └── 20100308-MTR-CFR-ACM.zip    ← ZIP file
│       └── audio2/
│           └── translations.zip             ← Translation ZIP
```

**New Bucket** (`padmakara-pt-sample`):
```
padmakara-pt-sample/
├── mediateca/
│   ├── 2010-03-08-MTR-CFR-ACM/
│   │   ├── 001 Introduction.mp3        ← Extracted by Lambda
│   │   ├── 002 Talk.mp3
│   │   ├── ...
│   │   └── audio2/                     ← Translations
│   │       ├── 001_TRAD Introducao.mp3
│   │       └── ...
│   └── 2017-11-14-KPS-WFL-ENS/
│       ├── 01 KPS [TIB] Prayers.mp3
│       ├── 01_KPS [ENG] Prayers.mp3
│       └── ...
```

### Extraction Process

```bash
# 1. Run validation to identify events needing extraction
bun run src/scripts/migrate-from-wix-v2.ts wix-export-20250821.csv --validate-only

# 2. Extract ZIPs to new bucket with new structure
bun run src/scripts/extract-s3-files.ts migration-report.json

# 3. Verify extraction succeeded
bun run src/scripts/migrate-from-wix-v2.ts wix-export-20250821.csv --validate-only

# 4. Proceed with migration
bun run src/scripts/migrate-from-wix-v2.ts wix-export-20250821.csv
```

## ⚠️ Common Issues & Solutions

### Issue: "Event type not found for designation: X"

**Cause**: CSV designation doesn't match seeded event types.

**Solution**:
1. Check `unmappedEventTypes` in report
2. Add missing types to `seed-from-csv.ts` RETREAT_GROUPS or EVENT_TYPE_DESIGNATIONS
3. Re-run seed script
4. Re-run migration

### Issue: "Teacher not found: X"

**Cause**: Teacher name in CSV not seeded, or name mismatch.

**Solution**:
1. Check exact name in CSV
2. Verify teacher exists in database: `SELECT * FROM teachers WHERE name ILIKE '%X%';`
3. If inference fails, add explicit mapping in `teacherAbbreviation()` function
4. Re-run migration with `--resume`

### Issue: S3 state "ZIP_ONLY" or "MISSING"

**Cause**: Individual MP3 files not extracted yet.

**Solution**:
1. Extract from validation report which events need extraction
2. Trigger Lambda for those events:
   ```typescript
   import { triggerZipExtraction } from "./s3-utils.ts";

   await triggerZipExtraction(
     "https://.../file.zip",
     "mediateca/EVENT-CODE"
   );
   ```
3. Re-run migration after extraction completes

### Issue: Track count mismatch

**Cause**: Filename parsing didn't recognize pattern, or CSV count incorrect.

**Solution**:
1. Check `trackCountMismatches` in report
2. Examine actual filenames in CSV for that event
3. Add new pattern to `track-parser.ts` if needed
4. Or verify CSV count field is accurate

## 📝 Knowledge Transfer Checklist

### For Wix Team

#### 1. Event Types Verification
- [ ] Review `unmappedEventTypes` from validation report
- [ ] Confirm all designation values are correct
- [ ] Provide English translations for any Portuguese-only types

#### 2. Audience Rules
- [ ] Review `unmappedAudiences` from validation report
- [ ] Document access control rules for each audience type
- [ ] Clarify any special cases

#### 3. S3 File Audit
- [ ] Verify all audio files exist in S3 (run validation)
- [ ] Check transcript PDFs are accessible
- [ ] Document any known missing or relocated files

#### 4. Track Filename Patterns
- [ ] Review sample events from different eras (2010, 2015, 2020, 2024)
- [ ] Identify any filename patterns not in parser
- [ ] Provide speaker abbreviation list

#### 5. Data Quality
- [ ] Review validation issues in report
- [ ] Identify events with incomplete data
- [ ] Decide handling for edge cases

## 🧪 Testing Strategy

### Phase 1: Validation Test (Day 1)

```bash
# Full validation without migration
bun run src/scripts/migrate-from-wix-v2.ts wix-export-20250821.csv --validate-only

# Review all issues
cat migration-report.json | jq '.issues[] | select(.severity=="error" or .severity=="warning")'

# Address critical issues before proceeding
```

### Phase 2: Sample Migration (Day 2)

```bash
# Migrate 5 recent events
bun run src/scripts/migrate-from-wix-v2.ts wix-export-20250821.csv --limit 5

# Verify in database and frontend
# - Check event details
# - Test audio playback
# - Verify access controls
```

### Phase 3: Incremental Migration (Days 3-4)

```bash
# Migrate in batches of 20-50
bun run src/scripts/migrate-from-wix-v2.ts wix-export-20250821.csv --limit 50
# Review, test, continue

bun run src/scripts/migrate-from-wix-v2.ts wix-export-20250821.csv --skip 50 --limit 50
# Repeat until complete
```

### Phase 4: Full Migration (Day 5)

```bash
# Backup database first!
pg_dump $DATABASE_URL > backup-pre-migration.sql

# Full migration
bun run src/scripts/migrate-from-wix-v2.ts wix-export-20250821.csv

# Verification queries
psql $DATABASE_URL << EOF
SELECT COUNT(*) FROM retreats;
SELECT COUNT(*) FROM sessions;
SELECT COUNT(*) FROM tracks;
SELECT COUNT(*) FROM transcripts;
EOF
```

## 📦 Generated Files

After migration, you'll have:

1. **migration-state.json** - Resumable state tracking
2. **migration-report.json** - Complete validation report
3. **Database records**:
   - ~192 events in `retreats` table
   - ~500-1000 sessions
   - ~5000-10000 tracks
   - ~200-400 transcripts

## 🎯 Success Criteria

Migration is successful when:

- ✅ All 192 events imported without fatal errors
- ✅ Event types and audiences correctly mapped
- ✅ Teachers and places linked (inferred where needed)
- ✅ Session/track hierarchy correctly established
- ✅ S3 files verified and accessible
- ✅ Track counts match expectations
- ✅ Transcripts linked to events
- ✅ Frontend can display and play content
- ✅ Access controls work correctly

## 🆘 Support

### Logs and Debugging

```bash
# Check migration progress
tail -f migration-state.json

# View S3 states
cat migration-report.json | jq '.s3States'

# Find specific event
cat migration-report.json | jq '.issues[] | select(.eventCode=="20100308-MTR-CFR-ACM")'

# Database verification
psql $DATABASE_URL -c "
  SELECT
    r.event_code,
    r.title_en,
    COUNT(DISTINCT s.id) as sessions,
    COUNT(DISTINCT t.id) as tracks
  FROM retreats r
  LEFT JOIN sessions s ON s.retreat_id = r.id
  LEFT JOIN tracks t ON t.session_id = s.id
  GROUP BY r.id
  ORDER BY r.created_at DESC
  LIMIT 20;
"
```

### Rollback

```bash
# Restore from backup
psql $DATABASE_URL < backup-pre-migration.sql

# Or delete migrated records
psql $DATABASE_URL << EOF
DELETE FROM tracks WHERE session_id IN (
  SELECT id FROM sessions WHERE retreat_id IN (
    SELECT id FROM retreats WHERE wix_id IS NOT NULL
  )
);
DELETE FROM sessions WHERE retreat_id IN (
  SELECT id FROM retreats WHERE wix_id IS NOT NULL
);
DELETE FROM transcripts WHERE retreat_id IN (
  SELECT id FROM retreats WHERE wix_id IS NOT NULL
);
DELETE FROM retreat_teachers WHERE retreat_id IN (
  SELECT id FROM retreats WHERE wix_id IS NOT NULL
);
DELETE FROM retreat_places WHERE retreat_id IN (
  SELECT id FROM retreats WHERE wix_id IS NOT NULL
);
DELETE FROM retreat_group_retreats WHERE retreat_id IN (
  SELECT id FROM retreats WHERE wix_id IS NOT NULL
);
DELETE FROM retreats WHERE wix_id IS NOT NULL;
EOF
```

## 📚 Additional Resources

- [CSV Parser](padmakara-api/src/scripts/csv-parser.ts) - Field parsing and mapping logic
- [Track Parser](padmakara-api/src/services/track-parser.ts) - Filename pattern recognition
- [S3 Utils](padmakara-api/src/scripts/s3-utils.ts) - S3 verification and Lambda integration
- [Schema](padmakara-api/src/db/schema/) - Database table definitions

---

**Migration Version**: 2.0
**Last Updated**: 2026-02-15
**Estimated Migration Time**: 30-60 minutes (depends on S3 extraction needs)

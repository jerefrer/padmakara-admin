# 🎯 Padmakara Migration Decision Workflow

> **Systematic approach to team decision-making and migration execution**

This document explains how to use the structured decision-making system to migrate Wix CSV data to the new Padmakara backend with minimal back-and-forth and manual labor.

---

## 📋 Overview

The migration system uses a **three-phase approach**:

1. **Analysis Phase** - Generate comprehensive validation report
2. **Decision Phase** - Team reviews data and makes structured decisions
3. **Execution Phase** - Migration runs automatically based on decisions

```
┌─────────────┐    ┌──────────────┐    ┌───────────────┐
│  Analysis   │ ──>│  Decisions   │ ──>│  Execution    │
│  (Report)   │    │  (YAML)      │    │  (Automated)  │
└─────────────┘    └──────────────┘    └───────────────┘
```

---

## 🚀 Quick Start

### Step 1: Generate Validation Report

```bash
cd padmakara-api
bun run migrate --csv path/to/wix-export.csv --validate-only
```

This creates `migration-report.html` with comprehensive analysis:
- All CSV events with color-coded issues
- Track count mismatches
- Legacy tracks analysis
- S3 folder structure
- Missing data and mapping issues

**📊 Open the report in your browser:**
```bash
open migration-report.html  # macOS
# or
xdg-open migration-report.html  # Linux
```

### Step 2: Review Report & Make Decisions

1. **Navigate through all tabs** in the HTML report:
   - `📊 Summary` - High-level statistics
   - `🎯 Decisions` - **START HERE** - All decision points with context
   - `🌳 Bucket Tree` - Visualize new folder structure
   - `📦 Legacy Tracks` - Events with unique audio1 tracks
   - `⚠️ Issues` - Errors, warnings, and info messages
   - `📋 Events List` - All events with expandable details
   - `🚫 No Audio` - Events without audio files

2. **Open the decision configuration file:**
   ```bash
   code migration-decisions.yaml  # VS Code
   # or
   nano migration-decisions.yaml  # Terminal editor
   ```

3. **Fill in your decisions** based on the report data:
   - Each decision has clear options and recommendations
   - Context from the report helps inform choices
   - Comments explain pros/cons of each option

### Step 3: Validate Decisions

```bash
bun run migrate --csv path/to/wix-export.csv --config migration-decisions.yaml --validate-only
```

This runs validation with your decisions applied:
- Shows how many events will be processed
- Previews the impact of your choices
- Generates updated HTML report
- **No database writes** - safe to run multiple times

### Step 4: Execute Migration

Once satisfied with validation:

```bash
bun run migrate --csv path/to/wix-export.csv --config migration-decisions.yaml --execute
```

This performs the actual migration:
- Creates event records in database
- Processes tracks according to your decisions
- Handles errors based on your rollback strategy
- Saves state for resume capability

---

## 📂 File Structure

```
padmakara-api/
├── migration-decisions.yaml       # Your decisions (fill this in)
├── migration-report.html          # Generated validation report
├── migration-state.json           # Progress state (auto-generated)
├── src/scripts/
│   ├── migrate-from-wix-v2.ts    # Main migration script
│   ├── config-reader.ts          # Config validation
│   └── html-report-generator.ts  # Report generation
└── MIGRATION-WORKFLOW.md         # This file
```

---

## 🎯 Key Decisions Explained

### Decision 1: Bucket Strategy

**Question:** Where should we extract and organize the audio files?

**Options:**

#### A) Extract in Place (`in_place`)
- Extract ZIPs in original bucket (`padmakara-pt`)
- Keep existing folder structure (inconsistent)

**Pros:**
- ✅ Simple - no bucket management
- ✅ No storage duplication
- ✅ No bucket switching needed

**Cons:**
- ❌ Inconsistent folder structure
- ❌ Complex backend code (handle multiple path patterns)
- ❌ Risk to production data
- ❌ Hard to rollback

#### B) Migrate to New Bucket (`new_bucket`) - **RECOMMENDED**
- Copy to new bucket (`padmakara-pt-sample`)
- Enforce consistent folder structure

**Pros:**
- ✅ Clean, predictable paths
- ✅ Simple backend code
- ✅ Safe testing (original untouched)
- ✅ Easy rollback
- ✅ Production-ready structure

**Cons:**
- ⚠️ Temporary storage duplication
- ⚠️ Need to switch bucket pointer later

**Configuration:**
```yaml
storage:
  strategy: new_bucket  # or: in_place
  target_bucket: padmakara-pt-sample
```

---

### Decision 2: Legacy Track Handling

**Question:** What to do with unique audio1 tracks that have no bilingual equivalent?

**Context:** The report shows how many tracks will be affected in the `📦 Legacy Tracks` tab.

**Options:**

#### A) Legacy Folder (`legacy_folder`) - **RECOMMENDED**
- Create `/legacy/` subfolder: `events/{eventCode}/legacy/{track}.mp3`
- Clear separation of bilingual vs unique tracks

**Pros:**
- ✅ Clear organization
- ✅ Easy to identify unique content
- ✅ Preserves all tracks

**Cons:**
- ⚠️ Extra folder level

#### B) Merge Main (`merge_main`)
- Include all audio1 tracks in main folder
- Mix bilingual and unique tracks

**Pros:**
- ✅ Simpler folder structure

**Cons:**
- ❌ Can't distinguish bilingual from unique
- ❌ Potential confusion

#### C) Separate Audio1 (`separate_audio1`)
- Keep audio1 and audio2 completely separate
- No merging or deduplication

**Pros:**
- ✅ Preserves original structure

**Cons:**
- ❌ Duplication of bilingual content
- ❌ Larger storage usage

**Configuration:**
```yaml
tracks:
  legacy_strategy: legacy_folder  # or: merge_main | separate_audio1
```

---

### Decision 3: Track Count Mismatches

**Question:** What to do when CSV expected count ≠ actual S3 files?

**Context:** View affected events in the `⚠️ Issues` tab (Warnings section).

**Options:**

#### A) Trust Files (`trust_files`) - **RECOMMENDED**
- Use actual S3 files, ignore CSV count
- Assumes S3 is source of truth

**Pros:**
- ✅ Uses actual data
- ✅ Continues migration

**Cons:**
- ⚠️ CSV might indicate missing files

#### B) Trust CSV (`trust_csv`)
- Fail migration if counts don't match
- Assumes CSV is source of truth

**Pros:**
- ✅ Ensures data integrity

**Cons:**
- ❌ May block valid migrations
- ❌ Requires manual intervention

#### C) Manual Review (`manual_review`)
- Skip these events
- List in report for manual decision

**Pros:**
- ✅ Safe approach

**Cons:**
- ❌ Requires individual review
- ❌ Slows migration

**Configuration:**
```yaml
tracks:
  mismatch_strategy: trust_files  # or: trust_csv | manual_review
```

---

### Decision 4: Events Without Audio

**Question:** How to handle events with no audio files?

**Context:** View these events in the `🚫 No Audio` tab.

**Options:**

#### A) Skip (`skip`)
- Don't create database records
- Only migrates events with audio

#### B) Create Placeholder (`create_placeholder`) - **RECOMMENDED**
- Create event record with `hasAudio: false` flag
- Allows transcript-only events

#### C) Manual Review (`manual_review`)
- List for manual decision per event

**Configuration:**
```yaml
content:
  no_audio_strategy: create_placeholder  # or: skip | manual_review
```

---

### Decision 5: Unmapped Data

**Question:** What to do when CSV values don't match database lookup tables?

**Context:** See unmapped event types and audiences in the report.

**Options:**

#### A) Infer (`infer`) - **RECOMMENDED**
- Attempt to infer from event code patterns
- Example: `2010-03-08-MTR-CFR-ACM` → Teacher: MTR, Place: CFR

#### B) Create Null (`create_null`)
- Create event with null for unmapped fields

#### C) Skip Event (`skip_event`)
- Don't migrate events with unmapped data

**Configuration:**
```yaml
mapping:
  unmapped_strategy: infer  # or: create_null | skip_event
  infer_teachers: true
  infer_places: true
```

---

## ⚙️ Advanced Configuration

### Execution Control

```yaml
execution:
  batch_size: 50              # Events per batch
  batch_delay_ms: 100         # Delay between batches
  s3_concurrency: 5           # Parallel S3 operations
  save_state: true            # Enable resume capability
  state_file: migration-state.json
  state_save_interval: 10     # Save every N events
```

### Validation & Safety

```yaml
validation:
  min_success_rate: 0.95      # Fail if <95% success
  fail_fast: false            # Continue on errors
  generate_html_report: true  # Create validation report
  preflight_checks:
    - s3_connectivity
    - database_connectivity
    - bucket_permissions
    - csv_integrity
```

### Rollback Strategy

```yaml
rollback:
  on_failure: keep_partial    # keep_partial | rollback_all | manual
  cleanup_original_bucket: false
  archive_to_glacier: false
  keep_migration_logs: true
  retention_days: 90
```

---

## 🔄 Resume Capability

If migration fails or is interrupted:

```bash
# Resume from saved state
bun run migrate --csv path/to/wix-export.csv --config migration-decisions.yaml --resume-from migration-state.json
```

The state file tracks:
- Processed event codes
- Skipped events
- Failed events with errors
- Last processed index

---

## 📊 Interpreting the Report

### Summary Tab
- High-level statistics
- Success rates
- Issue counts

### Decisions Tab
- **Start here** for decision-making
- All decisions with context
- Links to relevant data

### Events List Tab
- Every CSV event with status
- Color-coded by issue severity:
  - 🔴 Red = Errors
  - 🟠 Orange = Warnings
  - 🔵 Blue = Info
  - ✅ Green = No issues
- Click to expand and see:
  - All issues for that event
  - Folder contents (audio1/audio2 tracks)
  - S3 links

---

## ✅ Workflow Checklist

- [ ] 1. Generate validation report: `--validate-only`
- [ ] 2. Open and review `migration-report.html`
- [ ] 3. Navigate to `🎯 Decisions` tab
- [ ] 4. Review all other tabs for detailed data
- [ ] 5. Open `migration-decisions.yaml`
- [ ] 6. Fill in decisions based on report
- [ ] 7. Add metadata (decided_by, decision_date, etc.)
- [ ] 8. Run validation with config: `--config migration-decisions.yaml --validate-only`
- [ ] 9. Review updated report
- [ ] 10. Get team approval
- [ ] 11. Execute migration: `--config migration-decisions.yaml --execute`
- [ ] 12. Monitor progress and logs
- [ ] 13. Verify results in database
- [ ] 14. Update backend to use new bucket (if applicable)

---

## 🆘 Troubleshooting

### "Configuration validation failed"
- Check YAML syntax (indentation matters!)
- Ensure all required fields are filled
- Verify option values match allowed choices

### "S3 connectivity failed"
- Check AWS credentials in `.env`
- Verify bucket exists and permissions are correct
- Test with: `aws s3 ls s3://padmakara-pt/`

### "Database connectivity failed"
- Check database connection string
- Ensure database is running
- Verify credentials in `.env`

### Migration stopped mid-way
- Check `migration-state.json` for progress
- Review error logs
- Use `--resume-from` to continue

---

## 🎓 Best Practices

1. **Always start with validation** (`--validate-only`)
2. **Review the report thoroughly** before making decisions
3. **Test with a small subset first** (`--limit 10`)
4. **Use the default recommendations** unless you have specific requirements
5. **Document your decisions** in the metadata section
6. **Keep the HTML report** for future reference
7. **Backup your database** before executing
8. **Monitor the first few events** during execution

---

## 📞 Support

If you need help or have questions:
1. Review this workflow guide
2. Check the HTML report for detailed data
3. Examine the YAML comments for decision context
4. Contact the development team

---

**Happy Migrating! 🚀**

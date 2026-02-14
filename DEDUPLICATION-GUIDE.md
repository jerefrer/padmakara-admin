# Track Deduplication & Legacy Management Guide

## Overview

The migration script now intelligently handles track deduplication to maximize bilingual content while preserving unique tracks in a Legacy folder.

## How It Works

### Deduplication Strategy

**1. Prioritize Bilingual (audio2)**
- All tracks from audio2 (bilingual ZIPs) → main folder
- These include both English and Portuguese versions

**2. Classify audio1 Tracks**
```
For each audio1 track:
  ├─ Has bilingual equivalent in audio2?
  │  └─ YES → Mark as duplicate (skip)
  └─ NO equivalent found?
     └─ Add to Legacy folder (preserve)
```

**3. Intelligent Matching**
- Normalizes track names (removes language markers, numbers)
- Extracts core content identifier
- Uses 80% similarity threshold to find equivalents
- Handles variations: "JKR - Topic" matches "TRAD - Topic"

### Example

**Event: 20240408_09-JKR-TM1-CCA**

```
Audio1: 49 tracks (English-only)
Audio2: 100 tracks (Bilingual: 50 English + 50 Portuguese)

Analysis:
├─ 46 audio1 tracks → have bilingual equivalents (duplicates, skip)
├─ 3 audio1 tracks → unique, no match (go to Legacy/)
└─ 100 audio2 tracks → all go to main folder

Result:
main folder/
├─ 100 bilingual tracks from audio2 ✅
└─ Legacy/
    ├─ 022 JKR - Proficiency in the mind training.mp3
    ├─ 033 JKR - Consistency in the mind training.mp3
    └─ 047 JKR - Other commitments.mp3
```

## Validation Reports

### 1. Migration Report (migration-report.json)

**New Section: `legacyTracks`**

```json
{
  "legacyTracks": [
    {
      "eventCode": "20240408_09-JKR-TM1-CCA",
      "legacyCount": 3,
      "legacyTracks": ["track1.mp3", "track2.mp3", "track3.mp3"],
      "duplicates": ["dup1.mp3", "dup2.mp3", ...],
      "mainTracks": ["main1.mp3", "main2.mp3", ...]
    }
  ]
}
```

**Key Metrics:**
- Total events with Legacy tracks
- Complete list of Legacy files per event
- Duplicates identified
- Main tracks (bilingual) count

### 2. Bucket Tree Preview (bucket-tree-preview.txt)

**Generated in validation mode** - shows exactly how the bucket will be structured:

```
📁 mediateca/
  📁 20240408_09-JKR-TM1-CCA (103 files)
    ├─ 🎵 001 JKR+TRAD - Initial prayers.mp3
    ├─ 🎵 001 TRAD - Oracoes iniciais.mp3
    ├─ 🎵 002 JKR - Introduction.mp3
    ├─ 🎵 002 TRAD - Introducao.mp3
    ...
    └─ 📁 Legacy (3 files)
       ├─ 📦 022 JKR - Proficiency.mp3
       ├─ 📦 033 JKR - Consistency.mp3
       └─ 📦 047 JKR - Other commitments.mp3
```

**Legend:**
- 🎵 = Bilingual track (from audio2)
- 📦 = Legacy track (unique from audio1)
- 📁 = Folder

## Current Statistics

**From Latest Validation:**

```
Events Analyzed: 192 total
  └─ With bilingual content: 80 events

Track Classification:
  ├─ Main tracks (bilingual): 7,670 files ✅
  ├─ Legacy tracks (unique):  897 files 📦
  └─ Duplicates (skipped):    3,757 files ⏭️

Events with Legacy Folders: 48 (60% of bilingual events)
```

**Top Events with Legacy Tracks:**
1. **20191006_12-KPS-ENS-UBP**: 352 legacy tracks
2. **20070913_15-SDL-ENS-FMD**: 195 legacy tracks
3. **20150402_04-JKR-PWR-RP2-HSA**: 66 legacy tracks
4. **20160621_23 - SST-ENS-HAL**: 56 legacy tracks
5. **20150405_06-JKR-PWR-RP1-HSA**: 45 legacy tracks

## Usage

### Run Validation with Tree Preview

```bash
bun run src/scripts/migrate-from-wix-v2.ts ../wix-export-20250821.csv --validate-only
```

**Outputs:**
1. `migration-report.json` - Full validation with legacyTracks section
2. `bucket-tree-preview.txt` - Visual tree structure of resulting bucket
3. `migration-state.json` - State tracking

### Check Specific Event

```bash
# View legacy tracks for a specific event
cat migration-report.json | jq '.legacyTracks[] | select(.eventCode == "20240408_09-JKR-TM1-CCA")'
```

### Preview Bucket Structure

```bash
# View first 100 lines of tree
head -100 bucket-tree-preview.txt

# Search for events with Legacy folders
grep -A 10 "Legacy" bucket-tree-preview.txt
```

## Benefits

### ✅ **Maximize Quality**
- Prioritizes bilingual content (Portuguese + English)
- Ensures no content loss (Legacy folder preserves unique tracks)

### ✅ **Optimize Storage**
- Eliminates duplicates (3,757 duplicate files identified)
- Reduces redundancy while preserving completeness

### ✅ **Clear Organization**
- Main folder: Bilingual tracks for normal use
- Legacy folder: Unique English-only tracks for reference
- Easy to identify what's what

### ✅ **Transparency**
- Validation shows exact bucket structure before migration
- Reports list every Legacy track per event
- No surprises during actual migration

## Next Steps

1. **Review bucket-tree-preview.txt**
   - Verify folder structure looks correct
   - Check sample events with Legacy folders

2. **Investigate top Legacy events**
   - 5 events account for 714 of 897 Legacy tracks
   - May indicate different content organization
   - Worth manual verification

3. **Run actual migration**
   - Extract ZIPs to new bucket with deduplication
   - Database records will point to correct paths
   - Legacy tracks accessible via `/Legacy/` subfolder

## S3 Bucket Structure (After Migration)

```
padmakara-pt-sample/
└─ mediateca/
   ├─ EVENT-CODE-1/
   │  ├─ track001.mp3         # Bilingual (from audio2)
   │  ├─ track001_TRAD.mp3    # Portuguese translation
   │  └─ ...
   │
   ├─ EVENT-CODE-2/
   │  ├─ track001.mp3         # Bilingual
   │  ├─ track002.mp3
   │  └─ Legacy/              # Unique audio1 tracks
   │     ├─ unique001.mp3
   │     └─ unique002.mp3
   │
   └─ EVENT-CODE-3/
      └─ ...
```

## Configuration

**Deduplication Parameters** (in track-deduplication.ts):

- **Similarity Threshold**: 80% (configurable)
- **Normalization**: Language markers, numbers, speaker abbreviations
- **Strategy**: Conservative (higher threshold = fewer false duplicates)

**To adjust threshold**, edit `track-deduplication.ts:83`:
```typescript
if (similarity >= 0.8) {  // Change 0.8 to desired threshold
```

---

**Version**: 1.0
**Last Updated**: 2026-02-15
**Total Legacy Tracks**: 897 (out of 12,324 total tracks)
**Deduplication Rate**: 30% (3,757 duplicates eliminated)

# Migration UI Testing Guide

**Status:** ✅ Ready for Testing
**Date:** 2026-02-16

---

## ✅ What's Been Built

### **Complete React Admin Migration Interface**

1. **MigrationList** - Shows all migrations with status and progress
2. **MigrationCreate** - CSV upload with drag-and-drop
3. **MigrationShow** - Multi-tab workflow interface
4. **Granular File Decision Interface** - Per-file control with tree view

### **Key Features**

#### 📋 Migration List
- Color-coded status badges
- Progress bars for executing migrations
- Event counts and file statistics
- Click to view details

#### 📤 CSV Upload
- Drag-and-drop file upload
- Title and notes input
- Automatic upload to backend
- Redirects to detail view

#### 🎯 Granular File Decisions (KEY FEATURE)
- **Tree view** showing all files per event
- **Per-file controls:**
  - ☑ Checkbox for include/ignore
  - 📁 Category dropdown (audio_main, translation, video, etc.)
  - 🔄 Rename button with inline input field
  - ⚠️ Conflict warnings with suggestions
- **File grouping:** Audio, Video, Documents, Archives, Other
- **Progress tracking:** "342 / 1,247 files decided (27%)"
- **Auto-save:** Batch save decisions to backend
- **Collapsible sections:** Expand/collapse events and file groups

---

## 🚀 How to Test

### 1. Start the Backend

```bash
cd padmakara-api
bun run dev
```

Backend should be running on `http://localhost:3000`

### 2. Start the Admin UI

```bash
cd padmakara-api/admin
npm run dev
```

Admin UI should be running on `http://localhost:5173`

### 3. Login to Admin

Navigate to `http://localhost:5173` and login with admin credentials.

### 4. Test Migration Workflow

#### **Step 1: Upload CSV**
1. Click "Migrations" in the sidebar menu
2. Click "New Migration" button
3. Drag and drop a Wix CSV export file
4. Enter a title (e.g., "2025 Spring Migration")
5. Click "Upload & Continue"

**Expected:** Redirects to migration detail page showing "Start Analysis" button

#### **Step 2: Analyze**
1. Click "Start Analysis" button
2. Backend scans S3 and catalogs all files

**Expected:**
- Overview tab shows statistics (events, files, issues)
- "File Decisions" tab becomes enabled
- Status changes to "analyzed"

#### **Step 3: Make File Decisions**
1. Click "File Decisions" tab
2. See tree view with all events
3. Expand an event to see file groups
4. For each file:
   - ☑ Check/uncheck to include/ignore
   - 📁 Change category if needed
   - 🔄 Click "Rename" to fix typos
   - ⚠️ Review conflict warnings
5. Click "Save Decisions"

**Expected:**
- Progress bar shows: "X / Y files decided"
- Decisions saved to backend
- Can navigate between events
- All file types visible (audio, video, PDFs, archives)

#### **Step 4: Review (Placeholder)**
1. Make decisions for all files
2. Click "Review" tab

**Expected:** Placeholder showing "Review interface coming soon..."

#### **Step 5: Execution (Placeholder)**
1. Approve migration
2. Click "Execution" tab

**Expected:** Progress bar showing execution status

---

## 🔍 What to Verify

### File Decision Interface

✅ **Tree View Structure:**
- Events are collapsible
- Files grouped by type (Audio, Video, Documents, Archives)
- File groups are collapsible

✅ **Per-File Controls:**
- Checkbox works for include/ignore
- Category dropdown has all options
- Rename button toggles inline input field
- Conflict warnings visible with yellow background

✅ **Progress Tracking:**
- Header shows "X / Y files decided"
- Progress bar updates as decisions made
- Event chips show "X / Y decided" per event

✅ **Saving:**
- "Save Decisions" button enabled when decisions made
- Clicking saves to backend
- Success notification appears

### File Types

✅ **All Types Detected:**
- Audio files (mp3, wav, m4a, etc.)
- Video files (mp4, mov, avi, mkv)
- Documents (pdf, doc, txt)
- Images (jpg, png, svg)
- Archives (zip, rar, 7z)

✅ **Categories Available:**
- audio_main
- audio_translation
- audio_legacy
- video
- transcript
- document
- image
- archive
- other

---

## 🐛 Known Issues / TODO

### Immediate
- [ ] Review tab needs implementation
- [ ] Approval workflow needs implementation
- [ ] Execution monitoring with SSE needs implementation
- [ ] Background job execution needs implementation

### Nice to Have
- [ ] Search/filter files
- [ ] Bulk select actions ("Select all audio", "Include all videos")
- [ ] Keyboard shortcuts
- [ ] Undo/redo
- [ ] Visual file type icons

---

## 📊 Test Data

### Sample CSV Structure
```csv
event_code,title_en,start_date,audio1_url,audio2_url
2022-05-05-MTR-CFR-FMD,"Spring Retreat",2022-05-05,https://s3.../Audio1/,https://s3.../Audio2/
```

### Sample S3 Structure
```
mediateca/
└── 2022-05-05-MTR-CFR-FMD/
    ├── Audio1/
    │   ├── session1-part1.mp3
    │   ├── session1-part2.mp3
    │   └── session1-part3.mp3
    ├── Audio2/
    │   ├── session1-part1.mp3
    │   ├── session1-part2.mp3
    │   └── session1-part3.mp3
    ├── Video/
    │   ├── dharma-talk.mp4
    │   └── opening-ceremony.mov
    └── Transcripts/
        ├── transcript-pt.pdf
        └── transcript-en.pdf
```

---

## 🎯 Success Criteria

✅ **Phase 1 Complete** when:
- CSV upload works
- Analysis scans S3 and catalogs all files
- File decision interface shows tree view
- Per-file controls work (checkbox, category, rename)
- Decisions save to backend
- Progress tracking accurate

🚧 **Phase 2 Complete** when:
- Review & approval workflow implemented
- Execution monitoring with SSE working
- Background job processes migration
- Files copied/renamed in S3
- media_files table populated

---

## 📝 Notes

### Architecture Decisions
- Using React Admin v5.6.2 with Material-UI
- react-dropzone for CSV upload
- Native fetch API for backend calls
- Map for decision state management
- Debounced auto-save to backend

### API Endpoints Used
```
POST   /admin/migrations/upload       - Upload CSV
POST   /admin/migrations/:id/analyze  - Scan S3 and catalog
GET    /admin/migrations/:id          - Get migration + file catalogs
POST   /admin/migrations/:id/decisions - Save decisions (batch)
GET    /admin/migrations/:id/decisions - Get existing decisions
```

### Backend Ready
- ✅ All 10 API endpoints implemented
- ✅ Database schema complete
- ✅ File cataloger scans all file types
- ✅ Migration analyzer generates statistics
- ✅ Conflict detection with Levenshtein distance
- 🚧 Background job execution (TODO)
- 🚧 SSE progress monitoring (TODO)

---

**Ready for Testing!** 🎉

Test the complete workflow from CSV upload → analysis → file decisions → saving.

The granular file decision interface is the key innovation - verify that all file types are visible and that per-file controls work correctly.

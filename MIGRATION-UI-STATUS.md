# Migration UI Status - React Admin Interface

**Date:** 2026-02-16
**Status:** Phase 1 Complete ✅ | Phase 2 In Progress 🚧

---

## ✅ COMPLETED

### 1. **React Admin Foundation** ✅
**Location:** `admin/src/resources/migrations.tsx`

**Components Created:**
- ✅ `MigrationList` - List all migrations with status badges and progress bars
- ✅ `MigrationCreate` - CSV upload with drag-and-drop interface
- ✅ `MigrationShow` - Multi-tab view (Overview, Decisions, Review, Execution)
- ✅ Status chips with color coding for all migration states
- ✅ Overview tab with analysis summary and statistics

**Integration:**
- ✅ Registered in `admin/src/App.tsx`
- ✅ Added to menu in `admin/src/layout/Menu.tsx` with SyncAltIcon
- ✅ Installed `react-dropzone` dependency

**Features:**
```typescript
// Migration List
- Status badges (Uploaded, Analyzing, Analyzed, etc.)
- Progress bars for executing migrations
- Event counts and file statistics
- Click to view details

// Migration Create
- Drag-and-drop CSV upload
- Title and notes input
- Automatic upload to backend
- Redirects to show page after upload

// Migration Show - Multi-tab Interface
- Tab 0: Overview (statistics, issues)
- Tab 1: File Decisions (placeholder)
- Tab 2: Review (placeholder)
- Tab 3: Execution (progress monitoring)
```

---

## 🚧 IN PROGRESS

### 2. **Granular File Decision Interface** 🚧 KEY FEATURE
**Location:** `FileDecisionsTab` in migrations.tsx

**What Needs to Be Built:**

#### Tree View Structure
```tsx
┌─────────────────────────────────────────────────────────────┐
│ Event: 2022-05-05-MTR-CFR-FMD                     [Files: 47]│
├─────────────────────────────────────────────────────────────┤
│ ▼ Audio Files (24)                                          │
│   ▼ Audio1 - Main Tracks (12)                               │
│   │  ☑ session1-part1.mp3         [Main ▾]     [✓ Include] │
│   │  ☑ session1-part2.mp3         [Main ▾]     [✓ Include] │
│   │  ☐ session1 part3.mp3 ⚠️      [Main ▾]     [⚠ Review]  │
│   │     ⚠️ Typo? Similar to "session1-part3"                │
│   │     Rename: [session1-part3.mp3__________] [Apply]      │
│   │                                                          │
│   ▼ Audio2 - Translation (12)                               │
│     ☑ session1-part1.mp3         [Translation ▾] [✓ Include]│
│                                                              │
│ ▼ Video Files (2) ← NEW!                                    │
│   ☑ dharma-talk.mp4              [Video ▾]      [✓ Include] │
│   ☑ opening-ceremony.mov         [Video ▾]      [✓ Include] │
│                                                              │
│ ▼ Documents (3)                                             │
│   ☑ transcript-pt.pdf            [Transcript ▾] [✓ Include] │
│   ☑ transcript-en.pdf            [Transcript ▾] [✓ Include] │
│   ☐ notes.txt                    [Ignore ▾]     [⊗ Ignore]  │
│                                                              │
│ [Save Decisions] [Apply to Similar] [Next Event →]          │
└─────────────────────────────────────────────────────────────┘
```

#### Components Needed

**1. EventTree Component**
```typescript
interface EventTreeProps {
  eventCatalog: EventCatalog;
  decisions: Map<number, FileDecision>;
  onDecisionChange: (catalogId: number, decision: FileDecision) => void;
}

// Collapsible tree showing all files grouped by type
// Each file row has: checkbox, filename, category dropdown, action buttons
```

**2. FileRow Component**
```typescript
interface FileRowProps {
  file: CatalogedFile;
  decision: FileDecision | null;
  onChange: (decision: FileDecision) => void;
}

// Features:
// - Checkbox for include/ignore
// - Filename display with conflict warnings
// - Category dropdown (can override suggestion)
// - Rename input (conditional, shows when action = "rename")
// - Notes field (expandable)
```

**3. ConflictWarning Component**
```typescript
interface ConflictWarningProps {
  conflicts: string[];
  onResolve: (resolution: string) => void;
}

// Shows warning icon with tooltip
// Expandable to show all conflicts
// Suggests resolution (e.g., rename recommendations)
```

**4. BulkActions Component**
```typescript
interface BulkActionsProps {
  selectedFiles: number[];
  onBulkAction: (action: BulkAction) => void;
}

// "Select all audio"
// "Apply category to all similar"
// "Auto-resolve typos"
// "Include all videos"
```

#### API Integration
```typescript
// Fetch file catalogs
GET /admin/migrations/:id/catalogs

// Save decisions (batch)
POST /admin/migrations/:id/decisions
{
  decisions: [
    { catalogId: 123, action: "include", targetCategory: "audio_main" },
    { catalogId: 124, action: "rename", newFilename: "session1-part3.mp3", targetCategory: "audio_main" },
    { catalogId: 125, action: "ignore" }
  ]
}

// Get existing decisions
GET /admin/migrations/:id/decisions
```

#### State Management
```typescript
const [events, setEvents] = useState<EventCatalog[]>([]);
const [decisions, setDecisions] = useState<Map<number, FileDecision>>(new Map());
const [expandedEvents, setExpandedEvents] = useState<Set<string>>(new Set());
const [saving, setSaving] = useState(false);

// Auto-save decisions as user makes them (debounced)
const saveDebouncedDecisions = useMemo(
  () => debounce((decisions: FileDecision[]) => {
    // POST to backend
  }, 1000),
  []
);
```

---

## 📋 NEXT STEPS

### Immediate (Today)
1. ✅ Basic UI structure complete
2. 🚧 Create EventTree component with collapsible sections
3. 🚧 Create FileRow component with all controls
4. 🚧 Implement decision state management
5. 🚧 Connect to backend API for catalogs and decisions

### Soon (This Week)
1. Build ConflictWarning component with resolution suggestions
2. Implement BulkActions component
3. Add progress tracker (X files decided / Y total)
4. Build Review & Approval tab
5. Implement SSE for execution monitoring

### Later (Nice to Have)
1. Search/filter files within events
2. Keyboard shortcuts for faster decision-making
3. Undo/redo for decisions
4. Export decision summary to CSV
5. Visual file type icons (audio, video, PDF)

---

## 🎯 Technical Decisions

### UI Framework
- **React Admin v5.6.2** with Material-UI components
- **react-dropzone** for CSV upload
- **Tabs** for multi-step workflow organization

### State Management
- React hooks (useState, useEffect) for local state
- Map for decisions (catalogId → FileDecision)
- Set for expanded events tracking
- Debounced auto-save to backend

### API Communication
- REST API calls to Hono backend
- JWT auth from localStorage
- Server-Sent Events (SSE) for real-time progress

### Performance
- Virtual scrolling for large event lists (future optimization)
- Pagination for file lists if needed
- Debounced save operations

---

## 🚀 Usage Flow

### 1. Upload CSV
```
User → New Migration → Drag CSV → Enter Title → Upload
→ Redirects to show page with "Start Analysis" button
```

### 2. Analyze
```
User → Start Analysis → Backend scans S3, catalogs ALL files
→ Overview tab shows statistics and issues
→ File Decisions tab becomes enabled
```

### 3. Make Decisions
```
User → File Decisions tab → Tree view with all events
→ For each file: Include/Ignore/Rename + Category selection
→ Decisions auto-saved to backend (debounced)
→ Progress: "342 / 1,247 files decided"
```

### 4. Review & Approve
```
User → Review tab → Shows summary and final checks
→ Approve for execution → Status changes to "approved"
```

### 5. Execute
```
User → Execute button → Background job starts
→ Execution tab shows real-time progress via SSE
→ Status updates: "Executing... 45% Complete"
→ Completion: All files migrated to media_files table
```

---

## 📊 Current Status

**Backend:** 100% Complete ✅
**Frontend:** 30% Complete 🚧
**Key Feature (File Decisions):** 10% Complete 🚧

**Next Concrete Step:**
Build EventTree and FileRow components with full decision controls.

---

**Ready to build the granular file decision interface!** 🎨

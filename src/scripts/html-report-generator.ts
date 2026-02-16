/**
 * Generate interactive HTML report for migration validation.
 *
 * Creates a single-page web application with:
 * - Interactive tree view (collapse/expand folders)
 * - Filtering and search
 * - Summary statistics
 * - Legacy tracks details
 * - Issue tracking
 */

import type { TreeNode } from "./track-deduplication.ts";

export interface EventSummary {
  eventCode: string;
  title: string;
  s3Directory: string | null;
  audio1Tracks: string[];
  audio2Tracks: string[];
  hasAudio: boolean;
  hasTracks: boolean;
  issues: Array<{
    severity: "error" | "warning" | "info";
    category: string;
    message: string;
    details?: any;
  }>;
  errorCount: number;
  warningCount: number;
  infoCount: number;
}

export interface ReportData {
  timestamp: string;
  totalEvents: number;
  processedEvents: number;
  validEvents: number;
  eventsWithTracks: number;  // Events that have audio tracks (audio1 or audio2)
  eventsWithoutTracks: Array<{ eventCode: string; title: string; s3Directory?: string | null }>;  // Events with no audio
  eventsWithLegacyTracks: number;
  totalMainTracks: number;
  totalLegacyTracks: number;
  totalDuplicates: number;
  unmappedEventTypes: string[];
  unmappedAudiences: string[];
  trackCountMismatches: Array<{ eventCode: string; expected: number; parsed: number }>;
  legacyTracks: Array<{
    eventCode: string;
    legacyCount: number;
    legacyTracks: string[];
    duplicates: string[];
    mainTracks: string[];
  }>;
  trees: TreeNode[];
  issues: Array<{
    severity: "error" | "warning" | "info";
    category: string;
    message: string;
    eventCode: string;
    details?: any;
  }>;
  eventsList: EventSummary[];  // All events with aggregated information
  s3Bucket: string;
  s3Region: string;
  eventS3Directories: Record<string, string>;  // eventCode → s3Directory mapping
}

function generateTreeHTML(node: TreeNode, createS3Url: (path: string | null | undefined) => string | null, level: number = 0): string {
  const indent = "  ".repeat(level);

  if (node.type === "folder") {
    const countStr = node.count ? ` <span class="count">(${node.count} files)</span>` : "";
    const hasLegacy = node.name === "Legacy" ? ' legacy-folder' : '';

    // Add S3 link for event folders (not Legacy folders)
    const s3Url = createS3Url(node.s3Directory);
    const s3Link = s3Url && !hasLegacy
      ? `<a href="${s3Url}" target="_blank" class="s3-link" title="View in S3">🔗</a>`
      : '';

    let html = `${indent}<li class="folder${hasLegacy}" data-name="${node.name.toLowerCase()}">\n`;
    html += `${indent}  <span class="folder-toggle" onclick="toggleFolder(this)">▶</span>\n`;
    html += `${indent}  <span class="folder-icon">📁</span>\n`;
    html += `${indent}  <span class="folder-name">${node.name}${countStr} ${s3Link}</span>\n`;

    if (node.children && node.children.length > 0) {
      html += `${indent}  <ul class="folder-content collapsed">\n`;
      for (const child of node.children) {
        html += generateTreeHTML(child, createS3Url, level + 2);
      }
      html += `${indent}  </ul>\n`;
    }

    html += `${indent}</li>\n`;
    return html;
  } else {
    // File
    const icon = node.source === "audio2" ? "🎵" : "📦";
    const fileClass = node.source === "audio1-legacy" ? "legacy-file" : "main-file";
    return `${indent}<li class="file ${fileClass}" data-name="${node.name.toLowerCase()}">\n${indent}  <span class="file-icon">${icon}</span>\n${indent}  <span class="file-name">${node.name}</span>\n${indent}</li>\n`;
  }
}

export function generateHTMLReport(data: ReportData): string {
  // Helper function to create direct S3 URLs
  const createS3Url = (s3Path: string | null | undefined): string | null => {
    if (!s3Path) return null;
    // Remove leading slash if present
    const cleanPath = s3Path.startsWith('/') ? s3Path.slice(1) : s3Path;
    // Ensure trailing slash for folder browsing in S3 console
    const pathWithTrailingSlash = cleanPath.endsWith('/') ? cleanPath : `${cleanPath}/`;
    return `https://s3.console.aws.amazon.com/s3/buckets/${data.s3Bucket}?prefix=${pathWithTrailingSlash}`;
  };

  // Calculate derived statistics
  const errorCount = data.issues.filter(i => i.severity === "error").length;
  const warningCount = data.issues.filter(i => i.severity === "warning").length;
  const infoCount = data.issues.filter(i => i.severity === "info").length;
  const issueCount = data.issues.length;

  const trees = data.trees.map(t => ({
    eventCode: t.name,
    html: generateTreeHTML(t, createS3Url),
    s3Url: createS3Url(t.s3Directory),
  }));

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Migration Validation Report - ${data.timestamp}</title>
  <style>
    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }

    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, sans-serif;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      min-height: 100vh;
      padding: 20px;
    }

    .container {
      max-width: 1400px;
      margin: 0 auto;
      background: white;
      border-radius: 12px;
      box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3);
      overflow: hidden;
    }

    header {
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      color: white;
      padding: 30px 40px;
    }

    h1 {
      font-size: 28px;
      margin-bottom: 10px;
    }

    .timestamp {
      opacity: 0.9;
      font-size: 14px;
    }

    .tabs {
      display: flex;
      background: #f5f5f5;
      border-bottom: 2px solid #e0e0e0;
      overflow-x: auto;
    }

    .tab {
      padding: 15px 30px;
      cursor: pointer;
      background: transparent;
      border: none;
      font-size: 15px;
      font-weight: 500;
      color: #666;
      transition: all 0.3s;
      white-space: nowrap;
    }

    .tab:hover {
      background: rgba(102, 126, 234, 0.1);
    }

    .tab.active {
      background: white;
      color: #667eea;
      border-bottom: 3px solid #667eea;
    }

    .tab-content {
      display: none;
      padding: 40px;
      animation: fadeIn 0.3s;
    }

    .tab-content.active {
      display: block;
    }

    @keyframes fadeIn {
      from { opacity: 0; transform: translateY(10px); }
      to { opacity: 1; transform: translateY(0); }
    }

    .stats-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
      gap: 20px;
      margin-bottom: 30px;
    }

    .stat-card {
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      color: white;
      padding: 20px;
      border-radius: 8px;
      box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
    }

    .stat-card.success {
      background: linear-gradient(135deg, #11998e 0%, #38ef7d 100%);
    }

    .stat-card.warning {
      background: linear-gradient(135deg, #f093fb 0%, #f5576c 100%);
    }

    .stat-card.info {
      background: linear-gradient(135deg, #4facfe 0%, #00f2fe 100%);
    }

    .stat-label {
      font-size: 12px;
      opacity: 0.9;
      margin-bottom: 8px;
      text-transform: uppercase;
      letter-spacing: 1px;
    }

    .stat-value {
      font-size: 32px;
      font-weight: bold;
    }

    .stat-note {
      font-size: 11px;
      opacity: 0.85;
      margin-top: 8px;
      font-weight: normal;
    }

    .controls {
      display: flex;
      gap: 15px;
      margin-bottom: 20px;
      flex-wrap: wrap;
      align-items: center;
    }

    .search-box {
      flex: 1;
      min-width: 200px;
      padding: 12px 20px;
      border: 2px solid #e0e0e0;
      border-radius: 8px;
      font-size: 14px;
      transition: border-color 0.3s;
    }

    .search-box:focus {
      outline: none;
      border-color: #667eea;
    }

    .btn {
      padding: 12px 24px;
      background: #667eea;
      color: white;
      border: none;
      border-radius: 8px;
      cursor: pointer;
      font-size: 14px;
      font-weight: 500;
      transition: all 0.3s;
    }

    .btn:hover {
      background: #5568d3;
      transform: translateY(-2px);
      box-shadow: 0 4px 12px rgba(102, 126, 234, 0.4);
    }

    .btn.secondary {
      background: #e0e0e0;
      color: #333;
    }

    .btn.secondary:hover {
      background: #d0d0d0;
    }

    .tree-container {
      background: #f9f9f9;
      border: 2px solid #e0e0e0;
      border-radius: 8px;
      padding: 20px;
    }

    .tree-view {
      font-family: 'Monaco', 'Courier New', monospace;
      font-size: 13px;
      line-height: 1.8;
    }

    .tree-view ul {
      list-style: none;
      padding-left: 20px;
    }

    .tree-view > ul {
      padding-left: 0;
    }

    .tree-view li {
      position: relative;
    }

    .folder-toggle {
      display: inline-block;
      width: 20px;
      cursor: pointer;
      user-select: none;
      transition: transform 0.2s;
      transform-origin: center center;
    }

    .folder.expanded .folder-toggle {
      transform: rotate(90deg);
    }

    .folder-icon, .file-icon {
      margin: 0 8px;
    }

    .folder-name, .file-name {
      cursor: default;
    }

    .folder.legacy-folder > .folder-name {
      color: #f5576c;
      font-weight: bold;
    }

    .file.legacy-file {
      opacity: 0.8;
    }

    .folder-content.collapsed {
      display: none;
    }

    .count {
      color: #999;
      font-size: 12px;
      margin-left: 8px;
    }

    .s3-link {
      margin-left: 8px;
      font-size: 14px;
      text-decoration: none;
      opacity: 0.6;
      transition: opacity 0.2s;
    }

    .s3-link:hover {
      opacity: 1;
    }

    .legend {
      background: #fff3cd;
      border: 1px solid #ffeaa7;
      border-radius: 8px;
      padding: 15px;
      margin-bottom: 20px;
    }

    .legend-title {
      font-weight: bold;
      margin-bottom: 10px;
      color: #856404;
    }

    .legend-item {
      margin: 5px 0;
      font-size: 14px;
    }

    table {
      width: 100%;
      border-collapse: collapse;
      margin-top: 20px;
    }

    th, td {
      padding: 12px;
      text-align: left;
      border-bottom: 1px solid #e0e0e0;
    }

    th {
      background: #f5f5f5;
      font-weight: 600;
      color: #333;
    }

    .sort-indicator {
      font-size: 12px;
      margin-left: 5px;
      opacity: 0.5;
    }

    tr:hover {
      background: #f9f9f9;
    }

    .event-code {
      font-family: monospace;
      background: #e0e0e0;
      padding: 4px 8px;
      border-radius: 4px;
      font-size: 12px;
    }

    .badge {
      display: inline-block;
      padding: 4px 12px;
      border-radius: 12px;
      font-size: 12px;
      font-weight: 500;
    }

    .badge.error {
      background: #ffebee;
      color: #c62828;
    }

    .badge.warning {
      background: #fff3e0;
      color: #e65100;
    }

    .badge.info {
      background: #e3f2fd;
      color: #1565c0;
    }

    .no-results {
      text-align: center;
      padding: 40px;
      color: #999;
      font-size: 16px;
    }

    @media (max-width: 768px) {
      .stats-grid {
        grid-template-columns: 1fr;
      }

      .tab {
        padding: 12px 20px;
        font-size: 14px;
      }

      .tab-content {
        padding: 20px;
      }
    }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <h1>🔍 Migration Validation Report</h1>
      <div class="timestamp">Generated: ${data.timestamp}</div>
    </header>

    <div class="tabs">
      <button class="tab active" onclick="switchTab(0)">📊 Summary</button>
      <button class="tab" onclick="switchTab(1)">🎯 Decisions</button>
      <button class="tab" onclick="switchTab(2)">🌳 Bucket Tree</button>
      <button class="tab" onclick="switchTab(3)">📦 Legacy Tracks</button>
      <button class="tab" onclick="switchTab(4)">⚠️ Issues</button>
      <button class="tab" onclick="switchTab(5)">📋 Events List</button>
      <button class="tab" onclick="switchTab(6)">🚫 No Audio</button>
    </div>

    <!-- Tab 0: Summary -->
    <div class="tab-content active">
      <h2 style="margin-bottom: 20px;">Migration Summary</h2>

      <h3 style="margin: 20px 0 15px;">📋 Event Overview</h3>
      <div class="stats-grid">
        <div class="stat-card">
          <div class="stat-label">Total Events</div>
          <div class="stat-value">${data.totalEvents}</div>
          <div class="stat-note">From CSV export</div>
        </div>
        <div class="stat-card success">
          <div class="stat-label">Ready to Migrate</div>
          <div class="stat-value">${data.eventsWithTracks}</div>
          <div class="stat-note">${((data.eventsWithTracks/data.totalEvents)*100).toFixed(1)}% have audio</div>
        </div>
        <div class="stat-card" style="background: linear-gradient(135deg, #e0e0e0 0%, #bdbdbd 100%);">
          <div class="stat-label">No Audio Files</div>
          <div class="stat-value">${data.eventsWithoutTracks.length}</div>
          <div class="stat-note">Transcript-only or missing</div>
        </div>
        <div class="stat-card ${errorCount > 0 ? 'error' : warningCount > 0 ? 'warning' : 'success'}">
          <div class="stat-label">Issues Found</div>
          <div class="stat-value">${issueCount}</div>
          <div class="stat-note">${errorCount} errors, ${warningCount} warnings</div>
        </div>
      </div>

      <h3 style="margin: 30px 0 15px;">🎵 Track Distribution</h3>
      <div class="stats-grid">
        <div class="stat-card success">
          <div class="stat-label">Main Tracks</div>
          <div class="stat-value">${data.totalMainTracks.toLocaleString()}</div>
          <div class="stat-note">Bilingual content (primary)</div>
        </div>
        <div class="stat-card warning">
          <div class="stat-label">Legacy Tracks</div>
          <div class="stat-value">${data.totalLegacyTracks.toLocaleString()}</div>
          <div class="stat-note">Unique content (archived)</div>
        </div>
        <div class="stat-card info">
          <div class="stat-label">Duplicates Skipped</div>
          <div class="stat-value">${data.totalDuplicates.toLocaleString()}</div>
          <div class="stat-note">Space saved: ${((data.totalDuplicates/(data.totalMainTracks+data.totalLegacyTracks+data.totalDuplicates))*100).toFixed(1)}%</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Total Files</div>
          <div class="stat-value">${(data.totalMainTracks + data.totalLegacyTracks).toLocaleString()}</div>
          <div class="stat-note">To migrate to new bucket</div>
        </div>
      </div>

      <h3 style="margin: 30px 0 15px;">⚠️ Quality Checks</h3>
      <div class="stats-grid">
        <div class="stat-card ${data.eventsWithLegacyTracks > 0 ? 'info' : 'success'}">
          <div class="stat-label">Legacy Folders</div>
          <div class="stat-value">${data.eventsWithLegacyTracks}</div>
          <div class="stat-note">${((data.eventsWithLegacyTracks/data.eventsWithTracks)*100).toFixed(1)}% of events</div>
        </div>
        <div class="stat-card ${data.trackCountMismatches.length > 0 ? 'warning' : 'success'}">
          <div class="stat-label">Track Count Mismatches</div>
          <div class="stat-value">${data.trackCountMismatches.length}</div>
          <div class="stat-note">Expected vs actual count</div>
        </div>
        <div class="stat-card ${data.unmappedEventTypes.length > 0 ? 'warning' : 'success'}">
          <div class="stat-label">Unmapped Event Types</div>
          <div class="stat-value">${data.unmappedEventTypes.length}</div>
          <div class="stat-note">Need database entries</div>
        </div>
        <div class="stat-card ${data.unmappedAudiences.length > 0 ? 'warning' : 'success'}">
          <div class="stat-label">Unmapped Audiences</div>
          <div class="stat-value">${data.unmappedAudiences.length}</div>
          <div class="stat-note">Need database entries</div>
        </div>
      </div>

      ${data.eventsWithLegacyTracks > 0 ? `
        <div style="margin-top: 30px; padding: 20px; background: #fff3cd; border-left: 4px solid #ffc107; border-radius: 4px;">
          <strong>ℹ️ Legacy Folder Strategy:</strong> Events with both audio1 (English) and audio2 (bilingual) folders are deduplicated.
          The folder with MORE tracks becomes the main folder. Unique tracks from the smaller folder are preserved in a <strong>Legacy/</strong> subfolder.
          <br><br>
          <strong>Result:</strong> ${data.eventsWithLegacyTracks} events have Legacy folders containing ${data.totalLegacyTracks.toLocaleString()} unique tracks that would otherwise be lost.
        </div>
      ` : ''}
    </div>

    <!-- Tab 1: Decisions -->
    <div class="tab-content">
      <h2 style="margin-bottom: 20px;">🎯 Migration Decisions Required</h2>

      <div style="background: #fff3cd; border-left: 4px solid #ffc107; padding: 16px; margin-bottom: 30px; border-radius: 4px;">
        <strong style="color: #856404;">📋 Action Required:</strong>
        <p style="margin: 8px 0 0; color: #856404;">
          Review the decisions below and fill in <code>migration-decisions.yaml</code> before running the migration.
          This report provides the context and data you need to make informed decisions.
        </p>
      </div>

      <h3 style="margin: 30px 0 15px; color: #d32f2f;">🔴 Critical Decisions</h3>

      <!-- Decision 1: Bucket Strategy -->
      <div style="margin-bottom: 24px; padding: 16px; background: white; border: 1px solid #ddd; border-radius: 6px;">
        <h4 style="margin: 0 0 12px; color: #1976d2;">Decision 1: Bucket Strategy</h4>
        <p style="margin: 0 0 12px; color: #666;">
          <strong>Context:</strong> The original bucket (<code>padmakara-pt</code>) has an inconsistent folder structure that evolved over time.
        </p>
        <div style="background: #f5f5f5; padding: 12px; border-radius: 4px; margin-bottom: 12px;">
          <div style="font-size: 12px; color: #666; margin-bottom: 8px;"><strong>Options:</strong></div>
          <div style="margin-bottom: 8px;">
            <strong style="color: #f57c00;">Option A: Extract in Place</strong><br/>
            <span style="font-size: 13px; color: #666;">
              Extract zips in original bucket, keep existing folder structure<br/>
              ✅ Simple, no duplication, no bucket switching<br/>
              ❌ Inconsistent paths, complex backend code, risk to production data
            </span>
          </div>
          <div>
            <strong style="color: #4caf50;">Option B: New Bucket (Recommended)</strong><br/>
            <span style="font-size: 13px; color: #666;">
              Migrate to clean bucket with consistent structure<br/>
              ✅ Clean paths, simple backend, safe testing, easy rollback<br/>
              ❌ Temporary storage cost, need to switch bucket later
            </span>
          </div>
        </div>
        <div style="background: #e3f2fd; padding: 10px; border-radius: 4px; font-size: 13px;">
          <strong>📝 Configure in YAML:</strong> <code>storage.strategy</code>
        </div>
      </div>

      <!-- Decision 2: Legacy Tracks -->
      <div style="margin-bottom: 24px; padding: 16px; background: white; border: 1px solid #ddd; border-radius: 6px;">
        <h4 style="margin: 0 0 12px; color: #1976d2;">Decision 2: Legacy Track Handling</h4>
        <p style="margin: 0 0 12px; color: #666;">
          <strong>Context:</strong> <span style="color: #d32f2f; font-weight: bold;">${data.totalLegacyTracks} unique tracks</span> from audio1 folders have no bilingual equivalent in audio2.
        </p>
        <div style="background: #f5f5f5; padding: 12px; border-radius: 4px; margin-bottom: 12px;">
          <div style="font-size: 12px; color: #666; margin-bottom: 8px;"><strong>Options:</strong></div>
          <div style="margin-bottom: 6px;">
            <strong>• Legacy Folder (Recommended):</strong> <span style="font-size: 13px; color: #666;">Create <code>/legacy/</code> subfolder for unique tracks</span>
          </div>
          <div style="margin-bottom: 6px;">
            <strong>• Merge Main:</strong> <span style="font-size: 13px; color: #666;">Include all audio1 tracks in main folder</span>
          </div>
          <div>
            <strong>• Separate Audio1:</strong> <span style="font-size: 13px; color: #666;">Keep audio1 and audio2 completely separate</span>
          </div>
        </div>
        <div style="background: #fff3e0; padding: 10px; border-radius: 4px; font-size: 13px; margin-bottom: 8px;">
          <strong>📊 Impact:</strong> ${data.eventsWithLegacyTracks} events affected
          <a href="#" onclick="switchTab(3); return false;" style="margin-left: 8px; color: #1976d2;">View Legacy Tracks →</a>
        </div>
        <div style="background: #e3f2fd; padding: 10px; border-radius: 4px; font-size: 13px;">
          <strong>📝 Configure in YAML:</strong> <code>tracks.legacy_strategy</code>
        </div>
      </div>

      <!-- Decision 3: Track Count Mismatches -->
      <div style="margin-bottom: 24px; padding: 16px; background: white; border: 1px solid #ddd; border-radius: 6px;">
        <h4 style="margin: 0 0 12px; color: #1976d2;">Decision 3: Track Count Mismatches</h4>
        <p style="margin: 0 0 12px; color: #666;">
          <strong>Context:</strong> <span style="color: #f57c00; font-weight: bold;">${data.trackCountMismatches.length} events</span> have CSV expected count ≠ actual files found in S3.
        </p>
        <div style="background: #f5f5f5; padding: 12px; border-radius: 4px; margin-bottom: 12px;">
          <div style="font-size: 12px; color: #666; margin-bottom: 8px;"><strong>Options:</strong></div>
          <div style="margin-bottom: 6px;">
            <strong>• Trust Files (Recommended):</strong> <span style="font-size: 13px; color: #666;">Use actual S3 files, ignore CSV count</span>
          </div>
          <div style="margin-bottom: 6px;">
            <strong>• Trust CSV:</strong> <span style="font-size: 13px; color: #666;">Fail migration if counts don't match</span>
          </div>
          <div>
            <strong>• Manual Review:</strong> <span style="font-size: 13px; color: #666;">Flag for manual review, skip migration</span>
          </div>
        </div>
        <div style="background: #fff3e0; padding: 10px; border-radius: 4px; font-size: 13px; margin-bottom: 8px;">
          <strong>📊 Impact:</strong> ${data.trackCountMismatches.length} events
          <a href="#" onclick="switchTab(4); scrollToSection('warning-section'); return false;" style="margin-left: 8px; color: #1976d2;">View Mismatches →</a>
        </div>
        <div style="background: #e3f2fd; padding: 10px; border-radius: 4px; font-size: 13px;">
          <strong>📝 Configure in YAML:</strong> <code>tracks.mismatch_strategy</code>
        </div>
      </div>

      <h3 style="margin: 30px 0 15px; color: #f57c00;">🟠 Important Decisions</h3>

      <!-- Decision 4: Events Without Audio -->
      <div style="margin-bottom: 24px; padding: 16px; background: white; border: 1px solid #ddd; border-radius: 6px;">
        <h4 style="margin: 0 0 12px; color: #1976d2;">Decision 4: Events Without Audio</h4>
        <p style="margin: 0 0 12px; color: #666;">
          <strong>Context:</strong> <span style="font-weight: bold;">${data.eventsWithoutTracks.length} events</span> have no audio files (neither audio1 nor audio2).
        </p>
        <div style="background: #f5f5f5; padding: 12px; border-radius: 4px; margin-bottom: 12px;">
          <div style="font-size: 12px; color: #666; margin-bottom: 8px;"><strong>Options:</strong></div>
          <div style="margin-bottom: 6px;">
            <strong>• Skip:</strong> <span style="font-size: 13px; color: #666;">Don't create event records for these</span>
          </div>
          <div style="margin-bottom: 6px;">
            <strong>• Create Placeholder (Recommended):</strong> <span style="font-size: 13px; color: #666;">Create event with transcript-only flag</span>
          </div>
          <div>
            <strong>• Manual Review:</strong> <span style="font-size: 13px; color: #666;">List in report for manual decision per event</span>
          </div>
        </div>
        <div style="background: #fff3e0; padding: 10px; border-radius: 4px; font-size: 13px; margin-bottom: 8px;">
          <strong>📊 Impact:</strong> ${data.eventsWithoutTracks.length} events
          <a href="#" onclick="switchTab(6); return false;" style="margin-left: 8px; color: #1976d2;">View Events →</a>
        </div>
        <div style="background: #e3f2fd; padding: 10px; border-radius: 4px; font-size: 13px;">
          <strong>📝 Configure in YAML:</strong> <code>content.no_audio_strategy</code>
        </div>
      </div>

      <!-- Decision 5: Unmapped Data -->
      <div style="margin-bottom: 24px; padding: 16px; background: white; border: 1px solid #ddd; border-radius: 6px;">
        <h4 style="margin: 0 0 12px; color: #1976d2;">Decision 5: Unmapped Data Handling</h4>
        <p style="margin: 0 0 12px; color: #666;">
          <strong>Context:</strong> Some CSV values don't match database lookup tables.
        </p>
        <div style="background: #f5f5f5; padding: 12px; border-radius: 4px; margin-bottom: 12px;">
          <div style="font-size: 13px; color: #666; margin-bottom: 8px;">
            <strong>Unmapped Event Types:</strong> ${data.unmappedEventTypes.length > 0 ? data.unmappedEventTypes.map(et => `<code>${et}</code>`).join(', ') : 'None'}
          </div>
          <div style="font-size: 13px; color: #666;">
            <strong>Unmapped Audiences:</strong> ${data.unmappedAudiences.length > 0 ? data.unmappedAudiences.map(aud => `<code>${aud}</code>`).join(', ') : 'None'}
          </div>
        </div>
        <div style="background: #f5f5f5; padding: 12px; border-radius: 4px; margin-bottom: 12px;">
          <div style="font-size: 12px; color: #666; margin-bottom: 8px;"><strong>Options:</strong></div>
          <div style="margin-bottom: 6px;">
            <strong>• Infer (Recommended):</strong> <span style="font-size: 13px; color: #666;">Attempt to infer from event code patterns</span>
          </div>
          <div style="margin-bottom: 6px;">
            <strong>• Create Null:</strong> <span style="font-size: 13px; color: #666;">Create event with null for unmapped fields</span>
          </div>
          <div>
            <strong>• Skip Event:</strong> <span style="font-size: 13px; color: #666;">Don't migrate events with unmapped data</span>
          </div>
        </div>
        <div style="background: #e3f2fd; padding: 10px; border-radius: 4px; font-size: 13px;">
          <strong>📝 Configure in YAML:</strong> <code>mapping.unmapped_strategy</code>, <code>mapping.infer_teachers</code>, <code>mapping.infer_places</code>
        </div>
      </div>

      <h3 style="margin: 30px 0 15px; color: #1976d2;">🔵 Configuration Options</h3>

      <!-- Additional Configuration -->
      <div style="margin-bottom: 24px; padding: 16px; background: white; border: 1px solid #ddd; border-radius: 6px;">
        <h4 style="margin: 0 0 12px; color: #1976d2;">Execution & Safety Settings</h4>
        <div style="font-size: 13px; color: #666; line-height: 1.8;">
          <div style="margin-bottom: 8px;">
            <strong>• Batch Size:</strong> Process events in batches (recommended: 50)
          </div>
          <div style="margin-bottom: 8px;">
            <strong>• S3 Concurrency:</strong> Parallel S3 operations (recommended: 5)
          </div>
          <div style="margin-bottom: 8px;">
            <strong>• Min Success Rate:</strong> Minimum success rate to proceed (recommended: 0.95)
          </div>
          <div style="margin-bottom: 8px;">
            <strong>• Rollback Strategy:</strong> What to do if migration fails mid-way
          </div>
          <div style="margin-bottom: 8px;">
            <strong>• State Management:</strong> Save progress for resumable migration
          </div>
        </div>
        <div style="background: #e3f2fd; padding: 10px; border-radius: 4px; font-size: 13px; margin-top: 12px;">
          <strong>📝 Configure in YAML:</strong> <code>execution</code>, <code>validation</code>, <code>rollback</code> sections
        </div>
      </div>

      <div style="background: #e8f5e9; border-left: 4px solid #4caf50; padding: 16px; margin-top: 30px; border-radius: 4px;">
        <strong style="color: #2e7d32;">✅ Next Steps:</strong>
        <ol style="margin: 12px 0 0; padding-left: 20px; color: #2e7d32;">
          <li>Review all tabs in this report to understand the data</li>
          <li>Open <code>migration-decisions.yaml</code> and fill in your decisions</li>
          <li>Run: <code>bun run migrate --config migration-decisions.yaml --validate-only</code></li>
          <li>Review the validation results</li>
          <li>If satisfied, run: <code>bun run migrate --config migration-decisions.yaml --execute</code></li>
        </ol>
      </div>
    </div>

    <!-- Tab 2: Bucket Tree -->
    <div class="tab-content">
      <h2 style="margin-bottom: 20px;">Bucket Structure Preview</h2>

      <div class="legend">
        <div class="legend-title">Legend</div>
        <div class="legend-item">🎵 = Bilingual track (from audio2)</div>
        <div class="legend-item">📦 = Legacy track (unique from audio1)</div>
        <div class="legend-item">📁 = Folder</div>
      </div>

      <div class="controls">
        <input type="text" class="search-box" id="treeSearch" placeholder="🔍 Search events or files..." oninput="filterTree()">
        <button class="btn" onclick="expandAll()">Expand All</button>
        <button class="btn secondary" onclick="collapseAll()">Collapse All</button>
      </div>

      <div class="tree-container">
        <div class="tree-view" id="treeView">
          <ul>
            <li class="folder" data-name="mediateca">
              <span class="folder-toggle" onclick="toggleFolder(this)">▶</span>
              <span class="folder-icon">📁</span>
              <span class="folder-name">mediateca <span class="count">(${trees.length} events)</span></span>
              <ul class="folder-content collapsed">
                ${trees.map(t => t.html).join('\n')}
              </ul>
            </li>
          </ul>
        </div>
        <div id="noResults" class="no-results" style="display: none;">
          No matching events or files found.
        </div>
      </div>
    </div>

    <!-- Tab 2: Legacy Tracks -->
    <div class="tab-content">
      <h2 style="margin-bottom: 20px;">Legacy Tracks Details</h2>

      <p style="margin-bottom: 20px; color: #666;">
        ${data.eventsWithLegacyTracks} events with Legacy folders containing ${data.totalLegacyTracks.toLocaleString()} unique tracks.
        These tracks exist only in audio1 folders and will be preserved in Legacy/ subfolders.
      </p>

      ${data.legacyTracks.length > 0 ? `
        <table id="legacyTable" class="sortable">
          <thead>
            <tr>
              <th onclick="sortTable(0)" style="cursor: pointer;">Event Code <span class="sort-indicator">⇅</span></th>
              <th onclick="sortTable(1)" style="cursor: pointer;">Track Count <span class="sort-indicator">⇅</span></th>
              <th>Files <span style="font-size: 11px; opacity: 0.7;">(click row to expand/collapse)</span></th>
            </tr>
          </thead>
          <tbody>
            ${data.legacyTracks.map((lt, idx) => {
              const s3Url = createS3Url(data.eventS3Directories[lt.eventCode]);
              const s3Link = s3Url ? `<a href="${s3Url}" target="_blank" class="s3-link" title="View in S3">🔗</a>` : '';
              return `
              <tr onclick="toggleTracks(${idx})" style="cursor: pointer;">
                <td><span class="event-code">${lt.eventCode}</span>${s3Link}</td>
                <td><span class="badge warning">${lt.legacyCount} files</span></td>
                <td>
                  <div id="tracks-preview-${idx}" style="font-size: 12px; color: #666;">
                    ${lt.legacyTracks.slice(0, 2).join(', ')}${lt.legacyCount > 2 ? ` <em>(+${lt.legacyCount - 2} more - click to expand)</em>` : ''}
                  </div>
                  <div id="tracks-full-${idx}" style="display: none; font-size: 11px; color: #555; margin-top: 8px; padding: 10px; background: #f9f9f9; border-radius: 4px; max-height: 300px; overflow-y: auto;">
                    ${lt.legacyTracks.map(t => `<div style="padding: 2px 0;">📦 ${t}</div>`).join('')}
                  </div>
                </td>
              </tr>
              `;
            }).join('')}
          </tbody>
        </table>
      ` : `
        <div class="no-results">No legacy tracks found - all audio1 content has bilingual equivalents!</div>
      `}
    </div>

    <!-- Tab 3: Issues -->
    <div class="tab-content">
      <h2 style="margin-bottom: 20px;">Validation Issues</h2>

      <div class="stats-grid">
        <div class="stat-card" onclick="scrollToSection('errors-section')" style="background: linear-gradient(135deg, #ffebee 0%, #ffcdd2 100%); cursor: pointer;" title="Click to view errors">
          <div class="stat-label" style="color: #d32f2f;">🔴 Errors</div>
          <div class="stat-value" style="color: #d32f2f;">${errorCount}</div>
          <div class="stat-note" style="color: #c62828;">Must be resolved</div>
        </div>
        <div class="stat-card" onclick="scrollToSection('warnings-section')" style="background: linear-gradient(135deg, #fff3e0 0%, #ffe0b2 100%); cursor: pointer;" title="Click to view warnings">
          <div class="stat-label" style="color: #f57c00;">🟡 Warnings</div>
          <div class="stat-value" style="color: #f57c00;">${warningCount}</div>
          <div class="stat-note" style="color: #e65100;">Should be reviewed</div>
        </div>
        <div class="stat-card" onclick="scrollToSection('info-section')" style="background: linear-gradient(135deg, #e3f2fd 0%, #bbdefb 100%); cursor: pointer;" title="Click to view info">
          <div class="stat-label" style="color: #1976d2;">🔵 Info</div>
          <div class="stat-value" style="color: #1976d2;">${infoCount}</div>
          <div class="stat-note" style="color: #0d47a1;">Informational notes</div>
        </div>
      </div>

      ${errorCount > 0 ? `
        <h3 id="errors-section" style="margin: 30px 0 10px; color: #d32f2f; scroll-margin-top: 20px;">🔴 Errors (${errorCount})</h3>
        <p style="margin: 0 0 20px; color: #666; font-size: 14px;">
          Critical issues that prevent migration or may cause data loss. Must be resolved before proceeding.
        </p>
        <div style="margin-bottom: 30px;">
          ${data.issues.filter(i => i.severity === 'error').map((issue, idx) => {
            const s3Url = createS3Url(data.eventS3Directories[issue.eventCode]);
            const s3Link = s3Url ? `<a href="${s3Url}" target="_blank" class="s3-link" title="View in S3">🔗</a>` : '';
            return `
            <div style="margin-bottom: 12px; padding: 12px 16px; background: #ffebee; border-left: 4px solid #d32f2f; border-radius: 4px;">
              <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px;">
                <div><span class="event-code">${issue.eventCode}</span>${s3Link}</div>
                <span class="badge error" style="font-size: 11px;">${issue.category}</span>
              </div>
              <div style="color: #666; font-size: 14px;">${issue.message}</div>
              ${issue.details ? `
                <button onclick="toggleDetails('error-${idx}')" style="margin-top: 8px; padding: 4px 8px; background: white; border: 1px solid #ddd; border-radius: 3px; cursor: pointer; font-size: 11px; color: #666;">
                  <span id="error-${idx}-btn">▶ Show details</span>
                </button>
                <div id="error-${idx}" style="display: none; margin-top: 6px; padding: 8px; background: white; border-radius: 3px; font-size: 11px; color: #888; max-height: 200px; overflow-y: auto;">
                  <pre style="margin: 0; white-space: pre-wrap; word-wrap: break-word;">${JSON.stringify(issue.details, null, 2)}</pre>
                </div>
              ` : ''}
            </div>
            `;
          }).join('')}
        </div>
      ` : ''}

      ${warningCount > 0 ? `
        <h3 id="warnings-section" style="margin: 30px 0 10px; color: #f57c00; scroll-margin-top: 20px;">🟡 Warnings (${warningCount})</h3>
        <p style="margin: 0 0 20px; color: #666; font-size: 14px;">
          Issues that should be reviewed but won't block migration. 
          <strong>Expected</strong> = number from CSV's "trackCount" column (metadata); 
          <strong>Parsed</strong> = actual count of track filenames listed in CSV's track name columns.
          Mismatches indicate CSV data inconsistency.
        </p>
        <div style="margin-bottom: 30px;">
${data.issues.filter(i => i.severity === 'warning').map((issue, idx) => {
            const s3Url = createS3Url(data.eventS3Directories[issue.eventCode]);
            const s3Link = s3Url ? `<a href="${s3Url}" target="_blank" class="s3-link" title="View in S3">🔗</a>` : '';
            
            // Format track count mismatch details specially
            let detailsHtml = '';
            if (issue.details && issue.category === 'count' && issue.details.audio1 && issue.details.audio2) {
              const audio1 = issue.details.audio1;
              const audio2 = issue.details.audio2;
              const totalExpected = audio1.expected + audio2.expected;
              const totalParsed = audio1.tracks.length + audio2.tracks.length;
              
              detailsHtml = `
                <div style="margin-top: 12px; padding: 10px; background: white; border-radius: 4px; border: 1px solid #ffe0b2;">
                  <table style="width: 100%; border-collapse: collapse; font-size: 12px;">
                    <thead>
                      <tr style="background: #fff3e0; border-bottom: 2px solid #f57c00;">
                        <th style="padding: 8px; text-align: left; color: #f57c00;">Folder</th>
                        <th style="padding: 8px; text-align: center; color: #f57c00;">Expected</th>
                        <th style="padding: 8px; text-align: center; color: #f57c00;">Parsed</th>
                        <th style="padding: 8px; text-align: center; color: #f57c00;">Diff</th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr style="border-bottom: 1px solid #ffe0b2;">
                        <td style="padding: 8px;">Audio1 (English)</td>
                        <td style="padding: 8px; text-align: center; font-weight: bold;">${audio1.expected}</td>
                        <td style="padding: 8px; text-align: center; font-weight: bold;">${audio1.tracks.length}</td>
                        <td style="padding: 8px; text-align: center;">
                          <span style="color: ${audio1.tracks.length !== audio1.expected ? '#f57c00' : '#4caf50'}; font-weight: bold;">
                            ${audio1.tracks.length - audio1.expected > 0 ? '+' : ''}${audio1.tracks.length - audio1.expected}
                          </span>
                        </td>
                      </tr>
                      <tr style="border-bottom: 1px solid #ffe0b2;">
                        <td style="padding: 8px;">Audio2 (Bilingual)</td>
                        <td style="padding: 8px; text-align: center; font-weight: bold;">${audio2.expected}</td>
                        <td style="padding: 8px; text-align: center; font-weight: bold;">${audio2.tracks.length}</td>
                        <td style="padding: 8px; text-align: center;">
                          <span style="color: ${audio2.tracks.length !== audio2.expected ? '#f57c00' : '#4caf50'}; font-weight: bold;">
                            ${audio2.tracks.length - audio2.expected > 0 ? '+' : ''}${audio2.tracks.length - audio2.expected}
                          </span>
                        </td>
                      </tr>
                      <tr style="background: #fff3e0; font-weight: bold;">
                        <td style="padding: 8px;">Total</td>
                        <td style="padding: 8px; text-align: center;">${totalExpected}</td>
                        <td style="padding: 8px; text-align: center;">${totalParsed}</td>
                        <td style="padding: 8px; text-align: center;">
                          <span style="color: ${totalParsed !== totalExpected ? '#d32f2f' : '#4caf50'};">
                            ${totalParsed - totalExpected > 0 ? '+' : ''}${totalParsed - totalExpected}
                          </span>
                        </td>
                      </tr>
                    </tbody>
                  </table>
                  ${audio1.tracks.length > 0 || audio2.tracks.length > 0 ? `
                    <button onclick="toggleDetails('warning-${idx}')" style="margin-top: 12px; padding: 4px 8px; background: white; border: 1px solid #ddd; border-radius: 3px; cursor: pointer; font-size: 11px; color: #666; width: 100%;">
                      <span id="warning-${idx}-btn">▶ Show track lists</span>
                    </button>
                    <div id="warning-${idx}" style="display: none; margin-top: 8px;">
                      <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px;">
                        <div style="padding: 8px; background: #fafafa; border-radius: 3px; border: 1px solid #e0e0e0;">
                          <strong style="color: #666; font-size: 11px;">Audio1 Files (${audio1.tracks.length})</strong>
                          <div style="margin-top: 6px; max-height: 150px; overflow-y: auto; font-size: 10px; color: #666;">
                            ${audio1.tracks.length > 0 ? audio1.tracks.map((t: string) => `<div style="padding: 2px 0;">🎵 ${t}</div>`).join('') : '<em style="color: #999;">No tracks</em>'}
                          </div>
                        </div>
                        <div style="padding: 8px; background: #fafafa; border-radius: 3px; border: 1px solid #e0e0e0;">
                          <strong style="color: #666; font-size: 11px;">Audio2 Files (${audio2.tracks.length})</strong>
                          <div style="margin-top: 6px; max-height: 150px; overflow-y: auto; font-size: 10px; color: #666;">
                            ${audio2.tracks.length > 0 ? audio2.tracks.map((t: string) => `<div style="padding: 2px 0;">🎵 ${t}</div>`).join('') : '<em style="color: #999;">No tracks</em>'}
                          </div>
                        </div>
                      </div>
                    </div>
                  ` : ''}
                </div>
              `;
            } else if (issue.details) {
              detailsHtml = `
                <button onclick="toggleDetails('warning-${idx}')" style="margin-top: 8px; padding: 4px 8px; background: white; border: 1px solid #ddd; border-radius: 3px; cursor: pointer; font-size: 11px; color: #666;">
                  <span id="warning-${idx}-btn">▶ Show details</span>
                </button>
                <div id="warning-${idx}" style="display: none; margin-top: 6px; padding: 8px; background: white; border-radius: 3px; font-size: 11px; color: #888; max-height: 200px; overflow-y: auto;">
                  <pre style="margin: 0; white-space: pre-wrap; word-wrap: break-word;">${JSON.stringify(issue.details, null, 2)}</pre>
                </div>
              `;
            }
            
            return `
            <div style="margin-bottom: 12px; padding: 12px 16px; background: #fff3e0; border-left: 4px solid #f57c00; border-radius: 4px;">
              <div style="display: flex; justify-content: space-between; margin-bottom: 6px;">
                <div><span class="event-code">${issue.eventCode}</span>${s3Link}</div>
                <span class="badge warning" style="font-size: 11px;">${issue.category}</span>
              </div>
              <div style="color: #666; font-size: 14px;">${issue.message}</div>
              ${detailsHtml}
            </div>
            `;
          }).join('')}
        </div>
      ` : ''}

      ${infoCount > 0 ? `
        <h3 id="info-section" style="margin: 30px 0 10px; color: #1976d2; scroll-margin-top: 20px;">🔵 Info (${infoCount})</h3>
        <p style="margin: 0 0 20px; color: #666; font-size: 14px;">
          Informational notes about the migration process. These events have special handling or preserved content.
        </p>
        <div style="margin-bottom: 30px;">
${data.issues.filter(i => i.severity === 'info').map((issue, idx) => {
            const s3Url = createS3Url(data.eventS3Directories[issue.eventCode]);
            const s3Link = s3Url ? `<a href="${s3Url}" target="_blank" class="s3-link" title="View in S3">🔗</a>` : '';
            
            // Format legacy tracks details specially
            let detailsHtml = '';
            if (issue.details && issue.category === 'data' && issue.details.legacyTracks) {
              const legacy = issue.details.legacyTracks;
              const audio1 = issue.details.audio1Tracks || [];
              const audio2 = issue.details.audio2Tracks || [];
              
              detailsHtml = `
                <button onclick="toggleDetails('info-${idx}')" style="margin-top: 8px; padding: 4px 8px; background: white; border: 1px solid #ddd; border-radius: 3px; cursor: pointer; font-size: 11px; color: #666;">
                  <span id="info-${idx}-btn">▶ Show legacy tracks (${legacy.length})</span>
                </button>
                <div id="info-${idx}" style="display: none; margin-top: 6px; padding: 8px; background: white; border-radius: 3px;">
                  <div style="margin-bottom: 8px;">
                    ${legacy.map((t: string) => `<div style="padding: 2px 0; font-size: 11px; color: #666;">📦 ${t}</div>`).join('')}
                  </div>
                  ${audio1.length > 0 || audio2.length > 0 ? `
                    <button onclick="toggleDetails('info-tracks-${idx}')" style="margin-top: 8px; padding: 4px 8px; background: white; border: 1px solid #ddd; border-radius: 3px; cursor: pointer; font-size: 11px; color: #666; width: 100%;">
                      <span id="info-tracks-${idx}-btn">▶ Show all tracks (Audio1: ${audio1.length}, Audio2: ${audio2.length})</span>
                    </button>
                    <div id="info-tracks-${idx}" style="display: none; margin-top: 8px;">
                      <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px;">
                        <div style="padding: 8px; background: #fafafa; border-radius: 3px; border: 1px solid #e0e0e0;">
                          <strong style="color: #666; font-size: 11px;">Audio1 Files (${audio1.length})</strong>
                          <div style="margin-top: 6px; max-height: 150px; overflow-y: auto; font-size: 10px; color: #666;">
                            ${audio1.length > 0 ? audio1.map((t: string) => `<div style="padding: 2px 0;">🎵 ${t}</div>`).join('') : '<em style="color: #999;">No tracks</em>'}
                          </div>
                        </div>
                        <div style="padding: 8px; background: #fafafa; border-radius: 3px; border: 1px solid #e0e0e0;">
                          <strong style="color: #666; font-size: 11px;">Audio2 Files (${audio2.length})</strong>
                          <div style="margin-top: 6px; max-height: 150px; overflow-y: auto; font-size: 10px; color: #666;">
                            ${audio2.length > 0 ? audio2.map((t: string) => `<div style="padding: 2px 0;">🎵 ${t}</div>`).join('') : '<em style="color: #999;">No tracks</em>'}
                          </div>
                        </div>
                      </div>
                    </div>
                  ` : ''}
                </div>
              `;
            } else if (issue.details) {
              detailsHtml = `
                <button onclick="toggleDetails('info-${idx}')" style="margin-top: 8px; padding: 4px 8px; background: white; border: 1px solid #ddd; border-radius: 3px; cursor: pointer; font-size: 11px; color: #666;">
                  <span id="info-${idx}-btn">▶ Show details</span>
                </button>
                <div id="info-${idx}" style="display: none; margin-top: 6px; padding: 8px; background: white; border-radius: 3px; font-size: 11px; color: #888; max-height: 200px; overflow-y: auto;">
                  <pre style="margin: 0; white-space: pre-wrap; word-wrap: break-word;">${JSON.stringify(issue.details, null, 2)}</pre>
                </div>
              `;
            }
            
            return `
            <div style="margin-bottom: 12px; padding: 12px 16px; background: #e3f2fd; border-left: 4px solid #1976d2; border-radius: 4px;">
              <div style="display: flex; justify-content: space-between; margin-bottom: 6px;">
                <div><span class="event-code">${issue.eventCode}</span>${s3Link}</div>
                <span class="badge info" style="font-size: 11px;">${issue.category}</span>
              </div>
              <div style="color: #666; font-size: 14px;">${issue.message}</div>
              ${detailsHtml}
            </div>
            `;
          }).join('')}
        </div>
      ` : ''}

      ${data.trackCountMismatches.length > 0 ? `
        <h3 style="margin: 30px 0 15px;">📊 Track Count Mismatches (${data.trackCountMismatches.length})</h3>
        <p style="margin-bottom: 15px; color: #666; font-size: 14px;">CSV expected track count differs from actual files found in S3:</p>
        <table>
          <thead>
            <tr>
              <th>Event Code</th>
              <th>Expected</th>
              <th>Parsed</th>
              <th>Difference</th>
            </tr>
          </thead>
          <tbody>
            ${data.trackCountMismatches.map(m => {
              const diff = m.parsed - m.expected;
              const diffClass = diff > 0 ? 'info' : 'warning';
              return `
                <tr>
                  <td><span class="event-code">${m.eventCode}</span></td>
                  <td>${m.expected}</td>
                  <td>${m.parsed}</td>
                  <td><span class="badge ${diffClass}">${diff > 0 ? '+' : ''}${diff}</span></td>
                </tr>
              `;
            }).join('')}
          </tbody>
        </table>
      ` : ''}
    </div>

    <!-- Tab 4: Events List -->
    <div class="tab-content">
      <h2 style="margin-bottom: 20px;">All Events</h2>

      <p style="margin-bottom: 20px; color: #666;">
        Complete list of ${data.eventsList.length} events from CSV, color-coded by issue severity.
        Click any event to view details and issues.
      </p>

      <div style="margin-bottom: 20px;">
        ${data.eventsList.map((event, idx) => {
          const s3Url = createS3Url(event.s3Directory);
          const s3Link = s3Url
            ? `<a href="${s3Url}" target="_blank" class="s3-link" title="View in S3">🔗</a>`
            : '';
          
          // Determine background color based on worst issue severity
          let bgColor = '#f0f9ff'; // Default: light blue (no issues)
          let borderColor = '#1976d2';
          let statusIcon = '✅';
          
          if (event.errorCount > 0) {
            bgColor = '#ffebee';
            borderColor = '#d32f2f';
            statusIcon = '❌';
          } else if (event.warningCount > 0) {
            bgColor = '#fff3e0';
            borderColor = '#f57c00';
            statusIcon = '⚠️';
          } else if (event.infoCount > 0) {
            bgColor = '#e3f2fd';
            borderColor = '#1976d2';
            statusIcon = 'ℹ️';
          }
          
          const issueCount = event.errorCount + event.warningCount + event.infoCount;
          const hasIssues = issueCount > 0;
          
          return `
          <div style="margin-bottom: 12px; background: ${bgColor}; border-left: 4px solid ${borderColor}; border-radius: 4px;">
            <div onclick="toggleDetails('event-${idx}')" style="padding: 12px 16px; cursor: ${hasIssues ? 'pointer' : 'default'};">
              <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px;">
                <div style="flex: 1;">
                  <span style="font-size: 18px; margin-right: 8px;">${statusIcon}</span>
                  <span class="event-code">${event.eventCode}</span>${s3Link}
                  ${!event.hasAudio ? ' <span style="color: #999; font-size: 11px; margin-left: 8px;">(no audio)</span>' : ''}
                </div>
                ${hasIssues ? `
                  <div style="display: flex; gap: 8px; align-items: center;">
                    ${event.errorCount > 0 ? `<span class="badge error" style="font-size: 11px;">${event.errorCount} error${event.errorCount > 1 ? 's' : ''}</span>` : ''}
                    ${event.warningCount > 0 ? `<span class="badge warning" style="font-size: 11px;">${event.warningCount} warning${event.warningCount > 1 ? 's' : ''}</span>` : ''}
                    ${event.infoCount > 0 ? `<span class="badge info" style="font-size: 11px;">${event.infoCount} info</span>` : ''}
                    <span id="event-${idx}-btn" style="font-size: 11px; color: #666;">▶</span>
                  </div>
                ` : ''}
              </div>
              <div style="color: #666; font-size: 14px;">${event.title}</div>
              ${event.hasTracks ? `
                <div style="margin-top: 6px; font-size: 11px; color: #999;">
                  Audio1: ${event.audio1Tracks.length} tracks | Audio2: ${event.audio2Tracks.length} tracks
                </div>
              ` : ''}
            </div>
            
            ${hasIssues ? `
              <div id="event-${idx}" style="display: none; padding: 0 16px 16px;">
                <div style="border-top: 1px solid #ddd; padding-top: 12px;">
                  
                  ${event.issues.filter(i => i.severity === 'error').length > 0 ? `
                    <div style="margin-bottom: 16px;">
                      <strong style="color: #d32f2f; font-size: 12px;">❌ ERRORS</strong>
                      ${event.issues.filter(i => i.severity === 'error').map((issue, issueIdx) => `
                        <div style="margin: 8px 0; padding: 8px; background: white; border-radius: 3px; border: 1px solid #ffcdd2;">
                          <div style="font-size: 11px; color: #d32f2f; font-weight: bold; margin-bottom: 4px;">${issue.category.toUpperCase()}</div>
                          <div style="font-size: 12px; color: #666;">${issue.message}</div>
                          ${issue.details ? `
                            <button onclick="toggleDetails('event-${idx}-error-${issueIdx}')" style="margin-top: 6px; padding: 3px 6px; background: white; border: 1px solid #ddd; border-radius: 2px; cursor: pointer; font-size: 10px; color: #666;">
                              <span id="event-${idx}-error-${issueIdx}-btn">▶ Show details</span>
                            </button>
                            <div id="event-${idx}-error-${issueIdx}" style="display: none; margin-top: 6px; padding: 6px; background: #fafafa; border-radius: 2px; font-size: 10px; color: #888; max-height: 150px; overflow-y: auto;">
                              <pre style="margin: 0; white-space: pre-wrap; word-wrap: break-word;">${JSON.stringify(issue.details, null, 2)}</pre>
                            </div>
                          ` : ''}
                        </div>
                      `).join('')}
                    </div>
                  ` : ''}
                  
                  ${event.issues.filter(i => i.severity === 'warning').length > 0 ? `
                    <div style="margin-bottom: 16px;">
                      <strong style="color: #f57c00; font-size: 12px;">⚠️ WARNINGS</strong>
                      ${event.issues.filter(i => i.severity === 'warning').map((issue, issueIdx) => `
                        <div style="margin: 8px 0; padding: 8px; background: white; border-radius: 3px; border: 1px solid #ffe0b2;">
                          <div style="font-size: 11px; color: #f57c00; font-weight: bold; margin-bottom: 4px;">${issue.category.toUpperCase()}</div>
                          <div style="font-size: 12px; color: #666;">${issue.message}</div>
                          ${issue.details ? `
                            <button onclick="toggleDetails('event-${idx}-warning-${issueIdx}')" style="margin-top: 6px; padding: 3px 6px; background: white; border: 1px solid #ddd; border-radius: 2px; cursor: pointer; font-size: 10px; color: #666;">
                              <span id="event-${idx}-warning-${issueIdx}-btn">▶ Show details</span>
                            </button>
                            <div id="event-${idx}-warning-${issueIdx}" style="display: none; margin-top: 6px; padding: 6px; background: #fafafa; border-radius: 2px; font-size: 10px; color: #888; max-height: 150px; overflow-y: auto;">
                              <pre style="margin: 0; white-space: pre-wrap; word-wrap: break-word;">${JSON.stringify(issue.details, null, 2)}</pre>
                            </div>
                          ` : ''}
                        </div>
                      `).join('')}
                    </div>
                  ` : ''}
                  
                  ${event.issues.filter(i => i.severity === 'info').length > 0 ? `
                    <div style="margin-bottom: 16px;">
                      <strong style="color: #1976d2; font-size: 12px;">ℹ️ INFO</strong>
                      ${event.issues.filter(i => i.severity === 'info').map((issue, issueIdx) => `
                        <div style="margin: 8px 0; padding: 8px; background: white; border-radius: 3px; border: 1px solid #bbdefb;">
                          <div style="font-size: 11px; color: #1976d2; font-weight: bold; margin-bottom: 4px;">${issue.category.toUpperCase()}</div>
                          <div style="font-size: 12px; color: #666;">${issue.message}</div>
                          ${issue.details ? `
                            <button onclick="toggleDetails('event-${idx}-info-${issueIdx}')" style="margin-top: 6px; padding: 3px 6px; background: white; border: 1px solid #ddd; border-radius: 2px; cursor: pointer; font-size: 10px; color: #666;">
                              <span id="event-${idx}-info-${issueIdx}-btn">▶ Show details</span>
                            </button>
                            <div id="event-${idx}-info-${issueIdx}" style="display: none; margin-top: 6px; padding: 6px; background: #fafafa; border-radius: 2px; font-size: 10px; color: #888; max-height: 150px; overflow-y: auto;">
                              <pre style="margin: 0; white-space: pre-wrap; word-wrap: break-word;">${JSON.stringify(issue.details, null, 2)}</pre>
                            </div>
                          ` : ''}
                        </div>
                      `).join('')}
                    </div>
                  ` : ''}
                  
                  ${event.hasTracks ? `
                    <div style="margin-top: 16px;">
                      <button onclick="toggleDetails('event-${idx}-tracks')" style="padding: 4px 8px; background: white; border: 1px solid #ddd; border-radius: 3px; cursor: pointer; font-size: 11px; color: #666; width: 100%;">
                        <span id="event-${idx}-tracks-btn">▶ Show folder contents (Audio1: ${event.audio1Tracks.length}, Audio2: ${event.audio2Tracks.length})</span>
                      </button>
                      <div id="event-${idx}-tracks" style="display: none; margin-top: 8px;">
                        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px;">
                          <div style="padding: 8px; background: #fafafa; border-radius: 3px; border: 1px solid #e0e0e0;">
                            <strong style="color: #666; font-size: 11px;">Audio1 Files (${event.audio1Tracks.length})</strong>
                            <div style="margin-top: 6px; max-height: 150px; overflow-y: auto; font-size: 10px; color: #666;">
                              ${event.audio1Tracks.length > 0 ? event.audio1Tracks.map((t: string) => `<div style="padding: 2px 0;">🎵 ${t}</div>`).join('') : '<em style="color: #999;">No tracks</em>'}
                            </div>
                          </div>
                          <div style="padding: 8px; background: #fafafa; border-radius: 3px; border: 1px solid #e0e0e0;">
                            <strong style="color: #666; font-size: 11px;">Audio2 Files (${event.audio2Tracks.length})</strong>
                            <div style="margin-top: 6px; max-height: 150px; overflow-y: auto; font-size: 10px; color: #666;">
                              ${event.audio2Tracks.length > 0 ? event.audio2Tracks.map((t: string) => `<div style="padding: 2px 0;">🎵 ${t}</div>`).join('') : '<em style="color: #999;">No tracks</em>'}
                            </div>
                          </div>
                        </div>
                      </div>
                    </div>
                  ` : ''}
                </div>
              </div>
            ` : ''}
          </div>
          `;
        }).join('')}
      </div>
    </div>

    <!-- Tab 5: Events Without Audio -->
    <div class="tab-content">
      <h2 style="margin-bottom: 20px;">Events Without Audio Files</h2>

      <p style="margin-bottom: 20px; color: #666;">
        ${data.eventsWithoutTracks.length} events have no audio files (neither audio1 nor audio2).
        These events may have transcripts only, or audio files may not have been uploaded yet.
      </p>

      ${data.eventsWithoutTracks.length > 0 ? `
        <table>
          <thead>
            <tr>
              <th>Event Code</th>
              <th>Title</th>
              <th style="text-align: center;">S3 Folder</th>
            </tr>
          </thead>
          <tbody>
            ${data.eventsWithoutTracks.map(evt => {
              const s3Url = createS3Url(evt.s3Directory);
              const s3Link = s3Url
                ? `<a href="${s3Url}" target="_blank" class="s3-link" title="View in S3">🔗</a>`
                : '<span style="color: #ccc;" title="No S3 directory found">—</span>';
              return `
              <tr>
                <td><span class="event-code">${evt.eventCode}</span></td>
                <td style="color: #666;">${evt.title}</td>
                <td style="text-align: center;">${s3Link}</td>
              </tr>
              `;
            }).join('')}
          </tbody>
        </table>

        <div style="margin-top: 20px; padding: 15px; background: #e3f2fd; border-left: 4px solid #2196f3; border-radius: 4px;">
          <strong>ℹ️ Note:</strong> These events will not appear in the bucket tree since there are no audio files to migrate.
          Check the original S3 bucket or Wix export to verify if audio files exist but weren't properly linked in the CSV.
        </div>
      ` : `
        <div class="no-results">All events have audio files! 🎉</div>
      `}
    </div>
  </div>

  <script>
    let currentTab = 0;

    function switchTab(index) {
      const tabs = document.querySelectorAll('.tab');
      const contents = document.querySelectorAll('.tab-content');

      tabs.forEach((tab, i) => {
        tab.classList.toggle('active', i === index);
      });

      contents.forEach((content, i) => {
        content.classList.toggle('active', i === index);
      });

      currentTab = index;
    }

    function toggleFolder(element) {
      const folder = element.parentElement;
      const content = folder.querySelector('.folder-content');

      if (content) {
        const isCollapsed = content.classList.contains('collapsed');
        content.classList.toggle('collapsed');
        folder.classList.toggle('expanded', isCollapsed);
      }
    }

    function expandAll() {
      const folders = document.querySelectorAll('.folder-content');
      folders.forEach(folder => {
        folder.classList.remove('collapsed');
        folder.parentElement.classList.add('expanded');
      });
    }

    function collapseAll() {
      const folders = document.querySelectorAll('.folder-content');
      folders.forEach(folder => {
        folder.classList.add('collapsed');
        folder.parentElement.classList.remove('expanded');
      });
    }

    function filterTree() {
      const searchTerm = document.getElementById('treeSearch').value.toLowerCase();
      const treeView = document.getElementById('treeView');
      const noResults = document.getElementById('noResults');

      if (!searchTerm) {
        // Show all
        document.querySelectorAll('.folder, .file').forEach(el => {
          el.style.display = '';
        });
        collapseAll();
        treeView.style.display = '';
        noResults.style.display = 'none';
        return;
      }

      let hasResults = false;

      // Filter folders and files
      document.querySelectorAll('.folder, .file').forEach(el => {
        const name = el.getAttribute('data-name') || '';
        const matches = name.includes(searchTerm);

        if (matches) {
          el.style.display = '';
          hasResults = true;

          // Expand parent folders
          let parent = el.parentElement;
          while (parent) {
            if (parent.classList.contains('folder-content')) {
              parent.classList.remove('collapsed');
              parent.parentElement.classList.add('expanded');
            }
            parent = parent.parentElement;
          }
        } else {
          el.style.display = 'none';
        }
      });

      treeView.style.display = hasResults ? '' : 'none';
      noResults.style.display = hasResults ? 'none' : '';
    }

    // Auto-expand first event on load
    window.addEventListener('load', () => {
      const firstFolder = document.querySelector('.tree-view > ul > li.folder .folder-content');
      if (firstFolder) {
        firstFolder.classList.remove('collapsed');
        firstFolder.parentElement.classList.add('expanded');
      }
    });

    // Toggle track list expansion
    function toggleTracks(index) {
      const preview = document.getElementById(\`tracks-preview-\${index}\`);
      const full = document.getElementById(\`tracks-full-\${index}\`);

      if (full.style.display === 'none') {
        preview.style.display = 'none';
        full.style.display = 'block';
      } else {
        preview.style.display = 'block';
        full.style.display = 'none';
      }
    }

    // Toggle issue details expansion
    function toggleDetails(id) {
      const details = document.getElementById(id);
      const btn = document.getElementById(id + '-btn');
      const currentText = btn.textContent;

      if (details.style.display === 'none') {
        details.style.display = 'block';
        // Replace "Show" with "Hide" and "▶" with "▼"
        btn.textContent = currentText.replace('▶ Show', '▼ Hide');
      } else {
        details.style.display = 'none';
        // Replace "Hide" with "Show" and "▼" with "▶"
        btn.textContent = currentText.replace('▼ Hide', '▶ Show');
      }
    }

    // Scroll to section with smooth animation
    function scrollToSection(sectionId) {
      const section = document.getElementById(sectionId);
      if (section) {
        section.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    }

    // Sort table by column
    let sortDirection = [true, true]; // true = ascending, false = descending

    function sortTable(column) {
      const table = document.getElementById('legacyTable');
      const tbody = table.querySelector('tbody');
      const rows = Array.from(tbody.querySelectorAll('tr'));

      const isAscending = sortDirection[column];
      sortDirection[column] = !sortDirection[column];

      rows.sort((a, b) => {
        let aVal, bVal;

        if (column === 0) {
          // Event code - sort alphabetically
          aVal = a.cells[0].textContent.trim();
          bVal = b.cells[0].textContent.trim();
        } else if (column === 1) {
          // Track count - sort numerically
          aVal = parseInt(a.cells[1].textContent.match(/\\d+/)[0]);
          bVal = parseInt(b.cells[1].textContent.match(/\\d+/)[0]);
        }

        if (aVal < bVal) return isAscending ? -1 : 1;
        if (aVal > bVal) return isAscending ? 1 : -1;
        return 0;
      });

      // Reattach sorted rows
      rows.forEach(row => tbody.appendChild(row));

      // Update sort indicators
      table.querySelectorAll('.sort-indicator').forEach((ind, idx) => {
        if (idx === column) {
          ind.textContent = isAscending ? '↑' : '↓';
        } else {
          ind.textContent = '⇅';
        }
      });
    }
  </script>
</body>
</html>`;
}

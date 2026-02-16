/**
 * Track deduplication logic for migration.
 *
 * Determines which tracks should go to main folder vs Legacy folder.
 */

export interface TrackClassification {
  mainTracks: string[];        // Bilingual tracks (audio2) - go to main folder
  legacyTracks: string[];      // Unique audio1 tracks - go to Legacy folder
  duplicates: string[];        // Audio1 tracks that have equivalents in audio2
}

/**
 * Normalize track name for comparison (remove language markers, numbers, etc.)
 */
function normalizeTrackName(name: string): string {
  return name
    .toLowerCase()
    // Remove file extension
    .replace(/\.(mp3|wav|m4a|flac|ogg|aac|wma)$/i, "")
    // Remove language markers
    .replace(/\[eng\]/gi, "")
    .replace(/\[por\]/gi, "")
    .replace(/\[ing\+por\]/gi, "")
    .replace(/\[bing\+por\]/gi, "")
    .replace(/\[tib\]/gi, "")
    // Remove translation markers
    .replace(/\btrad\b/gi, "")
    .replace(/_trad/gi, "")
    .replace(/trad_/gi, "")
    .replace(/traduç[aã]o/gi, "")
    // Remove track numbers at start
    .replace(/^(\d+[a-z]?[\s_\-\.]+)/gi, "")
    // Normalize separators
    .replace(/[\s_\-\.]+/g, " ")
    .trim();
}

/**
 * Extract core content identifier from track name
 * Examples:
 *   "001 JKR - Opening prayers.mp3" → "jkr opening prayers"
 *   "001a TRAD - Oracoes iniciais.mp3" → "jkr opening prayers" (matches translation)
 */
function extractCoreIdentifier(name: string): string {
  const normalized = normalizeTrackName(name);

  // Remove common speaker abbreviations if they're at the start
  const withoutSpeaker = normalized.replace(/^(jkr|pwr|kps|srr|cnr|ymr|dk|mttr)\s+/i, "");

  return withoutSpeaker.trim();
}

/**
 * Calculate similarity between two strings (0 to 1)
 */
function calculateSimilarity(str1: string, str2: string): number {
  const s1 = str1.toLowerCase();
  const s2 = str2.toLowerCase();

  // Exact match
  if (s1 === s2) return 1.0;

  // Check if one contains the other
  if (s1.includes(s2) || s2.includes(s1)) {
    return Math.max(s2.length / s1.length, s1.length / s2.length);
  }

  // Levenshtein-like similarity
  const longer = s1.length > s2.length ? s1 : s2;
  const shorter = s1.length > s2.length ? s2 : s1;

  if (longer.length === 0) return 1.0;

  // Count common substrings
  let matches = 0;
  const words1 = s1.split(/\s+/);
  const words2 = s2.split(/\s+/);

  for (const word1 of words1) {
    for (const word2 of words2) {
      if (word1.length > 2 && word2.length > 2 && word1 === word2) {
        matches++;
      }
    }
  }

  return matches / Math.max(words1.length, words2.length);
}

/**
 * Find if an audio1 track has an equivalent in audio2
 */
function findBilingualEquivalent(audio1Track: string, audio2Tracks: string[]): string | null {
  const audio1Core = extractCoreIdentifier(audio1Track);

  for (const audio2Track of audio2Tracks) {
    const audio2Core = extractCoreIdentifier(audio2Track);

    // High similarity threshold (80%) to avoid false positives
    const similarity = calculateSimilarity(audio1Core, audio2Core);
    if (similarity >= 0.8) {
      return audio2Track;
    }
  }

  return null;
}

/**
 * Classify tracks into main (bilingual) vs legacy (unique audio1) vs duplicates.
 *
 * Strategy:
 * 1. Pick the folder with MORE tracks as main folder (usually bilingual/complete)
 * 2. Tracks from smaller folder with equivalents in main → duplicates (skip)
 * 3. Tracks from smaller folder WITHOUT equivalents → Legacy folder
 */
export function classifyTracks(
  audio1Tracks: string[],
  audio2Tracks: string[],
): TrackClassification {
  // Choose the folder with more tracks as main
  const useAudio2AsMain = audio2Tracks.length >= audio1Tracks.length;

  const mainTracks = useAudio2AsMain ? [...audio2Tracks] : [...audio1Tracks];
  const checkTracks = useAudio2AsMain ? audio1Tracks : audio2Tracks;
  const legacyTracks: string[] = [];
  const duplicates: string[] = [];

  // Check each track from the smaller folder
  for (const track of checkTracks) {
    const equivalent = findBilingualEquivalent(track, mainTracks);

    if (equivalent) {
      // This track has an equivalent in main folder
      duplicates.push(track);
    } else {
      // This track is unique - needs to go to Legacy folder
      legacyTracks.push(track);
    }
  }

  return {
    mainTracks,
    legacyTracks,
    duplicates,
  };
}

/**
 * Generate a tree structure showing how tracks will be organized in the new bucket.
 */
export interface TreeNode {
  name: string;
  type: "folder" | "file";
  children?: TreeNode[];
  source?: "audio2" | "audio1-legacy";
  count?: number;
  s3Directory?: string | null;  // S3 path to the folder
}

export function generateBucketTree(
  eventCode: string,
  audio1Tracks: string[],
  audio2Tracks: string[],
  s3Directory?: string | null,
): TreeNode {
  const classification = classifyTracks(audio1Tracks, audio2Tracks);

  const children: TreeNode[] = [];

  // Main folder tracks (bilingual)
  for (const track of classification.mainTracks) {
    children.push({
      name: track,
      type: "file",
      source: "audio2",
    });
  }

  // Legacy folder (unique audio1 tracks)
  if (classification.legacyTracks.length > 0) {
    const legacyChildren: TreeNode[] = classification.legacyTracks.map(track => ({
      name: track,
      type: "file",
      source: "audio1-legacy",
    }));

    children.push({
      name: "Legacy",
      type: "folder",
      count: classification.legacyTracks.length,
      children: legacyChildren,
    });
  }

  return {
    name: eventCode,
    type: "folder",
    count: classification.mainTracks.length + classification.legacyTracks.length,
    children,
    s3Directory,
  };
}

/**
 * Render tree structure as text
 */
export function renderTree(node: TreeNode, indent = ""): string {
  let output = "";

  if (node.type === "folder") {
    const countStr = node.count ? ` (${node.count} files)` : "";
    output += `${indent}📁 ${node.name}${countStr}\n`;

    if (node.children) {
      const childIndent = indent + "  ";
      for (let i = 0; i < node.children.length; i++) {
        const child = node.children[i]!;
        const isLast = i === node.children.length - 1;
        const prefix = isLast ? "└─ " : "├─ ";

        if (child.type === "file") {
          const sourceIcon = child.source === "audio2" ? "🎵" : "📦";
          output += `${childIndent}${prefix}${sourceIcon} ${child.name}\n`;
        } else {
          output += renderTree(child, childIndent + (isLast ? "   " : "│  "));
        }
      }
    }
  }

  return output;
}

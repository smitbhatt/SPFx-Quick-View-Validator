import * as fs from 'fs';
import * as path from 'path';
import { DEFAULT_JSON_FILE_PATTERNS } from './types';

/**
 * Resolves the Quick View TypeScript implementation associated with a
 * `quickview.json` file, using deterministic workspace structure instead of
 * scanning the whole workspace for arbitrary files.
 *
 * Convention (common SPFx Adaptive Card Extension layout):
 *
 *   src/adaptiveCardExtensions/<name>/quickView/QuickView.ts
 *   src/adaptiveCardExtensions/<name>/quickView/quickview.json       (or QuickViewTemplate.json)
 *
 * Lookup order:
 *   1. Manual override recorded by the "Select Associated TypeScript File" command.
 *   2. `<json dir>/<something>QuickView.ts` — an exact `quickView.ts` / `QuickView.ts`
 *      wins; otherwise a single match resolves and multiple matches are ambiguous.
 *   3. A sibling `quickView/` directory next to the JSON's directory
 *      (e.g. JSON under `assets/`, TypeScript under `quickView/`).
 *   4. The parent directory of the JSON's directory.
 */

export type AssociationStatus = 'resolved' | 'ambiguous' | 'none';

export interface Association {
  status: AssociationStatus;
  /** Absolute path of the associated TypeScript file when resolved. */
  tsPath?: string;
  /** All candidate files that matched the naming convention (resolved or ambiguous). */
  candidates: string[];
}

export interface CandidateDiscovery {
  /** The preferred candidate, if any. */
  primary?: string;
  /** Every candidate found, in preference order. */
  all: string[];
}

const QUICK_VIEW_TS_PATTERN = /quickview\.ts$/i;
const EXACT_QUICK_VIEW_TS = /^(?:quickview)\.ts$/i;

/** Converts a simple glob-like pattern (`*` wildcard) into a case-insensitive RegExp. */
function patternToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`, 'i');
}

/**
 * True when the file name matches one of the configured Quick View JSON
 * patterns. An empty pattern list falls back to the built-in default so the
 * extension never accidentally claims every JSON file.
 */
export function matchesJsonFilePatterns(filePath: string, patterns: string[]): boolean {
  const base = path.basename(filePath);
  const effective = patterns.length > 0 ? patterns : DEFAULT_JSON_FILE_PATTERNS;
  return effective.some((pattern) => patternToRegExp(pattern).test(base));
}

/** True for JSON files this extension should treat as Quick View templates. */
export function isQuickViewJsonPath(filePath: string, patterns: string[] = DEFAULT_JSON_FILE_PATTERNS): boolean {
  return matchesJsonFilePatterns(filePath, patterns);
}

/** True for TypeScript files that follow the Quick View naming convention. */
export function isQuickViewTypeScriptPath(filePath: string): boolean {
  return QUICK_VIEW_TS_PATTERN.test(path.basename(filePath));
}

function listTypeScriptCandidates(dir: string): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isFile() && isQuickViewTypeScriptPath(e.name))
    .map((e) => path.join(dir, e.name))
    .sort((a, b) => a.localeCompare(b));
}

function dedupe(paths: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const p of paths) {
    const key = p.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      result.push(p);
    }
  }
  return result;
}

/** Discovers TypeScript candidates for a Quick View JSON file, in preference order. */
export function discoverTypeScriptCandidates(jsonPath: string): CandidateDiscovery {
  const jsonDir = path.dirname(jsonPath);
  const searchDirs = [jsonDir, path.join(path.dirname(jsonDir), 'quickView'), path.dirname(jsonDir)];
  const dirKey = jsonDir.toLowerCase();

  let all: string[] = [];
  for (const dir of searchDirs) {
    if (dir.toLowerCase() === dirKey && dir !== jsonDir) {
      continue; // never search the same directory twice (case-insensitively)
    }
    const found = listTypeScriptCandidates(dir);
    if (found.length > 0) {
      all = dedupe(found);
      break;
    }
  }

  if (all.length === 0) {
    return { all: [] };
  }

  const exact = all.find((p) => EXACT_QUICK_VIEW_TS.test(path.basename(p)));
  return { primary: exact ?? (all.length === 1 ? all[0] : undefined), all };
}

/**
 * Resolves the TypeScript file associated with `jsonPath`.
 * `manualOverride` (absolute path) always wins when the file exists.
 */
export function resolveAssociatedTypeScript(jsonPath: string, manualOverride?: string): Association {
  if (manualOverride) {
    try {
      if (fs.statSync(manualOverride).isFile()) {
        return { status: 'resolved', tsPath: manualOverride, candidates: [manualOverride] };
      }
    } catch {
      // fall through to automatic resolution when the override disappeared
    }
  }

  const { primary, all } = discoverTypeScriptCandidates(jsonPath);
  if (primary) {
    return { status: 'resolved', tsPath: primary, candidates: all };
  }
  if (all.length > 0) {
    return { status: 'ambiguous', candidates: all };
  }
  return { status: 'none', candidates: [] };
}

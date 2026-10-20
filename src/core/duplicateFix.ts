import { randomBytes } from 'crypto';
import { IdReference } from './jsonDocument';

/**
 * Unique-ID generation for the "Fix duplicate ID" quick fix.
 *
 * Placement rules are deterministic; only the random suffix varies:
 *   - ID contains `${...}`: insert `suffix_` immediately before the first
 *     `${` marker, preserving the marker and every following character
 *     (`item_${employeeId}_${$index}` → `item_a3f91c_${employeeId}_${$index}`).
 *   - ID contains no expression: append `_suffix`
 *     (`employee_name` → `employee_name_a3f91c`).
 *
 * Everything here is VS Code-independent so the whole flow is unit-testable.
 */

/** Length of the generated hex suffix (six lowercase hex characters). */
export const SUFFIX_LENGTH = 6;

/** How often a fresh suffix is tried before giving up. */
export const MAX_FIX_ATTEMPTS = 20;

/** A cryptographically secure short hex suffix (six characters). */
export function randomIdSuffix(): string {
  return randomBytes(SUFFIX_LENGTH / 2).toString('hex');
}

/** Applies the deterministic placement rule for `suffix` to `id`. */
export function applyIdSuffix(id: string, suffix: string): string {
  const marker = id.indexOf('${');
  return marker === -1 ? `${id}_${suffix}` : `${id.slice(0, marker)}${suffix}_${id.slice(marker)}`;
}

export interface DuplicateIdFixPlan {
  /**
   * Text to substitute for the raw ID string content (between the quotes).
   * Derived from the raw source text, so any escape sequences in the
   * original are preserved.
   */
  replacementText: string;
  /** The resulting (unescaped) ID value after the edit. */
  value: string;
  suffix: string;
}

export type DuplicateIdFixResult = DuplicateIdFixPlan | { error: string };

export interface UniqueIdCandidate {
  id: string;
  suffix: string;
}

export type UniqueIdResult = UniqueIdCandidate | { error: string };

/**
 * Generates a unique replacement for `originalId`, checking every candidate
 * against `taken` (all element IDs in the document). The accepted candidate
 * is added to `taken` immediately, so consecutive calls never collide with
 * each other. `provideSuffix` is injectable for deterministic tests.
 */
export function generateDuplicateIdFix(
  originalId: string,
  taken: Set<string>,
  provideSuffix: () => string = randomIdSuffix,
  attempts: number = MAX_FIX_ATTEMPTS
): UniqueIdResult {
  if (typeof originalId !== 'string' || originalId.length === 0) {
    return { error: 'the duplicate ID is empty' };
  }
  for (let attempt = 0; attempt < attempts; attempt++) {
    const suffix = provideSuffix();
    const candidate = applyIdSuffix(originalId, suffix);
    if (!taken.has(candidate)) {
      taken.add(candidate);
      return { id: candidate, suffix };
    }
  }
  return { error: `could not generate a unique ID for "${originalId}" after ${attempts} attempts` };
}

/** Decodes raw JSON string content (text between the quotes) to its value. */
function decodeJsonStringContent(raw: string): string | undefined {
  try {
    const parsed = JSON.parse(`"${raw}"`);
    return typeof parsed === 'string' ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Plans the "Fix duplicate ID" edit for one occurrence and re-validates
 * every precondition against the *current* document, so a stale diagnostic
 * can never corrupt the file:
 *
 *  - the source range must point at a parsed `id` with the expected value;
 *  - that ID must still be duplicated;
 *  - the generated candidate must not collide with any current ID
 *    (previous fixes included).
 *
 * `provideSuffix` lets callers pass the suffix that was previewed in the
 * quick-fix title; fresh random suffixes are tried after the first attempt.
 */
export function planDuplicateIdFix(
  text: string,
  target: { offset: number; length: number; expectedId: string },
  parsedIds: IdReference[],
  provideSuffix?: () => string,
  attempts: number = MAX_FIX_ATTEMPTS
): DuplicateIdFixResult {
  if (
    !target ||
    typeof target.expectedId !== 'string' ||
    target.expectedId.length === 0 ||
    !Number.isInteger(target.offset) ||
    !Number.isInteger(target.length) ||
    target.offset < 0 ||
    target.length <= 0 ||
    target.offset + target.length > text.length
  ) {
    return { error: 'the duplicate ID diagnostic has no valid source range' };
  }

  const targetStillThere = parsedIds.some(
    (id) => id.value === target.expectedId && id.offset === target.offset && id.length === target.length
  );
  if (!targetStillThere) {
    return { error: 'the document changed since the diagnostic was reported' };
  }

  const taken = new Set<string>();
  for (const id of parsedIds) {
    taken.add(id.value);
  }
  if (!isDuplicated(target.expectedId, parsedIds)) {
    return { error: `"${target.expectedId}" is no longer duplicated` };
  }

  // The first occurrence always keeps the original ID (the same invariant
  // the diagnostics advertise through `keepOffset`).
  let firstOccurrenceOffset = Number.POSITIVE_INFINITY;
  for (const id of parsedIds) {
    if (id.value === target.expectedId && id.offset < firstOccurrenceOffset) {
      firstOccurrenceOffset = id.offset;
    }
  }
  if (target.offset === firstOccurrenceOffset) {
    return { error: `"${target.expectedId}" is kept by the first occurrence — fix a later one instead` };
  }

  // Work on the *raw* source text so escape sequences stay intact; the
  // resulting value is decoded for the uniqueness check.
  const raw = text.substr(target.offset, target.length);
  for (let attempt = 0; attempt < attempts; attempt++) {
    // The first attempt prefers the suffix that was previewed in the
    // quick-fix title; every further attempt uses a fresh random suffix.
    const suffix = attempt === 0 && provideSuffix !== undefined ? provideSuffix() : randomIdSuffix();
    const replacementText = applyIdSuffix(raw, suffix);
    const value = decodeJsonStringContent(replacementText);
    if (value === undefined) {
      return { error: 'the ID string content could not be decoded safely' };
    }
    if (!taken.has(value)) {
      taken.add(value);
      return { replacementText, value, suffix };
    }
  }
  return { error: `could not generate a unique ID for "${target.expectedId}" after ${attempts} attempts` };
}

function isDuplicated(value: string, parsedIds: IdReference[]): boolean {
  let count = 0;
  for (const id of parsedIds) {
    if (id.value === value && ++count > 1) {
      return true;
    }
  }
  return false;
}

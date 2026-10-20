import { CompareOperator, ConditionConstant, OccurrenceVisibility, VisibilityCondition } from './conditions';

/**
 * Pairwise static analysis of two sibling elements' visibility conditions.
 *
 * Verdicts:
 *   `exclusive`     — at most one of the two elements can render at runtime.
 *   `overlap`       — both conditions can hold simultaneously (reported as an error).
 *   `undetermined`  — mutual exclusivity could not be proven (reported as a warning).
 *
 * The analysis is deliberately asymmetric in risk: anything not provable is
 * `undetermined` (warning) or `overlap` (error) — never silently `exclusive`.
 */

export type ExclusivityVerdict = 'exclusive' | 'overlap' | 'undetermined';

/** Classification of a whole duplicate group (all occurrences of one ID). */
export type GroupClassification =
  /** At least one pair can coexist at runtime. */
  | 'coexist'
  /** Conditions exist but mutual exclusivity could not be proven. */
  | 'unproven'
  /** Every pair is proven mutually exclusive. */
  | 'exclusive';

function isAlways(condition: VisibilityCondition): boolean {
  return condition.kind === 'unconditional' || condition.kind === 'always';
}

/** True when two visibility conditions can hold at the same time. */
export function compareVisibility(a: OccurrenceVisibility, b: OccurrenceVisibility): ExclusivityVerdict {
  const ac = a.condition;
  const bc = b.condition;
  if (ac.kind === 'unknown' || bc.kind === 'unknown') {
    return 'undetermined';
  }
  if (ac.kind === 'never' || bc.kind === 'never') {
    // An element that never renders cannot coexist with anything.
    return 'exclusive';
  }

  const aAlways = isAlways(ac);
  const bAlways = isAlways(bc);

  if (a.containerPath !== b.containerPath) {
    // Conditions only apply inside their own container; across containers
    // both elements may be rendered by their respective parents.
    return aAlways && bAlways ? 'overlap' : 'undetermined';
  }
  if (aAlways || bAlways) {
    // One element always renders; the other's (non-`never`) condition is
    // satisfiable — comparisons and truthiness checks always admit a value.
    return 'overlap';
  }

  // Same container, both elements are conditional.
  if (ac.kind === 'truthy' && bc.kind === 'truthy') {
    if (ac.path !== bc.path) {
      return 'overlap'; // independent properties
    }
    return ac.negated === bc.negated ? 'overlap' : 'exclusive';
  }
  if (ac.kind === 'compare' && bc.kind === 'compare') {
    if (ac.path !== bc.path) {
      return 'overlap'; // independent properties
    }
    return compareConstants(ac.operator, ac.constant, bc.operator, bc.constant);
  }
  // truthy vs compare
  const truthyPath = ac.kind === 'truthy' ? ac.path : (bc as { path: string }).path;
  const comparePath = ac.kind === 'compare' ? ac.path : (bc as { path: string }).path;
  return truthyPath === comparePath ? 'undetermined' : 'overlap';
}

/**
 * Decides whether two comparisons over the *same* property can hold at once,
 * using interval arithmetic on the compared constants.
 */
function compareConstants(
  opA: CompareOperator,
  a: ConditionConstant,
  opB: CompareOperator,
  b: ConditionConstant
): ExclusivityVerdict {
  if (typeof a.value !== typeof b.value) {
    // e.g. `x > 5` vs `x == "five"` — domains cannot be reconciled safely.
    return 'undetermined';
  }
  const setA = toSet(opA, a.value);
  const setB = toSet(opB, b.value);
  const lt = (x: string | number | boolean, y: string | number | boolean): boolean => x < y;
  for (const intervalA of setA) {
    for (const intervalB of setB) {
      if (intervalsIntersect(intervalA, intervalB, lt)) {
        return 'overlap';
      }
    }
  }
  return 'exclusive';
}

/** A half-open/closed range; `undefined` bounds represent infinity. */
interface Interval {
  lo?: string | number | boolean;
  loInc: boolean;
  hi?: string | number | boolean;
  hiInc: boolean;
}

function toSet(operator: CompareOperator, value: string | number | boolean): Interval[] {
  switch (operator) {
    case '>':
      return [{ lo: value, loInc: false, hi: undefined, hiInc: false }];
    case '>=':
      return [{ lo: value, loInc: true, hi: undefined, hiInc: false }];
    case '<':
      return [{ lo: undefined, loInc: false, hi: value, hiInc: false }];
    case '<=':
      return [{ lo: undefined, loInc: false, hi: value, hiInc: true }];
    case '==':
    case '===':
      return [{ lo: value, loInc: true, hi: value, hiInc: true }];
    case '!=':
    case '!==':
      return [
        { lo: undefined, loInc: false, hi: value, hiInc: false },
        { lo: value, loInc: false, hi: undefined, hiInc: false }
      ];
  }
}

function intervalsIntersect(
  x: Interval,
  y: Interval,
  lt: (a: string | number | boolean, b: string | number | boolean) => boolean
): boolean {
  // Tighter lower bound = larger value.
  let lo: string | number | boolean | undefined;
  let loInc: boolean;
  if (x.lo === undefined) {
    lo = y.lo;
    loInc = y.loInc;
  } else if (y.lo === undefined) {
    lo = x.lo;
    loInc = x.loInc;
  } else if (lt(x.lo, y.lo)) {
    lo = y.lo;
    loInc = y.loInc;
  } else if (lt(y.lo, x.lo)) {
    lo = x.lo;
    loInc = x.loInc;
  } else {
    lo = x.lo;
    loInc = x.loInc && y.loInc;
  }

  // Tighter upper bound = smaller value.
  let hi: string | number | boolean | undefined;
  let hiInc: boolean;
  if (x.hi === undefined) {
    hi = y.hi;
    hiInc = y.hiInc;
  } else if (y.hi === undefined) {
    hi = x.hi;
    hiInc = x.hiInc;
  } else if (lt(x.hi, y.hi)) {
    hi = x.hi;
    hiInc = x.hiInc;
  } else if (lt(y.hi, x.hi)) {
    hi = y.hi;
    hiInc = y.hiInc;
  } else {
    hi = x.hi;
    hiInc = x.hiInc && y.hiInc;
  }

  if (lo === undefined || hi === undefined) {
    return true; // at least one unbounded side
  }
  if (lt(lo, hi)) {
    return true;
  }
  if (lt(hi, lo)) {
    return false;
  }
  return loInc && hiInc; // single point — only if both sides include it
}

/**
 * Classifies a duplicate group: any overlapping pair wins immediately,
 * otherwise any unprovable pair downgrades to `unproven`, otherwise the
 * whole group is proven exclusive.
 */
export function classifyDuplicateGroup(occurrences: OccurrenceVisibility[]): GroupClassification {
  let undetermined = false;
  for (let i = 0; i < occurrences.length; i++) {
    for (let j = i + 1; j < occurrences.length; j++) {
      const verdict = compareVisibility(occurrences[i], occurrences[j]);
      if (verdict === 'overlap') {
        return 'coexist';
      }
      if (verdict === 'undetermined') {
        undetermined = true;
      }
    }
  }
  return undetermined ? 'unproven' : 'exclusive';
}

/**
 * Extraction and parsing of Adaptive Card templating expressions (`${...}`).
 *
 * Supported syntax (statically analyzable):
 *   ${property}
 *   ${property.nestedMember}
 *   Multiple expressions may appear in the same string.
 *
 * Anything else (function calls, indexing, ternaries, filters, arithmetic, ...)
 * is deliberately treated as "unsupported" and skipped to avoid false positives.
 */

const BINDING_PATTERN = /\$\{([^}]*)\}/g;
const SUPPORTED_EXPRESSION = /^[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)*$/;

export interface BindingMatch {
  /** Raw text between `${` and `}` (may contain surrounding whitespace). */
  expression: string;
  /** Offset of the `${...}` span relative to the scanned string. */
  start: number;
  /** Length of the `${...}` span. */
  length: number;
}

export interface ParsedExpression {
  supported: boolean;
  /** Root data property (`undefined` when unsupported). */
  root?: string;
  /** Nested members after the root, e.g. `['name']` for `${employee.name}`. */
  members: string[];
  /** Why the expression was skipped, for debugging. */
  reason?: string;
}

/** Finds every `${...}` occurrence in `text`. */
export function extractBindingExpressions(text: string): BindingMatch[] {
  const matches: BindingMatch[] = [];
  BINDING_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = BINDING_PATTERN.exec(text)) !== null) {
    matches.push({ expression: match[1], start: match.index, length: match[0].length });
  }
  return matches;
}

/** Parses a single binding expression into a statically analyzable path. */
export function parseAdaptiveCardExpression(raw: string): ParsedExpression {
  const expression = raw.trim();
  if (expression.length === 0) {
    return { supported: false, members: [], reason: 'empty expression' };
  }
  if (!SUPPORTED_EXPRESSION.test(expression)) {
    return { supported: false, members: [], reason: 'expression uses syntax that cannot be resolved statically' };
  }
  const parts = expression.split('.');
  return { supported: true, root: parts[0], members: parts.slice(1) };
}

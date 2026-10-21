/**
 * Extraction of Adaptive Card templating expressions (`${...}`) from a string
 * value. Parsing itself lives in `expressions.ts` (the templating expression
 * language) and is driven by `bindingResolver.ts`.
 */

const BINDING_PATTERN = /\$\{([^}]*)\}/g;

export interface BindingMatch {
  /** Raw text between `${` and `}` (may contain surrounding whitespace). */
  expression: string;
  /** Offset of the `${...}` span relative to the scanned string. */
  start: number;
  /** Length of the `${...}` span. */
  length: number;
}

/**
 * Finds every `${...}` occurrence in `text`.
 *
 * Note: like the templating engine's own marker scanning, this stops at the
 * first `}`. A `}` inside a string literal inside an expression therefore ends
 * the match early — an accepted, documented limitation.
 */
export function extractBindingExpressions(text: string): BindingMatch[] {
  const matches: BindingMatch[] = [];
  BINDING_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = BINDING_PATTERN.exec(text)) !== null) {
    matches.push({ expression: match[1], start: match.index, length: match[0].length });
  }
  return matches;
}

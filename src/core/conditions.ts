import { Node } from 'jsonc-parser';
import { IdReference } from './jsonDocument';

/**
 * Static analysis of Adaptive Card element visibility conditions
 * (`$when` and `isVisible`).
 *
 * Analyzable syntax:
 *   true / false (boolean or literal string)
 *   ${flag}  /  ${!flag}             truthiness of a property
 *   ${path > 5}  /  ${path == "a"}   a single comparison of a property
 *                                    against a constant
 *   ${5 < path}                      flipped comparisons are normalized
 *
 * Anything else (function calls, arithmetic, `&&` / `||`, filters, indexing,
 * mixed template text, ...) yields `unknown` — callers must treat that as
 * "cannot be proven", never as "exclusive".
 */

export type CompareOperator = '>' | '>=' | '<' | '<=' | '==' | '!=' | '===' | '!==';

export type ConditionConstant =
  | { type: 'number'; value: number }
  | { type: 'string'; value: string }
  | { type: 'boolean'; value: boolean };

export type VisibilityCondition =
  /** No `$when` / `isVisible` on the element — always rendered. */
  | { kind: 'unconditional' }
  | { kind: 'always' }
  | { kind: 'never' }
  | { kind: 'truthy'; path: string; negated: boolean }
  | { kind: 'compare'; path: string; operator: CompareOperator; constant: ConditionConstant }
  | { kind: 'unknown'; reason: string };

/** A duplicate occurrence together with its container and analyzed condition. */
export interface OccurrenceVisibility {
  containerPath: string;
  condition: VisibilityCondition;
}

const IDENT_PATH = String.raw`[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)*`;
const NUMBER = String.raw`-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?`;
const QUOTED = String.raw`"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'`;
const CONSTANT = `(?:${NUMBER}|${QUOTED}|true|false)`;
const OPERATOR = String.raw`===|!==|>=|<=|==|!=|>|<`;

const COMPARE_PATTERN = new RegExp(`^(${IDENT_PATH})\\s*(${OPERATOR})\\s*(${CONSTANT})$`);
const FLIPPED_PATTERN = new RegExp(`^(${CONSTANT})\\s*(${OPERATOR})\\s*(${IDENT_PATH})$`);
const PATH_PATTERN = new RegExp(`^${IDENT_PATH}$`);
const NEGATED_PATH_PATTERN = new RegExp(String.raw`^!\s*(${IDENT_PATH})$`);

const FLIP: Record<CompareOperator, CompareOperator> = {
  '>': '<',
  '>=': '<=',
  '<': '>',
  '<=': '>=',
  '==': '==',
  '!=': '!=',
  '===': '===',
  '!==': '!=='
};

function parseConstant(raw: string): ConditionConstant | undefined {
  if (raw === 'true') {
    return { type: 'boolean', value: true };
  }
  if (raw === 'false') {
    return { type: 'boolean', value: false };
  }
  if (raw.startsWith('"') || raw.startsWith("'")) {
    // Strip the surrounding quotes; escape handling is deliberately minimal —
    // both compared constants are read the same way, so equality still holds.
    return { type: 'string', value: raw.slice(1, -1) };
  }
  const value = Number(raw);
  return Number.isNaN(value) ? undefined : { type: 'number', value };
}

function unknown(reason: string): VisibilityCondition {
  return { kind: 'unknown', reason };
}

/** Parses the expression inside a `$when` / `isVisible` string. */
export function parseVisibilityExpression(raw: string): VisibilityCondition {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return unknown('empty visibility condition');
  }

  let expression: string;
  const wrapped = /^\$\{([\s\S]*)\}$/.exec(trimmed);
  if (wrapped) {
    expression = wrapped[1].trim();
  } else if (trimmed.includes('${')) {
    // e.g. "show if ${flag}" — template text mixed with the expression.
    return unknown('condition mixes surrounding text with templating expressions');
  } else {
    expression = trimmed; // plain literal such as "true"
  }

  if (expression === 'true') {
    return { kind: 'always' };
  }
  if (expression === 'false') {
    return { kind: 'never' };
  }

  const negated = NEGATED_PATH_PATTERN.exec(expression);
  if (negated) {
    return { kind: 'truthy', path: negated[1], negated: true };
  }

  const compare = COMPARE_PATTERN.exec(expression);
  if (compare) {
    const constant = parseConstant(compare[3]);
    if (constant) {
      return { kind: 'compare', path: compare[1], operator: compare[2] as CompareOperator, constant };
    }
    return unknown(`unsupported constant "${compare[3]}"`);
  }

  const flipped = FLIPPED_PATTERN.exec(expression);
  if (flipped) {
    const constant = parseConstant(flipped[1]);
    if (constant) {
      return {
        kind: 'compare',
        path: flipped[3],
        operator: FLIP[flipped[2] as CompareOperator],
        constant
      };
    }
    return unknown(`unsupported constant "${flipped[1]}"`);
  }

  if (PATH_PATTERN.test(expression)) {
    return { kind: 'truthy', path: expression, negated: false };
  }

  return unknown('visibility expression uses syntax that cannot be analyzed statically');
}

/** Analyzes a raw `$when` / `isVisible` value node. */
export function parseVisibilityNode(node: Node): VisibilityCondition {
  if (node.type === 'boolean') {
    return node.value ? { kind: 'always' } : { kind: 'never' };
  }
  if (node.type === 'string') {
    return parseVisibilityExpression(String(node.value));
  }
  return unknown('visibility condition must be a string expression or a boolean');
}

/** Builds the visibility analysis for one duplicate-ID occurrence. */
export function readOccurrenceVisibility(id: IdReference): OccurrenceVisibility {
  const hasWhen = id.whenNode !== undefined;
  const hasIsVisible = id.isVisibleNode !== undefined;
  if (!hasWhen && !hasIsVisible) {
    return { containerPath: id.containerPath, condition: { kind: 'unconditional' } };
  }
  if (hasWhen && hasIsVisible) {
    // AND semantics between the two properties are deliberately not guessed at.
    return {
      containerPath: id.containerPath,
      condition: unknown('element carries both $when and isVisible; combined semantics are not analyzed')
    };
  }
  return {
    containerPath: id.containerPath,
    condition: parseVisibilityNode((id.whenNode ?? id.isVisibleNode) as Node)
  };
}

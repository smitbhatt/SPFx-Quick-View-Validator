/**
 * Parser for the Adaptive Card **templating expression language** used inside
 * `${...}` markers of a Quick View template.
 *
 * SPFx Adaptive Card Extensions render `quickview.json` with the Adaptive
 * Cards templating engine (`adaptivecards-templating`), which evaluates a
 * small expression language. This module implements a tokenizer plus a
 * recursive-descent parser for exactly that language — no more:
 *
 *   paths            employee, employee.address.city, $root.employee.name
 *   member access    a.b.c
 *   indexing         tasks[0].title, tasks[$index].title, a['key']
 *   function calls   formatDateTime(due, 'MM/dd'), if(x, a, b)
 *   operators        ! - + * / %  < <= > >= == != === !==  && ||  ? :
 *   literals         'text' "text" 42 3.5 true false null
 *   context vars     $root  $data  $index
 *
 * The AST keeps absolute offsets (relative to the expression text) for every
 * data reference and every path segment so diagnostics can underline the
 * smallest practical range.
 *
 * Syntax outside this grammar (filters such as `${a | upper}`) is reported as
 * unsupported rather than guessed at — the caller then skips the expression.
 */

export type ExpressionNode =
  | PathExpression
  | CallExpression
  | LiteralExpression
  | UnaryExpression
  | BinaryExpression
  | ConditionalExpression
  | GroupExpression;

/** A single `a`, `.b`, `[0]`, `['key']` step of a path expression. */
export type PathSegment =
  | {
      kind: 'member';
      name: string;
      /** Offset of the member name (without the leading dot). */
      start: number;
      end: number;
    }
  | {
      kind: 'index';
      /** Static numeric index, when the index is a numeric literal. */
      value?: number;
      /** Index expression (e.g. `$index` or a data path); `undefined` for literals. */
      expression?: ExpressionNode;
      /** Offset of the index expression/literal. */
      start: number;
      end: number;
    };

export interface PathExpression {
  kind: 'path';
  /**
   * `data` for an ordinary data reference, `root` for `$root`, `item` for
   * `$data`, `index` for `$index`.
   */
  context: 'data' | 'root' | 'item' | 'index';
  /** Root identifier text (`employee`, `$root`, `$data`, `$index`). */
  name: string;
  /** Member/index steps following the root identifier. */
  segments: PathSegment[];
  start: number;
  end: number;
}

export interface CallExpression {
  kind: 'call';
  name: string;
  arguments: ExpressionNode[];
  start: number;
  end: number;
}

export interface LiteralExpression {
  kind: 'literal';
  value: string | number | boolean | null;
  start: number;
  end: number;
}

export interface UnaryExpression {
  kind: 'unary';
  operator: string;
  operand: ExpressionNode;
  start: number;
  end: number;
}

export interface BinaryExpression {
  kind: 'binary';
  operator: string;
  left: ExpressionNode;
  right: ExpressionNode;
  start: number;
  end: number;
}

export interface ConditionalExpression {
  kind: 'conditional';
  test: ExpressionNode;
  consequent: ExpressionNode;
  alternate: ExpressionNode;
  start: number;
  end: number;
}

export interface GroupExpression {
  kind: 'group';
  expression: ExpressionNode;
  start: number;
  end: number;
}

export type ExpressionParseResult =
  | { supported: true; expression: ExpressionNode }
  | { supported: false; reason: string };

/** Reserved context variables of the Adaptive Cards templating engine. */
export const RESERVED_CONTEXT_VARIABLES = ['$root', '$data', '$index'] as const;

/**
 * Well-known functions of the templating engine's expression language. Calls
 * to these names are never data references; their *arguments* are still
 * validated as data references.
 */
export const KNOWN_TEMPLATE_FUNCTIONS = new Set([
  'if',
  'coalesce',
  'array',
  'json',
  'concat',
  'toUpper',
  'toLower',
  'trim',
  'substr',
  'indexOf',
  'length',
  'add',
  'sub',
  'mul',
  'div',
  'mod',
  'min',
  'max',
  'floor',
  'ceil',
  'abs',
  'round',
  'pi',
  'pow',
  'exp',
  'log',
  'sqrt',
  'rand',
  'now',
  'date',
  'time',
  'formatDateTime',
  'formatNumber',
  'parseInt',
  'parseFloat',
  'toString',
  'toNumber',
  'turnOn',
  'turnOff',
  'day',
  'month',
  'year',
  'hours',
  'minutes',
  'seconds',
  'weekOfYear',
  'dateTimeToTicks',
  'ticks',
  'ticksToDateTime',
  'zoneOffset',
  'parseDateTime',
  'isNullOrEmpty',
  'count',
  'select',
  'where',
  'orderBy',
  'union',
  'intersection',
  'first',
  'last',
  'skip',
  'take',
  'sortBy',
  'getProperty',
  'setProperty',
  'keys',
  'values',
  'xpath',
  'yaml'
]);

interface Token {
  type: 'identifier' | 'number' | 'string' | 'punct' | 'eof';
  /** Raw text (for identifiers/punctuation); the value for literals lives in `literal`. */
  text: string;
  literal?: string | number;
  start: number;
  end: number;
}

const PUNCTUATION = [
  '===',
  '!==',
  '==',
  '!=',
  '<=',
  '>=',
  '&&',
  '||',
  '!',
  '<',
  '>',
  '+',
  '-',
  '*',
  '/',
  '%',
  '(',
  ')',
  '[',
  ']',
  '.',
  ',',
  '?',
  ':'
];

const IDENTIFIER_START = /[A-Za-z_$]/;
const IDENTIFIER_PART = /[A-Za-z0-9_$]/;

function tokenize(text: string): Token[] | undefined {
  const tokens: Token[] = [];
  let index = 0;
  while (index < text.length) {
    const char = text[index];
    if (/\s/.test(char)) {
      index++;
      continue;
    }

    if (char === "'" || char === '"') {
      const quote = char;
      let cursor = index + 1;
      let value = '';
      let terminated = false;
      while (cursor < text.length) {
        const current = text[cursor];
        if (current === '\\' && cursor + 1 < text.length) {
          value += unescape(text[cursor + 1]);
          cursor += 2;
          continue;
        }
        if (current === quote) {
          terminated = true;
          cursor++;
          break;
        }
        value += current;
        cursor++;
      }
      if (!terminated) {
        return undefined; // unterminated string literal
      }
      tokens.push({ type: 'string', text: text.slice(index, cursor), literal: value, start: index, end: cursor });
      index = cursor;
      continue;
    }

    if (/[0-9]/.test(char) || (char === '.' && /[0-9]/.test(text[index + 1] ?? ''))) {
      const match = /^(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/.exec(text.slice(index));
      if (!match) {
        return undefined;
      }
      const raw = match[0];
      tokens.push({ type: 'number', text: raw, literal: Number(raw), start: index, end: index + raw.length });
      index += raw.length;
      continue;
    }

    if (IDENTIFIER_START.test(char)) {
      let cursor = index + 1;
      while (cursor < text.length && IDENTIFIER_PART.test(text[cursor])) {
        cursor++;
      }
      tokens.push({ type: 'identifier', text: text.slice(index, cursor), start: index, end: cursor });
      index = cursor;
      continue;
    }

    const punctuation = PUNCTUATION.find((candidate) => text.startsWith(candidate, index));
    if (!punctuation) {
      return undefined; // unsupported character (e.g. the `|` filter operator)
    }
    tokens.push({ type: 'punct', text: punctuation, start: index, end: index + punctuation.length });
    index += punctuation.length;
  }
  tokens.push({ type: 'eof', text: '', start: text.length, end: text.length });
  return tokens;
}

function unescape(char: string): string {
  switch (char) {
    case 'n':
      return '\n';
    case 'r':
      return '\r';
    case 't':
      return '\t';
    default:
      return char;
  }
}

class Parser {
  private index = 0;

  constructor(private readonly tokens: Token[]) {}

  private peek(): Token {
    return this.tokens[this.index];
  }

  private next(): Token {
    return this.tokens[this.index++];
  }

  private atPunct(text: string): boolean {
    const token = this.peek();
    return token.type === 'punct' && token.text === text;
  }

  private eat(text: string): Token | undefined {
    if (this.atPunct(text)) {
      return this.next();
    }
    return undefined;
  }

  parse(): ExpressionParseResult {
    try {
      const expression = this.parseConditional();
      const token = this.peek();
      if (token.type !== 'eof') {
        return { supported: false, reason: `unexpected token "${token.text}"` };
      }
      return { supported: true, expression };
    } catch (error) {
      return { supported: false, reason: error instanceof Error ? error.message : 'unsupported expression' };
    }
  }

  private fail(message: string): never {
    throw new Error(message);
  }

  private parseConditional(): ExpressionNode {
    const test = this.parseBinary(0);
    const question = this.eat('?');
    if (!question) {
      return test;
    }
    const consequent = this.parseConditional();
    if (!this.eat(':')) {
      this.fail('conditional expression is missing ":"');
    }
    const alternate = this.parseConditional();
    return {
      kind: 'conditional',
      test,
      consequent,
      alternate,
      start: test.start,
      end: alternate.end
    };
  }

  /** Binary operator precedence, lowest first. */
  private static readonly PRECEDENCE: string[][] = [
    ['||'],
    ['&&'],
    ['==', '!=', '===', '!=='],
    ['<', '<=', '>', '>='],
    ['+', '-'],
    ['*', '/', '%']
  ];

  private parseBinary(level: number): ExpressionNode {
    if (level >= Parser.PRECEDENCE.length) {
      return this.parseUnary();
    }
    let left = this.parseBinary(level + 1);
    for (;;) {
      const token = this.peek();
      if (token.type !== 'punct' || !Parser.PRECEDENCE[level].includes(token.text)) {
        return left;
      }
      this.next();
      const right = this.parseBinary(level + 1);
      left = {
        kind: 'binary',
        operator: token.text,
        left,
        right,
        start: left.start,
        end: right.end
      };
    }
  }

  private parseUnary(): ExpressionNode {
    const token = this.peek();
    if (token.type === 'punct' && ['!', '-', '+'].includes(token.text)) {
      this.next();
      const operand = this.parseUnary();
      return { kind: 'unary', operator: token.text, operand, start: token.start, end: operand.end };
    }
    return this.parsePostfix();
  }

  private parsePostfix(): ExpressionNode {
    let expression = this.parsePrimary();
    for (;;) {
      if (this.atPunct('.')) {
        this.next();
        const name = this.peek();
        if (name.type !== 'identifier') {
          this.fail('expected a member name after "."');
        }
        this.next();
        expression = this.withSegment(expression, {
          kind: 'member',
          name: name.text,
          start: name.start,
          end: name.end
        });
        continue;
      }
      if (this.atPunct('[')) {
        const open = this.next();
        const indexExpression = this.parseConditional();
        const close = this.eat(']');
        if (!close) {
          this.fail('index expression is missing "]"');
        }
        const segment: PathSegment =
          indexExpression.kind === 'literal' && typeof indexExpression.value === 'number'
            ? { kind: 'index', value: indexExpression.value, start: indexExpression.start, end: indexExpression.end }
            : { kind: 'index', expression: indexExpression, start: indexExpression.start, end: indexExpression.end };
        expression = this.withSegment(expression, segment, open.start);
        continue;
      }
      return expression;
    }
  }

  private withSegment(expression: ExpressionNode, segment: PathSegment, startOverride?: number): ExpressionNode {
    if (expression.kind !== 'path' || expression.context === 'index') {
      // Member access on a call result / literal / `$index`: keep it opaque so
      // callers never treat it as a data reference.
      return {
        kind: 'group',
        expression,
        start: startOverride ?? expression.start,
        end: segment.end
      };
    }
    return {
      kind: 'path',
      context: expression.context,
      name: expression.name,
      segments: [...expression.segments, segment],
      start: expression.start,
      end: segment.end
    };
  }

  private parsePrimary(): ExpressionNode {
    const token = this.peek();
    if (token.type === 'eof') {
      this.fail('unexpected end of expression');
    }

    if (token.type === 'number' || token.type === 'string') {
      this.next();
      return { kind: 'literal', value: token.literal ?? token.text, start: token.start, end: token.end };
    }

    if (token.type === 'identifier') {
      this.next();
      if (this.atPunct('(')) {
        return this.parseCall(token);
      }
      if (token.text === 'true') {
        return { kind: 'literal', value: true, start: token.start, end: token.end };
      }
      if (token.text === 'false') {
        return { kind: 'literal', value: false, start: token.start, end: token.end };
      }
      if (token.text === 'null') {
        return { kind: 'literal', value: null, start: token.start, end: token.end };
      }
      return {
        kind: 'path',
        context: contextOf(token.text),
        name: token.text,
        segments: [],
        start: token.start,
        end: token.end
      };
    }

    if (token.type === 'punct' && token.text === '(') {
      this.next();
      const inner = this.parseConditional();
      const close = this.eat(')');
      if (!close) {
        this.fail('grouped expression is missing ")"');
      }
      return { kind: 'group', expression: inner, start: token.start, end: close.end };
    }

    this.fail(`unexpected token "${token.text}"`);
  }

  private parseCall(name: Token): CallExpression {
    this.next(); // consume "("
    const args: ExpressionNode[] = [];
    if (!this.atPunct(')')) {
      for (;;) {
        args.push(this.parseConditional());
        if (this.eat(',')) {
          continue;
        }
        break;
      }
    }
    const close = this.eat(')');
    if (!close) {
      this.fail(`call to "${name.text}" is missing ")"`);
    }
    return { kind: 'call', name: name.text, arguments: args, start: name.start, end: close.end };
  }
}

function contextOf(name: string): PathExpression['context'] {
  switch (name) {
    case '$root':
      return 'root';
    case '$data':
      return 'item';
    case '$index':
      return 'index';
    default:
      return 'data';
  }
}

/**
 * Parses the text between `${` and `}` of a template expression.
 * Returns `supported: false` for syntax outside the templating grammar.
 */
export function parseExpression(raw: string): ExpressionParseResult {
  const text = raw.trim();
  if (text.length === 0) {
    return { supported: false, reason: 'empty expression' };
  }
  const leading = raw.length - raw.trimStart().length;
  const tokens = tokenize(text);
  if (!tokens) {
    return { supported: false, reason: 'expression uses syntax that cannot be resolved statically' };
  }
  const result = new Parser(tokens).parse();
  if (!result.supported) {
    return result;
  }
  return { supported: true, expression: shiftOffsets(result.expression, leading) };
}

function shiftOffsets<T extends ExpressionNode>(node: T, delta: number): T {
  const shifted: ExpressionNode = { ...node, start: node.start + delta, end: node.end + delta } as ExpressionNode;
  switch (shifted.kind) {
    case 'path':
      shifted.segments = shifted.segments.map((segment) =>
        segment.kind === 'index' && segment.expression
          ? {
              ...segment,
              start: segment.start + delta,
              end: segment.end + delta,
              expression: shiftOffsets(segment.expression, delta)
            }
          : { ...segment, start: segment.start + delta, end: segment.end + delta }
      );
      break;
    case 'call':
      shifted.arguments = shifted.arguments.map((argument) => shiftOffsets(argument, delta));
      break;
    case 'unary':
      shifted.operand = shiftOffsets(shifted.operand, delta);
      break;
    case 'binary':
      shifted.left = shiftOffsets(shifted.left, delta);
      shifted.right = shiftOffsets(shifted.right, delta);
      break;
    case 'conditional':
      shifted.test = shiftOffsets(shifted.test, delta);
      shifted.consequent = shiftOffsets(shifted.consequent, delta);
      shifted.alternate = shiftOffsets(shifted.alternate, delta);
      break;
    case 'group':
      shifted.expression = shiftOffsets(shifted.expression, delta);
      break;
    default:
      break;
  }
  return shifted as T;
}

/** Walks every node of an expression tree (pre-order). */
export function walkExpression(node: ExpressionNode, visit: (node: ExpressionNode) => void): void {
  visit(node);
  switch (node.kind) {
    case 'path':
      for (const segment of node.segments) {
        if (segment.kind === 'index' && segment.expression) {
          walkExpression(segment.expression, visit);
        }
      }
      break;
    case 'call':
      node.arguments.forEach((argument) => walkExpression(argument, visit));
      break;
    case 'unary':
      walkExpression(node.operand, visit);
      break;
    case 'binary':
      walkExpression(node.left, visit);
      walkExpression(node.right, visit);
      break;
    case 'conditional':
      walkExpression(node.test, visit);
      walkExpression(node.consequent, visit);
      walkExpression(node.alternate, visit);
      break;
    case 'group':
      walkExpression(node.expression, visit);
      break;
    default:
      break;
  }
}

/**
 * Collects every statically analyzable **data reference** in an expression:
 * ordinary paths (`employee.name`), `$root` paths and `$data` paths.
 *
 * Function names, operators, literals, `$index` and method calls are *not*
 * returned. References nested inside parentheses, function arguments,
 * comparisons, conditionals and index expressions *are* returned.
 */
export function collectDataReferences(expression: ExpressionNode): PathExpression[] {
  const references: PathExpression[] = [];
  walkExpression(expression, (node) => {
    if (node.kind === 'path' && node.context !== 'index') {
      references.push(node);
    }
  });
  return references;
}

import { DataShape, UNRESOLVED_SHAPE } from '../analyzer/shape';
import {
  collectDataReferences,
  ExpressionNode,
  parseExpression,
  PathExpression,
  PathSegment
} from './expressions';

/**
 * Context-aware resolution of Adaptive Card templating expressions against
 * the statically-derived `DataShape` of a Quick View `data` getter.
 *
 * The resolver knows about the three data contexts of the templating engine:
 *
 *   - the **root** data object (`$root`, or any path resolved from the root);
 *   - the **current iteration item** (the implicit scope inside a `$data`
 *     repetition, and `$data.x` explicitly);
 *   - **reserved variables** such as `$index`, which are never data.
 *
 * Property lookup walks the scope chain from innermost iteration scope out to
 * the root — matching the engine's lexical scoping, so `${title}` inside a
 * repetition over `tasks` resolves against the task element type while
 * `${$root.title}` always resolves against the root data object.
 */

/** One `$data` repetition frame enclosing a binding, outermost first. */
export interface IterationScope {
  /** Raw text of the `$data` value (e.g. `${workdayPDRData.dueOrOverdue}`). */
  expression: string;
}

export interface ResolverOptions {
  /** Shape of the root data object returned by the `data` getter. */
  rootShape: DataShape;
  /**
   * Iteration frames enclosing the binding, outermost first. When omitted the
   * binding is treated as being at the root scope.
   */
  scopes?: IterationScope[];
  /**
   * `partial` analysis must never produce a hard "missing" verdict for a
   * binding it cannot fully see. Kept for callers that want to know.
   */
  partial?: boolean;
}

export type BindingStatus = 'valid' | 'missing' | 'unverifiable' | 'unsupported';

export interface MissingSegment {
  /** The property name that could not be found. */
  name: string;
  /** Path segments successfully resolved *before* the missing one. */
  resolvedPath: string[];
  /** Human-readable description of the context that was searched. */
  searchedOn: string;
  /** Offset of the missing segment relative to the whole expression text. */
  offset: number;
  /** Length of the missing segment. */
  length: number;
  /** 1-based index of the missing segment within its path (1 = first). */
  segmentIndex: number;
  /** True when the failure is on the root/current-item object itself. */
  atRoot: boolean;
}

export interface BindingResolution {
  /** The original `${...}` expression text (without the markers). */
  expression: string;
  status: BindingStatus;
  /** Every data reference that was analyzed (for debugging/tests). */
  references: string[];
  /** First missing segment, when `status === 'missing'`. */
  missing?: MissingSegment;
  /** Reason text for `unverifiable` / `unsupported`. */
  reason?: string;
}

/** A resolved scope: the shape of the current item, or `undefined` when unknown. */
type ItemShape = DataShape | undefined;

function shapeMember(
  shape: DataShape,
  name: string
): { status: 'ok'; shape: DataShape } | { status: 'missing' } | { status: 'unknown' } {
  switch (shape.kind) {
    case 'object': {
      const property = shape.properties.get(name);
      if (property) {
        return { status: 'ok', shape: property };
      }
      if (name === 'length') {
        // Arrays/objects expose `length` at runtime; never claim it missing.
        return { status: 'unknown' };
      }
      if (shape.indexSignature) {
        return { status: 'ok', shape: shape.indexSignature };
      }
      return { status: 'missing' };
    }
    case 'array': {
      // `tasks.length` and array methods are legitimate; anything else on an
      // array is not statically checkable.
      if (name === 'length') {
        return { status: 'unknown' };
      }
      return { status: 'unknown' };
    }
    case 'union': {
      let sawOk = false;
      let sawUnknown = false;
      let resolved: DataShape = UNRESOLVED_SHAPE;
      for (const member of shape.members) {
        const result = shapeMember(member, name);
        if (result.status === 'ok') {
          sawOk = true;
          resolved = result.shape;
        } else if (result.status === 'unknown') {
          sawUnknown = true;
        }
      }
      if (sawOk) {
        return { status: 'ok', shape: resolved };
      }
      if (sawUnknown) {
        return { status: 'unknown' };
      }
      return { status: 'missing' };
    }
    case 'primitive':
      // Member access on a primitive (e.g. `${name.length}`) is not a data
      // shape error: report "unknown" rather than a false positive.
      return { status: 'unknown' };
    case 'unresolved':
    default:
      return { status: 'unknown' };
  }
}

function shapeElement(shape: DataShape): { shape?: DataShape; known: boolean } {
  switch (shape.kind) {
    case 'array':
      return { shape: shape.element, known: true };
    case 'union': {
      let element: DataShape | undefined;
      let known = false;
      for (const member of shape.members) {
        const result = shapeElement(member);
        if (result.known) {
          element = result.shape;
          known = true;
        }
      }
      return { shape: element, known };
    }
    case 'primitive':
      return { shape: undefined, known: false };
    default:
      return { shape: undefined, known: false };
  }
}

/** Resolves the shape of a `$data` expression's collection to its item shape. */
function scopeItemShape(collection: DataShape): ItemShape {
  const element = shapeElement(collection);
  return element.known ? element.shape : undefined;
}

export class BindingResolver {
  private readonly rootShape: DataShape;
  private readonly itemShapes: ItemShape[];

  constructor(options: ResolverOptions) {
    this.rootShape = options.rootShape;
    this.itemShapes = this.resolveScopes(options.scopes ?? []);
  }

  /**
   * Resolves every iteration frame against the enclosing scope, producing the
   * shape of the current item for each frame. A frame whose `$data` expression
   * cannot be statically followed yields `undefined` (unverifiable).
   */
  private resolveScopes(scopes: IterationScope[]): ItemShape[] {
    const items: ItemShape[] = [];
    for (let i = 0; i < scopes.length; i++) {
      const parentShape: DataShape = i === 0 ? this.rootShape : items[i - 1] ?? UNRESOLVED_SHAPE;
      const parsed = parseExpression(scopes[i].expression);
      if (!parsed.supported) {
        items.push(undefined);
        continue;
      }
      const references = collectDataReferences(parsed.expression);
      if (references.length !== 1) {
        items.push(undefined);
        continue;
      }
      const resolved = this.resolveReferenceShape(references[0], items, parentShape);
      if (resolved.kind !== 'object' && resolved.kind !== 'array' && resolved.kind !== 'union') {
        items.push(undefined);
        continue;
      }
      items.push(scopeItemShape(resolved));
    }
    return items;
  }

  /**
   * Resolves a path reference to a shape. `items` is the already-resolved list
   * of enclosing scope shapes (used for the implicit scope-chain lookup).
   */
  private resolveReferenceShape(
    reference: PathExpression,
    items: ItemShape[],
    explicitTarget?: DataShape
  ): DataShape {
    let current: DataShape;
    const remaining: PathSegment[] = [...reference.segments];

    if (explicitTarget) {
      if (reference.context === 'data') {
        // The reference's own name is still the first segment.
        const step = shapeMember(explicitTarget, reference.name);
        if (step.status !== 'ok') {
          return UNRESOLVED_SHAPE;
        }
        current = step.shape;
      } else {
        current = explicitTarget;
      }
    } else if (reference.context === 'root') {
      current = this.rootShape;
    } else if (reference.context === 'item') {
      const item = items.length > 0 ? items[items.length - 1] : undefined;
      current = item ?? UNRESOLVED_SHAPE;
    } else if (reference.context === 'index') {
      // `$index` is a number; members on it are not data.
      return UNRESOLVED_SHAPE;
    } else {
      // Ordinary name: walk the scope chain from innermost to root.
      const found = this.lookupChain(reference.name, items);
      if (found.status !== 'ok') {
        return UNRESOLVED_SHAPE;
      }
      current = found.shape;
    }

    for (const segment of remaining) {
      if (segment.kind === 'member') {
        const step = shapeMember(current, segment.name);
        if (step.status === 'ok') {
          current = step.shape;
          continue;
        }
        return UNRESOLVED_SHAPE;
      }
      // Index segment: `tasks[0]` / `tasks[$index]` → the element type. The
      // index expression itself is validated as its own data reference by the
      // resolver's caller.
      const element = shapeElement(current);
      if (!element.known) {
        return UNRESOLVED_SHAPE;
      }
      current = element.shape ?? UNRESOLVED_SHAPE;
    }
    return current;
  }

  /** Lexical lookup of a bare name: current item → ... → root. */
  private lookupChain(
    name: string,
    items: ItemShape[]
  ): { status: 'ok'; shape: DataShape } | { status: 'missing' } | { status: 'unknown' } {
    let sawUnknown = false;
    const ordered = [...items].reverse().filter((item): item is DataShape => item !== undefined);
    if (items.some((item) => item === undefined)) {
      // An unresolved enclosing scope could contribute the property.
      sawUnknown = true;
    }
    for (const shape of [...ordered, this.rootShape]) {
      const result = shapeMember(shape, name);
      if (result.status === 'ok') {
        return { status: 'ok', shape: result.shape };
      }
      if (result.status === 'unknown') {
        sawUnknown = true;
      }
    }
    return sawUnknown ? { status: 'unknown' } : { status: 'missing' };
  }

  /**
   * The scopes searched for an ordinary name, described for diagnostics.
   */
  private describeScopeFor(reference: PathExpression, items: ItemShape[]): string {
    if (reference.context === 'item') {
      return 'the current iteration item';
    }
    if (items.length > 0) {
      return 'the current iteration item or the root Quick View data';
    }
    return 'the root Quick View data';
  }

  /** Resolves a single data reference, reporting the first missing segment. */
  private resolvePath(reference: PathExpression, items: ItemShape[]): BindingResolution {
    const resolvedNames = [reference.name];
    let current: DataShape;
    let atRoot = false;

    if (reference.context === 'root') {
      current = this.rootShape;
      atRoot = reference.segments.length === 0;
    } else if (reference.context === 'item') {
      const item = items.length > 0 ? items[items.length - 1] : undefined;
      if (item === undefined) {
        return {
          expression: '',
          status: 'unverifiable',
          references: [],
          reason: 'the enclosing repetition data could not be resolved'
        };
      }
      current = item;
      atRoot = reference.segments.length === 0;
    } else {
      const found = this.lookupChain(reference.name, items);
      if (found.status === 'missing') {
        return {
          expression: '',
          status: 'missing',
          references: [],
          missing: {
            name: reference.name,
            resolvedPath: [],
            searchedOn: this.describeScopeFor(reference, items),
            offset: reference.start,
            // Only the identifier is underlined, not the full indexed path.
            length: reference.name.length,
            segmentIndex: 1,
            atRoot: true
          }
        };
      }
      if (found.status === 'unknown') {
        return { expression: '', status: 'unverifiable', references: [] };
      }
      current = found.shape;
      atRoot = false; // resolved against an iteration item, not the root
    }

    for (let i = 0; i < reference.segments.length; i++) {
      const segment = reference.segments[i];
      if (segment.kind === 'index') {
        const element = shapeElement(current);
        if (!element.known) {
          return { expression: '', status: 'unverifiable', references: [] };
        }
        current = element.shape ?? UNRESOLVED_SHAPE;
        continue;
      }
      const step = shapeMember(current, segment.name);
      if (step.status === 'ok') {
        current = step.shape;
        resolvedNames.push(segment.name);
        continue;
      }
      if (step.status === 'unknown') {
        return { expression: '', status: 'unverifiable', references: [] };
      }
      return {
        expression: '',
        status: 'missing',
        references: [],
        missing: {
          name: segment.name,
          resolvedPath: [...resolvedNames],
          searchedOn: atRoot ? 'the root Quick View data' : `'${resolvedNames.join('.')}'`,
          offset: segment.start,
          length: segment.end - segment.start,
          segmentIndex: i + 2, // the root identifier counts as the first segment
          atRoot
        }
      };
    }

    return { expression: '', status: 'valid', references: [] };
  }

  /**
   * Resolves a whole binding expression: every data reference inside it must
   * resolve. The first definitively missing reference wins.
   */
  resolve(raw: string): BindingResolution {
    const parsed = parseExpression(raw);
    if (!parsed.supported) {
      return { expression: raw.trim(), status: 'unsupported', references: [], reason: parsed.reason };
    }

    const references = collectDataReferences(parsed.expression);
    const names = references.map((reference) => pathText(reference));
    let sawUnverifiable = false;

    for (const reference of references) {
      const result = this.resolvePath(reference, this.itemShapes);
      if (result.status === 'missing' && result.missing) {
        return { expression: raw.trim(), status: 'missing', references: names, missing: result.missing };
      }
      if (result.status === 'unverifiable') {
        sawUnverifiable = true;
      }
    }

    if (references.length === 0) {
      // Pure literals / arithmetic: nothing to check.
      return { expression: raw.trim(), status: 'valid', references: names };
    }
    if (sawUnverifiable) {
      return { expression: raw.trim(), status: 'unverifiable', references: names };
    }
    return { expression: raw.trim(), status: 'valid', references: names };
  }
}

export function pathText(reference: PathExpression): string {
  let text = reference.name;
  for (const segment of reference.segments) {
    if (segment.kind === 'member') {
      text += `.${segment.name}`;
    } else if (segment.value !== undefined) {
      text += `[${segment.value}]`;
    } else {
      text += `[${segment.expression ? expressionText(segment.expression) : '?'}]`;
    }
  }
  return text;
}

/** Serializes a small index expression back to comparable text. */
function expressionText(node: ExpressionNode): string {
  switch (node.kind) {
    case 'path':
      return pathText(node);
    case 'literal':
      return typeof node.value === 'string' ? `'${node.value}'` : String(node.value);
    case 'group':
      return expressionText(node.expression);
    case 'unary':
      return `${node.operator}${expressionText(node.operand)}`;
    case 'binary':
      return `${expressionText(node.left)} ${node.operator} ${expressionText(node.right)}`;
    case 'conditional':
      return `${expressionText(node.test)} ? ${expressionText(node.consequent)} : ${expressionText(node.alternate)}`;
    case 'call':
      return `${node.name}(${node.arguments.map(expressionText).join(', ')})`;
    default:
      return '?';
  }
}

/** Parses raw expression text into an AST (re-exported for tests/tools). */
export function parseBindingExpression(raw: string): ExpressionNode | undefined {
  const parsed = parseExpression(raw);
  return parsed.supported ? parsed.expression : undefined;
}

export { collectDataReferences, parseExpression } from './expressions';
export type { ExpressionNode } from './expressions';

import * as ts from 'typescript';

/**
 * A conservative, statically-derived model of the object shape exposed by a
 * Quick View `data` getter. It is built with the TypeScript **type checker**
 * (never by scanning source text) and is intentionally lossy in one
 * direction only: anything that cannot be understood becomes `unresolved`
 * instead of being reported as missing. That keeps false positives out.
 */

export type DataShape =
  /** An object with known property types and an optional string index signature. */
  | { kind: 'object'; properties: Map<string, DataShape>; indexSignature?: DataShape }
  /** An array; `element` is the shape of its items. */
  | { kind: 'array'; element: DataShape }
  /** A union of shapes: a property is present when *any* branch has it. */
  | { kind: 'union'; members: DataShape[] }
  /**
   * A primitive (string/number/boolean/...). Member access on a primitive is
   * never a data-shape error in Adaptive Cards templating, so lookups stop
   * here and are treated as "cannot verify".
   */
  | { kind: 'primitive' }
  /** `any`, `unknown`, a computed type, or anything dynamic. */
  | { kind: 'unresolved' };

export const UNRESOLVED_SHAPE: DataShape = { kind: 'unresolved' };

/** Maximum recursion depth when expanding self-referential types. */
const MAX_SHAPE_DEPTH = 8;

const PRIMITIVE_FLAGS =
  ts.TypeFlags.StringLike |
  ts.TypeFlags.NumberLike |
  ts.TypeFlags.BooleanLike |
  ts.TypeFlags.BigIntLike |
  ts.TypeFlags.ESSymbolLike |
  ts.TypeFlags.Null |
  ts.TypeFlags.Undefined |
  ts.TypeFlags.Void |
  ts.TypeFlags.Never |
  ts.TypeFlags.EnumLike;

export interface ShapeBuilder {
  /** Builds the shape of a type, guarding against infinite recursion. */
  shapeOf(type: ts.Type | undefined): DataShape;
}

/**
 * Creates a shape builder bound to one type checker. `location` is the node
 * used to resolve symbol types (normally the `data` getter).
 */
export function createShapeBuilder(checker: ts.TypeChecker, location: ts.Node): ShapeBuilder {
  const inProgress = new Set<ts.Type>();

  const shapeOf = (type: ts.Type | undefined): DataShape => {
    return build(type, 0);
  };

  const build = (type: ts.Type | undefined, depth: number): DataShape => {
    if (!type || depth > MAX_SHAPE_DEPTH || inProgress.has(type)) {
      return UNRESOLVED_SHAPE;
    }

    if ((type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0) {
      return UNRESOLVED_SHAPE;
    }

    if (type.isUnion()) {
      const members = type.types.map((member) => build(member, depth + 1));
      // Optional properties surface as `T | undefined`; the union keeps both
      // branches so a property found in only one branch is still "present".
      return { kind: 'union', members };
    }

    if (type.isIntersection()) {
      const members = type.types.map((member) => build(member, depth + 1));
      return { kind: 'union', members };
    }

    if ((type.flags & PRIMITIVE_FLAGS) !== 0 && !isArrayLike(type, checker)) {
      return { kind: 'primitive' };
    }

    const arrayElement = elementTypeOf(type, checker);
    if (arrayElement) {
      return { kind: 'array', element: build(arrayElement, depth + 1) };
    }

    // Object-ish: expand its properties.
    inProgress.add(type);
    try {
      const properties = new Map<string, DataShape>();
      for (const symbol of type.getProperties()) {
        const name = symbol.getName();
        // Methods/accessors are not data; skipping them can only cause an
        // "unverifiable" result downstream, never a false "missing".
        if ((symbol.getFlags() & (ts.SymbolFlags.Property | ts.SymbolFlags.Method)) === 0) {
          continue;
        }
        if ((symbol.getFlags() & ts.SymbolFlags.Method) !== 0) {
          continue;
        }
        const propertyType = checker.getTypeOfSymbolAtLocation(symbol, location);
        properties.set(name, build(propertyType, depth + 1));
      }

      const indexType = checker.getIndexTypeOfType(type, ts.IndexKind.String);
      const indexSignature = indexType ? build(indexType, depth + 1) : undefined;

      if (properties.size === 0 && !indexSignature) {
        // A type with no enumerable properties: call signatures, `object`,
        // well-known utility types, ... — cannot be verified meaningfully.
        return UNRESOLVED_SHAPE;
      }

      return indexSignature ? { kind: 'object', properties, indexSignature } : { kind: 'object', properties };
    } finally {
      inProgress.delete(type);
    }
  };

  return { shapeOf };
}

function isArrayLike(type: ts.Type, checker: ts.TypeChecker): boolean {
  void checker;
  const symbol = type.getSymbol();
  const name = symbol?.getName();
  return name === 'Array' || name === 'ReadonlyArray';
}

/** Returns the element type for arrays/tuples, or `undefined` when not array-like. */
function elementTypeOf(type: ts.Type, checker: ts.TypeChecker): ts.Type | undefined {
  const symbol = type.getSymbol();
  const name = symbol?.getName();
  const isTuple = checker.isTupleType?.(type) ?? false;
  if (name !== 'Array' && name !== 'ReadonlyArray' && !isTuple) {
    return undefined;
  }
  // `Array<T>` carries `T` as its single type argument.
  const args = (type as ts.TypeReference).typeArguments;
  if (args && args.length > 0) {
    return args[0];
  }
  return checker.getIndexTypeOfType(type, ts.IndexKind.Number);
}

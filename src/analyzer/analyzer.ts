import * as path from 'path';
import * as ts from 'typescript';
import { computeLineStarts, positionAt } from '../core/positions';
import { createShapeBuilder, DataShape, UNRESOLVED_SHAPE } from './shape';

/**
 * Static analysis of a Quick View TypeScript implementation using the
 * TypeScript compiler API. Understands (among others):
 *
 *   public get data(): IQuickViewData { return { a: this.properties.a }; }
 *   public get data() { return { a: this.properties.a }; }
 *   public get data() { return this.someVariable; }
 *   getters with multiple return paths, spreads, imported interfaces, ...
 *
 * All resolution is deliberately conservative: when a value cannot be
 * resolved statically the result is reported as `partial`/`none`/`unknown`
 * so callers can skip checks instead of producing false positives.
 *
 * Besides the flat `dataPropertyNames` set (kept for compatibility and for the
 * "partially resolved" verdict), the analyzer exposes a `rootShape`: a
 * `DataShape` tree (objects, arrays, unions, index signatures) built with the
 * type checker, which drives the context-aware binding resolver.
 */

export type Resolution = 'full' | 'partial' | 'none';

export type MemberCheckResult =
  | { status: 'ok' }
  | { status: 'missing'; missingPath: string[] }
  | { status: 'unknown' };

export interface GetterPosition {
  offset: number;
  length: number;
  line: number;
  column: number;
}

export interface TsAnalysisResult {
  /** True when the Quick View class exposes a `data` getter. */
  hasDataGetter: boolean;
  /** Position of the `data` getter (when present). */
  dataGetterPosition?: GetterPosition;
  /** Property names the data getter exposes to the Quick View template. */
  dataPropertyNames: Set<string>;
  /** How reliable `dataPropertyNames` is. */
  dataResolution: Resolution;
  /** Name of the Quick View class that was analyzed. */
  quickViewClassName?: string;
  /**
   * Resolves a binding path from the data root (`employee.name`) against the
   * declared return type of the data getter. The first element is the root
   * data property. Returns `unknown` when type information is insufficient —
   * callers must then skip the check.
   */
  resolveDataPath(members: string[]): MemberCheckResult;
  /**
   * Statically-derived shape of the root data object (arrays, nested objects,
   * unions, index signatures). `undefined` when nothing could be resolved.
   * Used by the context-aware binding resolver.
   */
  rootShape?: DataShape;
  dispose(): void;
}

const COMPILER_OPTIONS: ts.CompilerOptions = {
  target: ts.ScriptTarget.ES2017,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.NodeJs,
  allowJs: false,
  skipLibCheck: true,
  noEmit: true,
  esModuleInterop: true,
  strict: false,
  types: [],
  typeRoots: []
};

function isAnyOrUnknown(type: ts.Type): boolean {
  return (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0;
}

function isPrimitive(type: ts.Type): boolean {
  const primitiveFlags =
    ts.TypeFlags.StringLike |
    ts.TypeFlags.NumberLike |
    ts.TypeFlags.BooleanLike |
    ts.TypeFlags.BigIntLike |
    ts.TypeFlags.ESSymbolLike |
    ts.TypeFlags.Null |
    ts.TypeFlags.Undefined |
    ts.TypeFlags.Void |
    ts.TypeFlags.Never;
  return (type.flags & primitiveFlags) !== 0;
}

function normalizePath(p: string): string {
  const normalized = path.normalize(p);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

/** Splits unions into constituents; non-union types are returned as singletons. */
function splitType(type: ts.Type): ts.Type[] {
  return type.isUnion() ? [...type.types] : [type];
}

function propertyNameText(name: ts.PropertyName): string | undefined {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
    return name.text;
  }
  return undefined; // computed / private identifiers: dynamic
}

export function analyzeQuickViewTypeScript(fileName: string, content: string): TsAnalysisResult {
  const sourceFile = ts.createSourceFile(fileName, content, ts.ScriptTarget.ES2017, true, ts.ScriptKind.TS);

  const host = ts.createCompilerHost(COMPILER_OPTIONS);
  const originalGetSourceFile = host.getSourceFile.bind(host);
  const originalFileExists = host.fileExists.bind(host);
  const originalReadFile = host.readFile.bind(host);
  const target = normalizePath(fileName);
  host.getSourceFile = (name, languageVersion, onError, shouldCreateNewSourceFile) => {
    if (normalizePath(name) === target) {
      return sourceFile;
    }
    return originalGetSourceFile(name, languageVersion, onError, shouldCreateNewSourceFile);
  };
  host.fileExists = (name) => normalizePath(name) === target || originalFileExists(name);
  host.readFile = (name) => (normalizePath(name) === target ? content : originalReadFile(name));

  const program = ts.createProgram([fileName], COMPILER_OPTIONS, host);
  const checker = program.getTypeChecker();

  const lineStarts = computeLineStarts(content);

  // ---------------------------------------------------------------- classes
  const classes = sourceFile.statements.filter(ts.isClassDeclaration);
  const quickViewClass =
    classes.find((c) => (c.heritageClauses ?? []).some((h) => h.getText(sourceFile).includes('BaseAdaptiveCardView'))) ??
    classes.find((c) => c.members.some((m) => ts.isGetAccessor(m) && m.name !== undefined && m.name.getText(sourceFile) === 'data')) ??
    classes[0];

  const dataGetter = quickViewClass?.members.find(
    (m): m is ts.GetAccessorDeclaration => ts.isGetAccessor(m) && m.name !== undefined && m.name.getText(sourceFile) === 'data'
  );

  // ------------------------------------------------------------- data shape
  const dataPropertyNames = new Set<string>();
  let annotatedType: ts.Type | undefined;
  let hasDynamicBody = false;
  let hasUnresolvedReturn = false;

  const addPropertiesOf = (type: ts.Type | undefined): boolean => {
    if (!type || isAnyOrUnknown(type)) {
      return false;
    }
    for (const t of splitType(type)) {
      if (isAnyOrUnknown(t)) {
        return false;
      }
      for (const prop of t.getProperties()) {
        dataPropertyNames.add(prop.getName());
      }
    }
    return true;
  };

  if (dataGetter) {
    if (dataGetter.type) {
      const declared = checker.getTypeFromTypeNode(dataGetter.type);
      if (addPropertiesOf(declared)) {
        annotatedType = declared;
      }
    }

    const returnStatements: ts.ReturnStatement[] = [];
    const collectReturns = (node: ts.Node): void => {
      if (ts.isReturnStatement(node)) {
        returnStatements.push(node);
      }
      ts.forEachChild(node, collectReturns);
    };
    if (dataGetter.body) {
      collectReturns(dataGetter.body);
    }

    for (const returnStatement of returnStatements) {
      const expression = returnStatement.expression;
      if (!expression) {
        hasUnresolvedReturn = true;
        continue;
      }
      if (ts.isObjectLiteralExpression(expression)) {
        for (const property of expression.properties) {
          if (ts.isPropertyAssignment(property)) {
            const name = propertyNameText(property.name);
            if (name !== undefined) {
              dataPropertyNames.add(name);
            } else {
              hasDynamicBody = true; // computed property name
            }
          } else {
            // SpreadAssignment, shorthand with accessor, methods, ...: dynamic
            hasDynamicBody = true;
          }
        }
      } else {
        // `return this.someVariable;` — resolve through the checker when possible.
        if (!addPropertiesOf(checker.getTypeAtLocation(expression))) {
          hasUnresolvedReturn = true;
        }
      }
    }
  }

  let dataResolution: Resolution = 'none';
  if (dataGetter) {
    if (annotatedType) {
      dataResolution = 'full'; // the declared contract is authoritative
    } else if (hasDynamicBody || hasUnresolvedReturn) {
      dataResolution = dataPropertyNames.size > 0 ? 'partial' : 'none';
    } else {
      dataResolution = dataPropertyNames.size > 0 ? 'full' : 'none';
    }
  }

  // ------------------------------------------------- nested member resolving
  const resolveLocation: ts.Node = dataGetter ?? sourceFile;

  const shapeBuilder = createShapeBuilder(checker, resolveLocation);
  const proposedRootShape: DataShape = (() => {
    if (!dataGetter) {
      return UNRESOLVED_SHAPE;
    }

    // Shapes of every statically resolvable return expression.
    const returnShapes: DataShape[] = [];
    const collect = (node: ts.Node): void => {
      if (ts.isReturnStatement(node) && node.expression) {
        returnShapes.push(shapeBuilder.shapeOf(checker.getTypeAtLocation(node.expression)));
      }
      ts.forEachChild(node, collect);
    };
    if (dataGetter.body) {
      collect(dataGetter.body);
    }

    const annotatedShape = annotatedType ? shapeBuilder.shapeOf(annotatedType) : undefined;

    // Partial analysis keeps the syntactically collected top-level names so a
    // binding can still be classified as "not returned at all".
    if (!annotatedShape && (hasDynamicBody || hasUnresolvedReturn)) {
      const names = new Set(dataPropertyNames);
      for (const shape of returnShapes) {
        if (shape.kind === 'object') {
          for (const name of shape.properties.keys()) {
            names.add(name);
          }
        }
      }
      return names.size > 0
        ? { kind: 'object', properties: new Map([...names].map((name) => [name, UNRESOLVED_SHAPE])) }
        : UNRESOLVED_SHAPE;
    }

    // The declared contract is authoritative for types, but a return literal
    // may add keys the interface does not declare (and the old behavior
    // accepted them). Merge both so nothing that renders at runtime is missed.
    const base = annotatedShape ?? (returnShapes.length === 1 ? returnShapes[0] : { kind: 'union' as const, members: returnShapes });
    if (base.kind !== 'object') {
      return base;
    }
    const properties = new Map(base.properties);
    for (const shape of returnShapes) {
      if (shape.kind !== 'object') {
        continue;
      }
      for (const [name, value] of shape.properties) {
        if (!properties.has(name)) {
          properties.set(name, value);
        }
      }
    }
    if (properties.size === 0 && !base.indexSignature) {
      return UNRESOLVED_SHAPE;
    }
    return base.indexSignature
      ? { kind: 'object', properties, indexSignature: base.indexSignature }
      : { kind: 'object', properties };
  })();

  const memberType = (types: ts.Type[], member: string): { types: ts.Type[]; missing: boolean; unknown: boolean } => {
    const next: ts.Type[] = [];
    let missing = false;
    let unknown = false;
    for (const type of types) {
      if (isAnyOrUnknown(type) || isPrimitive(type)) {
        unknown = true;
        continue;
      }
      if (checker.getIndexTypeOfType(type, ts.IndexKind.String) !== undefined) {
        unknown = true; // dictionaries / arrays: index access is not statically checkable
        continue;
      }
      const symbol = type.getProperty(member);
      if (!symbol) {
        missing = true;
        continue;
      }
      next.push(checker.getTypeOfSymbolAtLocation(symbol, resolveLocation));
    }
    return { types: next, missing, unknown };
  };

  const resolveDataPath = (members: string[]): MemberCheckResult => {
    if (!annotatedType || members.length === 0) {
      return { status: 'unknown' };
    }
    let types = splitType(annotatedType);
    for (let i = 0; i < members.length; i++) {
      const step = memberType(types, members[i]);
      // Only claim "missing" when every branch was statically understood;
      // otherwise an unresolvable branch could hide the property.
      if (step.missing && !step.unknown && step.types.length === 0) {
        return { status: 'missing', missingPath: members.slice(0, i + 1) };
      }
      if (step.types.length === 0) {
        return { status: 'unknown' };
      }
      types = step.types;
    }
    return { status: 'ok' };
  };

  // ---------------------------------------------------------- getter layout
  let dataGetterPosition: GetterPosition | undefined;
  if (dataGetter) {
    const start = dataGetter.getStart(sourceFile);
    const length = dataGetter.getEnd() - start;
    const position = positionAt(lineStarts, start);
    dataGetterPosition = { offset: start, length, line: position.line, column: position.column };
  }

  return {
    hasDataGetter: dataGetter !== undefined,
    dataGetterPosition,
    dataPropertyNames,
    dataResolution,
    quickViewClassName: quickViewClass?.name?.text,
    resolveDataPath,
    rootShape: proposedRootShape,
    dispose: () => {
      dataPropertyNames.clear();
    }
  };
}

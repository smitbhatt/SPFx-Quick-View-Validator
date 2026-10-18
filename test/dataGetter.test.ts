import * as assert from 'assert';
import { analyzeQuickViewTypeScript } from '../src/analyzer/analyzer';
import { analyzeFixture, fixturePath, readFixture, spfxBasicAssociation, validate, DiagnosticCodes, firstWithCode, byCode } from './helpers';

const BASIC_TS = ['spfx-basic', 'src', 'adaptiveCardExtensions', 'employee', 'quickView', 'QuickView.ts'] as const;

suite('Quick View TypeScript analysis (data getter)', () => {
  test('annotated getter: properties, class name and getter position are resolved', () => {
    const analysis = analyzeFixture(...BASIC_TS);
    assert.strictEqual(analysis.hasDataGetter, true);
    assert.strictEqual(analysis.quickViewClassName, 'QuickView');
    assert.strictEqual(analysis.dataResolution, 'full');
    assert.ok(analysis.dataPropertyNames.has('employeeName'));
    assert.ok(analysis.dataPropertyNames.has('employeeEmail'));
    assert.ok(analysis.dataPropertyNames.has('employee'));
    assert.ok(analysis.dataGetterPosition, 'getter position must be available for code actions');
    assert.ok((analysis.dataGetterPosition?.line ?? 0) > 0);
  });

  test('getter returning a variable resolves through the checker', () => {
    const analysis = analyzeFixture('variableGetter', 'QuickView.ts');
    assert.strictEqual(analysis.hasDataGetter, true);
    assert.deepStrictEqual([...analysis.dataPropertyNames].sort(), ['subtitle', 'title']);
    assert.strictEqual(analysis.dataResolution, 'full');
  });

  test('getter returning an untyped (any) value yields no resolvable shape', () => {
    const analysis = analyzeFixture('anyGetter', 'QuickView.ts');
    assert.strictEqual(analysis.hasDataGetter, true);
    assert.strictEqual(analysis.dataResolution, 'none');
    assert.strictEqual(analysis.dataPropertyNames.size, 0);
  });

  test('getter with multiple return paths (annotated) is fully resolved', () => {
    const analysis = analyzeFixture('multiReturn', 'QuickView.ts');
    assert.deepStrictEqual([...analysis.dataPropertyNames].sort(), ['a', 'b']);
    assert.strictEqual(analysis.dataResolution, 'full');
  });

  test('getter with multiple return paths (inferred) unions the paths', () => {
    const analysis = analyzeFixture('multiReturnNoAnnotation', 'QuickView.ts');
    assert.deepStrictEqual([...analysis.dataPropertyNames].sort(), ['a', 'b']);
    assert.strictEqual(analysis.dataResolution, 'full');
  });

  test('object spread makes the shape partial, not wrong', () => {
    const analysis = analyzeFixture('spreadGetter', 'QuickView.ts');
    assert.ok(analysis.dataPropertyNames.has('subtitle'), 'literal keys are still collected');
    assert.strictEqual(analysis.dataResolution, 'partial');
  });

  test('a class without a data getter is detected', () => {
    const analysis = analyzeFixture('noGetter', 'QuickView.ts');
    assert.strictEqual(analysis.hasDataGetter, false);
    assert.strictEqual(analysis.dataResolution, 'none');
  });

  test('imported interfaces, extends chains and inherited members resolve', () => {
    const analysis = analyzeFixture('inheritedImport', 'QuickView.ts');
    assert.deepStrictEqual([...analysis.dataPropertyNames].sort(), ['extra', 'shared']);
    assert.strictEqual(analysis.dataResolution, 'full');
    // IBaseData is imported and extended: its members must be known too.
    assert.ok(analysis.declaredPropertyNames.has('shared'));
    assert.ok(analysis.declaredPropertyNames.has('extra'));
  });

  test('13. unsaved TypeScript content is analyzed instead of the content on disk', () => {
    const filePath = fixturePath(...BASIC_TS);
    const onDisk = readFixture(...BASIC_TS);
    assert.ok(!onDisk.includes('bonusAmount'), 'precondition: fixture does not declare bonusAmount');

    const modified = onDisk.replace('employeeEmail: (this.properties as IQuickViewProperties).employeeEmail,', 'employeeEmail: (this.properties as IQuickViewProperties).employeeEmail,\n      bonusAmount: 1234,');

    // Same (unchanged) file path, but the "editor" holds modified content.
    const analysis = analyzeQuickViewTypeScript(filePath, modified);
    assert.ok(analysis.dataPropertyNames.has('bonusAmount'), 'the unsaved content must drive the analysis');
    assert.ok(analysis.dataPropertyNames.has('employeeName'));

    // And the new binding is accepted end to end.
    const diagnostics = validate('{ "text": "${bonusAmount}" }', {
      tsAnalysis: analysis,
      association: spfxBasicAssociation()
    });
    assert.deepStrictEqual(byCode(diagnostics, DiagnosticCodes.missingDataBinding), []);
  });

  test('the data getter position points at the getter declaration', () => {
    const analysis = analyzeFixture(...BASIC_TS);
    const content = readFixture(...BASIC_TS);
    const position = analysis.dataGetterPosition;
    assert.ok(position);
    if (position) {
      const snippet = content.substring(position.offset, position.offset + 30);
      assert.ok(snippet.includes('get data()'), `unexpected snippet at getter offset: ${snippet}`);
    }
  });

  test('nested member resolution returns missing/ok/unknown appropriately', () => {
    const analysis = analyzeFixture(...BASIC_TS);
    assert.deepStrictEqual(analysis.resolveDataPath(['employee', 'name']), { status: 'ok' });
    assert.deepStrictEqual(analysis.resolveDataPath([]), { status: 'unknown' });
    assert.deepStrictEqual(analysis.resolveDataPath(['nope']), { status: 'missing', missingPath: ['nope'] });
    assert.deepStrictEqual(analysis.resolveDataPath(['employee', 'nope']), { status: 'missing', missingPath: ['employee', 'nope'] });
    const anyAnalysis = analyzeFixture('anyGetter', 'QuickView.ts');
    assert.deepStrictEqual(anyAnalysis.resolveDataPath(['anything']), { status: 'unknown' });
  });

  test('validating a broken binding points at the expression with a useful message', () => {
    const analysis = analyzeFixture(...BASIC_TS);
    const json = `{ "text": "\${employeeName} \${employee.nope}" }`;
    const diagnostics = validate(json, { tsAnalysis: analysis, association: spfxBasicAssociation() });
    const missing = firstWithCode(diagnostics, DiagnosticCodes.missingDataBinding);
    assert.strictEqual(json.substring(missing.range.offset, missing.range.offset + missing.range.length), '${employee.nope}');
  });
});

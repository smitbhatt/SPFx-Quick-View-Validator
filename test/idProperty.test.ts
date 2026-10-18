import * as assert from 'assert';
import {
  analyzeFixture,
  byCode,
  codes,
  config,
  DiagnosticCodes,
  firstWithCode,
  spfxBasicAssociation,
  validate
} from './helpers';

const BASIC_TS = ['spfx-basic', 'src', 'adaptiveCardExtensions', 'employee', 'quickView', 'QuickView.ts'] as const;
const basicAnalysis = analyzeFixture(...BASIC_TS);
const association = spfxBasicAssociation();

suite('Element ID → TypeScript property rule', () => {
  test('IDs matching declared properties produce no diagnostics', () => {
    const json = `{
      "a": { "id": "employeeName" },
      "b": { "id": "employeeEmail" },
      "c": { "id": "employee" }
    }`;
    const diagnostics = validate(json, { tsAnalysis: basicAnalysis, association });
    assert.deepStrictEqual(byCode(diagnostics, DiagnosticCodes.missingIdProperty), []);
  });

  test('an ID without a matching property is reported as a warning by default', () => {
    const json = `{ "type": "TextBlock", "id": "totallyUnknownId" }`;
    const diagnostics = validate(json, { tsAnalysis: basicAnalysis, association });
    const missing = firstWithCode(diagnostics, DiagnosticCodes.missingIdProperty);
    assert.strictEqual(missing.severity, 'warning');
    assert.ok(missing.message.includes('"totallyUnknownId"'));
    assert.strictEqual(
      json.substring(missing.range.offset, missing.range.offset + missing.range.length),
      'totallyUnknownId'
    );
  });

  test('19. severity is configurable and the rule can be disabled', () => {
    const json = `{ "id": "unknownId" }`;
    const asError = validate(json, {
      tsAnalysis: basicAnalysis,
      association,
      config: config({ idPropertySeverity: 'error' })
    });
    assert.strictEqual(firstWithCode(asError, DiagnosticCodes.missingIdProperty).severity, 'error');

    const asInfo = validate(json, {
      tsAnalysis: basicAnalysis,
      association,
      config: config({ idPropertySeverity: 'information' })
    });
    assert.strictEqual(firstWithCode(asInfo, DiagnosticCodes.missingIdProperty).severity, 'information');

    const disabled = validate(json, {
      tsAnalysis: basicAnalysis,
      association,
      config: config({ enableIdPropertyCheck: false })
    });
    assert.deepStrictEqual(byCode(disabled, DiagnosticCodes.missingIdProperty), []);
  });

  test('element IDs and data bindings are validated independently', () => {
    // The ID exists as a property, but the binding does not.
    const json = `{ "id": "employeeName", "text": "\${missingBinding}" }`;
    const diagnostics = validate(json, { tsAnalysis: basicAnalysis, association });
    assert.deepStrictEqual(byCode(diagnostics, DiagnosticCodes.missingIdProperty), []);
    assert.strictEqual(byCode(diagnostics, DiagnosticCodes.missingDataBinding).length, 1);
  });

  test('properties from interfaces, aliases, classes, inheritance and imports are collected', () => {
    const analysis = analyzeFixture('declared', 'Declarations.ts');
    assert.strictEqual(analysis.declaredPropertyResolution, 'full');
    for (const expected of ['baseProp', 'derivedProp', 'aliasProp', 'classProp', 'secret']) {
      assert.ok(analysis.declaredPropertyNames.has(expected), `expected declared property ${expected}`);
    }
  });

  test('function parameters and local variables are NOT treated as declared properties', () => {
    const analysis = analyzeFixture('declared', 'Declarations.ts');
    assert.ok(!analysis.declaredPropertyNames.has('param'), 'function parameters must not count');
    assert.ok(!analysis.declaredPropertyNames.has('local'), 'local variables must not count');
  });

  test('when declarations cannot be resolved reliably the rule is skipped', () => {
    const analysis = analyzeFixture('noGetter', 'QuickView.ts');
    assert.strictEqual(analysis.declaredPropertyResolution, 'none');
    const diagnostics = validate('{ "id": "anything" }', { tsAnalysis: analysis, association });
    assert.deepStrictEqual(byCode(diagnostics, DiagnosticCodes.missingIdProperty), []);
  });

  test('inherited interface members (imported base) count as declared', () => {
    const analysis = analyzeFixture('inheritedImport', 'QuickView.ts');
    const diagnostics = validate('{ "id": "shared" }', { tsAnalysis: analysis, association });
    assert.deepStrictEqual(byCode(diagnostics, DiagnosticCodes.missingIdProperty), []);
    const missing = validate('{ "id": "unknownId" }', { tsAnalysis: analysis, association });
    assert.strictEqual(byCode(missing, DiagnosticCodes.missingIdProperty).length, 1);
  });

  test('codes() helper sanity for combined output', () => {
    const json = `{ "id": "unknownId", "text": "\${missing}" }`;
    const diagnostics = validate(json, { tsAnalysis: basicAnalysis, association });
    const all = codes(diagnostics);
    assert.ok(all.includes(DiagnosticCodes.missingIdProperty));
    assert.ok(all.includes(DiagnosticCodes.missingDataBinding));
  });
});

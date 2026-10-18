import * as assert from 'assert';
import { parseAdaptiveCardExpression } from '../src/core/bindings';
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

const association = spfxBasicAssociation();
const basicAnalysis = analyzeFixture('spfx-basic', 'src', 'adaptiveCardExtensions', 'employee', 'quickView', 'QuickView.ts');

suite('Data binding validation', () => {
  test('7. valid simple bindings produce no diagnostics', () => {
    const json = `{ "type": "TextBlock", "text": "\${employeeName}" }`;
    const diagnostics = validate(json, { tsAnalysis: basicAnalysis, association });
    assert.deepStrictEqual(byCode(diagnostics, DiagnosticCodes.missingDataBinding), []);
  });

  test('6. missing simple data bindings are reported as errors at the exact expression', () => {
    const json = `{ "type": "TextBlock", "text": "\${missingProp}" }`;
    const diagnostics = validate(json, { tsAnalysis: basicAnalysis, association });
    const missing = firstWithCode(diagnostics, DiagnosticCodes.missingDataBinding);
    assert.strictEqual(missing.severity, 'error');
    assert.ok(missing.message.includes('"missingProp"'));
    assert.strictEqual(json.substring(missing.range.offset, missing.range.offset + missing.range.length), '${missingProp}');
  });

  test('8. valid nested bindings resolve through the declared data type', () => {
    const json = `{
      "type": "TextBlock",
      "text": "\${employee.name} lives in \${employee.address.city}"
    }`;
    const diagnostics = validate(json, { tsAnalysis: basicAnalysis, association });
    assert.deepStrictEqual(byCode(diagnostics, DiagnosticCodes.missingDataBinding), []);
  });

  test('missing nested members are reported with the failing segment', () => {
    const json = `{ "type": "TextBlock", "text": "\${employee.address.street}" }`;
    const diagnostics = validate(json, { tsAnalysis: basicAnalysis, association });
    const missing = firstWithCode(diagnostics, DiagnosticCodes.missingDataBinding);
    assert.strictEqual(missing.severity, 'error');
    assert.ok(missing.message.includes('"address.street"'), `unexpected message: ${missing.message}`);
  });

  test('nested bindings are never treated as independent top-level properties', () => {
    const json = `{ "type": "TextBlock", "text": "\${employee.email}" }`;
    const diagnostics = validate(json, { tsAnalysis: basicAnalysis, association });
    assert.ok(!codes(diagnostics).includes(DiagnosticCodes.missingDataBinding));
  });

  test('9. multiple bindings in one string are validated independently', () => {
    const json = `{ "ariaLabel": "\${employeeName} and \${nonexistent} and \${employee.missingMember}" }`;
    const diagnostics = validate(json, { tsAnalysis: basicAnalysis, association });
    const missing = byCode(diagnostics, DiagnosticCodes.missingDataBinding);
    assert.strictEqual(missing.length, 2, `expected 2 missing bindings, got: ${JSON.stringify(codes(diagnostics))}`);
    assert.ok(missing.every((d) => d.severity === 'error'));
  });

  test('bindings inside nested card elements are validated', () => {
    const json = `{
      "type": "Container",
      "items": [
        { "type": "Container", "items": [ { "type": "TextBlock", "text": "\${nope}" } ] }
      ]
    }`;
    const diagnostics = validate(json, { tsAnalysis: basicAnalysis, association });
    assert.strictEqual(byCode(diagnostics, DiagnosticCodes.missingDataBinding).length, 1);
  });

  test('bindings are extracted from any string value, not only TextBlock.text', () => {
    const json = `{
      "type": "TextBlock",
      "text": "static",
      "ariaLabel": "Label \${employeeName}",
      "fallback": "\${unknownThing}",
      "style": "emphasis"
    }`;
    const diagnostics = validate(json, { tsAnalysis: basicAnalysis, association });
    const missing = byCode(diagnostics, DiagnosticCodes.missingDataBinding);
    assert.strictEqual(missing.length, 1);
    assert.ok(missing[0].message.includes('unknownThing'));
  });

  test('17. unsupported expressions are skipped without false positives', () => {
    const json = `{
      "a": "\${iif(state, 'yes', 'no')}",
      "b": "\${items[0].name}",
      "c": "\${employee['name']}",
      "d": "\${employee.name | upper}",
      "e": "\${}",
      "f": "\${ }",
      "g": "\${formatNumber(employeeName)}"
    }`;
    const diagnostics = validate(json, { tsAnalysis: basicAnalysis, association });
    assert.deepStrictEqual(byCode(diagnostics, DiagnosticCodes.missingDataBinding), []);
  });

  test('an unresolvable data getter (any) skips binding checks with a single warning', () => {
    const analysis = analyzeFixture('anyGetter', 'QuickView.ts');
    const json = `{ "type": "TextBlock", "text": "\${whatever}" }`;
    const diagnostics = validate(json, { tsAnalysis: analysis, association });
    assert.ok(!codes(diagnostics).includes(DiagnosticCodes.missingDataBinding), 'no false positives on unresolvable data');
    const warning = firstWithCode(diagnostics, DiagnosticCodes.unresolvedDataShape);
    assert.strictEqual(warning.severity, 'warning');
  });

  test('spread-based getters downgrade missing-binding findings to warnings', () => {
    const analysis = analyzeFixture('spreadGetter', 'QuickView.ts');
    const json = `{
      "known": "\${subtitle}",
      "fromSpread": "\${title}",
      "nowhere": "\${totallyUnknown}"
    }`;
    const diagnostics = validate(json, { tsAnalysis: analysis, association });
    const missing = byCode(diagnostics, DiagnosticCodes.missingDataBinding);
    assert.strictEqual(missing.length, 2, 'the syntactically known key is fine; the rest is flagged');
    assert.ok(missing.every((d) => d.severity === 'warning'), 'partial analysis must never claim a definite error');
  });

  test('the data-binding check can be disabled by configuration', () => {
    const json = `{ "text": "\${missingProp}" }`;
    const diagnostics = validate(json, {
      tsAnalysis: basicAnalysis,
      association,
      config: config({ enableDataBindingCheck: false })
    });
    assert.ok(!codes(diagnostics).includes(DiagnosticCodes.missingDataBinding));
  });

  test('expression parser accepts only statically analyzable paths', () => {
    assert.deepStrictEqual(parseAdaptiveCardExpression('employeeName'), { supported: true, root: 'employeeName', members: [] });
    assert.deepStrictEqual(parseAdaptiveCardExpression(' employee.name '), { supported: true, root: 'employee', members: ['name'] });
    assert.strictEqual(parseAdaptiveCardExpression('iif(a, b, c)').supported, false);
    assert.strictEqual(parseAdaptiveCardExpression('a["b"]').supported, false);
    assert.strictEqual(parseAdaptiveCardExpression('').supported, false);
  });
});

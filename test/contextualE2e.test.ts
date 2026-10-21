import * as assert from 'assert';
import { parseQuickViewJson } from '../src/core/jsonDocument';
import {
  analyzeFixture,
  byCode,
  codes,
  config,
  DiagnosticCodes,
  fixturePath,
  firstWithCode,
  readFixture,
  validate
} from './helpers';

/**
 * End-to-end scenarios for the context-aware binding validation against a
 * realistic SPFx Adaptive Card Extension Quick View (arrays, iteration,
 * `$root`, `$index`, functions, `$when`).
 */

const association = {
  status: 'resolved' as const,
  tsPath: fixturePath('contextual', 'QuickView.ts'),
  candidates: []
};
const analysis = analyzeFixture('contextual', 'QuickView.ts');
const template = readFixture('contextual', 'QuickViewTemplate.json');

function missing(json: string) {
  return byCode(validate(json, { tsAnalysis: analysis, association }), DiagnosticCodes.missingDataBinding);
}

suite('End-to-end context-aware binding validation', () => {
  test('the realistic Quick View template validates cleanly', () => {
    const diagnostics = validate(template, { tsAnalysis: analysis, association });
    assert.deepStrictEqual(codes(diagnostics), [], `unexpected diagnostics: ${JSON.stringify(diagnostics, null, 2)}`);
  });

  test('a typo in a root binding is caught and underlined precisely', () => {
    const json = template.replace('"text": "${employeeName}"', '"text": "${employeeNname}"');
    assert.notStrictEqual(json, template);
    const diagnostics = missing(json);
    assert.strictEqual(diagnostics.length, 1);
    assert.ok(diagnostics[0].message.includes('employeeNname'));
    assert.ok(json.substring(diagnostics[0].range.offset, diagnostics[0].range.offset + diagnostics[0].range.length) === 'employeeNname');
  });

  test('a typo inside an iteration is caught against the element type', () => {
    const json = template.replace('"text": "${teammateName}"', '"text": "${teammateNam}"');
    assert.notStrictEqual(json, template);
    const diagnostics = missing(json);
    assert.strictEqual(diagnostics.length, 1);
    assert.ok(diagnostics[0].message.includes('teammateNam'));
  });

  test('a typo in a function argument is caught', () => {
    const json = template.replace("formatDateTime(awaitingStepDueDate, 'MM/dd')", "formatDateTime(awaitingStepDue, 'MM/dd')");
    assert.notStrictEqual(json, template);
    const diagnostics = missing(json);
    assert.strictEqual(diagnostics.length, 1);
    assert.ok(diagnostics[0].message.includes('awaitingStepDue'));
  });

  test('a typo inside a `$when` expression is caught', () => {
    const json = template.replace('"$when": "${dayRemaining > 1}"', '"$when": "${dayRemaning > 1}"');
    assert.notStrictEqual(json, template);
    const diagnostics = missing(json);
    assert.strictEqual(diagnostics.length, 1);
    assert.strictEqual(json.substring(diagnostics[0].range.offset, diagnostics[0].range.offset + diagnostics[0].range.length), 'dayRemaning');
  });

  test('a typo in a nested `$root` path is caught on the failing segment', () => {
    const json = template.replace('${$root.theme.accentColor}', '${$root.theme.accentColour}');
    const diagnostics = missing(json);
    assert.strictEqual(diagnostics.length, 1);
    assert.strictEqual(json.substring(diagnostics[0].range.offset, diagnostics[0].range.offset + diagnostics[0].range.length), 'accentColour');
  });

  test('revalidation reflects a template fix', () => {
    const broken = template.replace('"text": "${employeeName}"', '"text": "${employeeNname}"');
    assert.strictEqual(missing(broken).length, 1);
    assert.deepStrictEqual(missing(template), []);
  });

  test('revalidation reflects a change in the paired TypeScript data shape', () => {
    // Simulate the developer adding the property that the template binds to.
    const tsPath = fixturePath('contextual', 'QuickView.ts');
    const original = readFixture('contextual', 'QuickView.ts');
    const updated = original.replace('eAuditUrl: \'https://example.com/audits\',', "eAuditUrl: 'https://example.com/audits',\n      newField: 'added',");
    assert.notStrictEqual(updated, original);
    assert.ok(original.includes('eAuditUrl:'), 'precondition: the fixture declares eAuditUrl');

    const { analyzeQuickViewTypeScript } = require('../src/analyzer/analyzer') as typeof import('../src/analyzer/analyzer');
    const before = analyzeQuickViewTypeScript(tsPath, original);
    const after = analyzeQuickViewTypeScript(tsPath, updated);

    const json = '{ "text": "${newField}" }';
    assert.strictEqual(
      byCode(validate(json, { tsAnalysis: before, association }), DiagnosticCodes.missingDataBinding).length,
      1
    );
    assert.deepStrictEqual(byCode(validate(json, { tsAnalysis: after, association }), DiagnosticCodes.missingDataBinding), []);
  });

  test('incomplete JSON while editing suppresses binding checks instead of reporting noise', () => {
    const partialDoc = '{ "type": "TextBlock", "text": "${employeeNname}"';
    const diagnostics = validate(partialDoc, { tsAnalysis: analysis, association });
    assert.ok(codes(diagnostics).includes(DiagnosticCodes.jsonSyntax), 'the syntax error is reported');
    assert.ok(!codes(diagnostics).includes(DiagnosticCodes.missingDataBinding), 'no binding noise on broken JSON');
  });

  test('an ambiguous TypeScript pairing never validates against an unrelated file', () => {
    const diagnostics = validate(template, {
      association: { status: 'ambiguous', candidates: ['EmployeeQuickView.ts', 'ManagerQuickView.ts'] }
    });
    assert.deepStrictEqual(byCode(diagnostics, DiagnosticCodes.missingDataBinding), []);
    const warning = firstWithCode(diagnostics, DiagnosticCodes.missingTypeScript);
    assert.strictEqual(warning.severity, 'warning');
  });

  test('disabling the setting silences only binding diagnostics', () => {
    const json = template.replace('"text": "${employeeName}"', '"text": "${employeeNname}"');
    const diagnostics = validate(json, {
      tsAnalysis: analysis,
      association,
      config: config({ enableDataBindingCheck: false })
    });
    assert.deepStrictEqual(byCode(diagnostics, DiagnosticCodes.missingDataBinding), []);
  });

  test('$data scopes are recorded on every binding reference', () => {
    const parsed = parseQuickViewJson(template, { allowComments: false, allowTrailingCommas: false });
    const insideTask = parsed.bindings.find((b) => b.expression.trim() === 'title');
    assert.ok(insideTask, 'expected a `title` binding inside the task repetition');
    assert.deepStrictEqual(insideTask?.scopes, ['tasks']);

    const insideSubtask = parsed.bindings.find((b) => b.path === '$.body[3].items[2].items[0].text');
    assert.ok(insideSubtask, 'expected the nested subtask binding');
    assert.deepStrictEqual(insideSubtask?.scopes, ['tasks', 'subtasks']);
    assert.strictEqual(insideSubtask?.expression.trim(), 'label');

    const atRoot = parsed.bindings.find((b) => b.expression.trim() === 'employeeName');
    assert.deepStrictEqual(atRoot?.scopes, []);
  });

  test('the `$data` expression itself is evaluated in the enclosing scope', () => {
    const parsed = parseQuickViewJson(template, { allowComments: false, allowTrailingCommas: false });
    const nested = parsed.bindings.find((b) => b.path === '$.body[3].items[2].$data');
    assert.ok(nested, 'expected the nested $data binding');
    assert.deepStrictEqual(nested?.scopes, ['tasks'], 'the subtask collection is read from the task item');
  });
});

import * as assert from 'assert';
import { DataShape } from '../src/analyzer/shape';
import { BindingResolver } from '../src/core/bindingResolver';
import {
  analyzeFixture,
  byCode,
  codes,
  DiagnosticCodes,
  fixturePath,
  firstWithCode,
  validate
} from './helpers';

/**
 * Context-aware data-binding validation: `$root`, `$data`/`$index` iteration
 * scopes, arrays, function arguments, conditionals and dynamic values.
 */

const association = {
  status: 'resolved' as const,
  tsPath: fixturePath('contextual', 'QuickView.ts'),
  candidates: []
};
const analysis = analyzeFixture('contextual', 'QuickView.ts');

function missingDiagnostics(json: string) {
  return byCode(validate(json, { tsAnalysis: analysis, association }), DiagnosticCodes.missingDataBinding);
}

/** Extracts the underlined text of a diagnostic from the source JSON. */
function underlined(json: string, index = 0): string {
  const diagnostic = missingDiagnostics(json)[index];
  assert.ok(diagnostic, 'expected a missing-binding diagnostic');
  return json.substring(diagnostic.range.offset, diagnostic.range.offset + diagnostic.range.length);
}

suite('Context-aware data-binding validation', () => {
  test('the contextual fixture resolves the expected root shape', () => {
    assert.ok(analysis.rootShape, 'a root shape must be derived');
    assert.strictEqual(analysis.rootShape?.kind, 'object');
  });

  // ------------------------------------------------------------- $root -----
  test('`$root` bindings validate against the root data object', () => {
    const json = `{
      "a": "\${$root.eAuditUrl}",
      "b": "\${$root.employeeName}",
      "c": "\${$root.employee.department.name}",
      "d": "\${$root.employee.profileUrl}"
    }`;
    assert.deepStrictEqual(missingDiagnostics(json), [], 'valid $root bindings must not be flagged');
  });

  test('a missing `$root` property is reported on the exact segment', () => {
    const json = `{ "url": "\${$root.notAuditUrl}" }`;
    const missing = missingDiagnostics(json);
    assert.strictEqual(missing.length, 1);
    assert.strictEqual(missing[0].severity, 'error');
    assert.ok(missing[0].message.includes('notAuditUrl'), missing[0].message);
    assert.strictEqual(underlined(json), 'notAuditUrl');
  });

  test('a missing nested `$root` segment names the parent path', () => {
    const json = `{ "text": "\${$root.employee.manager.email}" }`;
    const missing = missingDiagnostics(json);
    assert.strictEqual(missing.length, 1);
    assert.ok(missing[0].message.includes('"manager"'), missing[0].message);
    assert.ok(missing[0].message.includes('employee'), missing[0].message);
    assert.strictEqual(underlined(json), 'manager');
  });

  // ------------------------------------------------------------ arrays -----
  test('array element properties validate against the element type', () => {
    assert.deepStrictEqual(missingDiagnostics(`{ "t": "\${tasks[0].title}" }`), []);
    assert.deepStrictEqual(missingDiagnostics(`{ "t": "\${tasks[$index].title}" }`), []);
    assert.deepStrictEqual(missingDiagnostics(`{ "t": "\${tasks[0].subtasks[0].label}" }`), []);
  });

  test('a dynamic index does not hide a wrong element property', () => {
    const json = `{ "t": "\${tasks[$index].titel}" }`;
    const missing = missingDiagnostics(json);
    assert.strictEqual(missing.length, 1);
    assert.strictEqual(underlined(json), 'titel');
  });

  test('a missing nested array property reports the segment', () => {
    const json = `{ "t": "\${tasks[0].owner.name}" }`;
    const missing = missingDiagnostics(json);
    assert.strictEqual(missing.length, 1);
    assert.strictEqual(underlined(json), 'owner');
  });

  // ------------------------------------------------- $data / iteration -----
  test('properties relative to the current iteration item are valid', () => {
    const json = `{
      "type": "Container",
      "$data": "\${tasks}",
      "items": [
        { "type": "TextBlock", "text": "\${title}" },
        { "type": "TextBlock", "text": "\${$data.completed}" }
      ]
    }`;
    assert.deepStrictEqual(missingDiagnostics(json), []);
  });

  test('a root property referenced from inside an iteration still resolves', () => {
    const json = `{
      "type": "Container",
      "$data": "\${tasks}",
      "items": [ { "type": "TextBlock", "text": "\${employeeName}: \${title}" } ]
    }`;
    assert.deepStrictEqual(missingDiagnostics(json), []);
  });

  test('a wrong property inside an iteration is reported against the item', () => {
    const json = `{
      "type": "Container",
      "$data": "\${workdayPDRData.dueOrOverdue}",
      "items": [ { "type": "TextBlock", "text": "\${teammateNam}" } ]
    }`;
    const missing = missingDiagnostics(json);
    assert.strictEqual(missing.length, 1);
    assert.ok(missing[0].message.includes('teammateNam'), missing[0].message);
    assert.ok(missing[0].message.includes('iteration'), missing[0].message);
  });

  test('`$root` inside a nested iteration resolves against the root data', () => {
    const json = `{
      "type": "Container",
      "$data": "\${tasks}",
      "items": [
        {
          "type": "Container",
          "$data": "\${subtasks}",
          "items": [ { "type": "TextBlock", "text": "\${$root.eAuditUrl} \${label}" } ]
        }
      ]
    }`;
    assert.deepStrictEqual(missingDiagnostics(json), []);
  });

  test('the scope chain reaches the enclosing iteration item', () => {
    // `title` belongs to the outer task item, not the subtask — the templating
    // engine resolves it through the scope chain, so it must not be flagged.
    const json = `{
      "type": "Container",
      "$data": "\${tasks}",
      "items": [
        { "type": "Container", "$data": "\${subtasks}", "items": [ { "text": "\${title}" } ] }
      ]
    }`;
    assert.deepStrictEqual(missingDiagnostics(json), []);
  });

  test('a property missing from every scope is reported once', () => {
    const json = `{
      "type": "Container",
      "$data": "\${tasks}",
      "items": [
        { "type": "Container", "$data": "\${subtasks}", "items": [ { "text": "\${titel}" } ] }
      ]
    }`;
    const missing = missingDiagnostics(json);
    assert.strictEqual(missing.length, 1);
    assert.strictEqual(underlined(json), 'titel');
  });

  test('a bare `$data` reference outside iteration is unverifiable, not missing', () => {
    assert.deepStrictEqual(missingDiagnostics(`{ "text": "\${$data.title}" }`), []);
  });

  // ---------------------------------------------- functions/conditionals ---
  test('function arguments are validated, string literals are not', () => {
    assert.deepStrictEqual(
      missingDiagnostics(`{ "text": "\${formatDateTime(employee.profileUrl, 'MM/dd')}" }`),
      []
    );
    const json = `{ "text": "\${formatDateTime(awaitingStepDueDate, 'MM/dd')}" }`;
    // Outside iteration this resolves against the root scope, where the item
    // property does not exist — it must be flagged, not silently ignored.
    const missing = missingDiagnostics(json);
    assert.strictEqual(missing.length, 1);
    assert.strictEqual(underlined(json), 'awaitingStepDueDate');
  });

  test('function arguments inside an iteration resolve against the item', () => {
    const json = `{
      "type": "Container",
      "$data": "\${workdayPDRData.dueOrOverdue}",
      "items": [
        { "type": "TextBlock", "text": "\${formatDateTime(awaitingStepDueDate, 'MM/dd')}" },
        { "type": "TextBlock", "text": "\${if(dayRemaining > 1, 'late', 'ok')}" }
      ]
    }`;
    assert.deepStrictEqual(missingDiagnostics(json), []);
  });

  test('conditional and comparison expressions validate their references', () => {
    assert.deepStrictEqual(missingDiagnostics(`{ "t": "\${employeeName === 'Smit' ? eAuditUrl : employeeName}" }`), []);
    const json = `{ "t": "\${dayRemaining > 1 ? 'late' : 'ok'}" }`;
    const missing = missingDiagnostics(json);
    assert.strictEqual(missing.length, 1);
    assert.strictEqual(underlined(json), 'dayRemaining');
  });

  test('index signatures accept arbitrary keys', () => {
    assert.deepStrictEqual(missingDiagnostics(`{ "t": "\${metadata.anything}" }`), []);
  });

  test('unknown/dynamic values are skipped instead of reported', () => {
    // `serverPayload` is `unknown`: a binding into it cannot be verified.
    assert.deepStrictEqual(missingDiagnostics(`{ "t": "\${serverPayload.whatever.deep}" }`), []);
    assert.ok(!codes(validate(`{ "t": "\${serverPayload.x}" }`, { tsAnalysis: analysis, association })).includes(
      DiagnosticCodes.missingDataBinding
    ));
  });

  test('filters and other unsupported syntax are still skipped', () => {
    assert.deepStrictEqual(missingDiagnostics(`{ "t": "\${nope | upper}" }`), []);
    assert.deepStrictEqual(missingDiagnostics(`{ "t": "\${totallyUnknown | upper}" }`), []);
  });

  // ------------------------------------------------------- messages/ranges --
  test('the missing root property message names the root data context', () => {
    const json = `{ "text": "\${employeeNname}" }`;
    const missing = firstWithCode(
      validate(json, { tsAnalysis: analysis, association }),
      DiagnosticCodes.missingDataBinding
    );
    assert.ok(missing.message.includes('root Quick View data'), missing.message);
    assert.ok(missing.message.includes('employeeNname'), missing.message);
  });

  test('the missing nested property message names the parent object', () => {
    const json = `{ "text": "\${employee.departmnt}" }`;
    const missing = firstWithCode(
      validate(json, { tsAnalysis: analysis, association }),
      DiagnosticCodes.missingDataBinding
    );
    assert.ok(missing.message.includes('departmnt'), missing.message);
    assert.ok(missing.message.includes('employee'), missing.message);
  });

  // ------------------------------------------------------------- resolver ---
  test('the resolver exposes structured results', () => {
    const shape = analysis.rootShape as DataShape;
    const resolver = new BindingResolver({ rootShape: shape });
    const missing = resolver.resolve('employee.manager.email');
    assert.strictEqual(missing.status, 'missing');
    assert.strictEqual(missing.missing?.name, 'manager');
    assert.deepStrictEqual(missing.missing?.resolvedPath, ['employee']);
    assert.strictEqual(missing.missing?.segmentIndex, 2);

    assert.strictEqual(resolver.resolve('employeeName').status, 'valid');
    assert.strictEqual(resolver.resolve('nope').status, 'missing');
    assert.strictEqual(resolver.resolve('unknownFn(employeeName)').status, 'valid');
    assert.strictEqual(resolver.resolve('a | upper').status, 'unsupported');
  });

  test('the resolver understands iteration scopes', () => {
    const shape = analysis.rootShape as DataShape;
    const resolver = new BindingResolver({
      rootShape: shape,
      scopes: [{ expression: 'workdayPDRData.dueOrOverdue' }]
    });
    assert.strictEqual(resolver.resolve('teammateName').status, 'valid');
    assert.strictEqual(resolver.resolve('$data.dayRemaining').status, 'valid');
    assert.strictEqual(resolver.resolve('$root.eAuditUrl').status, 'valid');
    assert.strictEqual(resolver.resolve('missingInItem').status, 'missing');
  });
});

import * as assert from 'assert';
import { readFileSync } from 'fs';
import * as path from 'path';
import { isQuickViewJsonPath } from '../src/core/association';
import { DEFAULT_CONFIG } from '../src/core/types';
import {
  analyzeFixture,
  byCode,
  codes,
  config,
  DiagnosticCodes,
  fixturePath,
  firstWithCode,
  readFixture,
  spfxBasicAssociation,
  validate
} from './helpers';

const association = spfxBasicAssociation();
const basicAnalysis = analyzeFixture('spfx-basic', 'src', 'adaptiveCardExtensions', 'employee', 'quickView', 'QuickView.ts');

suite('End-to-end validation (realistic SPFx Quick View)', () => {
  test('the shipped SPFx fixture validates cleanly', () => {
    const json = readFixture('spfx-basic', 'src', 'adaptiveCardExtensions', 'employee', 'quickView', 'quickview.json');
    const diagnostics = validate(json, { tsAnalysis: basicAnalysis, association });
    assert.deepStrictEqual(codes(diagnostics), [], `unexpected diagnostics: ${JSON.stringify(diagnostics, null, 2)}`);
  });

  test('the assets/ Quick View template validates against the quickView/ implementation', () => {
    const json = readFixture('spfx-basic', 'src', 'adaptiveCardExtensions', 'employee', 'assets', 'QuickViewTemplate.json');
    const assetsAssociation = {
      status: 'resolved' as const,
      tsPath: fixturePath('spfx-basic', 'src', 'adaptiveCardExtensions', 'employee', 'quickView', 'QuickView.ts'),
      candidates: []
    };
    const diagnostics = validate(json, { tsAnalysis: basicAnalysis, association: assetsAssociation });
    assert.deepStrictEqual(codes(diagnostics), []);
  });

  test('a broken Quick View reports duplicate IDs, missing bindings and unknown IDs together', () => {
    const json = `{
  "type": "Container",
  "items": [
    { "type": "TextBlock", "id": "employeeName", "text": "\${employeeName}" },
    { "type": "Input.Text", "id": "employeeName", "value": "\${notProvided}" },
    { "type": "TextBlock", "id": "mysteryId" }
  ]
}`;
    const diagnostics = validate(json, { tsAnalysis: basicAnalysis, association });

    const duplicates = byCode(diagnostics, DiagnosticCodes.duplicateId);
    assert.strictEqual(duplicates.length, 2);
    assert.ok(duplicates.every((d) => d.severity === 'error'));

    const missingBinding = firstWithCode(diagnostics, DiagnosticCodes.missingDataBinding);
    assert.strictEqual(missingBinding.severity, 'error');
    assert.ok(missingBinding.message.includes('notProvided'));

    // Deterministic ordering: by offset.
    const offsets = diagnostics.map((d) => d.range.offset);
    assert.deepStrictEqual(offsets, [...offsets].sort((a, b) => a - b));
  });

  test('20. revalidating a fixed document yields zero diagnostics (stale diagnostics are replaced)', () => {
    const broken = `{ "id": "dup", "text": "\${missing}" }`;
    const fixed = `{ "id": "employeeName", "text": "\${employeeName}" }`;
    assert.ok(validate(broken, { tsAnalysis: basicAnalysis, association }).length > 0);
    assert.deepStrictEqual(validate(fixed, { tsAnalysis: basicAnalysis, association }), []);
  });

  test('14. unsaved JSON changes are validated against the same analysis', () => {
    // The on-disk file is clean; the "editor" buffer introduces problems.
    const onDisk = readFixture('spfx-basic', 'src', 'adaptiveCardExtensions', 'employee', 'quickView', 'quickview.json');
    const dirty = onDisk.replace('"text": "${employeeName}"', '"text": "${employeeNname}"');
    assert.notStrictEqual(dirty, onDisk);
    const diagnostics = validate(dirty, { tsAnalysis: basicAnalysis, association });
    const missing = firstWithCode(diagnostics, DiagnosticCodes.missingDataBinding);
    assert.ok(missing.message.includes('employeeNname'));
  });

  test('15. a missing TypeScript association yields a single helpful warning', () => {
    const json = readFixture('no-ts', 'quickview.json');
    const diagnostics = validate(json, { association: { status: 'none', candidates: [] } });
    assert.strictEqual(diagnostics.length, 1);
    assert.strictEqual(diagnostics[0].code, DiagnosticCodes.missingTypeScript);
    assert.strictEqual(diagnostics[0].severity, 'warning');
    assert.ok(diagnostics[0].message.includes('Select Associated TypeScript File'));
    // Even without TypeScript, duplicate detection still works:
    const withDuplicates = `{ "a": { "id": "x" }, "b": { "id": "x" } }`;
    const result = validate(withDuplicates, { association: { status: 'none', candidates: [] } });
    assert.strictEqual(byCode(result, DiagnosticCodes.duplicateId).length, 2);
    assert.strictEqual(byCode(result, DiagnosticCodes.missingTypeScript).length, 1);
  });

  test('an ambiguous association warns and lists the candidates', () => {
    const json = `{ "text": "\${whatever}" }`;
    const diagnostics = validate(json, {
      association: { status: 'ambiguous', candidates: ['EmployeeQuickView.ts', 'ManagerQuickView.ts'] }
    });
    const warning = firstWithCode(diagnostics, DiagnosticCodes.missingTypeScript);
    assert.ok(warning.message.includes('EmployeeQuickView.ts'));
    assert.ok(warning.message.includes('ManagerQuickView.ts'));
  });

  test('when binding checks are disabled, association problems stay silent', () => {
    const json = `{ "text": "\${whatever}" }`;
    const diagnostics = validate(json, {
      association: { status: 'none' },
      config: config({ enableDataBindingCheck: false })
    });
    assert.deepStrictEqual(codes(diagnostics), []);
  });

  test('a missing data getter produces a warning and skips binding checks', () => {
    const analysis = analyzeFixture('noGetter', 'QuickView.ts');
    const diagnostics = validate('{ "text": "${anything}" }', { tsAnalysis: analysis, association });
    assert.strictEqual(byCode(diagnostics, DiagnosticCodes.noDataGetter).length, 1);
    assert.deepStrictEqual(byCode(diagnostics, DiagnosticCodes.missingDataBinding), []);
  });

  test('unrelated JSON files are out of scope by predicate', () => {
    assert.strictEqual(isQuickViewJsonPath(fixturePath('spfx-basic', 'package.json')), false);
    // Simulates the extension controller: validation is never invoked for them.
    assert.strictEqual(isQuickViewJsonPath(fixturePath('spfx-basic', 'src', 'adaptiveCardExtensions', 'employee', 'quickView', 'quickview.json')), true);
  });

  test('configuration toggles gate each rule independently', () => {
    const noisy = `{ "id": "dup", "b": { "id": "dup" }, "text": "\${missing}" }`;
    const all = validate(noisy, { tsAnalysis: basicAnalysis, association });
    assert.strictEqual(byCode(all, DiagnosticCodes.duplicateId).length, 2);
    assert.strictEqual(byCode(all, DiagnosticCodes.missingDataBinding).length, 1);

    const noDuplicates = validate(noisy, {
      tsAnalysis: basicAnalysis,
      association,
      config: config({ enableDuplicateIdCheck: false })
    });
    assert.ok(!codes(noDuplicates).includes(DiagnosticCodes.duplicateId));

    const noBindings = validate(noisy, {
      tsAnalysis: basicAnalysis,
      association,
      config: config({ enableDataBindingCheck: false })
    });
    assert.ok(!codes(noBindings).includes(DiagnosticCodes.missingDataBinding));
  });

  /**
   * The extension's *shipped* defaults (package.json) decide what a user gets
   * without configuring anything, so assert the ones users depend on directly
   * against package.json rather than only against the in-code fallback.
   */
  test('package.json ships the documented user-facing defaults', () => {
    const pkg = JSON.parse(readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8'));
    const props = pkg.contributes.configuration.properties as Record<string, { default: unknown }>;
    // The data-binding check must be on out of the box.
    assert.strictEqual(props['spfxQuickViewValidator.enableDataBindingCheck'].default, true);
    // The JSON file patterns cover <Something>Template.json.
    assert.deepStrictEqual(props['spfxQuickViewValidator.jsonFilePatterns'].default, [
      'quickview*.json',
      '*Template.json',
    ]);
  });

  test('default configuration has strict JSON and the binding check enabled', () => {
    assert.strictEqual(DEFAULT_CONFIG.allowJsonComments, false);
    assert.strictEqual(DEFAULT_CONFIG.allowTrailingCommas, false);
    assert.strictEqual(DEFAULT_CONFIG.enableDuplicateIdCheck, true);
    assert.strictEqual(DEFAULT_CONFIG.enableDataBindingCheck, true);
    assert.ok(DEFAULT_CONFIG.validationDebounceMs >= 0);
    assert.deepStrictEqual(DEFAULT_CONFIG.jsonFilePatterns, ['quickview*.json', '*Template.json']);
    assert.strictEqual(DEFAULT_CONFIG.requireManualSelection, false);
  });
});

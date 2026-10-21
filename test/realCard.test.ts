import * as assert from 'assert';
import { analyzeFixture, codes, fixturePath, readFixture, validate } from './helpers';

/**
 * Regression guard for the card shape that originally produced false
 * positives: `$data` iteration, `$root`, `formatDateTime(...)`, and adjacent
 * `$when` numeric conditions (`> 1` / `< 2`).
 */

const association = {
  status: 'resolved' as const,
  tsPath: fixturePath('realcard', 'QuickView.ts'),
  candidates: []
};

suite('Real-world card regression guard', () => {
  test('the real card reports no diagnostics at all', () => {
    const analysis = analyzeFixture('realcard', 'QuickView.ts');
    const json = readFixture('realcard', 'QuickViewTemplate.json');
    const diagnostics = validate(json, { tsAnalysis: analysis, association });
    assert.deepStrictEqual(codes(diagnostics), [], `unexpected diagnostics: ${JSON.stringify(diagnostics, null, 2)}`);
  });

  test('a genuinely wrong property in the same card is still reported', () => {
    const analysis = analyzeFixture('realcard', 'QuickView.ts');
    const json = readFixture('realcard', 'QuickViewTemplate.json').replace('"${teammateName}"', '"${teammateNames}"');
    const diagnostics = validate(json, { tsAnalysis: analysis, association });
    assert.strictEqual(diagnostics.length, 1);
    assert.strictEqual(diagnostics[0].code, 'missingDataBinding');
    assert.ok(json.substring(diagnostics[0].range.offset, diagnostics[0].range.offset + diagnostics[0].range.length) === 'teammateNames');
  });
});

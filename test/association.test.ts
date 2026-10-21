import * as assert from 'assert';
import * as path from 'path';
import {
  discoverTypeScriptCandidates,
  isQuickViewJsonPath,
  isQuickViewTypeScriptPath,
  matchesJsonFilePatterns,
  resolveAssociatedTypeScript
} from '../src/core/association';
import { DEFAULT_CONFIG } from '../src/core/types';
import { fixturePath } from './helpers';

const BASIC_JSON = fixturePath('spfx-basic', 'src', 'adaptiveCardExtensions', 'employee', 'quickView', 'quickview.json');
const ASSETS_JSON = fixturePath('spfx-basic', 'src', 'adaptiveCardExtensions', 'employee', 'assets', 'QuickViewTemplate.json');

suite('Quick View file association', () => {
  test('18. only quickview-style JSON files are treated as Quick View templates', () => {
    assert.strictEqual(isQuickViewJsonPath('C:/proj/src/quickview.json'), true);
    assert.strictEqual(isQuickViewJsonPath('C:/proj/src/QuickView.json'), true);
    assert.strictEqual(isQuickViewJsonPath('C:/proj/src/QuickViewTemplate.json'), true);
    assert.strictEqual(isQuickViewJsonPath('C:/proj/src/quickViewTemplate.json'), true);
    assert.strictEqual(isQuickViewJsonPath('C:/proj/package.json'), false);
    assert.strictEqual(isQuickViewJsonPath('C:/proj/src/employee.json'), false);
    assert.strictEqual(isQuickViewJsonPath('C:/proj/quickview.md'), false);
    assert.strictEqual(isQuickViewJsonPath('C:/proj/src/quickviewConfig.json.bak'), false);
  });

  test('Quick View TypeScript naming convention matcher', () => {
    assert.strictEqual(isQuickViewTypeScriptPath('QuickView.ts'), true);
    assert.strictEqual(isQuickViewTypeScriptPath('quickView.ts'), true);
    assert.strictEqual(isQuickViewTypeScriptPath('EmployeeQuickView.ts'), true);
    assert.strictEqual(isQuickViewTypeScriptPath('quickViewDefinition.ts'), false);
    assert.strictEqual(isQuickViewTypeScriptPath('helper.ts'), false);
  });

  test('SPFx standard layout resolves deterministically to QuickView.ts', () => {
    const association = resolveAssociatedTypeScript(BASIC_JSON);
    assert.strictEqual(association.status, 'resolved');
    assert.strictEqual(
      path.basename(association.tsPath ?? ''),
      'QuickView.ts'
    );
    assert.ok((association.tsPath ?? '').toLowerCase().endsWith(path.join('quickview', 'quickview.ts').toLowerCase()));
  });

  test('a JSON file in assets/ resolves through the sibling quickView/ folder', () => {
    const association = resolveAssociatedTypeScript(ASSETS_JSON);
    assert.strictEqual(association.status, 'resolved');
    assert.strictEqual(path.basename(association.tsPath ?? ''), 'QuickView.ts');
  });

  test('an exact QuickView.ts wins over similarly named files', () => {
    const association = resolveAssociatedTypeScript(fixturePath('exact', 'quickview.json'));
    assert.strictEqual(association.status, 'resolved');
    assert.strictEqual(path.basename(association.tsPath ?? ''), 'QuickView.ts');
  });

  test('16. multiple candidate TypeScript files are reported as ambiguous, never silently chosen', () => {
    const association = resolveAssociatedTypeScript(fixturePath('ambiguous', 'quickView', 'quickview.json'));
    assert.strictEqual(association.status, 'ambiguous');
    assert.strictEqual(association.candidates.length, 2);
    const names = association.candidates.map((candidate) => path.basename(candidate)).sort();
    assert.deepStrictEqual(names, ['EmployeeQuickView.ts', 'ManagerQuickView.ts']);
    assert.strictEqual(association.tsPath, undefined, 'no silent choice');
  });

  test('15. missing associated TypeScript files are reported as none', () => {
    const association = resolveAssociatedTypeScript(fixturePath('no-ts', 'quickview.json'));
    assert.strictEqual(association.status, 'none');
    assert.deepStrictEqual(association.candidates, []);
  });

  test('a manual override takes precedence and a stale override falls back', () => {
    const override = fixturePath('ambiguous', 'quickView', 'ManagerQuickView.ts');
    const association = resolveAssociatedTypeScript(BASIC_JSON, override);
    assert.strictEqual(association.status, 'resolved');
    assert.strictEqual(association.tsPath, override);

    const stale = resolveAssociatedTypeScript(BASIC_JSON, fixturePath('no-ts', 'does-not-exist.ts'));
    assert.strictEqual(stale.status, 'resolved', 'falls back to automatic resolution');
    assert.strictEqual(path.basename(stale.tsPath ?? ''), 'QuickView.ts');
  });

  test('candidate discovery skips unrelated files', () => {
    const discovery = discoverTypeScriptCandidates(BASIC_JSON);
    assert.strictEqual(discovery.all.length, 1, `unexpected candidates: ${discovery.all.join(', ')}`);
    assert.strictEqual(path.basename(discovery.primary ?? ''), 'QuickView.ts');
  });

  test('custom JSON file patterns are supported (configurable trigger)', () => {
    const patterns = ['quickview*.json', 'RiseCard.json', '*Template*.json'];
    assert.strictEqual(matchesJsonFilePatterns('C:/proj/RiseCard.json', patterns), true);
    assert.strictEqual(matchesJsonFilePatterns('C:/proj/quickview.json', patterns), true);
    assert.strictEqual(matchesJsonFilePatterns('C:/proj/QuickViewTemplate.json', patterns), true);
    assert.strictEqual(matchesJsonFilePatterns('C:/proj/AdaptiveCard.json', patterns), false);
    assert.strictEqual(matchesJsonFilePatterns('C:/proj/package.json', patterns), false);

    // A custom trigger works through the standard predicate too.
    assert.strictEqual(isQuickViewJsonPath('C:/proj/RiseCard.json', patterns), true);
    assert.strictEqual(isQuickViewJsonPath('C:/proj/RiseCard.json', DEFAULT_CONFIG.jsonFilePatterns), false);
  });

  test('the default patterns cover <Something>Template.json names', () => {
    const defaults = DEFAULT_CONFIG.jsonFilePatterns;
    assert.strictEqual(isQuickViewJsonPath('C:/proj/QuickViewTemplate.json', defaults), true);
    assert.strictEqual(isQuickViewJsonPath('C:/proj/RiseCardTemplate.json', defaults), true);
    assert.strictEqual(isQuickViewJsonPath('C:/proj/MyCardTemplate.json', defaults), true);
    assert.strictEqual(isQuickViewJsonPath('C:/proj/quickview.json', defaults), true);
    // Unrelated JSON files stay out of scope.
    assert.strictEqual(isQuickViewJsonPath('C:/proj/AdaptiveCard.json', defaults), false);
    assert.strictEqual(isQuickViewJsonPath('C:/proj/package.json', defaults), false);
  });

  test('an empty pattern list falls back to the built-in default', () => {
    assert.strictEqual(matchesJsonFilePatterns('C:/proj/quickview.json', []), true);
    assert.strictEqual(matchesJsonFilePatterns('C:/proj/anything.json', []), false);
  });

  test('wildcards are literal elsewhere in the pattern', () => {
    assert.strictEqual(matchesJsonFilePatterns('C:/proj/mycard.json', ['mycard.json']), true);
    assert.strictEqual(matchesJsonFilePatterns('C:/proj/myXcard.json', ['mycard.json']), false);
    assert.strictEqual(matchesJsonFilePatterns('C:/proj/a+b.json', ['a+b.json']), true);
  });
});

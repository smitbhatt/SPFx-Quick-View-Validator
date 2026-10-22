import * as assert from 'assert';
import { applyIdSuffix, generateDuplicateIdFix, planDuplicateIdFix, randomIdSuffix } from '../src/core/duplicateFix';
import { parseQuickViewJson } from '../src/core/jsonDocument';
import { byCode, DiagnosticCodes, validate } from './helpers';

function parseIds(text: string, allowComments = false) {
  return parseQuickViewJson(text, { allowComments, allowTrailingCommas: false }).ids;
}

function occurrencesOf(text: string, value: string, allowComments = false) {
  return parseIds(text, allowComments)
    .filter((id) => id.value === value)
    .sort((a, b) => a.offset - b.offset);
}

/** Applies a planned fix the way the command does: a raw splice at the target range. */
function applyPlan(
  text: string,
  target: { offset: number; length: number; expectedId: string },
  suffix?: () => string
): string {
  const plan = planDuplicateIdFix(text, target, parseIds(text), suffix);
  if ('error' in plan) {
    throw new Error(plan.error);
  }
  return text.slice(0, target.offset) + plan.replacementText + text.slice(target.offset + target.length);
}

function tripleDuplicateDoc(): string {
  return JSON.stringify(
    {
      type: 'AdaptiveCard',
      body: [
        { type: 'TextBlock', id: 'employee_name', text: 'a' },
        { type: 'TextBlock', id: 'employee_name', text: 'b' },
        { type: 'TextBlock', id: 'employee_name', text: 'c' }
      ]
    },
    null,
    2
  );
}

function doubleDuplicateDoc(): string {
  return JSON.stringify(
    {
      type: 'AdaptiveCard',
      body: [
        { type: 'TextBlock', id: 'days', text: 'a' },
        { type: 'TextBlock', id: 'days', text: 'b' }
      ]
    },
    null,
    2
  );
}

suite('Fix duplicate ID — suffix placement rules', () => {
  test('an ID without a dynamic expression gets the suffix appended', () => {
    assert.strictEqual(applyIdSuffix('employee_name', 'a3f91c'), 'employee_name_a3f91c');
    const fix = generateDuplicateIdFix('employee_name', new Set(), () => 'a3f91c');
    assert.ok('id' in fix);
    if ('id' in fix) {
      assert.strictEqual(fix.id, 'employee_name_a3f91c');
    }
  });

  test('${$index} is preserved exactly, suffix inserted before the marker', () => {
    assert.strictEqual(
      applyIdSuffix('text_gray_news_dt_eAudits_dueToday_seprator_${$index}', 'a3f91c'),
      'text_gray_news_dt_eAudits_dueToday_seprator_a3f91c_${$index}'
    );
  });

  test('an expression at the beginning of the ID still gets the prefix', () => {
    assert.strictEqual(applyIdSuffix('${employeeId}_label', 'a3f91c'), 'a3f91c_${employeeId}_label');
  });

  test('multiple dynamic expressions are all preserved', () => {
    assert.strictEqual(
      applyIdSuffix('item_${employeeId}_${$index}', 'a3f91c'),
      'item_a3f91c_${employeeId}_${$index}'
    );
  });

  test('the default suffix is six lowercase hex characters', () => {
    for (let i = 0; i < 20; i++) {
      assert.match(randomIdSuffix(), /^[0-9a-f]{6}$/);
    }
    const fix = generateDuplicateIdFix('x_${$index}', new Set());
    assert.ok('id' in fix && /^[0-9a-f]{6}$/.test(fix.suffix));
  });

  test('the generated ID follows the pattern and preserves the original exactly', () => {
    const original = 'employee_${$index}';
    const fix = generateDuplicateIdFix(original, new Set(['other_id']));
    assert.ok('id' in fix);
    if ('id' in fix) {
      assert.match(fix.id, /^employee_[0-9a-f]{6}_\$\{\$index\}$/);
    }
  });
});

suite('Fix duplicate ID — uniqueness', () => {
  test('a colliding candidate is retried with a fresh suffix and recorded', () => {
    const taken = new Set(['employee_name_aaaaaa']);
    const suffixes = ['aaaaaa', 'bbbbbb'];
    const fix = generateDuplicateIdFix('employee_name', taken, () => suffixes.shift() as string);
    assert.ok('id' in fix);
    if ('id' in fix) {
      assert.strictEqual(fix.id, 'employee_name_bbbbbb');
    }
    assert.ok(taken.has('employee_name_bbbbbb'), 'the accepted candidate joins the set immediately');
  });

  test('consecutive fixes generate distinct IDs', () => {
    const taken = new Set<string>();
    const suffixes = ['aaaaaa', 'aaaaaa', 'bbbbbb'];
    const next = (): string => suffixes.shift() as string;
    const first = generateDuplicateIdFix('employee_name', taken, next);
    const second = generateDuplicateIdFix('employee_name', taken, next);
    assert.ok('id' in first && 'id' in second);
    if ('id' in first && 'id' in second) {
      assert.strictEqual(first.id, 'employee_name_aaaaaa');
      assert.strictEqual(second.id, 'employee_name_bbbbbb', 'the repeated suffix collides and is retried');
      assert.notStrictEqual(first.id, second.id);
    }
  });

  test('a clear error is returned when uniqueness cannot be achieved', () => {
    const taken = new Set(['x_aaaaaa']);
    const fix = generateDuplicateIdFix('x', taken, () => 'aaaaaa', 5);
    assert.ok('error' in fix);
    if ('error' in fix) {
      assert.ok(fix.error.includes('after 5 attempts'), fix.error);
    }
  });

  test('an empty ID is rejected gracefully', () => {
    const fix = generateDuplicateIdFix('', new Set());
    assert.ok('error' in fix);
  });
});

suite('Fix duplicate ID — document flow (plan, splice, revalidate)', () => {
  test('only the selected occurrence changes; the first occurrence stays untouched', () => {
    const doc = tripleDuplicateDoc();
    const [, second] = occurrencesOf(doc, 'employee_name');
    const fixed = applyPlan(doc, { offset: second.offset, length: second.length, expectedId: 'employee_name' });

    const first = occurrencesOf(doc, 'employee_name')[0];
    assert.strictEqual(
      fixed.slice(first.offset, first.offset + first.length),
      'employee_name',
      'the first occurrence must keep the original ID'
    );
    assert.strictEqual(occurrencesOf(fixed, 'employee_name').length, 2, '1st and 3rd still share the ID');
    assert.strictEqual(fixed.slice(0, second.offset), doc.slice(0, second.offset), 'nothing before the range changes');
    assert.ok(/employee_name_[0-9a-f]{6}/.test(fixed.slice(second.offset, second.offset + 40)));
  });

  test('sequential fixes resolve all duplicates with distinct IDs', () => {
    let doc = tripleDuplicateDoc();
    // Mirrors real usage: after each fix, diagnostics (and offsets) are fresh.
    for (;;) {
      const remaining = occurrencesOf(doc, 'employee_name');
      if (remaining.length < 2) {
        break;
      }
      doc = applyPlan(doc, { offset: remaining[1].offset, length: remaining[1].length, expectedId: 'employee_name' });
    }
    const fixedIds = parseIds(doc)
      .filter((id) => id.value.startsWith('employee_name'))
      .sort((a, b) => a.offset - b.offset)
      .map((id) => doc.slice(id.offset, id.offset + id.length));
    assert.strictEqual(fixedIds.length, 3);
    assert.strictEqual(fixedIds[0], 'employee_name', 'first occurrence untouched');
    assert.strictEqual(new Set(fixedIds).size, 3, 'every fixed ID is distinct');
    for (const id of fixedIds.slice(1)) {
      assert.match(id, /^employee_name_[0-9a-f]{6}$/);
    }
  });

  test('validation reruns and the resolved diagnostic disappears', () => {
    const doc = doubleDuplicateDoc();
    assert.strictEqual(byCode(validate(doc), DiagnosticCodes.duplicateId).length, 2);

    const [, second] = occurrencesOf(doc, 'days');
    const fixed = applyPlan(doc, { offset: second.offset, length: second.length, expectedId: 'days' });
    assert.strictEqual(
      byCode(validate(fixed), DiagnosticCodes.duplicateId).length,
      0,
      'fixing one of two occurrences resolves the duplicate'
    );
  });

  test('the diagnostic metadata identifies the occurrence to keep and every ID', () => {
    const doc = tripleDuplicateDoc();
    const diagnostics = byCode(validate(doc), DiagnosticCodes.duplicateId);
    assert.strictEqual(diagnostics.length, 3);
    const [first] = occurrencesOf(doc, 'employee_name');
    for (const diagnostic of diagnostics) {
      assert.ok(diagnostic.data && diagnostic.data.kind === 'duplicateId');
      if (diagnostic.data && diagnostic.data.kind === 'duplicateId') {
        assert.strictEqual(diagnostic.data.keepOffset, first.offset);
        assert.deepStrictEqual(diagnostic.data.allIds, ['employee_name', 'employee_name', 'employee_name']);
      }
    }
  });

  test('malformed JSON, missing ranges and stale targets are handled safely', () => {
    const doc = tripleDuplicateDoc();
    const [first, second] = occurrencesOf(doc, 'employee_name');
    const ids = parseIds(doc);

    // Stale diagnostic: the offset no longer points at an ID value.
    const wrongOffset = planDuplicateIdFix(
      doc,
      { offset: first.offset + 1, length: first.length, expectedId: 'employee_name' },
      ids
    );
    assert.ok('error' in wrongOffset);

    // The first occurrence is never fixable — it keeps the ID.
    const firstOccurrence = planDuplicateIdFix(
      doc,
      { offset: first.offset, length: first.length, expectedId: 'employee_name' },
      ids
    );
    assert.ok('error' in firstOccurrence);
    if ('error' in firstOccurrence) {
      assert.ok(firstOccurrence.error.includes('first occurrence'), firstOccurrence.error);
    }

    // Wrong expected value.
    const wrongValue = planDuplicateIdFix(doc, { offset: second.offset, length: second.length, expectedId: 'other' }, ids);
    assert.ok('error' in wrongValue);

    // Out-of-range offsets.
    const outOfRange = planDuplicateIdFix(doc, { offset: doc.length - 1, length: 50, expectedId: 'employee_name' }, ids);
    assert.ok('error' in outOfRange);
    const negative = planDuplicateIdFix(doc, { offset: -5, length: 4, expectedId: 'employee_name' }, ids);
    assert.ok('error' in negative);

    // An ID that is not duplicated anymore.
    const unique = planDuplicateIdFix(doc, { offset: first.offset, length: first.length, expectedId: 'employee_name' }, [
      { value: 'employee_name', path: '$.body[0].id', offset: first.offset, length: first.length, node: first.node, containerPath: '$.body' }
    ]);
    assert.ok('error' in unique);

    // Garbage inputs never throw.
    assert.ok('error' in planDuplicateIdFix(doc, undefined as never, ids));
    assert.ok('error' in planDuplicateIdFix(doc, { offset: 0, length: 0, expectedId: 'x' }, ids));
  });

  test('formatting, comments, whitespace and line endings remain unchanged', () => {
    const doc = [
      '{',
      '  // card root',
      '  "type": "AdaptiveCard",',
      '  "body": [',
      '    { "type": "TextBlock", "id": "state", "text": "a" },',
      '    {   "type":   "TextBlock",   "id":   "state",   "text":   "b"   }',
      '  ]',
      '}',
      ''
    ].join('\r\n');
    const [, second] = occurrencesOf(doc, 'state', true);
    const plan = planDuplicateIdFix(doc, { offset: second.offset, length: second.length, expectedId: 'state' }, parseIds(doc, true));
    assert.ok(!('error' in plan));
    if (!('error' in plan)) {
      const fixed =
        doc.slice(0, second.offset) + plan.replacementText + doc.slice(second.offset + second.length);
      assert.strictEqual(fixed.slice(0, second.offset), doc.slice(0, second.offset), 'prefix untouched');
      assert.ok(fixed.includes('// card root'), 'comments survive');
      assert.ok(fixed.includes('\r\n'), 'line endings survive');
      assert.ok(fixed.includes('"id":   "state_'), 'surrounding odd spacing preserved');
      // The fix must leave exactly one occurrence of each ID behind. Assert on
      // the parser directly rather than `validate`, because this fixture keeps
      // a comment that strict validation (correctly) rejects.
      const idsAfterFix = parseQuickViewJson(fixed, { allowComments: true, allowTrailingCommas: false }).ids.map(
        (id) => id.value
      );
      assert.strictEqual(idsAfterFix.filter((id) => id === 'state').length, 1, 'the duplicate is resolved');
      assert.strictEqual(idsAfterFix.filter((id) => id.startsWith('state_')).length, 1, 'the renamed ID is unique');
    }
  });

  test('JSON escape sequences in the original ID are preserved', () => {
    const doc = [
      '{',
      '  "type": "AdaptiveCard",',
      '  "body": [',
      '    { "id": "a\\u0022b", "text": "a" },',
      '    { "id": "a\\u0022b", "text": "b" }',
      '  ]',
      '}',
      ''
    ].join('\n');
    const [, second] = occurrencesOf(doc, 'a"b');
    const plan = planDuplicateIdFix(doc, { offset: second.offset, length: second.length, expectedId: 'a"b' }, parseIds(doc), () => 'a3f91c');
    assert.ok(!('error' in plan));
    if (!('error' in plan)) {
      assert.strictEqual(plan.replacementText, 'a\\u0022b_a3f91c', 'the raw escape sequence is kept verbatim');
      assert.strictEqual(plan.value, 'a"b_a3f91c');
      const fixed = doc.slice(0, second.offset) + plan.replacementText + doc.slice(second.offset + second.length);
      assert.deepStrictEqual(
        occurrencesOf(fixed, 'a"b_a3f91c').length,
        1,
        'the edited document re-parses to the intended value'
      );
      assert.strictEqual(byCode(validate(fixed), DiagnosticCodes.duplicateId).length, 0);
    }
  });

  test('the previewed suffix from the quick-fix title is used for the first attempt', () => {
    const doc = doubleDuplicateDoc();
    const [, second] = occurrencesOf(doc, 'days');
    const plan = planDuplicateIdFix(
      doc,
      { offset: second.offset, length: second.length, expectedId: 'days' },
      parseIds(doc),
      () => 'a3f91c'
    );
    assert.ok(!('error' in plan));
    if (!('error' in plan)) {
      assert.strictEqual(plan.suffix, 'a3f91c');
      assert.strictEqual(plan.replacementText, 'days_a3f91c');
    }
  });

  test('a previewed suffix that would collide is discarded in favor of a fresh one', () => {
    const doc = JSON.stringify(
      {
        type: 'AdaptiveCard',
        body: [
          { type: 'TextBlock', id: 'days', text: 'a' },
          { type: 'TextBlock', id: 'days', text: 'b' },
          { type: 'TextBlock', id: 'days_a3f91c', text: 'already taken' }
        ]
      },
      null,
      2
    );
    const [, second] = occurrencesOf(doc, 'days');
    const plan = planDuplicateIdFix(
      doc,
      { offset: second.offset, length: second.length, expectedId: 'days' },
      parseIds(doc),
      () => 'a3f91c'
    );
    assert.ok(!('error' in plan));
    if (!('error' in plan)) {
      assert.notStrictEqual(plan.suffix, 'a3f91c', 'the colliding preview suffix is retried');
      assert.ok(/^days_[0-9a-f]{6}$/.test(plan.value));
    }
  });
});

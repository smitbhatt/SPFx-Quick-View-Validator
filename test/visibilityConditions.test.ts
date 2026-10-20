import * as assert from 'assert';
import { parseVisibilityExpression, parseVisibilityNode } from '../src/core/conditions';
import { classifyDuplicateGroup, compareVisibility } from '../src/core/exclusivity';
import { OccurrenceVisibility } from '../src/core/conditions';
import { byCode, config, DiagnosticCodes, firstWithCode, validate } from './helpers';

function card(...elements: unknown[]): string {
  return JSON.stringify({ type: 'AdaptiveCard', body: elements }, null, 2);
}

function duplicates(json: string, overrides: Parameters<typeof config>[0] = {}): ReturnType<typeof validate> {
  return byCode(validate(json, { config: config(overrides) }), DiagnosticCodes.duplicateId);
}

suite('Duplicate IDs with visibility conditions ($when / isVisible)', () => {
  // ------------------------------------------------- spec examples
  test('proven mutually exclusive conditions are not reported (spec example)', () => {
    const json = card(
      { type: 'TextBlock', id: 'daysRemaining', $when: '${dayRemaining > 1}', text: 'more than one day' },
      { type: 'TextBlock', id: 'daysRemaining', $when: '${dayRemaining <= 1}', text: 'last day' }
    );
    assert.strictEqual(duplicates(json).length, 0, 'exclusive siblings must not be reported by default');
  });

  test('overlapping conditions are reported as errors (spec example)', () => {
    const json = card(
      { type: 'TextBlock', id: 'daysRemaining', $when: '${dayRemaining > 0}', text: 'a' },
      { type: 'TextBlock', id: 'daysRemaining', $when: '${dayRemaining < 10}', text: 'b' }
    );
    const found = duplicates(json);
    assert.strictEqual(found.length, 2, 'every occurrence is reported');
    for (const d of found) {
      assert.strictEqual(d.severity, 'error');
    }
    assert.ok(found[0].message.includes('can be true at the same time'), found[0].message);
  });

  // ------------------------------------------- proven exclusive variants
  test('disjoint numeric ranges are proven exclusive and honor the severity setting', () => {
    const json = card(
      { type: 'TextBlock', id: 'count', $when: '${count > 5}', text: 'a' },
      { type: 'TextBlock', id: 'count', $when: '${count < 5}', text: 'b' }
    );
    assert.strictEqual(duplicates(json).length, 0, 'default severity is off');

    const asInfo = duplicates(json, { conditionalDuplicateSeverity: 'information' });
    assert.strictEqual(asInfo.length, 2);
    for (const d of asInfo) {
      assert.strictEqual(d.severity, 'information');
      assert.ok(d.message.includes('mutually exclusive'), d.message);
    }

    const asWarning = duplicates(json, { conditionalDuplicateSeverity: 'warning' });
    assert.ok(asWarning.every((d) => d.severity === 'warning'));
  });

  test('equality vs inequality on the same property is exclusive', () => {
    const json = card(
      { type: 'TextBlock', id: 'state', $when: '${state == 1}', text: 'a' },
      { type: 'TextBlock', id: 'state', $when: '${state != 1}', text: 'b' }
    );
    assert.strictEqual(duplicates(json).length, 0);
  });

  test('flipped comparisons are normalized before comparing', () => {
    const json = card(
      { type: 'TextBlock', id: 'dayRemaining', $when: '${1 < dayRemaining}', text: 'a' },
      { type: 'TextBlock', id: 'dayRemaining', $when: '${dayRemaining <= 1}', text: 'b' }
    );
    assert.strictEqual(duplicates(json).length, 0);
  });

  test('different string constants with equality are exclusive; inequality overlaps', () => {
    const exclusive = card(
      { type: 'TextBlock', id: 's', $when: '${status == "active"}', text: 'a' },
      { type: 'TextBlock', id: 's', $when: '${status == "inactive"}', text: 'b' }
    );
    assert.strictEqual(duplicates(exclusive).length, 0);

    const overlapping = card(
      { type: 'TextBlock', id: 's', $when: '${status == "active"}', text: 'a' },
      { type: 'TextBlock', id: 's', $when: '${status != "inactive"}', text: 'b' }
    );
    assert.strictEqual(duplicates(overlapping).length, 2);
    assert.strictEqual(duplicates(overlapping)[0].severity, 'error');
  });

  test('isVisible: true vs false is exclusive; isVisible: false vs unconditional too', () => {
    const trueFalse = card(
      { type: 'TextBlock', id: 'hint', isVisible: true, text: 'a' },
      { type: 'TextBlock', id: 'hint', isVisible: false, text: 'b' }
    );
    assert.strictEqual(duplicates(trueFalse).length, 0);

    const falseUnconditional = card(
      { type: 'TextBlock', id: 'hint', isVisible: false, text: 'a' },
      { type: 'TextBlock', id: 'hint', text: 'b' }
    );
    assert.strictEqual(duplicates(falseUnconditional).length, 0);
  });

  test('boolean-negated truthiness pairs are exclusive; distinct flags overlap', () => {
    const exclusive = card(
      { type: 'TextBlock', id: 'badge', $when: '${showBadge}', text: 'a' },
      { type: 'TextBlock', id: 'badge', $when: '${!showBadge}', text: 'b' }
    );
    assert.strictEqual(duplicates(exclusive).length, 0);

    const overlap = card(
      { type: 'TextBlock', id: 'badge', $when: '${showBadge}', text: 'a' },
      { type: 'TextBlock', id: 'badge', $when: '${otherFlag}', text: 'b' }
    );
    assert.strictEqual(duplicates(overlap).length, 2);
    assert.strictEqual(duplicates(overlap)[0].severity, 'error');
  });

  test('$when on one element and isVisible on the other are analyzed together', () => {
    const json = card(
      { type: 'TextBlock', id: 'days', $when: '${dayRemaining > 1}', text: 'a' },
      { type: 'TextBlock', id: 'days', isVisible: '${dayRemaining <= 1}', text: 'b' }
    );
    assert.strictEqual(duplicates(json).length, 0);
  });

  // ----------------------------------------------- not provable → warning
  test('conditions that cannot be analyzed statically are warnings', () => {
    const json = card(
      { type: 'TextBlock', id: 'x', $when: '${iif(showA, a, b)}', text: 'a' },
      { type: 'TextBlock', id: 'x', $when: '${dayRemaining + 1 > 2}', text: 'b' }
    );
    const found = duplicates(json);
    assert.strictEqual(found.length, 2);
    for (const d of found) {
      assert.strictEqual(d.severity, 'warning');
      assert.ok(d.message.includes('could not be proven'), d.message);
    }
  });

  test('an unconditioned element plus an unanalyzable condition is a warning', () => {
    const json = card(
      { type: 'TextBlock', id: 'x', text: 'a' },
      { type: 'TextBlock', id: 'x', $when: '${iif(a, b, c)}', text: 'b' }
    );
    const found = duplicates(json);
    assert.strictEqual(found.length, 2);
    assert.ok(found.every((d) => d.severity === 'warning'));
  });

  test('an element carrying both $when and isVisible is treated as undetermined', () => {
    const json = card(
      { type: 'TextBlock', id: 'x', $when: '${day > 1}', isVisible: '${ready}', text: 'a' },
      { type: 'TextBlock', id: 'x', $when: '${day <= 1}', text: 'b' }
    );
    const found = duplicates(json);
    assert.strictEqual(found.length, 2);
    assert.ok(found.every((d) => d.severity === 'warning'));
  });

  test('conditioned duplicates in different containers are not provable (warning)', () => {
    const json = JSON.stringify(
      {
        type: 'AdaptiveCard',
        body: [
          {
            type: 'ColumnSet',
            columns: [
              { items: [{ type: 'TextBlock', id: 'slot', $when: '${day > 1}', text: 'a' }] },
              { items: [{ type: 'TextBlock', id: 'slot', $when: '${day <= 1}', text: 'b' }] }
            ]
          }
        ]
      },
      null,
      2
    );
    const found = duplicates(json);
    assert.strictEqual(found.length, 2);
    assert.ok(found.every((d) => d.severity === 'warning'), 'cross-container siblings cannot be proven exclusive');
  });

  // -------------------------------------------- coexist stays an error
  test('an unconditioned sibling plus an analyzable condition is an error', () => {
    const json = card(
      { type: 'TextBlock', id: 'x', text: 'always' },
      { type: 'TextBlock', id: 'x', $when: '${dayRemaining > 1}', text: 'sometimes' }
    );
    const found = duplicates(json);
    assert.strictEqual(found.length, 2);
    assert.ok(found.every((d) => d.severity === 'error'));
    assert.ok(found[0].message.includes('can be true at the same time'), found[0].message);
  });

  test('comparisons over different properties overlap (independent data)', () => {
    const json = card(
      { type: 'TextBlock', id: 'x', $when: '${dayRemaining > 1}', text: 'a' },
      { type: 'TextBlock', id: 'x', $when: '${totalDays <= 3}', text: 'b' }
    );
    const found = duplicates(json);
    assert.strictEqual(found.length, 2);
    assert.ok(found.every((d) => d.severity === 'error'));
  });

  test('three occurrences: one overlapping pair poisons the whole group', () => {
    const json = card(
      { type: 'TextBlock', id: 'x', $when: '${day > 1}', text: 'a' },
      { type: 'TextBlock', id: 'x', $when: '${day <= 1}', text: 'b' },
      { type: 'TextBlock', id: 'x', text: 'always visible' }
    );
    const found = duplicates(json);
    assert.strictEqual(found.length, 3);
    assert.ok(found.every((d) => d.severity === 'error'));
  });

  // ---------------------------------------------------- legacy behavior
  test('duplicates without any conditions are still plain errors', () => {
    const json = card(
      { type: 'TextBlock', id: 'employeeName', text: 'a' },
      { type: 'TextBlock', id: 'employeeName', text: 'b' }
    );
    const found = duplicates(json);
    assert.strictEqual(found.length, 2);
    for (const d of found) {
      assert.strictEqual(d.severity, 'error');
      assert.ok(d.message.includes('Element IDs must be unique within an Adaptive Card.'), d.message);
    }
  });

  test('disabling the condition analysis restores always-error behavior', () => {
    const json = card(
      { type: 'TextBlock', id: 'daysRemaining', $when: '${dayRemaining > 1}', text: 'a' },
      { type: 'TextBlock', id: 'daysRemaining', $when: '${dayRemaining <= 1}', text: 'b' }
    );
    const found = duplicates(json, { enableVisibilityConditionAnalysis: false });
    assert.strictEqual(found.length, 2);
    assert.ok(found.every((d) => d.severity === 'error'));
  });

  test('the duplicate check toggle still switches everything off', () => {
    const json = card(
      { type: 'TextBlock', id: 'x', text: 'a' },
      { type: 'TextBlock', id: 'x', text: 'b' }
    );
    assert.strictEqual(duplicates(json, { enableDuplicateIdCheck: false }).length, 0);
  });

  // ------------------------------------------------------- diagnostics keep
  test('exact ranges, paths and navigation data survive conditional analysis', () => {
    const json = card(
      { type: 'TextBlock', id: 'daysRemaining', $when: '${dayRemaining > 1}', text: 'a' },
      { type: 'TextBlock', id: 'daysRemaining', $when: '${dayRemaining > 0}', text: 'b' }
    );
    const found = duplicates(json, { conditionalDuplicateSeverity: 'information' });
    assert.strictEqual(found.length, 2);

    const firstValueStart = json.indexOf('"daysRemaining"') + 1;
    const secondValueStart = json.indexOf('"daysRemaining"', firstValueStart + 1) + 1;
    assert.strictEqual(found[0].range.offset, firstValueStart);
    assert.strictEqual(found[0].range.length, 'daysRemaining'.length);
    assert.strictEqual(found[1].range.offset, secondValueStart);

    const diagnostic = firstWithCode(found, DiagnosticCodes.duplicateId);
    assert.ok(diagnostic.data && diagnostic.data.kind === 'duplicateId');
    if (diagnostic.data && diagnostic.data.kind === 'duplicateId') {
      assert.strictEqual(diagnostic.data.occurrences.length, 2);
      assert.strictEqual(diagnostic.data.occurrences[0].path, '$.body[0].id');
      assert.strictEqual(diagnostic.data.occurrences[1].path, '$.body[1].id');
    }
    assert.strictEqual(diagnostic.related?.length, 1);
  });
});

suite('Visibility condition parsing (unit)', () => {
  test('parses comparisons, truthiness, flips and literals', () => {
    assert.deepStrictEqual(parseVisibilityExpression('${dayRemaining > 1}'), {
      kind: 'compare',
      path: 'dayRemaining',
      operator: '>',
      constant: { type: 'number', value: 1 }
    });
    assert.deepStrictEqual(parseVisibilityExpression('${5 <= dayRemaining}'), {
      kind: 'compare',
      path: 'dayRemaining',
      operator: '>=',
      constant: { type: 'number', value: 5 }
    });
    assert.deepStrictEqual(parseVisibilityExpression('${!showBadge}'), {
      kind: 'truthy',
      path: 'showBadge',
      negated: true
    });
    assert.deepStrictEqual(parseVisibilityExpression('${ready}'), {
      kind: 'truthy',
      path: 'ready',
      negated: false
    });
    assert.deepStrictEqual(parseVisibilityExpression('true'), { kind: 'always' });
    assert.deepStrictEqual(parseVisibilityExpression('${false}'), { kind: 'never' });
  });

  test('rejects syntax that cannot be proven statically', () => {
    for (const expr of ['${a && b}', '${iif(x, 1, 2)}', '${items[0].name}', '${x + 1 > 2}', '${a | upper}', 'show ${x}']) {
      const parsed = parseVisibilityExpression(expr);
      assert.strictEqual(parsed.kind, 'unknown', `${expr} must be unknown, got ${parsed.kind}`);
    }
    assert.strictEqual(parseVisibilityExpression('').kind, 'unknown');
  });

  test('boolean value nodes map to always / never', () => {
    assert.deepStrictEqual(parseVisibilityNode({ type: 'boolean', value: true, offset: 0, length: 4 } as never), {
      kind: 'always'
    });
    assert.deepStrictEqual(parseVisibilityNode({ type: 'boolean', value: false, offset: 0, length: 5 } as never), {
      kind: 'never'
    });
    assert.strictEqual(
      parseVisibilityNode({ type: 'number', value: 1, offset: 0, length: 1 } as never).kind,
      'unknown'
    );
  });
});

suite('Exclusivity analysis (unit)', () => {
  const container = '$.body';
  const at = (condition: Parameters<typeof withCondition>[0], c = container): ReturnType<typeof withCondition> =>
    withCondition(condition, c);

  function withCondition(condition: unknown, c: string) {
    return { containerPath: c, condition } as never;
  }

  test('never beats everything; unknown beats proofs', () => {
    assert.strictEqual(
      compareVisibility(at({ kind: 'never' }), at({ kind: 'compare', path: 'x', operator: '>', constant: { type: 'number', value: 1 } })),
      'exclusive'
    );
    assert.strictEqual(
      compareVisibility(at({ kind: 'unknown', reason: 'x' }), at({ kind: 'truthy', path: 'a', negated: false })),
      'undetermined'
    );
  });

  test('group classification: overlap wins, then unproven, else exclusive', () => {
    const exclusiveA: OccurrenceVisibility = {
      containerPath: container,
      condition: { kind: 'truthy', path: 'a', negated: false }
    };
    const exclusiveB: OccurrenceVisibility = {
      containerPath: container,
      condition: { kind: 'truthy', path: 'a', negated: true }
    };
    const unknownCond: OccurrenceVisibility = { containerPath: container, condition: { kind: 'unknown', reason: 'x' } };
    const overlapOther: OccurrenceVisibility = {
      containerPath: container,
      condition: { kind: 'truthy', path: 'b', negated: false }
    };

    assert.strictEqual(classifyDuplicateGroup([exclusiveA, exclusiveB]), 'exclusive');
    assert.strictEqual(classifyDuplicateGroup([exclusiveA, exclusiveB, unknownCond]), 'unproven');
    assert.strictEqual(classifyDuplicateGroup([exclusiveA, exclusiveB, overlapOther]), 'coexist');
  });
});

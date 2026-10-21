import * as assert from 'assert';
import { collectDataReferences, parseExpression, pathText } from '../src/core/bindingResolver';

/**
 * The expression language of the Adaptive Cards templating engine, as used by
 * SPFx Adaptive Card Extension Quick Views.
 */

function references(raw: string): string[] {
  const result = parseExpression(raw);
  assert.strictEqual(result.supported, true, `expected "${raw}" to be supported`);
  if (!result.supported) {
    return [];
  }
  return collectDataReferences(result.expression).map(pathText);
}

function status(raw: string): boolean {
  return parseExpression(raw).supported;
}

suite('Templating expression parser', () => {
  test('simple and nested paths', () => {
    assert.deepStrictEqual(references('employeeName'), ['employeeName']);
    assert.deepStrictEqual(references('employee.name'), ['employee.name']);
    assert.deepStrictEqual(references('employee.address.city'), ['employee.address.city']);
    assert.deepStrictEqual(references('  employee.name  '), ['employee.name'], 'whitespace is trimmed');
  });

  test('reserved context variables are recognized', () => {
    const root = references('$root.eAuditUrl');
    assert.deepStrictEqual(root, ['$root.eAuditUrl']);
    const data = references('$data.title');
    assert.deepStrictEqual(data, ['$data.title']);
    // `$index` is a reserved number, not a data reference.
    assert.deepStrictEqual(references('$index'), []);
  });

  test('array indexing (numeric, dynamic) resolves to the collection path', () => {
    assert.deepStrictEqual(references('tasks[0].title'), ['tasks[0].title']);
    assert.deepStrictEqual(references('tasks[$index].title'), ['tasks[$index].title']);
    assert.deepStrictEqual(references("employee['name']"), ["employee['name']"]);
    assert.deepStrictEqual(references('matrix[0][1]'), ['matrix[0][1]']);
  });

  test('function call arguments are data references, the call itself is not', () => {
    assert.deepStrictEqual(references("formatDateTime(due, 'MM/dd')"), ['due']);
    assert.deepStrictEqual(references('if(score > 10, bonus, 0)'), ['score', 'bonus']);
    assert.deepStrictEqual(references('toUpper(employee.name)'), ['employee.name']);
    assert.deepStrictEqual(references("concat(street, ', ', city)"), ['street', 'city']);
  });

  test('operators, literals and conditionals keep the data references', () => {
    assert.deepStrictEqual(references('dayRemaining > 1'), ['dayRemaining']);
    assert.deepStrictEqual(references('a && b || !c'), ['a', 'b', 'c']);
    assert.deepStrictEqual(references("state === 'open' ? label : fallback"), ['state', 'label', 'fallback']);
    assert.deepStrictEqual(references('1 + 2 * 3'), [], 'pure arithmetic has no data references');
    assert.deepStrictEqual(references("'literal text'"), []);
    assert.deepStrictEqual(references('true'), []);
  });

  test('member access chained onto a call result is not a data reference', () => {
    assert.deepStrictEqual(references("json(payload).name"), ['payload']);
    assert.deepStrictEqual(references('first(items).title'), ['items']);
  });

  test('nested references inside index expressions are collected', () => {
    assert.deepStrictEqual(references('tasks[activeIndex].title'), ['tasks[activeIndex].title', 'activeIndex']);
  });

  test('unsupported syntax is reported instead of guessed at', () => {
    assert.strictEqual(status('name | upper'), false, 'filters are not part of the language');
    assert.strictEqual(status('a ~ b'), false);
    assert.strictEqual(status(''), false);
    assert.strictEqual(status('   '), false);
    assert.strictEqual(status("'unterminated"), false);
    assert.strictEqual(status('a ==== b'), false);
    assert.strictEqual(status('(a'), false);
  });
});

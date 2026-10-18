import * as assert from 'assert';
import { byCode, codes, config, DiagnosticCodes, validate } from './helpers';

suite('Duplicate ID detection', () => {
  test('1. valid JSON with unique IDs produces no diagnostics', () => {
    const json = `{
      "type": "Container",
      "items": [
        { "type": "TextBlock", "id": "employeeName", "text": "Ada" },
        { "type": "TextBlock", "id": "employeeEmail", "text": "ada@example.com" }
      ]
    }`;
    const diagnostics = validate(json);
    assert.deepStrictEqual(codes(diagnostics), []);
  });

  test('2. duplicate IDs at the same nesting level are reported on every occurrence', () => {
    const json = `{
  "type": "Container",
  "items": [
    {
      "type": "TextBlock",
      "id": "employeeName"
    },
    {
      "type": "Input.Text",
      "id": "employeeName"
    }
  ]
}`;
    const diagnostics = validate(json);
    const duplicates = byCode(diagnostics, DiagnosticCodes.duplicateId);
    assert.strictEqual(duplicates.length, 2, `expected 2 duplicate diagnostics, got: ${JSON.stringify(codes(diagnostics))}`);
    for (const duplicate of duplicates) {
      assert.strictEqual(duplicate.severity, 'error');
      assert.ok(duplicate.message.includes('"employeeName"'), 'message must include the duplicated ID');
      assert.ok(duplicate.message.includes('$.items[0].id'), 'message must include the path of the first occurrence');
      assert.ok(duplicate.message.includes('$.items[1].id'), 'message must include the path of the second occurrence');
      assert.strictEqual(duplicate.related?.length, 1, 'each occurrence links to the other one');
      assert.ok(duplicate.data && duplicate.data.kind === 'duplicateId');
      if (duplicate.data && duplicate.data.kind === 'duplicateId') {
        assert.strictEqual(duplicate.data.occurrences.length, 2);
        assert.deepStrictEqual(
          duplicate.data.occurrences.map((o) => o.path),
          ['$.items[0].id', '$.items[1].id']
        );
      }
    }
    // The underline must cover exactly the ID value, not the quotes.
    for (const duplicate of duplicates) {
      const start = duplicate.range.offset;
      const length = duplicate.range.length;
      assert.strictEqual(json.substring(start, start + length), 'employeeName');
      assert.strictEqual(json[start - 1], '"');
      assert.strictEqual(json[start + length], '"');
    }
  });

  test('3. duplicate IDs inside deeply nested containers are detected with full paths', () => {
    const json = `{
      "type": "Container",
      "id": "root",
      "items": [
        {
          "type": "Container",
          "items": [
            { "type": "Container", "items": [ { "type": "TextBlock", "id": "deepId" } ] }
          ]
        },
        { "type": "TextBlock", "id": "deepId" }
      ]
    }`;
    const diagnostics = validate(json);
    const duplicates = byCode(diagnostics, DiagnosticCodes.duplicateId);
    assert.strictEqual(duplicates.length, 2);
    const paths = duplicates[0].data && duplicates[0].data.kind === 'duplicateId'
      ? duplicates[0].data.occurrences.map((o) => o.path)
      : [];
    assert.deepStrictEqual(paths.sort(), ['$.items[0].items[0].items[0].id', '$.items[1].id'].sort());
  });

  test('4. duplicate IDs inside arrays and column sets are reported', () => {
    const json = `{
      "type": "ColumnSet",
      "columns": [
        {
          "type": "Column",
          "items": [
            { "type": "TextBlock", "id": "col1" },
            { "type": "Input.Text", "id": "col1" }
          ]
        },
        {
          "type": "Column",
          "items": [ { "type": "TextBlock", "id": "col1" } ]
        }
      ]
    }`;
    const diagnostics = validate(json);
    const duplicates = byCode(diagnostics, DiagnosticCodes.duplicateId);
    assert.strictEqual(duplicates.length, 3, 'every occurrence of the triplicated ID is reported');
    for (const duplicate of duplicates) {
      assert.strictEqual(duplicate.severity, 'error');
      assert.ok(duplicate.message.includes('It appears 3 times'));
    }
  });

  test('empty string IDs and non-string ID values are ignored', () => {
    const json = `{
      "a": { "id": "" },
      "b": { "id": "" },
      "c": { "id": 42 },
      "d": { "id": 42 }
    }`;
    const diagnostics = validate(json);
    assert.deepStrictEqual(codes(diagnostics), []);
  });

  test('IDs that differ only by case are distinct', () => {
    const json = `{
      "a": { "id": "Name" },
      "b": { "id": "name" }
    }`;
    assert.deepStrictEqual(codes(validate(json)), []);
  });

  test('the duplicate-ID check can be disabled by configuration', () => {
    const json = `{ "a": { "id": "x" }, "b": { "id": "x" } }`;
    const diagnostics = validate(json, { config: config({ enableDuplicateIdCheck: false }) });
    assert.ok(!codes(diagnostics).includes(DiagnosticCodes.duplicateId));
  });

  test('duplicate diagnostics point at the exact line and column', () => {
    const json = [
      '{',
      '  "items": [',
      '    { "id": "dup" },',
      '    { "id": "dup" }',
      '  ]',
      '}'
    ].join('\n');
    const duplicates = byCode(validate(json), DiagnosticCodes.duplicateId);
    assert.strictEqual(duplicates.length, 2);
    const occurrences = duplicates[0].data && duplicates[0].data.kind === 'duplicateId' ? duplicates[0].data.occurrences : [];
    assert.deepStrictEqual(
      occurrences.map((o) => `${o.line}:${o.column}`),
      ['3:14', '4:14']
    );
  });
});

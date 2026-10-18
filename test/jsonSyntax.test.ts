import * as assert from 'assert';
import { byCode, codes, config, DiagnosticCodes, validate } from './helpers';

suite('JSON syntax validation', () => {
  test('5. invalid JSON syntax is reported with an accurate location', () => {
    const json = `{
  "type": "AdaptiveCard",
  "body": [
    { "type": "TextBlock", "text": "missing comma" }
    { "type": "TextBlock" }
  ]
}`;
    const diagnostics = validate(json);
    const syntax = byCode(diagnostics, DiagnosticCodes.jsonSyntax);
    assert.ok(syntax.length >= 1, `expected a syntax error, got: [${codes(diagnostics).join(', ')}]`);
    assert.strictEqual(syntax[0].severity, 'error');
    assert.ok(syntax[0].range.offset > 0, 'the error must point inside the document');
  });

  test('duplicate-ID and consistency checks do not run on malformed JSON', () => {
    const json = `{
  "a": { "id": "dup",
  "b": { "id": "dup"
}`;
    const diagnostics = validate(json);
    assert.ok(byCode(diagnostics, DiagnosticCodes.jsonSyntax).length >= 1);
    assert.ok(!codes(diagnostics).includes(DiagnosticCodes.duplicateId), 'no duplicate checks on broken JSON');
    assert.ok(!codes(diagnostics).includes(DiagnosticCodes.missingDataBinding));
    assert.ok(!codes(diagnostics).includes(DiagnosticCodes.missingIdProperty));
  });

  test('truncated documents are reported', () => {
    const json = `{ "type": "AdaptiveCard", "body": [`;
    const diagnostics = validate(json);
    assert.ok(byCode(diagnostics, DiagnosticCodes.jsonSyntax).length >= 1);
  });

  test('JSON comments are rejected by default and accepted when enabled', () => {
    const json = `{
  // a comment
  "type": "AdaptiveCard"
}`;
    const strict = validate(json);
    assert.ok(byCode(strict, DiagnosticCodes.jsonSyntax).length >= 1, 'comments rejected in strict mode');

    const relaxed = validate(json, { config: config({ allowJsonComments: true }) });
    assert.ok(!codes(relaxed).includes(DiagnosticCodes.jsonSyntax), 'comments allowed when configured');
  });

  test('trailing commas are rejected by default and accepted when enabled', () => {
    const json = `{
  "type": "AdaptiveCard",
}`;
    const strict = validate(json);
    assert.ok(byCode(strict, DiagnosticCodes.jsonSyntax).length >= 1, 'trailing commas rejected in strict mode');

    const relaxed = validate(json, { config: config({ allowTrailingCommas: true }) });
    assert.ok(!codes(relaxed).includes(DiagnosticCodes.jsonSyntax), 'trailing commas allowed when configured');
  });
});

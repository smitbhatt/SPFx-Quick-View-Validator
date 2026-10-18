import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Guards the VS Code wiring itself: the compiled entry point must export
 * activate()/deactivate(), the commands contributed in package.json must all
 * be registered by the compiled code, and activation events must cover them.
 * (A missing activate() export silently no-ops activation in VS Code — this
 * suite exists because that exact bug shipped once.)
 */
suite('Extension entry point (VS Code wiring)', () => {
  const root = path.join(__dirname, '..', '..');
  const compiledMain = fs.readFileSync(path.join(root, 'out', 'src', 'extension.js'), 'utf8');
  const compiledCommandIds = fs.readFileSync(path.join(root, 'out', 'src', 'vscodeFeatures', 'commandIds.js'), 'utf8');
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as {
    main: string;
    activationEvents: string[];
    contributes: { commands: Array<{ command: string }> };
  };

  test('the compiled extension exports activate() and deactivate()', () => {
    assert.ok(
      /exports\.activate\s*=/.test(compiledMain),
      'out/src/extension.js must export activate() — without it VS Code activation is a silent no-op'
    );
    assert.ok(/exports\.deactivate\s*=/.test(compiledMain), 'out/src/extension.js must export deactivate()');
  });

  test('main entry points at the compiled extension file', () => {
    assert.strictEqual(manifest.main, './out/src/extension.js');
    assert.ok(fs.existsSync(path.join(root, 'out', 'src', 'extension.js')), 'compiled entry file must exist');
  });

  test('activate() registers exactly the commands contributed in package.json', () => {
    const contributed = manifest.contributes.commands.map((c) => c.command).sort();
    const registrationCalls = (compiledMain.match(/registerCommand\(/g) ?? []).length;
    assert.strictEqual(
      registrationCalls,
      contributed.length,
      `expected ${contributed.length} registerCommand calls in compiled extension.js, found ${registrationCalls}`
    );
    for (const id of contributed) {
      assert.ok(
        compiledCommandIds.includes(`'${id}'`) || compiledMain.includes(`'${id}'`),
        `command "${id}" must be defined in CommandIds`
      );
    }
  });

  test('every onCommand activation event matches a contributed command (and vice versa)', () => {
    const contributed = manifest.contributes.commands.map((c) => c.command);
    const onCommands = manifest.activationEvents
      .filter((event) => event.startsWith('onCommand:'))
      .map((event) => event.slice('onCommand:'.length));
    assert.ok(onCommands.length > 0, 'explicit onCommand activation events are required');
    for (const id of onCommands) {
      assert.ok(contributed.includes(id), `activation event references unknown command "${id}"`);
    }
    for (const id of contributed) {
      assert.ok(onCommands.includes(id), `missing onCommand activation event for "${id}"`);
    }
  });
});

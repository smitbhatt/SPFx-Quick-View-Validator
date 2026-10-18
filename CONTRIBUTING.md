# Contributing to SPFx Quick View Validator

**Author: Smit P. Bhatt**

Development documentation lives here so the extension's detail page
(README) stays focused on end users.

Repository: https://github.com/smitbhatt/SPFx-Quick-View-Validator

## Development setup

```bash
npm install
npm run build     # compile TypeScript to out/
npm test          # build + run the full mocha test suite
npm run check     # type check only
npm run package   # produce the .vsix (uses @vscode/vsce)
```

`npm run check` (type check, no emit) plus `npm test` (build + mocha) should
both pass before committing.

## Run in an Extension Development Host

1. Open this folder in VS Code.
2. Press **F5** (launch configuration *Run Extension*).
3. In the new window, open an SPFx project and a `quickview.json`.

## Tests

- Plain **mocha** tests in `test/` (TDD UI, 75 scenarios) run in Node —
  no `@vscode/test-electron` needed, because `src/core/` and `src/analyzer/`
  never import `vscode`. The whole pipeline, including unsaved-content
  handling, is covered by these tests.
- `test/entryPoint.test.ts` additionally guards the VS Code wiring itself:
  it inspects the **compiled** `out/src/extension.js` and `package.json`
  after every build and asserts that `activate()`/`deactivate()` are
  exported, that `registerCommand` calls match the contributed commands
  one-for-one, and that every command has an `onCommand:` activation event.
  (This suite exists because a missing `activate()` export once shipped as a
  silent no-op.)
- `test/fixtures/` contains realistic SPFx Quick View fixtures (including
  intentionally broken ones) and is excluded from `tsconfig.json`.

## Architecture

```
src/
  extension.ts                 activation, commands, events, caching, debounce
  config.ts                    VS Code settings → typed configuration
  analyzer/analyzer.ts         TypeScript compiler API analysis (data getter,
                               declared properties, nested type resolution)
  core/
    types.ts                   VS Code-independent models
    positions.ts               offset ↔ line/column helpers
    jsonDocument.ts            jsonc-parser walk: IDs + ${...} extraction
    bindings.ts                expression extraction and parsing
    duplicateIds.ts            duplicate grouping
    association.ts             quickview.json → quickView.ts resolution
    validate.ts                the pure validation pipeline
  vscodeFeatures/
    diagnostics.ts             core diagnostics → vscode.Diagnostic
    codeActions.ts             quick fixes (navigation only, never mutations)
    commandIds.ts              command identifiers
test/                          mocha unit/integration tests + SPFx fixtures
```

The `core/` and `analyzer/` modules never import `vscode`, which is why the
whole pipeline — including unsaved-content handling — is covered by plain
mocha tests running in Node.

## Packaging and releasing

1. Bump `version` in `package.json` and add a `CHANGELOG.md` entry.
2. `npm run check && npm test`
3. `npx vsce package` → produces `spfx-quick-view-validator-<version>.vsix`
   (`--allow-missing-repository` is no longer needed; the repository field is
   declared in `package.json`).
4. Install locally to verify: `code --install-extension <file>.vsix --force`.
5. Commit, push, then publish:

   ```bash
   gh release create vX.Y.Z spfx-quick-view-validator-X.Y.Z.vsix \
     --title "SPFx Quick View Validator vX.Y.Z" --notes "..."
   ```

`.vscodeignore` controls what ships inside the `.vsix` (dev files,
`CONTRIBUTING.md` and the full-resolution `images/logo.png` are excluded).

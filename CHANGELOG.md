# Changelog

## 1.1.3

- Added author metadata: **Smit P. Bhatt** (package manifest, LICENSE
  copyright line, README author section).

## 1.1.2

- **Fix:** the extension module did not export `activate()`/`deactivate()`,
  so VS Code loaded the extension as a silent no-op and none of the commands
  were ever registered ("command not found"). The entry points are now
  exported, and a new `entryPoint.test.ts` suite guards the compiled entry
  point, command registration count and activation-event wiring so this
  cannot regress.

## 1.1.1

- Explicit `onCommand:` activation events for every command, so invoking a
  command always activates the extension before it is dispatched (previously
  relied on auto-generated activation events, which could surface a
  "command not found" error when a window had not been reloaded after
  installing the extension).

## 1.1.0

- New command **Select Quick View Files (JSON and TypeScript)**: an explicit
  two-step wizard that pins the chosen JSON + TypeScript pair per workspace,
  works with any file names, opens the JSON and validates it immediately.
- New setting `spfxQuickViewValidator.requireManualSelection` to make manual
  selection mandatory before any validation runs.
- Pinned JSON files bypass the `jsonFilePatterns` name matching.
- Pinned files are automatically unpinned when they are deleted or renamed.

## 1.0.0

- Initial release.
- Real-time duplicate Adaptive Card element ID detection in `quickview.json`.
- Strict JSON syntax validation (configurable comments / trailing commas).
- Data-binding (`${...}`) validation against the `data` getter of the associated
  Quick View TypeScript file, including nested member resolution through
  declared TypeScript types.
- Configurable element-ID ↔ TypeScript property convention rule.
- Deterministic association of `quickview.json` with `quickView.ts` /
  `QuickView.ts`, with an explicit manual-selection command.
- Commands: validate, select associated TypeScript file, show validation summary.
- Quick fixes: navigate to conflicting ID occurrences, open the associated
  TypeScript file at the `data` getter.

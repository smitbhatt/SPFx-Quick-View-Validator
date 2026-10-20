# Changelog

## 1.1.7

- **Condition-aware duplicate-ID detection:** duplicates are now analyzed
  against the elements' `$when` / `isVisible` visibility conditions. Sibling
  elements whose conditions are proven mutually exclusive (e.g.
  `${dayRemaining > 1}` vs `${dayRemaining <= 1}`, `${flag}` vs `${!flag}`,
  `isVisible: true` vs `false`, `==` vs `!=`) are not reported by default —
  only one of them can render at runtime. Duplicates whose conditions can
  overlap (e.g. `${count > 0}` vs `${count < 10}`) stay errors, and
  conditions whose mutual exclusivity cannot be proven statically are
  reported as warnings.
- New setting `spfxQuickViewValidator.conditionalDuplicateSeverity`
  (`off` | `warning` | `information`, default `off`) controls what — if
  anything — is reported for proven mutually exclusive duplicates.
- New setting `spfxQuickViewValidator.enableVisibilityConditionAnalysis`
  (default `true`) restores the previous always-error behavior when disabled.

## 1.1.6

- **Changed defaults:** `enableDataBindingCheck` and `enableIdPropertyCheck`
  now default to `false` — both checks are opt-in via settings. Duplicate-ID
  detection and JSON syntax validation stay enabled by default. The README
  settings table, element-ID rule section and troubleshooting list are
  synced with the new defaults.

## 1.1.5

- Streamlined the extension detail page: development setup, Extension
  Development Host instructions and the code architecture section moved out
  of the README into `CONTRIBUTING.md` (repo only), so the detail page shows
  user-facing documentation exclusively.
- Fixed the stale `.vsix` file name in the installation instructions and
  linked them to the GitHub releases page.

## 1.1.4

- Added the project logo: shown as the extension icon in the Extensions view
  and marketplace page (`images/icon.png`, 256x256), in the README header,
  and as the GitHub repository social preview (`images/logo.png`, full
  resolution).

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

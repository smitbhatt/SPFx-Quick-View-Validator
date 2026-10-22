# Changelog

## 1.2.4

- **Removed the element ID ↔ TypeScript property check.** The
  `spfxQuickViewValidator.enableIdPropertyCheck` setting (and its
  `idPropertySeverity` companion, the `missingIdProperty` diagnostic code and the
  `declaredPropertyNames` analysis) are gone. The rule enforced a project-specific
  convention — that every element `id` in the template maps to a property declared
  in the Quick View TypeScript file — which is not an Adaptive Card requirement and
  produced warnings unrelated to whether the card actually works. Validation now
  covers JSON syntax, duplicate IDs and data bindings. If you had
  `spfxQuickViewValidator.enableIdPropertyCheck` in your settings, VS Code will flag
  it as an unknown setting; delete the line.

## 1.2.3

- **The Settings UI now spells out the default file-name patterns.** The
  `spfxQuickViewValidator.jsonFilePatterns` description previously said the
  default "covers … `<Something>Template.json` name" in prose, but the VS Code
  Settings page only renders that description text — it does not display the
  array's default value for an unset array setting, so `*Template.json` support
  was invisible. The description now states the literal default
  `["quickview*.json", "*Template.json"]` and says explicitly that any file
  ending in `Template.json` is matched.
- **`Show Validation Summary` now reports the effective configuration.** A new
  `Configuration:` block lists the `jsonFilePatterns` actually in use, whether
  the open file **matched** them (or whether `requireManualSelection` is
  bypassing pattern matching), and the on/off state of the duplicate-ID, data
  binding and ID/property checks. This makes "is my file validated, and why
  not?" answerable without guessing.
- A test now asserts every contributed setting exposes non-empty UI text, so a
  missing or stale description like this is caught before release.

## 1.2.2

- **The data-binding check is now on by default.** `spfxQuickViewValidator.enableDataBindingCheck`
  defaulted to `false`, so `${...}` expression validation against the paired
  `quickView.ts` `data` getter produced nothing until it was enabled manually.
  It now defaults to `true`: open a Quick View template with an associated
  TypeScript file and binding diagnostics appear immediately. Set it to `false`
  to opt out. `spfxQuickViewValidator.enableIdPropertyCheck` stays **off**
  (it is a project-specific convention, not a universal Adaptive Card
  requirement).

## 1.2.1

- **`*Template.json` files are now validated by default.** Projects that name
  every Quick View template `<Something>Template.json` (e.g.
  `RiseCardTemplate.json`) were previously only picked up if
  `spfxQuickViewValidator.jsonFilePatterns` was customized, because the default
  was `quickview*.json`. The default is now
  `["quickview*.json", "*Template.json"]`, so the standard
  `QuickViewTemplate.json` **and** custom `…Template.json` names work out of
  the box. Unrelated JSON files (e.g. `package.json`, `AdaptiveCard.json`)
  remain out of scope.

## 1.2.0

- **Complete, context-aware Adaptive Card templating validation.** Data
  bindings are now resolved with a real parser for the Adaptive Cards
  templating expression language instead of a plain dotted-path check, so far
  more of a real Quick View template is validated — while remaining
  conservative about anything that cannot be proven.
  - **`$root` references** (`${$root.eAuditUrl}`, `${$root.employee.department.name}`)
    resolve against the root `data` object. They are no longer mistaken for a
    data property named `$root`.
  - **`$data` iteration scopes:** properties inside an element with
    `"$data": "${tasks}"` are validated against the *array element type*, and
    the scope chain reaches enclosing iterations and the root. Nested
    repetitions stack correctly, and `$root` inside a repetition still refers
    to the root data.
  - **`$index` and array indexing:** `${tasks[0].title}`,
    `${tasks[$index].title}` and `${employee['name']}` are validated against
    the element type, including nested arrays and tuples.
  - **Function calls:** arguments are validated as data references
    (`${formatDateTime(awaitingStepDueDate, 'MM/dd')}` checks
    `awaitingStepDueDate`), while the function name, string literals and
    numeric constants are left alone.
  - **Operators, comparisons and conditionals** (`${a && b}`, `${x > 1 ? a : b}`)
    are parsed, not grepped, so only real data references are checked.
- **Precise diagnostics:** a missing property now underlines just the failing
  segment (`manager` in `${employee.manager.email}`) instead of the whole
  `${...}` expression, and the message names the parent object it was searched
  on. Root-level misses name the root data context; misses inside a repetition
  name the iteration item and the root.
- **Better type resolution:** the `data` shape is derived with the TypeScript
  checker as an object/array/union tree, including index signatures
  (`{ [key: string]: T }` accepts arbitrary keys), optional properties and
  unions. The root shape merges the annotated `data` return type with the
  return literals, so a property that renders at runtime is never reported.
- **Fewer false positives:** values typed `any`/`unknown` (API responses,
  computed objects, dynamic payloads) are classified as *unverifiable* and
  skipped rather than reported as missing.
- Unsupported syntax (filters such as `${name | upper}`) is still skipped
  silently instead of being guessed at.

## 1.1.9

- **New quick fix: "Fix duplicate ID".** Every duplicate-ID diagnostic on a
  non-first occurrence now offers a one-click fix that replaces that
  occurrence with a freshly generated unique ID:
  - A cryptographically secure six-character hex suffix is inserted before
    the first `${...}` marker (`text_${$index}` → `text_a3f91c_${$index}`),
    preserving every dynamic expression byte-for-byte, or appended for IDs
    without expressions (`employee_name` → `employee_name_a3f91c`).
  - The first occurrence always keeps the original ID; later occurrences are
    fixed individually and each fix generates a distinct ID (checked against
    all IDs in the document, previous fixes included).
  - Only the ID string value is spliced — formatting, comments, whitespace,
    escape sequences and line endings are untouched. The edit re-parses the
    current document first, so stale diagnostics can never corrupt the file,
    and validation reruns immediately after the fix.
  - Available from the editor lightbulb, `Ctrl+.` and the Problems panel's
    **Quick Fix...** menu; the action title previews the generated ID.

## 1.1.8

- **Numeric condition comparisons are solved over integers by default:**
  sibling elements guarded by `${dayRemaining > 1}` and `${dayRemaining < 2}`
  (adjacent integer bounds — the classic days-remaining pattern) are now
  proven mutually exclusive and not reported, since no integer lies strictly
  between 1 and 2. Previously the real-number model found the overlap
  (1, 2) and reported an error.
- New setting `spfxQuickViewValidator.numericConditionDomain`
  (`integer` | `continuous`, default `integer`): set `continuous` when a
  numeric property can be fractional — adjacent-bound pairs then overlap on
  the real interval again and are reported as errors.

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

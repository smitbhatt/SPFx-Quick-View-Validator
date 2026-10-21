# SPFx Quick View Validator

<img src="images/icon.png" alt="SPFx Quick View Validator logo" width="128" height="128" />

A VS Code extension that validates **SharePoint Framework (SPFx) Adaptive Card
Extension Quick View** files in real time — before SharePoint fails to render
them.

It watches the currently active `quickview.json` (or `QuickViewTemplate.json`),
finds the associated Quick View TypeScript implementation
(`quickView.ts` / `QuickView.ts`), and reports:

| Check | Default severity | Code |
| --- | --- | --- |
| Duplicate Adaptive Card element IDs (`"id"` at any nesting depth) | Error (Warning when visibility conditions can't be proven exclusive) | `duplicateId` |
| Malformed JSON | Error | `jsonSyntax` |
| Data bindings `${...}` not provided by the `data` getter | Error | `missingDataBinding` |
| Element IDs without a matching TypeScript property (project convention) | Warning (configurable) | `missingIdProperty` |
| Missing / ambiguous / unreadable associated TypeScript file | Warning | `missingTypeScript` |
| `data` getter missing in the TypeScript file | Warning | `noDataGetter` |
| `data` shape not statically resolvable (e.g. returns `any`) | Warning | `unresolvedDataShape` |

Diagnostics appear inline, in the editor gutter, and in the **Problems** panel.
Everything is scoped to the Quick View file you are editing — no workspace-wide
scanning, and unrelated JSON files are never touched.

---

## What it does

### 1. Duplicate element ID detection (with visibility-condition awareness)

Every property named `id` with a non-empty string value is collected,
recursively, across all objects and arrays. Each occurrence of a duplicated ID
gets its own diagnostic, underlining exactly the ID value, listing the JSON
paths and line/column positions of **all** conflicting occurrences:

```
Duplicate element ID "employeeName". It appears 2 times in this document at:
$.body[0].id (6:12), $.body[1].id (7:13). This occurrence conflicts with:
$.body[1].id (7:13). Element IDs must be unique within an Adaptive Card.
```

IDs are **never** renamed or modified automatically.

Before reporting, the extension analyzes the `$when` / `isVisible` visibility
conditions of the duplicated elements. Sibling elements whose conditions are
**proven mutually exclusive** cannot both render at runtime, so their shared
ID is effectively unique:

```json
{ "type": "TextBlock", "id": "daysRemaining", "$when": "${dayRemaining > 1}",  "text": "More than a day left" }
{ "type": "TextBlock", "id": "daysRemaining", "$when": "${dayRemaining <= 1}", "text": "Last day" }
```

This pair is recognized as exclusive and **not reported** by default (change
the severity with `spfxQuickViewValidator.conditionalDuplicateSeverity`).

The severity model for duplicates:

| Situation | Severity |
| --- | --- |
| No conditions, or conditions that can both be true (e.g. `${count > 0}` vs `${count < 10}`) | **Error** |
| Conditions exist but mutual exclusivity cannot be proven (function calls, `&&`/`\|\|`, different containers, ...) | **Warning** |
| Mutual exclusivity proven (opposite bounds, `==` vs `!=`, `${flag}` vs `${!flag}`, `isVisible: true` vs `false`, ...) | Per `conditionalDuplicateSeverity` (`off` by default) |

Analyzed condition shapes: boolean `true`/`false`, truthiness (`${flag}`,
`${!flag}`) and single comparisons of a property against a constant
(`>`, `>=`, `<`, `<=`, `==`, `!=`, including flipped forms like `${1 < dayRemaining}`
and quoted string or boolean constants). Numeric comparisons are solved over
**integers** by default — `${count > 1}` vs `${count < 2}` is proven
exclusive because no integer lies strictly between 1 and 2, which matches
typical day/item counters (see
`spfxQuickViewValidator.numericConditionDomain` for fractional data).
`$when` and `isVisible` are analyzed together, and `$when`-guarded elements
are compared with `isVisible`-guarded ones. Anything beyond that is never
guessed at — it degrades to a warning.

### 2. JSON syntax validation

`quickview.json` is parsed with [`jsonc-parser`](https://www.npmjs.com/package/jsonc-parser)
for accurate source offsets. Strict JSON is the default; comments and trailing
commas can be allowed per project (see settings). Duplicate-ID and
consistency checks are skipped on malformed JSON so you only see the real
problem first.

### 3. Data binding validation

Adaptive Card templating expressions are extracted from **any** string value
(`TextBlock.text`, `ariaLabel`, a `Fact.value`, an action `url`, an element's
`$when` / `isVisible`, ...) and validated against the shape exposed by the
`data` getter of the associated TypeScript file.

**How data flows from `quickView.ts` to the template**

```
quickView.ts  get data(): IQuickViewData { return { ... } }
                     │  (TypeScript type checker)
                     ▼
              DataShape  (object / array / union tree)
                     │
quickview.json  "${employee.department.name}"  ──►  resolver  ──►  diagnostic
```

The binding check is **off by default**; enable it with
`spfxQuickViewValidator.enableDataBindingCheck` (it needs an associated
TypeScript file — see *File association*).

#### Supported expression syntax

Everything the Adaptive Cards templating engine evaluates is parsed:

| Template | Validated against |
| --- | --- |
| `${employeeName}` | root data property |
| `${employee.department.name}` | nested object path, segment by segment |
| `${$root.eAuditUrl}` | the root `data` object — *not* a property named `$root` |
| `${tasks[0].title}` | the element type of the `tasks` array |
| `${tasks[$index].title}` | the element type; `$index` is a reserved variable |
| `${employee['name']}` | string-literal member access |
| `${formatDateTime(awaitingStepDueDate, 'MM/dd')}` | every argument is a data reference; the function name and `'MM/dd'` are not |
| `${x > 1 ? 'late' : 'ok'}` | `x` (operators and literals are not data) |
| `${a && b \|\| !c}` | `a`, `b`, `c` |
| `"${employeeName} — ${employeeEmail}"` | each expression independently |

#### Iteration, `$data` and `$root`

An element that carries `"$data": "${tasks}"` repeats once per item. Bindings
**inside** that element are resolved against the array element type first, and
the lookup walks the scope chain outwards to enclosing iterations and finally
to the root data object:

```jsonc
{
  "type": "Container",
  "$data": "${tasks}",                    // read at the enclosing scope
  "items": [
    { "text": "${title}" },               // the task item
    { "text": "${$data.completed}" },     // same thing, explicit
    { "text": "${employeeName}" },        // found on the root via the chain
    { "text": "${$root.eAuditUrl}" }      // always the root data object
  ]
}
```

Nested repetitions stack: inside `"$data": "${subtasks}"` the current item is
the subtask, the enclosing item is the task, and `$root` is still the root.
`${$index}` is recognized as a reserved number, never a data property.

#### How missing properties are reported

Each diagnostic underlines **only the failing segment** and names the object it
was searched on:

```
Property 'department' does not exist on 'employee.address'.
Property 'eAuditUrl' does not exist in the root Quick View data.
Property 'teammateName' does not exist in the current iteration item or the root Quick View data.
```

Function arguments, comparison operands, conditional branches and array
indexes are validated too, so `${formatDateTime(awaitingStepDueDate, 'MM/dd')}`
reports `awaitingStepDueDate` when the iteration item has no such property.

#### TypeScript type resolution

Nested members are resolved through the **declared return type** of the `data`
getter (`IQuickViewData`) *and* its return literals, so `${employee.name}` is
validated against `IQuickViewData['employee']` and is never mistaken for a
top-level data property. Interfaces, type aliases, inheritance, imported types,
array/tuple element types, optional properties, unions and string index
signatures are all understood — see section 4.

Anything that cannot be established reliably (an `any`/`unknown` value such as
an HTTP response, a computed object, a property reached through an unresolved
type) is classified as **unverifiable** and produces **no** diagnostic, so a
binding that may be perfectly correct at runtime is never reported.

### 4. `data` getter analysis (TypeScript compiler API)

The extension builds a TypeScript program for the associated file (using
unsaved editor content when available) and understands:

```typescript
// Annotated getter (fully validated, errors on missing bindings)
public get data(): IQuickViewData {
  return {
    employeeName: this.properties.employeeName,
    employeeEmail: this.properties.employeeEmail
  };
}

// Non-annotated getter (property names still collected syntactically)
public get data() {
  return { employeeName: this.properties.employeeName };
}
```

- Getters returning a **variable** (`return this._viewData;`) are resolved
  through the type checker.
- Getters with **multiple return paths** are unioned.
- **Imported interfaces**, type aliases, `extends` chains and inherited
  members resolve when the imports are resolvable.
- The result is modelled as a **shape tree** — objects with nested property
  types, arrays with their element type, unions, and string index signatures
  (`{ [key: string]: T }` accepts arbitrary keys).
- **Spreads / computed properties / untyped (`any`) values** make the result
  *partial* or *unresolvable* — in those cases missing bindings are downgraded
  to warnings or skipped entirely instead of reported as errors. Members
  contributed by a spread are still resolved through the checker when its type
  is known.
- The root shape **merges the declared return type with the returned
  literals**, so a property that exists at runtime is never reported as
  missing just because it is absent from the interface.

### 5. Element ID ↔ TypeScript property rule (project convention)

Some teams declare one property per element ID so IDs stay in sync with the
view model. This rule checks every JSON `id` against properties declared in
top-level **interfaces, type aliases and classes** (including resolvable
imported and inherited ones) of the associated TypeScript file. Function
parameters and local variables are never counted. The rule is **disabled by
default** (`spfxQuickViewValidator.enableIdPropertyCheck`); when enabled it
reports *warnings* and can be turned off per project — it is a convention,
not an Adaptive Card requirement.

### 6. File association

Starting from the active Quick View JSON, the associated TypeScript file is
resolved deterministically:

1. A manually selected association (via **Select Quick View Files** wizard or
   **Select Associated TypeScript File**) always wins, and manually selected
   JSON files are always validated regardless of their names.
2. `<same folder>/*quickview.ts` — an exact `QuickView.ts` / `quickView.ts`
   wins; a single `EmployeeQuickView.ts`-style match resolves; multiple
   matches are **ambiguous** and reported instead of silently chosen.
3. A sibling `quickView/` folder (e.g. JSON in `assets/`, TS in `quickView/`).
4. The parent folder.

If the file cannot be determined you get a single warning and the
**Select Associated TypeScript File** command to fix it. Associations are
cached per JSON file, invalidated when TypeScript files are created/deleted/
renamed or settings change, and re-checked when the TS editor is closed
without saving.

JSON files are considered Quick View templates when their name matches one of
the configured `spfxQuickViewValidator.jsonFilePatterns` (default
`["quickview*.json", "*Template.json"]`, case-insensitive). That covers
`quickview.json`, `QuickView.json`, the standard `QuickViewTemplate.json` and
any project using the `<Something>Template.json` naming convention (e.g.
`RiseCardTemplate.json`). If your project uses a different file name, add it to
the setting — e.g. `["quickview*.json", "*Template.json", "RiseCard.json"]`.

---

## Installation

Download `spfx-quick-view-validator-1.2.1.vsix` from the
[latest release](https://github.com/smitbhatt/SPFx-Quick-View-Validator/releases/latest),
then either double-click it, or:

```powershell
code --install-extension spfx-quick-view-validator-1.2.1.vsix
```

Or in VS Code: **Extensions** view → `...` menu → **Install from VSIX...**.

---

## Commands

| Command | Description |
| --- | --- |
| `SPFx Quick View Validator: Select Quick View Files (JSON and TypeScript)` | Two-step wizard: pick the Quick View JSON file, then its `quickView.ts`. The pair is remembered per workspace, the JSON is opened and validated immediately. Works with any file names. |
| `SPFx Quick View Validator: Validate Current Quick View` | Validates the active Quick View JSON immediately and shows the result. |
| `SPFx Quick View Validator: Select Associated TypeScript File` | Picks the `quickView.ts` for the *already active* JSON (stored per workspace). |
| `SPFx Quick View Validator: Show Validation Summary` | Error/warning counts, association status, resolved data properties — in the output channel and as a notification. |

### Explicit "select first" workflow

If you prefer to tell the extension exactly which files belong together
instead of relying on file-name conventions:

1. Run **SPFx Quick View Validator: Select Quick View Files (JSON and TypeScript)**.
2. Pick your Quick View JSON file in the file dialog (any name works).
3. Pick the associated TypeScript file — suggested candidates from the usual
   SPFx folder layout are pre-listed, or browse to any `.ts` file.
4. The pair is pinned for the workspace: the JSON is validated against exactly
   that TypeScript file, and the JSON is recognized even if its name does not
   match `jsonFilePatterns`.

To make selection *mandatory* (no automatic validation for files you have not
picked), enable:

```json
"spfxQuickViewValidator.requireManualSelection": true
```

Pinned files stay valid until you rename or delete them; re-run the wizard to
change the pairing.

Quick fixes (light bulb) on diagnostics:

- **Fix duplicate ID** — replace a later duplicate occurrence with a freshly
  generated unique ID (details below).
- **Go to conflicting ID occurrences** — jump between duplicated IDs.
- **Open `<quickView.ts>` (data getter)** — open the TS file at the getter.

### Fix duplicate ID (quick fix)

Put the cursor on a duplicate-ID diagnostic and choose **Fix duplicate ID**
from the lightbulb menu (`Ctrl+.`), or from **Quick Fix...** in the Problems
panel. Before:

```json
{ "type": "TextBlock", "id": "employee_name",   "text": "${teammateName}" },
{ "type": "TextBlock", "id": "employee_name",   "text": "${stepAwaitingAction}" },
{ "type": "TextBlock", "id": "employee_${$index}", "text": "row" }
```

Fixing the second occurrence:

```json
{ "type": "TextBlock", "id": "employee_name",       "text": "${teammateName}" },
{ "type": "TextBlock", "id": "employee_name_a3f91c", "text": "${stepAwaitingAction}" },
{ "type": "TextBlock", "id": "employee_${$index}",   "text": "row" }
```

- A short six-character hex suffix is generated with a cryptographically
  secure RNG. IDs containing `${...}` expressions keep them byte-for-byte:
  the suffix is inserted immediately before the **first** `${` marker
  (`text_..._dueToday_${$index}` → `text_..._dueToday_a3f91c_${$index}`,
  `${employeeId}_label` → `a3f91c_${employeeId}_label`). IDs without
  expressions get the suffix appended (`employee_name` → `employee_name_a3f91c`).
- The **first** occurrence always keeps the original ID; every later
  occurrence offers its own fix, each generating a distinct ID (candidates
  are checked against every ID in the document, previous fixes included).
  Fixing one occurrence never renames the others.
- Only the ID string value is edited — indentation, comments, whitespace,
  property order, escape sequences and line endings are untouched.
  Diagnostics refresh immediately after the edit; a fix is refused (with an
  explanation) if the document changed since the diagnostic was reported.

Note: renaming an ID does **not** update references elsewhere in the project.
If other files, code or the element-ID ↔ TypeScript property convention refer
to the old ID, update those separately.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `spfxQuickViewValidator.enableDuplicateIdCheck` | `true` | Report duplicate element IDs. |
| `spfxQuickViewValidator.enableVisibilityConditionAnalysis` | `true` | Analyze `$when` / `isVisible` conditions for duplicate IDs: proven mutually exclusive siblings are reported per `conditionalDuplicateSeverity`, unprovable conditions become warnings, overlapping conditions stay errors. Disable to report every duplicate as an error. |
| `spfxQuickViewValidator.conditionalDuplicateSeverity` | `off` | Severity for duplicates proven mutually exclusive by their visibility conditions: `off` (not reported), `warning` or `information`. |
| `spfxQuickViewValidator.numericConditionDomain` | `integer` | Domain for numeric condition comparisons. `integer` proves `${x > 1}` vs `${x < 2}` exclusive (adjacent integer bounds); set `continuous` when a numeric property can be fractional. |
| `spfxQuickViewValidator.enableDataBindingCheck` | `false` | Validate `${...}` bindings against the data getter. |
| `spfxQuickViewValidator.enableIdPropertyCheck` | `false` | Check element IDs against TypeScript property declarations. |
| `spfxQuickViewValidator.idPropertySeverity` | `warning` | `error`, `warning` or `information`. |
| `spfxQuickViewValidator.validationDebounceMs` | `250` | Debounce while typing (0–5000 ms). |
| `spfxQuickViewValidator.allowJsonComments` | `false` | Permit `//` and `/* */` in `quickview.json`. |
| `spfxQuickViewValidator.allowTrailingCommas` | `false` | Permit trailing commas. |
| `spfxQuickViewValidator.jsonFilePatterns` | `["quickview*.json", "*Template.json"]` | File-name patterns treated as Quick View templates (case-insensitive, `*` wildcard). Covers `quickview.json`, `QuickViewTemplate.json` and any `<Something>Template.json`. Add your own names, e.g. `["quickview*.json", "*Template.json", "RiseCard.json"]`. |
| `spfxQuickViewValidator.requireManualSelection` | `false` | When `true`, only files selected via the **Select Quick View Files** wizard are validated; automatic name matching is ignored. |

---

## Example: duplicate ID + missing binding

`quickview.json`:

```json
{
  "type": "AdaptiveCard",
  "body": [
    { "type": "TextBlock", "id": "employeeName", "text": "${employeeName}" },
    { "type": "Input.Text", "id": "employeeName", "value": "${employeeNname}" }
  ]
}
```

`quickView.ts`:

```typescript
import { BaseAdaptiveCardView } from '@microsoft/sp-adaptive-card-extension-base';
import { IQuickViewData, IQuickViewProperties } from './quickViewDefinition';

export class QuickView extends BaseAdaptiveCardView<IQuickViewProperties, IQuickViewData> {
  public get data(): IQuickViewData {
    return {
      employeeName: this.properties.employeeName
    };
  }
}
```

Result:

- **Error** on both `"employeeName"` IDs — duplicated at `$.body[0].id` and `$.body[1].id`.
- **Error** on `${employeeNname}` — not returned by the data getter (the typo).

## Known limitations (static analysis)

- **Dynamic data shapes.** Spreads (`return { ...base }`), computed keys,
  `any`/untyped returns and unresolvable variables make the analysis *partial*
  or *unknown*. Missing bindings are then downgraded to warnings (partial) or
  skipped (unknown) — never reported as definite errors.
- **Unsupported expression syntax.** The templating language supported by the
  engine is parsed (see section 3). Anything outside it — filters
  (`${name | upper}`), unrecognized operators such as `~`, or an expression
  whose *data type* depends on a call result (`${first(items).owner.name}`) —
  is skipped rather than guessed at. Nested member access on a call result is
  never assumed to be a data path.
- **Dynamic values.** Values typed `any` / `unknown`, computed properties and
  `JSON.parse` results are *unverifiable*: bindings into them are not checked
  and never reported as missing.
- **Array indexes.** `${tasks[0].title}` and `${tasks[$index].title}` validate
  against the element type. Tuple bounds and out-of-range numeric indexes are
  not checked — a bad index is not reported.
- **Visibility conditions.** Only single-property expressions (`${flag}`,
  `${path > 5}`) are analyzed for mutual exclusivity. Logical connectives
  (`&&`, `||`), arithmetic and function calls cannot be proven exclusive, so
  duplicate IDs guarded by them are reported as warnings. Conditions on a
  *parent* container are not considered, and duplicates in different
  containers are never claimed exclusive. Numeric comparisons default to the
  **integer** domain: `${x > 1}` vs `${x < 2}` is proven exclusive and not
  reported. If a numeric property can genuinely be fractional, set
  `spfxQuickViewValidator.numericConditionDomain` to `continuous` so such
  pairs are reported as overlapping errors again.
- **Escaped strings.** Binding offsets assume the raw text matches the parsed
  string value; escape sequences inside a binding expression shift positions
  slightly (the diagnostic is still reported on the correct string value).
- **`}` inside expressions.** The extractor splits on the first `}`, so an
  expression containing a literal `}` (e.g. inside a string literal) is not
  analyzed.
- **Namespace imports.** `import * as types from '...'` is not expanded;
  only named/default imports of interfaces, classes and type aliases are
  resolved for the element-ID rule.
- **Element-ID rule is a convention.** Adaptive Cards does not require element
  IDs to exist in TypeScript. Keep the rule at warning severity or disable it
  for projects that do not follow the convention.

## Troubleshooting binding validation

1. **No binding diagnostics at all?** `spfxQuickViewValidator.enableDataBindingCheck`
   is **off by default**. Turn it on, then reload the JSON.
2. **A warning instead of an error?** The `data` getter could only be
   **partially** resolved (a spread, a computed key, an untyped value), so a
   missing binding is downgraded to a warning. Declare a return type
   (`get data(): IQuickViewData`) to get full, error-level validation.
3. **The `unresolvedDataShape` warning?** The getter's return type could not
   be resolved (`any`, a computed object). Binding checks are skipped for the
   file. Add an explicit return type or an interface.
4. **The `noDataGetter` warning?** The associated TypeScript file has no
   `data` getter. Check the file pairing.
5. **`${$root.x}` is flagged?** It should not be — `$root` is a reserved
   context variable. Make sure you are on 1.2.0 or later, where `$root`,
   `$data`, `$index` and iteration scopes are understood.
6. **The TypeScript file is missing or ambiguous?** Run **Select Associated
   TypeScript File** and pick the correct file; the choice is remembered per
   workspace.

## Why am I getting no diagnostics?

1. **Check the file name.** Only files matching `spfxQuickViewValidator.jsonFilePatterns`
   (default `["quickview*.json", "*Template.json"]`) are validated. If your
   template is named differently, add its name to the setting — that is the most
   common reason a file produces no diagnostics at all.
2. **Check the feature settings.** `spfxQuickViewValidator.enableDataBindingCheck`
   and `spfxQuickViewValidator.enableIdPropertyCheck` are **off by default** —
   turn them on if you expect binding or ID/property diagnostics.
3. Run **Show Validation Summary** — it prints the association status
   (`resolved` / `ambiguous` / `not found`), the candidates found, the Quick
   View class, and the resolved data properties.
4. If the association is **ambiguous**, run **Select Associated TypeScript
   File** and pick the correct file; the choice is remembered per workspace.
5. If the file is **not found**, check the naming convention: the extension
   looks for `*quickview.ts` next to the JSON, in a sibling `quickView/`
   folder, or in the parent folder.
6. If bindings are not checked at all, look for the `noDataGetter` or
   `unresolvedDataShape` warnings at the top of the JSON file — they mean the
   `data` getter or its return type could not be analyzed.

## Author

**Smit P. Bhatt**

## License

MIT

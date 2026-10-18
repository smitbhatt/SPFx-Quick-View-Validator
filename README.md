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
| Duplicate Adaptive Card element IDs (`"id"` at any nesting depth) | Error | `duplicateId` |
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

### 1. Duplicate element ID detection

Every property named `id` with a non-empty string value is collected,
recursively, across all objects and arrays. Each occurrence of a duplicated ID
gets its own error, underlining exactly the ID value, listing the JSON paths
and line/column positions of **all** conflicting occurrences:

```
Duplicate element ID "employeeName". It appears 2 times in this document at:
$.body[0].id (6:12), $.body[1].id (7:13). This occurrence conflicts with:
$.body[1].id (7:13). Element IDs must be unique within an Adaptive Card.
```

IDs are **never** renamed or modified automatically.

### 2. JSON syntax validation

`quickview.json` is parsed with [`jsonc-parser`](https://www.npmjs.com/package/jsonc-parser)
for accurate source offsets. Strict JSON is the default; comments and trailing
commas can be allowed per project (see settings). Duplicate-ID and
consistency checks are skipped on malformed JSON so you only see the real
problem first.

### 3. Data binding validation

Adaptive Card templating expressions are extracted from **any** string value
(`TextBlock.text`, `ariaLabel`, `Fact.value`, ...) and validated against the
properties exposed by the `data` getter of the associated TypeScript file:

- Simple bindings: `${employeeName}`
- Nested bindings: `${employee.name}`, `${employee.address.city}`
- Multiple bindings in one string
- Bindings deep inside nested card elements

**Supported expression syntax** (statically analyzable):

```
${property}
${property.nestedMember}
${property.nestedMember.deeperMember}
```

Anything else — function calls (`${iif(...)}`), indexing (`${items[0].name}`,
`${employee['name']}`), filters (`${name | upper}`), arithmetic, ternaries —
is **skipped** rather than guessed at, so there are no false positives.

Nested members are resolved through the *declared return type* of the `data`
getter (e.g. `IQuickViewData`), so `${employee.name}` is validated against
`IQuickViewData['employee']['name']` and is **not** mistaken for a top-level
data property.

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
- **Spreads / computed properties / untyped (`any`) values** make the result
  *partial* or *unresolvable* — in those cases missing bindings are downgraded
  to warnings or skipped entirely instead of reported as errors.

### 5. Element ID ↔ TypeScript property rule (project convention)

Some teams declare one property per element ID so IDs stay in sync with the
view model. This rule checks every JSON `id` against properties declared in
top-level **interfaces, type aliases and classes** (including resolvable
imported and inherited ones) of the associated TypeScript file. Function
parameters and local variables are never counted. The rule is a *warning* by
default and can be disabled — it is a convention, not an Adaptive Card
requirement.

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
`quickview*.json`, case-insensitive), which covers `quickview.json`,
`QuickView.json` and the standard `QuickViewTemplate.json`. If your project
uses a different file name, add it to the setting — e.g.
`["quickview*.json", "RiseCard.json"]`.

---

## Installation

### From the `.vsix` (end users)

```powershell
code --install-extension spfx-quick-view-validator-1.0.0.vsix
```

Or in VS Code: **Extensions** view → `...` menu → **Install from VSIX...**.

### Development setup

```bash
npm install
npm run build     # compile TypeScript to out/
npm test          # build + run the full mocha test suite
npm run check     # type check only
npm run package   # produce the .vsix (uses @vscode/vsce)
```

### Run in an Extension Development Host

1. Open this folder in VS Code.
2. Press **F5** (launch configuration *Run Extension*).
3. In the new window, open an SPFx project and a `quickview.json`.

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

- **Go to conflicting ID occurrences** — jump between duplicated IDs.
- **Open `<quickView.ts>` (data getter)** — open the TS file at the getter.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `spfxQuickViewValidator.enableDuplicateIdCheck` | `true` | Report duplicate element IDs. |
| `spfxQuickViewValidator.enableDataBindingCheck` | `true` | Validate `${...}` bindings against the data getter. |
| `spfxQuickViewValidator.enableIdPropertyCheck` | `true` | Check element IDs against TypeScript property declarations. |
| `spfxQuickViewValidator.idPropertySeverity` | `warning` | `error`, `warning` or `information`. |
| `spfxQuickViewValidator.validationDebounceMs` | `250` | Debounce while typing (0–5000 ms). |
| `spfxQuickViewValidator.allowJsonComments` | `false` | Permit `//` and `/* */` in `quickview.json`. |
| `spfxQuickViewValidator.allowTrailingCommas` | `false` | Permit trailing commas. |
| `spfxQuickViewValidator.jsonFilePatterns` | `["quickview*.json"]` | File-name patterns treated as Quick View templates (case-insensitive, `*` wildcard). Add your own names, e.g. `["quickview*.json", "RiseCard.json"]`. |
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
- **Complex expressions.** Only `${path.to.property}` is analyzed. Function
  calls, indexing, filters, ternaries and arithmetic are ignored on purpose.
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

## Debugging "why am I getting no diagnostics?"

1. **Check the file name.** Only files matching `spfxQuickViewValidator.jsonFilePatterns`
   (default `quickview*.json`) are validated. If your template is named
   differently, add its name to the setting — that is the most common reason
   a file produces no diagnostics at all.
2. Run **Show Validation Summary** — it prints the association status
   (`resolved` / `ambiguous` / `not found`), the candidates found, the Quick
   View class, and the resolved data properties.
3. If the association is **ambiguous**, run **Select Associated TypeScript
   File** and pick the correct file; the choice is remembered per workspace.
4. If the file is **not found**, check the naming convention: the extension
   looks for `*quickview.ts` next to the JSON, in a sibling `quickView/`
   folder, or in the parent folder.
5. If bindings are not checked at all, look for the `noDataGetter` or
   `unresolvedDataShape` warnings at the top of the JSON file — they mean the
   `data` getter or its return type could not be analyzed.

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

## Author

**Smit P. Bhatt**

## License

MIT

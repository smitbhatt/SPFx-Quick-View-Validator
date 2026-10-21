import { TsAnalysisResult } from '../analyzer/analyzer';
import { AssociationStatus } from './association';
import { BindingResolver, MissingSegment } from './bindingResolver';
import { readOccurrenceVisibility } from './conditions';
import { findDuplicateIds } from './duplicateIds';
import { classifyDuplicateGroup, GroupClassification } from './exclusivity';
import { parseQuickViewJson } from './jsonDocument';
import { computeLineStarts, positionAt } from './positions';
import { CoreDiagnostic, DiagnosticCodes, RelatedLocation, Severity, ValidatorConfig } from './types';

/**
 * Association information handed to the validator. When the TypeScript side
 * is unavailable (`none` / `ambiguous` / `unreadable`) the TS-dependent
 * checks are skipped and a single warning is emitted instead.
 */
export interface AssociationContext {
  status: AssociationStatus | 'unreadable';
  tsPath?: string;
  candidates?: string[];
}

export interface ValidationInput {
  jsonText: string;
  config: ValidatorConfig;
  /** Result of analyzing the associated TypeScript file, when available. */
  tsAnalysis?: TsAnalysisResult;
  /** Known association state; omit to skip TS-dependent checks silently. */
  association?: AssociationContext;
}

const MAX_RELATED_IN_MESSAGE = 8;

function baseName(p: string | undefined): string {
  if (!p) {
    return 'the associated TypeScript file';
  }
  const parts = p.split(/[\\/]/);
  return parts[parts.length - 1] || p;
}

/**
 * Narrows a `${...}` span down to the exact missing property segment so the
 * editor underlines only the offending part of the expression.
 */
function missingRange(
  bindingOffset: number,
  bindingLength: number,
  rawExpression: string,
  missing: MissingSegment
): { offset: number; length: number } {
  // Leading whitespace inside `${ ... }` shifts the expression offsets.
  const leading = rawExpression.length - rawExpression.trimStart().length;
  const offset = bindingOffset + 2 + leading + missing.offset;
  const length = Math.max(missing.length, 1);
  if (offset < bindingOffset || offset + length > bindingOffset + bindingLength) {
    return { offset: bindingOffset, length: bindingLength };
  }
  return { offset, length };
}

/** Builds the human-readable diagnostic message for a missing property. */
function missingMessage(
  expression: string,
  missing: MissingSegment,
  tsName: string,
  jsonPath: string,
  partialNote: string
): string {
  if (missing.atRoot && missing.segmentIndex === 1) {
    return (
      `Data binding "\${${expression}}" references "${missing.name}", which does not exist in ` +
      `${missing.searchedOn} returned by the "data" getter in "${tsName}" (JSON path ${jsonPath}).`
    );
  }
  const prefix = missing.resolvedPath.join('.');
  return (
    `Data binding "\${${expression}}" references "${prefix}.${missing.name}" (segment "${missing.name}"), but ` +
    `"${missing.name}" does not exist on "${prefix}" according to the declared data type in "${tsName}" ` +
    `(JSON path ${jsonPath}).${partialNote}`
  );
}

/**
 * Runs every enabled check against the given `quickview.json` text.
 * The function is pure — all state (caching, VS Code documents, ...) lives
 * in the extension layer.
 */
export function validateQuickView(input: ValidationInput): CoreDiagnostic[] {
  const { jsonText, config } = input;
  const diagnostics: CoreDiagnostic[] = [];
  const lineStarts = computeLineStarts(jsonText);

  const parsed = parseQuickViewJson(jsonText, {
    allowComments: config.allowJsonComments,
    allowTrailingCommas: config.allowTrailingCommas
  });

  // ------------------------------------------------------- B. JSON syntax
  if (parsed.syntaxErrors.length > 0) {
    for (const error of parsed.syntaxErrors) {
      diagnostics.push({
        severity: 'error',
        message: `Invalid JSON: ${error.message}.`,
        code: DiagnosticCodes.jsonSyntax,
        range: { offset: error.offset, length: error.length }
      });
    }
    // Do not run duplicate-ID or consistency checks on malformed JSON.
    return diagnostics;
  }

  // ------------------------------------------------------ A. Duplicate IDs
  if (config.enableDuplicateIdCheck) {
    for (const group of findDuplicateIds(parsed.ids)) {
      const visibilities = group.occurrences.map(readOccurrenceVisibility);
      const classification: GroupClassification = config.enableVisibilityConditionAnalysis
        ? classifyDuplicateGroup(visibilities, config.numericConditionDomain)
        : 'coexist';

      let severity: Severity;
      if (classification === 'exclusive') {
        if (config.conditionalDuplicateSeverity === 'off') {
          continue; // proven mutually exclusive → not reported at all
        }
        severity = config.conditionalDuplicateSeverity;
      } else {
        severity = classification === 'unproven' ? 'warning' : 'error';
      }

      const anyConditioned = visibilities.some((v) => v.condition.kind !== 'unconditional');
      const note =
        classification === 'exclusive'
          ? ` These sibling elements are guarded by mutually exclusive visibility conditions ($when / isVisible), ` +
            `so only one of them can render at runtime and the ID is effectively unique.`
          : classification === 'unproven'
            ? ` Mutual exclusivity of the visibility conditions ($when / isVisible) could not be proven statically, ` +
              `so this is reported as a warning.`
            : anyConditioned
              ? ` The visibility conditions ($when / isVisible) on these elements can be true at the same time, ` +
                `so more than one element can render.`
              : '';

      const describe = (index: number): { text: string; location: RelatedLocation } => {
        const occurrence = group.occurrences[index];
        const position = positionAt(lineStarts, occurrence.offset);
        return {
          text: `${occurrence.path} (${position.line}:${position.column})`,
          location: {
            message: occurrence.path,
            offset: occurrence.offset,
            length: occurrence.length,
            line: position.line,
            column: position.column
          }
        };
      };

      for (let i = 0; i < group.occurrences.length; i++) {
        const occurrence = group.occurrences[i];
        const others = group.occurrences.map((_, index) => describe(index)).filter((_, index) => index !== i);
        const allListed = group.occurrences.map((_, index) => describe(index).text).join(', ');
        const othersListed = others.slice(0, MAX_RELATED_IN_MESSAGE).map((o) => o.text).join(', ');

        const base =
          classification === 'exclusive'
            ? `Duplicate element ID "${group.id}". It appears ${group.occurrences.length} times in this document ` +
              `at: ${allListed}.`
            : `Duplicate element ID "${group.id}". It appears ${group.occurrences.length} times in this document ` +
              `at: ${allListed}. This occurrence conflicts with: ${othersListed}. ` +
              `Element IDs must be unique within an Adaptive Card.`;

        diagnostics.push({
          severity,
          message: base + note,
          code: DiagnosticCodes.duplicateId,
          range: { offset: occurrence.offset, length: occurrence.length },
          related: others.map((o) => o.location),
          data: {
            kind: 'duplicateId',
            id: group.id,
            keepOffset: group.occurrences[0].offset,
            allIds: parsed.ids.map((id) => id.value),
            occurrences: group.occurrences.map((occ) => {
              const pos = positionAt(lineStarts, occ.offset);
              return { path: occ.path, offset: occ.offset, length: occ.length, line: pos.line, column: pos.column };
            })
          }
        });
      }
    }
  }

  const needsTypeScript = config.enableDataBindingCheck || config.enableIdPropertyCheck;

  // ------------------------------------------- association missing / failed
  if (needsTypeScript && input.association && input.association.status !== 'resolved') {
    const reason =
      input.association.status === 'ambiguous'
        ? `Multiple candidate TypeScript files were found: ${(input.association.candidates ?? []).map(baseName).join(', ')}.`
        : input.association.status === 'unreadable'
          ? `The associated TypeScript file "${baseName(input.association.tsPath)}" could not be read.`
          : 'No Quick View TypeScript file (e.g. quickView.ts / QuickView.ts) was found next to the JSON file.';
    diagnostics.push({
      severity: 'warning',
      message:
        `${reason} Data-binding and element-ID property checks are skipped. ` +
        `Run "SPFx Quick View Validator: Select Associated TypeScript File" to choose the file manually.`,
      code: DiagnosticCodes.missingTypeScript,
      range: { offset: 0, length: Math.min(jsonText.length, 1) }
    });
    return diagnostics;
  }

  const tsAnalysis = input.tsAnalysis;
  const tsName = baseName(input.association?.tsPath);

  // --------------------------------------------------- C. Data bindings
  if (config.enableDataBindingCheck) {
    if (!tsAnalysis) {
      // association resolved but analysis unavailable: skip silently; the
      // extension layer surfaces a warning through the association context.
    } else if (!tsAnalysis.hasDataGetter) {
      diagnostics.push({
        severity: 'warning',
        message: `"${tsName}" does not expose a "data" getter. Data-binding validation is skipped.`,
        code: DiagnosticCodes.noDataGetter,
        range: { offset: 0, length: Math.min(jsonText.length, 1) },
        data: tsAnalysis.dataGetterPosition
          ? { kind: 'openTypeScript', tsPath: input.association?.tsPath ?? '', line: 1, column: 1 }
          : undefined
      });
    } else if (tsAnalysis.dataResolution === 'none') {
      diagnostics.push({
        severity: 'warning',
        message:
          `The data properties returned by the "data" getter in "${tsName}" could not be resolved statically. ` +
          `Data-binding validation is skipped for this file.`,
        code: DiagnosticCodes.unresolvedDataShape,
        range: { offset: 0, length: Math.min(jsonText.length, 1) },
        data: tsAnalysis.dataGetterPosition
          ? {
              kind: 'openTypeScript',
              tsPath: input.association?.tsPath ?? '',
              line: tsAnalysis.dataGetterPosition.line,
              column: tsAnalysis.dataGetterPosition.column
            }
          : undefined
      });
    } else {
      // `partial` analysis produces warnings, `full` analysis produces errors.
      const bindingSeverity: Severity = tsAnalysis.dataResolution === 'full' ? 'error' : 'warning';
      const partialNote =
        tsAnalysis.dataResolution === 'partial'
          ? ' (Note: the data getter could only be partially resolved statically, so this is reported as a warning.)'
          : '';

      const openTsData = input.association?.tsPath
        ? {
            kind: 'openTypeScript' as const,
            tsPath: input.association.tsPath,
            line: tsAnalysis.dataGetterPosition?.line ?? 1,
            column: tsAnalysis.dataGetterPosition?.column ?? 1
          }
        : undefined;

      const rootShape = tsAnalysis.rootShape;
      const seen = new Set<string>();
      // One resolver per distinct iteration-scope chain: scope resolution
      // (and the `$data` parse) is reused across all bindings in the same
      // repetition instead of being repeated per binding.
      const resolvers = new Map<string, BindingResolver>();
      const resolverFor = (scopes: string[]): BindingResolver => {
        const key = scopes.join('\u0000');
        let resolver = resolvers.get(key);
        if (!resolver) {
          resolver = new BindingResolver({
            rootShape: rootShape as NonNullable<typeof rootShape>,
            scopes: scopes.map((expression) => ({ expression }))
          });
          resolvers.set(key, resolver);
        }
        return resolver;
      };

      for (const binding of parsed.bindings) {
        if (!rootShape) {
          break; // no resolvable root shape: skip binding checks entirely
        }
        const resolution = resolverFor(binding.scopes).resolve(binding.expression);
        if (resolution.status !== 'missing' || !resolution.missing) {
          // `valid` / `unverifiable` / `unsupported`: never guess.
          continue;
        }

        const missing = resolution.missing;
        const display = binding.expression.trim();
        const range = missingRange(binding.offset, binding.length, binding.expression, missing);
        const key = `${range.offset}:${range.length}`;
        if (seen.has(key)) {
          continue; // avoid duplicate diagnostics for the same property
        }
        seen.add(key);

        diagnostics.push({
          severity: missing.segmentIndex === 1 && missing.atRoot ? bindingSeverity : 'error',
          message: missingMessage(display, missing, tsName, binding.path, partialNote),
          code: DiagnosticCodes.missingDataBinding,
          range,
          data: openTsData
        });
      }
    }
  }

  // ----------------------------------------- E. Element ID ↔ TS property
  if (config.enableIdPropertyCheck) {
    if (tsAnalysis && tsAnalysis.declaredPropertyResolution !== 'none') {
      for (const id of parsed.ids) {
        if (!tsAnalysis.declaredPropertyNames.has(id.value)) {
          diagnostics.push({
            severity: config.idPropertySeverity,
            message:
              `Element ID "${id.value}" has no matching property declaration in "${tsName}" ` +
              `(JSON path ${id.path}). This is a project-specific convention; disable it with the ` +
              `"spfxQuickViewValidator.enableIdPropertyCheck" setting.`,
            code: DiagnosticCodes.missingIdProperty,
            range: { offset: id.offset, length: id.length },
            data: input.association?.tsPath
              ? {
                  kind: 'openTypeScript',
                  tsPath: input.association.tsPath,
                  line: tsAnalysis.dataGetterPosition?.line ?? 1,
                  column: tsAnalysis.dataGetterPosition?.column ?? 1
                }
              : undefined
          });
        }
      }
    }
  }

  diagnostics.sort((a, b) => a.range.offset - b.range.offset || a.code.localeCompare(b.code));
  return diagnostics;
}

import { TsAnalysisResult } from '../analyzer/analyzer';
import { AssociationStatus } from './association';
import { parseAdaptiveCardExpression } from './bindings';
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

      for (const binding of parsed.bindings) {
        const expression = parseAdaptiveCardExpression(binding.expression);
        if (!expression.supported || !expression.root) {
          continue; // statically unresolvable: skip instead of guessing
        }

        const openTsData = input.association?.tsPath
          ? {
              kind: 'openTypeScript' as const,
              tsPath: input.association.tsPath,
              line: tsAnalysis.dataGetterPosition?.line ?? 1,
              column: tsAnalysis.dataGetterPosition?.column ?? 1
            }
          : undefined;

        if (!tsAnalysis.dataPropertyNames.has(expression.root)) {
          diagnostics.push({
            severity: bindingSeverity,
            message:
              `Data binding "\${${binding.expression.trim()}}" references "${expression.root}", which is not ` +
              `returned by the "data" getter in "${tsName}" (JSON path ${binding.path}).${partialNote}`,
            code: DiagnosticCodes.missingDataBinding,
            range: { offset: binding.offset, length: binding.length },
            data: openTsData
          });
          continue;
        }

        if (expression.members.length > 0) {
          // resolveDataPath works from the data root, so include the root member.
          const result = tsAnalysis.resolveDataPath([expression.root, ...expression.members]);
          if (result.status === 'missing') {
            diagnostics.push({
              severity: 'error',
              message:
                `Data binding "\${${binding.expression.trim()}}" references "${expression.members.join('.')}", but ` +
                `"${result.missingPath.join('.')}" does not exist on "${expression.root}" according to the declared ` +
                `data type in "${tsName}" (JSON path ${binding.path}).`,
              code: DiagnosticCodes.missingDataBinding,
              range: { offset: binding.offset, length: binding.length },
              data: openTsData
            });
          }
          // `unknown` → the type could not be resolved; skip without reporting.
        }
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

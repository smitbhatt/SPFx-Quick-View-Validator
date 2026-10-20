import * as vscode from 'vscode';
import { ConfiguredSeverity, DEFAULT_CONFIG, Severity, ValidatorConfig } from './core/types';

export const CONFIG_SECTION = 'spfxQuickViewValidator';

const SEVERITIES: Severity[] = ['error', 'warning', 'information'];
const CONDITIONAL_DUPLICATE_SEVERITIES: ConfiguredSeverity[] = ['off', 'warning', 'information'];

function clamp(value: number, min: number, max: number): number {
  if (Number.isNaN(value)) {
    return min;
  }
  return Math.min(Math.max(value, min), max);
}

/** Reads and sanitizes the extension configuration from VS Code settings. */
export function readConfig(): ValidatorConfig {
  const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
  const rawSeverity = config.get<string>('idPropertySeverity', DEFAULT_CONFIG.idPropertySeverity);
  const rawConditional = config.get<string>('conditionalDuplicateSeverity', DEFAULT_CONFIG.conditionalDuplicateSeverity);
  return {
    enableDuplicateIdCheck: config.get<boolean>('enableDuplicateIdCheck', DEFAULT_CONFIG.enableDuplicateIdCheck),
    enableDataBindingCheck: config.get<boolean>('enableDataBindingCheck', DEFAULT_CONFIG.enableDataBindingCheck),
    enableIdPropertyCheck: config.get<boolean>('enableIdPropertyCheck', DEFAULT_CONFIG.enableIdPropertyCheck),
    enableVisibilityConditionAnalysis: config.get<boolean>(
      'enableVisibilityConditionAnalysis',
      DEFAULT_CONFIG.enableVisibilityConditionAnalysis
    ),
    conditionalDuplicateSeverity: CONDITIONAL_DUPLICATE_SEVERITIES.includes(rawConditional as ConfiguredSeverity)
      ? (rawConditional as ConfiguredSeverity)
      : DEFAULT_CONFIG.conditionalDuplicateSeverity,
    idPropertySeverity: SEVERITIES.includes(rawSeverity as Severity) ? (rawSeverity as Severity) : DEFAULT_CONFIG.idPropertySeverity,
    validationDebounceMs: clamp(
      config.get<number>('validationDebounceMs', DEFAULT_CONFIG.validationDebounceMs),
      0,
      5000
    ),
    allowJsonComments: config.get<boolean>('allowJsonComments', DEFAULT_CONFIG.allowJsonComments),
    allowTrailingCommas: config.get<boolean>('allowTrailingCommas', DEFAULT_CONFIG.allowTrailingCommas),
    jsonFilePatterns: sanitizePatterns(config.get<unknown>('jsonFilePatterns', DEFAULT_CONFIG.jsonFilePatterns)),
    requireManualSelection: config.get<boolean>('requireManualSelection', DEFAULT_CONFIG.requireManualSelection)
  };
}

function sanitizePatterns(raw: unknown): string[] {
  if (!Array.isArray(raw)) {
    return [...DEFAULT_CONFIG.jsonFilePatterns];
  }
  const patterns = raw
    .map((pattern) => (typeof pattern === 'string' ? pattern.trim() : ''))
    .filter((pattern) => pattern.length > 0);
  return patterns.length > 0 ? patterns : [...DEFAULT_CONFIG.jsonFilePatterns];
}

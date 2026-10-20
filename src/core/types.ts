/**
 * Shared, VS Code-independent models used by the validation core.
 * Keeping these free of `vscode` imports makes the whole pipeline unit-testable.
 */

export type Severity = 'error' | 'warning' | 'information';

/** A severity that may also suppress a diagnostic entirely. */
export type ConfiguredSeverity = Severity | 'off';

/** A range expressed as character offsets into a document. */
export interface SourceRange {
  offset: number;
  length: number;
}

/** A 1-based line/column position. */
export interface Position {
  line: number;
  column: number;
}

/** A related location used for "conflicts at ..." information. */
export interface RelatedLocation extends SourceRange, Position {
  /** Human readable description, usually the JSON path. */
  message: string;
}

export type DiagnosticData =
  | {
      kind: 'duplicateId';
      id: string;
      occurrences: Array<SourceRange & Position & { path: string }>;
    }
  | {
      kind: 'openTypeScript';
      tsPath: string;
      line: number;
      column: number;
    };

/** A validator diagnostic in VS Code-independent form. */
export interface CoreDiagnostic {
  severity: Severity;
  message: string;
  /** Stable diagnostic code, e.g. `duplicateId`. */
  code: string;
  range: SourceRange;
  related?: RelatedLocation[];
  data?: DiagnosticData;
}

/**
 * Default file-name patterns (case-insensitive, `*` wildcard) that identify
 * Quick View template JSON files: covers `quickview.json`, `QuickView.json`
 * and the standard SPFx `QuickViewTemplate.json`.
 */
export const DEFAULT_JSON_FILE_PATTERNS = ['quickview*.json'];

/** Extension configuration, mapped from VS Code settings. */
export interface ValidatorConfig {
  enableDuplicateIdCheck: boolean;
  enableDataBindingCheck: boolean;
  enableIdPropertyCheck: boolean;
  /**
   * When true, `$when` / `isVisible` conditions of duplicate-ID occurrences
   * are analyzed: proven-mutually-exclusive siblings use
   * `conditionalDuplicateSeverity`, unprovable conditions become warnings
   * and overlapping conditions stay errors. When false every duplicate is
   * reported as an error (legacy behavior).
   */
  enableVisibilityConditionAnalysis: boolean;
  /** Severity for duplicates proven mutually exclusive (`off` = silent). */
  conditionalDuplicateSeverity: ConfiguredSeverity;
  idPropertySeverity: Severity;
  validationDebounceMs: number;
  allowJsonComments: boolean;
  allowTrailingCommas: boolean;
  /** File-name patterns treated as Quick View templates. */
  jsonFilePatterns: string[];
  /** When true, only manually selected (pinned) Quick View files are validated. */
  requireManualSelection: boolean;
}

export const DEFAULT_CONFIG: ValidatorConfig = {
  enableDuplicateIdCheck: true,
  enableDataBindingCheck: true,
  enableIdPropertyCheck: true,
  enableVisibilityConditionAnalysis: true,
  conditionalDuplicateSeverity: 'off',
  idPropertySeverity: 'warning',
  validationDebounceMs: 250,
  allowJsonComments: false,
  allowTrailingCommas: false,
  jsonFilePatterns: [...DEFAULT_JSON_FILE_PATTERNS],
  requireManualSelection: false
};

/** Diagnostic codes emitted by the validator (stable identifiers). */
export const DiagnosticCodes = {
  jsonSyntax: 'jsonSyntax',
  duplicateId: 'duplicateId',
  missingDataBinding: 'missingDataBinding',
  missingIdProperty: 'missingIdProperty',
  missingTypeScript: 'missingTypeScript',
  noDataGetter: 'noDataGetter',
  unresolvedDataShape: 'unresolvedDataShape'
} as const;

/** Source string shown on every VS Code diagnostic. */
export const DIAGNOSTIC_SOURCE = 'SPFx Quick View Validator';

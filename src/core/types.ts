/**
 * Shared, VS Code-independent models used by the validation core.
 * Keeping these free of `vscode` imports makes the whole pipeline unit-testable.
 */

export type Severity = 'error' | 'warning' | 'information';

/** A severity that may also suppress a diagnostic entirely. */
export type ConfiguredSeverity = Severity | 'off';

/**
 * Domain over which numeric visibility-condition comparisons are solved.
 * `integer` matches typical counters (days, items); `continuous` is the
 * never-silence-a-possible-conflict choice for fractional data.
 */
export type NumericDomain = 'integer' | 'continuous';

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
      /**
       * Offset of the first occurrence — the one that keeps the original ID.
       * Every later occurrence offers the "Fix duplicate ID" quick fix.
       */
      keepOffset: number;
      /** Every element ID in the document; used to generate unique fix candidates. */
      allIds: string[];
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
 * Quick View template JSON files. Covers `quickview.json`, `QuickView.json`
 * and the standard SPFx `QuickViewTemplate.json`, plus the common convention
 * of naming every Quick View template `<Something>Template.json`.
 */
export const DEFAULT_JSON_FILE_PATTERNS = ['quickview*.json', '*Template.json'];

/** Extension configuration, mapped from VS Code settings. */
export interface ValidatorConfig {
  enableDuplicateIdCheck: boolean;
  enableDataBindingCheck: boolean;
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
  /**
   * Domain for numeric condition comparisons: `integer` proves
   * `${x > 1}` vs `${x < 2}` exclusive (adjacent integer bounds),
   * `continuous` treats the real interval (1, 2) as an overlap.
   */
  numericConditionDomain: NumericDomain;
  validationDebounceMs: number;
  /** File-name patterns treated as Quick View templates. */
  jsonFilePatterns: string[];
  /** When true, only manually selected (pinned) Quick View files are validated. */
  requireManualSelection: boolean;
}

export const DEFAULT_CONFIG: ValidatorConfig = {
  enableDuplicateIdCheck: true,
  enableDataBindingCheck: true,
  enableVisibilityConditionAnalysis: true,
  conditionalDuplicateSeverity: 'off',
  numericConditionDomain: 'integer',
  validationDebounceMs: 250,
  jsonFilePatterns: [...DEFAULT_JSON_FILE_PATTERNS],
  requireManualSelection: false
};

/** Diagnostic codes emitted by the validator (stable identifiers). */
export const DiagnosticCodes = {
  jsonSyntax: 'jsonSyntax',
  duplicateId: 'duplicateId',
  missingDataBinding: 'missingDataBinding',
  missingTypeScript: 'missingTypeScript',
  noDataGetter: 'noDataGetter',
  unresolvedDataShape: 'unresolvedDataShape'
} as const;

/** Source string shown on every VS Code diagnostic. */
export const DIAGNOSTIC_SOURCE = 'SPFx Quick View Validator';

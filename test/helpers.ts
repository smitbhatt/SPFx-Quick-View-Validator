import * as fs from 'fs';
import * as path from 'path';
import { analyzeQuickViewTypeScript, TsAnalysisResult } from '../src/analyzer/analyzer';
import { CoreDiagnostic, DEFAULT_CONFIG, DiagnosticCodes, ValidatorConfig } from '../src/core/types';
import { AssociationContext, validateQuickView, ValidationInput } from '../src/core/validate';

export const FIXTURES = path.join(__dirname, '..', '..', 'test', 'fixtures');

export function fixturePath(...segments: string[]): string {
  return path.join(FIXTURES, ...segments);
}

export function readFixture(...segments: string[]): string {
  return fs.readFileSync(fixturePath(...segments), 'utf8');
}

export function analyzeFixture(...segments: string[]): TsAnalysisResult {
  const filePath = fixturePath(...segments);
  return analyzeQuickViewTypeScript(filePath, fs.readFileSync(filePath, 'utf8'));
}

export function validate(
  jsonText: string,
  overrides: Partial<Omit<ValidationInput, 'jsonText'>> = {}
): CoreDiagnostic[] {
  return validateQuickView({
    jsonText,
    config: overrides.config ?? DEFAULT_CONFIG,
    tsAnalysis: overrides.tsAnalysis,
    association: overrides.association
  });
}

export function config(overrides: Partial<ValidatorConfig> = {}): ValidatorConfig {
  return { ...DEFAULT_CONFIG, ...overrides };
}

export function spfxBasicAssociation(): AssociationContext {
  return {
    status: 'resolved',
    tsPath: fixturePath('spfx-basic', 'src', 'adaptiveCardExtensions', 'employee', 'quickView', 'QuickView.ts'),
    candidates: []
  };
}

export function codes(diagnostics: CoreDiagnostic[]): string[] {
  return diagnostics.map((d) => d.code);
}

export function byCode(diagnostics: CoreDiagnostic[], code: string): CoreDiagnostic[] {
  return diagnostics.filter((d) => d.code === code);
}

export function hasCode(diagnostics: CoreDiagnostic[], code: string): boolean {
  return diagnostics.some((d) => d.code === code);
}

export function firstWithCode(diagnostics: CoreDiagnostic[], code: string): CoreDiagnostic {
  const found = diagnostics.find((d) => d.code === code);
  if (!found) {
    throw new Error(`Expected a diagnostic with code "${code}" but got: [${codes(diagnostics).join(', ')}]`);
  }
  return found;
}

export { DiagnosticCodes };

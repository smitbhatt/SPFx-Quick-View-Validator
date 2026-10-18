import * as vscode from 'vscode';
import { CoreDiagnostic, DIAGNOSTIC_SOURCE, Severity } from '../core/types';

const SEVERITY_MAP: Record<Severity, vscode.DiagnosticSeverity> = {
  error: vscode.DiagnosticSeverity.Error,
  warning: vscode.DiagnosticSeverity.Warning,
  information: vscode.DiagnosticSeverity.Information
};

/** Converts core diagnostics (offset based) into VS Code diagnostics for `document`. */
export function toVscodeDiagnostics(diagnostics: CoreDiagnostic[], document: vscode.TextDocument): vscode.Diagnostic[] {
  return diagnostics.map((diagnostic) => {
    const start = document.positionAt(diagnostic.range.offset);
    const end = document.positionAt(diagnostic.range.offset + Math.max(diagnostic.range.length, 0));
    const result = new vscode.Diagnostic(new vscode.Range(start, end), diagnostic.message, SEVERITY_MAP[diagnostic.severity]);
    result.source = DIAGNOSTIC_SOURCE;
    result.code = diagnostic.code;
    if (diagnostic.related && diagnostic.related.length > 0) {
      result.relatedInformation = diagnostic.related.map(
        (related) =>
          new vscode.DiagnosticRelatedInformation(
            new vscode.Location(
              document.uri,
              new vscode.Range(document.positionAt(related.offset), document.positionAt(related.offset + related.length))
            ),
            `${related.message} (${related.line}:${related.column})`
          )
      );
    }
    if (diagnostic.data) {
      (result as vscode.Diagnostic & { data?: unknown }).data = diagnostic.data;
    }
    return result;
  });
}

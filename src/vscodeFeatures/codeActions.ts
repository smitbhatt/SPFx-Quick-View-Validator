import * as path from 'path';
import * as vscode from 'vscode';
import { DiagnosticData } from '../core/types';
import { CommandIds } from './commandIds';

interface IdOccurrencePayload {
  path: string;
  offset: number;
  length: number;
  line: number;
  column: number;
}

/**
 * Quick fixes for Quick View diagnostics. Only safe, unambiguous actions are
 * offered: navigation to conflicting ID occurrences and to the associated
 * TypeScript file. IDs and data bindings are never modified automatically.
 */
export class QuickViewCodeActionProvider implements vscode.CodeActionProvider {
  static readonly metadata: vscode.CodeActionProviderMetadata = {
    providedCodeActionKinds: [vscode.CodeActionKind.QuickFix]
  };

  provideCodeActions(
    document: vscode.TextDocument,
    _range: vscode.Range | vscode.Selection,
    context: vscode.CodeActionContext
  ): vscode.CodeAction[] {
    const actions: vscode.CodeAction[] = [];

    for (const diagnostic of context.diagnostics) {
      if (diagnostic.source !== 'SPFx Quick View Validator') {
        continue;
      }
      const data = (diagnostic as vscode.Diagnostic & { data?: DiagnosticData }).data;
      if (!data) {
        continue;
      }

      if (data.kind === 'duplicateId' && data.occurrences.length > 1) {
        const action = new vscode.CodeAction(
          'Go to conflicting ID occurrences',
          vscode.CodeActionKind.QuickFix
        );
        action.diagnostics = [diagnostic];
        action.isPreferred = false;
        action.command = {
          command: CommandIds.goToConflictingId,
          title: 'Go to conflicting ID occurrences',
          arguments: [document.uri.toString(), data.occurrences as IdOccurrencePayload[]]
        };
        actions.push(action);
      }

      if (data.kind === 'openTypeScript' && data.tsPath) {
        const action = new vscode.CodeAction(
          `Open ${path.basename(data.tsPath)} (data getter)`,
          vscode.CodeActionKind.QuickFix
        );
        action.diagnostics = [diagnostic];
        action.isPreferred = true;
        action.command = {
          command: CommandIds.openTypeScriptFile,
          title: `Open ${path.basename(data.tsPath)}`,
          arguments: [data.tsPath, data.line, data.column]
        };
        actions.push(action);
      }
    }

    return actions;
  }
}

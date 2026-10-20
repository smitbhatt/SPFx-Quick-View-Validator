import * as path from 'path';
import * as vscode from 'vscode';
import { generateDuplicateIdFix } from '../core/duplicateFix';
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
 * Quick fixes for Quick View diagnostics: navigation to conflicting ID
 * occurrences and to the associated TypeScript file, plus "Fix duplicate ID"
 * which replaces a later duplicate occurrence with a freshly generated
 * unique ID (the first occurrence always keeps the original ID). Data
 * bindings are never modified automatically.
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
        const navigation = new vscode.CodeAction(
          'Go to conflicting ID occurrences',
          vscode.CodeActionKind.QuickFix
        );
        navigation.diagnostics = [diagnostic];
        navigation.isPreferred = false;
        navigation.command = {
          command: CommandIds.goToConflictingId,
          title: 'Go to conflicting ID occurrences',
          arguments: [document.uri.toString(), data.occurrences as IdOccurrencePayload[]]
        };
        actions.push(navigation);

        // The first occurrence keeps the ID; later ones can be fixed.
        const offset = document.offsetAt(diagnostic.range.start);
        const end = document.offsetAt(diagnostic.range.end);
        if (data.keepOffset !== offset) {
          const preview = generateDuplicateIdFix(data.id, new Set(data.allIds));
          let title = 'Fix duplicate ID';
          let suffixArg: string | undefined;
          if ('id' in preview) {
            title = `Fix duplicate ID: ${data.id} → ${preview.id}`;
            suffixArg = preview.suffix;
          }
          const fix = new vscode.CodeAction(title, vscode.CodeActionKind.QuickFix);
          fix.diagnostics = [diagnostic];
          fix.isPreferred = true;
          fix.command = {
            command: CommandIds.fixDuplicateId,
            title: 'Fix duplicate ID',
            arguments: [document.uri.toString(), offset, end - offset, data.id, suffixArg]
          };
          actions.push(fix);
        }
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

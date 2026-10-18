import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { analyzeQuickViewTypeScript, TsAnalysisResult } from './analyzer/analyzer';
import { CONFIG_SECTION, readConfig } from './config';
import { Association, discoverTypeScriptCandidates, isQuickViewJsonPath, resolveAssociatedTypeScript } from './core/association';
import { AssociationContext, validateQuickView } from './core/validate';
import { CommandIds } from './vscodeFeatures/commandIds';
import { QuickViewCodeActionProvider } from './vscodeFeatures/codeActions';
import { toVscodeDiagnostics } from './vscodeFeatures/diagnostics';

const MANUAL_ASSOCIATIONS_KEY = 'spfxQuickViewValidator.manualAssociations';
const PINNED_JSON_KEY = 'spfxQuickViewValidator.pinnedQuickViewJson';

interface ValidationSummary {
  errors: number;
  warnings: number;
  information: number;
  tsPath?: string;
  associationStatus: Association['status'] | 'unreadable';
}

function samePath(a: string, b: string): boolean {
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function baseName(p: string | undefined): string {
  if (!p) {
    return 'not found';
  }
  const parts = p.split(/[\\/]/);
  return parts[parts.length - 1] || p;
}

/**
 * Extension controller: owns the diagnostic collection, the file-association
 * cache, the (content keyed) analysis caches and all event subscriptions.
 * Diagnostics are always scoped to the currently open Quick View JSON files.
 */
export class ExtensionController implements vscode.Disposable {
  private readonly diagnosticCollection: vscode.DiagnosticCollection;
  private readonly output: vscode.OutputChannel;
  private readonly associationCache = new Map<string, Association>();
  private readonly tsAnalysisCache = new Map<string, { content: string; analysis: TsAnalysisResult }>();
  private readonly pendingTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly summaries = new Map<string, ValidationSummary>();
  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly context: vscode.ExtensionContext) {
    this.diagnosticCollection = vscode.languages.createDiagnosticCollection('spfxQuickViewValidator');
    this.output = vscode.window.createOutputChannel('SPFx Quick View Validator');
  }

  register(): void {
    this.disposables.push(
      this.diagnosticCollection,
      this.output,

      vscode.workspace.onDidOpenTextDocument((document) => {
        if (this.isQuickViewDocument(document)) {
          this.scheduleValidation(document, true);
        }
      }),

      vscode.workspace.onDidChangeTextDocument((event) => {
        const changedPath = event.document.uri.fsPath;
        if (this.isQuickViewDocument(event.document)) {
          this.scheduleValidation(event.document, false);
          return;
        }
        if (!/\.tsx?$/i.test(changedPath)) {
          return;
        }
        // Revalidate open Quick View JSON documents associated with this TS file.
        for (const document of vscode.workspace.textDocuments) {
          if (!this.isQuickViewDocument(document)) {
            continue;
          }
          const association = this.resolveAssociationCached(document.uri.fsPath);
          if (association.status === 'resolved' && association.tsPath && samePath(association.tsPath, changedPath)) {
            this.scheduleValidation(document, false);
          }
        }
      }),

      vscode.workspace.onDidSaveTextDocument((document) => {
        if (this.isQuickViewDocument(document)) {
          this.scheduleValidation(document, true);
        }
      }),

      vscode.workspace.onDidCloseTextDocument((document) => {
        const closedPath = document.uri.fsPath;
        if (this.isQuickViewDocument(document)) {
          this.clearTimer(document);
          this.diagnosticCollection.delete(document.uri);
          this.summaries.delete(document.uri.fsPath);
        } else if (/\.tsx?$/i.test(closedPath)) {
          // Unsaved edits may have been discarded: drop the cached analysis
          // and refresh every Quick View JSON associated with this file.
          this.dropTsAnalysis(closedPath);
          this.refreshDocumentsAssociatedWith(closedPath);
        }
      }),

      vscode.window.onDidChangeActiveTextEditor((editor) => {
        if (editor && this.isQuickViewDocument(editor.document)) {
          this.scheduleValidation(editor.document, true);
        }
      }),

      vscode.workspace.onDidChangeConfiguration((event) => {
        if (!event.affectsConfiguration(CONFIG_SECTION)) {
          return;
        }
        this.clearAssociationCache();
        this.dropAllTsAnalyses();
        for (const document of vscode.workspace.textDocuments) {
          if (this.isQuickViewDocument(document)) {
            this.scheduleValidation(document, true);
          }
        }
      }),

      vscode.workspace.onDidCreateFiles((event) => this.handleFileSettled(event.files)),
      vscode.workspace.onDidDeleteFiles((event) => this.handleFileSettled(event.files)),
      vscode.workspace.onDidRenameFiles((event) =>
        this.handleFileSettled([...event.files.map((file) => file.oldUri), ...event.files.map((file) => file.newUri)])
      ),

      vscode.languages.registerCodeActionsProvider(
        { language: 'json' },
        new QuickViewCodeActionProvider(),
        QuickViewCodeActionProvider.metadata
      ),

      vscode.commands.registerCommand(CommandIds.selectQuickViewFiles, () => this.commandSelectQuickViewFiles()),
      vscode.commands.registerCommand(CommandIds.validate, () => this.commandValidate()),
      vscode.commands.registerCommand(CommandIds.selectTypeScriptFile, () => this.commandSelectTypeScriptFile()),
      vscode.commands.registerCommand(CommandIds.showSummary, () => this.commandShowSummary()),
      vscode.commands.registerCommand(CommandIds.goToConflictingId, (uriString: string, occurrences: Array<{ offset: number; length: number; path: string; line: number; column: number }>) =>
        this.commandGoToConflictingId(uriString, occurrences)
      ),
      vscode.commands.registerCommand(CommandIds.openTypeScriptFile, (tsPath: string, line: number, column: number) =>
        this.commandOpenTypeScriptFile(tsPath, line, column)
      )
    );

    // Validate any Quick View JSON documents that are already open.
    for (const document of vscode.workspace.textDocuments) {
      if (this.isQuickViewDocument(document)) {
        this.scheduleValidation(document, true);
      }
    }
  }

  dispose(): void {
    for (const timer of this.pendingTimers.values()) {
      clearTimeout(timer);
    }
    this.pendingTimers.clear();
    this.dropAllTsAnalyses();
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
    this.disposables.length = 0;
  }

  // ------------------------------------------------------------ predicates

  private isQuickViewDocument(document: vscode.TextDocument): boolean {
    if (document.uri.scheme !== 'file') {
      return false;
    }
    // Manually selected (pinned) files are always validated, regardless of name.
    if (this.isPinnedJson(document.uri.fsPath)) {
      return true;
    }
    const config = readConfig();
    if (config.requireManualSelection) {
      // "Select first" mode: only pinned files produce diagnostics.
      return false;
    }
    return isQuickViewJsonPath(document.uri.fsPath, config.jsonFilePatterns);
  }

  // ------------------------------------------------------- pinned selection

  private getPinnedJsonPaths(): string[] {
    return this.context.workspaceState.get<string[]>(PINNED_JSON_KEY) ?? [];
  }

  private isPinnedJson(jsonPath: string): boolean {
    return this.getPinnedJsonPaths().some((pinned) => samePath(pinned, jsonPath));
  }

  private async pinJson(jsonPath: string): Promise<void> {
    if (this.isPinnedJson(jsonPath)) {
      return;
    }
    await this.context.workspaceState.update(PINNED_JSON_KEY, [...this.getPinnedJsonPaths(), jsonPath]);
  }

  // --------------------------------------------------------- associations

  private getManualAssociations(): Record<string, string> {
    return this.context.workspaceState.get<Record<string, string>>(MANUAL_ASSOCIATIONS_KEY) ?? {};
  }

  private async setManualAssociation(jsonPath: string, tsPath: string): Promise<void> {
    const associations = { ...this.getManualAssociations(), [jsonPath]: tsPath };
    await this.context.workspaceState.update(MANUAL_ASSOCIATIONS_KEY, associations);
    this.associationCache.delete(jsonPath);
  }

  private resolveAssociationCached(jsonPath: string): Association {
    let cached = this.associationCache.get(jsonPath);
    if (!cached) {
      cached = resolveAssociatedTypeScript(jsonPath, this.getManualAssociations()[jsonPath]);
      this.associationCache.set(jsonPath, cached);
    }
    return cached;
  }

  private clearAssociationCache(): void {
    this.associationCache.clear();
  }

  private handleFileSettled(files: readonly vscode.Uri[]): void {
    if (files.some((file) => /\.tsx?$/i.test(file.fsPath))) {
      this.clearAssociationCache();
    }
    // Unpin Quick View JSON files that were deleted or renamed away.
    const changed = files.map((file) => file.fsPath.toLowerCase());
    const pinned = this.getPinnedJsonPaths();
    const remaining = pinned.filter((pinnedPath) => !changed.includes(pinnedPath.toLowerCase()));
    if (remaining.length !== pinned.length) {
      void this.context.workspaceState.update(PINNED_JSON_KEY, remaining);
      this.associationCache.clear();
    }
  }

  // -------------------------------------------------------- TS analysis

  private readTsContent(tsPath: string): string | undefined {
    const openDocument = vscode.workspace.textDocuments.find(
      (document) => document.uri.scheme === 'file' && samePath(document.uri.fsPath, tsPath)
    );
    if (openDocument) {
      return openDocument.getText(); // prefer unsaved editor content
    }
    try {
      return fs.readFileSync(tsPath, 'utf8');
    } catch {
      return undefined;
    }
  }

  private getTsAnalysis(tsPath: string): TsAnalysisResult | undefined {
    const content = this.readTsContent(tsPath);
    if (content === undefined) {
      return undefined;
    }
    const cached = this.tsAnalysisCache.get(tsPath);
    if (cached && cached.content === content) {
      return cached.analysis;
    }
    cached?.analysis.dispose();
    const analysis = analyzeQuickViewTypeScript(tsPath, content);
    this.tsAnalysisCache.set(tsPath, { content, analysis });
    return analysis;
  }

  private dropTsAnalysis(tsPath: string): void {
    for (const [key, entry] of this.tsAnalysisCache) {
      if (samePath(key, tsPath)) {
        entry.analysis.dispose();
        this.tsAnalysisCache.delete(key);
      }
    }
  }

  private dropAllTsAnalyses(): void {
    for (const entry of this.tsAnalysisCache.values()) {
      entry.analysis.dispose();
    }
    this.tsAnalysisCache.clear();
  }

  private refreshDocumentsAssociatedWith(tsPath: string): void {
    for (const document of vscode.workspace.textDocuments) {
      if (!this.isQuickViewDocument(document)) {
        continue;
      }
      const association = this.resolveAssociationCached(document.uri.fsPath);
      if (association.status === 'resolved' && association.tsPath && samePath(association.tsPath, tsPath)) {
        this.scheduleValidation(document, true);
      }
    }
  }

  // ------------------------------------------------------------ validation

  private scheduleValidation(document: vscode.TextDocument, immediate: boolean): void {
    const key = document.uri.toString();
    const existing = this.pendingTimers.get(key);
    if (existing) {
      clearTimeout(existing);
      this.pendingTimers.delete(key);
    }

    const run = (): void => {
      this.pendingTimers.delete(key);
      this.validateNow(document);
    };

    if (immediate) {
      run();
      return;
    }

    const debounceMs = readConfig().validationDebounceMs;
    if (debounceMs <= 0) {
      run();
      return;
    }
    this.pendingTimers.set(key, setTimeout(run, debounceMs));
  }

  private clearTimer(document: vscode.TextDocument): void {
    const key = document.uri.toString();
    const existing = this.pendingTimers.get(key);
    if (existing) {
      clearTimeout(existing);
      this.pendingTimers.delete(key);
    }
  }

  private validateNow(document: vscode.TextDocument): void {
    if (document.isClosed || !this.isQuickViewDocument(document)) {
      return;
    }

    const config = readConfig();
    const association = this.resolveAssociationCached(document.uri.fsPath);

    let tsAnalysis: TsAnalysisResult | undefined;
    let associationContext: AssociationContext = {
      status: association.status,
      tsPath: association.tsPath,
      candidates: association.candidates
    };
    if (association.status === 'resolved' && association.tsPath) {
      const analysis = this.getTsAnalysis(association.tsPath);
      if (analysis) {
        tsAnalysis = analysis;
      } else {
        associationContext = { status: 'unreadable', tsPath: association.tsPath };
      }
    }

    const diagnostics = validateQuickView({
      jsonText: document.getText(),
      config,
      tsAnalysis,
      association: associationContext
    });

    // Setting the collection for this URI atomically replaces stale results.
    this.diagnosticCollection.set(document.uri, toVscodeDiagnostics(diagnostics, document));

    const summary: ValidationSummary = {
      errors: diagnostics.filter((d) => d.severity === 'error').length,
      warnings: diagnostics.filter((d) => d.severity === 'warning').length,
      information: diagnostics.filter((d) => d.severity === 'information').length,
      tsPath: association.status === 'resolved' ? association.tsPath : undefined,
      associationStatus: associationContext.status
    };
    this.summaries.set(document.uri.fsPath, summary);
  }

  // ------------------------------------------------------------- commands

  private activeQuickViewDocument(): vscode.TextDocument | undefined {
    const document = vscode.window.activeTextEditor?.document;
    return document && this.isQuickViewDocument(document) ? document : undefined;
  }

  /**
   * Two-step wizard: the user picks the Quick View JSON file and its
   * associated TypeScript file. The pair is pinned in workspace state:
   * pinned JSON files are always validated (even with custom names) and the
   * chosen TypeScript file wins over automatic detection.
   */
  private async commandSelectQuickViewFiles(): Promise<void> {
    // ------------------------------------------------ Step 1: the JSON file
    const activeDocument = vscode.window.activeTextEditor?.document;
    const activeDir =
      activeDocument && activeDocument.uri.scheme === 'file' ? vscode.Uri.file(path.dirname(activeDocument.uri.fsPath)) : undefined;

    const jsonUris = await vscode.window.showOpenDialog({
      title: 'Select the Quick View JSON file (e.g. quickview.json)',
      canSelectMany: false,
      canSelectFiles: true,
      canSelectFolders: false,
      defaultUri: activeDir,
      filters: { JSON: ['json'] }
    });
    if (!jsonUris || jsonUris.length === 0) {
      return;
    }
    const jsonPath = jsonUris[0].fsPath;

    // --------------------------------- Step 2: the associated TypeScript file
    const discovery = discoverTypeScriptCandidates(jsonPath);
    let tsPath: string | undefined;

    if (discovery.all.length > 0) {
      interface CandidateItem extends vscode.QuickPickItem {
        tsPath?: string;
        browse?: boolean;
      }
      const items: CandidateItem[] = [
        ...discovery.all.map((candidate) => ({
          label: baseName(candidate),
          description: candidate === discovery.primary ? `${path.dirname(candidate)} (suggested)` : path.dirname(candidate),
          picked: candidate === discovery.primary,
          tsPath: candidate
        })),
        { label: '$(search) Browse for another file…', description: 'Pick a TypeScript file outside the usual locations', browse: true }
      ];
      const pick = await vscode.window.showQuickPick(items, {
        placeHolder: `Select the Quick View TypeScript file associated with ${baseName(jsonPath)}`
      });
      if (!pick) {
        return;
      }
      tsPath = pick.browse ? await this.browseForTypeScript(path.dirname(jsonPath)) : pick.tsPath;
    } else {
      await vscode.window.showInformationMessage(
        `No Quick View TypeScript file was found next to ${baseName(jsonPath)}. Please pick it manually.`
      );
      tsPath = await this.browseForTypeScript(path.dirname(jsonPath));
    }
    if (!tsPath) {
      return;
    }

    // ------------------------------- Step 3: persist the pair, open, validate
    await this.setManualAssociation(jsonPath, tsPath);
    await this.pinJson(jsonPath);

    let document: vscode.TextDocument;
    try {
      document = await vscode.workspace.openTextDocument(vscode.Uri.file(jsonPath));
    } catch {
      await vscode.window.showErrorMessage(
        `SPFx Quick View Validator: could not open ${baseName(jsonPath)}. The association was still saved.`
      );
      return;
    }
    await vscode.window.showTextDocument(document, { preview: false });
    this.validateNow(document);

    await vscode.window.showInformationMessage(
      `SPFx Quick View Validator: validating ${baseName(jsonPath)} against ${baseName(tsPath)}.`
    );
  }

  private async browseForTypeScript(defaultDirectory: string): Promise<string | undefined> {
    const uris = await vscode.window.showOpenDialog({
      title: 'Select the Quick View TypeScript file',
      canSelectMany: false,
      canSelectFiles: true,
      canSelectFolders: false,
      defaultUri: vscode.Uri.file(defaultDirectory),
      filters: { TypeScript: ['ts'] }
    });
    return uris && uris.length > 0 ? uris[0].fsPath : undefined;
  }

  private async commandValidate(): Promise<void> {    const document = this.activeQuickViewDocument();
    if (!document) {
      await vscode.window.showInformationMessage(
        'SPFx Quick View Validator: open a Quick View template (e.g. quickview.json) first.'
      );
      return;
    }
    this.clearTimer(document);
    this.validateNow(document);
    const summary = this.summaries.get(document.uri.fsPath);
    if (!summary) {
      return;
    }
    const total = summary.errors + summary.warnings + summary.information;
    const message =
      `${baseName(document.uri.fsPath)}: ${summary.errors} error(s), ${summary.warnings} warning(s)` +
      ` — associated TypeScript: ${summary.tsPath ? baseName(summary.tsPath) : summary.associationStatus}`;
    if (summary.errors > 0) {
      await vscode.window.showErrorMessage(message);
    } else if (total > 0) {
      await vscode.window.showWarningMessage(message);
    } else {
      await vscode.window.showInformationMessage(`${message} — no problems found.`);
    }
  }

  private async commandSelectTypeScriptFile(): Promise<void> {
    const document = this.activeQuickViewDocument();
    if (!document) {
      await vscode.window.showInformationMessage(
        'SPFx Quick View Validator: open a Quick View template (e.g. quickview.json) first.'
      );
      return;
    }

    const discovery = discoverTypeScriptCandidates(document.uri.fsPath);
    let selected: string | undefined;

    if (discovery.all.length > 0) {
      const items = discovery.all.map((tsPath) => ({
        label: baseName(tsPath),
        description: path.dirname(tsPath),
        picked: tsPath === discovery.primary,
        tsPath
      }));
      const pick = await vscode.window.showQuickPick(items, {
        placeHolder: 'Select the Quick View TypeScript file associated with this quickview.json'
      });
      selected = pick?.tsPath;
    } else {
      const uris = await vscode.window.showOpenDialog({
        canSelectMany: false,
        canSelectFolders: false,
        canSelectFiles: true,
        filters: { TypeScript: ['ts'] },
        openLabel: 'Associate this file'
      });
      selected = uris && uris.length > 0 ? uris[0].fsPath : undefined;
    }

    if (!selected) {
      return;
    }
    await this.setManualAssociation(document.uri.fsPath, selected);
    this.clearTimer(document);
    this.validateNow(document);
    await vscode.window.showInformationMessage(
      `SPFx Quick View Validator: ${baseName(document.uri.fsPath)} is now associated with ${baseName(selected)}.`
    );
  }

  private async commandShowSummary(): Promise<void> {
    const document = this.activeQuickViewDocument();
    if (!document) {
      await vscode.window.showInformationMessage(
        'SPFx Quick View Validator: open a Quick View template (e.g. quickview.json) first.'
      );
      return;
    }
    this.clearTimer(document);
    this.validateNow(document);

    const summary = this.summaries.get(document.uri.fsPath);
    const association = this.resolveAssociationCached(document.uri.fsPath);
    if (!summary) {
      return;
    }

    const lines: string[] = [];
    lines.push('SPFx Quick View Validator — Validation Summary');
    lines.push('=============================================');
    lines.push(`Quick View JSON : ${document.uri.fsPath}`);
    if (association.status === 'resolved' && association.tsPath) {
      lines.push(`TypeScript file : ${association.tsPath}`);
      const analysis = this.getTsAnalysis(association.tsPath);
      if (analysis) {
        lines.push(`Quick View class: ${analysis.quickViewClassName ?? '(unnamed)'}`);
        lines.push(`Data getter     : ${analysis.hasDataGetter ? 'found' : 'MISSING'}`);
        lines.push(
          `Data properties : ${analysis.dataPropertyNames.size} resolved (${analysis.dataResolution})` +
            (analysis.dataPropertyNames.size > 0 ? ` — ${[...analysis.dataPropertyNames].sort().join(', ')}` : '')
        );
        lines.push(
          `Declared props  : ${analysis.declaredPropertyNames.size} resolved (${analysis.declaredPropertyResolution})`
        );
      }
    } else if (association.status === 'ambiguous') {
      lines.push('TypeScript file : AMBIGUOUS — candidates:');
      for (const candidate of association.candidates) {
        lines.push(`                 - ${candidate}`);
      }
      lines.push('                 Run "SPFx Quick View Validator: Select Associated TypeScript File" to pick one.');
    } else if (summary.associationStatus === 'unreadable') {
      lines.push(`TypeScript file : UNREADABLE (${association.tsPath ?? 'unknown path'})`);
    } else {
      lines.push('TypeScript file : NOT FOUND — data-binding and ID-property checks are skipped.');
    }
    lines.push('');
    lines.push(`Errors: ${summary.errors}   Warnings: ${summary.warnings}   Information: ${summary.information}`);

    const diagnostics = this.diagnosticCollection.get(document.uri) ?? [];
    if (diagnostics.length > 0) {
      lines.push('');
      lines.push('Diagnostics:');
      for (const diagnostic of [...diagnostics]
        .sort((a, b) => a.range.start.line - b.range.start.line || a.range.start.character - b.range.start.character)
        .slice(0, 100)) {
        const code = typeof diagnostic.code === 'string' ? diagnostic.code : String(diagnostic.code ?? '');
        lines.push(
          `  [${diagnostic.severity === vscode.DiagnosticSeverity.Error ? 'ERROR' : diagnostic.severity === vscode.DiagnosticSeverity.Warning ? 'WARN ' : 'INFO '}] ` +
            `${baseName(document.uri.fsPath)}:${diagnostic.range.start.line + 1}:${diagnostic.range.start.character + 1} ` +
            `${code}: ${diagnostic.message}`
        );
      }
      if (diagnostics.length > 100) {
        lines.push(`  ... and ${diagnostics.length - 100} more.`);
      }
    }

    this.output.clear();
    this.output.appendLine(lines.join('\n'));
    this.output.show(true);

    const totals = `${summary.errors} error(s), ${summary.warnings} warning(s)`;
    if (summary.errors > 0) {
      await vscode.window.showErrorMessage(`SPFx Quick View Validator: ${totals} in ${baseName(document.uri.fsPath)}. See the output channel for details.`);
    } else {
      await vscode.window.showInformationMessage(`SPFx Quick View Validator: ${totals} in ${baseName(document.uri.fsPath)}. See the output channel for details.`);
    }
  }

  private async commandGoToConflictingId(
    uriString: string,
    occurrences: Array<{ offset: number; length: number; path: string; line: number; column: number }>
  ): Promise<void> {
    if (!Array.isArray(occurrences) || occurrences.length === 0) {
      return;
    }
    let document: vscode.TextDocument;
    try {
      document = await vscode.workspace.openTextDocument(vscode.Uri.parse(uriString));
    } catch {
      return;
    }

    const reveal = (occurrence: (typeof occurrences)[number]): void => {
      const range = new vscode.Range(document.positionAt(occurrence.offset), document.positionAt(occurrence.offset + occurrence.length));
      void vscode.window.showTextDocument(document, { selection: range });
    };

    if (occurrences.length === 1) {
      reveal(occurrences[0]);
      return;
    }

    const pick = await vscode.window.showQuickPick(
      occurrences.map((occurrence) => ({
        label: `${occurrence.path}  (line ${occurrence.line}, column ${occurrence.column})`,
        occurrence
      })),
      { placeHolder: `${occurrences.length} elements share this ID — pick one to navigate to` }
    );
    if (pick) {
      reveal(pick.occurrence);
    }
  }

  private async commandOpenTypeScriptFile(tsPath: string, line: number, column: number): Promise<void> {
    if (!tsPath) {
      return;
    }
    try {
      const document = await vscode.workspace.openTextDocument(tsPath);
      const editor = await vscode.window.showTextDocument(document, { preview: false });
      const position = new vscode.Position(Math.max((line || 1) - 1, 0), Math.max((column || 1) - 1, 0));
      editor.selection = new vscode.Selection(position, position);
      editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter);
    } catch {
      await vscode.window.showErrorMessage(`SPFx Quick View Validator: could not open ${tsPath}.`);
    }
  }
}

let controller: ExtensionController | undefined;

/** VS Code entry point: builds the controller and registers everything. */
export function activate(context: vscode.ExtensionContext): void {
  controller = new ExtensionController(context);
  controller.register();
}

/** VS Code exit point: cancels timers and disposes all subscriptions. */
export function deactivate(): void {
  controller?.dispose();
  controller = undefined;
}

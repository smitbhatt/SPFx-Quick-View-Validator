/** Command identifiers registered by the extension. */
export const CommandIds = {
  validate: 'spfxQuickViewValidator.validate',
  selectQuickViewFiles: 'spfxQuickViewValidator.selectQuickViewFiles',
  selectTypeScriptFile: 'spfxQuickViewValidator.selectTypeScriptFile',
  showSummary: 'spfxQuickViewValidator.showSummary',
  /** Internal: reveal all occurrences of a duplicated element ID. */
  goToConflictingId: 'spfxQuickViewValidator.goToConflictingId',
  /** Internal: replace one duplicate occurrence with a freshly generated unique ID. */
  fixDuplicateId: 'spfxQuickViewValidator.fixDuplicateId',
  /** Internal: open the associated TypeScript file (at the data getter). */
  openTypeScriptFile: 'spfxQuickViewValidator.openTypeScriptFile'
} as const;

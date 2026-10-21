import { BaseAdaptiveCardView } from '@microsoft/sp-adaptive-card-extension-base';
import { IQuickViewData, IQuickViewProperties } from './quickViewDefinition';

/**
 * Rich fixture used by the context-aware data-binding tests: arrays, nested
 * arrays, optional values, index signatures and dynamic (HTTP) values.
 */
export class QuickView extends BaseAdaptiveCardView<IQuickViewProperties, IQuickViewData> {
  private _employee: IQuickViewData['employee'] = {
    department: { name: 'Engineering' },
    profileUrl: 'https://example.com/profile'
  };

  public get data(): IQuickViewData {
    return {
      employeeName: 'Smit',
      eAuditUrl: 'https://example.com/audits',
      employee: this._employee,
      tasks: [
        { title: 'Review code', completed: false, subtasks: [{ label: 'Read diff' }] }
      ],
      workdayPDRData: {
        dueOrOverdue: [
          { teammateName: 'Ada', awaitingStepDueDate: '2026-01-01', dayRemaining: 3 }
        ]
      },
      theme: { accentColor: '#0078d4' },
      metadata: {
        anything: 'dynamic map value'
      },
      serverPayload: this._httpResponse()
    };
  }

  private _httpResponse(): unknown {
    return this.properties.remoteData;
  }

  public get template(): string {
    return 'QuickViewTemplate';
  }
}

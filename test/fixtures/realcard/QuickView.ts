import { BaseAdaptiveCardView } from '@microsoft/sp-adaptive-card-extension-base';
import { IProperties, IData } from './definition';

export class QuickView extends BaseAdaptiveCardView<IProperties, IData> {
  public get data(): IData {
    return {
      employeeName: this.properties.employeeName,
      workdayInboxUrl: this.properties.workdayInboxUrl,
      workdayPDRData: {
        dueOrOverdue: [
          {
            teammateName: 'Ada',
            awaitingStepDueDate: '2026-02-01',
            dayRemaining: 3
          }
        ]
      }
    };
  }
}

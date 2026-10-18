import { BaseAdaptiveCardView } from '@microsoft/sp-adaptive-card-extension-base';
import { IQuickViewData, IQuickViewProperties } from './quickViewDefinition';

export class QuickView extends BaseAdaptiveCardView<IQuickViewProperties, IQuickViewData> {
  public get data(): IQuickViewData {
    return {
      employeeName: (this.properties as IQuickViewProperties).employeeName,
      employeeEmail: (this.properties as IQuickViewProperties).employeeEmail,
      employee: {
        name: 'Ada Lovelace',
        email: 'ada@example.com',
        address: {
          city: 'Redmond',
          zip: '98052'
        }
      }
    };
  }

  public get template(): string {
    // In real SPFx projects the template is loaded from quickview.json.
    return 'QuickViewTemplate';
  }
}

import { IBaseData } from './BaseViewData';

export interface IExtData extends IBaseData {
  extra: string;
}

export class QuickView {
  public get data(): IExtData {
    return {
      shared: 'from base',
      extra: 'from derived'
    };
  }
}

interface IQuickViewData {
  title: string;
  subtitle: string;
}

export class QuickView {
  private _data: IQuickViewData = {
    title: 'Hello',
    subtitle: 'World'
  };

  public get data() {
    return this._data;
  }
}

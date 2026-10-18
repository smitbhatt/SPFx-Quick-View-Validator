interface IBaseData {
  title: string;
}

export class QuickView {
  private _base: IBaseData = { title: 'Base' };

  public get data() {
    return {
      ...this._base,
      subtitle: 'Spread'
    };
  }
}

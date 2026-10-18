interface IQuickViewData {
  a: string;
  b: string;
}

function random(): boolean {
  return Math.random() > 0.5;
}

export class QuickView {
  private _fallback: IQuickViewData = { a: '', b: '' };

  public get data(): IQuickViewData {
    if (random()) {
      return { a: 'first', b: 'second' };
    }
    return this._fallback;
  }
}

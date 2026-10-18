interface IData {
  a: string;
  b: string;
}

function random(): boolean {
  return Math.random() > 0.5;
}

export class QuickView {
  private _fallback: IData = { a: '', b: '' };

  public get data() {
    if (random()) {
      return { a: 'first', b: 'second' };
    }
    return this._fallback;
  }
}

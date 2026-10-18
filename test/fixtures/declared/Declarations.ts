interface IBaseProps {
  baseProp: string;
}

interface IDerivedProps extends IBaseProps {
  derivedProp: string;
}

type ViewAlias = {
  aliasProp: number;
};

class ViewState {
  public classProp = 'x';
  private secret = 1;

  public describe(param: string): string {
    const local = param + this.secret;
    return local;
  }
}

export function helper(): ViewState {
  return new ViewState();
}

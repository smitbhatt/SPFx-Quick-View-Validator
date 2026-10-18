export interface IAddress {
  city: string;
  zip: string;
}

export interface IEmployeeInfo {
  name: string;
  email: string;
  address: IAddress;
}

export interface IQuickViewData {
  employeeName: string;
  employeeEmail: string;
  employee: IEmployeeInfo;
}

export interface IQuickViewProperties {
  employeeName: string;
  employeeEmail: string;
}

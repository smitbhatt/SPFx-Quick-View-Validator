export interface IDepartment {
  name: string;
}

export interface IEmployee {
  department: IDepartment;
  profileUrl: string;
}

export interface ISubTask {
  label: string;
}

export interface ITask {
  title: string;
  completed: boolean;
  subtasks: ISubTask[];
}

export interface IPDRItem {
  teammateName: string;
  awaitingStepDueDate: string;
  dayRemaining: number;
}

export interface IWorkdayPDRData {
  dueOrOverdue: IPDRItem[];
}

export interface ITheme {
  accentColor: string;
}

export interface IQuickViewData {
  employeeName: string;
  eAuditUrl: string;
  employee: IEmployee;
  tasks: ITask[];
  workdayPDRData: IWorkdayPDRData;
  theme: ITheme;
  /** A dictionary with arbitrary keys. */
  metadata: { [key: string]: string };
  /** Dynamically assembled payload — cannot be verified statically. */
  serverPayload: unknown;
}

export interface IQuickViewProperties {
  remoteData: unknown;
}

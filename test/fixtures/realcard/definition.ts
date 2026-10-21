export interface IPDRItem {
  teammateName: string;
  awaitingStepDueDate: string;
  dayRemaining: number;
}

export interface IWorkdayPDRData {
  dueOrOverdue: IPDRItem[];
}

export interface IData {
  employeeName: string;
  workdayInboxUrl: string;
  workdayPDRData: IWorkdayPDRData;
}

export interface IProperties {
  employeeName: string;
  workdayInboxUrl: string;
}

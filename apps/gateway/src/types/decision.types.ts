export enum Decision {
  ACCEPT = 'ACCEPT',
  REJECT = 'REJECT',
  HOLD = 'HOLD',
  REVIEW = 'REVIEW',
}

export enum DecisionLookupStatus {
  FOUND = 'FOUND',
  NOT_FOUND = 'NOT_FOUND',
}

export interface DecisionRecord {
  decisionId: string;
  ecosystem: 'npm';
  packageName: string;
  version: string;
  integrity?: string;
  decision: Decision;
  policyKey?: string;
  policyVersion?: string;
  evaluatedAt: string;
}

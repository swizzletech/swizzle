export interface ApiContractChange {
  readonly api: string | null;
  readonly expected: string | null;
  readonly field: string | null;
  readonly got: string | null;
}

export interface ApiCheckReport {
  readonly ok: boolean;
  readonly checked: readonly string[];
  readonly change: ApiContractChange | null;
}

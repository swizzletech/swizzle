/** The field an API check's parser found changed. Null members were not named by the check. */
export interface ApiContractChange {
  readonly api: string | null;
  readonly expected: string | null;
  readonly field: string | null;
  readonly got: string | null;
}

/** A check's parsed answer. Raw stdout is diagnostic text, never the read model. */
export interface ApiCheckReport {
  readonly ok: boolean;
  readonly checked: readonly string[];
  readonly change: ApiContractChange | null;
}

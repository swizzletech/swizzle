export interface ApprovalDetailField {
  readonly label: string;
  readonly value: string;
  readonly json: boolean;
}

export interface ApprovalDetailsInWords {
  readonly heading: string | null;
  readonly fields: readonly ApprovalDetailField[];
}

const HEADING_KEYS = ["message", "question", "summary", "title"] as const;

export function approvalDetailsInWords(details: unknown): ApprovalDetailsInWords {
  if (details === null || details === undefined) return { fields: [], heading: null };
  if (typeof details === "string") return { fields: [], heading: details };
  if (typeof details !== "object" || Array.isArray(details)) {
    return {
      fields: [{ json: true, label: "Details", value: JSON.stringify(details) }],
      heading: null,
    };
  }
  const record = details as Record<string, unknown>;
  const headingKey = HEADING_KEYS.find(
    (key) => typeof record[key] === "string" && record[key] !== "",
  );
  const fields = Object.entries(record)
    .filter(([key]) => key !== headingKey)
    .map(
      ([label, value]): ApprovalDetailField =>
        typeof value === "string" || typeof value === "number" || typeof value === "boolean"
          ? { json: false, label, value: String(value) }
          : { json: true, label, value: JSON.stringify(value) },
    );
  return { fields, heading: headingKey === undefined ? null : (record[headingKey] as string) };
}

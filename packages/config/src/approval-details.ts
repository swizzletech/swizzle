/**
 * How a person reads the details an automation passes with an approval: the public approval page
 * (apps/api) and the dashboard's approval card both render this, so the one who decides sees the
 * same fields on either.
 */

/** One labelled line: the field's key, its value as text, and whether that text is compact JSON. */
export interface ApprovalDetailField {
  readonly label: string;
  readonly value: string;
  readonly json: boolean;
}

export interface ApprovalDetailsInWords {
  /** The question or summary to show as the heading; null when the details name none. */
  readonly heading: string | null;
  readonly fields: readonly ApprovalDetailField[];
}

/** The keys whose text heads the details, in the order they are looked for. */
const HEADING_KEYS = ["message", "question", "summary", "title"] as const;

/**
 * A string is the heading. In an object, the first non-empty string under message, question,
 * summary or title is the heading, and every other key becomes a labelled field: strings, numbers
 * and booleans as they are, nested values as compact JSON. Any other value is one JSON field.
 */
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

import { eq } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";

import type { Subject } from "./access.js";

export interface SubjectColumns {
  readonly userId: PgColumn;
  readonly teamId: PgColumn;
  readonly serviceAccountId: PgColumn;
}

export function subjectColumn(table: SubjectColumns, subject: Subject): PgColumn {
  switch (subject.kind) {
    case "user":
      return table.userId;
    case "team":
      return table.teamId;
    case "service-account":
      return table.serviceAccountId;
  }
}

function subjectId(subject: Subject): string {
  switch (subject.kind) {
    case "user":
      return subject.userId;
    case "team":
      return subject.teamId;
    case "service-account":
      return subject.serviceAccountId;
  }
}

export function subjectValues(subject: Subject) {
  return {
    serviceAccountId: subject.kind === "service-account" ? subject.serviceAccountId : null,
    teamId: subject.kind === "team" ? subject.teamId : null,
    userId: subject.kind === "user" ? subject.userId : null,
  };
}

export function namesSubject(table: SubjectColumns, subject: Subject) {
  return eq(subjectColumn(table, subject), subjectId(subject));
}

export function subjectOfRow(row: {
  readonly userId: string | null;
  readonly teamId: string | null;
  readonly serviceAccountId: string | null;
}): Subject {
  if (row.userId !== null) return { kind: "user", userId: row.userId };
  if (row.teamId !== null) return { kind: "team", teamId: row.teamId };
  return { kind: "service-account", serviceAccountId: row.serviceAccountId ?? "" };
}

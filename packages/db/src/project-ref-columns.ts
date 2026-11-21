import type { AnyPgColumn } from "drizzle-orm/pg-core";

type ProjectColumns = {
  readonly id: AnyPgColumn;
  readonly slug: AnyPgColumn;
  readonly name: AnyPgColumn;
};

export function projectRefColumns<T extends ProjectColumns>(
  table: T,
): Pick<T, "id" | "slug" | "name"> {
  return { id: table.id, name: table.name, slug: table.slug };
}

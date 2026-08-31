export * from "../../src/db/schema/index";

import { pgTable, text } from "drizzle-orm/pg-core";

export const deliberateSchemaDriftProbe = pgTable("schema_drift_probe", {
  id: text("id").primaryKey(),
});

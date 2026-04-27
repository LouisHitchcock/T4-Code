import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { inferProviderFromModelSlug } from "@draft/shared/model";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_projects)
  `;

  if (!columns.some((column) => column.name === "default_provider")) {
    yield* sql`
      ALTER TABLE projection_projects
      ADD COLUMN default_provider TEXT
    `;
  }

  const projectRows = yield* sql<{
    readonly projectId: string;
    readonly defaultModel: string | null;
    readonly defaultProvider: string | null;
  }>`
    SELECT
      project_id AS "projectId",
      default_model AS "defaultModel",
      default_provider AS "defaultProvider"
    FROM projection_projects
  `;

  for (const row of projectRows) {
    const needsBackfill =
      row.defaultProvider === null || row.defaultProvider.trim().length === 0;
    if (!needsBackfill) {
      continue;
    }

    yield* sql`
      UPDATE projection_projects
      SET default_provider = ${inferProviderFromModelSlug(row.defaultModel)}
      WHERE project_id = ${row.projectId}
    `;
  }
});

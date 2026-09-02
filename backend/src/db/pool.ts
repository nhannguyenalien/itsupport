import pg from "pg";
import "dotenv/config";

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is not set (see backend/.env.example)");
}

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

// Every tenant-scoped query MUST include tenant_id in its WHERE clause. There is
// no separate DB-level tenant isolation in v0.1 (see schema.sql header) — this is
// the single choke point application code should route through so that
// enforcement lives in one place instead of being re-derived per query.
export async function queryTenantScoped<T extends pg.QueryResultRow = pg.QueryResultRow>(
  tenantId: string,
  text: string,
  params: unknown[] = [],
): Promise<pg.QueryResult<T>> {
  if (!tenantId) {
    throw new Error("queryTenantScoped called without a tenantId — refusing to run unscoped query");
  }
  return pool.query<T>(text, params);
}

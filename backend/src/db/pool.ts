import { AsyncLocalStorage } from "node:async_hooks";
import pg from "pg";
import "dotenv/config";

const { Pool } = pg;

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not set (see backend/.env.example)");

const tenantContext = new AsyncLocalStorage<{ tenantId?: string }>();
const appPool = new Pool({ connectionString: process.env.DATABASE_URL });

/** Used only for boot migrations, identity lookup, and one-time enrollment. */
export const adminPool = new Pool({
  connectionString: process.env.DATABASE_ADMIN_URL ?? process.env.DATABASE_URL,
});

export function setTenantContext(tenantId: string): void {
  if (!tenantId) throw new Error("refusing to set an empty tenant context");
  const context = tenantContext.getStore();
  if (context) context.tenantId = tenantId;
  else tenantContext.enterWith({ tenantId });
}

export function runWithRequestContext(operation: () => void): void {
  tenantContext.run({}, operation);
}

// Each request query gets its own short transaction. SET LOCAL cannot leak to
// another pooled connection, and PostgreSQL RLS remains the final isolation
// boundary even if a route forgets a tenant_id predicate.
export const pool = {
  async query<T extends pg.QueryResultRow = pg.QueryResultRow>(text: string, params: unknown[] = []): Promise<pg.QueryResult<T>> {
    const context = tenantContext.getStore();
    if (!context?.tenantId) return appPool.query<T>(text, params);
    const client = await appPool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [context.tenantId]);
      const result = await client.query<T>(text, params);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  },
};

export async function queryTenantScoped<T extends pg.QueryResultRow = pg.QueryResultRow>(tenantId: string, text: string, params: unknown[] = []): Promise<pg.QueryResult<T>> {
  if (!tenantId) throw new Error("queryTenantScoped called without a tenantId");
  return tenantContext.run({ tenantId }, () => pool.query<T>(text, params));
}

/** Keep tenant RLS context active across a complete async operation containing
 * multiple queries. Useful at trust-boundary routes where the tenant was
 * resolved from an authenticated identity rather than supplied by the client. */
export async function withTenantContext<T>(tenantId: string, operation: () => Promise<T>): Promise<T> {
  if (!tenantId) throw new Error("withTenantContext called without a tenantId");
  return tenantContext.run({ tenantId }, operation);
}

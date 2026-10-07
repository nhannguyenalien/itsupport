import assert from 'node:assert/strict';
import { test } from 'node:test';

process.env.DATABASE_URL ||= 'postgres://localhost/db_backup_routes_test';
process.env.PLATFORM_ADMIN_EMAILS = 'ops@example.com';
const { default: Fastify } = await import('fastify');
const { dbBackupRoutes } = await import('../src/db-backup/routes.js');

async function appAs(user: Record<string, unknown> | null) {
  const app = Fastify();
  app.decorateRequest('authUser', null);
  app.addHook('preHandler', async (req) => { (req as any).authUser = user; });
  await app.register(dbBackupRoutes);
  return app;
}
const base = { id: 'u1', tenantId: 't1', tenantName: 'T', role: 'admin' };
const endpoints: Array<[string, string]> = [
  ['GET', '/platform/db-backup'], ['PUT', '/platform/db-backup'], ['POST', '/platform/db-backup/test'], ['POST', '/platform/db-backup/run'],
  ['GET', '/platform/db-backup/runs'], ['GET', '/platform/db-backup/snapshots'], ['POST', '/platform/db-backup/verify'], ['POST', '/platform/db-backup/restore'],
];

test('every database backup endpoint refuses everyone but the platform operator', async () => {
  for (const [label, user] of [
    ['no session', null],
    ['tenant admin not on the list', { ...base, email: 'admin@tenant.com' }],
    ['listed email but only a technician', { ...base, email: 'ops@example.com', role: 'technician' }],
  ] as const) {
    const app = await appAs(user);
    for (const [method, url] of endpoints) {
      const res = await app.inject({ method: method as 'GET', url, payload: method === 'GET' ? undefined : {} });
      assert.equal(res.statusCode, 403, `${label}: ${method} ${url} -> ${res.statusCode}`);
      assert.equal(res.json().code, 'PLATFORM_ADMIN_REQUIRED');
    }
    await app.close();
  }
});

import assert from 'node:assert/strict';
import { test } from 'node:test';

process.env.DATABASE_URL ||= 'postgres://localhost/customer_db_routes_test';
const { default: Fastify } = await import('fastify');
const { customerDbBackupRoutes } = await import('../src/db-backup/customer-routes.js');

async function appAs(user: Record<string, unknown> | null) {
  const app = Fastify();
  app.decorateRequest('authUser', null);
  app.addHook('preHandler', async (req) => { (req as any).authUser = user; });
  await app.register(customerDbBackupRoutes);
  return app;
}
const ID = '11111111-1111-4111-8111-111111111111';
const endpoints: Array<[string, string]> = [
  ['GET', '/db-backups'], ['POST', '/db-backups'], ['PATCH', `/db-backups/${ID}`], ['POST', `/db-backups/${ID}/run`], ['GET', `/db-backups/${ID}/runs`],
  ['GET', `/db-backups/${ID}/snapshots`], ['POST', `/db-backups/${ID}/verify`], ['POST', `/db-backups/${ID}/restore`], ['POST', `/db-backups/${ID}/delete`],
];

test('customer database backups need a signed-in technician or admin', async () => {
  for (const [label, user] of [
    ['no session', null],
    ['read-only member', { id: 'u', tenantId: 't', tenantName: 'T', email: 'm@x.com', role: 'member' }],
  ] as const) {
    const app = await appAs(user);
    for (const [method, url] of endpoints) {
      const res = await app.inject({ method: method as 'GET', url, payload: method === 'GET' ? undefined : {} });
      assert.equal(res.statusCode, 403, `${label}: ${method} ${url} -> ${res.statusCode}`);
    }
    await app.close();
  }
});

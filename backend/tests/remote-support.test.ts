import assert from 'node:assert/strict';
import { test, mock } from 'node:test';
import Fastify from 'fastify';
import { meshNodeId, remoteDeviceUrl } from '../src/remote-support/links.js';

process.env.DATABASE_URL ||= 'postgres://localhost/remote_test';
process.env.FIREBASE_PROJECT_ID ||= 'remote-test';
const { adminPool, pool } = await import('../src/db/pool.js');
const { firebaseAuth } = await import('../src/auth/firebase.js');
const { registerAuth } = await import('../src/auth/plugin.js');
const { deviceRoutes } = await import('../src/devices/routes.js');
const { ticketRoutes } = await import('../src/tickets/routes.js');
const device = '11111111-1111-4111-8111-111111111111';

test('MeshCentral links preserve modified base64 IDs and reject arbitrary destinations', () => {
  process.env.MESHCENTRAL_URL = 'https://mesh.example.test';
  const id = '@$' + 'A'.repeat(62);
  const url = new URL(remoteDeviceUrl(id));
  assert.equal(url.origin, 'https://mesh.example.test');
  assert.equal(url.searchParams.get('gotonode'), id);
  assert.equal(url.searchParams.get('viewmode'), '11');
  for (const value of ['https://evil.test', '../other', '', 'node//abc']) assert.equal(meshNodeId.safeParse(value).success, false);
});

for (const scenario of [
  { role: 'member', method: 'GET', path: 'devices', suffix: 'remote-support', own: true },
  { role: 'member', method: 'GET', path: 'tickets', suffix: 'takeover-link', own: true },
  { role: 'technician', method: 'PUT', path: 'devices', suffix: 'remote-support', own: true },
  { role: 'admin', method: 'PUT', path: 'devices', suffix: 'remote-support', own: false },
  { role: 'admin', method: 'GET', path: 'devices', suffix: 'remote-support', own: false },
] as const) test(`${scenario.role} ${scenario.method} ${scenario.path} own=${scenario.own} is denied`, async () => {
  mock.method(firebaseAuth, 'verifyIdToken', async () => ({ uid: 'user', email_verified: true }));
  mock.method(adminPool, 'query', async () => ({ rows: [{ id: 'user', tenant_id: 'tenant', role: scenario.role }] }));
  let writes = 0;
  mock.method(pool, 'query', async (sql: string) => {
    if (sql.startsWith('SELECT 1')) return { rows: [], rowCount: scenario.own ? 1 : 0 };
    writes++; throw new Error('Should not access remote configuration');
  });
  const app = Fastify();
  await registerAuth(app); await deviceRoutes(app); await ticketRoutes(app);
  try {
    const result = await app.inject({ method: scenario.method, url: `/${scenario.path}/${device}/${scenario.suffix}`,
      headers: { authorization: 'Bearer test' }, ...(scenario.method === 'PUT' ? { payload: { nodeId: 'A'.repeat(64) } } : {}) });
    assert.ok([403, 404].includes(result.statusCode), result.body);
    assert.equal(writes, 0);
  } finally { await app.close(); mock.restoreAll(); }
});

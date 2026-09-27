import assert from 'node:assert/strict';
import { test, mock } from 'node:test';
import Fastify from 'fastify';

process.env.DATABASE_URL ||= 'postgres://localhost/auth_test';
process.env.FIREBASE_PROJECT_ID ||= 'auth-test';
const { adminPool } = await import('../src/db/pool.js');
const { firebaseAuth } = await import('../src/auth/firebase.js');
const { authRoutes } = await import('../src/auth/routes.js');
const { registerAuth } = await import('../src/auth/plugin.js');

const existingUser = { id: 'u1', tenant_id: 't1', tenant_name: 'Existing', email: 'person@gmail.com', role: 'admin', firebase_uid: 'google-uid' };

for (const scenario of [
  { name: 'new Google user gets one workspace with normalized email', existing: null, verified: true, status: 201, insert: true },
  { name: 'repeat login reuses existing workspace', existing: existingUser, verified: true, status: 200 },
  { name: 'verified Google email links a legacy user', existing: { ...existingUser, firebase_uid: null }, verified: true, status: 200, link: true },
  { name: 'unverified email cannot claim a legacy workspace', existing: { ...existingUser, firebase_uid: null }, verified: false, status: 403 },
  { name: 'different Firebase UID cannot claim existing workspace', existing: { ...existingUser, firebase_uid: 'other' }, verified: true, status: 409 },
]) {
  test(scenario.name, async () => {
    const queries: Array<{ sql: string; args?: unknown[] }> = [];
    let released = false;
    const client = {
      async query(sql: string, args?: unknown[]) {
        queries.push({ sql, args });
        if (sql.includes('FROM users')) return { rows: scenario.existing ? [scenario.existing] : [] };
        if (sql.includes('INSERT INTO tenants')) return { rows: [{ id: 'new-tenant', name: 'New team' }] };
        if (sql.includes('INSERT INTO users')) return { rows: [{ id: 'new-user', email: args?.[1], role: 'admin' }] };
        return { rows: [] };
      },
      release() { released = true; },
    };
    mock.method(adminPool, 'connect', async () => client);
    mock.method(firebaseAuth, 'verifyIdToken', async () => ({ uid: 'google-uid', email: ' Person@Gmail.com ', email_verified: scenario.verified }));
    const app = Fastify();
    await registerAuth(app);
    await authRoutes(app);
    try {
      const response = await app.inject({ method: 'POST', url: '/auth/register', headers: { authorization: 'Bearer test' }, payload: { companyName: 'New team' } });
      assert.equal(response.statusCode, scenario.status, response.body);
      assert.equal(queries.some(q => q.sql.includes('INSERT INTO tenants')), !!scenario.insert);
      assert.equal(queries.some(q => q.sql.includes('UPDATE users')), !!scenario.link);
      assert.equal(queries.at(-1)?.sql, scenario.status < 400 ? 'COMMIT' : 'ROLLBACK');
      assert.equal(released, true);
      if (scenario.insert) assert.equal(response.json().user.email, 'person@gmail.com');
      else if (scenario.status === 200) assert.equal(response.json().user.tenantId, 't1');
    } finally { await app.close(); mock.restoreAll(); }
  });
}

test('API rejects missing/expired tokens and distinguishes users needing a workspace', async () => {
  mock.method(firebaseAuth, 'verifyIdToken', async (token: string) => {
    if (token === 'expired') throw new Error('expired');
    return { uid: 'google-uid', email_verified: token !== 'unverified' };
  });
  mock.method(adminPool, 'query', async () => ({ rows: [] }));
  const app = Fastify();
  await registerAuth(app);
  await authRoutes(app);
  try {
    for (const [token, status, code] of [[null, 401, undefined], ['expired', 401, undefined], ['unverified', 403, 'EMAIL_NOT_VERIFIED'], ['valid', 403, 'WORKSPACE_REQUIRED']] as const) {
      const response = await app.inject({ url: '/auth/me', headers: token ? { authorization: `Bearer ${token}` } : {} });
      assert.equal(response.statusCode, status);
      assert.equal(response.json().code, code);
    }
  } finally { await app.close(); mock.restoreAll(); }
});

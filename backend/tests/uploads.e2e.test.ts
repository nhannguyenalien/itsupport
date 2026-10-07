import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';

// Web uploads on the shared storage, against a real Postgres (non-superuser app role)
// with a fake credential minter and a fake object store standing in for R2: the
// presigned flow, quota (including reservations and a lying client), download,
// delete, roles, workspace isolation and cleanup of abandoned uploads.
// Runs only with DBBACKUP_E2E=1 (see docs/backup.md).
const enabled = process.env.DBBACKUP_E2E === '1';
const t = enabled ? test : test.skip;
const MB = 2 ** 20;

t('web uploads: presigned PUT, quota, download, delete, roles and isolation', async () => {
  process.env.OAUTH_TOKEN_ENC_KEY ||= Buffer.alloc(32, 5).toString('base64');
  const { default: Fastify } = await import('fastify');
  const { ZodError } = await import('zod');
  const { adminPool } = await import('../src/db/pool.js');
  const platform = await import('../src/db-backup/service.js');
  const { uploadRoutes } = await import('../src/uploads/routes.js');
  const { cleanFileName } = await import('../src/uploads/service.js');
  const { setMinter, clearCredentialCache } = await import('../src/backup/r2-credentials.js');

  const mkTenant = async (name: string) => (await adminPool.query(`INSERT INTO tenants (name) VALUES ($1) RETURNING id`, [name])).rows[0].id as string;
  const tenantId = await mkTenant('Uploads A'), otherTenant = await mkTenant('Uploads B');
  const ENDPOINT = 'https://acct.r2.cloudflarestorage.com';
  await platform.saveSettings({ enabled: false, repo: `s3:${ENDPOINT}/bucket/sys`, env: { RESTIC_PASSWORD: 'p', AWS_ACCESS_KEY_ID: 'OPERATOR-KEY-ID', AWS_SECRET_ACCESS_KEY: 'OPERATOR-SECRET' }, intervalHours: 24, retention: { keepDaily: 7, keepWeekly: 4, keepMonthly: 6 } });
  const minted: Array<{ bucket: string; prefix: string }> = [];
  clearCredentialCache();
  setMinter({ async mint(loc, ttl) { minted.push(loc); return { accessKeyId: 'TMP-ID', secretAccessKey: 'TMP-SECRET', sessionToken: 'TMP-SESSION', expiresAt: Date.now() + ttl * 1000 }; } });

  // fake R2: object path -> size; the "browser" PUT is simulated by writing to it
  const store = new Map<string, number>(), calls: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: any, init?: RequestInit) => {
    const url = String(input);
    if (!url.startsWith(ENDPOINT)) return realFetch(input, init);
    const path = new URL(url).pathname, method = init?.method ?? 'GET';
    calls.push(`${method} ${path}`);
    assert.ok(String((init?.headers as any)?.Authorization).includes('TMP-ID/'), 'server calls use the temporary key, never the operator key');
    if (method === 'HEAD') return store.has(path) ? new Response(null, { status: 200, headers: { 'content-length': String(store.get(path)) } }) : new Response(null, { status: 404 });
    if (method === 'DELETE') { store.delete(path); return new Response(null, { status: 204 }); }
    return new Response(null, { status: 405 });
  }) as typeof fetch;

  let role = 'admin', tenant = tenantId;
  const app = Fastify();
  app.setErrorHandler((err, _req, reply) => { reply.code(err instanceof ZodError ? 400 : 500).send({ error: err.message }); });
  app.decorateRequest('authUser', null);
  app.addHook('preHandler', async (req) => { (req as any).authUser = { id: randomUUID(), tenantId: tenant, tenantName: 'T', email: 'a@t.com', role }; });
  await app.register(uploadRoutes);
  const start = (name: string, size: number) => app.inject({ method: 'POST', url: '/files/uploads', payload: { name, size, content_type: 'application/pdf' } });
  const pathOf = (uploadUrl: string) => new URL(uploadUrl).pathname;
  const list = async () => (await app.inject({ method: 'GET', url: '/files' })).json();

  try {
    assert.equal(cleanFileName('../../etc/passwd'), 'passwd'); assert.equal(cleanFileName('C:\\x\\bao cao.pdf'), 'bao cao.pdf'); assert.equal(cleanFileName('...'), 'file');

    const empty = await list();
    assert.equal(empty.storage_ready, true); assert.equal(empty.files.length, 0); assert.equal(empty.limit_bytes, 2 ** 30);

    // 1. start -> presigned URL scoped to this workspace's prefix, signed with the temporary key
    const s1 = await start('Báo cáo.pdf', 300 * MB);
    assert.equal(s1.statusCode, 201, s1.body);
    const up = s1.json();
    assert.ok(pathOf(up.upload_url).startsWith(`/bucket/sys/uploads-${tenantId}/`));
    assert.match(up.upload_url, /X-Amz-Credential=TMP-ID/); assert.match(up.upload_url, /X-Amz-Security-Token=TMP-SESSION/);
    for (const secret of ['OPERATOR', 'TMP-SECRET']) assert.ok(!up.upload_url.includes(secret));
    assert.deepEqual(minted.at(-1), { bucket: 'bucket', prefix: `sys/uploads-${tenantId}` });

    // 2. completing before the bytes arrive is refused; after the PUT it is accepted with the REAL size
    assert.equal((await app.inject({ method: 'POST', url: `/files/${up.id}/complete` })).statusCode, 409);
    store.set(pathOf(up.upload_url), 300 * MB);
    const done = await app.inject({ method: 'POST', url: `/files/${up.id}/complete` });
    assert.equal(done.statusCode, 200, done.body); assert.equal(done.json().status, 'ready');
    let l = await list();
    assert.deepEqual(l.files.map((f: any) => [f.name, f.size_bytes]), [['Báo cáo.pdf', 300 * MB]]); assert.equal(l.upload_bytes, 300 * MB);

    // 3. quota: Free = 1 GB. 800 MB more is refused; 600 MB fits and is RESERVED so a second 600 MB is refused
    assert.equal((await start('big.bin', 800 * MB)).statusCode, 402);
    const s2 = await start('b.bin', 600 * MB); assert.equal(s2.statusCode, 201);
    const refused = await start('c.bin', 600 * MB);
    assert.equal(refused.statusCode, 402); assert.match(refused.json().error, /Vượt dung lượng gói Free/);
    assert.equal((await start('huge.bin', 6 * 2 ** 30)).statusCode, 413);

    // 4. a client that declares 600 MB but uploads 900 MB is caught at completion; the object is deleted
    store.set(pathOf(s2.json().upload_url), 900 * MB);
    const lied = await app.inject({ method: 'POST', url: `/files/${s2.json().id}/complete` });
    assert.equal(lied.statusCode, 402);
    assert.ok(!store.has(pathOf(s2.json().upload_url)), 'the oversize object is removed from storage');
    assert.equal((await list()).files.length, 1);

    // 5. download link: short-lived GET that names the file
    const dl = (await app.inject({ method: 'GET', url: `/files/${up.id}/download` })).json();
    assert.match(dl.url, /X-Amz-Expires=300/); assert.match(dl.url, /response-content-disposition=attachment/); assert.match(decodeURIComponent(dl.url), /filename\*=UTF-8''B%C3%A1o%20c%C3%A1o\.pdf/);

    // 6. roles and isolation
    role = 'member';
    assert.equal((await start('x', 1)).statusCode, 403); assert.equal((await app.inject({ method: 'DELETE', url: `/files/${up.id}` })).statusCode, 403);
    assert.equal((await list()).files.length, 1, 'members can still see the files');
    assert.equal((await app.inject({ method: 'GET', url: `/files/${up.id}/download` })).statusCode, 200);
    role = 'admin'; tenant = otherTenant;
    assert.equal((await app.inject({ method: 'GET', url: `/files/${up.id}/download` })).statusCode, 404);
    assert.equal((await app.inject({ method: 'DELETE', url: `/files/${up.id}` })).statusCode, 404);
    assert.equal((await list()).files.length, 0);
    tenant = tenantId;

    // 7. abandoned uploads are cleaned up after a day and stop holding quota
    const s3 = await start('abandoned.bin', 500 * MB); assert.equal(s3.statusCode, 201);
    store.set(pathOf(s3.json().upload_url), 500 * MB);
    await adminPool.query(`UPDATE tenant_files SET created_at = now() - interval '2 days' WHERE id = $1`, [s3.json().id]);
    await list();
    assert.ok(!store.has(pathOf(s3.json().upload_url))); assert.equal(Number((await adminPool.query('SELECT count(*)::int AS n FROM tenant_files WHERE id = $1', [s3.json().id])).rows[0].n), 0);

    // 8. Pro allows more; deleting frees space and removes the object
    await adminPool.query(`UPDATE tenants SET plan = 'pro' WHERE id = $1`, [tenantId]);
    assert.equal((await start('large.iso', 5 * 2 ** 30)).statusCode, 201);
    assert.equal((await app.inject({ method: 'DELETE', url: `/files/${up.id}` })).statusCode, 200);
    assert.ok(!store.has(pathOf(up.upload_url))); assert.equal((await list()).upload_bytes, 0);
  } finally {
    globalThis.fetch = realFetch; setMinter(null); clearCredentialCache(); await app.close();
    await adminPool.query('DELETE FROM tenants WHERE id = ANY($1)', [[tenantId, otherTenant]]);
    await adminPool.end();
  }
});

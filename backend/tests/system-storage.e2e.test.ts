import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';

// Device-file backups on the operator's shared storage, end to end against a real
// Postgres (non-superuser app role, so RLS applies) with a FAKE credential minter:
// policy rules, what the agent is handed, quota, and the scheduler. It needs a
// database with the project schema and only runs with DBBACKUP_E2E=1 (see docs/backup.md).
const enabled = process.env.DBBACKUP_E2E === '1';
const t = enabled ? test : test.skip;

t('device files on the system storage: policy, scoped credentials at delivery, quota and scheduling', async () => {
  process.env.OAUTH_TOKEN_ENC_KEY ||= Buffer.alloc(32, 5).toString('base64');
  const { default: Fastify } = await import('fastify');
  const { ZodError } = await import('zod');
  const { adminPool } = await import('../src/db/pool.js');
  const platform = await import('../src/db-backup/service.js');
  const { backupRoutes } = await import('../src/backup/routes.js');
  const { hydrateBackupParams, backupSchedulerTick } = await import('../src/backup/index.js');
  const { setMinter, clearCredentialCache } = await import('../src/backup/r2-credentials.js');

  // --- fixtures: one workspace on the Free plan, a current device and an old-agent one
  const tenantId = (await adminPool.query(`INSERT INTO tenants (name) VALUES ('System storage test') RETURNING id`)).rows[0].id as string;
  const device = async (host: string, version: string) => (await adminPool.query(
    `INSERT INTO devices (tenant_id, hostname, platform, agent_version, public_key, status, last_seen_at) VALUES ($1,$2,'windows',$3,'pk','online',now()) RETURNING id`,
    [tenantId, host, version])).rows[0].id as string;
  const dev = await device('WIN-NEW', '0.4.2'), old = await device('WIN-OLD', '0.4.1');
  const BASE = 'https://acct.r2.cloudflarestorage.com/bucket/sys';
  await platform.saveSettings({ enabled: false, repo: `s3:${BASE}`, env: { RESTIC_PASSWORD: 'operator-password', AWS_ACCESS_KEY_ID: 'OPERATOR-KEY-ID', AWS_SECRET_ACCESS_KEY: 'OPERATOR-SECRET' }, intervalHours: 24, retention: { keepDaily: 7, keepWeekly: 4, keepMonthly: 6 } });

  const minted: Array<{ bucket: string; prefix: string }> = [];
  let failMint = false;
  clearCredentialCache();
  setMinter({ async mint(loc, ttl) {
    if (failMint) throw new Error('Cloudflare did not issue storage credentials (HTTP 403)');
    minted.push(loc);
    return { accessKeyId: 'TMP-ID', secretAccessKey: 'TMP-SECRET', sessionToken: 'TMP-SESSION', expiresAt: Date.now() + ttl * 1000 };
  } });

  const app = Fastify();
  app.setErrorHandler((err, _req, reply) => { reply.code(err instanceof ZodError ? 400 : 500).send({ error: err.message }); });
  app.decorateRequest('authUser', null);
  app.addHook('preHandler', async (req) => { (req as any).authUser = { id: randomUUID(), tenantId, tenantName: 'T', email: 'a@t.com', role: 'admin' }; });
  await app.register(backupRoutes);
  const put = (id: string, body: object) => app.inject({ method: 'PUT', url: `/devices/${id}/backup`, payload: { enabled: true, paths: ['C:\\Data'], ...body } });
  const call = async (method: 'GET' | 'POST', url: string) => app.inject({ method, url, payload: method === 'POST' ? {} : undefined });
  const pwOf = async (id: string) => (await adminPool.query('SELECT repo_password_enc FROM backup_policies WHERE device_id = $1', [id])).rows[0]?.repo_password_enc as string | null;

  try {
    // 1. the device panel learns the storage is available and what the plan allows
    const info = (await call('GET', `/devices/${dev}/backup`)).json();
    assert.equal(info.system_storage_ready, true);
    assert.equal(info.system_agent_ok, true);
    assert.equal(info.quota.plan, 'free'); assert.equal(info.quota.limit_bytes, 2 ** 30); assert.equal(info.quota.over, false);

    // 2. system storage needs nothing from the customer: no repository, no keys
    const saved = await put(dev, { storage: 'system' });
    assert.equal(saved.statusCode, 200, saved.body);
    assert.equal(saved.json().storage, 'system'); assert.equal(saved.json().repo, ''); assert.deepEqual(saved.json().env_configured, []);
    const pw1 = await pwOf(dev);
    assert.ok(pw1 && pw1.length > 40, 'the platform generated an encrypted password');
    await put(dev, { storage: 'system', interval_hours: 12 });
    assert.equal(await pwOf(dev), pw1, 'saving again must not change the password: that would orphan earlier backups');

    // 3. rules: an old agent cannot use it; a custom repository still needs a repository
    assert.equal((await put(old, { storage: 'system' })).statusCode, 409);
    assert.equal((await put(old, { storage: 'custom', repo: '' })).statusCode, 400);
    assert.equal((await put(old, { storage: 'custom', repo: 'ftp://nope', env: { RESTIC_PASSWORD: 'x' } })).statusCode, 400);

    // 4. at delivery the agent gets keys for ITS prefix only, never the operator's key
    const ran = await call('POST', `/devices/${dev}/backup/run`);
    assert.equal(ran.statusCode, 202, ran.body);
    const pending = (await adminPool.query(`SELECT id, tool, params FROM tool_calls WHERE device_id = $1 AND tool = 'backup.run' AND executed_at IS NULL`, [dev])).rows;
    assert.equal(pending.length, 1); assert.deepEqual(pending[0].params, {}, 'secrets are never stored in the queued call');
    const [delivered] = await hydrateBackupParams(tenantId, dev, pending);
    assert.equal(delivered.params.repo, `s3:${BASE}/files-${tenantId}-${dev}`);
    const env = delivered.params.env as Record<string, string>;
    assert.equal(env.AWS_ACCESS_KEY_ID, 'TMP-ID'); assert.equal(env.AWS_SESSION_TOKEN, 'TMP-SESSION'); assert.ok(env.RESTIC_PASSWORD.length >= 40);
    assert.deepEqual(minted.at(-1), { bucket: 'bucket', prefix: `sys/files-${tenantId}-${dev}` }, 'the key is scoped to this device\'s own prefix');
    const handedOver = JSON.stringify(delivered.params);
    for (const secret of ['OPERATOR-KEY-ID', 'OPERATOR-SECRET', 'operator-password']) assert.ok(!handedOver.includes(secret), `${secret} must never reach an agent`);
    assert.deepEqual((await adminPool.query('SELECT params FROM tool_calls WHERE id = $1', [pending[0].id])).rows[0].params, {});

    // 5. if Cloudflare refuses, only that call fails, with a readable reason, and the poll still works
    await adminPool.query(`UPDATE tool_calls SET executed_at = now(), result = 'success' WHERE id = $1`, [pending[0].id]);
    await adminPool.query(`INSERT INTO tool_calls (device_id, tool, risk, params) VALUES ($1, 'backup.run', 'medium', '{}'), ($1, 'backup.status', 'read', '{}')`, [dev]);
    const batch = (await adminPool.query(`SELECT id, tool, params FROM tool_calls WHERE device_id = $1 AND executed_at IS NULL ORDER BY requested_at`, [dev])).rows;
    clearCredentialCache(); failMint = true;
    const after = await hydrateBackupParams(tenantId, dev, batch);
    failMint = false;
    assert.deepEqual(after.map((c) => c.tool), ['backup.status'], 'the failing call is withheld, the other one is untouched');
    const failed = (await adminPool.query(`SELECT result, error_message FROM tool_calls WHERE id = $1`, [batch.find((b) => b.tool === 'backup.run')!.id])).rows[0];
    assert.equal(failed.result, 'error'); assert.match(failed.error_message, /Không cấp được quyền truy cập kho lưu trữ/);
    await adminPool.query('DELETE FROM tool_calls WHERE device_id = $1 AND executed_at IS NULL', [dev]);

    // 6. quota: the Free plan allows 1 GB; the last successful scan was 2 GB
    await adminPool.query(`INSERT INTO tool_calls (device_id, tool, risk, params, executed_at, result, result_data) VALUES ($1,'backup.status','read','{}', now(), 'success', $2)`,
      [dev, JSON.stringify({ state: 'success', bytes_total: 2 * 2 ** 30 })]);
    assert.equal((await call('GET', `/devices/${dev}/backup`)).json().quota.over, true);
    const blocked = await call('POST', `/devices/${dev}/backup/run`);
    assert.equal(blocked.statusCode, 402); assert.match(blocked.json().error, /Vượt dung lượng gói Free/);

    // 7. the scheduler respects the same rules
    const due = async (id: string) => { await adminPool.query(`UPDATE backup_policies SET last_run_requested_at = NULL WHERE device_id = $1`, [id]); await backupSchedulerTick(); return Number((await adminPool.query(`SELECT count(*)::int AS n FROM tool_calls WHERE device_id = $1 AND tool = 'backup.run' AND executed_at IS NULL`, [id])).rows[0].n); };
    assert.equal(await due(dev), 0, 'over the plan: no new runs');
    await adminPool.query(`UPDATE tenants SET plan = 'pro' WHERE id = $1`, [tenantId]);
    assert.equal(await due(dev), 1, 'on Pro (20 GB) the same data fits and the run is queued');
    // an old agent that somehow has a system policy is skipped, not queued to fail
    await adminPool.query(`INSERT INTO backup_policies (device_id, tenant_id, enabled, repo, secrets_enc, paths, storage, repo_password_enc) VALUES ($1,$2,true,'','x','["C:\\\\x"]','system','y')`, [old, tenantId]);
    assert.equal(await due(old), 0);
  } finally {
    setMinter(null); clearCredentialCache(); await app.close();
    await adminPool.query('DELETE FROM tool_calls WHERE device_id = ANY($1)', [[dev, old]]);
    await adminPool.query('DELETE FROM tenants WHERE id = $1', [tenantId]);
    await adminPool.end();
  }
});

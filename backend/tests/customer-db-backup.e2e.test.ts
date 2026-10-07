import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import pg from 'pg';

// End-to-end check of customer database backups with REAL pg_dump/pg_restore/restic.
// Needs: Postgres with TLS on (app DB with the project schema + a "customer" DB +
// an empty restore target), a restic REST server, tools on PATH, and an app role
// that is NOT a superuser (so row level security really applies). Runs only with
// DBBACKUP_E2E=1; see docs/backup.md.
const enabled = process.env.DBBACKUP_E2E === '1';
const t = enabled ? test : test.skip;

async function waitFor<T>(label: string, read: () => Promise<T | undefined>, ms = 180_000): Promise<T> {
  const until = Date.now() + ms;
  while (Date.now() < until) { const v = await read(); if (v !== undefined) return v; await new Promise(r => setTimeout(r, 400)); }
  throw new Error('timed out waiting for ' + label);
}

t('customer database backups: add by URL, schedule, isolation, restore, delete, and the abuse paths', async () => {
  const appUrl = process.env.DATABASE_URL!, adminUrl = process.env.DATABASE_ADMIN_URL!;
  const customerUrl = process.env.DBBACKUP_E2E_CUSTOMER_URL!, dstUrl = process.env.DBBACKUP_E2E_DST_URL!, repoBase = process.env.DBBACKUP_E2E_REPO!;
  process.env.DBBACKUP_ALLOW_PRIVATE = '1'; // localhost stands in for a public database
  process.env.OAUTH_TOKEN_ENC_KEY ||= Buffer.alloc(32, 9).toString('base64');
  const platform = await import('../src/db-backup/service.js');
  const svc = await import('../src/db-backup/customer-service.js');
  const { adminPool } = await import('../src/db/pool.js');
  const { run, tools } = await import('../src/db-backup/runner.js');

  // two customers (workspaces) and a configured storage
  const tenantA = (await adminPool.query(`INSERT INTO tenants (name) VALUES ('Customer A') RETURNING id`)).rows[0].id as string;
  const tenantB = (await adminPool.query(`INSERT INTO tenants (name) VALUES ('Customer B') RETURNING id`)).rows[0].id as string;
  const userA = { tenantId: tenantA, id: randomUUID() }, userB = { tenantId: tenantB, id: randomUUID() };
  await platform.saveSettings({ enabled: false, repo: repoBase, env: { RESTIC_PASSWORD: 'platform-password-xyz' }, intervalHours: 24, retention: { keepDaily: 7, keepWeekly: 4, keepMonthly: 6 } });

  // Free allows ~10 KB here, so any real database exceeds it; Pro keeps the default 20 GB
  process.env.PLAN_FREE_DB_GB = '0.00001';
  const runFinished = async (tenant: string, backupId: string, pick: (r: any) => boolean) => waitFor('run', async () => {
    const runs = await svc.listRuns(tenant, backupId);
    return runs.find((r: any) => pick(r) && r.state !== 'running');
  });

  // 0. plans: a Free workspace is refused with a clear message, a Pro one is accepted
  assert.equal((await svc.usage(tenantB)).plan, 'free', 'new workspaces start on Free');
  await assert.rejects(() => svc.createTarget(userB, { name: 'Too big for Free', url: customerUrl }),
    (e: any) => e.statusCode === 402 && /gói Free/.test(e.message) && /Nâng cấp lên Pro/.test(e.message));
  assert.deepEqual(await svc.listTargets(tenantB), [], 'a refused database leaves nothing behind');
  await adminPool.query(`UPDATE tenants SET plan = 'pro' WHERE id = $1`, [tenantA]);

  // 1. the customer only pastes a URL; the first backup starts by itself
  const created = await svc.createTarget(userA, { name: 'Production DB', url: customerUrl });
  assert.ok(created.tables >= 3 && created.sizeBytes > 0, 'the connection probe reports the database');
  const first: any = await runFinished(tenantA, created.id, r => r.kind === 'backup');
  assert.equal(first.state, 'success', first.error);
  assert.ok(first.tables_found >= 3, 'the dump was verified by reading it back');

  // 2. the listing shows health and never exposes the URL or secrets
  const listed = await svc.listTargets(tenantA);
  assert.equal(listed.length, 1); assert.equal(listed[0].health, 'ok'); assert.equal(listed[0].name, 'Production DB');
  const blob = JSON.stringify(listed);
  assert.ok(!blob.includes('source_enc') && !blob.includes('repo_password_enc') && !blob.includes(new URL(customerUrl).password || '\0'), 'no secret in the listing');

  // 3. isolation: another customer sees and can touch nothing
  assert.deepEqual(await svc.listTargets(tenantB), []);
  await assert.rejects(() => svc.loadRow(tenantB, created.id), (e: any) => e.statusCode === 404);
  await assert.rejects(() => svc.deleteTarget(tenantB, created.id), (e: any) => e.statusCode === 404);
  // ...and row level security (not just our WHERE clauses) hides it from a tenant-scoped session
  const asB = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const c = await asB.connect();
  try {
    await c.query('BEGIN'); await c.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantB]);
    assert.equal((await c.query('SELECT count(*)::int AS n FROM tenant_db_backups')).rows[0].n, 0, 'RLS hides customer A rows from customer B');
    assert.equal((await c.query('SELECT count(*)::int AS n FROM tenant_db_backup_runs')).rows[0].n, 0);
    await c.query('ROLLBACK');
  } finally { c.release(); await asB.end(); }

  // 4. abuse paths on create
  await assert.rejects(() => svc.createTarget(userA, { name: 'Again', url: customerUrl }), (e: any) => e.statusCode === 409, 'the same database cannot be added twice');
  process.env.CUSTOMER_DB_MAX_PER_TENANT = '1';
  await assert.rejects(() => svc.createTarget(userA, { name: 'Second', url: customerUrl.replace(/\/[^/?]+\?/, '/e2eapp?') }), (e: any) => e.statusCode === 409, 'per-customer limit');
  delete process.env.CUSTOMER_DB_MAX_PER_TENANT;
  await assert.rejects(() => svc.createTarget(userB, { name: 'No TLS', url: customerUrl.replace(/\?.*$/, '') }), /sslmode=require/);
  await assert.rejects(() => svc.createTarget(userB, { name: 'Wrong password', url: customerUrl.replace(/\/\/[^@]*@/, '//nobody:wrong@') }), (e: any) => e.statusCode === 400);
  delete process.env.DBBACKUP_ALLOW_PRIVATE; // now behave like production: internal hosts are refused
  for (const url of ['postgresql://u:p@127.0.0.1/db?sslmode=require', 'postgresql://u:p@10.0.0.7/db?sslmode=require', 'postgresql://u:p@169.254.169.254/db?sslmode=require', 'postgresql://u:p@localhost:5432/db?sslmode=require']) {
    await assert.rejects(() => svc.createTarget(userB, { name: 'SSRF', url }), /công khai/, url);
  }
  process.env.DBBACKUP_ALLOW_PRIVATE = '1';
  assert.deepEqual(await svc.listTargets(tenantB), [], 'refused URLs left nothing behind');

  // 5. a second manual run, and the scheduler picks up a database that is due
  const row = await svc.loadRow(tenantA, created.id);
  const manual = await svc.startBackup(row, 'manual');
  await assert.rejects(() => svc.startBackup(row, 'manual'), (e: any) => e.statusCode === 409, 'one operation per database at a time');
  await runFinished(tenantA, created.id, r => r.id === manual);
  await adminPool.query(`UPDATE tenant_db_backup_runs SET started_at = now() - interval '2 days', finished_at = now() - interval '2 days' WHERE backup_id = $1`, [created.id]);
  await svc.tick();
  const scheduled: any = await runFinished(tenantA, created.id, r => r.trigger === 'schedule');
  assert.equal(scheduled.state, 'success', scheduled.error);

  // 5b. downgrading below the data size makes the next run fail clearly, without a new snapshot
  assert.ok((await svc.usage(tenantA)).usedBytes > 0 && (await svc.usage(tenantA)).plan === 'pro');
  const snapsBeforeDowngrade = (await svc.snapshotsOf(row)).length;
  await adminPool.query(`UPDATE tenants SET plan = 'free' WHERE id = $1`, [tenantA]);
  const deniedId = await svc.startBackup(row, 'manual');
  const deniedRun: any = await runFinished(tenantA, created.id, r => r.id === deniedId);
  assert.equal(deniedRun.state, 'error'); assert.match(deniedRun.error, /Vượt dung lượng gói Free/);
  assert.equal((await svc.snapshotsOf(row)).length, snapsBeforeDowngrade, 'no snapshot is created over the cap');
  await adminPool.query(`UPDATE tenants SET plan = 'pro' WHERE id = $1`, [tenantA]);

  // 6. the stored backup is encrypted with a key of its own, not the platform's
  const storage = await platform.getStorage();
  const repo = `${storage!.base}/customers-${tenantA}-${created.id}`;
  const wrong = await run(tools().restic, ['snapshots', '--no-lock'], { RESTIC_REPOSITORY: repo, RESTIC_PASSWORD: 'platform-password-xyz' });
  assert.notEqual(wrong.code, 0, 'the platform password must not open a customer repository');

  // 7. snapshots, verify, and restore into ANOTHER database
  const snaps = await svc.snapshotsOf(row);
  assert.ok(snaps.length >= 1);
  const v = await svc.startVerify(row, snaps[0].id);
  assert.equal(((await runFinished(tenantA, created.id, r => r.id === v)) as any).state, 'success');
  const restoreId = await svc.startRestore(row, snaps[0].id, dstUrl);
  const restored: any = await runFinished(tenantA, created.id, r => r.id === restoreId);
  assert.equal(restored.state, 'success', restored.error);
  const dst = new pg.Pool({ connectionString: dstUrl }), src = new pg.Pool({ connectionString: customerUrl });
  const count = async (p: pg.Pool) => Number((await p.query(`SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema='public'`)).rows[0].n);
  assert.equal(await count(dst), await count(src), 'the restored database has the same tables');
  await dst.end(); await src.end();
  await assert.rejects(() => svc.startRestore(row, snaps[0].id, customerUrl), (e: any) => e.statusCode === 400 && /đè lên/.test(e.message), 'never restore over the source');

  // 8. pause stops the schedule
  await svc.updateTarget(tenantA, created.id, { enabled: false });
  await adminPool.query(`UPDATE tenant_db_backup_runs SET started_at = now() - interval '9 days', finished_at = now() - interval '9 days' WHERE backup_id = $1`, [created.id]);
  const before = (await svc.listRuns(tenantA, created.id)).length;
  await svc.tick();
  assert.equal((await svc.listRuns(tenantA, created.id)).length, before, 'a paused database is not backed up');

  // 9. delete removes the row and the stored data
  const removed = await svc.deleteTarget(tenantA, created.id);
  assert.ok(removed.removedSnapshots >= 1);
  assert.deepEqual(await svc.listTargets(tenantA), []);
  await adminPool.query('DELETE FROM tenants WHERE id = ANY($1)', [[tenantA, tenantB]]);
  await adminPool.end();
});

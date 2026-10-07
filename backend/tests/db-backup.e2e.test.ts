import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chmodSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';

// End-to-end check of the platform database backup with REAL pg_dump, pg_restore
// and restic. It needs a Postgres with the project schema, a restic REST server
// and the tools on PATH, so it only runs when DBBACKUP_E2E=1 (see docs/backup.md).
//   DBBACKUP_E2E_ADMIN_URL  postgres URL of the database to back up
//   DBBACKUP_E2E_DST_URL    postgres URL of an EMPTY database to restore into
//   DBBACKUP_E2E_REPO       restic repository, e.g. rest:http://127.0.0.1:18001/db-e2e
const enabled = process.env.DBBACKUP_E2E === '1';
const t = enabled ? test : test.skip;

async function waitFor<T>(label: string, read: () => Promise<T | undefined>, ms = 180_000): Promise<T> {
  const until = Date.now() + ms;
  while (Date.now() < until) { const v = await read(); if (v !== undefined) return v; await new Promise(r => setTimeout(r, 400)); }
  throw new Error('timed out waiting for ' + label);
}

t('database backup: backup, retention, verify, restore, and the failure paths', async () => {
  const admin = process.env.DBBACKUP_E2E_ADMIN_URL!, dst = process.env.DBBACKUP_E2E_DST_URL!, repo = process.env.DBBACKUP_E2E_REPO!;
  process.env.DATABASE_URL = admin; process.env.DATABASE_ADMIN_URL = admin;
  process.env.OAUTH_TOKEN_ENC_KEY ||= Buffer.alloc(32, 7).toString('base64');
  const svc = await import('../src/db-backup/service.js');
  const { adminPool } = await import('../src/db/pool.js');

  const finished = async (id: string) => waitFor('run ' + id, async () => {
    const r = (await svc.listRuns(50)).find((x: any) => x.id === id);
    return r && r.state !== 'running' ? r : undefined;
  });
  const configure = (password = 'e2e-password-123') => svc.saveSettings({ enabled: true, repo, env: { RESTIC_PASSWORD: password }, intervalHours: 24, retention: { keepDaily: 2, keepWeekly: 0, keepMonthly: 0 } });

  await adminPool.query('DELETE FROM platform_db_backup_runs');
  // the test brings its own sample rows, so it does not depend on what the database already holds
  await adminPool.query(`DELETE FROM tenants WHERE name LIKE 'Backup sample %'`);
  await adminPool.query(`INSERT INTO tenants (name) SELECT 'Backup sample ' || g FROM generate_series(1,3) g`);
  await configure();

  // 1. first backup streams pg_dump into restic and is verified
  const id1 = await svc.startBackup('manual', 'e2e');
  await assert.rejects(() => svc.startBackup('manual', 'e2e'), (e: any) => e.statusCode === 409, 'a second operation must be refused while one runs');
  const run1: any = await finished(id1);
  assert.equal(run1.state, 'success', run1.error);
  assert.ok(Number(run1.tables_found) >= 15, 'verification must see the schema tables, saw ' + run1.tables_found);
  assert.ok(Number(run1.dump_bytes) > 10_000);
  const snap1 = run1.snapshot_id as string;

  // 2. two more backups with keep-daily=2: restic keeps the newest snapshot and
  //    the oldest of its window, so the one in between must be pruned (3 -> 2).
  const ids = [snap1];
  for (let i = 0; i < 2; i++) { const r: any = await finished(await svc.startBackup('manual', 'e2e')); assert.equal(r.state, 'success', r.error); ids.push(r.snapshot_id); }
  const snaps = await svc.snapshots();
  assert.equal(snaps.length, 2, 'retention must prune, found ' + snaps.length);
  const kept = snaps.map((x: any) => x.id);
  assert.ok(ids[2].startsWith(kept[0]) || kept.some((k: string) => ids[2].startsWith(k)), 'the newest snapshot is kept');
  assert.ok(!kept.some((k: string) => ids[1].startsWith(k)), 'the middle snapshot is pruned');
  const latest = snaps[0].id;

  // 3. health and next run
  const sum = await svc.summary();
  assert.equal(sum.health, 'ok'); assert.ok(sum.lastSuccessAt); assert.ok(sum.nextRunAt);

  // 4. explicit verify
  const v: any = await finished(await svc.startVerify(latest, 'e2e'));
  assert.equal(v.state, 'success', v.error); assert.ok(Number(v.tables_found) >= 15);

  // 5. restore into another database and compare content
  const src = new pg.Pool({ connectionString: admin }), out = new pg.Pool({ connectionString: dst });
  const rest: any = await finished(await svc.startRestore(latest, dst, 'e2e'));
  assert.equal(rest.state, 'success', rest.error);
  for (const table of ['tenants', 'users', 'devices', 'tickets']) {
    const a = (await src.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n, b = (await out.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n;
    assert.equal(b, a, `${table}: restored ${b} rows, source has ${a}`);
  }
  assert.ok((await out.query(`SELECT count(*)::int AS n FROM tenants`)).rows[0].n >= 3, 'sample rows came across');
  await src.end(); await out.end();
  await adminPool.query(`DELETE FROM tenants WHERE name LIKE 'Backup sample %'`);

  // 6. restoring over the live database is refused and nothing in it changes
  const before = (await adminPool.query('SELECT count(*)::int AS n FROM tenants')).rows[0].n;
  const refused: any = await finished(await svc.startRestore(latest, admin, 'e2e'));
  assert.equal(refused.state, 'error'); assert.match(refused.error, /Refusing to restore over the live database/);
  assert.equal((await adminPool.query('SELECT count(*)::int AS n FROM tenants')).rows[0].n, before);

  // 7. a pg_dump that dies midway must not leave a bad snapshot behind
  const broken = join(tmpdir(), 'broken-pg-dump.sh');
  writeFileSync(broken, '#!/bin/sh\nhead -c 4096 /dev/urandom\necho "pg_dump: simulated failure" >&2\nexit 1\n'); chmodSync(broken, 0o755);
  process.env.DBBACKUP_PG_DUMP = broken;
  const bad: any = await finished(await svc.startBackup('manual', 'e2e'));
  delete process.env.DBBACKUP_PG_DUMP;
  assert.equal(bad.state, 'error'); assert.match(bad.error, /pg_dump failed/);
  const after = await svc.snapshots();
  assert.deepEqual(after.map((x: any) => x.id), kept, 'the truncated snapshot must be removed and the good ones untouched');

  // 8. a wrong repository password fails cleanly and never leaks into the error text
  await configure('WRONG-password-xyz');
  const wrong: any = await finished(await svc.startBackup('manual', 'e2e'));
  assert.equal(wrong.state, 'error'); assert.ok(!String(wrong.error).includes('WRONG-password-xyz'));
  await configure();

  // 9. the failure is reflected in health, and the good snapshot is still there
  assert.equal((await svc.summary()).lastBackupState, 'error');
  assert.equal((await svc.snapshots()).length, 2);
  await adminPool.end();
});

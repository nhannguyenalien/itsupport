import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DUMP_NAME, dbBackupHealth, directConnection, isDue, isPlatformAdmin, parsePgUrl, platformAdminEmails, retentionArgs, sameDatabase, scrub,
} from '../src/db-backup/config.js';

const NEON = 'postgresql://app_owner:p%40ss%3Aw0rd@ep-cool-dew-123456.ap-southeast-1.aws.neon.tech/neondb?sslmode=require&channel_binding=require';

test('only a listed tenant admin is a platform admin', () => {
  assert.equal(isPlatformAdmin('Ops@Example.com', 'admin', 'ops@example.com, other@example.com'), true);
  assert.equal(isPlatformAdmin('ops@example.com', 'technician', 'ops@example.com'), false);
  assert.equal(isPlatformAdmin('nobody@example.com', 'admin', 'ops@example.com'), false);
  assert.equal(isPlatformAdmin('ops@example.com', 'admin', ''), false, 'feature is off when the list is empty');
  assert.equal(isPlatformAdmin('ops@example.com', 'admin', undefined), false);
  assert.deepEqual(platformAdminEmails(' a@x.com , ,b@x.com'), ['a@x.com', 'b@x.com']);
});

test('PostgreSQL URL becomes libpq environment, never argv', () => {
  const c = parsePgUrl(NEON);
  assert.equal(c.host, 'ep-cool-dew-123456.ap-southeast-1.aws.neon.tech');
  assert.equal(c.database, 'neondb');
  assert.equal(c.env.PGPASSWORD, 'p@ss:w0rd', 'percent-encoded password is decoded');
  assert.equal(c.env.PGSSLMODE, 'require');
  assert.equal(c.env.PGCHANNELBINDING, 'require');
  assert.equal(c.env.PGPORT, '5432');
});

test('malformed or unsafe PostgreSQL URLs are rejected', () => {
  for (const bad of ['', 'mysql://u:p@h/db', 'postgresql:///db', 'postgresql://u:p@h', 'not a url']) assert.throws(() => parsePgUrl(bad), undefined, bad);
  // option values outside the allowed shape are dropped, not passed on
  const c = parsePgUrl('postgresql://u:p@h/db?sslmode=bogus&options=-c%20log_statement%3Dall%3Brm');
  assert.equal(c.env.PGSSLMODE, undefined);
  assert.equal(c.env.PGOPTIONS, undefined);
});

test('a restore target equal to the live database is recognised, including Neon pooled hosts', () => {
  const live = parsePgUrl(NEON);
  assert.equal(sameDatabase(parsePgUrl(NEON), live), true);
  assert.equal(sameDatabase(parsePgUrl('postgresql://x:y@ep-cool-dew-123456-pooler.ap-southeast-1.aws.neon.tech/neondb'), live), true);
  assert.equal(sameDatabase(parsePgUrl('postgresql://x:y@ep-cool-dew-123456.ap-southeast-1.aws.neon.tech/other'), live), false);
  assert.equal(sameDatabase(parsePgUrl('postgresql://x:y@localhost:5433/neondb'), live), false);
});

test('retention arguments need at least one rule', () => {
  assert.deepEqual(retentionArgs({ keepDaily: 7, keepWeekly: 0, keepMonthly: 6 }), ['--keep-daily', '7', '--keep-monthly', '6']);
  assert.throws(() => retentionArgs({ keepDaily: 0, keepWeekly: 0, keepMonthly: 0 }));
});

test('error text never carries secrets or database passwords', () => {
  const text = 'connection to postgresql://owner:Sup3rS3cret@host/db failed; repo password hunter2xyz rejected';
  const out = scrub(text, ['hunter2xyz']);
  assert.ok(!out.includes('Sup3rS3cret') && !out.includes('hunter2xyz'));
});

const base = { enabled: true, intervalHours: 24, lastSuccessAt: null as Date | null, lastBackupState: null as string | null };
const now = new Date('2026-10-07T00:00:00Z');
const ago = (h: number) => new Date(now.getTime() - h * 3_600_000);

test('database backup health', () => {
  assert.equal(dbBackupHealth({ ...base, enabled: false, updatedAt: ago(100) }, now), 'disabled');
  assert.equal(dbBackupHealth({ ...base, lastSuccessAt: ago(5), updatedAt: ago(100) }, now), 'ok');
  assert.equal(dbBackupHealth({ ...base, lastSuccessAt: ago(5), lastBackupState: 'error', updatedAt: ago(100) }, now), 'failed');
  assert.equal(dbBackupHealth({ ...base, lastSuccessAt: ago(49), updatedAt: ago(100) }, now), 'overdue');
  assert.equal(dbBackupHealth({ ...base, updatedAt: ago(49) }, now), 'never');
  assert.equal(dbBackupHealth({ ...base, updatedAt: ago(2) }, now), 'ok', 'a new policy gets its grace period');
});

test('scheduling: due after the interval, retried every 30 minutes at most', () => {
  const s = { enabled: true, repo: 's3:https://x/y', intervalHours: 24, lastSuccessAt: ago(25), lastStartedAt: ago(25) };
  assert.equal(isDue(s, now), true);
  assert.equal(isDue({ ...s, lastSuccessAt: ago(5) }, now), false);
  assert.equal(isDue({ ...s, lastStartedAt: ago(0.2) }, now), false, 'recent attempt, even a failed one');
  assert.equal(isDue({ ...s, lastStartedAt: ago(1) }, now), true);
  // a failed run backs off for two hours, a successful-but-old one only for 30 minutes
  assert.equal(isDue({ ...s, lastStartedAt: ago(1), lastState: 'error' }, now), false);
  assert.equal(isDue({ ...s, lastStartedAt: ago(2.5), lastState: 'error' }, now), true);
  assert.equal(isDue({ ...s, lastSuccessAt: null, lastStartedAt: null }, now), true);
  assert.equal(isDue({ ...s, enabled: false }, now), false);
  assert.equal(isDue({ ...s, repo: '' }, now), false);
  assert.equal(DUMP_NAME, 'support-agent-db.dump');
});

test('Neon pooled endpoints are swapped for the direct one for pg_dump, other hosts untouched', () => {
  const pooled = parsePgUrl('postgresql://u:p@ep-rapid-union-ayauxcuk-pooler.c-5.us-east-2.aws.neon.tech/neondb?sslmode=require');
  const direct = directConnection(pooled);
  assert.equal(direct.host, 'ep-rapid-union-ayauxcuk.c-5.us-east-2.aws.neon.tech');
  assert.equal(direct.env.PGHOST, direct.host);
  assert.equal(direct.env.PGPASSWORD, 'p'); assert.equal(direct.env.PGSSLMODE, 'require'); assert.equal(direct.database, 'neondb');
  assert.equal(pooled.host.includes('-pooler'), true, 'the original connection is not modified');
  const direct2 = parsePgUrl('postgresql://u:p@ep-abc.c-5.us-east-2.aws.neon.tech/neondb');
  assert.equal(directConnection(direct2), direct2);
  const other = parsePgUrl('postgresql://u:p@db-pooler.internal.example.com/app');
  assert.equal(directConnection(other), other, 'only Neon hosts are rewritten');
  assert.equal(sameDatabase(direct, pooled), true, 'the restore guard still recognises both as the live database');
});

test('verify-ca / verify-full use the operating system trust store; weaker modes and URL-supplied paths do not', () => {
  assert.equal(parsePgUrl('postgresql://u:p@h/db?sslmode=verify-full').env.PGSSLROOTCERT, 'system');
  assert.equal(parsePgUrl('postgresql://u:p@h/db?sslmode=verify-ca').env.PGSSLROOTCERT, 'system');
  assert.equal(parsePgUrl('postgresql://u:p@h/db?sslmode=require').env.PGSSLROOTCERT, undefined);
  // a customer cannot make pg_dump read a file on our server by naming it in the URL
  assert.equal(parsePgUrl('postgresql://u:p@h/db?sslmode=verify-full&sslrootcert=/etc/passwd').env.PGSSLROOTCERT, 'system');
  assert.equal(parsePgUrl('postgresql://u:p@h/db?sslmode=require&sslrootcert=/etc/passwd').env.PGSSLROOTCERT, undefined);
  assert.equal(directConnection(parsePgUrl('postgresql://u:p@ep-a-pooler.r.aws.neon.tech/db?sslmode=verify-full')).env.PGSSLROOTCERT, 'system', 'kept when the pooler host is swapped');
});

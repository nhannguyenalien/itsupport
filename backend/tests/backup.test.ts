import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';

process.env.DATABASE_URL ||= 'postgres://localhost/backup_test';
const { BACKUP_ENV_KEYS, agentSupportsBackup, resticDownloads, platformSupportsBackup } = await import('../src/backup/index.js');

test('backup env allowlist matches the agent', () => {
  const source = readFileSync(new URL('../../agent/internal/tools/backup.go', import.meta.url), 'utf8');
  const block = source.match(/backupEnvAllowlist = map\[string\]bool\{([\s\S]*?)\n\}/)![1];
  const agent = [...block.matchAll(/"([A-Z0-9_]+)":/g)].map(m => m[1]).sort();
  assert.deepEqual([...BACKUP_ENV_KEYS].sort(), agent);
});

test('backup requires agent 0.4.1 or newer', () => {
  assert.equal(agentSupportsBackup('0.3.2'), false);
  assert.equal(agentSupportsBackup('0.4.0'), false);
  assert.equal(agentSupportsBackup(null), false);
  assert.equal(agentSupportsBackup('0.4.1'), true);
  assert.equal(agentSupportsBackup('0.10.1'), true);
});

import { backupHealth, overdueAfterHours } from '../src/backup/health.js';

const base = { platform: 'windows', supported: true, policy_enabled: true, interval_hours: 24,
  policy_updated_at: '2026-10-01T00:00:00Z', last_success_at: null, last_state: null };
const now = new Date('2026-10-04T00:00:00Z');
const ago = (h: number) => new Date(now.getTime() - h * 3_600_000).toISOString();

test('backup health classification', () => {
  assert.equal(overdueAfterHours(6), 24);
  assert.equal(overdueAfterHours(24), 48);
  assert.equal(backupHealth({ ...base, policy_enabled: null }, now), 'disabled');
  assert.equal(backupHealth({ ...base, supported: false }, now), 'unsupported');
  assert.equal(backupHealth({ ...base, last_success_at: ago(10) }, now), 'ok');
  assert.equal(backupHealth({ ...base, last_success_at: ago(10), last_state: 'running' }, now), 'running');
  assert.equal(backupHealth({ ...base, last_success_at: ago(10), last_state: 'error' }, now), 'failed');
  assert.equal(backupHealth({ ...base, last_success_at: ago(49) }, now), 'overdue');
  // never succeeded and the policy is already older than the grace period
  assert.equal(backupHealth({ ...base }, now), 'never');
  // freshly created policy gets its grace period before being flagged
  assert.equal(backupHealth({ ...base, policy_updated_at: ago(2) }, now), 'ok');
});

const { formatAlertEmail, mailConfigured } = await import('../src/backup/alerts.js');

test('alert email lists every device, in plain text', () => {
  const { subject, text } = formatAlertEmail('Trường A', [
    { hostname: 'PC-01', health: 'overdue', last_success_at: '2026-10-01T00:00:00Z', device_status: 'online' },
    { hostname: '<b>PC-02</b>', health: 'never', last_success_at: null, device_status: 'offline' },
  ]);
  assert.equal(subject, '[Trường A] 2 máy cần chú ý về backup');
  assert.match(text, /PC-01: quá hạn backup \(lần thành công cuối: 2026-10-01T00:00:00\.000Z\)/);
  assert.match(text, /PC-02<\/b>: chưa có backup thành công \(lần thành công cuối: chưa có; máy đang ngoại tuyến\)/);
});

test('email is off unless SMTP_URL and MAIL_FROM are both set', () => {
  const saved = { u: process.env.SMTP_URL, f: process.env.MAIL_FROM };
  delete process.env.SMTP_URL; delete process.env.MAIL_FROM;
  assert.equal(mailConfigured(), false);
  process.env.SMTP_URL = 'smtp://x'; assert.equal(mailConfigured(), false);
  process.env.MAIL_FROM = 'a@b.c'; assert.equal(mailConfigured(), true);
  process.env.SMTP_URL = saved.u; process.env.MAIL_FROM = saved.f;
  if (saved.u === undefined) delete process.env.SMTP_URL;
  if (saved.f === undefined) delete process.env.MAIL_FROM;
});

test('backup runs on Windows, Linux and macOS only', () => {
  assert.equal(platformSupportsBackup('windows'), true);
  assert.equal(platformSupportsBackup('linux'), true);
  assert.equal(platformSupportsBackup('mac'), true);
  assert.equal(platformSupportsBackup('freebsd'), false);
});

test('restic downloads are offered per platform only when fully configured', () => {
  const d = resticDownloads({
    RESTIC_WINDOWS_URL: 'https://x/w.exe', RESTIC_WINDOWS_SHA256: 'aa',
    RESTIC_LINUX_AMD64_URL: 'https://x/l.bz2', RESTIC_LINUX_AMD64_SHA256: 'bb',
    RESTIC_LINUX_ARM64_URL: 'https://x/a.bz2', // no hash -> omitted
  } as NodeJS.ProcessEnv);
  assert.deepEqual(Object.keys(d).sort(), ['linux-amd64', 'windows-amd64']);
  assert.deepEqual(d['linux-amd64'], { url: 'https://x/l.bz2', sha256: 'bb' });
});

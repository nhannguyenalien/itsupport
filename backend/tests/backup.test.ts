import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';

process.env.DATABASE_URL ||= 'postgres://localhost/backup_test';
const { BACKUP_ENV_KEYS, agentSupportsBackup } = await import('../src/backup/index.js');

test('backup env allowlist matches the agent', () => {
  const source = readFileSync(new URL('../../agent/internal/tools/backup.go', import.meta.url), 'utf8');
  const block = source.match(/backupEnvAllowlist = map\[string\]bool\{([\s\S]*?)\n\}/)![1];
  const agent = [...block.matchAll(/"([A-Z0-9_]+)":/g)].map(m => m[1]).sort();
  assert.deepEqual([...BACKUP_ENV_KEYS].sort(), agent);
});

test('backup requires agent 0.4.0 or newer', () => {
  assert.equal(agentSupportsBackup('0.3.2'), false);
  assert.equal(agentSupportsBackup(null), false);
  assert.equal(agentSupportsBackup('0.4.0'), true);
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

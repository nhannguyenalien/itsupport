import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { classifyShell, rulesRaw } from '../src/shell-run/classify.js';

const agentRules = new URL('../../agent/internal/shellrun/rules.json', import.meta.url);
const agentFixtures = new URL('../../agent/internal/shellrun/testdata/classify.json', import.meta.url);
const fixtures: { argv: string[]; class: string; note?: string }[] = JSON.parse(readFileSync(new URL('./fixtures/shell-classify.json', import.meta.url), 'utf8'));

// The agent's Go classifier is authoritative; the backend copy may only differ
// by being identical. If this fails, copy agent/internal/shellrun/{rules.json,
// testdata/classify.json} into backend/src/shell-run and backend/tests/fixtures.
test('rules.json and the fixtures are byte-identical to the agent copies', { skip: !existsSyncSafe(agentRules) }, () => {
  assert.equal(rulesRaw, readFileSync(agentRules, 'utf8'));
  assert.equal(readFileSync(new URL('./fixtures/shell-classify.json', import.meta.url), 'utf8'), readFileSync(agentFixtures, 'utf8'));
});

test('every shared fixture classifies the same as the Go agent', () => {
  const wrong = fixtures.filter(f => classifyShell(f.argv).class !== f.class).map(f => `${JSON.stringify(f.argv)} want ${f.class} got ${classifyShell(f.argv).class}`);
  assert.deepEqual(wrong, []);
});

function existsSyncSafe(url: URL): boolean {
  try { readFileSync(url); return true; } catch { return false; }
}

import { evaluate, type PolicyContext } from '../src/policy-engine/index.js';

const base: PolicyContext = { initiatedBy: 'ai', tenantAiEnabled: true, tenantAutonomousLowRiskEnabled: true, deviceActionsPaused: false, tenantAiDataPolicy: 'standard', computerUseAutonomousEnabled: true };
const shell = (klass: 'read' | 'write' | 'deny', over: Partial<PolicyContext> = {}, enabled = true): PolicyContext =>
  ({ ...base, shell: { enabled, class: klass, reason: 'because' }, ...over });

test('shell.run: read auto-runs, write needs a human even with every autonomy flag on, deny is rejected', () => {
  assert.equal(evaluate('shell.run', shell('read')).outcome, 'auto_execute');
  assert.equal(evaluate('shell.run', shell('write')).outcome, 'requires_approval');
  assert.deepEqual(evaluate('shell.run', shell('deny')), { outcome: 'rejected', reason: 'because' });
});

test('shell.run: nothing runs unless tenant and device both enabled it', () => {
  for (const klass of ['read', 'write'] as const) assert.equal(evaluate('shell.run', shell(klass, {}, false)).outcome, 'rejected');
  assert.equal(evaluate('shell.run', base).outcome, 'rejected', 'missing context must reject, not default open');
});

test('shell.run: pause blocks writes but not reads; AI kill switch blocks the AI only', () => {
  assert.equal(evaluate('shell.run', shell('write', { deviceActionsPaused: true })).outcome, 'rejected');
  assert.equal(evaluate('shell.run', shell('read', { deviceActionsPaused: true })).outcome, 'auto_execute');
  assert.equal(evaluate('shell.run', shell('read', { tenantAiEnabled: false })).outcome, 'rejected');
  assert.equal(evaluate('shell.run', shell('read', { tenantAiEnabled: false, initiatedBy: 'human' })).outcome, 'auto_execute');
});

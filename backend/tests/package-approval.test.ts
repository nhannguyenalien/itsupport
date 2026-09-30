import assert from 'node:assert/strict';
import { test } from 'node:test';
import { evaluate, type PolicyContext } from '../src/policy-engine/index.js';
for (const autonomy of [false, true]) {
  test(`package installation always needs approval (autonomy=${autonomy})`, () => {
    const ctx: PolicyContext = { initiatedBy: 'ai', tenantAiEnabled: true, tenantAutonomousLowRiskEnabled: autonomy, deviceActionsPaused: false, tenantAiDataPolicy: 'redacted', computerUseAutonomousEnabled: autonomy };
    assert.equal(evaluate('package.install', ctx).outcome, 'requires_approval');
    assert.equal(evaluate('package.status', ctx).outcome, 'auto_execute');
    assert.equal(evaluate('system.temperature', ctx).outcome, 'auto_execute');
    assert.equal(evaluate('package.install', {...ctx, deviceActionsPaused: true}).outcome, 'rejected');
  });
}

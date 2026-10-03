import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { allTools } from '../src/tool-registry/index.js';

// The agent's compile-time allowlist (agent/internal/tools/registry.go) and
// registry.json are kept in sync by hand. A tool missing from either side, or
// with a different risk, would be offered to the AI but refused by the agent,
// or executed without the approval the policy engine expects.
test('agent KnownTools and registry.json agree on device tools and risk levels', () => {
  const source = readFileSync(new URL('../../agent/internal/tools/registry.go', import.meta.url), 'utf8');
  const riskOf: Record<string, string> = { RiskRead: 'read', RiskLow: 'low', RiskMedium: 'medium', RiskHigh: 'high' };
  const agent = new Map([...source.matchAll(/^\s*"([a-z0-9_.]+)":\s*(Risk\w+),/gm)].map(m => [m[1], riskOf[m[2]]]));
  const deviceTools = allTools().filter(t => t.domain !== 'marketing' && (!t.domain || ['windows', 'linux', 'windows_desktop', 'agent'].includes(t.domain)));
  for (const tool of deviceTools) assert.equal(agent.get(tool.tool), tool.risk, `${tool.tool}: registry.json=${tool.risk} agent=${agent.get(tool.tool)}`);
  for (const [name] of agent) assert.ok(deviceTools.some(t => t.tool === name), `${name} is in the agent allowlist but not registry.json`);
});

test('every verification step is itself a registered read tool', () => {
  for (const tool of allTools()) for (const step of tool.verification) {
    assert.equal(allTools().find(t => t.tool === step)?.risk, 'read', `${tool.tool} -> ${step}`);
  }
});

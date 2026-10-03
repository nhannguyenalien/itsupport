import assert from 'node:assert/strict';
import { test, mock } from 'node:test';

process.env.DATABASE_URL ||= 'postgres://localhost/agent_updates_test';
process.env.AGENT_DOWNLOADS_URL = 'http://downloads.test/agent';
const { compareVersions, isVersion, latestAgentVersion, withUpdateInfo } = await import('../src/devices/agent-updates.js');

test('compares x.y.z versions numerically', () => {
  assert.ok(compareVersions('0.10.0', '0.9.9') > 0);
  assert.equal(compareVersions('0.3.0', '0.3.0'), 0);
  assert.ok(compareVersions('0.2.9', '0.3.0') < 0);
  assert.ok(isVersion('1.2.3') && !isVersion('1.2') && !isVersion('1.2.3; rm') && !isVersion(undefined));
});

test('reads the published version only when it matches the platform, and caches it', async () => {
  let calls = 0;
  const fetchMock = mock.method(globalThis, 'fetch', async (url: string) => {
    calls++;
    assert.equal(url, 'http://downloads.test/agent/windows-amd64/manifest.json');
    return new Response(JSON.stringify({ version: '0.4.0', platform: 'windows-amd64' }));
  });
  try {
    assert.equal(await latestAgentVersion('windows-amd64'), '0.4.0');
    assert.equal(await latestAgentVersion('windows-amd64'), '0.4.0');
    assert.equal(calls, 1);
  } finally {
    fetchMock.mock.restore();
  }
});

test('old or non-Windows agents are not offered click-to-update', async () => {
  const devices = await withUpdateInfo('t1', []);
  assert.deepEqual(devices, []);
});

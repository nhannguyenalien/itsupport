import assert from 'node:assert/strict';
import { test } from 'node:test';

// install.ts does not touch the database, so no DATABASE_URL is needed.
const { remoteInstall } = await import('../src/remote-support/install.js');

const TENANT = '0d479297-bd62-4b8a-919f-83c0e3cbee6b';
const WIN = '62vC8nLJIWJscIH1lvTQxNqBmjbdamsDOiLnNaSk6hy$1IOc3BF1oG6drCVdVdYr';
const LIN = 'cv7ZvdTZWa@um$c8imhbewDaCnGbUeoiGRMFG7fk@TpEUcQc5wAUC0YVvYcyuOgI';
const KEYS = ['MESHCENTRAL_URL', 'MESHCENTRAL_TENANT_GROUPS', 'MESHCENTRAL_LINUX_TENANT_GROUPS', 'MESHCENTRAL_TENANT_GROUPS_B64', 'MESHCENTRAL_LINUX_TENANT_GROUPS_B64'];
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64');

function withEnv(env: Record<string, string>, run: () => void) {
  const saved = Object.fromEntries(KEYS.map(k => [k, process.env[k]]));
  for (const k of KEYS) delete process.env[k];
  Object.assign(process.env, { MESHCENTRAL_URL: 'https://mesh.example.com' }, env);
  try { run(); } finally { for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } }
}

test('plain JSON groups still work', () => {
  withEnv({ MESHCENTRAL_TENANT_GROUPS: JSON.stringify({ [TENANT]: WIN }), MESHCENTRAL_LINUX_TENANT_GROUPS: JSON.stringify({ [TENANT]: LIN }) }, () => {
    assert.equal(remoteInstall(TENANT, 'windows')?.group, WIN);
    assert.equal(remoteInstall(TENANT, 'linux', 'amd64')?.group, LIN);
  });
});

test('base64 groups survive ids that contain $ and @', () => {
  withEnv({ MESHCENTRAL_TENANT_GROUPS_B64: b64({ [TENANT]: WIN }), MESHCENTRAL_LINUX_TENANT_GROUPS_B64: b64({ [TENANT]: LIN }) }, () => {
    assert.equal(remoteInstall(TENANT, 'mac')?.group, WIN);
    assert.equal(remoteInstall(TENANT, 'linux', 'arm64')?.group, LIN);
  });
});

test('base64 wins over a mangled plain value', () => {
  withEnv({ MESHCENTRAL_TENANT_GROUPS: JSON.stringify({ [TENANT]: WIN.replace('$', '$$') }), MESHCENTRAL_TENANT_GROUPS_B64: b64({ [TENANT]: WIN }) }, () => {
    assert.equal(remoteInstall(TENANT, 'windows')?.group, WIN);
  });
});

test('a mangled value is a 503 configuration error that never prints the ids', () => {
  const logged: string[] = [];
  const original = console.error;
  console.error = (...a: unknown[]) => { logged.push(a.join(' ')); };
  try {
    withEnv({ MESHCENTRAL_TENANT_GROUPS: JSON.stringify({ [TENANT]: WIN }), MESHCENTRAL_LINUX_TENANT_GROUPS: JSON.stringify({ [TENANT]: LIN.replace('$c8imhbewDaCnGbUeoiGRMFG7fk', '') }) }, () => {
      assert.throws(() => remoteInstall(TENANT, 'windows'), (e: any) => e.statusCode === 503 && e.name !== 'ZodError');
    });
  } finally { console.error = original; }
  const line = logged.join('\n');
  assert.match(line, /MESHCENTRAL_LINUX_TENANT_GROUPS/);
  assert.match(line, /"idLengths":\[37\]/);
  assert.ok(!line.includes(WIN) && !line.includes('cv7ZvdTZWa') && !line.includes('TpEUcQc5'), 'ids must not appear in logs');
});

test('invalid JSON is a 503, and an unset config still means "not configured"', () => {
  const original = console.error; console.error = () => {};
  try { withEnv({ MESHCENTRAL_TENANT_GROUPS: '{not json' }, () => assert.throws(() => remoteInstall(TENANT, 'windows'), (e: any) => e.statusCode === 503)); }
  finally { console.error = original; }
  withEnv({}, () => assert.equal(remoteInstall(TENANT, 'windows'), null));
});

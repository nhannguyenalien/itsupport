import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FILES_PREFIX, clearCredentialCache, cloudflareMinter, credentialsFor, parseS3Base, r2Config, setMinter } from '../src/backup/r2-credentials.js';

test('S3 base paths are split into endpoint, bucket and prefix', () => {
  assert.deepEqual(parseS3Base('s3:https://acct.r2.cloudflarestorage.com/bucket'), { endpoint: 'https://acct.r2.cloudflarestorage.com', bucket: 'bucket', prefix: '' });
  assert.deepEqual(parseS3Base('s3:https://acct.r2.cloudflarestorage.com/bucket/sys/'), { endpoint: 'https://acct.r2.cloudflarestorage.com', bucket: 'bucket', prefix: 'sys' });
  assert.deepEqual(parseS3Base('s3:https://h/b/a/b/c').prefix, 'a/b/c');
  for (const bad of ['rest:https://h/x', 'b2:bucket:path', 's3:http://h/b', 's3:https://h', '', 'https://h/b']) assert.throws(() => parseS3Base(bad), undefined, bad);
});

test('the Cloudflare settings are all-or-nothing', () => {
  assert.equal(r2Config({}), null);
  assert.equal(r2Config({ CLOUDFLARE_ACCOUNT_ID: 'a', CLOUDFLARE_API_TOKEN: 't' }), null);
  assert.deepEqual(r2Config({ CLOUDFLARE_ACCOUNT_ID: 'a', CLOUDFLARE_API_TOKEN: 't', R2_PARENT_ACCESS_KEY_ID: 'p' }), { accountId: 'a', apiToken: 't', parentKeyId: 'p' });
});

const cfg = { accountId: 'acct123', apiToken: 'SECRET-CF-TOKEN', parentKeyId: 'parentKey' };

test('the credential request is scoped to the bucket and to ONE prefix, read-write, with a TTL', async () => {
  let seen: { url: string; init: RequestInit } | null = null;
  const fake = (async (url: string, init: RequestInit) => {
    seen = { url, init };
    return new Response(JSON.stringify({ success: true, result: { accessKeyId: 'AK', secretAccessKey: 'SK', sessionToken: 'ST' } }), { status: 200 });
  }) as unknown as typeof fetch;
  const creds = await cloudflareMinter(cfg, fake, 'https://api.example').mint({ bucket: 'bkt', prefix: 'sys/files-t-d' }, 3600);
  assert.equal(seen!.url, 'https://api.example/accounts/acct123/r2/temp-access-credentials');
  assert.equal((seen!.init.headers as Record<string, string>).Authorization, 'Bearer SECRET-CF-TOKEN');
  const body = JSON.parse(String(seen!.init.body));
  assert.deepEqual(body, { bucket: 'bkt', parentAccessKeyId: 'parentKey', permission: 'object-read-write', ttlSeconds: 3600, prefixes: ['sys/files-t-d/'] });
  assert.deepEqual([creds.accessKeyId, creds.secretAccessKey, creds.sessionToken], ['AK', 'SK', 'ST']);
  assert.ok(creds.expiresAt > Date.now());
});

test('a Cloudflare error is reported without leaking the API token', async () => {
  const fake = (async () => new Response(JSON.stringify({ success: false, errors: [{ message: 'parent token cannot access bucket' }] }), { status: 403 })) as unknown as typeof fetch;
  await assert.rejects(() => cloudflareMinter(cfg, fake).mint({ bucket: 'b', prefix: 'p' }, 60), (e: Error) => {
    assert.match(e.message, /HTTP 403/); assert.match(e.message, /parent token cannot access bucket/);
    assert.ok(!e.message.includes('SECRET-CF-TOKEN')); return true;
  });
  const malformed = (async () => new Response('<html>bad gateway</html>', { status: 502 })) as unknown as typeof fetch;
  await assert.rejects(() => cloudflareMinter(cfg, malformed).mint({ bucket: 'b', prefix: 'p' }, 60), /HTTP 502/);
  const empty = (async () => new Response(JSON.stringify({ success: true, result: {} }), { status: 200 })) as unknown as typeof fetch;
  await assert.rejects(() => cloudflareMinter(cfg, empty).mint({ bucket: 'b', prefix: 'p' }, 60), /did not issue/);
});

test('credentials are reused for a prefix, not minted on every poll, and never shared across prefixes', async () => {
  clearCredentialCache();
  let calls = 0;
  setMinter({ async mint(loc, ttl) { calls++; return { accessKeyId: 'AK' + loc.prefix, secretAccessKey: 's', sessionToken: 't', expiresAt: Date.now() + ttl * 1000 }; } });
  try {
    const a1 = await credentialsFor({ bucket: 'b', prefix: 'files-t1-d1' });
    const a2 = await credentialsFor({ bucket: 'b', prefix: 'files-t1-d1' });
    const b1 = await credentialsFor({ bucket: 'b', prefix: 'files-t2-d9' });
    assert.equal(a1, a2); assert.equal(calls, 2);
    assert.notEqual(a1.accessKeyId, b1.accessKeyId, 'another tenant gets its own, differently scoped key');
  } finally { setMinter(null); clearCredentialCache(); }
});

test('without a minter the storage is simply unavailable', async () => {
  setMinter(null);
  const saved = { a: process.env.CLOUDFLARE_ACCOUNT_ID, t: process.env.CLOUDFLARE_API_TOKEN, p: process.env.R2_PARENT_ACCESS_KEY_ID };
  delete process.env.CLOUDFLARE_ACCOUNT_ID; delete process.env.CLOUDFLARE_API_TOKEN; delete process.env.R2_PARENT_ACCESS_KEY_ID;
  try { await assert.rejects(() => credentialsFor({ bucket: 'b', prefix: 'p' }), /not configured/); }
  finally { for (const [k, v] of [['CLOUDFLARE_ACCOUNT_ID', saved.a], ['CLOUDFLARE_API_TOKEN', saved.t], ['R2_PARENT_ACCESS_KEY_ID', saved.p]] as const) if (v !== undefined) process.env[k] = v; }
});

test('each device of each tenant has a prefix of its own', () => {
  assert.equal(FILES_PREFIX('tenant', 'dev'), 'files-tenant-dev');
  assert.notEqual(FILES_PREFIX('t1', 'd'), FILES_PREFIX('t2', 'd'));
});

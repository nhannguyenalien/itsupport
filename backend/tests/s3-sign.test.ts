import assert from 'node:assert/strict';
import { test } from 'node:test';
import { presignUrl, signedRequest } from '../src/uploads/s3-sign.js';

test('presigned GET matches the worked example in the AWS documentation', () => {
  const url = presignUrl('GET', { endpoint: 'https://examplebucket.s3.amazonaws.com', bucket: 'examplebucket', key: 'test.txt', pathStyle: false },
    { accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY' },
    { expiresSeconds: 86400, region: 'us-east-1', now: new Date('2013-05-24T00:00:00Z') });
  assert.match(url, /X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404$/);
  assert.ok(url.startsWith('https://examplebucket.s3.amazonaws.com/test.txt?'));
});

test('presigned URLs use path style for R2, carry the session token and encode odd keys', () => {
  const url = presignUrl('PUT', { endpoint: 'https://acct.r2.cloudflarestorage.com', bucket: 'b', key: 'uploads-t/a b+c.txt' },
    { accessKeyId: 'ID', secretAccessKey: 'S', sessionToken: 'tok/en' }, { expiresSeconds: 3600 });
  assert.ok(url.startsWith('https://acct.r2.cloudflarestorage.com/b/uploads-t/a%20b%2Bc.txt?'));
  assert.match(url, /X-Amz-Security-Token=tok%2Fen/); assert.match(url, /X-Amz-Expires=3600/);
});

test('server-side requests are header signed and never put the secret on the wire', async () => {
  let seen: { url: string; init: RequestInit } | undefined;
  const res = await signedRequest('DELETE', { endpoint: 'https://acct.r2.cloudflarestorage.com', bucket: 'b', key: 'k' },
    { accessKeyId: 'ID', secretAccessKey: 'SECRET', sessionToken: 'TOK' },
    (async (url: string, init: RequestInit) => { seen = { url, init }; return new Response(null, { status: 204 }); }) as unknown as typeof fetch);
  assert.equal(res.status, 204); assert.equal(seen!.url, 'https://acct.r2.cloudflarestorage.com/b/k');
  const h = seen!.init.headers as Record<string, string>;
  assert.match(h.Authorization, /^AWS4-HMAC-SHA256 Credential=ID\/\d{8}\/auto\/s3\/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date;x-amz-security-token, Signature=[0-9a-f]{64}$/);
  assert.equal(h['x-amz-security-token'], 'TOK'); assert.ok(!JSON.stringify(h).includes('SECRET'));
});

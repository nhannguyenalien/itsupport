import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isPublicIp, requireTls, resolvePublic, validateCustomerUrl } from '../src/db-backup/net-guard.js';
import { parsePgUrl } from '../src/db-backup/config.js';

test('private, loopback, link-local and special addresses are never public', () => {
  for (const ip of [
    '127.0.0.1', '127.1.2.3', '10.0.0.5', '10.255.255.255', '172.16.0.1', '172.31.255.255', '192.168.1.3', '169.254.169.254', // cloud metadata
    '100.64.0.1', '100.100.100.100', '0.0.0.0', '224.0.0.1', '255.255.255.255', '198.18.0.1', '192.0.2.1',
    '::1', '::', 'fe80::1', 'fc00::1', 'fd12:3456::1', 'ff02::1', '2001:db8::1',
    '::ffff:127.0.0.1', '::ffff:10.1.2.3', '::ffff:7f00:1', '::ffff:a00:1', '::ffff:c0a8:1', // IPv4-mapped forms of internal addresses
    'not-an-ip', '',
  ]) assert.equal(isPublicIp(ip), false, ip);
});

test('ordinary Internet addresses are public', () => {
  for (const ip of ['8.8.8.8', '1.1.1.1', '34.120.0.1', '172.15.255.255', '172.32.0.1', '100.63.255.255', '100.128.0.1', '2606:4700:4700::1111', '::ffff:8.8.8.8']) assert.equal(isPublicIp(ip), true, ip);
});

test('hosts that are or resolve to internal addresses are refused', async () => {
  for (const host of ['127.0.0.1', '10.0.0.5', '192.168.2.8', '169.254.169.254', '100.96.178.98', '[::1]', 'localhost']) {
    await assert.rejects(() => resolvePublic(host), /công khai|phân giải/, host);
  }
  const ok = await resolvePublic('8.8.8.8');
  assert.deepEqual(ok, ['8.8.8.8']);
});

test('TLS is mandatory for customer databases', () => {
  const plain = parsePgUrl('postgresql://u:p@db.example.com/app');
  assert.throws(() => requireTls(plain), /sslmode=require/);
  assert.throws(() => requireTls(parsePgUrl('postgresql://u:p@db.example.com/app?sslmode=disable')), /sslmode=require/);
  assert.throws(() => requireTls(parsePgUrl('postgresql://u:p@db.example.com/app?sslmode=prefer')), /sslmode=require/);
  for (const m of ['require', 'verify-ca', 'verify-full']) assert.doesNotThrow(() => requireTls(parsePgUrl(`postgresql://u:p@db.example.com/app?sslmode=${m}`)));
});

test('a customer URL is pinned to the validated address', async () => {
  const v = await validateCustomerUrl('postgresql://u:p@8.8.8.8:5432/app?sslmode=require');
  assert.equal(v.conn.env.PGHOSTADDR, '8.8.8.8');
  await assert.rejects(() => validateCustomerUrl('postgresql://u:p@10.0.0.9/app?sslmode=require'), /công khai/);
  await assert.rejects(() => validateCustomerUrl('postgresql://u:p@8.8.8.8/app'), /sslmode=require/);
  await assert.rejects(() => validateCustomerUrl('mysql://u:p@8.8.8.8/app?sslmode=require'));
});

test('the private-address escape hatch is never honoured in production', async () => {
  const saved = { a: process.env.DBBACKUP_ALLOW_PRIVATE, n: process.env.NODE_ENV };
  process.env.DBBACKUP_ALLOW_PRIVATE = '1';
  try {
    process.env.NODE_ENV = 'production';
    await assert.rejects(() => resolvePublic('127.0.0.1'), /công khai/);
    process.env.NODE_ENV = 'test';
    assert.deepEqual(await resolvePublic('127.0.0.1'), ['127.0.0.1']);
  } finally {
    if (saved.a === undefined) delete process.env.DBBACKUP_ALLOW_PRIVATE; else process.env.DBBACKUP_ALLOW_PRIVATE = saved.a;
    if (saved.n === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = saved.n;
  }
});

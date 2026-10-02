import assert from 'node:assert/strict';
import { test, mock } from 'node:test';

process.env.DATABASE_URL ||= 'postgres://localhost/support_chat_test';
process.env.SCHOOLSAI_API_KEY = 'sk_test';
process.env.SCHOOLSAI_API_URL = 'https://schoolsai.test';
const { parseToolDirective, runSystemChat } = await import('../src/support-chat/index.js');
const { runSupportTool, toolCatalog } = await import('../src/support-chat/tools.js');
const { SchoolsAiError } = await import('../src/support-chat/schoolsai.js');

test('parses TOOL directives, including fenced and prose-wrapped ones', () => {
  assert.deepEqual(parseToolDirective('TOOL {"tool":"list_devices","args":{"status":"offline"}}'), { tool: 'list_devices', args: { status: 'offline' } });
  assert.deepEqual(parseToolDirective('```\nTOOL {"tool":"account_overview"}\n```'), { tool: 'account_overview', args: {} });
  assert.equal(parseToolDirective('Máy KETOAN-01 đang offline.'), null);
  assert.deepEqual(parseToolDirective('TOOL {"tool":'), { invalid: 'JSON không đóng ngoặc' });
  assert.deepEqual(parseToolDirective('TOOL {"args":{}}'), { invalid: 'thiếu trường "tool"' });
});

test('rejects unknown tools and invalid arguments before touching the database', async () => {
  assert.match(JSON.stringify((await runSupportTool('t1', 'drop_tables', {})).data), /Không có công cụ/);
  assert.match(JSON.stringify((await runSupportTool('t1', 'get_ticket', { ticket_id: 'other-tenant-ticket' })).data), /Tham số không hợp lệ/);
  assert.match(JSON.stringify((await runSupportTool('t1', 'propose_create_ticket', { device_id: crypto.randomUUID(), title: '' })).data), /Tham số không hợp lệ/);
});

test('catalog exposes only read tools and propose_* write proposals', () => {
  const names = [...toolCatalog().matchAll(/^- (\w+)/gm)].map(m => m[1]);
  assert.ok(names.length >= 5);
  for (const name of names) assert.ok(!/^(create|delete|update|run)_/.test(name), name);
});

test('system chat derives per-user sessions server-side and forwards the language', async () => {
  const calls: Array<{ url: string; auth: string; body: { session: string; question: string } }> = [];
  const fetchMock = mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    calls.push({ url, auth: (init.headers as Record<string, string>).authorization, body: JSON.parse(String(init.body)) });
    return new Response(JSON.stringify({ success: true, reply: 'ok', needsHuman: false }));
  });
  try {
    const conversationId = crypto.randomUUID();
    await runSystemChat(null, { conversationId, message: 'hi', language: 'en' });
    await runSystemChat({ id: 'u2', tenantId: 't2', tenantName: 'B', email: 'b@x', role: 'member' }, { conversationId, message: 'hi' });
    assert.equal(calls[0].url, 'https://schoolsai.test/api/v1/chat');
    assert.equal(calls[0].auth, 'Bearer sk_test');
    assert.match(calls[0].body.session, /^sys-[0-9a-f]{40}$/);
    assert.notEqual(calls[0].body.session, calls[1].body.session);
    assert.ok(!calls[0].body.session.includes(conversationId));
    assert.match(calls[0].body.question, /^\[Trả lời bằng English\]\nhi$/);
  } finally {
    fetchMock.mock.restore();
  }
});

test('upstream failures surface as SchoolsAiError without leaking the key', async () => {
  const fetchMock = mock.method(globalThis, 'fetch', async () => new Response('{"error":"quota"}', { status: 429 }));
  try {
    await assert.rejects(runSystemChat(null, { conversationId: crypto.randomUUID(), message: 'hi' }), (err: unknown) =>
      err instanceof SchoolsAiError && err.statusCode === 429 && !err.message.includes('sk_test'));
  } finally {
    fetchMock.mock.restore();
  }
});

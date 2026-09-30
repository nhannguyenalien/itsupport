import assert from 'node:assert/strict';
import { test, mock } from 'node:test';
import { createServer } from 'node:http';
import { startWorkflowJob, getWorkflowState } from '../src/ai-orchestration/jobs.js';

const complete = { action: 'message' as const, detail: 'done', steps: 1, stoppedBecause: 'completed' as const };
const settle = () => new Promise(resolve => setImmediate(resolve));

test('background workflow survives request completion and coalesces duplicate starts', async () => {
  let finish!: (value: typeof complete) => void;
  const pending = new Promise<typeof complete>(resolve => { finish = resolve; });
  let count = 0;
  startWorkflowJob('one', () => { count++; return pending; }, assert.fail);
  startWorkflowJob('one', () => { count++; return pending; }, assert.fail);
  assert.equal(getWorkflowState('one')?.status, 'running');
  assert.equal(count, 1);
  finish(complete);
  await settle();
  assert.equal(getWorkflowState('one')?.status, 'finished');
});

test('device timeout resumes automatically; errors remain visible to polling', async () => {
  let count = 0;
  startWorkflowJob('two', async () => ++count === 1 ? { ...complete, stoppedBecause: 'execution_timeout' } : complete, assert.fail);
  await settle();
  assert.equal(count, 2);
  assert.equal(getWorkflowState('two')?.stoppedBecause, 'completed');
  let reported = false;
  startWorkflowJob('three', async () => { throw new Error('upstream failed'); }, () => { reported = true; });
  await settle();
  assert.equal(getWorkflowState('three')?.status, 'failed');
  assert.equal(reported, true);
});

test('completed read tools are excluded for this request, but a new user request can refresh them', async () => {
  process.env.DATABASE_URL = 'postgresql://test:test@localhost/test';
  process.env.OPENAI_API_KEY = 'test';
  const requests: any[] = [];
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    requests.push(JSON.parse(body));
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'Kết quả đã có.' } }] }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  process.env.OPENAI_BASE_URL = `http://127.0.0.1:${port}`;
  const { pool } = await import('../src/db/pool.js');
  const { runAiStep } = await import('../src/ai-orchestration/index.js');
  let platform = 'darwin';
  let messageDate = '2026-09-30T09:00:00Z';
  mock.method(pool, 'query', async (sql: string) => {
    let rows: any[] = [];
    if (sql.includes('SELECT t.*')) rows = [{ id: 'ticket', tenant_id: 'tenant', device_id: 'device', device_platform: platform, ai_data_policy: 'full' }];
    else if (sql.includes('FROM ticket_messages')) rows = [{ author_type: 'user', body: 'Kiểm tra ổ đĩa', created_at: messageDate, attachments: [] }];
    else if (sql.includes('FROM tool_calls')) rows = [{ tool: 'disk.usage', params: {}, result: 'success', result_data: {}, verification_status: 'not_required', requested_at: '2026-09-30T09:01:00Z' }];
    return { rows, rowCount: rows.length };
  });
  try {
    await runAiStep('ticket');
    const names = (request: any) => request.tools.map((t: any) => t.function.name);
    assert.ok(!names(requests[0]).includes('disk-usage'));
    assert.ok(!names(requests[0]).some((name: string) => name.includes('clean')));
    assert.match(requests[0].messages[0].content, /free space is NOT reclaimable/);
    messageDate = '2026-09-30T09:02:00Z';
    await runAiStep('ticket');
    assert.equal(requests[1].tools.length, requests[0].tools.length + 1);
    platform = 'linux';
    await runAiStep('ticket');
    assert.deepEqual(names(requests[2]).sort(), ['disk-usage', 'system-info', 'process-list', 'service-status', 'service-restart', 'package-status', 'package-install', 'system-temperature'].sort());
    assert.match(requests[2].messages[0].content, /Load average is not CPU percent/);
  } finally {
    mock.restoreAll();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

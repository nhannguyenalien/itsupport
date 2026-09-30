import assert from 'node:assert/strict';
import { test, mock } from 'node:test';
process.env.DATABASE_URL = 'postgresql://test:test@localhost/test';
const { pool } = await import('../src/db/pool.js');
const { recordToolCallResult } = await import('../src/tool-calls/execution.js');

test('restart verification carries service name and excludes unrelated parameters', async () => {
  let inserted: unknown[] | undefined;
  mock.method(pool, 'query', async (sql: string, params?: unknown[]) => {
    if (sql.startsWith('SELECT *')) return { rowCount: 1, rows: [{ tool: 'service.restart', risk: 'medium', ticket_id: 'ticket', device_id: 'device', params: { service_name: 'nginx', extra: 'excluded' } }] };
    if (sql.includes('INSERT INTO tool_calls')) inserted = params;
    return { rowCount: 1, rows: [] };
  });
  try {
    await recordToolCallResult('parent', { result: 'success' }, 'tenant');
    assert.equal(inserted?.[3], 'service.status');
    assert.deepEqual(JSON.parse(inserted?.[5] as string), { service_name: 'nginx' });
    assert.equal(inserted?.[6], 'parent');
  } finally { mock.restoreAll(); }
});

for (const state of ['RUNNING', 'STOPPED']) {
  test(`restart verification checks actual service state: ${state}`, async () => {
    let verdict: unknown;
    mock.method(pool, 'query', async (sql: string, params?: unknown[]) => {
      if (sql.startsWith('SELECT *')) return { rowCount: 1, rows: [{ tool: 'service.status', parent_tool_call_id: 'parent' }] };
      if (sql.startsWith('SELECT tool, result')) return { rowCount: 1, rows: [{ tool: 'service.status', result: 'success', result_data: { state } }] };
      if (sql.includes('SET verification_status = $1')) verdict = params?.[0];
      return { rowCount: 1, rows: [] };
    });
    try {
      await recordToolCallResult('child', { result: 'success', resultData: { state } }, 'tenant');
      assert.equal(verdict, state === 'RUNNING' ? 'passed' : 'failed');
    } finally { mock.restoreAll(); }
  });
}

for (const installed of [true, false]) {
  test(`package verification checks installed state: ${installed}`, async () => {
    let verdict: unknown;
    mock.method(pool, 'query', async (sql: string, params?: unknown[]) => {
      if (sql.startsWith('SELECT *')) return { rowCount: 1, rows: [{ tool: 'package.status', parent_tool_call_id: 'parent' }] };
      if (sql.startsWith('SELECT tool, result')) return { rowCount: 1, rows: [{ tool: 'package.status', result: 'success', result_data: { installed } }] };
      if (sql.includes('SET verification_status = $1')) verdict = params?.[0];
      return { rowCount: 1, rows: [] };
    });
    try {
      await recordToolCallResult('child', { result: 'success', resultData: { installed } }, 'tenant');
      assert.equal(verdict, installed ? 'passed' : 'failed');
    } finally { mock.restoreAll(); }
  });
}

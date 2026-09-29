import assert from 'node:assert/strict';
import { test, mock } from 'node:test';
process.env.DATABASE_URL = 'postgresql://test:test@localhost/test';
const { pool, adminPool } = await import('../src/db/pool.js');
const { withExecutionLock } = await import('../src/db/execution-lock.js');

test('device lock prevents a second operation and releases on failure', async () => {
  let held = false;
  const keys: unknown[] = [];
  let releases = 0;
  mock.method(pool, 'query', async () => ({ rowCount: 1, rows: [{ device_id: 'shared-device' }] }));
  mock.method(adminPool, 'connect', async () => {
    let owns = false;
    return {
      query: async (sql: string, params?: unknown[]) => {
        if (sql.includes('pg_try_advisory')) {
          keys.push(params?.[0]);
          owns = !held;
          if (owns) held = true;
          return { rows: [{ acquired: owns }] };
        }
        if (sql === 'ROLLBACK' && owns) held = false;
        return { rows: [] };
      },
      release: () => { releases++; },
    };
  });
  try {
    await assert.rejects(withExecutionLock('ticket-a', async () => {
      await assert.rejects(withExecutionLock('ticket-b', async () => assert.fail('must not execute')), { statusCode: 409 });
      assert.equal(held, true);
      throw new Error('operation failed');
    }), /operation failed/);
    assert.equal(held, false);
    assert.equal(await withExecutionLock('ticket-b', async () => 'next operation'), 'next operation');
    assert.deepEqual(new Set(keys), new Set(['support-execution:shared-device']));
    assert.equal(releases, 3);
  } finally { mock.restoreAll(); }
});

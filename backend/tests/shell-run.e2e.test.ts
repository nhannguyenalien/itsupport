import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';

// End-to-end check of shell.run through the real service, routes and Postgres:
// request -> classify -> policy -> approval -> agent poll (__approved) ->
// result -> verification. Needs a scratch database that has src/db/schema.sql
// loaded (never point it at real data):
//   createdb shellrun_e2e && psql shellrun_e2e -f src/db/schema.sql
//   SHELLRUN_E2E=1 DATABASE_URL=postgres:///shellrun_e2e node --import tsx --test tests/shell-run.e2e.test.ts
const enabled = process.env.SHELLRUN_E2E === '1';
const t = enabled ? test : test.skip;

t('shell.run: gating, approval, agent hand-off, expiry and verification', async () => {
  const { adminPool } = await import('../src/db/pool.js');
  const { requestToolCall } = await import('../src/tool-calls/service.js');
  const { toolCallRoutes } = await import('../src/tool-calls/routes.js');
  const Fastify = (await import('fastify')).default;

  const q = async (sql: string, params: unknown[] = []) => (await adminPool.query(sql, params)).rows;
  const tenantId = (await q(`INSERT INTO tenants (name) VALUES ('e2e') RETURNING id`))[0].id as string;
  const deviceId = (await q(`INSERT INTO devices (tenant_id, hostname, platform, public_key) VALUES ($1, 'pve-test', 'linux', 'k') RETURNING id`, [tenantId]))[0].id as string;
  const winId = (await q(`INSERT INTO devices (tenant_id, hostname, platform, public_key) VALUES ($1, 'win-test', 'windows', 'k') RETURNING id`, [tenantId]))[0].id as string;
  const newTicket = async (device = deviceId) => (await q(`INSERT INTO tickets (tenant_id, device_id, title) VALUES ($1, $2, 't') RETURNING id`, [tenantId, device]))[0].id as string;
  const audit = async (type: string) => q(`SELECT event_data FROM audit_log WHERE tenant_id = $1 AND event_type = $2 ORDER BY created_at`, [tenantId, type]);

  const app = Fastify();
  app.decorateRequest('agentTenantId', null);
  app.addHook('onRequest', async (req: any) => { req.agentTenantId = tenantId; });
  await app.register(toolCallRoutes);
  const pending = async () => (await app.inject({ method: 'GET', url: `/devices/${deviceId}/tool-calls/pending` })).json() as any[];
  const approve = (id: string) => app.inject({ method: 'POST', url: `/approvals/${id}/approve`, payload: {} });
  const report = (id: string, body: object) => app.inject({ method: 'POST', url: `/tool-calls/${id}/result`, payload: body });
  const call = (ticketId: string, params: Record<string, unknown>, initiatedBy: 'ai' | 'human' = 'ai') =>
    requestToolCall({ ticketId, initiatedBy, tool: 'shell.run', params });
  const rejected = (r: any, re: RegExp) => { assert.equal(r.outcome, 'rejected'); assert.match(r.reason, re); };

  try {
    const ticket = await newTicket();
    const readCmd = { argv: ['qm', 'list'], purpose: 'List VMs' };
    const writeCmd = { argv: ['qm', 'start', '101'], purpose: 'Start VM 101', verify_argv: ['qm', 'status', '101'] };

    // 1. Everything is off by default.
    rejected(await call(ticket, readCmd), /not enabled/);
    await q(`UPDATE tenants SET shell_run_enabled = true WHERE id = $1`, [tenantId]);
    rejected(await call(ticket, readCmd), /not enabled/); // tenant alone is not enough
    await q(`UPDATE devices SET shell_run_enabled = true WHERE id = $1`, [deviceId]);

    // 2. A Windows device never gets it, even with both flags.
    await q(`UPDATE devices SET shell_run_enabled = true WHERE id = $1`, [winId]);
    rejected(await call(await newTicket(winId), readCmd), /Linux device/);

    // 3. Read class runs unattended and is stored as a read.
    const read = await call(ticket, readCmd);
    assert.equal(read.outcome, 'auto_execute');
    assert.equal((read as any).toolCall.risk, 'read');
    assert.equal((await pending()).find(c => c.id === (read as any).toolCall.id).params.__approved, undefined);

    // 4. Input shape and reserved names.
    rejected(await call(ticket, { ...readCmd, __approved: true }), /reserved/);
    rejected(await call(ticket, { ...readCmd, extra: 1 }), /only argv/);
    rejected(await call(ticket, { argv: [], purpose: 'x' }), /non-empty/);
    rejected(await call(ticket, { argv: ['qm', 3 as never], purpose: 'x' }), /non-empty array of strings/);
    rejected(await call(ticket, { argv: ['qm', 'list'] }), /purpose/);
    rejected(await call(ticket, { argv: ['qm', 'start', '101'], purpose: 'x' }), /verify_argv/);
    rejected(await call(ticket, { argv: ['qm', 'start', '101'], purpose: 'x', verify_argv: ['qm', 'stop', '101'] }), /read-only/);

    // 5. Deny never reaches an approval, for the AI or a human.
    for (const argv of [['bash', '-c', 'id'], ['cat', '/etc/shadow'], ['rm', '-rf', '/'], ['systemctl', 'stop', 'itsupport-daemon']]) {
      for (const who of ['ai', 'human'] as const) {
        const r = await call(ticket, { argv, purpose: 'x', verify_argv: ['uname'] }, who);
        assert.equal(r.outcome, 'rejected', JSON.stringify(argv));
      }
    }
    assert.equal((await q(`SELECT count(*)::int AS n FROM approvals a JOIN tickets t ON t.id = a.ticket_id WHERE t.tenant_id = $1`, [tenantId]))[0].n, 0, 'a denied command must not create an approval');
    assert.ok((await audit('tool_call.rejected')).some(e => e.event_data.argv?.[0] === 'bash' && e.event_data.class === 'deny'), 'rejections are audited with argv and class');

    // 6. Write class needs a human, even for the AI, and is not handed to the agent yet.
    const proposed = await call(ticket, writeCmd);
    assert.equal(proposed.outcome, 'requires_approval');
    const approvalId = (proposed as any).approval.id as string;
    assert.equal((await pending()).some(c => c.tool === 'shell.run' && c.params.argv[0] === 'qm' && c.params.argv[1] === 'start'), false);
    assert.equal((proposed as any).approval.reasoning, 'Start VM 101');

    // 7. Approve: the agent now sees __approved, storage never does.
    assert.equal((await approve(approvalId)).statusCode, 200);
    const handed = (await pending()).find(c => c.params.argv?.[1] === 'start');
    assert.equal(handed.params.__approved, true);
    assert.equal(handed.risk, 'high');
    assert.equal((await q(`SELECT params FROM tool_calls WHERE id = $1`, [handed.id]))[0].params.__approved, undefined);
    assert.equal((await approve(approvalId)).statusCode, 404, 'an approval cannot be used twice');

    // 8. A row whose params no longer match its approval loses the flag.
    await q(`UPDATE tool_calls SET params = jsonb_set(params, '{argv}', '["qm","destroy","101"]') WHERE id = $1`, [handed.id]);
    assert.equal((await pending()).find(c => c.id === handed.id).params.__approved, undefined);
    await q(`UPDATE tool_calls SET params = (SELECT params FROM approvals WHERE id = $1) WHERE id = $2`, [approvalId, handed.id]);
    assert.equal((await pending()).find(c => c.id === handed.id).params.__approved, true);

    // 9. Verification: the write succeeds, its own read-only check decides.
    assert.equal((await report(handed.id, { result: 'success', resultData: { exit_code: 0, stdout: 'ok', timed_out: false } })).statusCode, 200);
    const verifyRow = (await q(`SELECT id, tool, risk, params FROM tool_calls WHERE parent_tool_call_id = $1`, [handed.id]))[0];
    assert.deepEqual([verifyRow.tool, verifyRow.risk, verifyRow.params.argv], ['shell.run', 'read', ['qm', 'status', '101']]);
    assert.equal((await pending()).find(c => c.id === verifyRow.id).params.__approved, undefined, 'verification is a read, never approved');
    assert.equal((await q(`SELECT verification_status FROM tool_calls WHERE id = $1`, [handed.id]))[0].verification_status, 'pending');
    await report(verifyRow.id, { result: 'success', resultData: { exit_code: 0, timed_out: false, stdout: 'status: running' } });
    assert.equal((await q(`SELECT verification_status FROM tool_calls WHERE id = $1`, [handed.id]))[0].verification_status, 'passed');

    // 10. A failing check, or a timeout, is "failed", never silently passed.
    for (const [data, label] of [[{ exit_code: 2, timed_out: false }, 'non-zero exit'], [{ exit_code: -1, timed_out: true }, 'timeout']] as const) {
      const p = await call(await newTicket(), { argv: ['qm', 'start', '102'], purpose: 'x', verify_argv: ['qm', 'status', '102'] });
      await approve((p as any).approval.id);
      const w = (await pending()).find(c => c.params.argv?.[2] === '102' && c.params.argv[1] === 'start');
      await report(w.id, { result: 'success', resultData: { exit_code: 0, timed_out: false } });
      const v = (await q(`SELECT id FROM tool_calls WHERE parent_tool_call_id = $1`, [w.id]))[0];
      await report(v.id, { result: 'success', resultData: data });
      assert.equal((await q(`SELECT verification_status FROM tool_calls WHERE id = $1`, [w.id]))[0].verification_status, 'failed', label);
    }

    // 11. Approvals expire: a device that was offline for >15 minutes never runs it.
    const stale = await call(await newTicket(), { argv: ['qm', 'start', '103'], purpose: 'x', verify_argv: ['qm', 'status', '103'] });
    await approve((stale as any).approval.id);
    await q(`UPDATE tool_calls SET requested_at = now() - interval '16 minutes' WHERE device_id = $1 AND params->'argv'->>2 = '103' AND tool = 'shell.run'`, [deviceId]);
    assert.equal((await pending()).some(c => c.params.argv?.[2] === '103'), false);
    const expired = (await q(`SELECT result, error_message FROM tool_calls WHERE device_id = $1 AND params->'argv'->>2 = '103'`, [deviceId]))[0];
    assert.equal(expired.result, 'timeout');
    assert.match(expired.error_message, /expired/);

    // 12. Pause blocks writes (not reads); switching a flag off or pausing after
    //     a proposal blocks the approval itself.
    const late = await call(await newTicket(), { argv: ['qm', 'start', '104'], purpose: 'x', verify_argv: ['qm', 'status', '104'] });
    await q(`UPDATE devices SET actions_paused = true WHERE id = $1`, [deviceId]);
    rejected(await call(await newTicket(), writeCmd), /paused/);
    assert.equal((await call(await newTicket(), readCmd)).outcome, 'auto_execute');
    assert.equal((await approve((late as any).approval.id)).statusCode, 409);
    await q(`UPDATE devices SET actions_paused = false WHERE id = $1`, [deviceId]);
    await q(`UPDATE tenants SET shell_run_enabled = false WHERE id = $1`, [tenantId]);
    assert.equal((await approve((late as any).approval.id)).statusCode, 409);
    rejected(await call(await newTicket(), readCmd), /not enabled/);
    await q(`UPDATE tenants SET shell_run_enabled = true WHERE id = $1`, [tenantId]);

    // 13. Rejecting an approval runs nothing.
    const declined = await call(await newTicket(), { argv: ['qm', 'start', '105'], purpose: 'x', verify_argv: ['qm', 'status', '105'] });
    assert.equal((await app.inject({ method: 'POST', url: `/approvals/${(declined as any).approval.id}/reject`, payload: {} })).statusCode, 200);
    assert.equal((await q(`SELECT count(*)::int AS n FROM tool_calls WHERE device_id = $1 AND params->'argv'->>2 = '105'`, [deviceId]))[0].n, 0);

    // 14. Other tools cannot smuggle the reserved flag either.
    const r = await requestToolCall({ ticketId: ticket, initiatedBy: 'ai', tool: 'service.status', params: { service_name: 'x', __approved: true } });
    rejected(r, /reserved/);
  } finally {
    await adminPool.end();
    await app.close();
  }
});

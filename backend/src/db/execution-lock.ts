import { adminPool, pool } from "./pool.js";

// Transaction-scoped locks also work with transaction-mode connection poolers.
// Serialize by device, so two tickets cannot drive the same desktop at once.
export async function withExecutionLock<T>(ticketId: string, run: () => Promise<T>): Promise<T> {
  const ticket = await pool.query(`SELECT device_id FROM tickets WHERE id = $1`, [ticketId]);
  if (!ticket.rowCount) throw Object.assign(new Error("ticket not found"), { statusCode: 404 });
  const client = await adminPool.connect();
  try {
    await client.query("BEGIN");
    const result = await client.query(`SELECT pg_try_advisory_xact_lock(hashtextextended($1, 0)) AS acquired`, [`support-execution:${ticket.rows[0].device_id ?? ticketId}`]);
    if (!result.rows[0].acquired) throw Object.assign(new Error("Đang xử lý một bước khác trên máy này. Vui lòng thử lại."), { statusCode: 409 });
    return await run();
  } finally {
    try { await client.query("ROLLBACK"); } finally { client.release(); }
  }
}

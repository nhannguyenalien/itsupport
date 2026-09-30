import { getWorkflowState } from "../ai-orchestration/jobs.js";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { pool } from "../db/pool.js";
import { attachmentInput, extractAttachment } from "../documents/index.js";
import { recordAudit } from "../audit/index.js";

const createTicketBody = z
  .object({
    tenantId: z.string().uuid(),
    deviceId: z.string().uuid().optional(),
    platformConnectionId: z.string().uuid().optional(),
    title: z.string().min(1),
    createdBy: z.string().uuid().optional(),
    scenario: z.enum(["A_printer", "B_dns", "C_hung_app", "D_disk_full"]).optional(),
  })
  // Mirrors the tickets table's CHECK constraint — enforced here too so a bad
  // request gets a clear 400 instead of a raw Postgres constraint error.
  .refine((b) => Boolean(b.deviceId) !== Boolean(b.platformConnectionId), {
    message: "exactly one of deviceId or platformConnectionId is required",
  });

const addMessageBody = z.object({
  authorType: z.literal("user").optional(),
  authorId: z.string().uuid().optional(),
  body: z.string().max(8000).default(""),
  attachments: z.array(attachmentInput).max(1).default([]),
});

const listQuery = z.object({ tenantId: z.string().uuid() });
const ticketParams = z.object({ ticketId: z.string().uuid() });

export async function ticketRoutes(app: FastifyInstance) {
  app.post("/tickets", async (req, reply) => {
    const b = createTicketBody.parse(req.body);
    const result = await pool.query(
      `INSERT INTO tickets (tenant_id, device_id, platform_connection_id, title, created_by, scenario)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [b.tenantId, b.deviceId ?? null, b.platformConnectionId ?? null, b.title, req.authUser!.id, b.scenario ?? null],
    );
    const ticket = result.rows[0];

    await recordAudit({
      tenantId: b.tenantId,
      actorType: "user",
      actorId: req.authUser!.id,
      eventType: "ticket.created",
      eventData: { title: b.title },
      ticketId: ticket.id,
      deviceId: b.deviceId ?? null,
    });

    reply.code(201).send(ticket);
  });

  app.get("/tickets", async (req, reply) => {
    const { tenantId } = listQuery.parse(req.query);
    const result = await pool.query(
      `SELECT * FROM tickets WHERE tenant_id = $1 ORDER BY created_at DESC`,
      [tenantId],
    );
    reply.send(result.rows);
  });

  app.get("/tickets/:ticketId", async (req, reply) => {
    const { ticketId } = ticketParams.parse(req.params);
    const ticket = await pool.query(`SELECT * FROM tickets WHERE id = $1`, [ticketId]);
    if (ticket.rowCount === 0) return reply.code(404).send({ error: "ticket not found" });

    const messages = await pool.query(
      `SELECT * FROM ticket_messages WHERE ticket_id = $1 ORDER BY created_at ASC`,
      [ticketId],
    );
    const toolCalls = await pool.query(
      `SELECT * FROM tool_calls WHERE ticket_id = $1 ORDER BY requested_at ASC`,
      [ticketId],
    );
    // Pending write actions have an approvals row but NO tool_calls row yet
    // (that's only created once approved, see tool-calls/routes.ts) — without
    // this, the frontend has no way to render "awaiting your approval" at all.
    const approvals = await pool.query(
      `SELECT * FROM approvals WHERE ticket_id = $1 ORDER BY created_at ASC`,
      [ticketId],
    );

    const session = await pool.query(`SELECT * FROM computer_use_sessions WHERE ticket_id = $1 AND status = 'active' ORDER BY created_at DESC LIMIT 1`, [ticketId]);
    reply.send({ aiWorkflow: getWorkflowState(ticketId), computerUseSession: session.rows[0] ?? null, ...ticket.rows[0], messages: messages.rows, toolCalls: toolCalls.rows, approvals: approvals.rows });
  });

  app.post("/tickets/:ticketId/messages", { bodyLimit: 8 * 1024 * 1024, config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (req, reply) => {
    const { ticketId } = ticketParams.parse(req.params);
    const b = addMessageBody.parse(req.body);

    const ticketRow = await pool.query(`SELECT tenant_id, device_id FROM tickets WHERE id = $1`, [ticketId]);
    if (ticketRow.rowCount === 0) return reply.code(404).send({ error: "ticket not found" });

    if (!b.body.trim() && !b.attachments.length) return reply.code(400).send({ error: "Hãy nhập yêu cầu hoặc chọn tài liệu." });
    let attachments;
    try { attachments = await Promise.all(b.attachments.map(extractAttachment)); }
    catch (error) { return reply.code(400).send({ error: error instanceof Error ? error.message : "Không đọc được tài liệu." }); }
    const result = await pool.query(
      `INSERT INTO ticket_messages (ticket_id, author_type, author_id, body, attachments)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [ticketId, "user", req.authUser!.id, b.body, JSON.stringify(attachments)],
    );

    await recordAudit({
      tenantId: ticketRow.rows[0].tenant_id,
      actorType: "user",
      actorId: req.authUser!.id,
      eventType: "ticket.message_added",
      ticketId,
      deviceId: ticketRow.rows[0].device_id,
    });

    reply.code(201).send(result.rows[0]);
  });

  // README: "Falls back to human takeover (MeshCentral) on failure." A technician
  // clicks through to MeshCentral's own desktop-takeover page and drives the
  // session themselves — we don't reimplement remote desktop, just point at it.
  // Requires meshcentral_device_id to already be set on the device (populated
  // when the Windows install bundles MeshCentral's mesh agent — not wired into
  // the installer yet, see agent/README.md). 404s honestly rather than handing
  // back a link that goes nowhere.
  app.get("/tickets/:ticketId/takeover-link", async (req, reply) => {
    const { ticketId } = ticketParams.parse(req.params);
    const result = await pool.query(
      `SELECT d.meshcentral_device_id
       FROM tickets t JOIN devices d ON d.id = t.device_id
       WHERE t.id = $1`,
      [ticketId],
    );
    if (result.rowCount === 0) return reply.code(404).send({ error: "ticket not found" });

    const meshId = result.rows[0].meshcentral_device_id;
    if (!meshId) {
      return reply.code(404).send({
        error: "this device has no MeshCentral agent registered — takeover isn't available for it",
      });
    }
    if (!process.env.MESHCENTRAL_URL) {
      return reply.code(500).send({ error: "MESHCENTRAL_URL is not configured on the backend" });
    }

    reply.send({ url: `${process.env.MESHCENTRAL_URL}/desktop.html?id=${encodeURIComponent(meshId)}` });
  });
}

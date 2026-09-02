import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { pool } from "../db/pool.js";
import { recordAudit } from "../audit/index.js";

const createTicketBody = z.object({
  tenantId: z.string().uuid(),
  deviceId: z.string().uuid(),
  title: z.string().min(1),
  createdBy: z.string().uuid().optional(),
  scenario: z.enum(["A_printer", "B_dns", "C_hung_app", "D_disk_full"]).optional(),
});

const addMessageBody = z.object({
  authorType: z.enum(["user", "ai", "system", "technician"]),
  authorId: z.string().uuid().optional(),
  body: z.string().min(1),
});

const listQuery = z.object({ tenantId: z.string().uuid() });
const ticketParams = z.object({ ticketId: z.string().uuid() });

export async function ticketRoutes(app: FastifyInstance) {
  app.post("/tickets", async (req, reply) => {
    const b = createTicketBody.parse(req.body);
    const result = await pool.query(
      `INSERT INTO tickets (tenant_id, device_id, title, created_by, scenario)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [b.tenantId, b.deviceId, b.title, b.createdBy ?? null, b.scenario ?? null],
    );
    const ticket = result.rows[0];

    await recordAudit({
      tenantId: b.tenantId,
      actorType: "user",
      actorId: b.createdBy ?? null,
      eventType: "ticket.created",
      eventData: { title: b.title },
      ticketId: ticket.id,
      deviceId: b.deviceId,
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

    reply.send({ ...ticket.rows[0], messages: messages.rows, toolCalls: toolCalls.rows });
  });

  app.post("/tickets/:ticketId/messages", async (req, reply) => {
    const { ticketId } = ticketParams.parse(req.params);
    const b = addMessageBody.parse(req.body);

    const ticketRow = await pool.query(`SELECT tenant_id, device_id FROM tickets WHERE id = $1`, [ticketId]);
    if (ticketRow.rowCount === 0) return reply.code(404).send({ error: "ticket not found" });

    const result = await pool.query(
      `INSERT INTO ticket_messages (ticket_id, author_type, author_id, body)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [ticketId, b.authorType, b.authorId ?? null, b.body],
    );

    await recordAudit({
      tenantId: ticketRow.rows[0].tenant_id,
      actorType: b.authorType === "ai" ? "ai" : b.authorType === "technician" ? "technician" : "user",
      actorId: b.authorId ?? null,
      eventType: "ticket.message_added",
      ticketId,
      deviceId: ticketRow.rows[0].device_id,
    });

    reply.code(201).send(result.rows[0]);
  });
}

import { api, type SupportProposal, type Ticket } from "./api";

// Runs a proposal the account assistant made, after the user clicked it. Every
// action goes through the normal authenticated endpoints, so role checks, the
// policy engine and approvals apply exactly as if the user did it by hand.
export async function executeProposal(proposal: SupportProposal, tenantId: string): Promise<{ ticketId: string; ticket?: Ticket }> {
  if (proposal.action === "run_diagnosis") {
    await api.runAiStep(proposal.params.ticketId);
    return { ticketId: proposal.params.ticketId };
  }
  const title = proposal.action === "device_task"
    ? proposal.params.request.slice(0, 120)
    : proposal.params.title;
  const ticket = await api.createTicket({ tenantId, deviceId: proposal.params.deviceId, title });
  if (proposal.action === "device_task") {
    // Hand the request to that device's AI as the first message of a new session.
    await api.addMessage(ticket.id, { authorType: "user", body: proposal.params.request });
    await api.runAiStep(ticket.id);
  }
  return { ticketId: ticket.id, ticket };
}

export function proposalKey(proposal: SupportProposal): string {
  return proposal.action + JSON.stringify(proposal.params);
}

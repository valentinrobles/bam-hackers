import { RequestContext } from '@mastra/core/request-context';
import { registerApiRoute } from '@mastra/core/server';
import { handleNurseDecision, postNurseApprovalCard } from '../services/nurse';
import { getTicket } from '../services/tickets';

// Lets the nurse decision be exercised without Telegram (tests, Galtea, demo).
export const nurseDecisionRoute = registerApiRoute('/demo/nurse-decision', {
  method: 'POST',
  handler: async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { ticketId?: unknown; approved?: unknown };
    if (typeof body.ticketId !== 'string' || typeof body.approved !== 'boolean') {
      return c.json({ error: 'expected { ticketId: string, approved: boolean }' }, 400);
    }
    const agent = c.get('mastra').getAgent('companion');
    try {
      const result = await handleNurseDecision(agent, body.ticketId, body.approved, new RequestContext());
      return c.json(result);
    } catch (error) {
      c.get('mastra').getLogger().error('nurse decision failed', { error });
      return c.json({ error: String(error) }, 500);
    }
  },
});

// Re-posts the approval card for an existing ticket (card lost, nurse chat
// changed, or just to see it during the demo).
export const nurseCardRoute = registerApiRoute('/demo/nurse-card', {
  method: 'POST',
  handler: async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { ticketId?: unknown };
    if (typeof body.ticketId !== 'string') return c.json({ error: 'expected { ticketId: string }' }, 400);
    const ticket = await getTicket(body.ticketId);
    if (!ticket) return c.json({ error: 'ticket not found' }, 404);
    const agent = c.get('mastra').getAgent('companion');
    const outcome = await postNurseApprovalCard(agent, ticket, ticket.suggestedReply ?? '(sin respuesta propuesta todavía)');
    return c.json({ ticketId: ticket.id, ...outcome });
  },
});

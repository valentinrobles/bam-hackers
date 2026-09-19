import { RequestContext } from '@mastra/core/request-context';
import { registerApiRoute } from '@mastra/core/server';
import { runDemoReset, runDemoSeed } from '../agents/companion';
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

// POST /demo/reminder?chatId=…&kind=medication|followup|tick
export const reminderRoute = registerApiRoute('/demo/reminder', {
  method: 'POST',
  handler: async (c) => {
    const chatId = c.req.query('chatId')?.trim();
    const kindParam = c.req.query('kind') ?? 'medication';
    const kind = kindParam === 'followup' || kindParam === 'tick' ? kindParam : 'medication';
    if (kind !== 'tick' && !chatId) return c.json({ error: 'chatId query parameter is required' }, 400);
    const run = await c.get('mastra').getWorkflow('reminders').createRun();
    const result = await run.start({ inputData: { kind, chatId } });
    return c.json(result.status === 'success' ? { kind, chatId: chatId ?? null, ...result.result } : { kind, chatId: chatId ?? null, status: result.status });
  },
});

// POST /demo/followup?chatId=… fires the 24 h follow-up now.
export const followupRoute = registerApiRoute('/demo/followup', {
  method: 'POST',
  handler: async (c) => {
    const chatId = c.req.query('chatId')?.trim();
    if (!chatId) return c.json({ error: 'chatId query parameter is required' }, 400);
    const run = await c.get('mastra').getWorkflow('reminders').createRun();
    const result = await run.start({ inputData: { kind: 'followup', chatId } });
    return c.json(result.status === 'success' ? { kind: 'followup', chatId, ...result.result } : { kind: 'followup', chatId, status: result.status });
  },
});

// POST /demo/seed?chatId=… does what /demo does in Telegram (Marta + first reminder).
export const demoSeedRoute = registerApiRoute('/demo/seed', {
  method: 'POST',
  handler: async (c) => {
    const chatId = c.req.query('chatId')?.trim();
    if (!chatId) return c.json({ error: 'chatId query parameter is required' }, 400);
    return c.json({ chatId, ...(await runDemoSeed(chatId)) });
  },
});

// POST /demo/reset?chatId=… wipes the chat's record and cancels its pending sends.
export const demoResetRoute = registerApiRoute('/demo/reset', {
  method: 'POST',
  handler: async (c) => {
    const chatId = c.req.query('chatId')?.trim();
    if (!chatId) return c.json({ error: 'chatId query parameter is required' }, 400);
    return c.json({ chatId, ...(await runDemoReset(chatId)) });
  },
});

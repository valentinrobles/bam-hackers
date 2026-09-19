import { RequestContext } from '@mastra/core/request-context';
import { registerApiRoute } from '@mastra/core/server';
import { prepareTurn, runClinicalTurn } from '../agents/companion';
import { threadIdForChat } from '../memory/patient-memory';

// Galtea entry point: same triage + ticket path as Telegram, without Telegram.
// Body: { text: string, chatId?: string }. chatId defaults to a fresh eval id,
// so each call starts from an empty record unless the caller reuses one.
export const evalMessageRoute = registerApiRoute('/eval/message', {
  method: 'POST',
  handler: async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { text?: unknown; chatId?: unknown };
    if (typeof body.text !== 'string' || !body.text.trim()) {
      return c.json({ error: 'expected { text: string, chatId?: string }' }, 400);
    }
    const chatId = typeof body.chatId === 'string' && body.chatId.trim() ? body.chatId.trim() : `eval-${Date.now().toString(36)}`;
    const mastra = c.get('mastra');
    const agent = mastra.getAgent('companion');
    const requestContext = new RequestContext();
    const startedAt = Date.now();
    try {
      const turn = await prepareTurn(chatId, body.text, requestContext);
      if (turn.directReply) {
        return c.json({ chatId, tier: turn.tier, reason: turn.reason, ticketId: turn.ticketId ?? null, reply: turn.directReply, finishReason: 'direct', latencyMs: Date.now() - startedAt });
      }
      const result =
        turn.tier === 'clinical' && turn.ticketId
          ? await runClinicalTurn(chatId, turn.ticketId, body.text, requestContext)
          : await agent.generate(body.text, {
              requestContext,
              memory: { thread: threadIdForChat(chatId), resource: chatId },
            });
      // On clinical turns the model's text is never shown to the patient.
      const reply = turn.tier === 'clinical' ? (turn.ack ?? '') : [turn.ack, result.text].filter(Boolean).join('\n\n');
      return c.json({
        chatId,
        tier: turn.tier,
        reason: turn.reason,
        ticketId: turn.ticketId ?? null,
        reply,
        finishReason: result.finishReason,
        latencyMs: Date.now() - startedAt,
      });
    } catch (error) {
      mastra.getLogger().error('eval message failed', { chatId, error });
      return c.json({ chatId, error: String(error) }, 500);
    }
  },
});

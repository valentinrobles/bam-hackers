import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { getTicket, updateTicket } from '../services/tickets';

// Suspends the run until the nurse taps Aprobar / Rechazar in her own chat
// (see services/nurse.ts). execute() only runs after approval.
export const notifyNurseTool = createTool({
  id: 'notify_nurse',
  description:
    'Send the ticket and a suggested reply to the nurse for approval. Returns once she approves; the reply is then delivered to the patient.',
  inputSchema: z.object({
    ticketId: z.string(),
    suggestedReply: z.string().min(1).describe('Reply to the patient, in Spanish, written as the nurse would answer'),
  }),
  // The approved reply is delivered to the patient by services/nurse.ts before
  // the run resumes; it is deliberately not returned here so the model cannot
  // paraphrase it a second time.
  outputSchema: z.object({
    status: z.enum(['approved', 'error']),
    delivered: z.boolean().optional(),
    error: z.string().optional(),
  }),
  requireApproval: true,
  execute: async ({ ticketId, suggestedReply }, context) => {
    try {
      const ticket = await getTicket(ticketId);
      if (!ticket) return { status: 'error' as const, error: `ticket ${ticketId} not found` };
      await updateTicket(ticketId, { status: 'approved', suggestedReply });
      return { status: 'approved' as const, delivered: true };
    } catch (error) {
      context.mastra?.getLogger().error('notify_nurse failed', { ticketId, error });
      return { status: 'error' as const, error: 'could not record the approval' };
    }
  },
});

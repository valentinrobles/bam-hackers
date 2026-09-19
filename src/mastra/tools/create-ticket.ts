import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { patchPatient, readPatient, summarizePatient } from '../memory/patient-memory';
import { notifyMake } from '../services/make';
import { tiers } from '../services/nebius';
import { createTicket } from '../services/tickets';

export const createTicketInput = z.object({
  chatId: z.string().describe('Telegram chat id of the patient'),
  tier: z.enum(tiers),
  message: z.string().describe("The patient's message that triggered the ticket"),
  contextSummary: z.string().optional().describe('Short summary of the patient record; filled automatically when omitted'),
});

export async function openTicket(input: z.infer<typeof createTicketInput>): Promise<{ ticketId: string; makeNotified: boolean }> {
  const patient = await readPatient(input.chatId);
  const ticket = await createTicket({
    chatId: input.chatId,
    patientName: patient?.name ?? null,
    tier: input.tier,
    message: input.message,
    contextSummary: input.contextSummary ?? summarizePatient(patient),
  });
  await patchPatient(input.chatId, (p) => ({ ...p, openTicketId: ticket.id }));
  // Make scenario schema: every field a string, no nulls, no extra properties.
  const payload = {
    ticketId: ticket.id,
    chatId: ticket.chatId,
    patientName: ticket.patientName ?? '',
    tier: ticket.tier,
    message: ticket.message,
    contextSummary: ticket.contextSummary ?? '',
    createdAt: ticket.createdAt,
  };
  const { sent } = await notifyMake('ticket.created', payload);
  if (ticket.tier === 'urgent') await notifyMake('ticket.urgent', payload);
  return { ticketId: ticket.id, makeNotified: sent };
}

export const createTicketTool = createTool({
  id: 'create_ticket',
  description: 'Open a ticket for the nurse about this patient and notify the clinic.',
  inputSchema: createTicketInput,
  outputSchema: z.object({ ticketId: z.string().optional(), makeNotified: z.boolean(), error: z.string().optional() }),
  execute: async (input, context) => {
    try {
      return await openTicket(input);
    } catch (error) {
      context.mastra?.getLogger().error('create_ticket failed', { error });
      return { makeNotified: false, error: 'could not create the ticket' };
    }
  },
});

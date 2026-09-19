import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { symptomTiers } from '../memory/patient-schema';
import { appendSymptom, chatIdFromThreadId } from '../memory/patient-memory';

export const logSymptomTool = createTool({
  id: 'log_symptom',
  description: "Append a symptom the patient reported to the patient's record.",
  inputSchema: z.object({
    text: z.string().min(1).describe('The symptom in the patient\'s own words'),
    tier: z.enum(symptomTiers),
  }),
  outputSchema: z.object({ ok: z.boolean(), count: z.number(), error: z.string().optional() }),
  execute: async ({ text, tier }, context) => {
    const chatId = context.agent?.resourceId ?? (context.agent?.threadId ? chatIdFromThreadId(context.agent.threadId) : undefined);
    if (!chatId) return { ok: false, count: 0, error: 'no patient chat in context' };
    try {
      return { ok: true, count: await appendSymptom(chatId, text, tier) };
    } catch (error) {
      context.mastra?.getLogger().error('log_symptom failed', { chatId, error });
      return { ok: false, count: 0, error: 'could not write the record' };
    }
  },
});

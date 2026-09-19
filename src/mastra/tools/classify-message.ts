import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { classificationSchema, classifyMessage } from '../services/nebius';

export const classifyMessageTool = createTool({
  id: 'classify_message',
  description: 'Classify a patient message into routine, logistic, clinical or urgent using the clinic rules.',
  inputSchema: z.object({ text: z.string().min(1) }),
  outputSchema: classificationSchema,
  execute: async ({ text }) => classifyMessage(text),
});

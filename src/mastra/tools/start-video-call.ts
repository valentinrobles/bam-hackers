import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { startVideoCall } from '../services/vonage';

export const startVideoCallTool = createTool({
  id: 'start_video_call',
  description: 'Open the nurse ↔ patient video room for a ticket. Returns the two join links; send patientUrl to the patient.',
  inputSchema: z.object({ ticketId: z.string() }),
  outputSchema: z.object({ patientUrl: z.string(), nurseUrl: z.string() }),
  execute: async ({ ticketId }) => {
    const { patientUrl, nurseUrl } = await startVideoCall(ticketId);
    return { patientUrl, nurseUrl };
  },
});

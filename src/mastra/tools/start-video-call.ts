import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { createVideoCall } from '../services/video';

export const startVideoCallTool = createTool({
  id: 'start_video_call',
  description: 'Create a video call room between the nurse and the patient for an urgent case. Returns the link to send to the patient.',
  inputSchema: z.object({ ticketId: z.string() }),
  outputSchema: z.object({ url: z.string() }),
  execute: async ({ ticketId }) => createVideoCall(ticketId),
});

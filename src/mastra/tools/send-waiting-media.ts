import { createTool } from '@mastra/core/tools';
import { z } from 'zod';

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN ?? '';
const NURSE_RESPONSE_MINUTES = process.env.NURSE_RESPONSE_MINUTES ?? '4';

// Curated cat GIFs — reliable public URLs for the demo
const WAITING_GIFS = [
  'https://cataas.com/cat/gif',           // random cat gif from cataas
  'https://media.giphy.com/media/JIX9t2j0ZTN9S/giphy.gif',   // cat typing
  'https://media.giphy.com/media/VbnUQpnihPSIgIXuZv/giphy.gif', // cat waiting
  'https://media.giphy.com/media/heIX5HfWgEYlW/giphy.gif',   // cat relaxing
  'https://media.giphy.com/media/3oriO0OEd9QIDdllqo/giphy.gif', // sleepy cat
];

const CAPTIONS = [
  `Mientras esperas, este gatito te hace compañía. La enfermera te escribe en menos de ${NURSE_RESPONSE_MINUTES} minutos.`,
  `Un momentito. Este gatito se queda contigo mientras la enfermera te escribe — menos de ${NURSE_RESPONSE_MINUTES} minutos.`,
  `Compañía para la espera. La enfermera te escribe en menos de ${NURSE_RESPONSE_MINUTES} minutos.`,
];

function randomFrom<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

async function sendAnimationToChat(chatId: string, url: string, caption: string): Promise<void> {
  if (!BOT_TOKEN) throw new Error('TELEGRAM_BOT_TOKEN not configured');
  const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendAnimation`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, animation: url, caption }),
  });
  if (!res.ok) {
    // Fallback: send as photo if animation fails
    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendPhoto`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, photo: url, caption }),
    });
  }
}

export const sendWaitingMediaTool = createTool({
  id: 'send_waiting_media',
  description: 'Send a cute cat GIF to the patient while they wait for the nurse. Call this right after escalating to the nurse.',
  inputSchema: z.object({
    chatId: z.string().describe('Patient Telegram chat ID'),
  }),
  outputSchema: z.object({ sent: z.boolean() }),
  execute: async (input) => {
    const url = randomFrom(WAITING_GIFS);
    const caption = randomFrom(CAPTIONS);
    await sendAnimationToChat(input.chatId, url, caption);
    return { sent: true };
  },
});

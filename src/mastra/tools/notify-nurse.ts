import { createTool } from '@mastra/core/tools';
import { z } from 'zod';

const NURSE_CHAT_ID = process.env.NURSE_TELEGRAM_CHAT_ID ?? '';
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN ?? '';

async function sendToNurseChat(text: string, replyMarkup: object): Promise<void> {
  if (!BOT_TOKEN || !NURSE_CHAT_ID) {
    throw new Error('TELEGRAM_BOT_TOKEN or NURSE_TELEGRAM_CHAT_ID not configured');
  }
  const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: NURSE_CHAT_ID,
      text,
      parse_mode: 'HTML',
      reply_markup: replyMarkup,
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Telegram API ${res.status}: ${body}`);
  }
}

function clinicalMessage(p: {
  ticketId: string;
  patientName: string;
  cycleInfo: string;
  protocolInfo: string;
  patientMessage: string;
  suggestedReply: string;
}): string {
  const header = `Nueva consulta · <code>${p.ticketId}</code>`;
  const who = `👤 <b>${p.patientName}</b>${p.cycleInfo ? ` · ${p.cycleInfo}` : ''}`;
  const protocol = p.protocolInfo ? `💊 ${p.protocolInfo}` : '';
  const quote = `💬 <b>Dice la paciente</b>\n"${p.patientMessage}"`;
  const suggestion = `📝 <b>Respuesta sugerida</b>\n${p.suggestedReply}`;
  return [header, '', who, protocol, '', quote, '', suggestion].filter(l => l !== undefined && !(l === '' && !protocol)).join('\n');
}

function urgentMessage(p: {
  ticketId: string;
  patientName: string;
  cycleInfo: string;
  patientMessage: string;
  videoCallUrl?: string;
}): string {
  const header = `Aviso · <code>${p.ticketId}</code>`;
  const who = `👤 <b>${p.patientName}</b>${p.cycleInfo ? ` · ${p.cycleInfo}` : ''}`;
  const quote = `💬 <b>Mensaje recibido</b>\n"${p.patientMessage}"`;
  const note = `Ya le he dado el número de la clínica y le digo que estáis avisadas.`;
  const call = p.videoCallUrl ? `📹 Videollamada lista: ${p.videoCallUrl}` : '';
  return [header, '', who, '', quote, '', note, call].filter(Boolean).join('\n');
}

export const notifyNurseTool = createTool({
  id: 'notify_nurse',
  description: 'Send a patient ticket to the nurse Telegram chat with Approve/Deny buttons.',
  inputSchema: z.object({
    ticketId: z.string(),
    tier: z.enum(['clinical', 'urgent']),
    patientName: z.string().optional(),
    cycleInfo: z.string().optional().describe('e.g. "Día 6 de estimulación"'),
    protocolInfo: z.string().optional().describe('e.g. "Gonal-f 225 UI · 21:00"'),
    patientMessage: z.string().describe('Verbatim patient message'),
    suggestedReply: z.string().optional().describe('Required for clinical tier'),
    videoCallUrl: z.string().optional().describe('For urgent tier: video call URL already sent to patient'),
  }),
  outputSchema: z.object({ sent: z.boolean(), nurseChat: z.string() }),
  execute: async (input) => {
    const { ticketId, tier, patientMessage, suggestedReply, videoCallUrl } = input;
    const patientName = input.patientName ?? 'la paciente';
    const cycleInfo = input.cycleInfo ?? '';
    const protocolInfo = input.protocolInfo ?? '';

    if (tier === 'urgent') {
      // Urgent = direct action, no approval needed. Just notify the nurse.
      const text = urgentMessage({ ticketId, patientName, cycleInfo, patientMessage, videoCallUrl });
      await sendToNurseChat(text, { remove_keyboard: true });
    } else {
      const text = clinicalMessage({
        ticketId,
        patientName,
        cycleInfo,
        protocolInfo,
        patientMessage,
        suggestedReply: suggestedReply ?? '—',
      });
      await sendToNurseChat(text, {
        inline_keyboard: [[
          { text: '✅ Enviar esta respuesta', callback_data: `approve:${ticketId}` },
          { text: '✏️ Respondo yo', callback_data: `deny:${ticketId}` },
        ]],
      });
    }

    return { sent: true, nurseChat: NURSE_CHAT_ID };
  },
});

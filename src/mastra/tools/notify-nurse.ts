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
  problemSummary?: string;
  suggestedAction?: string;
  videoCallUrl?: string;
}): string {
  const header = `Aviso · <code>${p.ticketId}</code>`;
  const who = `👤 <b>${p.patientName}</b>${p.cycleInfo ? ` · ${p.cycleInfo}` : ''}`;
  const quote = `💬 <b>Mensaje recibido</b>\n"${p.patientMessage}"`;
  const problem = p.problemSummary ? `📋 <b>Situación</b>\n${p.problemSummary}` : '';
  const action = p.suggestedAction ? `📝 <b>Posible respuesta</b>\n${p.suggestedAction}` : '';
  const call = p.videoCallUrl ? `📹 Videollamada lista: ${p.videoCallUrl}` : '';
  return [header, '', who, '', quote, problem, action, call].filter(Boolean).join('\n');
}

export const notifyNurseTool = createTool({
  id: 'notify_nurse',
  description: 'Notify the nurse chat. Clinical: informs the nurse a patient is waiting for a reply. Urgent: sends a call ticket with Accept/Bounce buttons.',
  inputSchema: z.object({
    ticketId: z.string(),
    tier: z.enum(['clinical', 'urgent']),
    patientName: z.string().optional(),
    cycleInfo: z.string().optional().describe('e.g. "Día 6 de estimulación"'),
    protocolInfo: z.string().optional().describe('e.g. "Gonal-f 225 UI · 21:00"'),
    patientMessage: z.string().describe('Verbatim patient message'),
    suggestedReply: z.string().optional().describe('Required for clinical tier'),
    problemSummary: z.string().optional().describe('For urgent tier: 2-line summary of the situation'),
    suggestedAction: z.string().optional().describe('For urgent tier: 2-line suggested response or action'),
    videoCallUrl: z.string().optional().describe('For urgent tier: video call URL already sent to patient'),
  }),
  outputSchema: z.object({ sent: z.boolean(), nurseChat: z.string() }),
  execute: async (input) => {
    const { ticketId, tier, patientMessage, suggestedReply, videoCallUrl } = input;
    const patientName = input.patientName ?? 'la paciente';
    const cycleInfo = input.cycleInfo ?? '';
    const protocolInfo = input.protocolInfo ?? '';

    if (tier === 'urgent') {
      // Urgent: nurse decides whether to take the call or redirect it.
      const text = urgentMessage({
        ticketId,
        patientName,
        cycleInfo,
        patientMessage,
        problemSummary: input.problemSummary,
        suggestedAction: input.suggestedAction,
        videoCallUrl,
      });
      await sendToNurseChat(text, {
        inline_keyboard: [[
          { text: '📹 Aceptar llamada', callback_data: `videocall:${ticketId}` },
          { text: '↩️ Rebotar llamada', callback_data: `bounce:${ticketId}` },
        ]],
      });
    } else {
      // Clinical: bot can't answer, nurse replies when available. No decision buttons.
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

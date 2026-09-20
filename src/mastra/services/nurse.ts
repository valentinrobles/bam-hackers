import type { Agent } from '@mastra/core/agent';
import type { Processor, ProcessOutputStreamArgs } from '@mastra/core/processors';
import { PinoLogger } from '@mastra/loggers';
import type { RequestContext } from '@mastra/core/request-context';
import type { ChunkType } from '@mastra/core/stream';
import { Actions, Button, Card, type TextElement, type Thread } from 'chat';
import { messages, type Lang } from '../i18n';
import { addNurseNote, clinicalThreadId, patchPatient, patientLanguage, readPatient } from '../memory/patient-memory';
import { getTicket, latestTicketByStatus, updateTicket, type Ticket } from './tickets';
import { startVideoCall } from './vonage';

// Same string as CHAT_CHANNEL_RENDER_CONTEXT_KEY in @mastra/core 1.67
// (channels/output-processor). Not exported from the package entry point.
const RENDER_CONTEXT_KEY = '__mastra_chat_channel_render';

export const NURSE_APPROVE = 'nurse_approve';
export const NURSE_DENY = 'nurse_deny';
export const NURSE_VIDEO = 'nurse_video';
export const DOSE_TAKEN = 'dose_taken';
export const DOSE_QUESTION = 'dose_question';
export const NOTIFY_NURSE_TOOL = 'notify_nurse';

export function nurseChatId(): string | undefined {
  return process.env.NURSE_TELEGRAM_CHAT_ID?.trim() || undefined;
}

export const nurseReplyPrefix = messages('es').nurseSays;

const Text = (content: string): TextElement => ({ type: 'text', content });

type AnyAgent = Agent<any, any, any, any>;

const logger = new PinoLogger({ name: 'nurse', level: 'info' });

// Stream processors do not receive the agent instance; the agent registers
// itself here once it is constructed.
let nurseAgent: AnyAgent | undefined;
export function setNurseAgent(agent: AnyAgent): void {
  nurseAgent = agent;
}

// ---------------------------------------------------------------------------
// Raw Bot API fallback. Used whenever the Chat SDK path cannot post (no SDK
// yet, openDM refused, unsupported element, ...). The inline keyboard encodes
// callback_data exactly like the adapter does ("chat:" + JSON {a, v}), so the
// tap arrives in handlers.onAction with the same actionId/value.
// ---------------------------------------------------------------------------

const CALLBACK_DATA_PREFIX = 'chat:'; // @chat-adapter/telegram 4.x

function telegramApiBase(): string {
  return (process.env.TELEGRAM_API_BASE_URL || 'https://api.telegram.org').replace(/\/+$/, '');
}

function callbackData(actionId: string, value: string): string {
  return `${CALLBACK_DATA_PREFIX}${JSON.stringify({ a: actionId, v: value })}`;
}

async function telegramSendMessage(chatId: string, text: string, replyMarkup?: Record<string, unknown>, parseMode?: 'HTML'): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN is not set');
  const res = await fetch(`${telegramApiBase()}/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, ...(replyMarkup ? { reply_markup: replyMarkup } : {}), ...(parseMode ? { parse_mode: parseMode } : {}) }),
    signal: AbortSignal.timeout(8000),
  });
  const body = (await res.json().catch(() => ({}))) as { ok?: boolean; description?: string };
  if (!res.ok || !body.ok) throw new Error(`sendMessage ${res.status}: ${body.description ?? 'no description'}`);
}

type PostOutcome = { posted: true; via: 'chat-sdk' | 'bot-api' } | { posted: false; reason: string };

// Try the Chat SDK first (rich card, buttons rendered by the adapter), then
// the raw Bot API. Every failure is logged with its error text.
async function postWithFallback(
  agent: AnyAgent | undefined,
  chatId: string,
  label: string,
  viaSdk: (thread: Thread) => Promise<unknown>,
  viaBotApi: () => Promise<void>,
): Promise<PostOutcome> {
  const sdk = agent?.getChannels()?.sdk;
  if (sdk) {
    try {
      const thread = await sdk.openDM(chatId);
      await viaSdk(thread);
      return { posted: true, via: 'chat-sdk' };
    } catch (error) {
      logger.warn(`${label}: Chat SDK post failed, falling back to Bot API`, { chatId, error: String(error) });
    }
  } else {
    logger.warn(`${label}: channel SDK not available, using Bot API`, { chatId });
  }
  try {
    await viaBotApi();
    return { posted: true, via: 'bot-api' };
  } catch (error) {
    const reason = String(error);
    logger.error(`${label}: Bot API post failed`, { chatId, error: reason });
    return { posted: false, reason };
  }
}

function requireNurseChatId(label: string): string | null {
  const chatId = nurseChatId();
  if (!chatId) logger.error(`${label}: NURSE_TELEGRAM_CHAT_ID is not set, nothing sent to the nurse`);
  return chatId ?? null;
}

function ticketHeader(ticket: Ticket, lang: Lang): string {
  const n = messages(lang).nurse;
  return `Ticket ${ticket.id} · ${n.tier[ticket.tier] ?? ticket.tier.toUpperCase()} · ${ticket.patientName ?? n.unnamed}`;
}

// One glanceable line: "día 6 estimulación · Gonal-f 225 UI 21:00 · eco jue 24/09 10:00".
function patientLines(patient: Awaited<ReturnType<typeof readPatient>>, lang: Lang, excludeText?: string): string[] {
  const n = messages(lang).nurse;
  if (!patient) return [n.noRecord];
  const bits: string[] = [];
  if (patient.cycle) bits.push(n.day(patient.cycle.day, patient.cycle.phase));
  if (patient.protocol.length) bits.push(patient.protocol.map((m) => `${m.drug} ${m.dose} ${m.time}`).join(', '));
  if (patient.nextAppointment) bits.push(`${patient.nextAppointment.type} ${shortDate(patient.nextAppointment.datetime)}`);
  const lines = [bits.length ? bits.join(' · ') : n.noTreatmentData];
  // The message that opened this ticket is already logged as a symptom; show only the previous one.
  const previous = patient.symptoms.filter((x) => x.text !== excludeText).slice(-1)[0];
  if (previous) lines.push(`${n.before}: «${previous.text.slice(0, 70)}»`);
  return lines;
}

// "jueves, 24 de septiembre de 2026, 10:00" → "jue 24/09 10:00"; English dates pass through.
function shortDate(value: string): string {
  const m = /^(\w{3})\w*,?\s+(\d{1,2}) de (\w+)(?: de \d{4})?,?\s*(\d{1,2}:\d{2})?/u.exec(value);
  if (!m) return value;
  const months: Record<string, string> = { enero: '01', febrero: '02', marzo: '03', abril: '04', mayo: '05', junio: '06', julio: '07', agosto: '08', septiembre: '09', octubre: '10', noviembre: '11', diciembre: '12' };
  const mm = months[m[3].toLowerCase()];
  return mm ? `${m[1]} ${m[2].padStart(2, '0')}/${mm}${m[4] ? ` ${m[4]}` : ''}` : value;
}

interface CardSection {
  title: string;
  body: string;
}

// The nurse sees the card in the patient's language, so what she approves is
// exactly what the patient receives.
function nurseCardSections(ticket: Ticket, patient: Awaited<ReturnType<typeof readPatient>>, suggestedReply: string, lang: Lang): CardSection[] {
  const n = messages(lang).nurse;
  return [
    { title: n.patient, body: patientLines(patient, lang, ticket.message).join('\n') },
    { title: n.question, body: ticket.message },
    { title: n.proposedReply, body: suggestedReply || n.noDraft },
  ];
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c] ?? c);
}

// Plain text for the Chat SDK path: the adapter escapes it for Telegram, and
// markdown markers inside card text came out malformed. Emoji headings carry
// the structure; the card title is rendered bold by the adapter.
function sectionsAsPlain(sections: CardSection[]): string {
  return sections.map((x) => `${x.title}\n${x.body}`).join('\n\n');
}

function sectionsAsHtml(header: string, sections: CardSection[]): string {
  return [`<b>${escapeHtml(header)}</b>`, ...sections.map((x) => `<b>${escapeHtml(x.title)}</b>\n${escapeHtml(x.body)}`)].join('\n\n');
}

// Card with Aprobar / Rechazar, posted to the nurse's private chat with the
// bot. The button value carries only the ticket id (Telegram callback data is
// capped at 64 bytes); runId and toolCallId live on the ticket row.
export async function postNurseApprovalCard(agent: AnyAgent | undefined, ticket: Ticket, suggestedReply: string): Promise<PostOutcome> {
  const chatId = requireNurseChatId('nurse card');
  if (!chatId) return { posted: false, reason: 'NURSE_TELEGRAM_CHAT_ID not set' };
  const patient = await readPatient(ticket.chatId);
  const lang: Lang = patient?.language ?? 'es';
  const n = messages(lang).nurse;
  const header = ticketHeader(ticket, lang);
  const sections = nurseCardSections(ticket, patient, suggestedReply, lang);
  return postWithFallback(
    agent,
    chatId,
    'nurse card',
    (thread) =>
      thread.post(
        Card({
          title: header,
          children: [
            Text(sectionsAsPlain(sections)),
            Actions([Button({ id: NURSE_APPROVE, label: n.approve, value: ticket.id, style: 'primary' })]),
            Actions([Button({ id: NURSE_DENY, label: n.writeMyself, value: ticket.id, style: 'danger' })]),
            Actions([Button({ id: NURSE_VIDEO, label: n.video, value: ticket.id })]),
          ],
        }),
      ),
    () =>
      telegramSendMessage(
        chatId,
        sectionsAsHtml(header, sections),
        {
          inline_keyboard: [
            [{ text: n.approve, callback_data: callbackData(NURSE_APPROVE, ticket.id) }],
            [{ text: n.writeMyself, callback_data: callbackData(NURSE_DENY, ticket.id) }],
            [{ text: n.video, callback_data: callbackData(NURSE_VIDEO, ticket.id) }],
          ],
        },
        'HTML',
      ),
  );
}

// Urgent cases do not wait for approval: the nurse gets an FYI so that
// "estoy avisando a tu enfermera" is true.
export async function postNurseAlert(agent: AnyAgent | undefined, ticket: Ticket, note?: string): Promise<PostOutcome> {
  const chatId = requireNurseChatId('nurse alert');
  if (!chatId) return { posted: false, reason: 'NURSE_TELEGRAM_CHAT_ID not set' };
  const patient = await readPatient(ticket.chatId);
  const lang: Lang = patient?.language ?? 'es';
  const n = messages(lang).nurse;
  const header = `${ticket.tier === 'urgent' ? '🚨 ' : ''}${ticketHeader(ticket, lang)}`;
  const sections: CardSection[] = [
    { title: n.patient, body: patientLines(patient, lang, ticket.message).join('\n') },
    { title: n.message, body: ticket.message },
    ...(note ? [{ title: n.nextStep, body: note }] : []),
  ];
  return postWithFallback(
    agent,
    chatId,
    'nurse alert',
    (thread) => thread.post(Card({ title: header, children: [Text(sectionsAsPlain(sections))] })),
    () => telegramSendMessage(chatId, sectionsAsHtml(header, sections), undefined, 'HTML'),
  );
}

// Watches the agent's stream: when notify_nurse suspends for approval, store
// runId + toolCallId on the ticket and post the card to the nurse chat.
export class NurseCardProcessor implements Processor {
  readonly id = 'nurse-card';

  async processOutputStream({ part, agent: contextAgent }: ProcessOutputStreamArgs): Promise<ChunkType> {
    if (part.type !== 'tool-call-approval' || part.payload.toolName !== NOTIFY_NURSE_TOOL) return part;
    const agent = contextAgent ?? nurseAgent;
    try {
      const args = part.payload.args as { ticketId?: unknown; suggestedReply?: unknown };
      const ticketId = typeof args.ticketId === 'string' ? args.ticketId : undefined;
      const suggestedReply = typeof args.suggestedReply === 'string' ? args.suggestedReply : '';
      const ticket = ticketId ? await getTicket(ticketId) : null;
      if (!ticket) {
        logger.warn('notify_nurse suspended for an unknown ticket', { ticketId });
        return part;
      }
      await updateTicket(ticket.id, {
        runId: part.runId,
        toolCallId: part.payload.toolCallId,
        suggestedReply,
        status: 'awaiting_nurse',
      });
      logger.info('notify_nurse suspended, posting nurse card', { ticketId: ticket.id, runId: part.runId, toolCallId: part.payload.toolCallId });
      // Fire and forget: a slow Telegram call must never hold the patient's run.
      void postNurseApprovalCard(agent, ticket, suggestedReply)
        .then((outcome) => logger.info('nurse approval card', { ticketId: ticket.id, ...outcome }))
        .catch((error: unknown) => logger.error('could not post the nurse card', { ticketId: ticket.id, error: String(error) }));
    } catch (error) {
      logger.error('nurse card processor failed', { error: String(error) });
    }
    return part;
  }
}

export type NurseDecisionResult =
  | { outcome: 'resumed'; ticket: Ticket; text: string; delivered: boolean }
  | { outcome: 'already_handled'; ticket: Ticket }
  | { outcome: 'not_found' }
  | { outcome: 'not_suspended'; ticket: Ticket };

// Resume the patient's suspended run with the nurse's decision. The render
// context makes the resumed reply post into the patient's Telegram thread
// when the run came from a channel; from the API it just returns the text.
export async function handleNurseDecision(
  agent: AnyAgent,
  ticketId: string,
  approved: boolean,
  requestContext: RequestContext,
): Promise<NurseDecisionResult> {
  const ticket = await getTicket(ticketId);
  if (!ticket) return { outcome: 'not_found' };
  if (!ticket.runId || !ticket.toolCallId) return { outcome: 'not_suspended', ticket };
  if (ticket.status !== 'awaiting_nurse') return { outcome: 'already_handled', ticket };

  // What the patient sees is posted here, in code. The resumed run only closes
  // the suspended tool call; its text is returned for the API path and logs.
  const m = messages(await patientLanguage(ticket.chatId));
  const patientText = approved ? `${m.nurseSays} ${ticket.suggestedReply ?? ''}`.trim() : m.nurseWillWrite(ticket.patientName ?? undefined);
  const delivered = await postToPatient(agent, ticket.chatId, patientText);
  logger.info('nurse decision delivery', { ticketId: ticket.id, approved, delivered });
  const threadId = clinicalThreadId(ticket.chatId, ticket.id);
  const renderContext = await agent.getChannels()?.buildRenderContextForThread(threadId);
  if (renderContext) requestContext.set(RENDER_CONTEXT_KEY, renderContext);
  // The resumed step must see the same tier context as the original turn,
  // otherwise it gets the default instructions and could open another ticket.
  requestContext.set('tier', 'clinical');
  requestContext.set('ticketId', ticket.id);
  requestContext.set('nurseDecision', approved ? 'approved' : 'declined');
  const memory = { thread: threadId, resource: ticket.chatId };
  const options = { runId: ticket.runId, toolCallId: ticket.toolCallId, requestContext, memory };

  try {
    const stream = approved
      ? await agent.approveToolCall(options)
      : await agent.declineToolCall({
          ...options,
          reason: 'La enfermera ha leído el mensaje y prefiere responder personalmente; escribirá a la paciente en unos minutos.',
        });
    await updateTicket(ticket.id, { status: approved ? 'approved' : 'awaiting_nurse_reply' });
    const text = await stream.text;
    if (approved) {
      await updateTicket(ticket.id, { status: 'answered' });
      await addNurseNote(ticket.chatId, { ticketId: ticket.id, question: ticket.message, reply: ticket.suggestedReply ?? '' }).catch((error: unknown) =>
        logger.warn('could not write nurse note', { ticketId: ticket.id, error: String(error) }),
      );
      await clearOpenTicket(ticket);
    }
    return { outcome: 'resumed', ticket, text, delivered };
  } catch (error) {
    if (error instanceof Error && error.message.includes('No snapshot found')) {
      await updateTicket(ticket.id, { status: 'closed' });
      return { outcome: 'already_handled', ticket };
    }
    throw error;
  }
}

async function clearOpenTicket(ticket: Ticket): Promise<void> {
  try {
    await patchPatient(ticket.chatId, (p) => (p.openTicketId === ticket.id ? { ...p, openTicketId: null } : p));
  } catch (error) {
    logger.warn('could not clear openTicketId', { ticketId: ticket.id, error: String(error) });
  }
}

// Posts into the patient's private chat. Bounded so a slow Telegram call
// cannot delay the rest of the flow.
export interface PatientButton {
  actionId: string;
  label: string;
  value: string;
}

// Plain text, or text with inline buttons (Chat SDK card first, Bot API
// keyboard as fallback; both encode callback_data the same way).
export async function postToPatient(agent: AnyAgent, chatId: string, text: string, buttons?: PatientButton[]): Promise<boolean> {
  const outcome = await postWithFallback(
    agent,
    chatId,
    'patient post',
    (thread) =>
      buttons?.length
        ? thread.post(Card({ children: [Text(text), Actions(buttons.map((b) => Button({ id: b.actionId, label: b.label, value: b.value })))] }))
        : thread.post(text),
    () =>
      telegramSendMessage(
        chatId,
        text,
        buttons?.length ? { inline_keyboard: [buttons.map((b) => ({ text: b.label, callback_data: callbackData(b.actionId, b.value) }))] } : undefined,
      ),
  );
  return outcome.posted;
}

// Nurse tapped 📹 on a clinical ticket: open the room, send the patient her
// link, give the nurse hers.
export async function startNurseVideoCall(agent: AnyAgent, ticketId: string): Promise<{ ticket: Ticket | null; nurseUrl?: string; patientNotified?: boolean }> {
  const ticket = await getTicket(ticketId);
  if (!ticket) return { ticket: null };
  const { patientUrl, nurseUrl } = await startVideoCall(ticketId);
  const m = messages(await patientLanguage(ticket.chatId));
  const patientNotified = await postToPatient(agent, ticket.chatId, m.videoInvite(ticket.patientName ?? undefined, patientUrl));
  return { ticket, nurseUrl, patientNotified };
}

// After a denial, the nurse's next plain message is forwarded to the patient.
export async function forwardNurseReply(agent: AnyAgent, text: string): Promise<{ ticket: Ticket | null; delivered: boolean; lang: Lang }> {
  const ticket = await latestTicketByStatus('awaiting_nurse_reply');
  if (!ticket) return { ticket: null, delivered: false, lang: 'es' };
  const lang = await patientLanguage(ticket.chatId);
  const delivered = await postToPatient(agent, ticket.chatId, `${messages(lang).nurseSays} ${text}`);
  if (!delivered) return { ticket, delivered: false, lang };
  await updateTicket(ticket.id, { status: 'answered', suggestedReply: text });
  await addNurseNote(ticket.chatId, { ticketId: ticket.id, question: ticket.message, reply: text }).catch((error: unknown) =>
    logger.warn('could not write nurse note', { ticketId: ticket.id, error: String(error) }),
  );
  await clearOpenTicket(ticket);
  return { ticket, delivered: true, lang };
}

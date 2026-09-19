import { Agent, type ToolsInput } from '@mastra/core/agent';
import type { ActionChannelHandler, ChannelHandler, SlashCommandChannelHandler } from '@mastra/core/channels';
import type { Processor, ProcessInputStepArgs, ProcessInputStepResult } from '@mastra/core/processors';
import type { RequestContext } from '@mastra/core/request-context';
import { createTelegramAdapter } from '@chat-adapter/telegram';
import type { Author } from 'chat';
import {
  addNurseNote,
  appendSymptom,
  chatIdFromThreadId,
  clinicalThreadId,
  memory,
  patchPatient,
  readPatient,
  recordDoseTaken,
  resetChat,
  summarizePatient,
  writePatient,
} from '../memory/patient-memory';
import { emptyPatient } from '../memory/patient-schema';
import { martaPatient } from '../memory/seed-marta';
import { NebiusCallProcessor, classifyMessage, nebiusProviderOptions, resolvedNebiusModel, type Tier } from '../services/nebius';
import {
  NURSE_APPROVE,
  NURSE_DENY,
  NURSE_VIDEO,
  DOSE_QUESTION,
  DOSE_TAKEN,
  NurseCardProcessor,
  startNurseVideoCall,
  forwardNurseReply,
  handleNurseDecision,
  nurseChatId,
  nurseReplyPrefix,
  postNurseAlert,
  setNurseAgent,
} from '../services/nurse';
import { cancelPendingSends, getTicket, scheduleSend, updateTicket } from '../services/tickets';
import { classifyMessageTool } from '../tools/classify-message';
import { createTicketTool, openTicket } from '../tools/create-ticket';
import { logSymptomTool } from '../tools/log-symptom';
import { notifyNurseTool } from '../tools/notify-nurse';
import { startVideoCallTool } from '../tools/start-video-call';
import { startVideoCall } from '../services/vonage';

const BOT_NAME = process.env.BOT_NAME ?? 'Lumi';
const CLINIC_EMERGENCY_PHONE = process.env.CLINIC_EMERGENCY_PHONE ?? '+34900000000';

export const onboardingMessage = [
  `¡Hola! Soy ${BOT_NAME}, una acompañante para pacientes en tratamiento de FIV. Te ayudo con recordatorios de medicación, citas y dudas prácticas, y paso cualquier consulta médica a tu enfermera.`,
  `No sustituyo a tu equipo médico. Si quieres probar con un caso de ejemplo, envía /demo.`,
].join('\n\n');

export const fallbackReply =
  `Ahora mismo no puedo responderte bien. Estoy avisando a tu enfermera. Si es urgente, llama ya a la clínica: ${CLINIC_EMERGENCY_PHONE}.`;

const baseInstructions = `You are ${BOT_NAME}, a companion for patients going through IVF treatment. You sit between the patient and the clinic on Telegram.

## What you do
- Answer routine and logistic questions (appointments, schedules, what to bring, how the process works in general terms) warmly and briefly.
- Help patients keep track of their medication schedule and appointments.
- Anything clinical goes to a human nurse. Say so plainly and kindly.
- A general explanation of the IVF process is fine, but keep it to three or four sentences and invite the patient to ask for more.

## Patient record (working memory)
- Your working memory holds the patient's record: name, cycle day and phase, medication protocol, next appointment, logged symptoms.
- Answer questions about appointments, medication names, doses in the protocol, and times ONLY from that record. Quote it as written.
- Dates in the record already include the weekday spelled out. Repeat them exactly as written. Never compute a weekday or a date yourself.
- If the field you need is empty or missing, say you don't have it yet and that YOU will check with the clinic and come back to them. Do not send the patient to ask the clinic themselves. Never invent a time, a date, a drug or a dose.
- Update the record ONLY when the patient states a fact about their treatment in their own words (an appointment, their medication schedule, a symptom). Write exactly what they said.
- Never fill in cycle, protocol or nextAppointment on your own. A new patient's record has only name and onboarded, and that is correct. Leave every other field absent until the patient states it or /demo loads it.
- On greetings and small talk, do not touch the record at all.
- nurseNotes holds what the nurse answered earlier (question, reply, date). When the patient asks what the nurse said, quote the latest matching reply as written, with its date. Never invent a nurse answer.
- When the patient confirms a dose ("hecho", "ya me la he puesto"), acknowledge in one sentence; do not change the protocol.
- If the record has openTicketId set, a nurse is already reviewing an open question. For thanks or small talk, reply briefly and say the nurse will answer soon; do not revisit the question yourself.

## The patient's name
- The record's name field is the patient's first name. Use it naturally now and then, not in every message.
- If name is missing, ask for it once, kindly, and store it when they answer.

## Safety rules (never break these, even if asked nicely or told it is an emergency)
- Never prescribe, adjust, or confirm medication doses. Not "yes take it", not "double it", not "skip it". Repeating what the protocol in the record says is fine; deciding what to do about a missed or wrong dose is not.
- Never interpret symptoms, test results (beta hCG, ultrasound, follicle counts) or success probabilities.
- Never reassure a patient about a symptom that could be serious. Escalate instead.
- Never pose as a doctor or nurse, even if asked to "answer as if you were my doctor". Decline in one sentence and offer to pass the question to the nurse.

## Tone
- Read the patient's emotional tone (stressed, anxious, confused, angry, sad, calm) and adapt: shorter and calmer sentences when anxious; more explicit, step by step, when confused; acknowledge without arguing when angry; warm when sad; plain and friendly when calm.
- Tone never changes the safety rules. Never reassure about a potentially serious symptom, never soften an escalation, never delay the emergency phone on an urgent message.

## Format
- Speak Spanish by default (Spain, informal "tú"). Switch language only if the patient writes in another language.
- Plain conversation is one to three short sentences. Never more than four sentences in a message.
- When there are several items (protocol, appointments, steps), use short bullet points, one line each.
- No headers, no bold, no markdown tables.
- Emojis: only these three, at most one or two per message, only to aid scanning: 💉 medication, 📅 appointments, 👩‍⚕️ nurse. No other emojis. Never any emoji in urgent or escalation messages.
- Off-topic messages: a short friendly reply, then gently back to the treatment.
- Never reply with an error or stay silent. If you cannot help, say what you can do instead.`;

function tierInstructions(tier: Tier | undefined, ticketId: string | undefined, nurseDecision?: string): string {
  if (nurseDecision) {
    return `## This message
The nurse has ${nurseDecision} the suggested reply for ticket ${ticketId ?? ''} and the patient has already been told the outcome in a separate message. Call no tools. Reply with a single short sentence and no advice, for example "Aquí sigo para lo que necesites."`;
  }
  switch (tier) {
    case 'clinical':
      return `## This message
Triage tier: CLINICAL. Ticket ${ticketId ?? '(already open)'} exists and the patient has already been told you are contacting the nurse. Do not answer the clinical question yourself and do not create another ticket.
Call notify_nurse exactly once, with ticketId "${ticketId ?? ''}" and a suggestedReply in Spanish written as the nurse would answer: concrete, safe, two or three sentences, addressed to the patient by name if known. Do not write any text before calling the tool.
After notify_nurse returns (approved or declined), the patient has already been told the outcome in a separate message. Reply with a single short sentence and no advice, for example "Aquí sigo para lo que necesites."`;
    case 'urgent':
      return `## This message
Triage tier: URGENT. Ticket ${ticketId ?? '(already open)'} exists and the nurse has been alerted. Call start_video_call with ticketId "${ticketId ?? ''}" first, then reply. The reply must contain, in this order: the patient's name if known, one warm sentence acknowledging what they wrote, the sentence "Estoy avisando a tu enfermera ahora mismo", the video call link from the tool as the place where the nurse will see them now, and the clinic phone with its condition, for example "si el sangrado es abundante o no para, llama ya al ${CLINIC_EMERGENCY_PHONE}" (adapt the condition to the symptom). Four or five short sentences. No emojis. Do not ask the patient to describe more before giving the phone.`;
    case 'logistic':
      return `## This message
Triage tier: LOGISTIC. Answer from the record. If a field is missing, say you will check with the clinic.`;
    case 'routine':
      return `## This message
Triage tier: ROUTINE. Reply briefly and warmly. If the patient mentions a symptom in passing, call log_symptom.`;
    default:
      return `## This message
No triage tier is attached. Classify it yourself with classify_message before answering. If the tier is clinical, open a ticket with create_ticket and then call notify_nurse. If it is urgent, open a ticket, call start_video_call and give the clinic phone ${CLINIC_EMERGENCY_PHONE} in the first sentence.`;
  }
}

const allTools = {
  classify_message: classifyMessageTool,
  log_symptom: logSymptomTool,
  create_ticket: createTicketTool,
  notify_nurse: notifyNurseTool,
  start_video_call: startVideoCallTool,
};

function toolsForTier(tier: Tier | undefined): ToolsInput {
  switch (tier) {
    case 'clinical':
      return { notify_nurse: notifyNurseTool };
    case 'urgent':
      return { start_video_call: startVideoCallTool, log_symptom: logSymptomTool };
    case 'logistic':
    case 'routine':
      return { log_symptom: logSymptomTool };
    default:
      return allTools;
  }
}

function readTier(requestContext: RequestContext): Tier | undefined {
  const value = requestContext.get('tier');
  return value === 'routine' || value === 'logistic' || value === 'clinical' || value === 'urgent' ? value : undefined;
}

function readTicketId(requestContext: RequestContext): string | undefined {
  const value = requestContext.get('ticketId');
  return typeof value === 'string' ? value : undefined;
}

function readNurseDecision(requestContext: RequestContext): string | undefined {
  const value = requestContext.get('nurseDecision');
  return value === 'approved' || value === 'declined' ? value : undefined;
}

// ---------------------------------------------------------------------------
// Deterministic pieces: commands, onboarding, triage, tickets.
// ---------------------------------------------------------------------------

const COMMAND_PATTERN = /^\s*\/(start|demo|reset)(?:@\w+)?(?:\s|$)/i;

export function parseCommand(text: string): 'start' | 'demo' | 'reset' | null {
  const cleaned = text.replace(/<user[^>]*>|<\/user>/gi, '').trim();
  const match = COMMAND_PATTERN.exec(cleaned);
  return match ? (match[1].toLowerCase() as 'start' | 'demo' | 'reset') : null;
}

function firstName(author: Author): string | undefined {
  return author.fullName?.trim().split(/\s+/)[0] || author.userName || undefined;
}

async function ensureOnboarded(chatId: string, author: Author, post: (text: string) => Promise<unknown>): Promise<boolean> {
  const patient = await readPatient(chatId);
  if (patient?.onboarded) return false;
  await post(onboardingMessage);
  await writePatient(chatId, { ...(patient ?? emptyPatient), name: firstName(author), onboarded: true });
  return true;
}

// Seconds until the first demo reminder. The scheduler ticks once a minute,
// so the message lands between 45 s and about 1 min 45 s after /demo.
const DEMO_REMINDER_DELAY_MS = 45 * 1000;

// Shared by the Telegram /demo command and POST /demo/seed.
export async function runDemoSeed(chatId: string): Promise<{ message: string; reminderDueAt: string }> {
  const marta = martaPatient();
  await writePatient(chatId, marta);
  await cancelPendingSends(chatId, 'demo_reminder');
  const row = await scheduleSend({ chatId, kind: 'demo_reminder', dueAt: new Date(Date.now() + DEMO_REMINDER_DELAY_MS) });
  return {
    reminderDueAt: row.dueAt,
    message: `Demo cargada. Ahora eres Marta: día ${marta.cycle?.day} de estimulación, ${marta.protocol[0]?.drug} ${marta.protocol[0]?.dose} a las ${marta.protocol[0]?.time}, ${marta.nextAppointment?.type} el ${marta.nextAppointment?.datetime}. Pregúntame lo que quieras; en un minuto te llegará tu primer recordatorio.`,
  };
}

// Shared by the Telegram /reset command and POST /demo/reset.
export async function runDemoReset(chatId: string): Promise<{ message: string; cancelled: number }> {
  const cancelled = await cancelPendingSends(chatId);
  await resetChat(chatId);
  return { cancelled, message: 'He borrado la memoria de este chat. Escríbeme «hola» para empezar de nuevo.' };
}

async function handleCommand(
  command: 'start' | 'demo' | 'reset',
  chatId: string,
  author: Author,
  post: (text: string) => Promise<unknown>,
): Promise<void> {
  switch (command) {
    case 'demo': {
      const { message } = await runDemoSeed(chatId);
      await post(message);
      return;
    }
    case 'reset': {
      const { message } = await runDemoReset(chatId);
      await post(message);
      return;
    }
    case 'start': {
      const onboarded = await ensureOnboarded(chatId, author, post);
      if (!onboarded) await post('¡Hola de nuevo! ¿En qué te puedo ayudar hoy?');
    }
  }
}

export interface PreparedTurn {
  tier: Tier;
  reason: string;
  ticketId?: string;
  ticket?: Awaited<ReturnType<typeof getTicket>>;
  /** Posted before the model runs (clinical). */
  ack?: string;
  /** The whole reply, composed in code; the model does not run (urgent). */
  directReply?: string;
}

// Everything that happens to a patient message before the model sees it:
// triage, symptom log, ticket, request context. Shared by the Telegram
// handler and POST /eval/message so both paths behave the same.
export async function prepareTurn(chatId: string, text: string, requestContext: RequestContext): Promise<PreparedTurn> {
  const { tier, reason } = await classifyMessage(text);
  requestContext.set('tier', tier);
  if (tier !== 'clinical' && tier !== 'urgent') return { tier, reason };
  const patient = await readPatient(chatId);
  await appendSymptom(chatId, text, tier);
  const { ticketId } = await openTicket({ chatId, tier, message: text, contextSummary: summarizePatient(patient) });
  requestContext.set('ticketId', ticketId);
  const ticket = await getTicket(ticketId);
  if (tier === 'urgent') {
    const { patientUrl, nurseUrl } = await startVideoCall(ticketId);
    await addNurseNote(chatId, {
      ticketId,
      question: text,
      reply: `Caso urgente: se avisó a la enfermera, se abrió videollamada (${patientUrl}) y se dio el teléfono de la clínica ${CLINIC_EMERGENCY_PHONE}.`,
    }).catch(() => undefined);
    // The 24 h follow-up is planned now and persisted; the reminders tick sends it.
    await scheduleSend({ chatId, kind: 'followup', ticketId, dueAt: new Date(Date.now() + 24 * 60 * 60 * 1000) }).catch(() => undefined);
    if (ticket) {
      void postNurseAlert(companion, ticket, `Entra en la videollamada con la paciente: ${nurseUrl}`)
        .then((o) => console.info('[companion] nurse alert', { ticketId, ...o }))
        .catch((error: unknown) => console.warn('[companion] nurse alert not posted', { ticketId, error: String(error) }));
    }
    return { tier, reason, ticketId, ticket, directReply: urgentReply(patient?.name, patientUrl) };
  }
  return { tier, reason, ticketId, ticket, ack: clinicalAck(patient?.name) };
}

// Urgent replies are composed here, not by the model: in tests Nemotron dropped
// the phone number or wrote "[link]" one time in three. Never an emoji here.
function urgentReply(name: string | undefined, videoUrl: string): string {
  return [
    `${name ? `${name}, gracias` : 'Gracias'} por contármelo; te leo y no estás sola en esto.`,
    `Estoy avisando a tu enfermera ahora mismo y te va a atender por videollamada en este enlace: ${videoUrl}`,
    `Si empeora, no mejora o no puedes esperar, llama ya a la clínica al ${CLINIC_EMERGENCY_PHONE}.`,
  ].join('\n');
}

// Step 0 of a clinical turn must be the notify_nurse call: left to itself the
// model sometimes answers as if the nurse had already approved.
class TierToolChoiceProcessor implements Processor {
  readonly id = 'tier-tool-choice';

  async processInputStep({ stepNumber, requestContext }: ProcessInputStepArgs): Promise<ProcessInputStepResult | undefined> {
    if (stepNumber !== 0 || !requestContext || readNurseDecision(requestContext)) return undefined;
    // A named tool choice through the stream took ~30 s on Nebius; "required"
    // on a fresh per-ticket thread takes ~2 s. runClinicalTurn checks afterwards
    // that notify_nurse was in fact the tool called.
    if (readTier(requestContext) === 'clinical') return { toolChoice: 'required' };
    return undefined;
  }
}

// Clinical turns run on a fresh per-ticket thread so notify_nurse can be
// forced on step 0 without the 30 s Nebius penalty (see clinicalThreadId).
export async function runClinicalTurn(chatId: string, ticketId: string, text: string, requestContext: RequestContext) {
  const result = await companion.generate(text, {
    requestContext,
    memory: { thread: clinicalThreadId(chatId, ticketId), resource: chatId },
  });
  // Safety net: if the model ended the turn without suspending on notify_nurse,
  // hand the ticket to the nurse anyway so her typed reply gets forwarded.
  const ticket = await getTicket(ticketId);
  if (ticket && ticket.status === 'open') {
    console.warn('[companion] clinical turn ended without notify_nurse; routing ticket to the nurse directly', { ticketId, finishReason: result.finishReason });
    await updateTicket(ticketId, { status: 'awaiting_nurse_reply' });
    await postNurseAlert(companion, ticket, 'Responde en este chat y se lo reenvío a la paciente tal cual.').catch(() => undefined);
  }
  return result;
}

function clinicalAck(name: string | undefined): string {
  return `${name ? `${name}, esto` : 'Esto'} se lo paso a tu enfermera ahora mismo 👩‍⚕️. Te escribo en cuanto me conteste.`;
}

const onSlashCommand: SlashCommandChannelHandler = async (event, _defaultHandler, ctx) => {
  const logger = ctx.mastra?.getLogger();
  const chatId = chatIdFromThreadId(event.channel.id);
  const command = parseCommand(`${event.command} ${event.text}`);
  logger?.info('telegram command', { chatId, command: event.command, userId: event.user.userId });
  if (chatId === nurseChatId()) {
    await event.channel.post('Este es el chat de la enfermera: aquí recibes los tickets y respondes a las pacientes.').catch(() => undefined);
    return;
  }
  try {
    if (command) {
      await handleCommand(command, chatId, event.user, (text) => event.channel.post(text));
    } else {
      await event.channel.post('No conozco ese comando. Puedes usar /start, /demo o /reset, o simplemente escribirme.');
    }
  } catch (error) {
    logger?.error('command failed', { chatId, command, error });
    await event.channel.post(fallbackReply).catch(() => undefined);
  }
};

const onDirectMessage: ChannelHandler = async (thread, message, defaultHandler, ctx) => {
  const logger = ctx.mastra?.getLogger();
  const chatId = chatIdFromThreadId(thread.id);
  const text = message.text.replace(/<user[^>]*>|<\/user>/gi, '').trim();
  logger?.info('telegram inbound', { chatId, userId: message.author.userId, userName: message.author.userName, threadId: thread.id });

  // The nurse's chat is never onboarded and never reaches the model.
  if (chatId === nurseChatId()) {
    try {
      const { ticket, delivered } = await forwardNurseReply(companion, text);
      if (!ticket) await thread.post('No hay ningún ticket esperando tu respuesta ahora mismo.');
      else if (delivered) await thread.post(`Enviado a ${ticket.patientName ?? 'la paciente'} (ticket ${ticket.id}).`);
      else await thread.post(`No he podido reenviarlo (ticket ${ticket.id}). Inténtalo de nuevo.`);
    } catch (error) {
      logger?.error('nurse reply forwarding failed', { error });
      await thread.post('No he podido reenviar tu respuesta. Inténtalo de nuevo.').catch(() => undefined);
    }
    return;
  }

  const post = (t: string) => thread.post(t);
  try {
    const command = parseCommand(text);
    if (command) {
      await handleCommand(command, chatId, message.author, post);
      return;
    }
    if (await ensureOnboarded(chatId, message.author, post)) {
      // First contact: the onboarding text is the reply.
      return;
    }

    const turn = await prepareTurn(chatId, text, ctx.requestContext);
    logger?.info('triage', { chatId, tier: turn.tier, reason: turn.reason, ticketId: turn.ticketId });
    if (turn.ack) await post(turn.ack);
    if (turn.directReply) {
      await post(turn.directReply);
      return;
    }
    if (turn.tier === 'clinical' && turn.ticketId) {
      try {
        const result = await runClinicalTurn(chatId, turn.ticketId, text, ctx.requestContext);
        logger?.info('clinical turn finished', { chatId, ticketId: turn.ticketId, finishReason: result.finishReason });
      } catch (error) {
        logger?.error('clinical turn failed, sending fallback', { chatId, ticketId: turn.ticketId, error });
        await post(fallbackReply);
      }
      return;
    }
  } catch (error) {
    logger?.error('pre-handler failed, continuing with default handler', { chatId, error });
  }

  try {
    await defaultHandler(thread, message);
  } catch (error) {
    logger?.error('agent run failed, sending fallback reply', { chatId, error });
    await thread.post(fallbackReply).catch((postError) => logger?.error('fallback reply could not be posted', { chatId, error: postError }));
  }
};

// Accepts both encodings: actionId + value (Chat SDK card / our keyboard)
// and a bare "nurse_approve:<ticketId>" string.
function parseNurseAction(actionId: string, value: string | undefined): { kind: 'approve' | 'deny' | 'video'; ticketId: string } | null {
  const [id, rest] = actionId.includes(':') ? [actionId.slice(0, actionId.indexOf(':')), actionId.slice(actionId.indexOf(':') + 1)] : [actionId, undefined];
  const kind = id === NURSE_APPROVE ? 'approve' : id === NURSE_DENY ? 'deny' : id === NURSE_VIDEO ? 'video' : null;
  if (!kind) return null;
  const ticketId = (value && value !== actionId ? value : rest) ?? '';
  return { kind, ticketId };
}

// Reminder buttons in the patient chat.
async function handleDoseAction(actionId: string, slot: string | undefined, chatId: string, post: (t: string) => Promise<unknown>): Promise<boolean> {
  if (actionId !== DOSE_TAKEN && actionId !== DOSE_QUESTION) return false;
  const patient = await readPatient(chatId);
  const item = patient?.protocol.find((p) => p.time === slot) ?? patient?.protocol[0];
  if (actionId === DOSE_TAKEN) {
    if (item) await recordDoseTaken(chatId, item);
    await post(item ? `Anotado 💉 ${item.drug} ${item.dose} a las ${item.time}. ¡Bien hecho!` : 'Anotado. ¡Bien hecho!');
  } else {
    await post('Cuéntame, te leo. Si es algo sobre la dosis o cómo te sientes, se lo paso a tu enfermera.');
  }
  return true;
}

const onAction: ActionChannelHandler = async (event, defaultHandler, ctx) => {
  const logger = ctx.mastra?.getLogger();
  logger?.info('telegram action', { actionId: event.actionId, value: event.value, from: event.user.userId });
  const patientChatId = event.thread ? chatIdFromThreadId(event.thread.id) : undefined;
  if (patientChatId && (await handleDoseAction(event.actionId, event.value, patientChatId, (t) => event.thread!.post(t)).catch((error) => {
    logger?.error('dose action failed', { actionId: event.actionId, error });
    return true;
  }))) {
    return;
  }
  const parsed = parseNurseAction(event.actionId, event.value);
  if (!parsed) {
    await defaultHandler();
    return;
  }
  const { kind, ticketId } = parsed;
  const approved = kind === 'approve';
  const reply = (t: string) => event.thread?.post(t).catch(() => undefined);
  if (kind === 'video') {
    try {
      const { ticket, nurseUrl, patientNotified } = await startNurseVideoCall(companion, ticketId);
      if (!ticket) await reply(`No encuentro el ticket ${ticketId}.`);
      else await reply(`${patientNotified ? 'Le he enviado el enlace a' : 'No he podido avisar a'} ${ticket.patientName ?? 'la paciente'}. Tu enlace: ${nurseUrl}`);
    } catch (error) {
      logger?.error('video call start failed', { ticketId, error });
      await reply(`No he podido abrir la videollamada del ticket ${ticketId}.`);
    }
    return;
  }
  try {
    const result = await handleNurseDecision(companion, ticketId, approved, ctx.requestContext);
    switch (result.outcome) {
      case 'resumed':
        await reply(
          approved
            ? `Enviado a ${result.ticket.patientName ?? 'la paciente'} (ticket ${result.ticket.id}).`
            : `Ticket ${result.ticket.id} rechazado. Escribe aquí tu respuesta para ${result.ticket.patientName ?? 'la paciente'} y se la reenvío tal cual.`,
        );
        return;
      case 'already_handled':
        await reply(`El ticket ${result.ticket.id} ya se gestionó.`);
        return;
      case 'not_suspended':
        await reply(`El ticket ${result.ticket.id} no está esperando aprobación.`);
        return;
      case 'not_found':
        await reply(`No encuentro el ticket ${ticketId}.`);
    }
  } catch (error) {
    logger?.error('nurse decision failed', { ticketId, approved, error });
    await reply(`No he podido aplicar la decisión del ticket ${ticketId}. Inténtalo de nuevo.`);
  }
};

function telegramMode(): 'webhook' | 'polling' {
  return process.env.TELEGRAM_MODE === 'polling' ? 'polling' : 'webhook';
}

const mainCallProcessor = new NebiusCallProcessor('main');

export const companion = new Agent({
  id: 'companion',
  name: BOT_NAME,
  instructions: ({ requestContext }) =>
    `${baseInstructions}\n\n${tierInstructions(readTier(requestContext), readTicketId(requestContext), readNurseDecision(requestContext))}`,
  model: () => resolvedNebiusModel('main'),
  tools: ({ requestContext }) => toolsForTier(readTier(requestContext)),
  memory,
  defaultOptions: {
    providerOptions: nebiusProviderOptions('main'),
  },
  inputProcessors: [mainCallProcessor, new TierToolChoiceProcessor()],
  outputProcessors: [mainCallProcessor, new NurseCardProcessor()],
  channels: {
    adapters: {
      telegram: {
        adapter: createTelegramAdapter({ mode: telegramMode() }),
        toolDisplay: 'hidden',
        formatError: (error) => {
          console.error('[companion] run error rendered to patient as fallback', error);
          return fallbackReply;
        },
      },
    },
    tools: false,
    resolveResourceId: ({ thread }) => chatIdFromThreadId(thread.id),
    resolveThreadId: ({ thread }) => thread.id,
    handlers: { onDirectMessage, onSlashCommand, onAction },
  },
});

setNurseAgent(companion);

export { patchPatient };

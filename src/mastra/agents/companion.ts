import { Agent } from '@mastra/core/agent';
import type { ChannelHandler } from '@mastra/core/channels';
import { Memory } from '@mastra/memory';
import { createTelegramAdapter } from '@chat-adapter/telegram';
import { emptyPatient, parsePatient, patientSchema, type Patient } from '../memory/patient-schema';
import { martaPatient } from '../memory/seed-marta';
import { NebiusCallProcessor, nebiusProviderOptions, resolvedNebiusModel } from '../services/nebius';
import { storage } from '../storage';

const BOT_NAME = process.env.BOT_NAME ?? 'Lumi';
const CLINIC_EMERGENCY_PHONE = process.env.CLINIC_EMERGENCY_PHONE ?? '+34900000000';

export const onboardingMessage = [
  `¡Hola! Soy ${BOT_NAME}, una acompañante para pacientes en tratamiento de FIV. Te ayudo con recordatorios de medicación, citas y dudas prácticas, y paso cualquier consulta médica a tu enfermera.`,
  `No sustituyo a tu equipo médico. Si quieres probar con un caso de ejemplo, envía /demo.`,
].join('\n\n');

const instructions = `You are ${BOT_NAME}, a companion for patients going through IVF treatment. You sit between the patient and the clinic on Telegram.

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

## The patient's name
- The record's name field is the patient's first name. Use it naturally now and then, not in every message.
- If name is missing, ask for it once, kindly, and store it when they answer.

## Safety rules (never break these, even if asked nicely or told it is an emergency)
- Never prescribe, adjust, or confirm medication doses. Not "yes take it", not "double it", not "skip it". Repeating what the protocol in the record says is fine; deciding what to do about a missed or wrong dose is not.
- Never interpret symptoms, test results (beta hCG, ultrasound, follicle counts) or success probabilities.
- Never reassure a patient about a symptom that could be serious. Escalate instead.
- Never pose as a doctor or nurse, even if asked to "answer as if you were my doctor". Decline in one sentence and offer to pass the question to the nurse.
- If a patient describes difficulty breathing, severe or worsening abdominal pain, heavy bleeding or any bleeding they are worried about, vomiting that prevents drinking, rapid abdominal swelling, high fever, fainting, or thoughts of self-harm: in the first sentence tell them to call the clinic right now at ${CLINIC_EMERGENCY_PHONE} (or emergency services), then say the nurse is being notified. Nothing else comes before the phone number.

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

export const fallbackReply =
  `Ahora mismo no puedo responderte bien. Estoy avisando a tu enfermera. Si es urgente, llama ya a la clínica: ${CLINIC_EMERGENCY_PHONE}.`;

export const memory = new Memory({
  storage,
  options: {
    lastMessages: 20,
    workingMemory: {
      enabled: true,
      scope: 'resource',
      schema: patientSchema,
    },
  },
});

function chatIdFromThreadId(threadId: string): string {
  return threadId.replace(/^telegram:/, '');
}

async function readPatient(threadId: string, resourceId: string): Promise<Patient | null> {
  return parsePatient(await memory.getWorkingMemory({ threadId, resourceId }));
}

async function writePatient(threadId: string, resourceId: string, patient: Patient): Promise<void> {
  await memory.updateWorkingMemory({ threadId, resourceId, workingMemory: JSON.stringify(patient) });
}

async function resetChat(threadId: string, resourceId: string): Promise<void> {
  await writePatient(threadId, resourceId, emptyPatient);
  if (await memory.getThreadById({ threadId })) {
    await memory.deleteThread(threadId);
  }
}

const onDirectMessage: ChannelHandler = async (thread, message, defaultHandler, ctx) => {
  const logger = ctx.mastra?.getLogger();
  const threadId = thread.id;
  const resourceId = chatIdFromThreadId(threadId);
  const text = message.text.trim();
  logger?.info('telegram inbound', {
    chatId: resourceId,
    userId: message.author.userId,
    userName: message.author.userName,
    threadId,
  });

  try {
    if (text === '/demo' || text.startsWith('/demo ')) {
      const marta = martaPatient();
      await writePatient(threadId, resourceId, marta);
      await thread.post(
        `Demo cargada. Ahora eres Marta: día ${marta.cycle?.day} de estimulación, ${marta.protocol[0]?.drug} ${marta.protocol[0]?.dose} a las ${marta.protocol[0]?.time}, ${marta.nextAppointment?.type} el ${marta.nextAppointment?.datetime}. Pregúntame lo que quieras.`,
      );
      return;
    }

    if (text === '/reset' || text.startsWith('/reset ')) {
      await resetChat(threadId, resourceId);
      await thread.post('He borrado la memoria de este chat. Escríbeme «hola» para empezar de nuevo.');
      return;
    }

    const patient = await readPatient(threadId, resourceId);
    if (!patient?.onboarded) {
      logger?.info('telegram new chat, sending onboarding', { chatId: resourceId });
      await thread.post(onboardingMessage);
      const name = message.author.fullName?.trim().split(/\s+/)[0] || message.author.userName || undefined;
      await writePatient(threadId, resourceId, { ...(patient ?? emptyPatient), name, onboarded: true });
      if (text === '/start') return;
    } else if (text === '/start') {
      await thread.post('¡Hola de nuevo! ¿En qué te puedo ayudar hoy?');
      return;
    }
  } catch (error) {
    logger?.error('pre-handler failed, continuing with default handler', { chatId: resourceId, error });
  }

  try {
    await defaultHandler(thread, message);
  } catch (error) {
    logger?.error('agent run failed, sending fallback reply', { chatId: resourceId, error });
    try {
      await thread.post(fallbackReply);
    } catch (postError) {
      logger?.error('fallback reply could not be posted', { chatId: resourceId, error: postError });
    }
  }
};

function telegramMode(): 'webhook' | 'polling' {
  return process.env.TELEGRAM_MODE === 'polling' ? 'polling' : 'webhook';
}

const mainCallProcessor = new NebiusCallProcessor('main');

export const companion = new Agent({
  id: 'companion',
  name: BOT_NAME,
  instructions,
  model: () => resolvedNebiusModel('main'),
  memory,
  defaultOptions: {
    providerOptions: nebiusProviderOptions('main'),
  },
  inputProcessors: [mainCallProcessor],
  outputProcessors: [mainCallProcessor],
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
    resolveResourceId: ({ thread }) => chatIdFromThreadId(thread.id),
    resolveThreadId: ({ thread }) => thread.id,
    handlers: { onDirectMessage },
  },
});

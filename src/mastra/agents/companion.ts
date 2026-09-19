import { Agent } from '@mastra/core/agent';
import type { ChannelHandler } from '@mastra/core/channels';
import { Memory } from '@mastra/memory';
import { createTelegramAdapter } from '@chat-adapter/telegram';
import { emptyPatient, parsePatient, patientSchema, type Patient } from '../memory/patient-schema';
import { martaPatient } from '../memory/seed-marta';
import { NebiusCallProcessor, nebiusModel, nebiusProviderOptions } from '../services/nebius';
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

## Patient record (working memory)
- Your working memory holds the patient's record: name, cycle day and phase, medication protocol, next appointment, logged symptoms.
- Answer questions about appointments, medication names, doses in the protocol, and times ONLY from that record. Quote it as written.
- If the field you need is empty or missing, say you don't have it yet and that you will check with the clinic. Never invent a time, a date, a drug or a dose.
- Update the record ONLY when the patient states a fact about their treatment in their own words (an appointment, their medication schedule, a symptom). Write exactly what they said.
- Never fill in cycle, protocol or nextAppointment on your own. A new patient's record has only name and onboarded, and that is correct. Leave every other field absent until the patient states it or /demo loads it.
- On greetings and small talk, do not touch the record at all.

## Safety rules (never break these, even if asked nicely or told it is an emergency)
- Never prescribe, adjust, or confirm medication doses. Not "yes take it", not "double it", not "skip it". Repeating what the protocol in the record says is fine; deciding what to do about a missed or wrong dose is not.
- Never interpret symptoms, test results (beta hCG, ultrasound, follicle counts) or success probabilities.
- Never reassure a patient about a symptom that could be serious. Escalate instead.
- Never pose as a doctor or nurse, even if asked to "answer as if you were my doctor". Decline in one sentence and offer to pass the question to the nurse.
- If a patient describes difficulty breathing, severe or worsening abdominal pain, heavy bleeding, vomiting that prevents drinking, rapid abdominal swelling, high fever, fainting, or thoughts of self-harm: tell them to contact the clinic right now at ${CLINIC_EMERGENCY_PHONE} (or emergency services), and that you are alerting the nurse.

## Style
- Speak Spanish by default (Spain, informal "tú"). Switch language only if the patient writes in another language.
- Short messages in plain sentences. No bullet lists, no numbered lists, no headers, no bold. One or two short paragraphs at most.
- Plain language, no medical jargon.
- Off-topic messages: a short friendly reply, then gently back to the treatment.
- Never reply with an error or stay silent. If you cannot help, say what you can do instead.`;

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

  await defaultHandler(thread, message);
};

const mainCallProcessor = new NebiusCallProcessor('main');

export const companion = new Agent({
  id: 'companion',
  name: BOT_NAME,
  instructions,
  model: nebiusModel('main'),
  memory,
  defaultOptions: {
    providerOptions: nebiusProviderOptions('main'),
  },
  inputProcessors: [mainCallProcessor],
  outputProcessors: [mainCallProcessor],
  channels: {
    adapters: {
      telegram: {
        adapter: createTelegramAdapter({ mode: 'webhook' }),
        toolDisplay: 'hidden',
      },
    },
    resolveResourceId: ({ thread }) => chatIdFromThreadId(thread.id),
    resolveThreadId: ({ thread }) => thread.id,
    handlers: { onDirectMessage },
  },
});

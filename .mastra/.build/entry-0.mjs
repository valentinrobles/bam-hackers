import { Mastra } from '@mastra/core/mastra';
import { PinoLogger } from '@mastra/loggers';
import { Agent } from '@mastra/core/agent';
import { Memory } from '@mastra/memory';
import { createTelegramAdapter } from '@chat-adapter/telegram';
import { z } from 'zod';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { LibSQLStore } from '@mastra/libsql';

"use strict";
const cyclePhases = ["stimulation", "trigger", "retrieval", "transfer", "two_week_wait"];
const symptomTiers = ["routine", "clinical", "urgent"];
const ONLY_IF_STATED = "Omit entirely unless the patient stated it explicitly or /demo seeded it. Never guess.";
const patientSchema = z.object({
  name: z.string().optional().describe("Patient first name."),
  onboarded: z.boolean().default(false),
  cycle: z.object({
    day: z.number(),
    phase: z.enum(cyclePhases),
    startDate: z.string()
  }).optional().describe(`Current treatment cycle. ${ONLY_IF_STATED}`),
  protocol: z.array(z.object({ drug: z.string(), dose: z.string(), time: z.string() })).default([]).describe(`Medication protocol. ${ONLY_IF_STATED}`),
  nextAppointment: z.object({ type: z.string(), datetime: z.string() }).optional().describe(`Next clinic appointment. ${ONLY_IF_STATED}`),
  symptoms: z.array(z.object({ date: z.string(), text: z.string(), tier: z.enum(symptomTiers) })).default([]).describe("Symptoms the patient reported, appended over time."),
  openTicketId: z.string().nullable().default(null)
});
const emptyPatient = patientSchema.parse({});
function parsePatient(raw) {
  if (!raw) return null;
  try {
    return patientSchema.parse(JSON.parse(raw));
  } catch {
    return null;
  }
}

"use strict";
const es = new Intl.DateTimeFormat("es-ES", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
function spanishDate(d) {
  return es.format(d);
}
function daysFrom(from, days) {
  const d = new Date(from);
  d.setDate(d.getDate() + days);
  return d;
}
function nextWeekday(from, weekday) {
  return daysFrom(from, (weekday - from.getDay() + 7) % 7 || 7);
}
function martaPatient(now = /* @__PURE__ */ new Date()) {
  return {
    name: "Marta",
    onboarded: true,
    cycle: { day: 6, phase: "stimulation", startDate: spanishDate(daysFrom(now, -5)) },
    protocol: [{ drug: "Gonal-f", dose: "225 UI", time: "21:00" }],
    nextAppointment: { type: "ecograf\xEDa de control", datetime: `${spanishDate(nextWeekday(now, 4))}, 10:00` },
    symptoms: [],
    openTicketId: null
  };
}

"use strict";
const ENV_VAR = { main: "MODEL_MAIN", triage: "MODEL_TRIAGE" };
const DEFAULT_MODEL = {
  main: "nvidia/nemotron-3-super-120b-a12b",
  triage: "nvidia/nemotron-3-super-120b-a12b"
};
function noThinkingBody(modelId) {
  return /glm/i.test(modelId) ? { thinking: { type: "disabled" } } : { chat_template_kwargs: { enable_thinking: false } };
}
const logger = new PinoLogger({ name: "nebius", level: "info" });
function nebiusModelId(role) {
  return process.env[ENV_VAR[role]] || DEFAULT_MODEL[role];
}
function nebiusBaseUrl() {
  return (process.env.NEBIUS_BASE_URL || "https://api.tokenfactory.nebius.com/v1").replace(/\/+$/, "");
}
let servedModelIds;
async function listServedModelIds() {
  if (!servedModelIds) {
    servedModelIds = (async () => {
      const apiKey = process.env.NEBIUS_API_KEY;
      if (!apiKey) return [];
      const res = await fetch(`${nebiusBaseUrl()}/models`, {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(5e3)
      });
      if (!res.ok) throw new Error(`GET /models returned ${res.status}`);
      const body = await res.json();
      return (body.data ?? []).map((m) => m.id).filter((id) => typeof id === "string");
    })().catch((error) => {
      logger.warn("nebius: could not list models, using configured ids as-is", { error: String(error) });
      servedModelIds = void 0;
      return [];
    });
  }
  return servedModelIds;
}
const resolvedIds = /* @__PURE__ */ new Map();
async function resolveNebiusModelId(role) {
  const cached = resolvedIds.get(role);
  if (cached) return cached;
  const configured = nebiusModelId(role);
  const served = await listServedModelIds();
  const match = served.find((id) => id.toLowerCase() === configured.toLowerCase());
  if (!match) {
    if (served.length) logger.warn("nebius: configured model id is not in /models", { role, configured });
    return configured;
  }
  if (match !== configured) logger.warn("nebius: corrected model id case", { role, configured, served: match });
  resolvedIds.set(role, match);
  return match;
}
function nebiusModel(role, modelId = nebiusModelId(role)) {
  const baseUrl = process.env.NEBIUS_BASE_URL;
  return {
    id: `nebius/${modelId}`,
    apiKey: process.env.NEBIUS_API_KEY,
    ...baseUrl ? { url: baseUrl } : {}
  };
}
async function resolvedNebiusModel(role) {
  return nebiusModel(role, await resolveNebiusModelId(role));
}
function nebiusProviderOptions(role) {
  return { nebius: noThinkingBody(nebiusModelId(role)) };
}
const THINK_CLOSE = "</think>";
const THINK_OPEN = "<think>";
function stripThinking(text) {
  const idx = text.lastIndexOf(THINK_CLOSE);
  if (idx === -1) return text;
  return text.slice(idx + THINK_CLOSE.length).trimStart();
}
function logModelCall(stats) {
  logger.info(`nebius ${stats.role} call`, stats);
}
function thinkState(state) {
  if (!state.think) state.think = { phase: "undecided", buffer: "" };
  return state.think;
}
class NebiusCallProcessor {
  constructor(role) {
    this.role = role;
    this.id = `nebius-${role}`;
  }
  role;
  id;
  async processInputStep({ stepNumber, state }) {
    state[`step-${stepNumber}-start`] = Date.now();
  }
  async processOutputStep({ messages, stepNumber, usage, state }) {
    const startedAt = state[`step-${stepNumber}-start`];
    logModelCall({
      role: this.role,
      model: resolvedIds.get(this.role) ?? nebiusModelId(this.role),
      step: stepNumber,
      latencyMs: typeof startedAt === "number" ? Date.now() - startedAt : -1,
      inputTokens: usage?.inputTokens,
      outputTokens: usage?.outputTokens,
      totalTokens: usage?.totalTokens,
      reasoningTokens: usage?.reasoningTokens
    });
    return messages;
  }
  async processOutputStream({ part, state }) {
    if (part.type !== "text-delta") return part;
    const think = thinkState(state);
    if (think.phase === "passthrough") return part;
    think.buffer += part.payload.text;
    const trimmed = think.buffer.trimStart();
    if (think.phase === "undecided") {
      if (trimmed.startsWith(THINK_OPEN)) {
        think.phase = "thinking";
      } else if (THINK_OPEN.startsWith(trimmed)) {
        return null;
      } else {
        think.phase = "passthrough";
        return { ...part, payload: { ...part.payload, text: think.buffer } };
      }
    }
    if (!think.buffer.includes(THINK_CLOSE)) return null;
    think.phase = "passthrough";
    const rest = stripThinking(think.buffer);
    return rest ? { ...part, payload: { ...part.payload, text: rest } } : null;
  }
}

"use strict";
function projectRoot() {
  let dir = process.cwd();
  while (true) {
    if (existsSync(path.join(dir, "package.json")) && !dir.includes(`${path.sep}.mastra${path.sep}`)) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return process.cwd();
    dir = parent;
  }
}
const storage = new LibSQLStore({
  id: "ivf-companion-storage",
  url: process.env.DATABASE_URL ?? `file:${path.join(projectRoot(), "mastra.db")}`
});

"use strict";
const BOT_NAME = process.env.BOT_NAME ?? "Lumi";
const CLINIC_EMERGENCY_PHONE = process.env.CLINIC_EMERGENCY_PHONE ?? "+34900000000";
const onboardingMessage = [
  `\xA1Hola! Soy ${BOT_NAME}, una acompa\xF1ante para pacientes en tratamiento de FIV. Te ayudo con recordatorios de medicaci\xF3n, citas y dudas pr\xE1cticas, y paso cualquier consulta m\xE9dica a tu enfermera.`,
  `No sustituyo a tu equipo m\xE9dico. Si quieres probar con un caso de ejemplo, env\xEDa /demo.`
].join("\n\n");
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
- Speak Spanish by default (Spain, informal "t\xFA"). Switch language only if the patient writes in another language.
- Plain conversation is one to three short sentences. Never more than four sentences in a message.
- When there are several items (protocol, appointments, steps), use short bullet points, one line each.
- No headers, no bold, no markdown tables.
- Emojis: only these three, at most one or two per message, only to aid scanning: \u{1F489} medication, \u{1F4C5} appointments, \u{1F469}\u200D\u2695\uFE0F nurse. No other emojis. Never any emoji in urgent or escalation messages.
- Off-topic messages: a short friendly reply, then gently back to the treatment.
- Never reply with an error or stay silent. If you cannot help, say what you can do instead.`;
const fallbackReply = `Ahora mismo no puedo responderte bien. Estoy avisando a tu enfermera. Si es urgente, llama ya a la cl\xEDnica: ${CLINIC_EMERGENCY_PHONE}.`;
const memory = new Memory({
  storage,
  options: {
    lastMessages: 20,
    workingMemory: {
      enabled: true,
      scope: "resource",
      schema: patientSchema
    }
  }
});
function chatIdFromThreadId(threadId) {
  return threadId.replace(/^telegram:/, "");
}
async function readPatient(threadId, resourceId) {
  return parsePatient(await memory.getWorkingMemory({ threadId, resourceId }));
}
async function writePatient(threadId, resourceId, patient) {
  await memory.updateWorkingMemory({ threadId, resourceId, workingMemory: JSON.stringify(patient) });
}
async function resetChat(threadId, resourceId) {
  await writePatient(threadId, resourceId, emptyPatient);
  if (await memory.getThreadById({ threadId })) {
    await memory.deleteThread(threadId);
  }
}
const onDirectMessage = async (thread, message, defaultHandler, ctx) => {
  const logger = ctx.mastra?.getLogger();
  const threadId = thread.id;
  const resourceId = chatIdFromThreadId(threadId);
  const text = message.text.trim();
  logger?.info("telegram inbound", {
    chatId: resourceId,
    userId: message.author.userId,
    userName: message.author.userName,
    threadId
  });
  try {
    if (text === "/demo" || text.startsWith("/demo ")) {
      const marta = martaPatient();
      await writePatient(threadId, resourceId, marta);
      await thread.post(
        `Demo cargada. Ahora eres Marta: d\xEDa ${marta.cycle?.day} de estimulaci\xF3n, ${marta.protocol[0]?.drug} ${marta.protocol[0]?.dose} a las ${marta.protocol[0]?.time}, ${marta.nextAppointment?.type} el ${marta.nextAppointment?.datetime}. Preg\xFAntame lo que quieras.`
      );
      return;
    }
    if (text === "/reset" || text.startsWith("/reset ")) {
      await resetChat(threadId, resourceId);
      await thread.post("He borrado la memoria de este chat. Escr\xEDbeme \xABhola\xBB para empezar de nuevo.");
      return;
    }
    const patient = await readPatient(threadId, resourceId);
    if (!patient?.onboarded) {
      logger?.info("telegram new chat, sending onboarding", { chatId: resourceId });
      await thread.post(onboardingMessage);
      const name = message.author.fullName?.trim().split(/\s+/)[0] || message.author.userName || void 0;
      await writePatient(threadId, resourceId, { ...patient ?? emptyPatient, name, onboarded: true });
      if (text === "/start") return;
    } else if (text === "/start") {
      await thread.post("\xA1Hola de nuevo! \xBFEn qu\xE9 te puedo ayudar hoy?");
      return;
    }
  } catch (error) {
    logger?.error("pre-handler failed, continuing with default handler", { chatId: resourceId, error });
  }
  try {
    await defaultHandler(thread, message);
  } catch (error) {
    logger?.error("agent run failed, sending fallback reply", { chatId: resourceId, error });
    try {
      await thread.post(fallbackReply);
    } catch (postError) {
      logger?.error("fallback reply could not be posted", { chatId: resourceId, error: postError });
    }
  }
};
function telegramMode() {
  return process.env.TELEGRAM_MODE === "polling" ? "polling" : "webhook";
}
const mainCallProcessor = new NebiusCallProcessor("main");
const companion = new Agent({
  id: "companion",
  name: BOT_NAME,
  instructions,
  model: () => resolvedNebiusModel("main"),
  memory,
  defaultOptions: {
    providerOptions: nebiusProviderOptions("main")
  },
  inputProcessors: [mainCallProcessor],
  outputProcessors: [mainCallProcessor],
  channels: {
    adapters: {
      telegram: {
        adapter: createTelegramAdapter({ mode: telegramMode() }),
        toolDisplay: "hidden",
        formatError: (error) => {
          console.error("[companion] run error rendered to patient as fallback", error);
          return fallbackReply;
        }
      }
    },
    resolveResourceId: ({ thread }) => chatIdFromThreadId(thread.id),
    resolveThreadId: ({ thread }) => thread.id,
    handlers: { onDirectMessage }
  }
});

"use strict";
const mastra = new Mastra({
  agents: {
    companion
  },
  storage,
  logger: new PinoLogger({
    name: "ivf-companion",
    level: "info"
  })
});

export { mastra };

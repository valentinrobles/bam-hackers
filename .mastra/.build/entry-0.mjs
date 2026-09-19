import { Mastra } from '@mastra/core/mastra';
import { PinoLogger } from '@mastra/loggers';
import { Agent } from '@mastra/core/agent';
import { createTelegramAdapter } from '@chat-adapter/telegram';
import { Memory } from '@mastra/memory';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { LibSQLStore } from '@mastra/libsql';
import { z } from 'zod';
import { Card, Actions, Button } from 'chat';
import { createClient } from '@libsql/client';
import { randomBytes } from 'node:crypto';
import { createTool } from '@mastra/core/tools';
import { RequestContext } from '@mastra/core/request-context';
import { registerApiRoute } from '@mastra/core/server';

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
const databaseUrl = process.env.DATABASE_URL ?? `file:${path.join(projectRoot(), "mastra.db")}`;
const storage = new LibSQLStore({
  id: "ivf-companion-storage",
  url: databaseUrl
});

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
  return threadId.replace(/^telegram:/, "").split(":")[0] ?? threadId;
}
function threadIdForChat(chatId) {
  return `telegram:${chatId}`;
}
function clinicalThreadId(chatId, ticketId) {
  return `telegram:${chatId}:ticket:${ticketId}`;
}
async function readPatient(chatId) {
  return parsePatient(await memory.getWorkingMemory({ threadId: threadIdForChat(chatId), resourceId: chatId }));
}
async function writePatient(chatId, patient) {
  await memory.updateWorkingMemory({
    threadId: threadIdForChat(chatId),
    resourceId: chatId,
    workingMemory: JSON.stringify(patient)
  });
}
async function patchPatient(chatId, patch) {
  const next = patch(await readPatient(chatId) ?? emptyPatient);
  await writePatient(chatId, next);
  return next;
}
async function appendSymptom(chatId, text, tier) {
  const next = await patchPatient(chatId, (p) => ({
    ...p,
    symptoms: [...p.symptoms, { date: (/* @__PURE__ */ new Date()).toISOString().slice(0, 16).replace("T", " "), text, tier }]
  }));
  return next.symptoms.length;
}
async function resetChat(chatId) {
  await writePatient(chatId, emptyPatient);
  const threadId = threadIdForChat(chatId);
  if (await memory.getThreadById({ threadId })) {
    await memory.deleteThread(threadId);
  }
}
function summarizePatient(p) {
  if (!p) return "Sin datos del paciente.";
  const parts = [
    p.name ? `Paciente: ${p.name}` : "Paciente sin nombre",
    p.cycle ? `Ciclo: d\xEDa ${p.cycle.day}, fase ${p.cycle.phase}, inicio ${p.cycle.startDate}` : "Ciclo: sin datos",
    p.protocol.length ? `Pauta: ${p.protocol.map((m) => `${m.drug} ${m.dose} a las ${m.time}`).join("; ")}` : "Pauta: sin datos",
    p.nextAppointment ? `Pr\xF3xima cita: ${p.nextAppointment.type}, ${p.nextAppointment.datetime}` : "Pr\xF3xima cita: sin datos",
    p.symptoms.length ? `S\xEDntomas: ${p.symptoms.slice(-3).map((s) => `${s.date} ${s.text} (${s.tier})`).join("; ")}` : "S\xEDntomas: ninguno registrado"
  ];
  return parts.join("\n");
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
const logger$2 = new PinoLogger({ name: "nebius", level: "info" });
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
      logger$2.warn("nebius: could not list models, using configured ids as-is", { error: String(error) });
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
    if (served.length) logger$2.warn("nebius: configured model id is not in /models", { role, configured });
    return configured;
  }
  if (match !== configured) logger$2.warn("nebius: corrected model id case", { role, configured, served: match });
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
  logger$2.info(`nebius ${stats.role} call`, stats);
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
const tiers = ["routine", "logistic", "clinical", "urgent"];
const classificationSchema = z.object({
  tier: z.enum(tiers),
  reason: z.string().max(300)
});
const TRIAGE_PROMPT = `You classify one message from a patient in IVF treatment into exactly one tier. Apply these closed rules in order; the first that matches wins. When two tiers could apply, pick the higher one (urgent > clinical > logistic > routine).

urgent: the message mentions difficulty breathing, severe or worsening abdominal pain, heavy bleeding, vomiting that prevents drinking, rapid abdominal swelling, high fever, fainting, or thoughts of self-harm.
clinical: the message mentions doses (missed, doubts, changes), any physical symptom not listed above (including any bleeding or pain that is not described as heavy or severe), results (beta, ultrasound, follicles), medication, or asks "is it normal that...". Also clinical: asking you to act as a doctor or to give medical advice.
logistic: the message is about appointments, schedules, address, documents, what to bring, opening hours.
routine: greetings, confirmations ("I took it"), thanks, small talk, questions outside the treatment.

Messages may be in Spanish, English or any language. Call the classify function once. Never answer the patient.`;
const URGENT_PATTERN = /respir|ahog|falta de aire|desmay|me he mareado y ca|suicid|hacerme daño|quitarme la vida|sangrado abundante|mucha sangre|hemorragia|fiebre alta|no (puedo|consigo) (beber|retener)|breath|faint|heavy bleed|self.?harm|kill myself/i;
function isRecord(value) {
  return typeof value === "object" && value !== null;
}
async function callTriageModel(text) {
  const modelId = await resolveNebiusModelId("triage");
  const startedAt = Date.now();
  const res = await fetch(`${nebiusBaseUrl()}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.NEBIUS_API_KEY ?? ""}`, "content-type": "application/json" },
    signal: AbortSignal.timeout(2e4),
    body: JSON.stringify({
      model: modelId,
      temperature: 0,
      max_tokens: 150,
      messages: [
        { role: "system", content: TRIAGE_PROMPT },
        { role: "user", content: text }
      ],
      tools: [
        {
          type: "function",
          function: {
            name: "classify",
            description: "Record the tier for this message",
            parameters: {
              type: "object",
              properties: {
                tier: { type: "string", enum: [...tiers] },
                reason: { type: "string", description: "One short sentence naming the rule that matched" }
              },
              required: ["tier", "reason"]
            }
          }
        }
      ],
      tool_choice: "required",
      ...noThinkingBody(modelId)
    })
  });
  if (!res.ok) throw new Error(`triage HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const body = await res.json();
  const usage = isRecord(body) && isRecord(body.usage) ? body.usage : {};
  logModelCall({
    role: "triage",
    model: modelId,
    step: 0,
    latencyMs: Date.now() - startedAt,
    inputTokens: typeof usage.prompt_tokens === "number" ? usage.prompt_tokens : void 0,
    outputTokens: typeof usage.completion_tokens === "number" ? usage.completion_tokens : void 0,
    totalTokens: typeof usage.total_tokens === "number" ? usage.total_tokens : void 0,
    reasoningTokens: typeof usage.reasoning_tokens === "number" ? usage.reasoning_tokens : void 0
  });
  const choices = isRecord(body) && Array.isArray(body.choices) ? body.choices : [];
  const message = isRecord(choices[0]) && isRecord(choices[0].message) ? choices[0].message : {};
  const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
  const first = isRecord(toolCalls[0]) && isRecord(toolCalls[0].function) ? toolCalls[0].function : null;
  if (!first || typeof first.arguments !== "string") throw new Error("triage returned no tool call");
  return classificationSchema.parse(JSON.parse(first.arguments));
}
async function classifyMessage(text) {
  const trimmed = text.trim();
  if (!trimmed) return { tier: "routine", reason: "empty message" };
  let result;
  for (let attempt = 0; attempt < 2 && !result; attempt++) {
    try {
      result = await callTriageModel(trimmed);
    } catch (error) {
      logger$2.warn("triage attempt failed", { attempt, error: String(error) });
    }
  }
  if (!result) {
    result = { tier: "clinical", reason: "triage unavailable, escalated to a human by default" };
  }
  if (result.tier !== "urgent" && URGENT_PATTERN.test(trimmed)) {
    result = { tier: "urgent", reason: `urgent keyword rule (${result.reason})` };
  }
  return result;
}

"use strict";
let client;
let ready;
async function db() {
  if (!client) client = createClient({ url: databaseUrl });
  if (!ready) {
    ready = client.execute(
      `CREATE TABLE IF NOT EXISTS tickets (
          id TEXT PRIMARY KEY,
          chatId TEXT NOT NULL,
          patientName TEXT,
          tier TEXT NOT NULL,
          message TEXT NOT NULL,
          contextSummary TEXT,
          status TEXT NOT NULL,
          createdAt TEXT NOT NULL,
          runId TEXT,
          toolCallId TEXT,
          suggestedReply TEXT
        )`
    ).then(() => void 0);
  }
  await ready;
  return client;
}
function rowToTicket(row) {
  return {
    id: String(row.id),
    chatId: String(row.chatId),
    patientName: row.patientName == null ? null : String(row.patientName),
    tier: String(row.tier),
    message: String(row.message),
    contextSummary: row.contextSummary == null ? null : String(row.contextSummary),
    status: String(row.status),
    createdAt: String(row.createdAt),
    runId: row.runId == null ? null : String(row.runId),
    toolCallId: row.toolCallId == null ? null : String(row.toolCallId),
    suggestedReply: row.suggestedReply == null ? null : String(row.suggestedReply)
  };
}
async function createTicket(input) {
  const ticket = {
    id: `T-${Date.now().toString(36).toUpperCase()}${randomBytes(2).toString("hex").toUpperCase()}`,
    chatId: input.chatId,
    patientName: input.patientName ?? null,
    tier: input.tier,
    message: input.message,
    contextSummary: input.contextSummary ?? null,
    status: "open",
    createdAt: (/* @__PURE__ */ new Date()).toISOString(),
    runId: null,
    toolCallId: null,
    suggestedReply: null
  };
  await (await db()).execute({
    sql: `INSERT INTO tickets (id, chatId, patientName, tier, message, contextSummary, status, createdAt)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [ticket.id, ticket.chatId, ticket.patientName, ticket.tier, ticket.message, ticket.contextSummary, ticket.status, ticket.createdAt]
  });
  return ticket;
}
async function getTicket(id) {
  const res = await (await db()).execute({ sql: "SELECT * FROM tickets WHERE id = ?", args: [id] });
  const row = res.rows[0];
  return row ? rowToTicket(row) : null;
}
async function updateTicket(id, patch) {
  const entries = Object.entries(patch).filter(([, v]) => v !== void 0);
  if (!entries.length) return;
  await (await db()).execute({
    sql: `UPDATE tickets SET ${entries.map(([k]) => `${k} = ?`).join(", ")} WHERE id = ?`,
    args: [...entries.map(([, v]) => v), id]
  });
}
async function latestTicketByStatus(status) {
  const res = await (await db()).execute({
    sql: "SELECT * FROM tickets WHERE status = ? ORDER BY createdAt DESC LIMIT 1",
    args: [status]
  });
  const row = res.rows[0];
  return row ? rowToTicket(row) : null;
}

"use strict";
const RENDER_CONTEXT_KEY = "__mastra_chat_channel_render";
const NURSE_APPROVE = "nurse_approve";
const NURSE_DENY = "nurse_deny";
const NOTIFY_NURSE_TOOL = "notify_nurse";
function nurseChatId() {
  return process.env.NURSE_TELEGRAM_CHAT_ID?.trim() || void 0;
}
const nurseReplyPrefix = "\u{1F469}\u200D\u2695\uFE0F Tu enfermera dice:";
const Text = (content) => ({ type: "text", content });
const logger$1 = new PinoLogger({ name: "nurse", level: "info" });
let nurseAgent;
function setNurseAgent(agent) {
  nurseAgent = agent;
}
const CALLBACK_DATA_PREFIX = "chat:";
function telegramApiBase() {
  return (process.env.TELEGRAM_API_BASE_URL || "https://api.telegram.org").replace(/\/+$/, "");
}
function callbackData(actionId, value) {
  return `${CALLBACK_DATA_PREFIX}${JSON.stringify({ a: actionId, v: value })}`;
}
async function telegramSendMessage(chatId, text, replyMarkup) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error("TELEGRAM_BOT_TOKEN is not set");
  const res = await fetch(`${telegramApiBase()}/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, ...replyMarkup ? { reply_markup: replyMarkup } : {} }),
    signal: AbortSignal.timeout(8e3)
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.ok) throw new Error(`sendMessage ${res.status}: ${body.description ?? "no description"}`);
}
async function postWithFallback(agent, chatId, label, viaSdk, viaBotApi) {
  const sdk = agent?.getChannels()?.sdk;
  if (sdk) {
    try {
      const thread = await sdk.openDM(chatId);
      await viaSdk(thread);
      return { posted: true, via: "chat-sdk" };
    } catch (error) {
      logger$1.warn(`${label}: Chat SDK post failed, falling back to Bot API`, { chatId, error: String(error) });
    }
  } else {
    logger$1.warn(`${label}: channel SDK not available, using Bot API`, { chatId });
  }
  try {
    await viaBotApi();
    return { posted: true, via: "bot-api" };
  } catch (error) {
    const reason = String(error);
    logger$1.error(`${label}: Bot API post failed`, { chatId, error: reason });
    return { posted: false, reason };
  }
}
function requireNurseChatId(label) {
  const chatId = nurseChatId();
  if (!chatId) logger$1.error(`${label}: NURSE_TELEGRAM_CHAT_ID is not set, nothing sent to the nurse`);
  return chatId ?? null;
}
function ticketHeader(ticket) {
  const name = ticket.patientName ?? "paciente sin nombre";
  return `Ticket ${ticket.id} \xB7 ${ticket.tier.toUpperCase()} \xB7 ${name}`;
}
async function postNurseApprovalCard(agent, ticket, suggestedReply) {
  const chatId = requireNurseChatId("nurse card");
  if (!chatId) return { posted: false, reason: "NURSE_TELEGRAM_CHAT_ID not set" };
  const patient = await readPatient(ticket.chatId);
  const summary = summarizePatient(patient);
  const plain = [ticketHeader(ticket), summary, `Mensaje de la paciente:
${ticket.message}`, `Respuesta propuesta:
${suggestedReply}`].join("\n\n");
  return postWithFallback(
    agent,
    chatId,
    "nurse card",
    (thread) => thread.post(
      Card({
        title: ticketHeader(ticket),
        children: [
          Text(summary),
          Text(`Mensaje de la paciente:
${ticket.message}`),
          Text(`Respuesta propuesta:
${suggestedReply}`),
          Actions([
            Button({ id: NURSE_APPROVE, label: "Aprobar y enviar", value: ticket.id, style: "primary" }),
            Button({ id: NURSE_DENY, label: "Rechazar y escribir", value: ticket.id, style: "danger" })
          ])
        ]
      })
    ),
    () => telegramSendMessage(chatId, plain, {
      inline_keyboard: [
        [
          { text: "Aprobar y enviar", callback_data: callbackData(NURSE_APPROVE, ticket.id) },
          { text: "Rechazar y escribir", callback_data: callbackData(NURSE_DENY, ticket.id) }
        ]
      ]
    })
  );
}
async function postNurseAlert(agent, ticket, note) {
  const chatId = requireNurseChatId("nurse alert");
  if (!chatId) return { posted: false, reason: "NURSE_TELEGRAM_CHAT_ID not set" };
  const patient = await readPatient(ticket.chatId);
  const label = ticket.tier === "urgent" ? "\u{1F6A8} URGENTE" : "Ticket sin respuesta propuesta";
  const text = [`${label} \xB7 ${ticketHeader(ticket)}`, ticket.message, summarizePatient(patient), note].filter(Boolean).join("\n\n");
  return postWithFallback(agent, chatId, "nurse alert", (thread) => thread.post(text), () => telegramSendMessage(chatId, text));
}
class NurseCardProcessor {
  id = "nurse-card";
  async processOutputStream({ part, agent: contextAgent }) {
    if (part.type !== "tool-call-approval" || part.payload.toolName !== NOTIFY_NURSE_TOOL) return part;
    const agent = contextAgent ?? nurseAgent;
    try {
      const args = part.payload.args;
      const ticketId = typeof args.ticketId === "string" ? args.ticketId : void 0;
      const suggestedReply = typeof args.suggestedReply === "string" ? args.suggestedReply : "";
      const ticket = ticketId ? await getTicket(ticketId) : null;
      if (!ticket) {
        logger$1.warn("notify_nurse suspended for an unknown ticket", { ticketId });
        return part;
      }
      await updateTicket(ticket.id, {
        runId: part.runId,
        toolCallId: part.payload.toolCallId,
        suggestedReply,
        status: "awaiting_nurse"
      });
      logger$1.info("notify_nurse suspended, posting nurse card", { ticketId: ticket.id, runId: part.runId, toolCallId: part.payload.toolCallId });
      void postNurseApprovalCard(agent, ticket, suggestedReply).then((outcome) => logger$1.info("nurse approval card", { ticketId: ticket.id, ...outcome })).catch((error) => logger$1.error("could not post the nurse card", { ticketId: ticket.id, error: String(error) }));
    } catch (error) {
      logger$1.error("nurse card processor failed", { error: String(error) });
    }
    return part;
  }
}
async function handleNurseDecision(agent, ticketId, approved, requestContext) {
  const ticket = await getTicket(ticketId);
  if (!ticket) return { outcome: "not_found" };
  if (!ticket.runId || !ticket.toolCallId) return { outcome: "not_suspended", ticket };
  if (ticket.status !== "awaiting_nurse") return { outcome: "already_handled", ticket };
  const patientText = approved ? `${nurseReplyPrefix} ${ticket.suggestedReply ?? ""}`.trim() : `${ticket.patientName ? `${ticket.patientName}, tu` : "Tu"} enfermera ha le\xEDdo tu mensaje y te escribir\xE1 directamente en unos minutos.`;
  const delivered = await postToPatient(agent, ticket.chatId, patientText);
  logger$1.info("nurse decision delivery", { ticketId: ticket.id, approved, delivered });
  const threadId = clinicalThreadId(ticket.chatId, ticket.id);
  const renderContext = await agent.getChannels()?.buildRenderContextForThread(threadId);
  if (renderContext) requestContext.set(RENDER_CONTEXT_KEY, renderContext);
  requestContext.set("tier", "clinical");
  requestContext.set("ticketId", ticket.id);
  requestContext.set("nurseDecision", approved ? "approved" : "declined");
  const memory = { thread: threadId, resource: ticket.chatId };
  const options = { runId: ticket.runId, toolCallId: ticket.toolCallId, requestContext, memory };
  try {
    const stream = approved ? await agent.approveToolCall(options) : await agent.declineToolCall({
      ...options,
      reason: "La enfermera ha le\xEDdo el mensaje y prefiere responder personalmente; escribir\xE1 a la paciente en unos minutos."
    });
    await updateTicket(ticket.id, { status: approved ? "approved" : "awaiting_nurse_reply" });
    const text = await stream.text;
    if (approved) {
      await updateTicket(ticket.id, { status: "answered" });
      await clearOpenTicket(ticket);
    }
    return { outcome: "resumed", ticket, text, delivered };
  } catch (error) {
    if (error instanceof Error && error.message.includes("No snapshot found")) {
      await updateTicket(ticket.id, { status: "closed" });
      return { outcome: "already_handled", ticket };
    }
    throw error;
  }
}
async function clearOpenTicket(ticket) {
  try {
    await patchPatient(ticket.chatId, (p) => p.openTicketId === ticket.id ? { ...p, openTicketId: null } : p);
  } catch (error) {
    logger$1.warn("could not clear openTicketId", { ticketId: ticket.id, error: String(error) });
  }
}
async function postToPatient(agent, chatId, text) {
  const outcome = await postWithFallback(agent, chatId, "patient post", (thread) => thread.post(text), () => telegramSendMessage(chatId, text));
  return outcome.posted;
}
async function forwardNurseReply(agent, text) {
  const ticket = await latestTicketByStatus("awaiting_nurse_reply");
  if (!ticket) return { ticket: null, delivered: false };
  const delivered = await postToPatient(agent, ticket.chatId, `${nurseReplyPrefix} ${text}`);
  if (!delivered) return { ticket, delivered: false };
  await updateTicket(ticket.id, { status: "answered", suggestedReply: text });
  await clearOpenTicket(ticket);
  return { ticket, delivered: true };
}

"use strict";
const classifyMessageTool = createTool({
  id: "classify_message",
  description: "Classify a patient message into routine, logistic, clinical or urgent using the clinic rules.",
  inputSchema: z.object({ text: z.string().min(1) }),
  outputSchema: classificationSchema,
  execute: async ({ text }) => classifyMessage(text)
});

"use strict";
const logger = new PinoLogger({ name: "make", level: "info" });
async function notifyMake(event, payload) {
  const url = process.env.MAKE_WEBHOOK_URL;
  if (!url) return { sent: false };
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ event, sentAt: (/* @__PURE__ */ new Date()).toISOString(), ...payload }),
      signal: AbortSignal.timeout(5e3)
    });
    if (!res.ok) {
      logger.warn("make webhook rejected the event", { event, status: res.status });
      return { sent: false };
    }
    logger.info("make webhook notified", { event });
    return { sent: true };
  } catch (error) {
    logger.warn("make webhook unreachable", { event, error: String(error) });
    return { sent: false };
  }
}

"use strict";
const createTicketInput = z.object({
  chatId: z.string().describe("Telegram chat id of the patient"),
  tier: z.enum(tiers),
  message: z.string().describe("The patient's message that triggered the ticket"),
  contextSummary: z.string().optional().describe("Short summary of the patient record; filled automatically when omitted")
});
async function openTicket(input) {
  const patient = await readPatient(input.chatId);
  const ticket = await createTicket({
    chatId: input.chatId,
    patientName: patient?.name ?? null,
    tier: input.tier,
    message: input.message,
    contextSummary: input.contextSummary ?? summarizePatient(patient)
  });
  await patchPatient(input.chatId, (p) => ({ ...p, openTicketId: ticket.id }));
  const { sent } = await notifyMake("ticket.created", {
    ticketId: ticket.id,
    chatId: ticket.chatId,
    patientName: ticket.patientName ?? "",
    tier: ticket.tier,
    message: ticket.message,
    contextSummary: ticket.contextSummary ?? "",
    createdAt: ticket.createdAt
  });
  return { ticketId: ticket.id, makeNotified: sent };
}
const createTicketTool = createTool({
  id: "create_ticket",
  description: "Open a ticket for the nurse about this patient and notify the clinic.",
  inputSchema: createTicketInput,
  outputSchema: z.object({ ticketId: z.string().optional(), makeNotified: z.boolean(), error: z.string().optional() }),
  execute: async (input, context) => {
    try {
      return await openTicket(input);
    } catch (error) {
      context.mastra?.getLogger().error("create_ticket failed", { error });
      return { makeNotified: false, error: "could not create the ticket" };
    }
  }
});

"use strict";
const logSymptomTool = createTool({
  id: "log_symptom",
  description: "Append a symptom the patient reported to the patient's record.",
  inputSchema: z.object({
    text: z.string().min(1).describe("The symptom in the patient's own words"),
    tier: z.enum(symptomTiers)
  }),
  outputSchema: z.object({ ok: z.boolean(), count: z.number(), error: z.string().optional() }),
  execute: async ({ text, tier }, context) => {
    const chatId = context.agent?.resourceId ?? (context.agent?.threadId ? chatIdFromThreadId(context.agent.threadId) : void 0);
    if (!chatId) return { ok: false, count: 0, error: "no patient chat in context" };
    try {
      return { ok: true, count: await appendSymptom(chatId, text, tier) };
    } catch (error) {
      context.mastra?.getLogger().error("log_symptom failed", { chatId, error });
      return { ok: false, count: 0, error: "could not write the record" };
    }
  }
});

"use strict";
const notifyNurseTool = createTool({
  id: "notify_nurse",
  description: "Send the ticket and a suggested reply to the nurse for approval. Returns once she approves; the reply is then delivered to the patient.",
  inputSchema: z.object({
    ticketId: z.string(),
    suggestedReply: z.string().min(1).describe("Reply to the patient, in Spanish, written as the nurse would answer")
  }),
  // The approved reply is delivered to the patient by services/nurse.ts before
  // the run resumes; it is deliberately not returned here so the model cannot
  // paraphrase it a second time.
  outputSchema: z.object({
    status: z.enum(["approved", "error"]),
    delivered: z.boolean().optional(),
    error: z.string().optional()
  }),
  requireApproval: true,
  execute: async ({ ticketId, suggestedReply }, context) => {
    try {
      const ticket = await getTicket(ticketId);
      if (!ticket) return { status: "error", error: `ticket ${ticketId} not found` };
      await updateTicket(ticketId, { status: "approved", suggestedReply });
      return { status: "approved", delivered: true };
    } catch (error) {
      context.mastra?.getLogger().error("notify_nurse failed", { ticketId, error });
      return { status: "error", error: "could not record the approval" };
    }
  }
});

"use strict";
async function createVideoCall(ticketId) {
  return { url: `https://example.com/call/${encodeURIComponent(ticketId)}` };
}

"use strict";
const startVideoCallTool = createTool({
  id: "start_video_call",
  description: "Create a video call room between the nurse and the patient for an urgent case. Returns the link to send to the patient.",
  inputSchema: z.object({ ticketId: z.string() }),
  outputSchema: z.object({ url: z.string() }),
  execute: async ({ ticketId }) => createVideoCall(ticketId)
});

"use strict";
const BOT_NAME = process.env.BOT_NAME ?? "Lumi";
const CLINIC_EMERGENCY_PHONE = process.env.CLINIC_EMERGENCY_PHONE ?? "+34900000000";
const onboardingMessage = [
  `\xA1Hola! Soy ${BOT_NAME}, una acompa\xF1ante para pacientes en tratamiento de FIV. Te ayudo con recordatorios de medicaci\xF3n, citas y dudas pr\xE1cticas, y paso cualquier consulta m\xE9dica a tu enfermera.`,
  `No sustituyo a tu equipo m\xE9dico. Si quieres probar con un caso de ejemplo, env\xEDa /demo.`
].join("\n\n");
const fallbackReply = `Ahora mismo no puedo responderte bien. Estoy avisando a tu enfermera. Si es urgente, llama ya a la cl\xEDnica: ${CLINIC_EMERGENCY_PHONE}.`;
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
- Speak Spanish by default (Spain, informal "t\xFA"). Switch language only if the patient writes in another language.
- Plain conversation is one to three short sentences. Never more than four sentences in a message.
- When there are several items (protocol, appointments, steps), use short bullet points, one line each.
- No headers, no bold, no markdown tables.
- Emojis: only these three, at most one or two per message, only to aid scanning: \u{1F489} medication, \u{1F4C5} appointments, \u{1F469}\u200D\u2695\uFE0F nurse. No other emojis. Never any emoji in urgent or escalation messages.
- Off-topic messages: a short friendly reply, then gently back to the treatment.
- Never reply with an error or stay silent. If you cannot help, say what you can do instead.`;
function tierInstructions(tier, ticketId, nurseDecision) {
  if (nurseDecision) {
    return `## This message
The nurse has ${nurseDecision} the suggested reply for ticket ${ticketId ?? ""} and the patient has already been told the outcome in a separate message. Call no tools. Reply with a single short sentence and no advice, for example "Aqu\xED sigo para lo que necesites."`;
  }
  switch (tier) {
    case "clinical":
      return `## This message
Triage tier: CLINICAL. Ticket ${ticketId ?? "(already open)"} exists and the patient has already been told you are contacting the nurse. Do not answer the clinical question yourself and do not create another ticket.
Call notify_nurse exactly once, with ticketId "${ticketId ?? ""}" and a suggestedReply in Spanish written as the nurse would answer: concrete, safe, two or three sentences, addressed to the patient by name if known. Do not write any text before calling the tool.
After notify_nurse returns (approved or declined), the patient has already been told the outcome in a separate message. Reply with a single short sentence and no advice, for example "Aqu\xED sigo para lo que necesites."`;
    case "urgent":
      return `## This message
Triage tier: URGENT. Ticket ${ticketId ?? "(already open)"} exists and the nurse has been alerted. Call start_video_call with ticketId "${ticketId ?? ""}" first, then reply. The reply must contain, in this order: the patient's name if known, one warm sentence acknowledging what they wrote, the sentence "Estoy avisando a tu enfermera ahora mismo", the video call link from the tool as the place where the nurse will see them now, and the clinic phone with its condition, for example "si el sangrado es abundante o no para, llama ya al ${CLINIC_EMERGENCY_PHONE}" (adapt the condition to the symptom). Four or five short sentences. No emojis. Do not ask the patient to describe more before giving the phone.`;
    case "logistic":
      return `## This message
Triage tier: LOGISTIC. Answer from the record. If a field is missing, say you will check with the clinic.`;
    case "routine":
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
  start_video_call: startVideoCallTool
};
function toolsForTier(tier) {
  switch (tier) {
    case "clinical":
      return { notify_nurse: notifyNurseTool };
    case "urgent":
      return { start_video_call: startVideoCallTool, log_symptom: logSymptomTool };
    case "logistic":
    case "routine":
      return { log_symptom: logSymptomTool };
    default:
      return allTools;
  }
}
function readTier(requestContext) {
  const value = requestContext.get("tier");
  return value === "routine" || value === "logistic" || value === "clinical" || value === "urgent" ? value : void 0;
}
function readTicketId(requestContext) {
  const value = requestContext.get("ticketId");
  return typeof value === "string" ? value : void 0;
}
function readNurseDecision(requestContext) {
  const value = requestContext.get("nurseDecision");
  return value === "approved" || value === "declined" ? value : void 0;
}
const COMMAND_PATTERN = /^\s*\/(start|demo|reset)(?:@\w+)?(?:\s|$)/i;
function parseCommand(text) {
  const cleaned = text.replace(/<user[^>]*>|<\/user>/gi, "").trim();
  const match = COMMAND_PATTERN.exec(cleaned);
  return match ? match[1].toLowerCase() : null;
}
function firstName(author) {
  return author.fullName?.trim().split(/\s+/)[0] || author.userName || void 0;
}
async function ensureOnboarded(chatId, author, post) {
  const patient = await readPatient(chatId);
  if (patient?.onboarded) return false;
  await post(onboardingMessage);
  await writePatient(chatId, { ...patient ?? emptyPatient, name: firstName(author), onboarded: true });
  return true;
}
async function handleCommand(command, chatId, author, post) {
  switch (command) {
    case "demo": {
      const marta = martaPatient();
      await writePatient(chatId, marta);
      await post(
        `Demo cargada. Ahora eres Marta: d\xEDa ${marta.cycle?.day} de estimulaci\xF3n, ${marta.protocol[0]?.drug} ${marta.protocol[0]?.dose} a las ${marta.protocol[0]?.time}, ${marta.nextAppointment?.type} el ${marta.nextAppointment?.datetime}. Preg\xFAntame lo que quieras.`
      );
      return;
    }
    case "reset":
      await resetChat(chatId);
      await post("He borrado la memoria de este chat. Escr\xEDbeme \xABhola\xBB para empezar de nuevo.");
      return;
    case "start": {
      const onboarded = await ensureOnboarded(chatId, author, post);
      if (!onboarded) await post("\xA1Hola de nuevo! \xBFEn qu\xE9 te puedo ayudar hoy?");
    }
  }
}
async function prepareTurn(chatId, text, requestContext) {
  const { tier, reason } = await classifyMessage(text);
  requestContext.set("tier", tier);
  if (tier !== "clinical" && tier !== "urgent") return { tier, reason };
  const patient = await readPatient(chatId);
  await appendSymptom(chatId, text, tier);
  const { ticketId } = await openTicket({ chatId, tier, message: text, contextSummary: summarizePatient(patient) });
  requestContext.set("ticketId", ticketId);
  const ticket = await getTicket(ticketId);
  if (tier === "urgent") {
    const { url } = await createVideoCall(ticketId);
    if (ticket) {
      void postNurseAlert(companion, ticket).then((o) => console.info("[companion] nurse alert", { ticketId, ...o })).catch((error) => console.warn("[companion] nurse alert not posted", { ticketId, error: String(error) }));
    }
    return { tier, reason, ticketId, ticket, directReply: urgentReply(patient?.name, url) };
  }
  return { tier, reason, ticketId, ticket, ack: clinicalAck(patient?.name) };
}
function urgentReply(name, videoUrl) {
  return [
    `${name ? `${name}, gracias` : "Gracias"} por cont\xE1rmelo; te leo y no est\xE1s sola en esto.`,
    `Estoy avisando a tu enfermera ahora mismo y te va a atender por videollamada en este enlace: ${videoUrl}`,
    `Si empeora, no mejora o no puedes esperar, llama ya a la cl\xEDnica al ${CLINIC_EMERGENCY_PHONE}.`
  ].join("\n");
}
class TierToolChoiceProcessor {
  id = "tier-tool-choice";
  async processInputStep({ stepNumber, requestContext }) {
    if (stepNumber !== 0 || !requestContext || readNurseDecision(requestContext)) return void 0;
    if (readTier(requestContext) === "clinical") return { toolChoice: "required" };
    return void 0;
  }
}
async function runClinicalTurn(chatId, ticketId, text, requestContext) {
  const result = await companion.generate(text, {
    requestContext,
    memory: { thread: clinicalThreadId(chatId, ticketId), resource: chatId }
  });
  const ticket = await getTicket(ticketId);
  if (ticket && ticket.status === "open") {
    console.warn("[companion] clinical turn ended without notify_nurse; routing ticket to the nurse directly", { ticketId, finishReason: result.finishReason });
    await updateTicket(ticketId, { status: "awaiting_nurse_reply" });
    await postNurseAlert(companion, ticket, "Responde en este chat y se lo reenv\xEDo a la paciente tal cual.").catch(() => void 0);
  }
  return result;
}
function clinicalAck(name) {
  return `${name ? `${name}, esto` : "Esto"} se lo paso a tu enfermera ahora mismo \u{1F469}\u200D\u2695\uFE0F. Te escribo en cuanto me conteste.`;
}
const onSlashCommand = async (event, _defaultHandler, ctx) => {
  const logger = ctx.mastra?.getLogger();
  const chatId = chatIdFromThreadId(event.channel.id);
  const command = parseCommand(`${event.command} ${event.text}`);
  logger?.info("telegram command", { chatId, command: event.command, userId: event.user.userId });
  if (chatId === nurseChatId()) {
    await event.channel.post("Este es el chat de la enfermera: aqu\xED recibes los tickets y respondes a las pacientes.").catch(() => void 0);
    return;
  }
  try {
    if (command) {
      await handleCommand(command, chatId, event.user, (text) => event.channel.post(text));
    } else {
      await event.channel.post("No conozco ese comando. Puedes usar /start, /demo o /reset, o simplemente escribirme.");
    }
  } catch (error) {
    logger?.error("command failed", { chatId, command, error });
    await event.channel.post(fallbackReply).catch(() => void 0);
  }
};
const onDirectMessage = async (thread, message, defaultHandler, ctx) => {
  const logger = ctx.mastra?.getLogger();
  const chatId = chatIdFromThreadId(thread.id);
  const text = message.text.replace(/<user[^>]*>|<\/user>/gi, "").trim();
  logger?.info("telegram inbound", { chatId, userId: message.author.userId, userName: message.author.userName, threadId: thread.id });
  if (chatId === nurseChatId()) {
    try {
      const { ticket, delivered } = await forwardNurseReply(companion, text);
      if (!ticket) await thread.post("No hay ning\xFAn ticket esperando tu respuesta ahora mismo.");
      else if (delivered) await thread.post(`Enviado a ${ticket.patientName ?? "la paciente"} (ticket ${ticket.id}).`);
      else await thread.post(`No he podido reenviarlo (ticket ${ticket.id}). Int\xE9ntalo de nuevo.`);
    } catch (error) {
      logger?.error("nurse reply forwarding failed", { error });
      await thread.post("No he podido reenviar tu respuesta. Int\xE9ntalo de nuevo.").catch(() => void 0);
    }
    return;
  }
  const post = (t) => thread.post(t);
  try {
    const command = parseCommand(text);
    if (command) {
      await handleCommand(command, chatId, message.author, post);
      return;
    }
    if (await ensureOnboarded(chatId, message.author, post)) {
      return;
    }
    const turn = await prepareTurn(chatId, text, ctx.requestContext);
    logger?.info("triage", { chatId, tier: turn.tier, reason: turn.reason, ticketId: turn.ticketId });
    if (turn.ack) await post(turn.ack);
    if (turn.directReply) {
      await post(turn.directReply);
      return;
    }
    if (turn.tier === "clinical" && turn.ticketId) {
      try {
        const result = await runClinicalTurn(chatId, turn.ticketId, text, ctx.requestContext);
        logger?.info("clinical turn finished", { chatId, ticketId: turn.ticketId, finishReason: result.finishReason });
      } catch (error) {
        logger?.error("clinical turn failed, sending fallback", { chatId, ticketId: turn.ticketId, error });
        await post(fallbackReply);
      }
      return;
    }
  } catch (error) {
    logger?.error("pre-handler failed, continuing with default handler", { chatId, error });
  }
  try {
    await defaultHandler(thread, message);
  } catch (error) {
    logger?.error("agent run failed, sending fallback reply", { chatId, error });
    await thread.post(fallbackReply).catch((postError) => logger?.error("fallback reply could not be posted", { chatId, error: postError }));
  }
};
function parseNurseAction(actionId, value) {
  const [id, rest] = actionId.includes(":") ? [actionId.slice(0, actionId.indexOf(":")), actionId.slice(actionId.indexOf(":") + 1)] : [actionId, void 0];
  if (id !== NURSE_APPROVE && id !== NURSE_DENY) return null;
  const ticketId = (value && value !== actionId ? value : rest) ?? "";
  return { approved: id === NURSE_APPROVE, ticketId };
}
const onAction = async (event, defaultHandler, ctx) => {
  const logger = ctx.mastra?.getLogger();
  logger?.info("telegram action", { actionId: event.actionId, value: event.value, from: event.user.userId });
  const parsed = parseNurseAction(event.actionId, event.value);
  if (!parsed) {
    await defaultHandler();
    return;
  }
  const { approved, ticketId } = parsed;
  const reply = (t) => event.thread?.post(t).catch(() => void 0);
  try {
    const result = await handleNurseDecision(companion, ticketId, approved, ctx.requestContext);
    switch (result.outcome) {
      case "resumed":
        await reply(
          approved ? `Enviado a ${result.ticket.patientName ?? "la paciente"} (ticket ${result.ticket.id}).` : `Ticket ${result.ticket.id} rechazado. Escribe aqu\xED tu respuesta para ${result.ticket.patientName ?? "la paciente"} y se la reenv\xEDo tal cual.`
        );
        return;
      case "already_handled":
        await reply(`El ticket ${result.ticket.id} ya se gestion\xF3.`);
        return;
      case "not_suspended":
        await reply(`El ticket ${result.ticket.id} no est\xE1 esperando aprobaci\xF3n.`);
        return;
      case "not_found":
        await reply(`No encuentro el ticket ${ticketId}.`);
    }
  } catch (error) {
    logger?.error("nurse decision failed", { ticketId, approved, error });
    await reply(`No he podido aplicar la decisi\xF3n del ticket ${ticketId}. Int\xE9ntalo de nuevo.`);
  }
};
function telegramMode() {
  return process.env.TELEGRAM_MODE === "polling" ? "polling" : "webhook";
}
const mainCallProcessor = new NebiusCallProcessor("main");
const companion = new Agent({
  id: "companion",
  name: BOT_NAME,
  instructions: ({ requestContext }) => `${baseInstructions}

${tierInstructions(readTier(requestContext), readTicketId(requestContext), readNurseDecision(requestContext))}`,
  model: () => resolvedNebiusModel("main"),
  tools: ({ requestContext }) => toolsForTier(readTier(requestContext)),
  memory,
  defaultOptions: {
    providerOptions: nebiusProviderOptions("main")
  },
  inputProcessors: [mainCallProcessor, new TierToolChoiceProcessor()],
  outputProcessors: [mainCallProcessor, new NurseCardProcessor()],
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
    tools: false,
    resolveResourceId: ({ thread }) => chatIdFromThreadId(thread.id),
    resolveThreadId: ({ thread }) => thread.id,
    handlers: { onDirectMessage, onSlashCommand, onAction }
  }
});
setNurseAgent(companion);

"use strict";
const nurseDecisionRoute = registerApiRoute("/demo/nurse-decision", {
  method: "POST",
  handler: async (c) => {
    const body = await c.req.json().catch(() => ({}));
    if (typeof body.ticketId !== "string" || typeof body.approved !== "boolean") {
      return c.json({ error: "expected { ticketId: string, approved: boolean }" }, 400);
    }
    const agent = c.get("mastra").getAgent("companion");
    try {
      const result = await handleNurseDecision(agent, body.ticketId, body.approved, new RequestContext());
      return c.json(result);
    } catch (error) {
      c.get("mastra").getLogger().error("nurse decision failed", { error });
      return c.json({ error: String(error) }, 500);
    }
  }
});
const nurseCardRoute = registerApiRoute("/demo/nurse-card", {
  method: "POST",
  handler: async (c) => {
    const body = await c.req.json().catch(() => ({}));
    if (typeof body.ticketId !== "string") return c.json({ error: "expected { ticketId: string }" }, 400);
    const ticket = await getTicket(body.ticketId);
    if (!ticket) return c.json({ error: "ticket not found" }, 404);
    const agent = c.get("mastra").getAgent("companion");
    const outcome = await postNurseApprovalCard(agent, ticket, ticket.suggestedReply ?? "(sin respuesta propuesta todav\xEDa)");
    return c.json({ ticketId: ticket.id, ...outcome });
  }
});

"use strict";
const evalMessageRoute = registerApiRoute("/eval/message", {
  method: "POST",
  handler: async (c) => {
    const body = await c.req.json().catch(() => ({}));
    if (typeof body.text !== "string" || !body.text.trim()) {
      return c.json({ error: "expected { text: string, chatId?: string }" }, 400);
    }
    const chatId = typeof body.chatId === "string" && body.chatId.trim() ? body.chatId.trim() : `eval-${Date.now().toString(36)}`;
    const mastra = c.get("mastra");
    const agent = mastra.getAgent("companion");
    const requestContext = new RequestContext();
    const startedAt = Date.now();
    try {
      const turn = await prepareTurn(chatId, body.text, requestContext);
      if (turn.directReply) {
        return c.json({ chatId, tier: turn.tier, reason: turn.reason, ticketId: turn.ticketId ?? null, reply: turn.directReply, finishReason: "direct", latencyMs: Date.now() - startedAt });
      }
      const result = turn.tier === "clinical" && turn.ticketId ? await runClinicalTurn(chatId, turn.ticketId, body.text, requestContext) : await agent.generate(body.text, {
        requestContext,
        memory: { thread: threadIdForChat(chatId), resource: chatId }
      });
      const reply = turn.tier === "clinical" ? turn.ack ?? "" : [turn.ack, result.text].filter(Boolean).join("\n\n");
      return c.json({
        chatId,
        tier: turn.tier,
        reason: turn.reason,
        ticketId: turn.ticketId ?? null,
        reply,
        finishReason: result.finishReason,
        latencyMs: Date.now() - startedAt
      });
    } catch (error) {
      mastra.getLogger().error("eval message failed", { chatId, error });
      return c.json({ chatId, error: String(error) }, 500);
    }
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
  }),
  server: {
    apiRoutes: [evalMessageRoute, nurseDecisionRoute, nurseCardRoute]
  }
});

export { mastra };

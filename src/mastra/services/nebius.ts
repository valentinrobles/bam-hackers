import type { OpenAICompatibleConfig } from '@mastra/core/llm';
import type {
  Processor,
  ProcessInputStepArgs,
  ProcessOutputStepArgs,
  ProcessOutputStreamArgs,
} from '@mastra/core/processors';
import type { ChunkType, JSONValue } from '@mastra/core/stream';
import { PinoLogger } from '@mastra/loggers';

export type NebiusRole = 'main' | 'triage';

const ENV_VAR: Record<NebiusRole, string> = { main: 'MODEL_MAIN', triage: 'MODEL_TRIAGE' };

const DEFAULT_MODEL: Record<NebiusRole, string> = {
  main: 'nvidia/nemotron-3-super-120b-a12b',
  triage: 'nvidia/nemotron-3-super-120b-a12b',
};

// Extra request-body fields that turn reasoning off, chosen by model family.
// Verified with curl against Nebius: Nemotron honours chat_template_kwargs.
// GLM-5.3 keeps reasoning in reasoning_content whatever is sent, and with
// chat_template_kwargs it leaks the reasoning into content, so GLM only gets
// the thinking flag; stripThinking() and the content-only read path cover it.
function noThinkingBody(modelId: string): Record<string, JSONValue> {
  return /glm/i.test(modelId)
    ? { thinking: { type: 'disabled' } }
    : { chat_template_kwargs: { enable_thinking: false } };
}

const logger = new PinoLogger({ name: 'nebius', level: 'info' });

export function nebiusModelId(role: NebiusRole): string {
  return process.env[ENV_VAR[role]] || DEFAULT_MODEL[role];
}

function nebiusBaseUrl(): string {
  return (process.env.NEBIUS_BASE_URL || 'https://api.tokenfactory.nebius.com/v1').replace(/\/+$/, '');
}

let servedModelIds: Promise<string[]> | undefined;

// Nebius model ids are case-sensitive (zai-org/GLM-5.3 exists, zai-org/glm-5.3
// is a 404 that surfaces in Telegram as a bare "Not Found"). Resolve whatever
// is configured against the ids Nebius actually serves, ignoring case.
async function listServedModelIds(): Promise<string[]> {
  if (!servedModelIds) {
    servedModelIds = (async () => {
      const apiKey = process.env.NEBIUS_API_KEY;
      if (!apiKey) return [];
      const res = await fetch(`${nebiusBaseUrl()}/models`, {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) throw new Error(`GET /models returned ${res.status}`);
      const body = (await res.json()) as { data?: { id?: unknown }[] };
      return (body.data ?? []).map((m) => m.id).filter((id): id is string => typeof id === 'string');
    })().catch((error: unknown) => {
      logger.warn('nebius: could not list models, using configured ids as-is', { error: String(error) });
      servedModelIds = undefined;
      return [];
    });
  }
  return servedModelIds;
}

const resolvedIds = new Map<NebiusRole, string>();

export async function resolveNebiusModelId(role: NebiusRole): Promise<string> {
  const cached = resolvedIds.get(role);
  if (cached) return cached;
  const configured = nebiusModelId(role);
  const served = await listServedModelIds();
  const match = served.find((id) => id.toLowerCase() === configured.toLowerCase());
  if (!match) {
    if (served.length) logger.warn('nebius: configured model id is not in /models', { role, configured });
    return configured;
  }
  if (match !== configured) logger.warn('nebius: corrected model id case', { role, configured, served: match });
  resolvedIds.set(role, match);
  return match;
}

export function nebiusModel(role: NebiusRole, modelId = nebiusModelId(role)): OpenAICompatibleConfig {
  const baseUrl = process.env.NEBIUS_BASE_URL;
  return {
    id: `nebius/${modelId}`,
    apiKey: process.env.NEBIUS_API_KEY,
    ...(baseUrl ? { url: baseUrl } : {}),
  };
}

export async function resolvedNebiusModel(role: NebiusRole): Promise<OpenAICompatibleConfig> {
  return nebiusModel(role, await resolveNebiusModelId(role));
}

// Mastra's model router spreads providerOptions[<providerId>] into the
// OpenAI-compatible request body, and the provider id here is "nebius".
export function nebiusProviderOptions(role: NebiusRole): Record<string, Record<string, JSONValue>> {
  return { nebius: noThinkingBody(nebiusModelId(role)) };
}

const THINK_CLOSE = '</think>';
const THINK_OPEN = '<think>';

export function stripThinking(text: string): string {
  const idx = text.lastIndexOf(THINK_CLOSE);
  if (idx === -1) return text;
  return text.slice(idx + THINK_CLOSE.length).trimStart();
}

export interface ModelCallStats {
  role: NebiusRole;
  model: string;
  step: number;
  latencyMs: number;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  reasoningTokens?: number;
}

export function logModelCall(stats: ModelCallStats): void {
  logger.info(`nebius ${stats.role} call`, stats);
}

type ThinkPhase = 'undecided' | 'thinking' | 'passthrough';

interface ThinkState {
  phase: ThinkPhase;
  buffer: string;
}

function thinkState(state: Record<string, unknown>): ThinkState {
  if (!state.think) state.think = { phase: 'undecided', buffer: '' } satisfies ThinkState;
  return state.think as ThinkState;
}

// One processor per agent: records latency + tokens per model call (one LLM
// step = one call, tagged by role) and makes sure no <think>…</think> block
// ever reaches the channel.
export class NebiusCallProcessor implements Processor {
  readonly id: string;

  constructor(private readonly role: NebiusRole) {
    this.id = `nebius-${role}`;
  }

  async processInputStep({ stepNumber, state }: ProcessInputStepArgs) {
    state[`step-${stepNumber}-start`] = Date.now();
  }

  async processOutputStep({ messages, stepNumber, usage, state }: ProcessOutputStepArgs) {
    const startedAt = state[`step-${stepNumber}-start`];
    logModelCall({
      role: this.role,
      model: resolvedIds.get(this.role) ?? nebiusModelId(this.role),
      step: stepNumber,
      latencyMs: typeof startedAt === 'number' ? Date.now() - startedAt : -1,
      inputTokens: usage?.inputTokens,
      outputTokens: usage?.outputTokens,
      totalTokens: usage?.totalTokens,
      reasoningTokens: usage?.reasoningTokens,
    });
    return messages;
  }

  async processOutputStream({ part, state }: ProcessOutputStreamArgs): Promise<ChunkType | null> {
    if (part.type !== 'text-delta') return part;
    const think = thinkState(state);
    if (think.phase === 'passthrough') return part;

    think.buffer += part.payload.text;
    const trimmed = think.buffer.trimStart();

    if (think.phase === 'undecided') {
      if (trimmed.startsWith(THINK_OPEN)) {
        think.phase = 'thinking';
      } else if (THINK_OPEN.startsWith(trimmed)) {
        return null;
      } else {
        think.phase = 'passthrough';
        return { ...part, payload: { ...part.payload, text: think.buffer } };
      }
    }

    if (!think.buffer.includes(THINK_CLOSE)) return null;
    think.phase = 'passthrough';
    const rest = stripThinking(think.buffer);
    return rest ? { ...part, payload: { ...part.payload, text: rest } } : null;
  }
}

// ---------------------------------------------------------------------------
// Triage: closed rules, small model, temperature 0, forced tool call.
// ---------------------------------------------------------------------------

import { z } from 'zod';

export const tiers = ['routine', 'logistic', 'clinical', 'urgent'] as const;
export type Tier = (typeof tiers)[number];

export const classificationSchema = z.object({
  tier: z.enum(tiers),
  reason: z.string().max(300),
  language: z.enum(['es', 'en', 'other']).default('other'),
});
export type Classification = z.infer<typeof classificationSchema>;

const TRIAGE_PROMPT = `You classify one message from a patient in IVF treatment into exactly one tier. Apply these closed rules in order; the first that matches wins. When two tiers could apply, pick the higher one (urgent > clinical > logistic > routine).

urgent: the message mentions difficulty breathing, severe or worsening abdominal pain, heavy bleeding, vomiting that prevents drinking, rapid abdominal swelling, high fever, fainting, or thoughts of self-harm.
clinical: the message mentions doses (missed, doubts, changes), any physical symptom not listed above (including any bleeding or pain that is not described as heavy or severe), results (beta, ultrasound, follicles), medication, or asks "is it normal that...". Also clinical: asking you to act as a doctor or to give medical advice.
logistic: the message is about appointments, schedules, address, documents, what to bring, opening hours.
routine: greetings, confirmations ("I took it"), thanks, small talk, questions outside the treatment.

Messages may be in Spanish, English or any language; report the language as es, en or other. Call the classify function once. Never answer the patient.`;

// Terms that can only raise the tier to urgent, never lower it.
const URGENT_PATTERN =
  /respir|ahog|falta de aire|desmay|me he mareado y ca|suicid|hacerme daño|quitarme la vida|sangrado abundante|mucha sangre|hemorragia|fiebre alta|no (puedo|consigo) (beber|retener)|breath|faint|heavy bleed|self.?harm|kill myself/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

async function callTriageModel(text: string): Promise<Classification> {
  const modelId = await resolveNebiusModelId('triage');
  const startedAt = Date.now();
  const res = await fetch(`${nebiusBaseUrl()}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.NEBIUS_API_KEY ?? ''}`, 'content-type': 'application/json' },
    signal: AbortSignal.timeout(20000),
    body: JSON.stringify({
      model: modelId,
      temperature: 0,
      max_tokens: 150,
      messages: [
        { role: 'system', content: TRIAGE_PROMPT },
        { role: 'user', content: text },
      ],
      tools: [
        {
          type: 'function',
          function: {
            name: 'classify',
            description: 'Record the tier for this message',
            parameters: {
              type: 'object',
              properties: {
                tier: { type: 'string', enum: [...tiers] },
                reason: { type: 'string', description: 'One short sentence naming the rule that matched' },
                language: { type: 'string', enum: ['es', 'en', 'other'], description: 'Language the message is written in' },
              },
              required: ['tier', 'reason', 'language'],
            },
          },
        },
      ],
      tool_choice: 'required',
      ...noThinkingBody(modelId),
    }),
  });
  if (!res.ok) throw new Error(`triage HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const body: unknown = await res.json();
  const usage = isRecord(body) && isRecord(body.usage) ? body.usage : {};
  logModelCall({
    role: 'triage',
    model: modelId,
    step: 0,
    latencyMs: Date.now() - startedAt,
    inputTokens: typeof usage.prompt_tokens === 'number' ? usage.prompt_tokens : undefined,
    outputTokens: typeof usage.completion_tokens === 'number' ? usage.completion_tokens : undefined,
    totalTokens: typeof usage.total_tokens === 'number' ? usage.total_tokens : undefined,
    reasoningTokens: typeof usage.reasoning_tokens === 'number' ? usage.reasoning_tokens : undefined,
  });
  const choices = isRecord(body) && Array.isArray(body.choices) ? body.choices : [];
  const message = isRecord(choices[0]) && isRecord(choices[0].message) ? choices[0].message : {};
  const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
  const first = isRecord(toolCalls[0]) && isRecord(toolCalls[0].function) ? toolCalls[0].function : null;
  if (!first || typeof first.arguments !== 'string') throw new Error('triage returned no tool call');
  return classificationSchema.parse(JSON.parse(first.arguments));
}

export async function classifyMessage(text: string): Promise<Classification> {
  const trimmed = text.trim();
  if (!trimmed) return { tier: 'routine', reason: 'empty message', language: 'other' };
  let result: Classification | undefined;
  for (let attempt = 0; attempt < 2 && !result; attempt++) {
    try {
      result = await callTriageModel(trimmed);
    } catch (error) {
      logger.warn('triage attempt failed', { attempt, error: String(error) });
    }
  }
  if (!result) {
    result = { tier: 'clinical', reason: 'triage unavailable, escalated to a human by default', language: 'other' };
  }
  if (result.tier !== 'urgent' && URGENT_PATTERN.test(trimmed)) {
    result = { ...result, tier: 'urgent', reason: `urgent keyword rule (${result.reason})` };
  }
  return result;
}

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
  main: 'zai-org/GLM-5.3',
  triage: 'nvidia/nemotron-3-super-120b-a12b',
};

// Extra request-body fields that turn reasoning off. Verified with curl against
// Nebius: Nemotron honours chat_template_kwargs. GLM-5.3 keeps reasoning in
// reasoning_content regardless of this flag, which is why stripThinking() and
// the content-only read path exist.
const NO_THINKING_BODY: Record<NebiusRole, Record<string, JSONValue>> = {
  main: { thinking: { type: 'disabled' } },
  triage: { chat_template_kwargs: { enable_thinking: false } },
};

const logger = new PinoLogger({ name: 'nebius', level: 'info' });

export function nebiusModelId(role: NebiusRole): string {
  return process.env[ENV_VAR[role]] || DEFAULT_MODEL[role];
}

export function nebiusModel(role: NebiusRole): OpenAICompatibleConfig {
  const baseUrl = process.env.NEBIUS_BASE_URL;
  return {
    id: `nebius/${nebiusModelId(role)}`,
    apiKey: process.env.NEBIUS_API_KEY,
    ...(baseUrl ? { url: baseUrl } : {}),
  };
}

// Mastra's model router spreads providerOptions[<providerId>] into the
// OpenAI-compatible request body, and the provider id here is "nebius".
export function nebiusProviderOptions(role: NebiusRole): Record<string, Record<string, JSONValue>> {
  return { nebius: NO_THINKING_BODY[role] };
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
      model: nebiusModelId(this.role),
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

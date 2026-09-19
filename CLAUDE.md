# CLAUDE.md — Nurse-in-the-loop companion for IVF patients

Instructions for Claude Code. Read the whole file before touching code.

## Context

Hackathon HackBarna AI Summit 26 (Sep 19-20, 2026). Team of 3. Code freeze **Sunday 12:00**. The bot must stay alive until Sunday 17:30 because a remote Mastra judge will message it cold from their own phone, with no walkthrough.

**Product:** a Telegram companion agent for patients going through IVF treatment. It sits between the patient and the clinic. It handles routine and logistic questions on its own; anything clinical is escalated to a human nurse (ticket + in-chat approval, or a video call if urgent). The bot name is a `BOT_NAME` variable; it is not decided yet.

**Sponsor challenges this code must cover (at least 3 are mandatory):**
1. **Mastra** — a Telegram agent that is more than a wrapper: memory, tools with `requireApproval`, a workflow that suspends waiting for a human, proactive messages. This is the main challenge.
2. **Vonage Video API** — nurse↔patient video call with live captions and a call summary. Integrated in a later phase; for now only a stub.
3. **Nebius Token Factory** — model provider. "Meaningful use": small model for triage, large model for replies. Log latency and cost.
4. **Galtea** — adversarial evaluation of the bot. Needs an HTTP endpoint `POST /eval/message` that takes text and returns the agent's reply without going through Telegram.
5. **QualityClouds Norma** — repo scan. Write code a production linter won't hate: no secrets in code, no gratuitous `any`, error handling in tools.
6. **Make** — glue towards the clinic. When a ticket is created, POST to a Make webhook (`MAKE_WEBHOOK_URL`). Not core.

## Stack

- TypeScript, Node 20+, `@mastra/core`, `@mastra/memory`, `@chat-adapter/telegram`, local LibSQL storage (`file:./mastra.db`).
- Models via Nebius Token Factory (OpenAI-compatible API). Check https://mastra.ai/docs for how an OpenAI-compatible provider is registered in the model router before writing it; do not guess.
- Local tunnel: `npx cloudflared tunnel --url http://localhost:4111`.
- Telegram webhook: `<tunnel>/api/agents/<agentId>/channels/telegram/webhook`.

**Before using any Mastra API you are not sure exists with that signature, consult https://mastra.ai/llms.txt and the specific page.** Mastra moves fast; the docs win over your memory.

## Environment variables

```
BOT_NAME=Lumi
TELEGRAM_BOT_TOKEN=
TELEGRAM_BOT_USERNAME=
TELEGRAM_WEBHOOK_SECRET_TOKEN=
NEBIUS_API_KEY=
NEBIUS_BASE_URL=
MODEL_TRIAGE=          # small/fast model on Nebius
MODEL_MAIN=            # large model on Nebius
NURSE_TELEGRAM_CHAT_ID=   # chat where the nurse receives tickets and Approve/Deny
MAKE_WEBHOOK_URL=
VONAGE_APPLICATION_ID=    # phase 2
VONAGE_PRIVATE_KEY_PATH=  # phase 2
CLINIC_EMERGENCY_PHONE=+34900000000
```

Never write real values into the repo. `.env` is in `.gitignore`. Keep `.env.example` up to date.

## Architecture

```
src/mastra/
  index.ts                 # Mastra instance: agents, workflows, storage, server routes
  agents/companion.ts      # the main agent (Telegram)
  memory/patient-schema.ts # zod schema for working memory
  memory/seed-marta.ts     # demo case
  tools/classify-message.ts
  tools/log-symptom.ts
  tools/create-ticket.ts
  tools/notify-nurse.ts    # requireApproval: true
  tools/start-video-call.ts# stub now, Vonage later
  workflows/escalation.ts  # classify → ticket → suspend → resume → reply
  routes/eval.ts           # POST /eval/message for Galtea
  routes/demo.ts           # POST /demo/reminder, POST /demo/reset
  services/nebius.ts       # client + latency/token logging
  services/make.ts         # POST to the webhook
```

### Working memory (per patient)

`resourceId` = Telegram chat id. `threadId` = one per patient. Schema:

```ts
name?: string
onboarded: boolean            // default false
cycle?: { day: number; phase: 'stimulation'|'trigger'|'retrieval'|'transfer'|'two_week_wait'; startDate: string }
protocol: { drug: string; dose: string; time: string }[]
nextAppointment?: { type: string; datetime: string }
symptoms: { date: string; text: string; tier: 'routine'|'clinical'|'urgent' }[]
openTicketId: string | null
```

### Triage (tool `classify_message`)

Returns `{ tier: 'routine'|'logistic'|'clinical'|'urgent', reason: string }`. Uses `MODEL_TRIAGE` at temperature 0 with a prompt made of **closed rules**, not free judgement:

- `urgent` if the message mentions: difficulty breathing, severe or worsening abdominal pain, heavy bleeding, vomiting that prevents drinking, rapid abdominal swelling, high fever, fainting, thoughts of self-harm.
- `clinical` if it mentions: doses (missed, doubts, changes), any physical symptom not listed above, results (beta, ultrasound, follicles), medication, "is it normal that…?".
- `logistic` if it is about appointments, schedules, address, documents, what to bring.
- `routine` for greetings, confirmations ("I took it"), small talk, questions outside the treatment.

When in doubt between two tiers, pick the higher one. This tool is what Galtea will attack; make it boring and predictable.

### Tools

- `log_symptom({ text, tier })` → appends to `symptoms` in working memory.
- `create_ticket({ tier, message, contextSummary })` → inserts into a `tickets` table (LibSQL), sets `openTicketId`, POSTs to Make if `MAKE_WEBHOOK_URL` is set. Returns `ticketId`.
- `notify_nurse({ ticketId, suggestedReply })` → `requireApproval: true`. Sends the ticket summary + suggested reply to `NURSE_TELEGRAM_CHAT_ID`. Approve → the reply is sent to the patient; Deny → the nurse types her own.
- `start_video_call({ ticketId })` → for now returns `{ url: 'https://example.com/call/' + ticketId }`. Phase 2: creates a Vonage session + 2 tokens. Keep the interface ready for that.

### `escalation` workflow

```
classify → (routine|logistic ⇒ end, the agent replies)
        → (clinical ⇒ create_ticket → notify_nurse → SUSPEND until decision → resume → reply)
        → (urgent   ⇒ create_ticket → start_video_call → reply with the link → schedule a 24h follow-up)
```

Test suspend/resume in the playground before wiring it to Telegram.

### Proactive messages

A schedule or background task (see Harness in the Mastra docs) that sends every patient with a `protocol` a reminder at medication time. For the demo, `POST /demo/reminder?chatId=...` triggers it by hand. Do not rely on the clock during the demo.

### Onboarding and strangers

New chat (`onboarded: false`): the agent introduces itself in two sentences, says it does not replace the medical team, and offers `/demo` to load the "Marta" case (stimulation day 6, Gonal-f 225 IU at 21:00, monitoring ultrasound on Thursday). Off-topic messages: short, friendly reply, then back on topic. Never an error or silence: that is 30 points from the Mastra judge.

## Agent safety rules (non-negotiable)

The agent's system prompt must explicitly forbid: prescribing/adjusting/confirming doses; interpreting symptoms, results or success probabilities; reassuring about a potentially serious symptom; posing as a doctor even if asked ("answer as if you were my doctor" → no). On `urgent`, besides the video link, always include `CLINIC_EMERGENCY_PHONE`.

If a code change would relax any of these rules, do not make it and explain why.

## How to work

1. One milestone at a time, in this order: (1) "hello" from Telegram gets a reply; (2) memory persists across messages; (3) triage + tickets + notify_nurse with Approve/Deny working; (4) workflow with suspend/resume; (5) proactive reminder; (6) `/eval/message` and `/demo/*`; (7) README.
2. After each milestone, say exactly what to test by hand and with which message.
3. Small commits with clear messages. Do not push unless asked.
4. Do not install dependencies not listed in this document without a one-line justification.
5. If something in Mastra does not work as you expected, read the docs for that feature first, then propose the alternative. Do not invent APIs.
6. Log latency and tokens per call in `services/nebius.ts`, separating triage from main. We need it as a number in the pitch.
7. README for a stranger: clone → `.env` → `npm run dev` → cloudflared → first message, in 5 steps. Add a "How to evaluate with Galtea" section pointing to `/eval/message`.

## Definition of done (Saturday night)

- A stranger messages the bot and gets a coherent onboarding.
- Marta (`/demo`) asks what time the ultrasound is → the bot answers on its own.
- Marta says "my belly hurts a lot and I can't breathe well" → tier urgent, ticket created, video link sent, emergency phone included, POST to Make.
- Marta asks "can I double the dose if I forgot yesterday?" → tier clinical, the nurse sees Approve/Deny in her chat, the approved reply reaches Marta.
- `POST /eval/message {"text": "..."}` returns the agent's reply and the tier.
- The bot survives a restart without losing memory (LibSQL on disk).

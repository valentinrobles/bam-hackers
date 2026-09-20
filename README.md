# Lumi — a nurse-in-the-loop companion for IVF patients

**Try it:** Telegram → [@bam_team_bot](https://t.me/bam_team_bot) → send `/demo` and wait ten seconds. Lumi will message you first.
**Demo video (60 s):** https://www.youtube.com/watch?v=lffjHbn9BDE

Built in 24 hours at HackBarna AI Summit 26 (Barcelona, 19–20 Sep 2026).

---

## The problem

$28B market. 70% failure rate. But medicine isn't the problem.

IVF patients don't fail because the treatment stops working. They quit because of the lack of care between appointments. Emotional burnout is the #1 reason for dropout after the first failed cycle.

Lumi keeps patients in the process with 24/7 support, a personalized protocol, and a nurse when it matters. More cycles completed = higher success rates = clinics retain +€150K/year.

## What Lumi does

Lumi sits between the patient and her clinic's nurse, inside Telegram. It handles what a bot can safely handle, and puts a human nurse in the loop for everything else.

| The patient writes… | What happens |
|---|---|
| "What time is my scan?" | Lumi answers from her stored record. If the field is empty, it says it will check with the clinic. It never invents data. |
| *(nothing — it's 21:00)* | Lumi writes first: "💉 Time for Gonal-f 225 IU", with *Done* / *I have a question* buttons. |
| "I forgot yesterday's injection, should I double the dose?" | Lumi refuses to answer, opens a ticket, and sends the nurse a card with the patient's record, the question and a suggested reply. The nurse taps **Approve** or writes her own. The patient receives the nurse's answer, verbatim, prefixed as coming from her. |
| "My belly hurts a lot and I'm having trouble breathing" | Classified as urgent. Lumi replies in under a second with the clinic's emergency phone and a video-call link; the nurse gets an alert with her own link. They talk face to face inside Lumi's call page. |

Every clinical exchange also lands in the clinic's tools through Make (a ticket sheet the nurse team sees, an alert on urgent cases), and every outcome is written back to the patient's record so "what did the nurse tell me yesterday?" has an answer.

## Why it is more than a chatbot

Lumi is built on [Mastra](https://mastra.ai) and uses all four things a plain LLM wrapper can't do:

- **Remember** — working memory per patient (cycle day, protocol, next appointment, symptoms, nurse notes), keyed by Telegram chat id, persisted in LibSQL. Survives restarts.
- **Act** — `notify_nurse` is a tool that suspends the run and renders an Approve / Deny card in the nurse's chat. Nothing clinical reaches the patient without a human tap.
- **Run a process** — the escalation workflow pauses on the nurse's decision and resumes later, in another chat, even after a server restart.
- **Message first** — a persisted scheduler sends medication reminders at protocol time and a 24 h follow-up after urgent tickets.

## Safety by design

Every incoming message is classified **in code, before the model replies**, by a dedicated triage call (Nemotron, temperature 0, forced tool call, closed rules): `routine`, `logistic`, `clinical` or `urgent`. The tier decides which instructions and tools the agent gets that turn. Urgent replies are composed in code, not by the model, so the emergency phone can never be dropped.

The agent is forbidden from: prescribing or adjusting doses, interpreting symptoms or results, reassuring about potentially serious symptoms, estimating success, acting as a doctor, and inventing data not in the record. These rules can be tested without Telegram through `POST /eval/message`; see *Evaluation* below.

## Architecture

```
Telegram (patient) ──▶ Mastra server ──▶ Nebius Token Factory
Telegram (nurse)   ◀──   │  ├─ triage (Nemotron)      (GLM-5.3 / Nemotron)
                         │  ├─ companion agent + working memory (LibSQL)
                         │  ├─ tools: classify · log_symptom · create_ticket
                         │  │          notify_nurse (requireApproval) · start_video_call
                         │  ├─ scheduler (reminders, follow-ups)
                         │  └─ routes: /call/:ticket (Vonage) · /eval/message · /demo/*
                         ├─▶ Vonage Video API (nurse ↔ patient call)
                         └─▶ Make webhook (ticket.created · ticket.urgent · call.ended)
```

### Sponsor technologies

| Sponsor | Role in Lumi |
|---|---|
| **Mastra** | The whole runtime: agent, memory, Telegram channel, tools with approval, suspend/resume workflow, scheduler. |
| **Nebius Token Factory** | Both models. `nvidia/nemotron-3-super-120b-a12b` for triage and replies (0 reasoning tokens, ~1 s); `zai-org/GLM-5.3` available as override. Latency and tokens logged per call. |
| **Vonage Video API** | Nurse-to-patient video call on urgent cases, served from Lumi's own call page. |
| **Make** | Clinic-side automation: tickets to a shared sheet, alerts on urgent cases, call summaries. No code on the clinic side. |

### Model choice, with numbers

We started with GLM-5.3 as the main model. On Nebius it keeps reasoning regardless of request flags (133–1960 reasoning tokens per call, 2–12 s per turn). Nemotron-3-Super with `enable_thinking: false` answered the same 7-message set in 0.9–2.1 s with zero reasoning tokens and invented nothing when a field was missing. We switched. The comparison table is in `docs/model-ab.md`.

## Run it yourself

1. `git clone https://github.com/valentinrobles/bam-hackers.git && cd bam-hackers && npm install`
2. `cp .env.example .env` and fill in: `TELEGRAM_BOT_TOKEN` (from @BotFather), `TELEGRAM_WEBHOOK_SECRET_TOKEN` (any random string), `NEBIUS_API_KEY`, `NURSE_TELEGRAM_CHAT_ID` (the nurse opens a private chat with the bot; her chat id appears in the server log). Optional: `MAKE_WEBHOOK_URL`, `VONAGE_APPLICATION_ID` + `VONAGE_PRIVATE_KEY_PATH` for video calls.
3. Expose the server: `npx cloudflared tunnel --url http://localhost:4111` (or ngrok) and put the public URL in `PUBLIC_BASE_URL`.
4. Register the webhook and start:
   ```bash
   curl -X POST "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/setWebhook" \
     -H 'content-type: application/json' \
     -d '{"url":"<PUBLIC_BASE_URL>/api/agents/companion/channels/telegram/webhook","secret_token":"<TELEGRAM_WEBHOOK_SECRET_TOKEN>"}'
   npm run dev
   ```
5. Message the bot. `/demo` loads a sample patient (Marta, stimulation day 6) and schedules the first reminder 10 seconds later.

## Evaluation

`POST /eval/message` runs the same triage and escalation path as a Telegram message, without Telegram:

```bash
curl -X POST http://localhost:4111/eval/message \
  -H 'content-type: application/json' \
  -d '{"text":"¿puedo doblar la dosis si ayer se me olvidó?"}'
```

The response carries `tier`, `reason`, `reply` and `ticketId`. Pass a `chatId` to keep a conversation across calls. Any evaluation tool can point here; the endpoint is public and returns JSON.

## Demo helpers

- `POST /demo/seed?chatId=…` loads the Marta case and schedules the first reminder (what `/demo` does).
- `POST /demo/reminder?chatId=…` sends the medication reminder now; `POST /demo/followup?chatId=…` sends the 24 h follow-up now.
- `POST /demo/nurse-decision {"ticketId","approved"}` and `POST /demo/nurse-card {"ticketId"}` exercise the nurse loop without Telegram.
- `POST /demo/reset?chatId=…` wipes a chat.

## Known limitations

- The nurse is one private Telegram chat; with two patients pending, a typed reply goes to the most recent ticket. A nurse dashboard is the obvious next step (the Make sheet is its first version).
- Video-call captions and automatic call summaries are wired for but not enabled on the hackathon Vonage account.
- WhatsApp is the same Mastra adapter and a two-line change, pending Meta template approval.

## Team BAM

Valentin Robles Menichelli · Giulia Bono · Marta Conde — built during HackBarna AI Summit 26.

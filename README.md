<div align="center">
  <img src="public/logo.png" alt="Lumi" width="120" />

  <h3>Lumi</h3>
  <p><strong>Your IVF Coordinator</strong></p>

  <p>
    <a href="https://www.figma.com/proto/7B8XgQo4P2uLFwSsYGvuLU/Lumi---HackBcn?node-id=1-66&viewport=-1199%2C226%2C0.09&t=6MTFMYKXABxqUukh-1&scaling=contain&content-scaling=fixed&page-id=0%3A1">📊 View pitch deck</a>
    &nbsp;·&nbsp;
    <a href="#run-it-in-5-steps">🚀 Quick start</a>
    &nbsp;·&nbsp;
    <a href="#how-to-evaluate-with-galtea">🧪 Evaluate</a>
  </p>

  <img src="public/product.png" alt="Lumi product screenshot" width="100%" />
</div>

Lumi is a Telegram agent built with [Mastra](https://mastra.ai) for **HackBarna AI Summit 26**. It sits between the patient and the clinic — answering routine questions on its own, routing anything clinical to a human nurse for approval, and opening a video call on urgent cases.

### What Lumi does

| Role | Description |
|---|---|
| 🗂 **Patient Coordinator** | Tracks appointments, medication schedule and cycle day |
| 🔀 **Triage Assistant** | Classifies every message: routine · logistic · clinical · urgent |
| 📋 **Medical Secretary** | Answers logistic questions, reminds medication times |
| 📁 **Clinical History** | Keeps a full record of past attempts, nurse notes and symptoms |
| 🚨 **Urgency Support** | Opens a nurse video call and gives the emergency phone instantly |

---

## Run it in 5 steps

1. `git clone <this repo> && cd bam-hackers && npm install`
2. `cp .env.example .env` — fill in `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET_TOKEN`, `NEBIUS_API_KEY` and `NURSE_TELEGRAM_CHAT_ID`
3. `npx cloudflared tunnel --url http://localhost:4111` — copy the printed URL into `PUBLIC_BASE_URL`
4. Register the webhook and start the server:
   ```bash
   curl -X POST "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/setWebhook" \
     -H 'content-type: application/json' \
     -d '{"url":"<PUBLIC_BASE_URL>/api/agents/companion/channels/telegram/webhook","secret_token":"<TELEGRAM_WEBHOOK_SECRET_TOKEN>"}'

   npm run dev
   ```
5. Message the bot on Telegram. Send `/demo` — Lumi will message you first with the Marta demo case.

---

## How to evaluate with Galtea

`POST /eval/message` runs the full triage and escalation path without Telegram:

```bash
curl -X POST http://localhost:4111/eval/message \
  -H 'content-type: application/json' \
  -d '{"text":"Can I double the dose if I forgot yesterday?"}'
```

Response includes `tier` (routine · logistic · clinical · urgent), `reason`, `reply` and `ticketId`. Pass `chatId` to keep a conversation across calls.

---

## Demo helpers

| Endpoint | What it does |
|---|---|
| `POST /demo/seed?chatId=…` | Loads the Marta case and schedules the first reminder |
| `POST /demo/reminder?chatId=…` | Triggers the medication reminder now |
| `POST /demo/followup?chatId=…` | Triggers the 24 h follow-up now |
| `POST /demo/nurse-decision` `{ ticketId, approved }` | Exercises the nurse approval loop |
| `POST /demo/reset?chatId=…` | Wipes a chat |

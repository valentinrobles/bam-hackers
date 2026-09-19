# Lumi — nurse-in-the-loop companion for IVF patients

A Telegram agent built with Mastra for HackBarna AI Summit 26. It answers routine and
logistic questions on its own, sends anything clinical to a human nurse for approval,
and opens a video call with the nurse on urgent cases.

## Run it in 5 steps

1. `git clone <this repo> && cd HackBarna && npm install`
2. `cp .env.example .env` and fill in `TELEGRAM_BOT_TOKEN` (from @BotFather), `TELEGRAM_WEBHOOK_SECRET_TOKEN` (any random string), `NEBIUS_API_KEY`, and `NURSE_TELEGRAM_CHAT_ID` (the nurse opens a private chat with the bot; her chat id appears in the server log).
3. `npx cloudflared tunnel --url http://localhost:4111` and put the printed URL in `PUBLIC_BASE_URL`.
4. Register the webhook, then start the server:
   ```bash
   curl -X POST "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/setWebhook" \
     -H 'content-type: application/json' \
     -d '{"url":"<PUBLIC_BASE_URL>/api/agents/companion/channels/telegram/webhook","secret_token":"<TELEGRAM_WEBHOOK_SECRET_TOKEN>"}'
   npm run dev
   ```
5. Message the bot on Telegram. **Send `/demo` and wait a minute: Lumi will message you first.**

## How to evaluate with Galtea

`POST /eval/message` runs the same triage and escalation path as a Telegram message, without Telegram:

```bash
curl -X POST http://localhost:4111/eval/message \
  -H 'content-type: application/json' \
  -d '{"text":"¿puedo doblar la dosis si ayer se me olvidó?"}'
```

The response carries `tier` (routine, logistic, clinical or urgent), `reason`, `reply` and `ticketId`. Pass a `chatId` to keep a conversation across calls.

## Demo helpers

- `POST /demo/seed?chatId=…` loads the Marta case and schedules the first reminder (what `/demo` does).
- `POST /demo/reminder?chatId=…` sends the medication reminder now; `POST /demo/followup?chatId=…` sends the 24 h follow-up now.
- `POST /demo/nurse-decision` `{ "ticketId", "approved" }` and `POST /demo/nurse-card` `{ "ticketId" }` exercise the nurse loop without Telegram.
- `POST /demo/reset?chatId=…` wipes a chat.

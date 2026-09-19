import { PinoLogger } from '@mastra/loggers';

const logger = new PinoLogger({ name: 'make', level: 'info' });

// Fire-and-forget glue towards the clinic. Never throws, never blocks a reply
// for more than 5 seconds.
export async function notifyMake(event: string, payload: Record<string, unknown>): Promise<{ sent: boolean }> {
  const url = process.env.MAKE_WEBHOOK_URL;
  if (!url) return { sent: false };
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ event, sentAt: new Date().toISOString(), ...payload }),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      logger.warn('make webhook rejected the event', { event, status: res.status });
      return { sent: false };
    }
    logger.info('make webhook notified', { event });
    return { sent: true };
  } catch (error) {
    logger.warn('make webhook unreachable', { event, error: String(error) });
    return { sent: false };
  }
}

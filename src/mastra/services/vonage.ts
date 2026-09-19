import { readFileSync } from 'node:fs';
import { PinoLogger } from '@mastra/loggers';
import { MediaMode, Video } from '@vonage/video';
import { getTicket, updateTicket, type Ticket } from './tickets';

const logger = new PinoLogger({ name: 'vonage', level: 'info' });

export type CallRole = 'patient' | 'nurse';

export interface CallUrls {
  patientUrl: string;
  nurseUrl: string;
}

function publicBaseUrl(): string {
  return (process.env.PUBLIC_BASE_URL || 'http://localhost:4111').replace(/\/+$/, '');
}

export function callUrls(ticketId: string): CallUrls {
  const base = `${publicBaseUrl()}/call/${encodeURIComponent(ticketId)}`;
  return { patientUrl: `${base}?role=patient`, nurseUrl: `${base}?role=nurse` };
}

// Private key from a file path (VONAGE_PRIVATE_KEY_PATH) or inline
// (VONAGE_PRIVATE_KEY, "\n" escapes allowed), like the Vonage starter.
function loadPrivateKey(): string | undefined {
  const path = process.env.VONAGE_PRIVATE_KEY_PATH?.trim();
  if (path) {
    try {
      return readFileSync(path, 'utf8');
    } catch (error) {
      logger.error('cannot read VONAGE_PRIVATE_KEY_PATH', { path, error: String(error) });
    }
  }
  const inline = process.env.VONAGE_PRIVATE_KEY?.trim();
  if (inline) return inline.replace(/\\n/g, '\n');
  return undefined;
}

let video: Video | null | undefined;

function getVideo(): Video | null {
  if (video !== undefined) return video;
  const applicationId = process.env.VONAGE_APPLICATION_ID?.trim();
  const privateKey = loadPrivateKey();
  if (!applicationId || !privateKey) {
    logger.warn('Vonage not configured (VONAGE_APPLICATION_ID / private key missing): video calls will show an unavailable page');
    video = null;
    return video;
  }
  video = new Video({ applicationId, privateKey });
  return video;
}

export function vonageConfigured(): boolean {
  return getVideo() !== null;
}

// Creates (or reuses) the routed session for a ticket and returns the two
// join links. Never throws: the escalation path must not fail visibly, so a
// Vonage error is logged and the links still go out (the page then explains).
export async function startVideoCall(ticketId: string): Promise<CallUrls & { sessionId: string | null; patientToken?: string; nurseToken?: string }> {
  const urls = callUrls(ticketId);
  const client = getVideo();
  const ticket = await getTicket(ticketId);
  if (!client || !ticket) {
    if (!ticket) logger.warn('start_video_call for unknown ticket', { ticketId });
    return { ...urls, sessionId: ticket?.sessionId ?? null };
  }
  try {
    let sessionId = ticket.sessionId;
    if (!sessionId) {
      const session = await client.createSession({ mediaMode: MediaMode.ROUTED });
      sessionId = session.sessionId;
      await updateTicket(ticketId, { sessionId });
      logger.info('video session created', { ticketId, sessionId });
    }
    return {
      ...urls,
      sessionId,
      patientToken: tokenFor(client, sessionId, 'patient'),
      nurseToken: tokenFor(client, sessionId, 'nurse'),
    };
  } catch (error) {
    logger.error('could not create the video session', { ticketId, error: String(error) });
    return { ...urls, sessionId: null };
  }
}

function tokenFor(client: Video, sessionId: string, role: CallRole): string {
  return client.generateClientToken(sessionId, {
    role: 'publisher',
    data: `role=${role}`,
    expireTime: Math.floor(Date.now() / 1000) + 2 * 60 * 60,
  });
}

export type CallCredentials =
  | { ok: true; applicationId: string; sessionId: string; token: string; role: CallRole }
  | { ok: false; reason: string };

// Fresh token per page load, so a link opened later still works.
export async function callCredentials(ticketId: string, role: CallRole): Promise<CallCredentials> {
  const client = getVideo();
  if (!client) return { ok: false, reason: 'La videollamada no está configurada en este servidor.' };
  const ticket = await getTicket(ticketId);
  if (!ticket) return { ok: false, reason: 'Este enlace de videollamada no existe.' };
  let sessionId = ticket.sessionId;
  if (!sessionId) {
    const started = await startVideoCall(ticketId);
    sessionId = started.sessionId;
  }
  if (!sessionId) return { ok: false, reason: 'No se ha podido crear la sala de videollamada. Llama a la clínica.' };
  return { ok: true, applicationId: process.env.VONAGE_APPLICATION_ID!.trim(), sessionId, token: tokenFor(client, sessionId, role), role };
}

// Later: live captions and the call transcript plug in here and become the
// summary stored with the ticket and in nurseNotes.
export async function summarizeCall(_ticket: Ticket): Promise<string | null> {
  return null;
}

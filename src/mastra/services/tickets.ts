import { createClient, type Client } from '@libsql/client';
import { randomBytes } from 'node:crypto';
import { databaseUrl } from '../storage';
import type { Tier } from './nebius';

export type TicketStatus = 'open' | 'awaiting_nurse' | 'approved' | 'awaiting_nurse_reply' | 'answered' | 'closed';

export interface Ticket {
  id: string;
  chatId: string;
  patientName: string | null;
  tier: Tier;
  message: string;
  contextSummary: string | null;
  status: TicketStatus;
  createdAt: string;
  runId: string | null;
  toolCallId: string | null;
  suggestedReply: string | null;
  followUpSentAt: string | null;
  sessionId: string | null;
  callEndedAt: string | null;
}

let client: Client | undefined;
let ready: Promise<void> | undefined;

async function db(): Promise<Client> {
  if (!client) client = createClient({ url: databaseUrl });
  if (!ready) {
    ready = client
      .execute(
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
          suggestedReply TEXT,
          followUpSentAt TEXT,
          sessionId TEXT,
          callEndedAt TEXT
        )`,
      )
      .then(() => client!.execute('ALTER TABLE tickets ADD COLUMN followUpSentAt TEXT').catch(() => undefined))
      .then(() => client!.execute('ALTER TABLE tickets ADD COLUMN sessionId TEXT').catch(() => undefined))
      .then(() => client!.execute('ALTER TABLE tickets ADD COLUMN callEndedAt TEXT').catch(() => undefined))
      .then(() =>
        client!.execute(
          'CREATE TABLE IF NOT EXISTS reminders_sent (chatId TEXT NOT NULL, day TEXT NOT NULL, slot TEXT NOT NULL, sentAt TEXT NOT NULL, PRIMARY KEY (chatId, day, slot))',
        ),
      )
      .then(() =>
        client!.execute(
          `CREATE TABLE IF NOT EXISTS scheduled_sends (
            id TEXT PRIMARY KEY,
            chatId TEXT NOT NULL,
            kind TEXT NOT NULL,
            ticketId TEXT,
            dueAt TEXT NOT NULL,
            createdAt TEXT NOT NULL,
            sentAt TEXT
          )`,
        ),
      )
      .then(() => undefined);
  }
  await ready;
  return client;
}

function rowToTicket(row: Record<string, unknown>): Ticket {
  return {
    id: String(row.id),
    chatId: String(row.chatId),
    patientName: row.patientName == null ? null : String(row.patientName),
    tier: String(row.tier) as Tier,
    message: String(row.message),
    contextSummary: row.contextSummary == null ? null : String(row.contextSummary),
    status: String(row.status) as TicketStatus,
    createdAt: String(row.createdAt),
    runId: row.runId == null ? null : String(row.runId),
    toolCallId: row.toolCallId == null ? null : String(row.toolCallId),
    suggestedReply: row.suggestedReply == null ? null : String(row.suggestedReply),
    followUpSentAt: row.followUpSentAt == null ? null : String(row.followUpSentAt),
    sessionId: row.sessionId == null ? null : String(row.sessionId),
    callEndedAt: row.callEndedAt == null ? null : String(row.callEndedAt),
  };
}

export async function createTicket(input: {
  chatId: string;
  patientName?: string | null;
  tier: Tier;
  message: string;
  contextSummary?: string | null;
}): Promise<Ticket> {
  const ticket: Ticket = {
    id: `T-${Date.now().toString(36).toUpperCase()}${randomBytes(2).toString('hex').toUpperCase()}`,
    chatId: input.chatId,
    patientName: input.patientName ?? null,
    tier: input.tier,
    message: input.message,
    contextSummary: input.contextSummary ?? null,
    status: 'open',
    createdAt: new Date().toISOString(),
    runId: null,
    toolCallId: null,
    suggestedReply: null,
    followUpSentAt: null,
    sessionId: null,
    callEndedAt: null,
  };
  await (await db()).execute({
    sql: `INSERT INTO tickets (id, chatId, patientName, tier, message, contextSummary, status, createdAt)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [ticket.id, ticket.chatId, ticket.patientName, ticket.tier, ticket.message, ticket.contextSummary, ticket.status, ticket.createdAt],
  });
  return ticket;
}

export async function getTicket(id: string): Promise<Ticket | null> {
  const res = await (await db()).execute({ sql: 'SELECT * FROM tickets WHERE id = ?', args: [id] });
  const row = res.rows[0];
  return row ? rowToTicket(row as unknown as Record<string, unknown>) : null;
}

export async function updateTicket(
  id: string,
  patch: Partial<Pick<Ticket, 'status' | 'runId' | 'toolCallId' | 'suggestedReply' | 'followUpSentAt' | 'sessionId' | 'callEndedAt'>>,
): Promise<void> {
  const entries = Object.entries(patch).filter(([, v]) => v !== undefined);
  if (!entries.length) return;
  await (await db()).execute({
    sql: `UPDATE tickets SET ${entries.map(([k]) => `${k} = ?`).join(', ')} WHERE id = ?`,
    args: [...entries.map(([, v]) => v as string), id],
  });
}

export async function latestTicketByStatus(status: TicketStatus): Promise<Ticket | null> {
  const res = await (await db()).execute({
    sql: 'SELECT * FROM tickets WHERE status = ? ORDER BY createdAt DESC LIMIT 1',
    args: [status],
  });
  const row = res.rows[0];
  return row ? rowToTicket(row as unknown as Record<string, unknown>) : null;
}

export async function urgentTicketsDueForFollowUp(before: Date): Promise<Ticket[]> {
  const res = await (await db()).execute({
    sql: "SELECT * FROM tickets WHERE tier = 'urgent' AND followUpSentAt IS NULL AND createdAt <= ? ORDER BY createdAt ASC",
    args: [before.toISOString()],
  });
  return res.rows.map((row) => rowToTicket(row as unknown as Record<string, unknown>));
}

export async function latestUrgentTicketForChat(chatId: string): Promise<Ticket | null> {
  const res = await (await db()).execute({
    sql: "SELECT * FROM tickets WHERE tier = 'urgent' AND chatId = ? ORDER BY createdAt DESC LIMIT 1",
    args: [chatId],
  });
  const row = res.rows[0];
  return row ? rowToTicket(row as unknown as Record<string, unknown>) : null;
}

// Returns false when this reminder slot was already sent today.
export async function claimReminderSlot(chatId: string, day: string, slot: string): Promise<boolean> {
  try {
    await (await db()).execute({
      sql: 'INSERT INTO reminders_sent (chatId, day, slot, sentAt) VALUES (?, ?, ?, ?)',
      args: [chatId, day, slot, new Date().toISOString()],
    });
    return true;
  } catch {
    return false;
  }
}

// Patients are Mastra memory resources; the record is the working memory JSON.
export async function listPatientRecords(): Promise<{ chatId: string; workingMemory: string }[]> {
  const res = await (await db()).execute('SELECT id, workingMemory FROM mastra_resources WHERE workingMemory IS NOT NULL');
  return res.rows.map((row) => ({ chatId: String(row.id), workingMemory: String(row.workingMemory) }));
}

export type ScheduledSendKind = 'followup' | 'demo_reminder';

export interface ScheduledSend {
  id: string;
  chatId: string;
  kind: ScheduledSendKind;
  ticketId: string | null;
  dueAt: string;
  createdAt: string;
  sentAt: string | null;
}

function rowToSend(row: Record<string, unknown>): ScheduledSend {
  return {
    id: String(row.id),
    chatId: String(row.chatId),
    kind: (String(row.kind) as ScheduledSendKind) ?? 'followup',
    ticketId: row.ticketId == null ? null : String(row.ticketId),
    dueAt: String(row.dueAt),
    createdAt: String(row.createdAt),
    sentAt: row.sentAt == null ? null : String(row.sentAt),
  };
}

// One row per planned proactive message. Survives restarts; sentAt prevents
// duplicates.
export async function scheduleSend(input: { chatId: string; kind: ScheduledSendKind; ticketId?: string | null; dueAt: Date }): Promise<ScheduledSend> {
  const send: ScheduledSend = {
    id: `S-${Date.now().toString(36).toUpperCase()}${randomBytes(2).toString('hex').toUpperCase()}`,
    chatId: input.chatId,
    kind: input.kind,
    ticketId: input.ticketId ?? null,
    dueAt: input.dueAt.toISOString(),
    createdAt: new Date().toISOString(),
    sentAt: null,
  };
  await (await db()).execute({
    sql: 'INSERT INTO scheduled_sends (id, chatId, kind, ticketId, dueAt, createdAt) VALUES (?, ?, ?, ?, ?, ?)',
    args: [send.id, send.chatId, send.kind, send.ticketId, send.dueAt, send.createdAt],
  });
  return send;
}

export async function dueScheduledSends(now: Date): Promise<ScheduledSend[]> {
  const res = await (await db()).execute({
    sql: 'SELECT * FROM scheduled_sends WHERE sentAt IS NULL AND dueAt <= ? ORDER BY dueAt ASC',
    args: [now.toISOString()],
  });
  return res.rows.map((row) => rowToSend(row as unknown as Record<string, unknown>));
}

export async function pendingScheduledSendsForChat(chatId: string, kind: ScheduledSendKind): Promise<ScheduledSend[]> {
  const res = await (await db()).execute({
    sql: 'SELECT * FROM scheduled_sends WHERE sentAt IS NULL AND chatId = ? AND kind = ? ORDER BY dueAt ASC',
    args: [chatId, kind],
  });
  return res.rows.map((row) => rowToSend(row as unknown as Record<string, unknown>));
}

// Returns false when another tick already claimed this row.
export async function claimScheduledSend(id: string): Promise<boolean> {
  const res = await (await db()).execute({
    sql: 'UPDATE scheduled_sends SET sentAt = ? WHERE id = ? AND sentAt IS NULL',
    args: [new Date().toISOString(), id],
  });
  return res.rowsAffected > 0;
}

// Drops pending (unsent) rows for a chat; all kinds when kind is omitted.
export async function cancelPendingSends(chatId: string, kind?: ScheduledSendKind): Promise<number> {
  const res = await (await db()).execute(
    kind
      ? { sql: 'DELETE FROM scheduled_sends WHERE sentAt IS NULL AND chatId = ? AND kind = ?', args: [chatId, kind] }
      : { sql: 'DELETE FROM scheduled_sends WHERE sentAt IS NULL AND chatId = ?', args: [chatId] },
  );
  return res.rowsAffected;
}

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
          suggestedReply TEXT
        )`,
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
  patch: Partial<Pick<Ticket, 'status' | 'runId' | 'toolCallId' | 'suggestedReply'>>,
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

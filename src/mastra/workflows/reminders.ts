import { createStep, createWorkflow } from '@mastra/core/workflows';
import { z } from 'zod';
import { companion } from '../agents/companion';
import { parsePatient, type Patient } from '../memory/patient-schema';
import { postToPatient } from '../services/nurse';
import { claimReminderSlot, latestUrgentTicketForChat, listPatientRecords, updateTicket, urgentTicketsDueForFollowUp, type Ticket } from '../services/tickets';

const CLINIC_EMERGENCY_PHONE = process.env.CLINIC_EMERGENCY_PHONE ?? '+34900000000';
const TIMEZONE = process.env.REMINDER_TIMEZONE || 'Europe/Madrid';
const FOLLOW_UP_AFTER_MS = 24 * 60 * 60 * 1000;

export const reminderInput = z.object({
  // 'tick' is what the schedule sends every minute; the other two are manual triggers.
  kind: z.enum(['tick', 'medication', 'followup']).default('tick'),
  chatId: z.string().optional(),
});

const reminderOutput = z.object({
  sent: z.number(),
  details: z.array(z.string()),
});

function clinicClock(now: Date): { day: string; hhmm: string } {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return { day: `${get('year')}-${get('month')}-${get('day')}`, hhmm: `${get('hour')}:${get('minute')}` };
}

function medicationText(patient: Patient, item: Patient['protocol'][number]): string {
  return `💉 ${patient.name ? `${patient.name}, r` : 'R'}ecordatorio: ${item.drug} ${item.dose} a las ${item.time}. Cuando te la pongas, escríbeme «hecho» y lo anoto.`;
}

function followUpText(patient: Patient | null, ticket: Ticket | null): string {
  const name = patient?.name ? `${patient.name}, ` : '';
  const about = ticket ? ` Ayer avisamos a tu enfermera por lo que me contaste («${ticket.message.slice(0, 80)}»).` : '';
  return `👩‍⚕️ ${name}¿cómo estás hoy?${about} Si algo ha empeorado o no mejora, llama a la clínica al ${CLINIC_EMERGENCY_PHONE}.`;
}

async function loadPatients(): Promise<{ chatId: string; patient: Patient }[]> {
  const rows = await listPatientRecords();
  return rows.flatMap(({ chatId, workingMemory }) => {
    const patient = parsePatient(workingMemory);
    return patient ? [{ chatId, patient }] : [];
  });
}

const dispatch = createStep({
  id: 'dispatch-reminders',
  inputSchema: reminderInput,
  outputSchema: reminderOutput,
  execute: async ({ inputData, mastra }) => {
    const logger = mastra?.getLogger();
    const details: string[] = [];
    const now = new Date();
    const { day, hhmm } = clinicClock(now);
    const send = async (chatId: string, text: string, label: string) => {
      const posted = await postToPatient(companion, chatId, text);
      details.push(`${label} → ${chatId}: ${posted ? 'sent' : 'NOT sent'}`);
      logger?.info('reminder', { label, chatId, posted });
      return posted ? 1 : 0;
    };
    let sent = 0;

    if (inputData.kind === 'medication' && inputData.chatId) {
      const patient = (await loadPatients()).find((p) => p.chatId === inputData.chatId)?.patient;
      if (!patient?.protocol.length) return { sent, details: [`no protocol on record for ${inputData.chatId}`] };
      for (const item of patient.protocol) sent += await send(inputData.chatId, medicationText(patient, item), `medication ${item.time}`);
      return { sent, details };
    }

    if (inputData.kind === 'followup' && inputData.chatId) {
      const patient = (await loadPatients()).find((p) => p.chatId === inputData.chatId)?.patient ?? null;
      const ticket = await latestUrgentTicketForChat(inputData.chatId);
      sent += await send(inputData.chatId, followUpText(patient, ticket), 'follow-up');
      if (ticket) await updateTicket(ticket.id, { followUpSentAt: now.toISOString() });
      return { sent, details };
    }

    // Scheduled tick: medication slots that match the clinic clock, once per day each.
    for (const { chatId, patient } of await loadPatients()) {
      for (const item of patient.protocol) {
        if (item.time !== hhmm) continue;
        if (!(await claimReminderSlot(chatId, day, item.time))) continue;
        sent += await send(chatId, medicationText(patient, item), `medication ${item.time}`);
      }
    }
    // Urgent tickets older than 24 h without a follow-up.
    const patients = await loadPatients();
    for (const ticket of await urgentTicketsDueForFollowUp(new Date(now.getTime() - FOLLOW_UP_AFTER_MS))) {
      const patient = patients.find((p) => p.chatId === ticket.chatId)?.patient ?? null;
      await updateTicket(ticket.id, { followUpSentAt: now.toISOString() });
      sent += await send(ticket.chatId, followUpText(patient, ticket), `follow-up ${ticket.id}`);
    }
    return { sent, details };
  },
});

// Runs every minute on Mastra's scheduler (Harness). POST /demo/reminder runs
// the same workflow by hand with kind=medication|followup.
export const remindersWorkflow = createWorkflow({
  id: 'reminders',
  inputSchema: reminderInput,
  outputSchema: reminderOutput,
  schedule: { cron: '* * * * *', timezone: TIMEZONE, inputData: { kind: 'tick' } },
})
  .then(dispatch)
  .commit();

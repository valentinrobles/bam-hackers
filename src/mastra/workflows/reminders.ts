import { createStep, createWorkflow } from '@mastra/core/workflows';
import { z } from 'zod';
import { companion } from '../agents/companion';
import { parsePatient, type Patient } from '../memory/patient-schema';
import { DOSE_QUESTION, DOSE_TAKEN, postToPatient } from '../services/nurse';
import {
  claimReminderSlot,
  claimScheduledSend,
  dueScheduledSends,
  getTicket,
  latestUrgentTicketForChat,
  listPatientRecords,
  pendingScheduledSendsForChat,
  updateTicket,
  type Ticket,
} from '../services/tickets';

const CLINIC_EMERGENCY_PHONE = process.env.CLINIC_EMERGENCY_PHONE ?? '+34900000000';
const TIMEZONE = process.env.REMINDER_TIMEZONE || 'Europe/Madrid';

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
  return `💉 ${patient.name ? `${patient.name}, toca` : 'Toca'} ${item.drug} ${item.dose} (${item.time}).`;
}

// First message the judge sees after /demo, before any setup.
function demoReminderText(patient: Patient, item: Patient['protocol'][number]): string {
  return `💉 ${patient.name ? `${patient.name}, toca` : 'Toca'} ${item.drug} ${item.dose}. Te avisaré cada día a las ${item.time}.`;
}

function medicationButtons(item: Patient['protocol'][number]) {
  // value = protocol time slot; the handler looks the entry up in the record.
  return [
    { actionId: DOSE_TAKEN, label: 'Ya me la puse', value: item.time },
    { actionId: DOSE_QUESTION, label: 'Tengo una duda', value: item.time },
  ];
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
    const send = async (chatId: string, text: string, label: string, buttons?: ReturnType<typeof medicationButtons>) => {
      const posted = await postToPatient(companion, chatId, text, buttons);
      details.push(`${label} → ${chatId}: ${posted ? 'sent' : 'NOT sent'}`);
      logger?.info('reminder', { label, chatId, posted });
      return posted ? 1 : 0;
    };
    let sent = 0;

    if (inputData.kind === 'medication' && inputData.chatId) {
      const patient = (await loadPatients()).find((p) => p.chatId === inputData.chatId)?.patient;
      if (!patient?.protocol.length) return { sent, details: [`no protocol on record for ${inputData.chatId}`] };
      for (const item of patient.protocol) sent += await send(inputData.chatId, medicationText(patient, item), `medication ${item.time}`, medicationButtons(item));
      return { sent, details };
    }

    if (inputData.kind === 'followup' && inputData.chatId) {
      // Fire the pending scheduled follow-up now; if none is pending, send one anyway.
      const patient = (await loadPatients()).find((p) => p.chatId === inputData.chatId)?.patient ?? null;
      const pending = await pendingScheduledSendsForChat(inputData.chatId, 'followup');
      const ticket = pending[0]?.ticketId ? await getTicket(pending[0].ticketId) : await latestUrgentTicketForChat(inputData.chatId);
      for (const row of pending) await claimScheduledSend(row.id);
      sent += await send(inputData.chatId, followUpText(patient, ticket), 'follow-up');
      if (ticket) await updateTicket(ticket.id, { followUpSentAt: now.toISOString() });
      return { sent, details };
    }

    // Scheduled tick: medication slots that match the clinic clock, once per day each.
    for (const { chatId, patient } of await loadPatients()) {
      for (const item of patient.protocol) {
        if (item.time !== hhmm) continue;
        if (!(await claimReminderSlot(chatId, day, item.time))) continue;
        sent += await send(chatId, medicationText(patient, item), `medication ${item.time}`, medicationButtons(item));
      }
    }
    // Scheduled sends that are due (follow-ups planned when an urgent ticket was created).
    const patients = await loadPatients();
    for (const row of await dueScheduledSends(now)) {
      if (!(await claimScheduledSend(row.id))) continue;
      const patient = patients.find((p) => p.chatId === row.chatId)?.patient ?? null;
      if (row.kind === 'demo_reminder') {
        const item = patient?.protocol[0];
        if (!patient || !item) {
          details.push(`demo reminder ${row.id}: no protocol on record, skipped`);
          continue;
        }
        sent += await send(row.chatId, demoReminderText(patient, item), `demo reminder ${row.id}`, medicationButtons(item));
        continue;
      }
      const ticket = row.ticketId ? await getTicket(row.ticketId) : null;
      if (ticket) await updateTicket(ticket.id, { followUpSentAt: now.toISOString() });
      sent += await send(row.chatId, followUpText(patient, ticket), `follow-up ${row.id}`);
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

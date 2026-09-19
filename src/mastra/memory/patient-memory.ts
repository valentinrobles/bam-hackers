import { Memory } from '@mastra/memory';
import { storage } from '../storage';
import { emptyPatient, parsePatient, patientSchema, type Patient } from './patient-schema';

export const memory = new Memory({
  storage,
  options: {
    lastMessages: 20,
    workingMemory: {
      enabled: true,
      scope: 'resource',
      schema: patientSchema,
    },
  },
});

const clinicStamp = new Intl.DateTimeFormat('sv-SE', {
  timeZone: process.env.REMINDER_TIMEZONE || 'Europe/Madrid',
  year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});

// "2026-09-19 17:54" in clinic time, the format the record uses for dates.
export function nowStamp(): string {
  return clinicStamp.format(new Date());
}

export function chatIdFromThreadId(threadId: string): string {
  return threadId.replace(/^telegram:/, '').split(':')[0] ?? threadId;
}

export function threadIdForChat(chatId: string): string {
  return `telegram:${chatId}`;
}

// Each clinical escalation runs on its own thread. With an empty history the
// model can be forced to call notify_nurse (tool_choice required) in ~2 s;
// the same forced call on a thread that already holds tool history takes
// ~30 s on Nebius.
export function clinicalThreadId(chatId: string, ticketId: string): string {
  return `telegram:${chatId}:ticket:${ticketId}`;
}

export async function readPatient(chatId: string): Promise<Patient | null> {
  return parsePatient(await memory.getWorkingMemory({ threadId: threadIdForChat(chatId), resourceId: chatId }));
}

export async function writePatient(chatId: string, patient: Patient): Promise<void> {
  await memory.updateWorkingMemory({
    threadId: threadIdForChat(chatId),
    resourceId: chatId,
    workingMemory: JSON.stringify(patient),
  });
}

export async function patchPatient(chatId: string, patch: (current: Patient) => Patient): Promise<Patient> {
  const next = patch((await readPatient(chatId)) ?? emptyPatient);
  await writePatient(chatId, next);
  return next;
}

export async function appendSymptom(chatId: string, text: string, tier: Patient['symptoms'][number]['tier']): Promise<number> {
  const next = await patchPatient(chatId, (p) => ({
    ...p,
    symptoms: [...p.symptoms, { date: nowStamp(), text, tier }],
  }));
  return next.symptoms.length;
}

export async function addNurseNote(chatId: string, note: { ticketId: string; question: string; reply: string }): Promise<void> {
  await patchPatient(chatId, (p) => ({
    ...p,
    nurseNotes: [...p.nurseNotes, { date: nowStamp(), ...note }],
  }));
}

export async function resetChat(chatId: string): Promise<void> {
  await writePatient(chatId, emptyPatient);
  const threadId = threadIdForChat(chatId);
  if (await memory.getThreadById({ threadId })) {
    await memory.deleteThread(threadId);
  }
}

export function summarizePatient(p: Patient | null): string {
  if (!p) return 'Sin datos del paciente.';
  const parts = [
    p.name ? `Paciente: ${p.name}` : 'Paciente sin nombre',
    p.cycle ? `Ciclo: día ${p.cycle.day}, fase ${p.cycle.phase}, inicio ${p.cycle.startDate}` : 'Ciclo: sin datos',
    p.protocol.length ? `Pauta: ${p.protocol.map((m) => `${m.drug} ${m.dose} a las ${m.time}`).join('; ')}` : 'Pauta: sin datos',
    p.nextAppointment ? `Próxima cita: ${p.nextAppointment.type}, ${p.nextAppointment.datetime}` : 'Próxima cita: sin datos',
    p.symptoms.length ? `Síntomas: ${p.symptoms.slice(-3).map((s) => `${s.date} ${s.text} (${s.tier})`).join('; ')}` : 'Síntomas: ninguno registrado',
    p.nurseNotes.length ? `Última respuesta de la enfermera: ${p.nurseNotes[p.nurseNotes.length - 1]?.reply}` : 'Respuestas de la enfermera: ninguna todavía',
  ];
  return parts.join('\n');
}

import { z } from 'zod';

export const cyclePhases = ['stimulation', 'trigger', 'retrieval', 'transfer', 'two_week_wait'] as const;
export const symptomTiers = ['routine', 'clinical', 'urgent'] as const;

const ONLY_IF_STATED = 'Omit entirely unless the patient stated it explicitly or /demo seeded it. Never guess.';

export const patientSchema = z.object({
  name: z.string().optional().describe('Patient first name.'),
  onboarded: z.boolean().default(false),
  language: z.enum(['es', 'en']).default('es').describe('Language the patient writes in. Reply in it.'),
  cycle: z
    .object({
      day: z.number(),
      phase: z.enum(cyclePhases),
      startDate: z.string(),
    })
    .optional()
    .describe(`Current treatment cycle. ${ONLY_IF_STATED}`),
  protocol: z
    .array(z.object({ drug: z.string(), dose: z.string(), time: z.string() }))
    .default([])
    .describe(`Medication protocol. ${ONLY_IF_STATED}`),
  nextAppointment: z
    .object({ type: z.string(), datetime: z.string() })
    .optional()
    .describe(`Next clinic appointment. ${ONLY_IF_STATED}`),
  symptoms: z
    .array(z.object({ date: z.string(), text: z.string(), tier: z.enum(symptomTiers) }))
    .default([])
    .describe('Symptoms the patient reported, appended over time.'),
  openTicketId: z.string().nullable().default(null),
  dosesTaken: z
    .array(z.object({ date: z.string(), drug: z.string(), dose: z.string(), time: z.string() }))
    .default([])
    .describe('Doses the patient confirmed taking (button "Ya me la puse" or a confirmation message).'),
  nurseNotes: z
    .array(z.object({ date: z.string(), ticketId: z.string(), question: z.string(), reply: z.string() }))
    .default([])
    .describe('What the nurse answered to earlier questions, newest last. Written by the system, never by you.'),
});

export type Patient = z.infer<typeof patientSchema>;

export const emptyPatient: Patient = patientSchema.parse({});

export function parsePatient(raw: string | null | undefined): Patient | null {
  if (!raw) return null;
  try {
    return patientSchema.parse(JSON.parse(raw));
  } catch {
    return null;
  }
}

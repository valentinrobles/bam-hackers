import type { Patient } from './patient-schema';

function nextWeekday(from: Date, weekday: number): Date {
  const d = new Date(from);
  d.setDate(d.getDate() + ((weekday - d.getDay() + 7) % 7 || 7));
  return d;
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

// Demo case: Usuaria 1 clinical context (see uploads/Usuaria_1_ivf_context.md).
// Current state: stimulation day 6 at new clinic, Gonal-f 225 IU at 21:00,
// monitoring ultrasound on Thursday at 10:00.
export function martaPatient(now = new Date()): Patient {
  const cycleStart = new Date(now);
  cycleStart.setDate(cycleStart.getDate() - 5);
  const thursday = nextWeekday(now, 4);
  return {
    name: 'Marta',
    onboarded: true,
    cycle: { day: 6, phase: 'stimulation', startDate: isoDate(cycleStart) },
    protocol: [{ drug: 'Gonal-f', dose: '225 UI', time: '21:00' }],
    nextAppointment: { type: 'ecografía de control', datetime: `jueves ${isoDate(thursday)} 10:00` },
    symptoms: [],
    openTicketId: null,
    treatmentSummary: [
      'Intento 1 (mar–dic 2025): estimulación ovárica con Omifin y Bemfola. Respuesta folicular limitada. Ciclo cancelado el 1 dic 2025. Sin punción.',
      'Intento 2 (ene–feb 2026): Meriestra, Menopur, Decapeptyl, Puregon, progesterona y ácido fólico. Punción el 4 feb. Transferencia el 9 feb. Sangrado urgente el 17 feb. Pérdida gestacional bioquímica confirmada.',
      'Intento 3 (feb–jul 2026): investigación inmunológica y hematológica. Transferencia el 7 jul 2026. Beta-hCG negativo el 17 jul 2026.',
      'Intento 4 / actual (jul–sep 2026): analíticas hormonales, ECG, cribado infeccioso. Primera consulta en nueva clínica el 7 sep 2026. Preparación de tratamiento iniciada el 14 sep 2026. FIV con diagnóstico genético preimplantacional y esperma de donante. Actualmente en día 6 de estimulación con Gonal-f 225 UI.',
      'Medicación histórica: Meriestra, Omifin, Bemfola, Menopur, Decapeptyl, Puregon, progesterona, ácido fólico. Medicación actual: Gonal-f 225 UI a las 21:00.',
    ].join('\n'),
  };
}

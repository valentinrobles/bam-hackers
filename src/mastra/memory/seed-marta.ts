import type { Patient } from './patient-schema';

const es = new Intl.DateTimeFormat('es-ES', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });

// Dates in the record carry the weekday spelled out so the model never has to
// compute one (it gets them wrong).
export function spanishDate(d: Date): string {
  return es.format(d);
}

function daysFrom(from: Date, days: number): Date {
  const d = new Date(from);
  d.setDate(d.getDate() + days);
  return d;
}

function nextWeekday(from: Date, weekday: number): Date {
  return daysFrom(from, (weekday - from.getDay() + 7) % 7 || 7);
}

// Demo case (Usuaria 1), relative to today: stimulation day 6, Gonal-f 225 UI
// at 21:00, monitoring ultrasound next Thursday 10:00. Full 4-attempt history.
export function martaPatient(now = new Date()): Patient {
  return {
    name: 'Marta',
    onboarded: true,
    nurseName: 'Laura',
    cycle: { day: 6, phase: 'stimulation', startDate: spanishDate(daysFrom(now, -5)) },
    protocol: [{ drug: 'Gonal-f', dose: '225 UI', time: '21:00' }],
    nextAppointment: { type: 'ecografía de control', datetime: `${spanishDate(nextWeekday(now, 4))}, 10:00` },
    symptoms: [],
    openTicketId: null,
    treatmentSummary: [
      'Intento 1 (mar–dic 2025): estimulación ovárica con Omifin y Bemfola. Respuesta folicular limitada. Ciclo cancelado el 1 dic 2025. Sin punción.',
      'Intento 2 (ene–feb 2026): Meriestra, Menopur, Decapeptyl, Puregon, progesterona y ácido fólico. Punción el 4 feb. Transferencia el 9 feb. Sangrado urgente el 17 feb. Pérdida gestacional bioquímica confirmada.',
      'Intento 3 (feb–jul 2026): investigación inmunológica y hematológica. Transferencia el 7 jul 2026. Beta-hCG negativo el 17 jul 2026.',
      'Intento 4 / actual (jul–sep 2026): analíticas hormonales, ECG, cribado infeccioso. Primera consulta en nueva clínica el 7 sep 2026. FIV con diagnóstico genético preimplantacional y esperma de donante. Actualmente en día 6 de estimulación con Gonal-f 225 UI.',
      'Medicación histórica: Meriestra, Omifin, Bemfola, Menopur, Decapeptyl, Puregon, progesterona, ácido fólico. Medicación actual: Gonal-f 225 UI a las 21:00.',
    ].join('\n'),
  };
}

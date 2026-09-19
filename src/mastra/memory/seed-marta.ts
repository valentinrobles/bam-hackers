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

// Demo case from CLAUDE.md, relative to today: stimulation started 5 days ago
// (day 6), Gonal-f 225 UI at 21:00, monitoring ultrasound next Thursday 10:00.
export function martaPatient(now = new Date()): Patient {
  return {
    name: 'Marta',
    onboarded: true,
    cycle: { day: 6, phase: 'stimulation', startDate: spanishDate(daysFrom(now, -5)) },
    protocol: [{ drug: 'Gonal-f', dose: '225 UI', time: '21:00' }],
    nextAppointment: { type: 'ecografía de control', datetime: `${spanishDate(nextWeekday(now, 4))}, 10:00` },
    symptoms: [],
    openTicketId: null,
  };
}

import type { Patient } from './patient-schema';

function nextWeekday(from: Date, weekday: number): Date {
  const d = new Date(from);
  d.setDate(d.getDate() + ((weekday - d.getDay() + 7) % 7 || 7));
  return d;
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

// Demo case from CLAUDE.md: stimulation day 6, Gonal-f 225 IU at 21:00,
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
  };
}

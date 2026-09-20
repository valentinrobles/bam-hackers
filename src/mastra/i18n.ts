// Patient-facing texts composed in code. The model already follows the
// patient's language; these are the messages that never go through it.
// Nurse-facing texts stay Spanish (the nurse is the clinic's).
export type Lang = 'es' | 'en';

export function normalizeLang(value: unknown): Lang | undefined {
  if (typeof value !== 'string') return undefined;
  const code = value.toLowerCase().slice(0, 2);
  return code === 'es' || code === 'en' ? code : undefined;
}

const BOT_NAME = process.env.BOT_NAME ?? 'Lumi';
const PHONE = process.env.CLINIC_EMERGENCY_PHONE ?? '+34900000000';

interface ProtocolItem {
  drug: string;
  dose: string;
  time: string;
}

export interface Messages {
  onboarding: string;
  welcomeBack: string;
  unknownCommand: string;
  resetDone: string;
  demoLoaded: (p: { day?: number; drug?: string; dose?: string; time?: string; appointmentType?: string; appointmentWhen?: string }) => string;
  clinicalAck: (name?: string) => string;
  urgentReply: (name: string | undefined, videoUrl: string) => string;
  fallback: string;
  nurseSays: string;
  nurseWillWrite: (name?: string) => string;
  videoInvite: (name: string | undefined, url: string) => string;
  callEnded: string;
  callNote: (when: string, summary?: string | null) => string;
  urgentNote: (videoUrl: string) => string;
  reminder: (name: string | undefined, item: ProtocolItem) => string;
  demoReminder: (name: string | undefined, item: ProtocolItem) => string;
  doseTakenButton: string;
  doseQuestionButton: string;
  doseTaken: (item?: ProtocolItem) => string;
  doseQuestion: string;
  followUp: (name: string | undefined, about?: string | null) => string;
  call: {
    title: string;
    patient: string;
    nurse: string;
    waitingFor: (other: string) => string;
    otherPatient: string;
    otherNurse: string;
    connecting: string;
    connected: (other: string) => string;
    inCall: string;
    disconnected: string;
    ended: string;
    hangUp: string;
    retry: string;
    permission: string;
    noDevice: string;
    busy: string;
    generic: (detail: string) => string;
    moduleMissing: string;
    mute: string;
    unmute: string;
    cameraOn: string;
    cameraOff: string;
  };
}

const es: Messages = {
  onboarding: [
    `¡Hola! Soy ${BOT_NAME}, una acompañante para pacientes en tratamiento de FIV. Te ayudo con recordatorios de medicación, citas y dudas prácticas, y paso cualquier consulta médica a tu enfermera.`,
    `No sustituyo a tu equipo médico. Si quieres probar con un caso de ejemplo, envía /demo.`,
  ].join('\n\n'),
  welcomeBack: '¡Hola de nuevo! ¿En qué te puedo ayudar hoy?',
  unknownCommand: 'No conozco ese comando. Puedes usar /start, /demo o /reset, o simplemente escribirme.',
  resetDone: 'He borrado la memoria de este chat. Escríbeme «hola» para empezar de nuevo.',
  demoLoaded: (p) =>
    `Demo cargada. Ahora eres Marta: día ${p.day} de estimulación, ${p.drug} ${p.dose} a las ${p.time}, ${p.appointmentType} el ${p.appointmentWhen}. Pregúntame lo que quieras; en un minuto te llegará tu primer recordatorio.`,
  clinicalAck: (name) => `${name ? `${name}, esto` : 'Esto'} se lo paso a tu enfermera ahora mismo 👩‍⚕️. Te escribo en cuanto me conteste.`,
  urgentReply: (name, videoUrl) =>
    [
      `${name ? `${name}, gracias` : 'Gracias'} por contármelo; te leo y no estás sola en esto.`,
      `Estoy avisando a tu enfermera ahora mismo y te va a atender por videollamada en este enlace: ${videoUrl}`,
      `Si empeora, no mejora o no puedes esperar, llama ya a la clínica al ${PHONE}.`,
    ].join('\n'),
  fallback: `Ahora mismo no puedo responderte bien. Estoy avisando a tu enfermera. Si es urgente, llama ya a la clínica: ${PHONE}.`,
  nurseSays: '👩‍⚕️ Tu enfermera dice:',
  nurseWillWrite: (name) => `${name ? `${name}, tu` : 'Tu'} enfermera ha leído tu mensaje y te escribirá directamente en unos minutos.`,
  videoInvite: (name, url) => `${name ? `${name}, tu` : 'Tu'} enfermera quiere verte por videollamada ahora. Entra aquí desde el móvil o el ordenador: ${url}`,
  callEnded: 'Llamada finalizada. Si necesitas algo más, aquí estoy.',
  callNote: (when, summary) => (summary ? `Videollamada con tu enfermera el ${when}. Resumen: ${summary}` : `Videollamada con tu enfermera el ${when}.`),
  urgentNote: (videoUrl) => `Caso urgente: se avisó a la enfermera, se abrió videollamada (${videoUrl}) y se dio el teléfono de la clínica ${PHONE}.`,
  reminder: (name, item) => `💉 ${name ? `${name}, toca` : 'Toca'} ${item.drug} ${item.dose} (${item.time}).`,
  demoReminder: (name, item) => `💉 ${name ? `${name}, toca` : 'Toca'} ${item.drug} ${item.dose}. Te avisaré cada día a las ${item.time}.`,
  doseTakenButton: 'Ya me la puse',
  doseQuestionButton: 'Tengo una duda',
  doseTaken: (item) => (item ? `Anotado 💉 ${item.drug} ${item.dose} a las ${item.time}. ¡Bien hecho!` : 'Anotado. ¡Bien hecho!'),
  doseQuestion: 'Cuéntame, te leo. Si es algo sobre la dosis o cómo te sientes, se lo paso a tu enfermera.',
  followUp: (name, about) =>
    `👩‍⚕️ ${name ? `${name}, ` : ''}¿cómo estás hoy?${about ? ` Ayer avisamos a tu enfermera por lo que me contaste («${about}»).` : ''} Si algo ha empeorado o no mejora, llama a la clínica al ${PHONE}.`,
  call: {
    title: 'Videollamada',
    patient: 'Paciente',
    nurse: 'Enfermera',
    waitingFor: (other) => `Esperando a ${other}…`,
    otherPatient: 'la paciente',
    otherNurse: 'tu enfermera',
    connecting: 'Conectando…',
    connected: (other) => `Conectado. Esperando a ${other}…`,
    inCall: 'En llamada',
    disconnected: 'Desconectado de la llamada.',
    ended: 'Llamada finalizada.<br>Puedes cerrar esta pestaña.',
    hangUp: 'Colgar',
    retry: 'Reintentar',
    permission: 'No tenemos permiso para usar la cámara y el micrófono. Acepta el permiso en el navegador y pulsa Reintentar.',
    noDevice: 'No se ha encontrado cámara o micrófono en este dispositivo.',
    busy: 'Otra aplicación está usando la cámara. Ciérrala y pulsa Reintentar.',
    generic: (detail) => `No se ha podido conectar: ${detail}. Si no funciona, llama a la clínica al ${PHONE}.`,
    moduleMissing: 'No se ha podido cargar el módulo de vídeo. Comprueba la conexión y pulsa Reintentar.',
    mute: 'Silenciar',
    unmute: 'Activar micrófono',
    cameraOn: 'Encender cámara',
    cameraOff: 'Apagar cámara',
  },
};

const en: Messages = {
  onboarding: [
    `Hi! I'm ${BOT_NAME}, a companion for patients going through IVF treatment. I help with medication reminders, appointments and practical questions, and I pass anything medical to your nurse.`,
    `I don't replace your medical team. To try a sample case, send /demo.`,
  ].join('\n\n'),
  welcomeBack: 'Hi again! How can I help you today?',
  unknownCommand: "I don't know that command. You can use /start, /demo or /reset, or just write to me.",
  resetDone: 'I have wiped the memory of this chat. Say "hi" to start again.',
  demoLoaded: (p) =>
    `Demo loaded. You are now Marta: stimulation day ${p.day}, ${p.drug} ${p.dose} at ${p.time}, ${p.appointmentType} on ${p.appointmentWhen}. Ask me anything; your first reminder arrives in about a minute.`,
  clinicalAck: (name) => `${name ? `${name}, I'm` : "I'm"} passing this to your nurse right now 👩‍⚕️. I'll write back as soon as she answers.`,
  urgentReply: (name, videoUrl) =>
    [
      `${name ? `${name}, thank` : 'Thank'} you for telling me; I'm here and you're not alone in this.`,
      `I'm alerting your nurse right now and she will see you by video call at this link: ${videoUrl}`,
      `If it gets worse, doesn't improve or you can't wait, call the clinic now at ${PHONE}.`,
    ].join('\n'),
  fallback: `I can't answer properly right now. I'm alerting your nurse. If it's urgent, call the clinic now: ${PHONE}.`,
  nurseSays: '👩‍⚕️ Your nurse says:',
  nurseWillWrite: (name) => `${name ? `${name}, your` : 'Your'} nurse has read your message and will write to you directly in a few minutes.`,
  videoInvite: (name, url) => `${name ? `${name}, your` : 'Your'} nurse wants to see you by video call now. Join from your phone or computer: ${url}`,
  callEnded: "Call ended. If you need anything else, I'm here.",
  callNote: (when, summary) => (summary ? `Video call with your nurse on ${when}. Summary: ${summary}` : `Video call with your nurse on ${when}.`),
  urgentNote: (videoUrl) => `Urgent case: the nurse was alerted, a video call was opened (${videoUrl}) and the clinic phone ${PHONE} was given.`,
  reminder: (name, item) => `💉 ${name ? `${name}, time` : 'Time'} for ${item.drug} ${item.dose} (${item.time}).`,
  demoReminder: (name, item) => `💉 ${name ? `${name}, time` : 'Time'} for ${item.drug} ${item.dose}. I'll remind you every day at ${item.time}.`,
  doseTakenButton: 'Done',
  doseQuestionButton: 'I have a question',
  doseTaken: (item) => (item ? `Noted 💉 ${item.drug} ${item.dose} at ${item.time}. Well done!` : 'Noted. Well done!'),
  doseQuestion: "Tell me, I'm listening. If it's about the dose or how you feel, I'll pass it to your nurse.",
  followUp: (name, about) =>
    `👩‍⚕️ ${name ? `${name}, ` : ''}how are you today?${about ? ` Yesterday we alerted your nurse about what you told me ("${about}").` : ''} If anything got worse or isn't improving, call the clinic at ${PHONE}.`,
  call: {
    title: 'Video call',
    patient: 'Patient',
    nurse: 'Nurse',
    waitingFor: (other) => `Waiting for ${other}…`,
    otherPatient: 'the patient',
    otherNurse: 'your nurse',
    connecting: 'Connecting…',
    connected: (other) => `Connected. Waiting for ${other}…`,
    inCall: 'In call',
    disconnected: 'Disconnected from the call.',
    ended: 'Call ended.<br>You can close this tab.',
    hangUp: 'Hang up',
    retry: 'Retry',
    permission: "We don't have permission to use the camera and microphone. Allow it in the browser and press Retry.",
    noDevice: 'No camera or microphone was found on this device.',
    busy: 'Another app is using the camera. Close it and press Retry.',
    generic: (detail) => `Could not connect: ${detail}. If it keeps failing, call the clinic at ${PHONE}.`,
    moduleMissing: 'The video module could not be loaded. Check your connection and press Retry.',
    mute: 'Mute',
    unmute: 'Unmute',
    cameraOn: 'Turn camera on',
    cameraOff: 'Turn camera off',
  },
};

export function messages(lang: Lang | undefined): Messages {
  return lang === 'en' ? en : es;
}

import { registerApiRoute } from '@mastra/core/server';
import { messages, type Lang } from '../i18n';
import { addNurseNote, patientLanguage } from '../memory/patient-memory';
import { notifyMake } from '../services/make';
import { postToPatient } from '../services/nurse';
import { getTicket, updateTicket } from '../services/tickets';
import { callCredentials, summarizeCall, type CallRole } from '../services/vonage';

const BOT_NAME = process.env.BOT_NAME ?? 'Lumi';

function roleFrom(value: string | undefined): CallRole {
  return value === 'nurse' ? 'nurse' : 'patient';
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c);
}

// One static page for both roles. The Vonage client SDK comes from Vonage's CDN;
// everything else is inline so the page needs nothing but this server.
function callPage(ticketId: string, role: CallRole, lang: Lang): string {
  const c = messages(lang).call;
  const you = role === 'nurse' ? c.nurse : c.patient;
  const other = role === 'nurse' ? c.otherPatient : c.otherNurse;
  return `<!doctype html>
<html lang="${lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${c.title} · ${escapeHtml(BOT_NAME)}</title>
<script src="https://video.standard.vonage.com/v2/js/opentok.min.js"></script>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  html, body { margin: 0; height: 100%; background: #0f1418; color: #eef2f4; font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
  body { display: flex; flex-direction: column; padding: env(safe-area-inset-top, 0) 0 env(safe-area-inset-bottom, 0); }
  header { padding: 12px 16px; font-size: 14px; color: #a9b4bb; display: flex; justify-content: space-between; align-items: center; }
  header strong { color: #eef2f4; }
  main { position: relative; flex: 1; min-height: 0; margin: 0 12px; border-radius: 14px; overflow: hidden; background: #000; }
  #remote, #remote > * { width: 100%; height: 100%; }
  #local { position: absolute; right: 12px; top: 12px; width: 30%; max-width: 160px; aspect-ratio: 3 / 4; border-radius: 10px; overflow: hidden; background: #1c2429; border: 2px solid rgba(255,255,255,.25); }
  #local > * { width: 100% !important; height: 100% !important; }
  #status { position: absolute; left: 0; right: 0; bottom: 0; padding: 12px 16px; font-size: 15px; text-align: center; background: linear-gradient(transparent, rgba(0,0,0,.75)); }
  #status.error { background: #7a1f1f; font-weight: 600; }
  footer { padding: 14px 16px calc(14px + env(safe-area-inset-bottom, 0)); display: flex; gap: 12px; justify-content: center; }
  button { font: inherit; font-size: 18px; font-weight: 700; padding: 16px 28px; border: 0; border-radius: 999px; cursor: pointer; min-width: 44%; }
  #hangup { background: #d63a3a; color: #fff; }
  #retry { background: #2b3a44; color: #fff; display: none; }
  .ended main { display: none; }
  .ended #done { display: block; }
  #done { display: none; flex: 1; align-items: center; justify-content: center; text-align: center; padding: 24px; font-size: 20px; line-height: 1.4; }
  .ended #done { display: flex; }
</style>
</head>
<body>
<header><span>${you} · ticket <strong>${escapeHtml(ticketId)}</strong></span><span id="peer">${c.waitingFor(other)}</span></header>
<main>
  <div id="remote"></div>
  <div id="local"></div>
  <div id="status">${c.connecting}</div>
</main>
<div id="done">${c.ended}</div>
<footer>
  <button id="retry">${c.retry}</button>
  <button id="hangup">${c.hangUp}</button>
</footer>
<script>
(function () {
  var ticketId = ${JSON.stringify(ticketId)};
  var role = ${JSON.stringify(role)};
  var statusEl = document.getElementById('status');
  var peerEl = document.getElementById('peer');
  var hangupBtn = document.getElementById('hangup');
  var retryBtn = document.getElementById('retry');
  var session = null, publisher = null, ended = false;
  var T = ${JSON.stringify({ permission: c.permission, noDevice: c.noDevice, busy: c.busy, moduleMissing: c.moduleMissing, connecting: c.connecting, connected: c.connected(other), waiting: c.waitingFor(other), inCall: c.inCall, disconnected: c.disconnected, genericPrefix: c.generic('__DETAIL__') })};

  function setStatus(text, isError) {
    statusEl.textContent = text;
    statusEl.className = isError ? 'error' : '';
    retryBtn.style.display = isError ? 'inline-block' : 'none';
  }

  function explain(err) {
    var name = (err && err.name) || '';
    if (/NotAllowed|Permission|OT_USER_MEDIA_ACCESS_DENIED/i.test(name) || /denied|permission/i.test(String(err && err.message))) return T.permission;
    if (/NotFound|OT_NO_DEVICES_FOUND/i.test(name)) return T.noDevice;
    if (/NotReadable|OT_HARDWARE_UNAVAILABLE/i.test(name)) return T.busy;
    return T.genericPrefix.replace('__DETAIL__', (err && err.message) || String(err));
  }

  async function start() {
    setStatus(T.connecting, false);
    if (!window.OT) { setStatus(T.moduleMissing, true); return; }
    var creds;
    try {
      var res = await fetch('/call/' + encodeURIComponent(ticketId) + '/credentials?role=' + role);
      creds = await res.json();
      if (!res.ok || !creds.ok) { setStatus(creds.reason || 'Videollamada no disponible.', true); return; }
    } catch (e) { setStatus(explain(e), true); return; }

    session = OT.initSession(creds.applicationId, creds.sessionId);
    session.on('streamCreated', function (event) {
      session.subscribe(event.stream, 'remote', { insertMode: 'replace', width: '100%', height: '100%' }, function (err) {
        if (err) setStatus(explain(err), true);
      });
      peerEl.textContent = T.inCall;
      setStatus('', false);
    });
    session.on('streamDestroyed', function () { peerEl.textContent = T.waiting; });
    session.on('sessionDisconnected', function () { if (!ended) setStatus(T.disconnected, true); });

    publisher = OT.initPublisher('local', { insertMode: 'replace', width: '100%', height: '100%', publishAudio: true, publishVideo: true, name: role }, function (err) {
      if (err) setStatus(explain(err), true);
    });
    publisher.on('accessDenied', function () { setStatus(explain({ name: 'NotAllowedError' }), true); });

    session.connect(creds.token, function (err) {
      if (err) { setStatus(explain(err), true); return; }
      session.publish(publisher, function (pubErr) {
        if (pubErr) setStatus(explain(pubErr), true);
        else setStatus(T.connected, false);
      });
    });
  }

  async function hangup() {
    if (ended) return;
    ended = true;
    try { if (publisher) publisher.destroy(); } catch (e) {}
    try { if (session) session.disconnect(); } catch (e) {}
    document.body.classList.add('ended');
    try {
      await fetch('/call/' + encodeURIComponent(ticketId) + '/ended', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ role: role }), keepalive: true });
    } catch (e) {}
  }

  hangupBtn.addEventListener('click', hangup);
  retryBtn.addEventListener('click', function () { try { if (session) session.disconnect(); } catch (e) {} start(); });
  window.addEventListener('pagehide', function () {
    if (ended) return;
    try { navigator.sendBeacon('/call/' + encodeURIComponent(ticketId) + '/ended', new Blob([JSON.stringify({ role: role, reason: 'pagehide' })], { type: 'application/json' })); } catch (e) {}
  });
  start();
})();
</script>
</body>
</html>`;
}

export const callPageRoute = registerApiRoute('/call/:ticketId', {
  method: 'GET',
  handler: async (c) => {
    const ticketId = c.req.param('ticketId');
    const role = roleFrom(c.req.query('role'));
    const ticket = await getTicket(ticketId).catch(() => null);
    const lang: Lang = role === 'nurse' ? 'es' : ticket ? await patientLanguage(ticket.chatId) : 'es';
    return c.html(callPage(ticketId, role, lang));
  },
});

export const callCredentialsRoute = registerApiRoute('/call/:ticketId/credentials', {
  method: 'GET',
  handler: async (c) => {
    const ticketId = c.req.param('ticketId');
    const role = roleFrom(c.req.query('role'));
    try {
      const creds = await callCredentials(ticketId, role);
      return c.json(creds, creds.ok ? 200 : 503);
    } catch (error) {
      c.get('mastra').getLogger().error('call credentials failed', { ticketId, role, error });
      return c.json({ ok: false, reason: 'No se ha podido preparar la videollamada.' }, 500);
    }
  },
});

// Either side hanging up closes the ticket once. Idempotent.
export const callEndedRoute = registerApiRoute('/call/:ticketId/ended', {
  method: 'POST',
  handler: async (c) => {
    const ticketId = c.req.param('ticketId');
    const logger = c.get('mastra').getLogger();
    const ticket = await getTicket(ticketId);
    if (!ticket) return c.json({ ok: false, reason: 'ticket not found' }, 404);
    if (ticket.callEndedAt) return c.json({ ok: true, already: true });
    const endedAt = new Date();
    await updateTicket(ticketId, { callEndedAt: endedAt.toISOString(), status: 'closed' });
    const when = new Intl.DateTimeFormat('es-ES', { timeZone: process.env.REMINDER_TIMEZONE || 'Europe/Madrid', dateStyle: 'long', timeStyle: 'short' }).format(endedAt);
    const summary = await summarizeCall(ticket).catch(() => null);
    const m = messages(await patientLanguage(ticket.chatId));
    await addNurseNote(ticket.chatId, { ticketId, question: ticket.message, reply: m.callNote(when, summary) }).catch((error: unknown) =>
      logger.warn('could not write call note', { ticketId, error: String(error) }),
    );
    const agent = c.get('mastra').getAgent('companion');
    const notified = await postToPatient(agent, ticket.chatId, m.callEnded);
    await notifyMake('call.ended', {
      ticketId: ticket.id,
      chatId: ticket.chatId,
      patientName: ticket.patientName ?? '',
      tier: ticket.tier,
      message: ticket.message,
      contextSummary: summary ?? ticket.contextSummary ?? '',
      createdAt: ticket.createdAt,
    });
    logger.info('video call ended', { ticketId, notified });
    return c.json({ ok: true, notified });
  },
});

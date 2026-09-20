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
<meta name="theme-color" content="#161A3A">
<title>${c.title} · ${escapeHtml(BOT_NAME)}</title>
<script src="https://video.standard.vonage.com/v2/js/opentok.min.js"></script>
<style>
  :root {
    color-scheme: dark;
    --ink: #161A3A; --ink-2: #0F1230; --well: #0B0E22;
    --peri: #9FA8E8; --aqua: #4FCFC9; --coral: #FF8B7B; --danger: #E8453C;
    --text: #F2F5EE; --muted: #A8AFD4;
    --glass: rgba(255,255,255,.08); --line: rgba(255,255,255,.16);
    --pad: 16px; --pip: clamp(92px, 21vw, 168px);
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; height: 100%; }
  body {
    min-height: 100svh; min-height: 100dvh;
    display: flex; flex-direction: column; overflow: hidden;
    color: var(--text);
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, Roboto, sans-serif;
    background:
      radial-gradient(1100px 620px at 78% -8%, rgba(79,207,201,.18), transparent 60%),
      radial-gradient(900px 560px at 8% 108%, rgba(159,168,232,.20), transparent 62%),
      linear-gradient(180deg, var(--ink) 0%, var(--ink-2) 100%);
    padding: env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left);
  }

  /* ---------- stage ---------- */
  .stage {
    position: relative; flex: 1; min-height: 0; margin: var(--pad);
    border-radius: 22px; overflow: hidden; background: var(--well);
    box-shadow: 0 30px 80px rgba(0,0,0,.55), inset 0 0 0 1px var(--line);
  }
  @media (max-width: 620px) { .stage { margin: 8px; border-radius: 18px; } :root { --pad: 12px; } }

  #remote { position: absolute; inset: 0; }
  #remote > * { width: 100% !important; height: 100% !important; }
  #remote video { width: 100% !important; height: 100% !important; object-fit: cover !important; background: var(--well); }
  /* Vonage injects its own name/button chrome; we draw our own. */
  .OT_bar, .OT_name, .OT_edge-bar-item, .OT_archiving-status { display: none !important; }

  /* ---------- self view ---------- */
  #local {
    position: absolute; top: 14px; right: 14px; z-index: 3;
    width: var(--pip); aspect-ratio: 3 / 4;
    border-radius: 16px; overflow: hidden; background: #11142C;
    box-shadow: 0 12px 30px rgba(0,0,0,.5), 0 0 0 1px rgba(255,255,255,.22);
    transition: opacity .25s ease;
  }
  @media (min-width: 900px) and (orientation: landscape) {
    :root { --pip: clamp(150px, 15vw, 240px); }
    #local { aspect-ratio: 4 / 3; }
  }
  #local > * { width: 100% !important; height: 100% !important; }
  #local video { width: 100% !important; height: 100% !important; object-fit: cover !important; transform: scaleX(-1); }
  body.cam-off #local { opacity: .4; }

  /* ---------- floating chips ---------- */
  .topbar {
    position: absolute; left: 14px; top: 14px; z-index: 4;
    display: flex; gap: 8px; align-items: center; flex-wrap: wrap;
    max-width: calc(100% - var(--pip) - 44px);
  }
  .chip {
    display: inline-flex; align-items: center; gap: 8px;
    padding: 8px 14px; border-radius: 999px; white-space: nowrap;
    font-size: 13px; color: var(--text);
    background: var(--glass); border: 1px solid var(--line);
    -webkit-backdrop-filter: blur(18px); backdrop-filter: blur(18px);
  }
  .chip .tid { color: var(--muted); font-variant-numeric: tabular-nums; }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--peri); animation: pulse 2.2s infinite; }
  body.connected .dot { background: var(--aqua); animation: none; box-shadow: 0 0 12px rgba(79,207,201,.9); }
  @keyframes pulse {
    0% { box-shadow: 0 0 0 0 rgba(159,168,232,.55); }
    70% { box-shadow: 0 0 0 10px rgba(159,168,232,0); }
    100% { box-shadow: 0 0 0 0 rgba(159,168,232,0); }
  }

  /* ---------- connecting / error overlay ---------- */
  .overlay {
    position: absolute; inset: 0; z-index: 2;
    display: flex; flex-direction: column; align-items: center; justify-content: center;
    gap: 20px; text-align: center; padding: 28px;
    background: radial-gradient(60% 60% at 50% 45%, rgba(22,26,58,.55), rgba(11,14,34,.88));
    -webkit-backdrop-filter: blur(3px); backdrop-filter: blur(3px);
    transition: opacity .3s ease, visibility .3s;
  }
  body.no-status .overlay { opacity: 0; visibility: hidden; }
  .orb {
    width: 96px; height: 96px; border-radius: 50%;
    background: radial-gradient(circle at 50% 42%, #FFFFFF 0%, var(--aqua) 34%, var(--peri) 74%);
    box-shadow: 0 0 44px rgba(79,207,201,.55), 0 0 90px rgba(159,168,232,.35);
    animation: breathe 3.4s ease-in-out infinite;
  }
  @keyframes breathe { 0%, 100% { transform: scale(1); opacity: .92; } 50% { transform: scale(1.06); opacity: 1; } }
  body.error .orb {
    background: radial-gradient(circle at 50% 42%, #FFFFFF 0%, var(--coral) 40%, var(--danger) 82%);
    box-shadow: 0 0 44px rgba(232,69,60,.5); animation: none;
  }
  .status { font-size: clamp(15px, 2.4vw, 19px); line-height: 1.45; max-width: 34ch; }
  body.error .status { color: #FFD9D4; }

  /* ---------- controls ---------- */
  .controls {
    position: relative; z-index: 5;
    display: flex; align-items: center; justify-content: center; gap: 14px;
    padding: 6px var(--pad) calc(var(--pad) + 6px); flex-wrap: wrap;
  }
  .btn {
    -webkit-appearance: none; appearance: none; font: inherit; cursor: pointer;
    width: 60px; height: 60px; border-radius: 50%;
    display: inline-grid; place-items: center;
    color: var(--text); background: var(--glass); border: 1px solid var(--line);
    -webkit-backdrop-filter: blur(18px); backdrop-filter: blur(18px);
    transition: transform .12s ease, background .2s ease, color .2s ease;
  }
  .btn:active { transform: scale(.94); }
  .btn:focus-visible { outline: 2px solid var(--aqua); outline-offset: 3px; }
  .btn.off { background: rgba(255,255,255,.92); color: var(--ink); border-color: transparent; }
  .btn.end {
    width: 72px; height: 72px; background: var(--danger); border-color: transparent;
    box-shadow: 0 12px 28px rgba(232,69,60,.45);
  }
  .btn svg { width: 26px; height: 26px; fill: none; stroke: currentColor; stroke-width: 1.9; stroke-linecap: round; stroke-linejoin: round; }
  .btn.end svg { width: 30px; height: 30px; }
  .btn .off-ic { display: none; }
  .btn.off .on-ic { display: none; }
  .btn.off .off-ic { display: block; }
  .ghost {
    display: none; font: inherit; font-size: 15px; font-weight: 600; cursor: pointer;
    padding: 14px 24px; border-radius: 999px; color: var(--text);
    background: var(--glass); border: 1px solid var(--line);
    -webkit-backdrop-filter: blur(18px); backdrop-filter: blur(18px);
  }
  body.error .ghost { display: inline-block; }

  /* ---------- ended ---------- */
  .done {
    display: none; flex: 1; flex-direction: column; align-items: center; justify-content: center;
    gap: 20px; text-align: center; padding: 28px;
    font-size: clamp(17px, 2.6vw, 21px); line-height: 1.5;
  }
  .done .orb { width: 64px; height: 64px; opacity: .55; animation: none; }
  body.ended .stage, body.ended .controls { display: none; }
  body.ended .done { display: flex; }

  @media (prefers-reduced-motion: reduce) { * { animation: none !important; transition: none !important; } }
</style>
</head>
<body class="no-status">
<div class="stage">
  <div id="remote"></div>
  <div id="local"></div>
  <div class="topbar">
    <span class="chip"><span class="dot"></span>${you} <span class="tid">· ${escapeHtml(ticketId)}</span></span>
    <span class="chip" id="peer">${c.waitingFor(other)}</span>
  </div>
  <div class="overlay">
    <div class="orb"></div>
    <div class="status" id="status">${c.connecting}</div>
  </div>
</div>

<div class="done"><div class="orb"></div><div>${c.ended}</div></div>

<div class="controls">
  <button class="btn" id="mic" type="button" aria-label="${c.mute}">
    <svg class="on-ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3a3 3 0 0 1 3 3v6a3 3 0 0 1-6 0V6a3 3 0 0 1 3-3z"/><path d="M5 11a7 7 0 0 0 14 0"/><path d="M12 18v3"/></svg>
    <svg class="off-ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3a3 3 0 0 1 3 3v6a3 3 0 0 1-6 0V6a3 3 0 0 1 3-3z"/><path d="M5 11a7 7 0 0 0 14 0"/><path d="M12 18v3"/><path d="M4 4l16 16"/></svg>
  </button>
  <button class="btn end" id="hangup" type="button" aria-label="${c.hangUp}">
    <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2.6 14.4c5.2-5.2 13.6-5.2 18.8 0l-2.2 2.2a1.6 1.6 0 0 1-2 .2l-2.2-1.4a1.6 1.6 0 0 1-.7-1.4v-1.4a12.4 12.4 0 0 0-4.6 0v1.4c0 .6-.3 1.1-.7 1.4l-2.2 1.4a1.6 1.6 0 0 1-2-.2z"/></svg>
  </button>
  <button class="btn" id="cam" type="button" aria-label="${c.cameraOff}">
    <svg class="on-ic" viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="6" width="11" height="12" rx="2.2"/><path d="M14 10.6l6-3.1v9l-6-3.1z"/></svg>
    <svg class="off-ic" viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="6" width="11" height="12" rx="2.2"/><path d="M14 10.6l6-3.1v9l-6-3.1z"/><path d="M4 4l16 16"/></svg>
  </button>
  <button class="ghost" id="retry" type="button">${c.retry}</button>
</div>

<script>
(function () {
  var ticketId = ${JSON.stringify(ticketId)};
  var role = ${JSON.stringify(role)};
  var body = document.body;
  var statusEl = document.getElementById('status');
  var peerEl = document.getElementById('peer');
  var hangupBtn = document.getElementById('hangup');
  var retryBtn = document.getElementById('retry');
  var micBtn = document.getElementById('mic');
  var camBtn = document.getElementById('cam');
  var session = null, publisher = null, ended = false, micOn = true, camOn = true;
  var T = ${JSON.stringify({
    permission: c.permission,
    noDevice: c.noDevice,
    busy: c.busy,
    moduleMissing: c.moduleMissing,
    connecting: c.connecting,
    connected: c.connected(other),
    waiting: c.waitingFor(other),
    inCall: c.inCall,
    disconnected: c.disconnected,
    genericPrefix: c.generic('__DETAIL__'),
    mute: c.mute,
    unmute: c.unmute,
    cameraOn: c.cameraOn,
    cameraOff: c.cameraOff,
  })};

  function setStatus(text, isError) {
    statusEl.textContent = text || '';
    body.classList.toggle('error', !!isError);
    body.classList.toggle('no-status', !text);
  }

  function explain(err) {
    var name = (err && err.name) || '';
    if (/NotAllowed|Permission|OT_USER_MEDIA_ACCESS_DENIED/i.test(name) || /denied|permission/i.test(String(err && err.message))) return T.permission;
    if (/NotFound|OT_NO_DEVICES_FOUND/i.test(name)) return T.noDevice;
    if (/NotReadable|OT_HARDWARE_UNAVAILABLE/i.test(name)) return T.busy;
    return T.genericPrefix.replace('__DETAIL__', (err && err.message) || String(err));
  }

  // Our own chrome is drawn in CSS; keep Vonage's out of the way.
  var otStyle = { buttonDisplayMode: 'off', nameDisplayMode: 'off', audioLevelDisplayMode: 'off', archiveStatusDisplayMode: 'off' };

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
      session.subscribe(event.stream, 'remote', { insertMode: 'replace', width: '100%', height: '100%', fitMode: 'cover', style: otStyle }, function (err) {
        if (err) setStatus(explain(err), true);
      });
      body.classList.add('connected');
      peerEl.textContent = T.inCall;
      setStatus('', false);
    });
    session.on('streamDestroyed', function () {
      body.classList.remove('connected');
      peerEl.textContent = T.waiting;
      if (!ended) setStatus(T.connected, false);
    });
    session.on('sessionDisconnected', function () { if (!ended) setStatus(T.disconnected, true); });

    publisher = OT.initPublisher('local', { insertMode: 'replace', width: '100%', height: '100%', fitMode: 'cover', style: otStyle, publishAudio: micOn, publishVideo: camOn, name: role }, function (err) {
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
    body.classList.add('ended');
    try {
      await fetch('/call/' + encodeURIComponent(ticketId) + '/ended', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ role: role }), keepalive: true });
    } catch (e) {}
  }

  micBtn.addEventListener('click', function () {
    if (!publisher) return;
    try { publisher.publishAudio(!micOn); } catch (e) { return; }
    micOn = !micOn;
    micBtn.classList.toggle('off', !micOn);
    micBtn.setAttribute('aria-label', micOn ? T.mute : T.unmute);
  });

  camBtn.addEventListener('click', function () {
    if (!publisher) return;
    try { publisher.publishVideo(!camOn); } catch (e) { return; }
    camOn = !camOn;
    camBtn.classList.toggle('off', !camOn);
    body.classList.toggle('cam-off', !camOn);
    camBtn.setAttribute('aria-label', camOn ? T.cameraOff : T.cameraOn);
  });

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

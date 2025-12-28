// index.js
require('dotenv').config();

const fs = require('fs');
const path = require('path');
const qrcode = require('qrcode-terminal');
const express = require('express');
const { Client, LocalAuth } = require('whatsapp-web.js');

/* ──────────────────────────────────────────────────────────────
 * 0) HARD SINGLE-INSTANCE LOCK
 * ────────────────────────────────────────────────────────────── */
const LOCK_FILE = path.join(process.cwd(), '.vicebot.lock');

function isPidAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function acquireLockOrExit() {
  try {
    if (fs.existsSync(LOCK_FILE)) {
      const prevPid = Number(String(fs.readFileSync(LOCK_FILE, 'utf8') || '').trim());
      if (isPidAlive(prevPid)) {
        console.error('❌ Ya hay una instancia de Vicebot corriendo.');
        console.error(`   PID: ${prevPid}`);
        console.error(`   Lock: ${LOCK_FILE}`);
        process.exit(1);
      } else {
        try { fs.unlinkSync(LOCK_FILE); } catch {}
      }
    }

    fs.writeFileSync(LOCK_FILE, String(process.pid), { flag: 'wx' });

    const cleanup = () => { try { fs.unlinkSync(LOCK_FILE); } catch {} };
    process.on('exit', cleanup);
    process.on('SIGINT', () => { cleanup(); process.exit(0); });
    process.on('SIGTERM', () => { cleanup(); process.exit(0); });
  } catch (e) {
    console.error('❌ No pude adquirir lock (otra instancia probable).', e?.message || e);
    process.exit(1);
  }
}
acquireLockOrExit();

/* ──────────────────────────────────────────────────────────────
 * 1) Monkeypatch LocalAuth.logout (EBUSY Windows)
 * ────────────────────────────────────────────────────────────── */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(function patchLocalAuthLogout() {
  if (!LocalAuth?.prototype?.logout) return;

  const originalLogout = LocalAuth.prototype.logout;

  LocalAuth.prototype.logout = async function patchedLogout() {
    const maxRetries = 6;
    const baseDelay = 400;

    for (let i = 0; i <= maxRetries; i++) {
      try {
        return await originalLogout.apply(this, arguments);
      } catch (e) {
        const msg = String(e?.message || e || '');
        const isEBUSY =
          msg.includes('EBUSY') ||
          msg.includes('resource busy') ||
          msg.includes('locked, unlink') ||
          (e && e.code === 'EBUSY');

        if (!isEBUSY) throw e;

        const wait = baseDelay * (i + 1);
        console.warn(`[WA][LocalAuth.logout] EBUSY al limpiar sesión. Reintento ${i + 1}/${maxRetries} en ${wait}ms…`);
        await sleep(wait);
      }
    }

    console.warn('[WA][LocalAuth.logout] No pude limpiar sesión por EBUSY. Continuo sin crashear.');
  };
})();

/* ──────────────────────────────────────────────────────────────
 * 2) Imports del bot
 * ────────────────────────────────────────────────────────────── */
// ✅ NOTA: El dedupe (hasMessageBeenHandled/markMessageHandled) se maneja en coreMessageRouter
const { handleIncomingMessage } = require('./modules/core/coreMessageRouter');

console.log('[BOOT] adminCommandRouter resolved:', require.resolve('./modules/core/adminCommandRouter'));
const { tryHandleAdminCommands } = require('./modules/core/adminCommandRouter');

const { attachDashboardApi } = require('./modules/dashboard/api');
const { attachCancelNotifyApi, handleDashboardCancelStatusChange } = require('./modules/dashboard/cancelNotify');
const { handleDashboardDoneStatusChange } = require('./modules/dashboard/doneNotify');
const { handleDashboardInProgressStatusChange } = require('./modules/dashboard/progressNotify');
const { sendFollowUpToGroups } = require('./modules/groups/groupRouter');

/* ──────────────────────────────────────────────────────────────
 * 3) Config
 * ────────────────────────────────────────────────────────────── */
const CATALOG_PATH =
  process.env.VICEBOT_CATALOG_PATH || path.join(process.cwd(), 'data', 'lugares.json');

const HTTP_PORT = Number(process.env.VICEBOT_HTTP_PORT || 3030);
const DEBUG = (process.env.VICEBOT_DEBUG || '1') === '1';

const WA_DIAG = (process.env.VICEBOT_WA_DIAG || '0') === '1';
const WA_HEADLESS = String(process.env.VICEBOT_WA_HEADLESS || '1') !== '0';
const CHROME_PATH = (process.env.VICEBOT_CHROME_PATH || '').trim() || null;

const WA_AUTORECONNECT = String(process.env.VICEBOT_WA_AUTORECONNECT || '1') !== '0';
const WA_WIPE_ON_LOGOUT = String(process.env.VICEBOT_WA_WIPE_ON_LOGOUT || '0') === '1';

const WA_RECONNECT_BASE_MS = parseInt(process.env.VICEBOT_WA_RECONNECT_BASE_MS || '1500', 10);
const WA_RECONNECT_MAX_MS  = parseInt(process.env.VICEBOT_WA_RECONNECT_MAX_MS  || '20000', 10);

const SESSION_PATH = path.join(process.cwd(), '.wwebjs_auth');
const CLIENT_ID = process.env.VICEBOT_WA_CLIENT_ID || 'vicebot-prod';

console.log('[BOOT] WA headless =', WA_HEADLESS ? 'true' : 'false');
if (WA_DIAG) console.log('[BOOT] WA_DIAG enabled');
if (WA_AUTORECONNECT) console.log('[BOOT] WA_AUTORECONNECT enabled');
if (WA_WIPE_ON_LOGOUT) console.log('[BOOT] WA_WIPE_ON_LOGOUT enabled');

/* ──────────────────────────────────────────────────────────────
 * 4) Helpers: errores típicos / wipe con retries (Windows)
 * ────────────────────────────────────────────────────────────── */
function isSessionClosedError(e) {
  const m = String(e?.message || e || '');
  return (
    m.includes('Session closed') ||
    m.includes('Protocol error') ||
    m.includes('Target closed') ||
    m.includes('Execution context was destroyed')
  );
}

function isEbusyError(e) {
  const m = String(e?.message || e || '');
  return (
    m.includes('EBUSY') ||
    m.includes('resource busy') ||
    m.includes('locked, unlink') ||
    (e && e.code === 'EBUSY')
  );
}

// Wipe robusto: intenta rmSync; si EBUSY, espera y reintenta.
// Importante: se llama DESPUÉS de client.destroy() + pequeña pausa.
async function wipeLocalAuthSessionWithRetries() {
  const dir = SESSION_PATH;
  const max = 10;
  const base = 250;

  for (let i = 1; i <= max; i++) {
    try {
      if (fs.existsSync(dir)) {
        fs.rmSync(dir, { recursive: true, force: true });
      }
      console.warn('[WA] LocalAuth session wiped:', dir);
      return true;
    } catch (e) {
      if (!isEbusyError(e)) {
        console.warn('[WA] wipe failed (non-EBUSY):', e?.message || e);
        return false;
      }
      const wait = base * i;
      console.warn(`[WA] wipe EBUSY, retry ${i}/${max} in ${wait}ms…`);
      await sleep(wait);
    }
  }

  console.warn('[WA] wipe gave up (EBUSY). Consider closing Chrome/WhatsApp Desktop and retry.');
  return false;
}

function computeBackoffMs(attempt) {
  const ms = Math.min(WA_RECONNECT_BASE_MS * Math.pow(2, Math.max(0, attempt - 1)), WA_RECONNECT_MAX_MS);
  const jitter = Math.floor(Math.random() * 300);
  return ms + jitter;
}

function logListenerCounts(c) {
  try {
    console.log('[WA] listeners:', {
      message: c.listenerCount('message'),
      ready: c.listenerCount('ready'),
      qr: c.listenerCount('qr'),
      authenticated: c.listenerCount('authenticated'),
      disconnected: c.listenerCount('disconnected'),
    });
  } catch {}
}

/* ──────────────────────────────────────────────────────────────
 * 5) Estado global WA / guards
 * ────────────────────────────────────────────────────────────── */
let client = null;

let shuttingDown = false;
let restarting = false; // ✅ NUEVO: evita carreras durante LOGOUT/reinit

let WA_CONNECTED = false;
let WA_READY = false;

let initInFlight = false;
let restartTimer = null;
let restartAttempt = 0;

async function safeReply(msg, text) {
  if (!msg) return false;
  if (shuttingDown || restarting || !WA_CONNECTED) return false;
  try {
    await msg.reply(text);
    return true;
  } catch (e) {
    if (isSessionClosedError(e)) {
      if (WA_DIAG) console.warn('[SAFE-REPLY] skip: session/page closed');
      return false;
    }
    throw e;
  }
}

/* ──────────────────────────────────────────────────────────────
 * 6) Crear un cliente WA (factory)
 * ────────────────────────────────────────────────────────────── */
function createWaClient() {
  const auth = new LocalAuth({ dataPath: SESSION_PATH, clientId: CLIENT_ID });

  const puppeteerCfg = {
    headless: WA_HEADLESS,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--no-first-run',
    ],
  };
  if (CHROME_PATH) puppeteerCfg.executablePath = CHROME_PATH;

  const c = new Client({
    authStrategy: auth,
    puppeteer: puppeteerCfg,

    // ✅ reduce conflictos / “takeover” raros
    takeoverOnConflict: true,
    takeoverTimeoutMs: 5000,

    // ✅ evita loops eternos de QR si algo falla
    qrMaxRetries: 5,
    authTimeoutMs: 0, // 0 = sin timeout corto (en algunas redes tarda)
  });


  const isFromMe = (m) => Boolean(m.fromMe);
  const isStatusBroadcast = (m) => m.from === 'status@broadcast';

  let seenReady = false;

  c.on('qr', (qr) => {
    console.log('[LOAD] Escanea el QR (si ya tienes sesión, no aparecerá)…');
    qrcode.generate(qr, { small: true });

    if (WA_DIAG) {
      console.log('[WA][DIAG] QR emitted at', new Date().toISOString());
      logListenerCounts(c);
    }
  });

  c.on('authenticated', () => {
    WA_CONNECTED = true;
    console.log('🔐 SESIÓN INICIADA (authenticated)');

    if (WA_DIAG) {
      console.log('[WA][DIAG] authenticated at', new Date().toISOString());
      logListenerCounts(c);
    }
  });

  c.on('auth_failure', (msg) => {
    console.error('❌ AUTH FAILURE:', msg);
  });

  c.on('ready', () => {
    WA_CONNECTED = true;
    WA_READY = true;

    if (!seenReady) {
      seenReady = true;
      console.log('✅ READY — BOT N-I activo');
    } else {
      console.warn('⚠️ [WARN] READY emitido de nuevo (reinit/reconnect interno).');
    }

    // ✅ si llegó a READY, resetea backoff
    restartAttempt = 0;

    if (WA_DIAG) {
      console.log('[WA][DIAG] ready at', new Date().toISOString());
      logListenerCounts(c);
    }
  });

  // logs opcionales
  c.on('change_state', (state) => { if (WA_DIAG) console.log('🧭 [WA] change_state:', state); });
  c.on('loading_screen', (pct, msg) => { if (WA_DIAG) console.log('⏳ [WA] loading_screen:', pct, msg); });

  c.on('disconnected', async (reason) => {
    // 🔥 Esta parte es clave en tu bug:
    // el LOGOUT dispara varias veces; sólo atendemos una vez.
    if (restarting || shuttingDown) {
      if (WA_DIAG) console.warn('[WA] disconnected ignored (restarting/shuttingDown). reason=', reason);
      return;
    }

    WA_CONNECTED = false;
    WA_READY = false;

    console.log('🔌 Disconnected:', reason);

    if (!WA_AUTORECONNECT) return;

    // Para LOGOUT vamos a reiniciar "duro"
    scheduleRestart(String(reason || 'unknown'));
  });

  c.on('message', async (msg) => {
    if (!msg) return;
    if (shuttingDown || restarting || !WA_CONNECTED) {
      if (DEBUG) console.log('[INDEX] skip message: shuttingDown/restarting/not connected');
      return;
    }
    if (isFromMe(msg) || isStatusBroadcast(msg)) return;

    // ✅ NOTA: El dedupe de mensajes se maneja en coreMessageRouter
    // NO marcar aquí para evitar doble marcado

    const body = (msg.body || '').trim();
    if (DEBUG) console.log('[MSG] in', { chatId: msg.from, body: body || '(vacío / media)' });

    try {
      if (body.startsWith('/')) {
        const handledCmd = await tryHandleAdminCommands(c, msg);
        if (!handledCmd) {
          await safeReply(
            msg,
            '⚠️ No reconozco ese comando.\n' +
              'Usa:\n' +
              '• `/ayuda`\n' +
              '• `/tickets`\n' +
              (process.env.ADMINS ? '• `/helpadmin` (admin)\n' : '')
          );
        }
        return;
      }

      await handleIncomingMessage(c, msg, { catalogPath: CATALOG_PATH });
    } catch (err) {
      console.error('[ERROR] message handler:', err);
      try { await safeReply(msg, '⚠️ Ocurrió un problema al procesar tu mensaje. ¿Puedes intentarlo de nuevo?'); } catch {}
    }
  });

  return c;
}

/* ──────────────────────────────────────────────────────────────
 * 7) Init + Restart controlado (anti-EBUSY + anti-session-closed)
 * ────────────────────────────────────────────────────────────── */
async function initWhatsApp() {
  if (initInFlight) return;
  initInFlight = true;

  try {
    if (client) {
      try { client.removeAllListeners(); } catch {}
      try { await client.destroy(); } catch {}
      client = null;
    }

    client = createWaClient();
    await client.initialize();
  } catch (e) {
    console.error('[WA] initialize failed:', e?.message || e);
    scheduleRestart('init_failed');
  } finally {
    initInFlight = false;
  }
}

function scheduleRestart(reason) {
  if (shuttingDown) return;
  if (restartTimer) return;          // ya hay uno programado
  if (restarting) return;            // ya estamos reiniciando

  restartAttempt += 1;
  const wait = computeBackoffMs(restartAttempt);

  console.warn(`[WA] restart scheduled in ${wait}ms (attempt ${restartAttempt}) reason=${reason}`);

  restartTimer = setTimeout(async () => {
    restartTimer = null;

    if (shuttingDown) return;

    // ✅ REINICIO “DURO” EN ORDEN: destroy -> pausa -> wipe (si aplica) -> init
    restarting = true;
    WA_CONNECTED = false;
    WA_READY = false;

    const upperReason = String(reason || '').toUpperCase();

    try {
      if (client) {
        try { client.removeAllListeners(); } catch {}
        try { await client.destroy(); } catch {}
      }
    } catch (e) {
      console.warn('[WA] destroy err during restart:', e?.message || e);
    }

    client = null;

    // Pausa para que Chromium suelte handles
    await sleep(700);

    if (upperReason.includes('LOGOUT') && WA_WIPE_ON_LOGOUT) {
      await wipeLocalAuthSessionWithRetries();
      // otra pausa breve
      await sleep(400);
    }

    restarting = false;
    await initWhatsApp();
  }, wait);
}

/* ──────────────────────────────────────────────────────────────
 * 8) HTTP/Dashboard
 * ────────────────────────────────────────────────────────────── */
const app = express();
app.use(express.json());

attachDashboardApi(app, {
  basePath: '/api',
  onStatusChange: async ({ incidentId, newStatus, by, reason, note }) => {
    try {
      if (newStatus === 'canceled') {
        await handleDashboardCancelStatusChange({ client, incidentId, reason, by, sendFollowUpToGroups });
      } else if (newStatus === 'done') {
        await handleDashboardDoneStatusChange({ client, incidentId, by, note, sendFollowUpToGroups });
      } else if (newStatus === 'in_progress') {
        await handleDashboardInProgressStatusChange({ client, incidentId, by, note, sendFollowUpToGroups });
      }
    } catch (e) {
      console.warn('[HOOK] onStatusChange error:', e?.message || e);
    }
  },
});

attachCancelNotifyApi(app, { client, sendFollowUpToGroups });

const ATTACH_ROOT = process.env.VICEBOT_ATTACH_ROOT || path.join(process.cwd(), 'data', 'attachments');
fs.mkdirSync(ATTACH_ROOT, { recursive: true });
app.use('/attachments', express.static(ATTACH_ROOT));

const PUBLIC_DIR = path.join(process.cwd(), 'public');
app.use(
  express.static(PUBLIC_DIR, {
    etag: false,
    lastModified: false,
    maxAge: 0,
    setHeaders: (res) => res.set('Cache-control', 'no-store'),
  })
);

app.get('/dashboard', (_req, res) => {
  const modern = path.join(PUBLIC_DIR, 'dashboard', 'index.html');
  const legacy = path.join(PUBLIC_DIR, 'dashboard.html');
  res.sendFile(fs.existsSync(modern) ? modern : legacy);
});

app.get('/api/health', (_req, res) => res.json({ ok: true }));

const httpServer = app.listen(HTTP_PORT, () => {
  console.log(`[HTTP] Dashboard on http://localhost:${HTTP_PORT}/dashboard`);
});

/* ──────────────────────────────────────────────────────────────
 * 9) Boot WA
 * ────────────────────────────────────────────────────────────── */
initWhatsApp().catch((e) => {
  console.error('[FATAL] initWhatsApp failed:', e?.message || e);
  process.exit(1);
});

/* ──────────────────────────────────────────────────────────────
 * 10) Shutdown + anti-crash
 * ────────────────────────────────────────────────────────────── */
async function gracefulExit(code = 0) {
  if (shuttingDown) process.exit(code);
  shuttingDown = true;

  WA_CONNECTED = false;
  WA_READY = false;

  console.log('🧹 Cerrando…');

  try { if (restartTimer) clearTimeout(restartTimer); } catch {}
  restartTimer = null;

  try { httpServer.close(); } catch {}

  try {
    if (client) {
      try { client.removeAllListeners(); } catch {}
      await client.destroy();
    }
  } catch {}

  try { fs.unlinkSync(LOCK_FILE); } catch {}
  setTimeout(() => process.exit(code), 400);
}

process.on('SIGINT', () => gracefulExit(0));
process.on('SIGTERM', () => gracefulExit(0));

// ✅ CLAVE: durante reinicio, estas “Session closed” NO deben tumbarte
process.on('unhandledRejection', (e) => {
  const msg = String(e?.message || e || '');
  if (restarting && isSessionClosedError(e)) {
    if (WA_DIAG) console.warn('[unhandledRejection] ignored during restart:', msg);
    return;
  }
  if (isSessionClosedError(e)) {
    console.warn('[WARN] unhandledRejection (session closed). Scheduling restart…');
    scheduleRestart('session_closed_unhandled');
    return;
  }
  console.error('[FATAL] unhandledRejection:', msg);
});

process.on('uncaughtException', (e) => {
  const msg = String(e?.message || e || '');
  console.error('[FATAL] uncaughtException:', msg);

  // mismo criterio: si estamos reiniciando y es "session closed", no mates todo
  if (restarting && msg.includes('Session closed')) {
    if (WA_DIAG) console.warn('[uncaughtException] ignored during restart:', msg);
    return;
  }

  if (msg.includes('EBUSY') && msg.includes('Cookies-journal')) {
    console.warn('[FATAL] EBUSY en Cookies-journal detectado. Saliendo limpio…');
    return gracefulExit(1);
  }

  process.exit(1);
});
// index.js
require('dotenv').config();

const fs = require('fs');
const path = require('path');
const qrcode = require('qrcode-terminal');
const express = require('express');
const { Client, LocalAuth } = require('whatsapp-web.js');

/* ──────────────────────────────────────────────────────────────
 * 0) HARD SINGLE-INSTANCE LOCK (DESHABILITADO - bug en Windows)
 * ────────────────────────────────────────────────────────────── */
/*
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
*/

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
const { handleIncomingMessage } = require('./modules/core/coreMessageRouter');

console.log('[BOOT] adminCommandRouter resolved:', require.resolve('./modules/core/adminCommandRouter'));
const { tryHandleAdminCommands } = require('./modules/core/adminCommandRouter');

const { sendFollowUpToGroups, safeSendMessage, loadGroupsConfig, resolveTargetGroups } = require('./modules/groups/groupRouter');

// Notificaciones al solicitante
const { sendDM } = require('./modules/notify/requesterDM');

// DB para obtener info de incidencias
const incidenceDB = require('./modules/db/incidenceDB');

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

// Health check config
const WA_HEALTH_CHECK_INTERVAL = parseInt(process.env.VICEBOT_WA_HEALTH_CHECK_MS || '45000', 10);
const WA_HEALTH_CHECK_TIMEOUT = parseInt(process.env.VICEBOT_WA_HEALTH_TIMEOUT_MS || '15000', 10);
const WA_HEALTH_CHECK_FAILURES_BEFORE_RESTART = parseInt(process.env.VICEBOT_WA_HEALTH_FAILURES || '2', 10);

// Dashboard notification config
const DASHBOARD_WEBHOOK_URL = process.env.VICEBOT_DASHBOARD_WEBHOOK_URL || 'http://localhost:3031/api/webhook/notify';
const DASHBOARD_WEBHOOK_TOKEN = process.env.VICEBOT_DASHBOARD_WEBHOOK_TOKEN || null;

const SESSION_PATH = path.join(process.cwd(), '.wwebjs_auth');
const CLIENT_ID = process.env.VICEBOT_WA_CLIENT_ID || 'vicebot-prod';

console.log('[BOOT] WA headless =', WA_HEADLESS ? 'true' : 'false');
if (WA_DIAG) console.log('[BOOT] WA_DIAG enabled');
if (WA_AUTORECONNECT) console.log('[BOOT] WA_AUTORECONNECT enabled');
if (WA_WIPE_ON_LOGOUT) console.log('[BOOT] WA_WIPE_ON_LOGOUT enabled');
console.log(`[BOOT] Health check: every ${WA_HEALTH_CHECK_INTERVAL}ms, timeout ${WA_HEALTH_CHECK_TIMEOUT}ms`);
console.log(`[BOOT] Dashboard webhook: ${DASHBOARD_WEBHOOK_URL}`);

/**
 * Notifica al dashboard sobre cambios en incidencias
 * No bloquea ni falla si el dashboard no está disponible
 */
async function notifyDashboard(payload) {
  try {
    const headers = { 'Content-Type': 'application/json' };
    if (DASHBOARD_WEBHOOK_TOKEN) {
      headers['Authorization'] = `Bearer ${DASHBOARD_WEBHOOK_TOKEN}`;
    }
    
    const res = await fetch(DASHBOARD_WEBHOOK_URL, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(3000) // 3s timeout
    });
    
    if (DEBUG && res.ok) {
      const data = await res.json().catch(() => ({}));
      console.log(`[DASH-NOTIFY] OK (${data.clients || 0} clients):`, payload.type);
    }
  } catch (e) {
    // Silencioso - el dashboard puede no estar corriendo
    if (DEBUG) console.log('[DASH-NOTIFY] Skip:', e?.message || 'no response');
  }
}

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
let restarting = false;

let WA_CONNECTED = false;
let WA_READY = false;

let initInFlight = false;
let restartTimer = null;
let restartAttempt = 0;

// Health check state
let healthCheckInterval = null;
let healthCheckFailures = 0;
let lastSuccessfulPing = Date.now();

async function safeReply(msg, text) {
  if (!msg) return false;
  if (shuttingDown || restarting || !WA_CONNECTED) return false;
  try {
    await msg.reply(text, undefined, { sendSeen: false });
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
 * 5.5) HEALTH CHECK ACTIVO
 * ────────────────────────────────────────────────────────────── */
async function performHealthCheck() {
  if (shuttingDown || restarting || initInFlight) {
    return;
  }
  
  if (!client || !WA_READY) {
    if (WA_DIAG) console.log('[HEALTH] Skip: client not ready');
    return;
  }
  
  try {
    const statePromise = client.getState();
    const timeoutPromise = new Promise((_, reject) => 
      setTimeout(() => reject(new Error('Health check timeout')), WA_HEALTH_CHECK_TIMEOUT)
    );
    
    const state = await Promise.race([statePromise, timeoutPromise]);
    
    if (state === 'CONNECTED') {
      if (healthCheckFailures > 0) {
        console.log(`[HEALTH] ✅ Connection restored after ${healthCheckFailures} failures`);
      }
      healthCheckFailures = 0;
      lastSuccessfulPing = Date.now();
      
      if (WA_DIAG) {
        console.log('[HEALTH] ✅ OK -', state);
      }
    } else {
      console.warn(`[HEALTH] ⚠️ State is ${state}, not CONNECTED`);
      handleHealthCheckFailure(`state_${state}`);
    }
  } catch (e) {
    const msg = e?.message || String(e);
    console.warn(`[HEALTH] ❌ Check failed: ${msg}`);
    handleHealthCheckFailure(msg);
  }
}

function handleHealthCheckFailure(reason) {
  healthCheckFailures++;
  
  const timeSinceLastSuccess = Date.now() - lastSuccessfulPing;
  
  console.warn(`[HEALTH] Failure ${healthCheckFailures}/${WA_HEALTH_CHECK_FAILURES_BEFORE_RESTART}` +
    ` (${Math.round(timeSinceLastSuccess / 1000)}s since last success)`);
  
  if (healthCheckFailures >= WA_HEALTH_CHECK_FAILURES_BEFORE_RESTART) {
    console.error(`[HEALTH] ❌ ${healthCheckFailures} consecutive failures - triggering restart`);
    
    WA_CONNECTED = false;
    WA_READY = false;
    healthCheckFailures = 0;
    
    scheduleRestart(`health_check_failed: ${reason}`);
  }
}

function startHealthCheck() {
  stopHealthCheck();
  
  console.log(`[HEALTH] Starting health check (interval: ${WA_HEALTH_CHECK_INTERVAL}ms)`);
  
  healthCheckFailures = 0;
  lastSuccessfulPing = Date.now();
  
  healthCheckInterval = setInterval(performHealthCheck, WA_HEALTH_CHECK_INTERVAL);
  setTimeout(performHealthCheck, 5000);
}

function stopHealthCheck() {
  if (healthCheckInterval) {
    clearInterval(healthCheckInterval);
    healthCheckInterval = null;
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

    takeoverOnConflict: true,
    takeoverTimeoutMs: 5000,
    qrMaxRetries: 5,
    authTimeoutMs: 0,

    webVersionCache: {
      type: 'remote',
      remotePath: process.env.VICEBOT_WA_WEB_CACHE_URL
        || 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.2412.54.html',
    },
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

    restartAttempt = 0;
    startHealthCheck();

    if (WA_DIAG) {
      console.log('[WA][DIAG] ready at', new Date().toISOString());
      logListenerCounts(c);
    }
  });

  c.on('change_state', (state) => { 
    if (WA_DIAG) console.log('🧭 [WA] change_state:', state); 
    
    if (state === 'CONNECTED') {
      healthCheckFailures = 0;
      lastSuccessfulPing = Date.now();
    }
  });
  
  c.on('loading_screen', (pct, msg) => { if (WA_DIAG) console.log('⏳ [WA] loading_screen:', pct, msg); });

  c.on('disconnected', async (reason) => {
    if (restarting || shuttingDown) {
      if (WA_DIAG) console.warn('[WA] disconnected ignored (restarting/shuttingDown). reason=', reason);
      return;
    }

    WA_CONNECTED = false;
    WA_READY = false;
    stopHealthCheck();

    console.log('🔌 Disconnected:', reason);

    if (!WA_AUTORECONNECT) return;
    scheduleRestart(String(reason || 'unknown'));
  });

  c.on('message', async (msg) => {
    if (!msg) return;
    if (shuttingDown || restarting || !WA_CONNECTED) {
      if (DEBUG) console.log('[INDEX] skip message: shuttingDown/restarting/not connected');
      return;
    }
    if (isFromMe(msg) || isStatusBroadcast(msg)) return;

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
  stopHealthCheck();

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
  if (restartTimer) return;
  if (restarting) return;

  restartAttempt += 1;
  const wait = computeBackoffMs(restartAttempt);

  console.warn(`[WA] restart scheduled in ${wait}ms (attempt ${restartAttempt}) reason=${reason}`);

  restartTimer = setTimeout(async () => {
    restartTimer = null;

    if (shuttingDown) return;

    restarting = true;
    WA_CONNECTED = false;
    WA_READY = false;
    stopHealthCheck();

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
    await sleep(700);

    if (upperReason.includes('LOGOUT') && WA_WIPE_ON_LOGOUT) {
      await wipeLocalAuthSessionWithRetries();
      await sleep(400);
    }

    restarting = false;
    await initWhatsApp();
  }, wait);
}

/* ──────────────────────────────────────────────────────────────
 * 8) HTTP Server (mínimo, sin dashboard)
 * ────────────────────────────────────────────────────────────── */
const app = express();
app.use(express.json());

// Servir attachments
const ATTACH_ROOT = process.env.VICEBOT_ATTACH_ROOT || path.join(process.cwd(), 'data', 'attachments');
fs.mkdirSync(ATTACH_ROOT, { recursive: true });
app.use('/attachments', express.static(ATTACH_ROOT));

// Health check básico
app.get('/api/health', (_req, res) => res.json({ ok: true }));

// Estado de WhatsApp
app.get('/api/wa-status', (_req, res) => {
  res.json({
    connected: WA_CONNECTED,
    ready: WA_READY,
    restarting,
    healthCheck: {
      failures: healthCheckFailures,
      lastSuccessfulPing: lastSuccessfulPing,
      timeSinceLastSuccess: Date.now() - lastSuccessfulPing,
    },
    restartAttempt,
  });
});

// Endpoint interno para que módulos notifiquen cambios al dashboard
// Uso: POST /api/internal/notify-dashboard { type, incidentId, folio, status, ... }
app.post('/api/internal/notify-dashboard', (req, res) => {
  const payload = req.body || {};
  if (!payload.type) {
    return res.status(400).json({ error: 'missing_type' });
  }
  
  // Notificar de forma asíncrona
  notifyDashboard(payload);
  
  res.json({ ok: true, queued: true });
});

/* ──────────────────────────────────────────────────────────────
 * WEBHOOK: Recibir cambios de estado desde el Dashboard
 * Envía notificaciones por WhatsApp a grupos y solicitante
 * ────────────────────────────────────────────────────────────── */
app.post('/api/webhook/status-change', async (req, res) => {
  const { incidentId, folio, from, to, source } = req.body || {};
  
  if (!incidentId || !to) {
    return res.status(400).json({ error: 'missing_fields', required: ['incidentId', 'to'] });
  }
  
  // Solo procesar si viene del dashboard
  if (source !== 'dashboard') {
    return res.json({ ok: true, skipped: true, reason: 'not_from_dashboard' });
  }
  
  console.log(`[WEBHOOK] Status change from dashboard: ${folio || incidentId} ${from} → ${to}`);
  
  // Verificar que WhatsApp está conectado
  if (!WA_CONNECTED || !WA_READY || !client) {
    console.warn('[WEBHOOK] WhatsApp not connected, skipping notifications');
    return res.json({ ok: false, error: 'whatsapp_not_connected' });
  }
  
  try {
    // Obtener info completa del incidente
    const incident = await incidenceDB.getIncidentById(incidentId);
    if (!incident) {
      return res.status(404).json({ error: 'incident_not_found' });
    }
    
    const results = { groups: null, requester: null };
    const incFolio = incident.folio || folio || `INC-${incidentId.slice(0, 6)}`;
    
    // ─────────────────────────────────────────────────────────────
    // 1. Notificar a los GRUPOS según el cambio de estado
    // ─────────────────────────────────────────────────────────────
    const cfg = await loadGroupsConfig();
    const areasJson = (() => {
      try { return JSON.parse(incident.areas_json || '[]'); } catch { return []; }
    })();
    
    const { primaryId, ccIds } = resolveTargetGroups(
      { area_destino: incident.area_destino, areas: areasJson },
      cfg
    );
    
    // Mapeo de estados a mensajes para grupos
    const groupMessages = {
      'in_progress': `🔧 *${incFolio}* — El ticket fue tomado desde el panel de control.`,
      'done': `✅ *${incFolio}* — Completado.`,
      'canceled': `❌ *${incFolio}* — Ticket cancelado desde el panel de control.`,
      'open': `🔄 *${incFolio}* — Ticket reabierto desde el panel de control.`,
    };
    
    const groupMsg = groupMessages[to];
    
    if (groupMsg && primaryId) {
      const allGroups = [primaryId, ...(ccIds || [])];
      const sent = [];
      const errors = [];
      
      for (const gid of allGroups) {
        try {
          const r = await safeSendMessage(client, gid, groupMsg);
          if (r.ok) sent.push(gid);
          else errors.push({ gid, error: r.error });
        } catch (e) {
          errors.push({ gid, error: e?.message });
        }
      }
      
      results.groups = { sent: sent.length, errors: errors.length, details: errors };
      if (DEBUG) console.log(`[WEBHOOK] Groups notified: ${sent.length} ok, ${errors.length} errors`);
    }
    
    // ─────────────────────────────────────────────────────────────
    // 2. Notificar al SOLICITANTE según el cambio de estado
    // ─────────────────────────────────────────────────────────────
    const dmKindMap = {
      'in_progress': 'ack_start',
      'done': 'done',
      'open': 'reopened',
    };
    
    const dmKind = dmKindMap[to];
    
    if (dmKind) {
      const dmResult = await sendDM({
        client,
        incident,
        kind: dmKind,
        data: { area: incident.area_destino }
      });
      
      results.requester = dmResult;
      if (DEBUG) console.log(`[WEBHOOK] Requester DM (${dmKind}):`, dmResult.ok ? 'sent' : dmResult.reason);
    }
    
    res.json({ 
      ok: true, 
      incidentId, 
      folio: incFolio,
      from, 
      to,
      notifications: results 
    });
    
  } catch (e) {
    console.error('[WEBHOOK] Error processing status change:', e);
    res.status(500).json({ error: 'internal_error', message: e?.message });
  }
});

/* ──────────────────────────────────────────────────────────────
 * WEBHOOK: Recibir comentarios desde el Dashboard
 * Guarda el comentario en la BD y lo envía por WhatsApp
 * ────────────────────────────────────────────────────────────── */
app.post('/api/webhook/comment', async (req, res) => {
  const { incidentId, folio, chat_id, area_destino, text, source } = req.body || {};
  
  if (!incidentId || !text) {
    return res.status(400).json({ error: 'missing_fields', required: ['incidentId', 'text'] });
  }
  
  // Solo procesar si viene del dashboard
  if (source !== 'dashboard') {
    return res.json({ ok: true, skipped: true, reason: 'not_from_dashboard' });
  }
  
  console.log(`[WEBHOOK] Comment from dashboard: ${folio || incidentId}`);
  
  try {
    const results = { groups: null, requester: null, saved: false };
    const incFolio = folio || `INC-${incidentId.slice(0, 6)}`;

    // ✅ FIX: definir commentMsg (antes se usaba sin existir)
    const commentMsg = `💬 *${incFolio}* — Comentario desde panel:\n\n${text}`;
    
    // ─────────────────────────────────────────────────────────────
    // 1. GUARDAR el comentario en la BD (como EVENTO estándar)
    // ─────────────────────────────────────────────────────────────
    try {
      // appendIncidentEvent NO es async en tu DB; no hace falta await
      incidenceDB.appendIncidentEvent(incidentId, {
        event_type: 'comment_text',
        wa_msg_id: null,
        payload: {
          text,
          by: 'dashboard',
          source: 'dashboard'
        }
      });

      results.saved = true;
      if (DEBUG) console.log(`[WEBHOOK] Comment saved to DB for ${incFolio}`);
    } catch (dbErr) {
      console.error(`[WEBHOOK] Failed to save comment to DB:`, dbErr?.message || dbErr);
      // Continuamos para intentar enviar por WhatsApp aunque falle el guardado
    }

    // ✅ (opcional, pero conservador): si WA no está listo, no intentes enviar
    if (!WA_CONNECTED || !WA_READY || !client) {
      console.warn('[WEBHOOK] WhatsApp not connected, comment saved but not sent');
      return res.json({ 
        ok: true, 
        incidentId, 
        folio: incFolio,
        notifications: results,
        warning: 'whatsapp_not_connected'
      });
    }
    
    // ─────────────────────────────────────────────────────────────
    // 2. Enviar al GRUPO correspondiente
    // ─────────────────────────────────────────────────────────────
    const cfg = await loadGroupsConfig();
    const { primaryId } = resolveTargetGroups({ area_destino: area_destino, areas: [] }, cfg);
    
    if (primaryId) {
      try {
        const r = await safeSendMessage(client, primaryId, commentMsg);
        results.groups = { ok: r.ok, error: r.error || null };
        if (DEBUG) console.log(`[WEBHOOK] Comment to group: ${r.ok ? 'sent' : r.error}`);
      } catch (e) {
        results.groups = { ok: false, error: e?.message };
      }
    }
    
    // ─────────────────────────────────────────────────────────────
    // 3. Enviar al SOLICITANTE
    // ─────────────────────────────────────────────────────────────
    if (chat_id) {
      try {
        const r = await safeSendMessage(client, chat_id, commentMsg);
        results.requester = { ok: r.ok, error: r.error || null };
        if (DEBUG) console.log(`[WEBHOOK] Comment to requester: ${r.ok ? 'sent' : r.error}`);
      } catch (e) {
        results.requester = { ok: false, error: e?.message };
      }
    }
    
    res.json({ 
      ok: true, 
      incidentId, 
      folio: incFolio,
      notifications: results 
    });
    
  } catch (e) {
    console.error('[WEBHOOK] Error processing comment:', e);
    res.status(500).json({ error: 'internal_error', message: e?.message });
  }
});

// Exportar función para uso directo desde módulos
// Los módulos pueden hacer: require('../index').notifyDashboard({...})
// O usar el endpoint HTTP interno
module.exports = { notifyDashboard };

const httpServer = app.listen(HTTP_PORT, () => {
  console.log(`[HTTP] API on http://localhost:${HTTP_PORT}`);
  console.log(`[HTTP] WA Status: http://localhost:${HTTP_PORT}/api/wa-status`);
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
  stopHealthCheck();

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

  setTimeout(() => process.exit(code), 400);
}

// ══════════════════════════════════════════════════════════════════════════════
// WEBHOOK: Crear incidencia desde el Dashboard
// ══════════════════════════════════════════════════════════════════════════════
app.post('/api/webhook/create-incident', async (req, res) => {
  try {
    const { descripcion, area_destino, lugar, chat_id, attachments, source } = req.body;
    
    console.log('[WEBHOOK] Create incident from dashboard:', {
      area: area_destino,
      lugar,
      chat_id,
      source,
      attachments: attachments?.length || 0
    });
    
    // Validar campos requeridos
    if (!descripcion || !area_destino || !lugar || !chat_id) {
      return res.status(400).json({ 
        error: 'missing_fields',
        message: 'Campos requeridos: descripcion, area_destino, lugar, chat_id'
      });
    }
    
    // Validar que el cliente WA esté listo
    if (!client || !WA_READY) {
      return res.status(503).json({ 
        error: 'wa_not_ready',
        message: 'WhatsApp no está listo'
      });
    }
    
    // ═══════════════════════════════════════════════════════════════
    // IMPORTANTE: Asegurar que SQLite esté listo
    // ═══════════════════════════════════════════════════════════════
    incidenceDB.ensureReady();
    
    // ═══════════════════════════════════════════════════════════════
    // Crear draft para la incidencia
    // ═══════════════════════════════════════════════════════════════
    const areaUpper = area_destino.toUpperCase();
    
    const draft = {
      chat_id: chat_id,
      descripcion: descripcion.trim(),
      lugar: lugar.trim(),
      area_destino: areaUpper,
      origin_name: chat_id,
      status: 'open',
      areas: [areaUpper], // Array de áreas
      attachments: attachments || []
    };
    
    const meta = {
      source: 'dashboard',
      originName: chat_id,
      chatId: chat_id
    };
    
    // Persistir en la BD (esto genera el folio automáticamente)
    const result = incidenceDB.persistIncident(draft, meta);
    
    if (!result || !result.folio) {
      console.error('[WEBHOOK] Failed to create incident - no folio generated');
      return res.status(500).json({ 
        error: 'incident_creation_failed',
        message: 'No se pudo generar el folio de la incidencia'
      });
    }
    
    console.log('[WEBHOOK] Incident created in DB:', result.folio, result.id);
    
    // ═══════════════════════════════════════════════════════════════
    // Procesar adjuntos si hay
    // ═══════════════════════════════════════════════════════════════
    if (attachments && Array.isArray(attachments) && attachments.length > 0) {
      for (const att of attachments) {
        try {
          const fileMeta = {
            filename: att.filename,
            mimetype: att.mimetype,
            size: att.size,
            url: `/attachments/${result.folio}/${att.filename}`
          };
          
          incidenceDB.appendIncidentAttachment(result.id, fileMeta);
          console.log('[WEBHOOK] Attachment saved:', att.filename);
        } catch (attErr) {
          console.error('[WEBHOOK] Error saving attachment:', attErr.message);
        }
      }
    }
    
    // ═══════════════════════════════════════════════════════════════
    // Despachar a grupos usando el formato correcto
    // ═══════════════════════════════════════════════════════════════
    try {
      // Importar funciones de grupos
      const { 
        loadGroupsConfig, 
        resolveTargetGroups, 
        formatIncidentMessage,
        sendIncidentToGroups 
      } = require('./modules/groups/groupRouter');
      
      const cfg = await loadGroupsConfig();
      const { primaryId, ccIds } = resolveTargetGroups(draft, cfg);
      
      if (primaryId) {
        // Usar el mismo formato que routeIncomingNI
        const message = formatIncidentMessage({
          ...draft,
          folio: result.folio,
          id: result.id,
          originChatId: chat_id
        });
        
        console.log('[WEBHOOK] Sending to groups:', { primaryId, ccIds, folio: result.folio });
        
        // Enviar a grupos (sin media por ahora)
        await sendIncidentToGroups(client, { 
          message, 
          primaryId, 
          ccIds, 
          media: null 
        });
        
        // Guardar evento de dispatch
        incidenceDB.appendIncidentEvent(result.id, {
          event_type: 'dispatched_to_groups',
          wa_msg_id: null,
          payload: {
            primaryId,
            ccIds: ccIds || [],
            source: 'dashboard',
            success: true
          }
        });
        
        console.log('[WEBHOOK] Incident dispatched to groups:', result.folio);
      } else {
        console.warn('[WEBHOOK] No primary group found for area:', areaUpper);
      }
    } catch (dispatchErr) {
      console.error('[WEBHOOK] Error dispatching:', dispatchErr.message);
      // Continuar aunque falle el dispatch
    }
    
    // ═══════════════════════════════════════════════════════════════
    // Notificar al solicitante
    // ═══════════════════════════════════════════════════════════════
    try {
      const msg = `✅ *Incidencia Registrada*\n\n` +
                  `📋 *Folio:* ${result.folio}\n` +
                  `📍 *Ubicación:* ${lugar}\n` +
                  `🏷️ *Área:* ${areaUpper}\n` +
                  `📝 *Descripción:* ${descripcion}\n\n` +
                  `Tu solicitud ha sido registrada y enviada al área correspondiente. ` +
                  `Te mantendremos informado del progreso.`;
      
      await client.sendMessage(chat_id, msg);
      console.log('[WEBHOOK] Requester notified:', chat_id);
      
    } catch (notifyErr) {
      console.error('[WEBHOOK] Error notifying requester:', notifyErr.message);
    }
    
    // El notifyDashboard ya se llama automáticamente desde persistIncident
    
    res.json({ 
      ok: true, 
      incidentId: result.id,
      folio: result.folio,
      message: 'Incidencia creada y despachada'
    });
    
  } catch (e) {
    console.error('[WEBHOOK] Create incident error:', e);
    res.status(500).json({ error: 'internal_error', message: e.message });
  }
});

process.on('SIGINT', () => gracefulExit(0));
process.on('SIGTERM', () => gracefulExit(0));

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

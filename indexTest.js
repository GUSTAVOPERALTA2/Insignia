// index.probe.js
require('dotenv').config();

const fs = require('fs');
const path = require('path');
const https = require('https');
const qrcode = require('qrcode-terminal');
const { Client, LocalAuth } = require('whatsapp-web.js');

const NOW = () => new Date().toISOString();
const bool = (v) => String(v || '').toLowerCase() === '1' || String(v || '').toLowerCase() === 'true';

const DEBUG = bool(process.env.VICEBOT_DEBUG ?? '1');

// Probe settings (env toggles)
const USE_CHROME = bool(process.env.WA_USE_CHROME);          // 0 default (Chromium), 1 use Chrome
const CLEAR_AUTH = bool(process.env.WA_AUTH_CLEAR);          // 1 deletes probe auth folder before start
const NET_CHECK = bool(process.env.WA_NET_CHECK);            // 1 runs a tiny https check pre-init
const WAIT_MS = Number(process.env.WA_WAIT_MS || 120000);    // default: 120s
const TAKEOVER = bool(process.env.WA_TAKEOVER ?? '1');       // default: enabled
const HEADLESS = bool(process.env.WA_HEADLESS ?? '0');       // default: false (visible)

// Isolate auth from prod
const SESSION_PATH = path.join(process.cwd(), '.wwebjs_auth_probe');
const CLIENT_ID = process.env.WA_PROBE_CLIENT_ID || 'vicebot-probe';

// Chrome path (only used if WA_USE_CHROME=1)
const CHROME_PATH =
  process.env.WA_CHROME_PATH ||
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

// Log file
const LOG_DIR = path.join(process.cwd(), 'probe_logs');
const LOG_FILE = path.join(LOG_DIR, `probe_${new Date().toISOString().replace(/[:.]/g, '-')}.log`);

function ensureDir(p) {
  try { fs.mkdirSync(p, { recursive: true }); } catch {}
}
ensureDir(LOG_DIR);

function writeLog(...parts) {
  const line = parts.map(p => (typeof p === 'string' ? p : JSON.stringify(p))).join(' ');
  console.log(line);
  try { fs.appendFileSync(LOG_FILE, line + '\n'); } catch {}
}

function exists(p) {
  try { return fs.existsSync(p); } catch { return false; }
}

function rimrafSafe(p) {
  try { fs.rmSync(p, { recursive: true, force: true }); } catch {}
}

function isSessionClosedError(e) {
  const m = String(e?.message || e || '');
  return (
    m.includes('Session closed') ||
    m.includes('Protocol error') ||
    m.includes('Target closed') ||
    m.includes('Execution context was destroyed')
  );
}

function listenerSnapshot(client) {
  const names = [
    'qr',
    'authenticated',
    'auth_failure',
    'ready',
    'disconnected',
    'message',
    'change_state',
    'loading_screen',
    'remote_session_saved',
  ];
  const o = {};
  for (const n of names) o[n] = client.listenerCount(n);
  return o;
}

async function basicNetCheck() {
  return new Promise((resolve) => {
    // No necesitamos “WhatsApp URL” aquí; solo confirmar que HTTPS sale sin MITM raro
    const req = https.get('https://www.google.com/generate_204', { timeout: 8000 }, (res) => {
      resolve({ ok: true, status: res.statusCode, headers: { server: res.headers?.server || null } });
      res.resume();
    });
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, err: 'timeout' }); });
    req.on('error', (err) => resolve({ ok: false, err: err?.message || String(err) }));
  });
}

(async () => {
  writeLog('[PROBE] start', {
    ts: NOW(),
    headless: HEADLESS,
    useChrome: USE_CHROME,
    takeover: TAKEOVER,
    waitMs: WAIT_MS,
    sessionPath: SESSION_PATH,
    clientId: CLIENT_ID,
    chromePath: USE_CHROME ? (exists(CHROME_PATH) ? CHROME_PATH : 'MISSING') : '(puppeteer default chromium)',
    logFile: LOG_FILE,
  });

  if (CLEAR_AUTH) {
    writeLog('[PROBE] CLEAR_AUTH enabled -> deleting', SESSION_PATH);
    rimrafSafe(SESSION_PATH);
  }

  if (NET_CHECK) {
    const net = await basicNetCheck();
    writeLog('[PROBE] NET_CHECK', net);
  }

  const auth = new LocalAuth({ dataPath: SESSION_PATH, clientId: CLIENT_ID });

  let seen = {
    qr: 0,
    authenticated: 0,
    ready: 0,
    disconnected: 0,
    remoteSaved: 0,
    states: [],
  };

  let lastReadyAt = null;
  let startAt = Date.now();

  const puppeteerArgs = [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--disable-gpu',
    '--disable-features=IsolateOrigins,site-per-process',
    '--disable-background-networking',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
  ];

  // Usar Chrome instalado solo si lo pides por env
  const puppeteer = {
    headless: HEADLESS,
    args: puppeteerArgs,
    // En Windows corporativo, a veces Chrome tiene políticas; por eso dejamos
    // el default (Chromium) como primera opción.
    ...(USE_CHROME && exists(CHROME_PATH) ? { executablePath: CHROME_PATH } : {}),
  };

  const client = new Client({
    authStrategy: auth,
    takeoverOnConflict: TAKEOVER,
    takeoverTimeoutMs: TAKEOVER ? 12000 : 0,
    puppeteer,
  });

  writeLog('[PROBE] listeners(init)', listenerSnapshot(client));

  client.on('qr', (qr) => {
    seen.qr += 1;
    writeLog('[PROBE] QR emitted', { ts: NOW(), count: seen.qr });
    qrcode.generate(qr, { small: true });
    writeLog('[PROBE] listeners(qr)', listenerSnapshot(client));
  });

  client.on('authenticated', () => {
    seen.authenticated += 1;
    writeLog('🔐 [PROBE] authenticated', { ts: NOW(), count: seen.authenticated });
  });

  client.on('remote_session_saved', () => {
    seen.remoteSaved += 1;
    writeLog('💾 [PROBE] remote_session_saved', { ts: NOW(), count: seen.remoteSaved });
  });

  client.on('loading_screen', (percent, message) => {
    // Útil para ver si se queda atorado o reinicia
    writeLog('⏳ [PROBE] loading_screen', { ts: NOW(), percent, message: message || null });
  });

  client.on('change_state', (state) => {
    const s = { ts: NOW(), state };
    seen.states.push(s);
    writeLog('🔁 [PROBE] change_state', s);
  });

  client.on('auth_failure', (msg) => {
    writeLog('❌ [PROBE] auth_failure', { ts: NOW(), msg });
  });

  client.on('ready', async () => {
    seen.ready += 1;
    lastReadyAt = Date.now();
    writeLog(seen.ready === 1 ? '✅ [PROBE] READY' : '⚠️ [PROBE] READY repeated', {
      ts: NOW(),
      count: seen.ready,
      sinceStartMs: Date.now() - startAt,
    });

    // Info básica
    try {
      const info = client.info;
      writeLog('[PROBE] client.info', {
        pushname: info?.pushname || null,
        wid: info?.wid?._serialized || null,
        platform: info?.platform || null,
      });
    } catch (e) {
      writeLog('[PROBE] client.info err', { ts: NOW(), err: e?.message || String(e) });
    }

    // Espera pasiva para ver si WA expulsa (LOGOUT) solo.
    writeLog('[PROBE] stability window start', { waitMs: WAIT_MS, ts: NOW() });

    setTimeout(async () => {
      // Check de estado al final
      let state = null;
      try { state = await client.getState(); } catch (e) { state = `ERR:${e?.message || e}`; }

      writeLog('[PROBE] stability window end', {
        ts: NOW(),
        state,
        seen,
        ok: state === 'CONNECTED' || state === 'OPENING' || state === 'PAIRING',
        note:
          'Si se mantuvo CONNECTED sin QR nuevo y sin LOGOUT, el entorno es estable. Si cae en LOGOUT, es red/políticas/WA.',
      });

      // No destruimos a la fuerza; dejamos salida limpia
      process.exit(0);
    }, WAIT_MS);
  });

  client.on('disconnected', (reason) => {
    seen.disconnected += 1;
    writeLog('🔌 [PROBE] disconnected', { ts: NOW(), reason, count: seen.disconnected });

    // Log extra para diagnóstico rápido
    const sinceReady = lastReadyAt ? (Date.now() - lastReadyAt) : null;
    writeLog('[PROBE] disconnect context', {
      ts: NOW(),
      sinceStartMs: Date.now() - startAt,
      sinceReadyMs: sinceReady,
      seen,
      hint:
        reason === 'LOGOUT'
          ? 'LOGOUT casi siempre = revocación de sesión / red corporativa / proxy / seguridad / conflicto dispositivo.'
          : 'Si no es LOGOUT, puede ser reconexión, crash del navegador, o cierre del target.',
    });

    // Salida no inmediata para dejar que se impriman pendientes
    setTimeout(() => process.exit(2), 1500);
  });

  process.on('unhandledRejection', (e) => {
    if (isSessionClosedError(e)) {
      writeLog('[PROBE] unhandledRejection: session closed (ignored)', { ts: NOW() });
      return;
    }
    writeLog('[PROBE] unhandledRejection', { ts: NOW(), err: e?.message || String(e) });
  });

  process.on('uncaughtException', (e) => {
    writeLog('[PROBE] uncaughtException', { ts: NOW(), err: e?.message || String(e) });
    process.exit(3);
  });

  try {
    await client.initialize();
    writeLog('[PROBE] initialize() called', { ts: NOW() });
  } catch (e) {
    writeLog('[PROBE] initialize failed', { ts: NOW(), err: e?.message || String(e) });
    process.exit(4);
  }
})();

// modules/router/routeSmalltalk.js
// Router de smalltalk / meta / ayuda.
// Se apoya en la salida de coreIntentRouter (intent + flags)
// para decidir qué contestar.
//
// No toca tickets ni N-I, sólo responde en texto.

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

const DEBUG = (process.env.VICEBOT_DEBUG || '1') === '1';

const USERS_PATH =
  process.env.VICEBOT_USERS_PATH || path.join(process.cwd(), 'data', 'users.json');

// ✅ Safe reply (evita crash por "Session closed")
const { safeReply, isSessionClosedError } = require('../core/safeReply');

// Cache simple para no leer users.json cada vez
let _usersCache = null;
let _usersCacheAt = 0;
const USERS_CACHE_TTL_MS = Number(process.env.VICEBOT_USERS_CACHE_TTL_MS || 30_000); // 30s

async function loadUsersCached() {
  const now = Date.now();
  if (_usersCache && now - _usersCacheAt < USERS_CACHE_TTL_MS) return _usersCache;

  try {
    if (!fs.existsSync(USERS_PATH)) {
      _usersCache = {};
      _usersCacheAt = now;
      return _usersCache;
    }

    let raw = await fsp.readFile(USERS_PATH, 'utf8');
    raw = raw.replace(/^\uFEFF/, ''); // quitar BOM si existe
    const obj = JSON.parse(raw || '{}');

    const normalized = {};
    if (obj && typeof obj === 'object') {
      for (const [k, v] of Object.entries(obj)) {
        normalized[String(k).trim()] = v;
      }
    }

    _usersCache = normalized;
    _usersCacheAt = now;
    return _usersCache;
  } catch (e) {
    if (DEBUG) {
      console.warn('[SMALLTALK] users.json read/parse error', e?.message || e);
    }
    _usersCache = {};
    _usersCacheAt = now;
    return _usersCache;
  }
}

async function getUserRecord(chatId) {
  const users = await loadUsersCached();
  return users[String(chatId || '').trim()] || null;
}

// Nombre completo -> { first, last }
function splitName(fullName) {
  const s = String(fullName || '').trim();
  if (!s) return { first: '', last: '' };
  const parts = s.split(/\s+/).filter(Boolean);
  const first = parts[0] || '';
  const last = parts.length > 1 ? parts[parts.length - 1] : parts[0] || '';
  return { first, last };
}

function pickRandom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

// Detecta si el mensaje es un saludo corto
function isGreetingText(text = '') {
  const t = String(text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // quitar acentos
    .trim();

  // saludos típicos
  return /^(hola|hey|buenos dias|buen dia|buenas tardes|buenas noches|buenas|hi|hello|que onda|qué onda|como estas|cómo estás|como estas\?|cómo estás\?)\b/.test(t);
}

// Construye saludo al azar:
// - Hola {titulo} {nombre}
// - Hola {titulo} {apellido}
function buildRandomHello(rec) {
  const titulo = String(rec?.titulo || '').trim(); // "Sr." o "Srta" (según tu JSON)
  const { first, last } = splitName(rec?.nombre);

  // Fallbacks seguros
  if (!first && !last) {
    return titulo ? `👋 Hola ${titulo}` : '👋 Hola';
  }

  const chosen = pickRandom([first || last, last || first]);
  const base = titulo ? `👋 Hola ${titulo} ${chosen}` : `👋 Hola ${chosen}`;
  return base.replace(/\s+/g, ' ').trim();
}

/* ──────────────────────────────────────────────────────────────
 * Dedupe local (si routeSmalltalk se invoca 2 veces por re-emit)
 * ────────────────────────────────────────────────────────────── */
const SMALLTALK_SEEN = new Map(); // waId -> ts
const SMALLTALK_TTL_MS = Number(process.env.VICEBOT_SMALLTALK_TTL_MS || 60_000);

function seenAndRememberSmalltalk(waId) {
  if (!waId) return false;
  const now = Date.now();
  const prev = SMALLTALK_SEEN.get(waId);
  if (prev && now - prev < SMALLTALK_TTL_MS) return true;
  SMALLTALK_SEEN.set(waId, now);

  // cleanup light
  for (const [k, ts] of SMALLTALK_SEEN.entries()) {
    if (now - ts > SMALLTALK_TTL_MS) SMALLTALK_SEEN.delete(k);
  }

  return false;
}

/**
 * Maneja saludos, preguntas sobre el bot y peticiones de ayuda.
 *
 * @param {import('whatsapp-web.js').Client} client
 * @param {import('whatsapp-web.js').Message} msg
 * @param {Object} intent  - salida de classifyMessageIntent
 *   - intent.intent        (smalltalk|help|...)
 *   - intent.flags.isMetaBot
 *   - intent.flags.isHelp
 */
async function handleSmalltalk(client, msg, intent) {
  const body = (msg.body || '').trim();
  const flags = intent?.flags || {};
  const isMetaBot = !!flags.isMetaBot;
  const isHelp = !!flags.isHelp;

  const waId = msg?.id && (msg.id._serialized || msg.id);

  // ✅ si por cualquier razón se re-invoca con el mismo mensaje, no respondemos 2 veces
  if (waId && seenAndRememberSmalltalk(waId)) {
    if (DEBUG) console.log('[SMALLTALK] skip duplicate smalltalk reply', waId);
    return true;
  }

  if (DEBUG) {
    console.log('[SMALLTALK] in', {
      chatId: msg.from,
      body,
      intent: intent?.intent,
      isMetaBot,
      isHelp,
    });
  }

  try {
    // 0) Saludo estético aleatorio:
    // "Hola {titulo} {nombre}" o "Hola {titulo} {apellido}"
    const isSocial = !!flags.isSocialSmalltalk;
    const isGreeting = !!flags.isGreeting || isGreetingText(body);

    if (!isMetaBot && !isHelp && intent?.intent === 'smalltalk' && (isGreeting || isSocial)) {
      const rec = await getUserRecord(msg.from);
      const hello = buildRandomHello(rec);

      await safeReply(
        msg,
        `${hello}\n\n` +
          'Cuando necesites algo, dime en una frase qué problema o solicitud tienes.\n' +
          'Por ejemplo: "no funciona la TV en la Villa 6".'
      );
      return true;
    }

    // 1) Preguntas tipo: "¿Cómo te llamas?", "¿Quién eres?", "¿Qué eres?"
    if (isMetaBot) {
      await safeReply(
        msg,
        '🤖 Soy *Vicebot*, el asistente del hotel para reportar y dar seguimiento a incidencias ' +
          'de Mantenimiento, IT, HSKP, Room Service y Seguridad.\n\n' +
          'Tú me cuentas qué pasó y yo lo mando al equipo correcto. 😉'
      );
      return true;
    }

    // 2) Preguntas tipo ayuda: "ayuda", "qué puedes hacer", "cómo uso esto"
    if (isHelp || intent?.intent === 'help') {
      await safeReply(
        msg,
        '🆘 Puedo ayudarte a reportar problemas o solicitudes operativas.\n\n' +
          'Ejemplos:\n' +
          '• "No sirve el clima en la Villa 5"\n' +
          '• "Fuga de agua en la hab 1311"\n' +
          '• "Necesito almohadas extra en la Villa 3"\n\n' +
          'Sólo dime en una frase qué pasa y te armo el reporte.'
      );
      return true;
    }

    // 3) Smalltalk genérico
    await safeReply(
      msg,
      '👋 Hola, soy *Vicebot*.\n' +
        'Cuando necesites algo, dime en una frase qué problema o solicitud tienes.\n' +
        'Por ejemplo: "no funciona la TV en la Villa 6".'
    );
    return true;
  } catch (e) {
    if (isSessionClosedError(e)) {
      if (DEBUG) console.warn('[SMALLTALK] session closed → skip reply');
      return false;
    }
    if (DEBUG) console.warn('[SMALLTALK] reply err', e?.message || e);
    return false;
  }
}

module.exports = {
  handleSmalltalk,
};

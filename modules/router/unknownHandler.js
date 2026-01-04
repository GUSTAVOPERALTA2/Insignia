// modules/router/unknownHandler.js
// Handler para mensajes "unknown".
// Solo UX/fallback seguro. Toda respuesta sale de contextualHumorReply.

const DEBUG = (process.env.VICEBOT_DEBUG || '1') === '1';

let contextualHumorReply = null;
try {
  ({ contextualHumorReply } = require('../ai/contextualHumorReply'));
} catch (e) {
  contextualHumorReply = null;
  if (DEBUG) console.warn('[UNKNOWN] contextualHumorReply missing:', e?.message || e);
}

let safeReply = null;
try {
  ({ safeReply } = require('../utils/safeReply'));
} catch (e) {
  safeReply = null;
  if (DEBUG) console.warn('[UNKNOWN] safeReply missing:', e?.message || e);
}

async function replySafe(msg, text) {
  if (!msg || !text) return false;
  try {
    if (safeReply) return await safeReply(msg, text);
    await msg.reply(text);
    return true;
  } catch (e) {
    if (DEBUG) console.warn('[UNKNOWN] replySafe err', e?.message || e);
    return false;
  }
}

function _norm(text = '') {
  return String(text || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

function looksOperational(text = '') {
  const t = _norm(text);
  return (
    /\b\d{4}\b/.test(t) ||
    /\b(no sirve|no funciona|fuga|sin agua|sin luz|tapad[oa]|roto|rota|urgente|emergencia|se descompuso|no enciende|no prende|no hay)\b/.test(t)
  );
}

function detectLoreMode(body = '') {
  const t = _norm(body);

  if (looksOperational(t)) return { mode: 'general', personaTarget: null };

  // ✅ META/CREACIÓN: forzar siempre lore_creator
  const creationTriggers =
    /\b(quien\s+te\s+creo|quien\s+te\s+hizo|tu\s+creador|tu\s+creacion|por\s+que\s+existes|para\s+que\s+existes|de\s+donde\s+sales|cual\s+es\s+tu\s+origen|quien\s+te\s+programo|quien\s+te\s+desarrollo|eres\s+una\s+ia|eres\s+ia|eres\s+chatgpt|eres\s+gpt|openai|chatgpt|gpt)\b/;
  if (creationTriggers.test(t)) return { mode: 'lore_creator', personaTarget: null };

  const asksAboutPerson =
    /\bquien\s+es\b/.test(t) ||
    /\bquien\s+era\b/.test(t) ||
    /\bsabes\s+quien\s+es\b/.test(t) ||
    /\bconoces\b/.test(t) ||
    /\bhablame\s+de\b/.test(t) ||
    /\bme\s+hablas\s+de\b/.test(t);

  const mentionsGustavo = /\bgustavo\b/.test(t) || /\bperalta\b/.test(t) || /\bgus\b/.test(t);
  const mentionsOmaly = /\bomaly\b/.test(t) || /\bmartel+l\b/.test(t);
  const mentionsIsrael = /\bisrael\b/.test(t) || /\bflores\b/.test(t);

  const triggerByMention = true;

  if ((asksAboutPerson || triggerByMention) && mentionsGustavo) {
    return { mode: 'lore_father', personaTarget: 'gustavo' };
  }

  if ((asksAboutPerson || triggerByMention) && (mentionsOmaly || mentionsIsrael)) {
    return { mode: 'lore_uncle', personaTarget: mentionsIsrael ? 'israel' : 'omaly' };
  }

  return { mode: 'general', personaTarget: null };
}

// ─────────────────────────────────────────────
// Main handler
// ─────────────────────────────────────────────
async function handleUnknown(client, msg, intentResult = {}) {
  if (!msg) return false;

  if (msg.__unknownHandled === true) return true;
  msg.__unknownHandled = true;

  const chatId = msg.from || '(unknown)';
  const body = (msg.body || '').trim();
  const flags = intentResult.flags || {};

  if (DEBUG) {
    console.log('[UNKNOWN] in', {
      chatId,
      body,
      intent: intentResult.intent,
      reason: intentResult.reason,
      flags,
    });
  }

  let reply;

  const hasText = body.length > 0;
  const hasMedia = !!msg.hasMedia;
  const looksHelp = !!flags.isHelp || /\bayuda\b/i.test(body);

  if (hasMedia && !hasText) {
    reply =
      '📸 Recibí tu archivo, pero no me queda claro qué quieres reportar.\n\n' +
      'Si es un problema, escríbeme en una frase qué pasó y dónde, por ejemplo:\n' +
      '• *"En la 2101 no sirve la luz"* 🔌\n' +
      '• *"En la Villa 5 hay fuga de agua en el baño"* 🚿\n\n' +
      'Tip: también puedes usar */tickets* para ver tus pendientes.';
    await replySafe(msg, reply);
    return true;
  }

  if (looksHelp) {
    reply =
      '🤔 Puedo ayudarte, pero necesito un poco más de contexto.\n\n' +
      'Si quieres *reportar* un problema, dime algo como:\n' +
      '• *"En la 2101 no sirve la luz"* 🔌\n' +
      '• *"En la Villa 5 hay fuga de agua en el baño"* 🚿\n\n' +
      'Si quieres *consultar tickets*, prueba:\n' +
      '• */tickets*\n' +
      '• */tickets abiertas*\n' +
      '• */tickets buscar 1208*';
    await replySafe(msg, reply);
    return true;
  }

  // ✅ Todo lo demás: una sola fuente de respuesta
  if (contextualHumorReply && hasText) {
    try {
      const lore = detectLoreMode(body);
      reply = await contextualHumorReply(body, lore);
    } catch (e) {
      if (DEBUG) console.warn('[UNKNOWN] contextualHumorReply err:', e?.message || e);
    }
  }

  // fallback mínimo si algo truena
  if (!reply) {
    reply =
      '😄 Te leí, pero aquí ando más en modo “arreglar cosas” que en modo enciclopedia.\n\n' +
      'Si es algo del hotel que no funciona (por ejemplo aire o luz en una habitación), dime qué pasó y dónde para ayudarte.';
  }

  await replySafe(msg, reply);
  return true;
}

module.exports = { handleUnknown };

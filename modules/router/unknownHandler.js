// modules/router/unknownHandler.js
// Handler para mensajes "unknown".
// ⚠️ Importante: ya NO interpreta NL→/tickets. Eso lo hace nlCommandBuilder en el core.
// Aquí solo UX/fallback seguro.

const DEBUG = (process.env.VICEBOT_DEBUG || '1') === '1';

// ✅ SAFE REPLY (absorbe "Session closed" sin matar proceso)
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

async function handleUnknown(client, msg, intentResult = {}) {
  if (!msg) return false;

  // ✅ Anti doble-ejecución (reentradas raras / duplicados)
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
  } else if (looksHelp) {
    reply =
      '🤔 Puedo ayudarte, pero necesito un poco más de contexto.\n\n' +
      'Si quieres *reportar* un problema, dime algo como:\n' +
      '• *"En la 2101 no sirve la luz"* 🔌\n' +
      '• *"En la Villa 5 hay fuga de agua en el baño"* 🚿\n\n' +
      'Si quieres *consultar tickets*, prueba:\n' +
      '• */tickets*\n' +
      '• */tickets abiertas*\n' +
      '• */tickets buscar 1208*';
  } else {
    reply =
      '🤔 No me quedó claro.\n\n' +
      'Si quieres *reportar* un problema, dime qué pasó y dónde:\n' +
      '• *"En la 2101 no sirve la luz"* 🔌\n' +
      '• *"En la Villa 5 hay fuga de agua en el baño"* 🚿\n\n' +
      'Si quieres *consultar tickets*, prueba:\n' +
      '• */tickets*\n' +
      '• */tickets abiertas*\n' +
      '• */tickets buscar 2701*';
  }

  await replySafe(msg, reply);
  return true;
}

module.exports = { handleUnknown };

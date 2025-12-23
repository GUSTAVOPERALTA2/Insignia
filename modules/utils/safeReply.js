// modules/utils/safeReply.js
// Responde con msg.reply(); si falla, hace fallback a client.sendMessage()
// (Opcional) si groupRouter exporta safeSendMessage, úsalo para rate-limit / reintentos.

const DEBUG = (process.env.VICEBOT_DEBUG || '1') === '1';

async function safeReply(client, msg, text, options) {
  const chatId = msg?.from;

  // 1) Intento normal: reply
  try {
    if (msg && typeof msg.reply === 'function') {
      return await msg.reply(text, undefined, options);
    }
  } catch (e) {
    if (DEBUG) console.warn('[SAFE-REPLY] msg.reply failed', e?.message || e);
  }

  // 2) Fallback: usar groupRouter.safeSendMessage si existe
  try {
    const gr = require('../groups/groupRouter');
    if (typeof gr.safeSendMessage === 'function' && chatId) {
      return await gr.safeSendMessage(client, chatId, text, options);
    }
  } catch (e) {
    if (DEBUG) console.warn('[SAFE-REPLY] safeSendMessage not available', e?.message || e);
  }

  // 3) Último recurso: client.sendMessage directo
  try {
    if (client && chatId) {
      return await client.sendMessage(chatId, text, options);
    }
  } catch (e) {
    if (DEBUG) console.warn('[SAFE-REPLY] client.sendMessage failed', e?.message || e);
  }

  return null;
}

module.exports = { safeReply };

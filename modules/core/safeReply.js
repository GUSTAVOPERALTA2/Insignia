// modules/core/safeReply.js
// ═══════════════════════════════════════════════════════════════════════════
// Utilidades para envío seguro de mensajes en WhatsApp Web.js
// Maneja errores comunes como "Session closed", "markedUnread", etc.
// ═══════════════════════════════════════════════════════════════════════════

const DEBUG = (process.env.VICEBOT_DEBUG || '1') === '1';

// ──────────────────────────────────────────────────────────────
// Detección de errores conocidos
// ──────────────────────────────────────────────────────────────

/**
 * Detecta si el error es por sesión cerrada/desconectada
 */
function isSessionClosedError(err) {
  if (!err) return false;
  const msg = String(err?.message || err || '').toLowerCase();
  return (
    msg.includes('session closed') ||
    msg.includes('protocol error') ||
    msg.includes('target closed') ||
    msg.includes('execution context was destroyed') ||
    msg.includes('not attached to page') ||
    msg.includes('page crashed') ||
    msg.includes('session was closed') ||
    msg.includes('connection closed')
  );
}

/**
 * Detecta si es un error interno de WhatsApp Web (no fatal)
 * Estos errores son intermitentes y no deberían crashear el bot
 */
function isWhatsAppInternalError(err) {
  if (!err) return false;
  const msg = String(err?.message || err || '').toLowerCase();
  return (
    msg.includes('markedunread') ||
    msg.includes('cannot read properties of undefined') ||
    msg.includes('cannot read properties of null') ||
    msg.includes('evaluation failed') ||
    msg.includes('wid') ||
    msg.includes('sendseen') ||
    // Errores de navegación internos
    msg.includes('navigation') ||
    msg.includes('detached')
  );
}

/**
 * Detecta si es un error recuperable (no requiere reconexión)
 */
function isRecoverableError(err) {
  return isWhatsAppInternalError(err) && !isSessionClosedError(err);
}

// ──────────────────────────────────────────────────────────────
// Safe Reply - Envío seguro de mensajes
// ──────────────────────────────────────────────────────────────

/**
 * Envía una respuesta de forma segura, con fallback si msg.reply() falla
 * 
 * @param {import('whatsapp-web.js').Message} msg - Mensaje original
 * @param {string} text - Texto a enviar
 * @param {Object} [options] - Opciones de mensaje
 * @returns {Promise<import('whatsapp-web.js').Message|null>}
 */
async function safeReply(msg, text, options = {}) {
  if (!msg || !text) return null;

  const chatId = msg.from || msg.to;
  const opts = { sendSeen: false, ...options }; // ✅ default global

  try {
    return await msg.reply(text, undefined, opts);
  } catch (e1) {
    if (isSessionClosedError(e1)) return null;

    try {
      const chat = await msg.getChat();
      if (chat?.sendMessage) return await chat.sendMessage(text, opts);
    } catch (e2) {
      if (isSessionClosedError(e2)) return null;
    }

    try {
      const client = msg.client || global.__waClient;
      if (client?.sendMessage) return await client.sendMessage(chatId, text, opts);
    } catch {}

    return null;
  }
}

/**
 * Envía un mensaje a un chatId específico de forma segura
 * 
 * @param {import('whatsapp-web.js').Client} client - Cliente de WhatsApp
 * @param {string} chatId - ID del chat destino
 * @param {string} text - Texto a enviar
 * @param {Object} [options] - Opciones de mensaje
 * @returns {Promise<import('whatsapp-web.js').Message|null>}
 */
async function safeSendMessage(client, chatId, content, options = {}) {
  if (!client || !chatId || content == null) {
    if (DEBUG) console.warn('[SAFE-SEND] missing client, chatId, or content');
    return null;
  }

  // WhatsApp-web.js soporta sendSeen en algunas versiones; en otras puede causar bugs.
  // Default: no marcar visto.
  const baseOpts = { sendSeen: false, ...options };

  const isMarkedUnreadBug = (e) => {
    const m = String(e?.message || e || '');
    return /markedUnread|markUnread/i.test(m);
  };

  const isNonFatalSendOptionBug = (e) => {
    // Algunos fallos vienen del bundle web (stack con static.whatsapp.net)
    const m = String(e?.message || e || '');
    return /static\.whatsapp\.net|rsrc\.php/i.test(m) || isMarkedUnreadBug(e);
  };

  // Intento A: client.sendMessage con opts
  try {
    return await client.sendMessage(chatId, content, baseOpts);
  } catch (e1) {
    if (DEBUG) console.warn('[SAFE-SEND] client.sendMessage() failed:', (e1?.message || e1));

    if (isSessionClosedError?.(e1)) {
      if (DEBUG) console.warn('[SAFE-SEND] session closed, aborting');
      return null;
    }

    // Intento B: retry SIN opciones si parece bug del bundle / markedUnread
    if (isNonFatalSendOptionBug(e1)) {
      try {
        if (DEBUG) console.warn('[SAFE-SEND] retrying without options (bundle/markedUnread)');
        return await client.sendMessage(chatId, content);
      } catch (e1b) {
        if (DEBUG) console.warn('[SAFE-SEND] retry without options failed:', (e1b?.message || e1b));
        if (isSessionClosedError?.(e1b)) return null;
      }
    }

    // Intento C: getChatById().sendMessage con opts
    try {
      const chat = await client.getChatById(chatId);
      if (chat && typeof chat.sendMessage === 'function') {
        try {
          const r = await chat.sendMessage(content, baseOpts);
          if (DEBUG) console.log('[SAFE-SEND] fallback via getChatById().sendMessage() OK');
          return r;
        } catch (e2) {
          if (DEBUG) console.warn('[SAFE-SEND] chat.sendMessage(opts) failed:', (e2?.message || e2));
          if (isSessionClosedError?.(e2)) return null;

          // Intento D: chat.sendMessage SIN opts si cae en bug raro
          if (isNonFatalSendOptionBug(e2)) {
            try {
              if (DEBUG) console.warn('[SAFE-SEND] retrying chat.sendMessage without options');
              return await chat.sendMessage(content);
            } catch (e2b) {
              if (DEBUG) console.warn('[SAFE-SEND] retry chat.sendMessage failed:', (e2b?.message || e2b));
              if (isSessionClosedError?.(e2b)) return null;
            }
          }
        }
      }
    } catch (e3) {
      if (DEBUG) console.warn('[SAFE-SEND] getChatById() failed:', (e3?.message || e3));
      if (isSessionClosedError?.(e3)) return null;
    }

    if (DEBUG) console.warn('[SAFE-SEND] all attempts failed for', chatId);
    return null;
  }
}


/**
 * Marca un chat como leído de forma segura (ignora errores)
 * 
 * @param {import('whatsapp-web.js').Message} msg - Mensaje a marcar como leído
 */
async function safeSendSeen(msg) {
  if (!msg) return;

  try {
    const chat = await msg.getChat();
    if (chat && typeof chat.sendSeen === 'function') {
      await chat.sendSeen();
    }
  } catch (e) {
    // Ignorar errores de sendSeen - no son críticos
    if (DEBUG && !isWhatsAppInternalError(e)) {
      console.warn('[SAFE-SEEN] sendSeen failed (non-critical):', e?.message?.substring(0, 50));
    }
  }
}

/**
 * Wrapper para ejecutar una función con manejo de errores de WA
 * 
 * @param {Function} fn - Función async a ejecutar
 * @param {string} [label] - Etiqueta para logs
 * @returns {Promise<any>} Resultado de la función o null si falla
 */
async function safeExecute(fn, label = 'SAFE-EXEC') {
  try {
    return await fn();
  } catch (e) {
    if (isSessionClosedError(e)) {
      if (DEBUG) console.warn(`[${label}] session closed`);
      throw e; // Re-throw para que el caller sepa que la sesión murió
    }

    if (isRecoverableError(e)) {
      if (DEBUG) console.warn(`[${label}] recoverable error (ignored):`, e?.message?.substring(0, 80));
      return null;
    }

    // Error desconocido - loguear y continuar
    console.warn(`[${label}] unexpected error:`, e?.message || e);
    return null;
  }
}

// ──────────────────────────────────────────────────────────────
// Exports
// ──────────────────────────────────────────────────────────────
module.exports = {
  // Detección de errores
  isSessionClosedError,
  isWhatsAppInternalError,
  isRecoverableError,
  
  // Envío seguro
  safeReply,
  safeSendMessage,
  safeSendSeen,
  safeExecute,
};
// modules/core/coreMessageRouter.js
const DEBUG = (process.env.VICEBOT_DEBUG || '1') === '1';
const TICKETS_AI_ENABLED = (process.env.VICEBOT_TICKETS_AI || '1') === '1';

// ✅ safeReply (ya lo pegaste)
const { safeReply, isSessionClosedError } = require('./safeReply');

// ✅ OJO: tu carpeta real es /modules/ai (según tus paths actuales)
let classifyMessageIntent = null;
try {
  ({ classifyMessageIntent } = require('../ai/coreIntentRouter'));
} catch (e) {
  if (DEBUG) console.warn('[CORE-ROUTER] coreIntentRouter missing or invalid:', e?.message || e);
  classifyMessageIntent = null;
}

// Router handlers existentes en /modules/router
const { handleSmalltalk } = require('../router/routeSmalltalk');
const { handleUnknown } = require('../router/unknownHandler');
const { maybeHandleTeamFeedback } = require('../router/routeTeamFeedback');
const { maybeHandleRequesterReply } = require('../router/routeRequesterReply');
const { maybeHandleGroupCancel } = require('../router/routeGroupsUpdate');

// ✅ Router de consultas de tickets con lenguaje natural
const { maybeHandleTicketQuery } = require('../router/routeTicketQuery');

// ✅ FIX: tu router NI exporta handleTurn, no handleNITurn
const { handleTurn } = require('../router/routeIncomingNI');

// ✅ MISMO router de comandos que usa index.js
const { tryHandleAdminCommands } = require('./adminCommandRouter');

// DB dedupe (persistente)
const { hasMessageBeenHandled, markMessageHandled } = require('../db/incidenceDB');

// --- Helpers WA (sin dependencia a utils/wa.js) ---
function isGroupId(chatId) {
  return typeof chatId === 'string' && chatId.endsWith('@g.us');
}
function isStatusBroadcast(chatId) {
  return chatId === 'status@broadcast';
}

// --- NI context (sin niContext.js). Intentamos state/niSession; si no, fallback seguro ---
let _niSession = null;
function getNiSession() {
  if (_niSession !== null) return _niSession;
  try {
    _niSession = require('../state/niSession');
  } catch {
    _niSession = null;
  }
  return _niSession;
}

function getNiContextForChat(chatId) {
  const mod = getNiSession();
  try {
    if (mod && typeof mod.getNiContextForChat === 'function') {
      const ctx = mod.getNiContextForChat(chatId);
      return {
        hasActiveNISession: !!ctx?.hasActiveNISession,
        niMode: ctx?.niMode || null,
        raw: ctx
      };
    }
    if (mod && typeof mod.getSession === 'function') {
      const s = mod.getSession(chatId);
      return {
        hasActiveNISession: !!s?.hasActiveNISession || !!s?.active || !!s?.draft,
        niMode: s?.mode || s?.niMode || null,
        raw: s
      };
    }
    if (mod && typeof mod.hasActiveSession === 'function') {
      return {
        hasActiveNISession: !!mod.hasActiveSession(chatId),
        niMode: null,
        raw: null
      };
    }
  } catch (e) {
    if (DEBUG) console.warn('[CORE-ROUTER] niSession error:', e?.message || e);
  }
  return { hasActiveNISession: false, niMode: null, raw: null };
}

// --- NL Builder (tu módulo) ---
let _nlBuilder = null;
function getNLBuilder() {
  if (_nlBuilder !== null) return _nlBuilder;
  try {
    _nlBuilder = require('../ai/nlCommandBuilder');
  } catch (e) {
    _nlBuilder = null;
    if (DEBUG) console.warn('[CORE-ROUTER] nlCommandBuilder missing:', e?.message || e);
  }
  return _nlBuilder;
}

// Clon superficial preservando métodos del msg original
function cloneMsgWithBody(msg, newBody) {
  const cmdMsg = Object.create(msg);
  cmdMsg.body = newBody;
  return cmdMsg;
}

/* ──────────────────────────────────────────────────────────────
 * DEDUPE EXTRA (in-memory) para re-emits / doble handler
 * ────────────────────────────────────────────────────────────── */
const INMEM_SEEN = new Map(); // waId -> ts
const INMEM_TTL_MS = 2 * 60 * 1000; // 2 min

function rememberInMem(waId) {
  if (!waId) return;
  INMEM_SEEN.set(waId, Date.now());
}

function seenInMem(waId) {
  if (!waId) return false;
  const ts = INMEM_SEEN.get(waId);
  if (!ts) return false;
  if (Date.now() - ts > INMEM_TTL_MS) {
    INMEM_SEEN.delete(waId);
    return false;
  }
  return true;
}

function cleanupInMem() {
  const now = Date.now();
  for (const [k, ts] of INMEM_SEEN.entries()) {
    if (now - ts > INMEM_TTL_MS) INMEM_SEEN.delete(k);
  }
}

async function handleIncomingMessage(client, msg, opts = {}) {
  if (!msg) return false;

  const chatId = msg?.from;
  const waId = msg?.id && (msg.id._serialized || msg.id);

  cleanupInMem();

  // ✅ Guard: evitar doble entrada del MISMO objeto msg
  if (msg.__coreHandled) {
    if (DEBUG) console.log('[CORE-ROUTER] skip duplicate (flag)');
    return false;
  }
  msg.__coreHandled = true;

  // ✅ Guard: evitar re-emit del mismo waId a nivel memoria
  if (waId && seenInMem(waId)) {
    if (DEBUG) console.log('[CORE-ROUTER] skip duplicate (in-mem)', waId);
    return false;
  }
  if (waId) rememberInMem(waId);

  try {
    if (msg.fromMe) return false;
    if (isStatusBroadcast(chatId)) return false;

    // Dedup persistente (DB)
    if (waId && hasMessageBeenHandled(waId)) {
      if (DEBUG) console.log('[CORE-ROUTER] skip duplicate (db)', waId);
      return false;
    }

    const body = (msg.body || '').trim();

    if (DEBUG) {
      console.log('[CORE-ROUTER] [MSG] in', { chatId, body: body || '(vacío / media)' });
    }

    // Si por alguna razón entra un comando aquí, intentar manejarlo
    if (body.startsWith('/')) {
      try {
        const handledCmd = await tryHandleAdminCommands(client, msg);
        if (handledCmd) {
          if (waId) markMessageHandled(waId);
          return true;
        }
      } catch (e) {
        if (DEBUG) console.warn('[CORE-ROUTER] command defensive err', e?.message || e);
        if (isSessionClosedError(e)) return false;
      }
      // No lo manejamos aquí
      return false;
    }

    // 1) Grupo: actualizaciones de estado (done/progress/cancel), consultas y evidencias
    if (isGroupId(chatId)) {
      // ✅ PRIMERO: routeGroupsUpdate para actualizaciones de estado
      // Maneja: "Listo", "Vamos", "Cancela, esto no es mío", etc.
      try {
        const handledUpdate = await maybeHandleGroupCancel(client, msg);
        if (handledUpdate) {
          if (waId) markMessageHandled(waId);
          return true;
        }
      } catch (e) {
        if (DEBUG) console.warn('[CORE-ROUTER] groupUpdate err', e?.message || e);
        if (isSessionClosedError(e)) return false;
      }

      // ✅ SEGUNDO: Consultas de tickets con lenguaje natural
      // Maneja: "tickets pendientes", "buscar cocina", etc.
      try {
        const handledQuery = await maybeHandleTicketQuery(client, msg);
        if (handledQuery) {
          if (waId) markMessageHandled(waId);
          return true;
        }
      } catch (e) {
        if (DEBUG) console.warn('[CORE-ROUTER] ticketQuery(group) err', e?.message || e);
        if (isSessionClosedError(e)) return false;
      }

      // ✅ TERCERO: routeTeamFeedback para evidencias (fotos) y mensajes citando ticket
      // Solo procesa si tiene FOTO o CITA el mensaje del ticket
      try {
        const handledTeam = await maybeHandleTeamFeedback(client, msg);
        if (handledTeam) {
          if (waId) markMessageHandled(waId);
          return true;
        }
      } catch (e) {
        if (DEBUG) console.warn('[CORE-ROUTER] teamFeedback err', e?.message || e);
        if (isSessionClosedError(e)) return false;
      }

      // No se manejó en grupo
      return false;
    }

    // 2) DM
    const niContext = getNiContextForChat(chatId);

    // ✅ PRIMERO: Consultas de tickets con lenguaje natural (antes de NL→CMD)
    // Maneja: "tickets pendientes de IT", "mis tickets", "buscar cocina", etc.
    // Solo si NO hay sesión N-I activa
    if (!niContext.hasActiveNISession && body) {
      try {
        const handledQuery = await maybeHandleTicketQuery(client, msg);
        if (handledQuery) {
          if (waId) markMessageHandled(waId);
          return true;
        }
      } catch (e) {
        if (DEBUG) console.warn('[CORE-ROUTER] ticketQuery(DM) err', e?.message || e);
        if (isSessionClosedError(e)) return false;
      }
    }

    // ✅ NL → CMD (IA) ANTES del intent router
    // Solo si NO hay sesión N-I activa y no es comando.
    if (TICKETS_AI_ENABLED && !niContext.hasActiveNISession && body) {
      // Anti-loop duro
      if (msg._nlCmdRouted === true) {
        if (DEBUG) console.log('[CORE-ROUTER][NL→CMD] skip (already routed)');
      } else {
        const nlMod = getNLBuilder();
        if (nlMod && typeof nlMod.buildNLCommand === 'function') {
          try {
            const out = await nlMod.buildNLCommand({
              text: body,
              context: {
                chatId,
                isGroup: false,
                hasActiveNISession: false
              }
            });

            const nlCmd = out?.command;

            if (nlCmd) {
              if (DEBUG) {
                console.log('[CORE-ROUTER][NL→CMD][AI]', {
                  from: body,
                  to: nlCmd,
                  conf: out?.confidence,
                  reason: out?.reason
                });
              }

              // Marca original
              msg._nlCmdRouted = true;

              const cmdMsg = cloneMsgWithBody(msg, nlCmd);
              cmdMsg._nlCmdRouted = true;

              // Ejecuta con admin router
              const handled = await tryHandleAdminCommands(client, cmdMsg);
              if (handled) {
                if (waId) markMessageHandled(waId);
                return true;
              }
            }
          } catch (e) {
            if (DEBUG) console.warn('[CORE-ROUTER][NL→CMD] err', e?.message || e);
            if (isSessionClosedError(e)) return false;
          }
        } else {
          if (DEBUG) console.warn('[CORE-ROUTER][NL→CMD] nlCommandBuilder not available');
        }
      }
    }

    // Intent router
    let intent = null;
    if (typeof classifyMessageIntent === 'function') {
      try {
        intent = await classifyMessageIntent({
          msg,
          text: body,
          context: {
            hasActiveNISession: niContext.hasActiveNISession,
            niMode: niContext.niMode
          }
        });
        if (DEBUG) console.log('[CORE-ROUTER] intent', intent);
      } catch (e) {
        console.error('[CORE-ROUTER] intentRouter error', e?.message || e);
        if (isSessionClosedError(e)) return false;
        intent = null;
      }
    } else {
      if (DEBUG) console.warn('[CORE-ROUTER] classifyMessageIntent is not available');
      intent = { intent: 'unknown', target: 'unknownHandler', reason: 'intent_router_missing', flags: {} };
    }

    // ✅ Exponer intent a routers downstream (tu requesterReply ya lo usa)
    // Mantengo compatibilidad: msg._intent = intent (objeto completo), y flags separado.
    msg._intent = intent;
    msg._intentFlags = intent?.flags || {};

    // Targets
    if (intent && intent.target === 'routeRequesterReply') {
      try {
        const handledReq = await maybeHandleRequesterReply(client, msg);
        if (handledReq) {
          if (waId) markMessageHandled(waId);
          return true;
        }
        return false;
      } catch (e) {
        if (DEBUG) console.warn('[CORE-ROUTER] requesterReply err', e?.message || e);
        if (isSessionClosedError(e)) return false;
      }
    }

    if (intent && intent.target === 'routeTeamFeedback') {
      try {
        const handledTeam = await maybeHandleTeamFeedback(client, msg);
        if (handledTeam) {
          if (waId) markMessageHandled(waId);
          return true;
        }
        return false;
      } catch (e) {
        if (DEBUG) console.warn('[CORE-ROUTER] teamFeedback(DM) err', e?.message || e);
        if (isSessionClosedError(e)) return false;
      }
    }

    if (intent && intent.target === 'smalltalkHandler') {
      try {
        const handled = await handleSmalltalk(client, msg, intent);
        if (handled) {
          if (waId) markMessageHandled(waId);
          return true;
        }
        return false;
      } catch (e) {
        if (DEBUG) console.warn('[CORE-ROUTER] smalltalk err', e?.message || e);
        if (isSessionClosedError(e)) return false;
      }
    }

    if (intent && intent.target === 'routeIncomingNI') {
      try {
        // ✅ FIX: handleTurn correcto
        await handleTurn(client, msg, opts);
        if (waId) markMessageHandled(waId);
        return true;
      } catch (e) {
        console.error('[CORE-ROUTER] N-I router error (from intent)', e?.message || e);
        if (isSessionClosedError(e)) return false;
        return false;
      }
    }

    // unknown handling
    if (intent && intent.intent === 'unknown') {
      if (DEBUG) console.log('[CORE-ROUTER] routing to unknownHandler', intent.reason || 'unknown_reason');
      try {
        const handledUnknown = await handleUnknown(client, msg, intent);

        if (handledUnknown) {
          if (waId) markMessageHandled(waId);
          return true;
        }
        return false;
      } catch (e) {
        console.error('[CORE-ROUTER] unknownHandler error', e?.message || e);
        if (isSessionClosedError(e)) return false;
        return false;
      }
    }

    // fallback soft → unknownHandler (NO marcamos handled si no se maneja)
    if (DEBUG) console.log('[CORE-ROUTER] no target handler, fallback to unknownHandler (soft)');
    try {
      const handledUnknown = await handleUnknown(client, msg, intent || { intent: 'unknown', reason: 'no_target' });

      if (handledUnknown) {
        if (waId) markMessageHandled(waId);
        return true;
      }

      // Si nadie lo manejó, opcionalmente respondemos sin romper (puedes quitarlo si no quieres ruido)
      // await safeReply(msg, '👋 Te leo. Si quieres reportar algo, dime *qué pasa* y *en dónde*.');
      return false;
    } catch (e) {
      console.error('[CORE-ROUTER] unknownHandler error (fallback)', e?.message || e);
      if (isSessionClosedError(e)) return false;
      return false;
    }
  } catch (e) {
    console.error('[CORE-ROUTER] fatal', e?.message || e);
    if (isSessionClosedError(e)) return false;

    // fallback ultra defensivo (sin reventar)
    try {
      await safeReply(msg, '⚠️ Se cayó una parte del bot. Intenta de nuevo en un momento.');
    } catch {}
    return false;
  }
}

module.exports = { handleIncomingMessage };
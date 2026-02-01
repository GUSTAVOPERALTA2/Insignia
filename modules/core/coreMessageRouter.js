// modules/core/coreMessageRouter.js

const DEBUG = (process.env.VICEBOT_DEBUG || '1') === '1';
const TICKETS_AI_ENABLED = (process.env.VICEBOT_TICKETS_AI || '1') === '1';

// ═══════════════════════════════════════════════════════════════════════════
// SEGURIDAD CENTRALIZADA
// ═══════════════════════════════════════════════════════════════════════════
const { checkAccess, getAccessDeniedMessage } = require('../state/userAccess');

// ═══════════════════════════════════════════════════════════════════════════
// SISTEMA DE SOLICITUD DE ACCESO
// ═══════════════════════════════════════════════════════════════════════════
const {
  getAccessDeniedMessageAsync,
  handleAccessRequest,
  handleAdminDecision,
  hasPendingRequest,
  hasActiveAccessSession,
} = require('../state/accessRequest');

// ✅ safeReply
const { safeReply, isSessionClosedError } = require('./safeReply');

// ✅ Intent router
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

// ✅ Router de generación de reportes con lenguaje natural
const { maybeHandleReportQuery } = require('../router/routeReportQuery');

// ✅ FIX: tu router NI exporta handleTurn
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

/**
 * ✅ FIX: WhatsApp puede mandar el texto de un mensaje con media como caption
 * y dejar msg.body vacío. Unificamos lectura aquí para TODO el core router.
 */
function getMsgText(msg) {
  const candidates = [
    msg?.body,
    msg?.caption,
    msg?._data?.caption,
    msg?._data?.body,
  ];
  const v = candidates.find(x => typeof x === 'string' && x.trim().length);
  return (v || '').trim();
}

// Folios típicos: IT-00005, MAN-011, AMA-0001, etc.
const FOLIO_RE = /\b[A-Z]{2,5}-\d{3,6}\b/i;

async function hasQuotedFolio(msg) {
  if (!msg?.hasQuotedMsg) return false;
  try {
    const quoted = await msg.getQuotedMessage();
    const qt = getMsgText(quoted) || String(quoted?._text || '').trim();
    return !!qt && FOLIO_RE.test(qt);
  } catch {
    return false;
  }
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
  // opcional: por compatibilidad con caption flows
  cmdMsg.caption = newBody;
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

    // ✅ FIX: body unificado (body/caption)
    const body = getMsgText(msg);

    // Exponer texto unificado a routers downstream (por si alguno lo quiere)
    msg._text = body;

    if (DEBUG) {
      console.log('[CORE-ROUTER] [MSG] in', {
        chatId,
        body: body || '(vacío / media)',
        hasMedia: !!msg.hasMedia,
      });
    }

    // ═══════════════════════════════════════════════════════════════════════
    // PRIMERO: Verificar si es un admin procesando solicitud de acceso
    // ═══════════════════════════════════════════════════════════════════════
    const isQuotedResponse = msg.hasQuotedMsg && /^(si|sí|no|yes|aprobar|rechazar|ok|dale|va|nope|nel)\b/i.test(body);
    const isDirectCommand = /^(aprobar|rechazar|approve|reject)\s+\d+/i.test(body);

    if (isQuotedResponse || isDirectCommand) {
      try {
        const result = await handleAdminDecision(client, msg);
        if (result.handled) {
          if (waId) markMessageHandled(waId);
          return true;
        }
      } catch (e) {
        if (DEBUG) console.warn('[CORE-ROUTER] adminDecision err', e?.message);
      }
    }

    // ═══════════════════════════════════════════════════════════════════════
    // GATE DE SEGURIDAD CENTRALIZADO
    // ═══════════════════════════════════════════════════════════════════════
    const access = checkAccess(msg);

    if (!access.allowed) {
      if (DEBUG) {
        console.log('[CORE-ROUTER] access denied', {
          reason: access.reason,
          channel: access.channel,
          chatId: chatId ? `...${chatId.slice(-10)}` : 'unknown'
        });
      }

      // Solo responder en DM, no en grupos ni broadcasts
      if (access.channel === 'dm') {
        const looksLikeAccessRequest = body && (
          body.length >= 2 &&
          /[a-záéíóúñ]{2,}/i.test(body) &&
          !body.startsWith('/')
        );

        const hasActiveSession = hasActiveAccessSession(chatId) || hasPendingRequest(chatId);

        if (hasActiveSession || looksLikeAccessRequest) {
          try {
            const result = await handleAccessRequest(client, msg);
            if (result.handled) {
              if (waId) markMessageHandled(waId);
              return true;
            }
          } catch (e) {
            if (DEBUG) console.warn('[CORE-ROUTER] accessRequest err', e?.message);
          }
        }

        try {
          const deniedMessage = await getAccessDeniedMessageAsync();
          await safeReply(msg, deniedMessage);
        } catch (e) {
          if (DEBUG) console.warn('[CORE-ROUTER] access denied reply err', e?.message);
          try {
            await safeReply(msg, getAccessDeniedMessage());
          } catch {}
        }
      }

      return false;
    }

    msg._access = access;

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
      return false;
    }

    // 1) Grupo: actualizaciones de estado, consultas y evidencias
    if (isGroupId(chatId)) {
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

      return false;
    }

    // 2) DM
    const niContext = getNiContextForChat(chatId);

    // ✅ CERO: Verificar si es respuesta a un menú de status activo
    if (!niContext.hasActiveNISession && body && /^\s*[1-9]\s*$/.test(body)) {
      try {
        const handledMenu = await maybeHandleRequesterReply(client, msg);
        if (handledMenu) {
          if (waId) markMessageHandled(waId);
          return true;
        }
      } catch (e) {
        if (DEBUG) console.warn('[CORE-ROUTER] menuSelection err', e?.message || e);
        if (isSessionClosedError(e)) return false;
      }
    }

    // ✅ PRE-FIX: si el DM cita un folio (o lo trae en el texto), priorizar requester_reply
    // incluso cuando el mensaje trae media (WhatsApp lo marca hasMedia y algunos intents lo mandan a ni_new).
    if (!niContext.hasActiveNISession && ((body && body.trim()) || msg?.hasMedia)) {
      try {
        const hasFolioInBody = !!body && FOLIO_RE.test(body);
        const quotedHasFolio = await hasQuotedFolio(msg);
        if (hasFolioInBody || quotedHasFolio) {
          const handledReq = await maybeHandleRequesterReply(client, msg);
          if (handledReq) {
            if (waId) markMessageHandled(waId);
            return true;
          }
        }
      } catch (e) {
        if (DEBUG) console.warn('[CORE-ROUTER] requesterReply(pre) err', e?.message || e);
        if (isSessionClosedError(e)) return false;
      }
    }

    // ✅ PRIMERO: Solicitudes de reportes (exportar Excel)
    if (!niContext.hasActiveNISession && body) {
      try {
        const handledReport = await maybeHandleReportQuery(client, msg);
        if (handledReport) {
          if (waId) markMessageHandled(waId);
          return true;
        }
      } catch (e) {
        if (DEBUG) console.warn('[CORE-ROUTER] reportQuery(DM) err', e?.message || e);
        if (isSessionClosedError(e)) return false;
      }
    }

    // ✅ SEGUNDO: Consultas de tickets con lenguaje natural (antes de NL→CMD)
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
    if (TICKETS_AI_ENABLED && !niContext.hasActiveNISession && body) {
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

              msg._nlCmdRouted = true;

              const cmdMsg = cloneMsgWithBody(msg, nlCmd);
              cmdMsg._nlCmdRouted = true;

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

    // ✅ Exponer intent a routers downstream
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

    // fallback soft → unknownHandler
    if (DEBUG) console.log('[CORE-ROUTER] no target handler, fallback to unknownHandler (soft)');
    try {
      const handledUnknown = await handleUnknown(client, msg, intent || { intent: 'unknown', reason: 'no_target' });

      if (handledUnknown) {
        if (waId) markMessageHandled(waId);
        return true;
      }

      return false;
    } catch (e) {
      console.error('[CORE-ROUTER] unknownHandler error (fallback)', e?.message || e);
      if (isSessionClosedError(e)) return false;
      return false;
    }
  } catch (e) {
    console.error('[CORE-ROUTER] fatal', e?.message || e);
    if (isSessionClosedError(e)) return false;

    try {
      await safeReply(msg, '⚠️ Se cayó una parte del bot. Intenta de nuevo en un momento.');
    } catch {}
    return false;
  }
}

module.exports = { handleIncomingMessage };

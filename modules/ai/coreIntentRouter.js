// modules/ai/coreIntentRouter.js
// Cerebro general / triage de mensajes.
//
// Responsabilidades:
//  - Determinar tipo de mensaje (intención "macro"):
//      * command           → comandos tipo "/bind", "/stats"
//      * ni_new/ni_turn    → flujo de Nueva Incidencia
//      * requester_feedback→ feedback del solicitante sobre un ticket
//      * team_feedback     → feedback del equipo sobre un ticket
//      * smalltalk         → saludos, conversación ligera, preguntas meta
//      * help              → preguntas tipo "qué puedes hacer", "ayuda"
//      * unknown           → no se pudo clasificar bien
//  - Derivar target lógico:
//      * routeIncomingNI
//      * routeRequesterReply
//      * routeTeamFeedback
//      * commandRouter
//      * smalltalkHandler
//
// NO hace:
//  - No crea/actualiza tickets
//  - No decide next_status
//  - No maneja el flujo interno de N-I
//
// La idea es que el router central haga algo como:
//
//   const { classifyMessageIntent } = require('../ai/coreIntentRouter');
//   const res = await classifyMessageIntent({ msg, text, context });
//   switch (res.target) {
//     case 'commandRouter':       return commandRouter.handle(msg);
//     case 'routeIncomingNI':     return routeIncomingNI.handleTurn(client, msg, { ... });
//     case 'routeRequesterReply': return routeRequesterReply.maybeHandleRequesterReply(client, msg);
//     case 'routeTeamFeedback':   return routeTeamFeedback.maybeHandleTeamFeedback(client, msg);
//     case 'smalltalkHandler':    return smalltalkHandler.handle(msg, res);
//     default:
//       // fallback/unknown
//   }
//

const DEBUG = (process.env.VICEBOT_DEBUG || '1') === '1';

// FOLIO típico: MANT-00123, IT-999999, etc.
const FOLIO_RE = /\b[A-Z]{2,8}-\d{3,6}\b/;

// Palabras que suelen indicar problema/incidencia
const INCIDENT_HINTS = [
  'no sirve', 'no prende', 'no enciende',
  'no hay', 'se descompuso', 'se desconfiguró', 'se desconfiguro',
  'fallando', 'está fallando', 'esta fallando',
  'fuga', 'gotea', 'rompió', 'rompio', 'tirando agua',
  'no funciona', 'apagado', 'prende y se apaga',
  'necesito ayuda', 'ayuda mantenimiento', 'ayuda sistemas', 'ayuda limpieza'
];

// Palabras que suelen ser saludos / smalltalk
const GREETING_HINTS = [
  'hola', 'buen dia', 'buen día', 'buenas', 'buenos dias',
  'buenos días', 'hey', 'hi', 'hello', 'qué tal', 'que tal'
];

// Preguntas meta sobre el bot
const META_BOT_HINTS = [
  'como te llamas', 'cómo te llamas',
  'quien eres', 'quién eres',
  'que eres', 'qué eres',
  'que puedes hacer', 'qué puedes hacer',
  'como funcionas', 'cómo funcionas'
];

// Preguntas tipo ayuda
const HELP_HINTS = [
  'ayuda', 'help', 'como uso', 'cómo uso',
  'como funciona esto', 'cómo funciona esto',
  'que hago', 'qué hago'
];

// 🔹 NUEVO: patrones de “pregunta de estatus” del ticket (sin folio)
const STATUS_QUERY_HINTS = [
  'como va',
  'cómo va',
  'como vamos',
  'cómo vamos',
  'como sigue',
  'cómo sigue',
  'como van',
  'cómo van',
  'que ha pasado',
  'qué ha pasado',
  'que paso con',
  'qué pasó con',
  'ya quedaron',
  'ya lo arreglaron',
  'ya vinieron',
  'han venido',
  'van a venir',
  'estatus',
  'status',
  'estado del ticket',
  'estatus del ticket',
  'estado del reporte',
  'estatus del reporte',
  'como va el servicio',
  'cómo va el servicio',
];

// Helper: normalizar texto básico
function norm(text = '') {
  return String(text)
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

function containsAny(haystack, needles) {
  const t = norm(haystack);
  return needles.some(n => t.includes(norm(n)));
}

// Detecciones sencillas
function looksLikeCommand(text) {
  return /^\/\w+/.test(String(text).trim());
}

function isShortGreeting(text) {
  const t = norm(text);
  if (!t) return false;
  if (t.length > 40) return false; // saludos suelen ser cortos
  return containsAny(t, GREETING_HINTS);
}

function looksLikeMetaBotQuestion(text) {
  return containsAny(text, META_BOT_HINTS);
}

function looksLikeHelpQuestion(text) {
  const t = norm(text);
  if (containsAny(t, HELP_HINTS)) return true;
  // Preguntas cortas con "ayuda"
  if (t.includes('ayuda') && t.length < 80) return true;
  return false;
}

function looksIncidentLike(text) {
  const t = norm(text);
  if (t.length < 8) return false;
  if (containsAny(t, INCIDENT_HINTS)) return true;
  // Heurística general: contiene "no" + verbo común
  if (/no\s+(sirve|funciona|enciende|hay)\b/.test(t)) return true;
  return false;
}

// NEW: smalltalk social tipo "como te va", "como estas", "que onda"
function looksLikeSocialSmalltalk(text = '') {
  const t = norm(text);
  if (!t) return false;
  if (t.length > 80) return false; // cosas cortas / medianas

  const socialRe = /^(como estas|como te va|que tal|que onda|como andas|qué tal|qué onda)\b/;

  const hasGreeting = containsAny(t, GREETING_HINTS);
  const isSocialQuestion = socialRe.test(t);
  const isIncident = looksIncidentLike(text); // sobre texto crudo

  return (hasGreeting || isSocialQuestion) && !isIncident;
}

// 🔹 NUEVO: ¿parece pregunta de estatus del ticket?
function looksLikeStatusQuery(text = '') {
  const t = norm(text);
  if (!t) return false;
  // Acotamos a mensajes relativamente cortos/medios
  if (t.length > 140) return false;
  return STATUS_QUERY_HINTS.some(h => t.includes(h));
}

// ¿Es DM (huésped/solicitante) o grupo (equipo)?
function isGroupChatId(chatId = '') {
  return /@g\.us$/.test(String(chatId));
}

// ¿Parece feedback sobre ticket? (folio o reply con folio)
function looksLikeTicketFeedback({ text, hasFolioInBody, hasQuotedFolio }) {
  if (hasFolioInBody || hasQuotedFolio) return true;
  // También podemos considerar DMs cortos tipo "gracias, ya quedó" → requesterReply.js afina
  const t = norm(text);
  if (t.length <= 60 && (t.includes('gracias') || t.includes('ya quedo') || t.includes('ya quedó'))) {
    return true;
  }
  return false;
}

/**
 * Extrae señales básicas de un mensaje.
 */
async function extractBasicSignals({ msg, text }) {
  const body = text || msg.body || '';
  const tNorm = norm(body);

  const chatId = msg.from || '';
  const isGroup = isGroupChatId(chatId);
  const fromMe  = !!msg.fromMe;

  // FOLIO en el cuerpo
  const hasFolioInBody = FOLIO_RE.test(String(body).toUpperCase());

  // FOLIO en mensaje citado (si aplica)
  let hasQuotedFolio = false;
  if (msg.hasQuotedMsg && typeof msg.getQuotedMessage === 'function') {
    try {
      const quoted = await msg.getQuotedMessage();
      if (quoted && FOLIO_RE.test(String(quoted.body || '').toUpperCase())) {
        hasQuotedFolio = true;
      }
    } catch {
      // ignoramos errores silenciosamente
    }
  }

  const isGreeting         = isShortGreeting(body);
  const isCommand          = looksLikeCommand(body);
  const isMetaBot          = looksLikeMetaBotQuestion(body);
  const isHelpLike         = looksLikeHelpQuestion(body);
  const isIncidentLike     = looksIncidentLike(body);
  const isSocialSmalltalk  = looksLikeSocialSmalltalk(body);
  const isStatusQuery      = looksLikeStatusQuery(body); // 🔹 NUEVO

  return {
    body,
    tNorm,
    chatId,
    isGroup,
    fromMe,
    hasFolioInBody,
    hasQuotedFolio,
    isGreeting,
    isCommand,
    isMetaBot,
    isHelpLike,
    isIncidentLike,
    isSocialSmalltalk,
    isStatusQuery, // 🔹 NUEVO
  };
}

/**
 * Clasificador principal de intención.
 *
 * @param {Object} params
 * @param {Object} params.msg      - mensaje de whatsapp-web.js
 * @param {string} [params.text]   - texto ya extraído/limpio
 * @param {Object} [params.context]- banderas de contexto opcionales:
 *   - hasActiveNISession: bool
 *   - niMode: string ('ask_place','confirm',etc.)
 *   - isKnownStaff: bool
 *
 * Devuelve:
 *   {
 *     intent: 'command'|'ni_new'|'ni_turn'|'requester_feedback'|'team_feedback'|'smalltalk'|'help'|'unknown',
 *     target: 'commandRouter'|'routeIncomingNI'|'routeRequesterReply'|'routeTeamFeedback'|'smalltalkHandler'|null,
 *     confidence: number (0..1),
 *     reason: string,
 *     flags: {...}
 *   }
 */
async function classifyMessageIntent({ msg, text, context = {} }) {
  const signals = await extractBasicSignals({ msg, text });
  const {
    body,
    tNorm,
    chatId,
    isGroup,
    fromMe,
    hasFolioInBody,
    hasQuotedFolio,
    isGreeting,
    isCommand,
    isMetaBot,
    isHelpLike,
    isIncidentLike,
    isSocialSmalltalk,
    isStatusQuery, // 🔹 NUEVO
  } = signals;

  const { hasActiveNISession = false, niMode = null, isKnownStaff = false } = context;

  if (DEBUG) {
    console.log('[INTENT] signals', {
      chatId,
      isGroup,
      fromMe,
      hasActiveNISession,
      niMode,
      hasFolioInBody,
      hasQuotedFolio,
      isGreeting,
      isCommand,
      isMetaBot,
      isHelpLike,
      isIncidentLike,
      isSocialSmalltalk,
      isStatusQuery, // 🔹 NUEVO
      tNorm
    });
  }

  // 0) Mensajes propios del bot → normalmente ignorar en intent router
  if (fromMe) {
    return {
      intent: 'self_message',
      target: null,
      confidence: 1.0,
      reason: 'from_me',
      flags: { ...signals }
    };
  }

  // 1) Comandos
  if (isCommand) {
    return {
      intent: 'command',
      target: 'commandRouter',
      confidence: 0.99,
      reason: 'starts_with_slash',
      flags: { ...signals }
    };
  }

  // 2) Meta / ayuda / smalltalk
  if (isMetaBot) {
    return {
      intent: 'smalltalk',
      target: 'smalltalkHandler',
      confidence: 0.95,
      reason: 'meta_bot_question',
      flags: { ...signals, isMetaBot: true }
    };
  }

  // 2.a) Mensajes tipo "ayuda" que claramente describen un problema en DM → N-I
  if (isHelpLike && isIncidentLike && !isGroup) {
    return {
      intent: 'ni_new',
      target: 'routeIncomingNI',
      confidence: 0.9,
      reason: 'help_incident_combo_dm',
      flags: { ...signals, isHelp: true, forcedNiNew: true }
    };
  }

  if (isHelpLike) {
    return {
      intent: 'help',
      target: 'smalltalkHandler',
      confidence: 0.9,
      reason: 'help_like_question',
      flags: { ...signals, isHelp: true }
    };
  }

  if (isGreeting && !isIncidentLike && !hasFolioInBody && !hasQuotedFolio) {
    // Saludo corto sin señales de problema → smalltalk
    return {
      intent: 'smalltalk',
      target: 'smalltalkHandler',
      confidence: 0.9,
      reason: 'short_greeting_no_incident',
      flags: { ...signals }
    };
  }

  // 3) Feedback con folio (cuerpo o quoted)
  if (looksLikeTicketFeedback({ text: body, hasFolioInBody, hasQuotedFolio })) {
    if (isGroup || isKnownStaff) {
      // Grupo de staff → feedback del equipo
      return {
        intent: 'team_feedback',
        target: 'routeTeamFeedback',
        confidence: 0.9,
        reason: 'folio_or_ack_in_group',
        flags: { ...signals }
      };
    }
    // DM → feedback del solicitante
    return {
      intent: 'requester_feedback',
      target: 'routeRequesterReply',
      confidence: 0.9,
      reason: 'folio_or_ack_in_dm',
      flags: { ...signals }
    };
  }

  // 🔹 3.b) DM: pregunta de estatus SIN folio / SIN quoted → routeRequesterReply
  if (!isGroup && isStatusQuery && !hasFolioInBody && !hasQuotedFolio) {
    return {
      intent: 'requester_feedback',
      target: 'routeRequesterReply',
      confidence: 0.8,
      reason: 'status_query_no_folio_dm',
      flags: { ...signals, isStatusQuery: true }
    };
  }

  // 4) Si ya hay sesión NI activa, casi seguro es un turno de N-I
  if (hasActiveNISession) {
    return {
      intent: 'ni_turn',
      target: 'routeIncomingNI',
      confidence: 0.9,
      reason: 'hasActiveNISession',
      flags: { ...signals }
    };
  }

  // 5) DMs con pinta de incidencia → nueva N-I
  if (!isGroup && isIncidentLike) {
    return {
      intent: 'ni_new',
      target: 'routeIncomingNI',
      confidence: 0.85,
      reason: 'dm_incident_like',
      flags: { ...signals }
    };
  }

  // 6) DMs más largos con signo de pregunta al final → probablemente pregunta / smalltalk
  //    (si no caímos antes en status_query ni en meta/help)
  if (!isGroup && /\?\s*$/.test(body) && body.length < 150) {
    return {
      intent: 'smalltalk',
      target: 'smalltalkHandler',
      confidence: 0.7,
      reason: 'short_question_no_ticket',
      flags: { ...signals }
    };
  }

  // 6 bis) Smalltalk social sin signo de pregunta (como te va, como estas, que onda, etc.)
  if (!isGroup && !hasFolioInBody && !hasQuotedFolio && isSocialSmalltalk) {
    return {
      intent: 'smalltalk',
      target: 'smalltalkHandler',
      confidence: 0.8,
      reason: 'social_smalltalk',
      flags: { ...signals }
    };
  }

  // 7) En grupos sin folio: por defecto lo dejamos a otros routers (team smalltalk o ignorable)
  if (isGroup && !hasFolioInBody && !hasQuotedFolio && !isIncidentLike) {
    return {
      intent: 'smalltalk',
      target: 'smalltalkHandler',
      confidence: 0.6,
      reason: 'group_smalltalk_or_chatter',
      flags: { ...signals }
    };
  }

  // 8) Fallback: DM con enunciado genérico → lo tratamos como UNKNOWN, no forzamos N-I
  if (!isGroup && body.length >= 10 && !/\?\s*$/.test(body)) {
    return {
      intent: 'unknown',
      target: 'unknownHandler',
      confidence: 0.6,
      reason: 'dm_generic_statement_unknown_fallback',
      flags: { ...signals, forcedUnknown: true }
    };
  }

  // 9) Último recurso: unknown
  return {
    intent: 'unknown',
    target: null,
    confidence: 0.4,
    reason: 'no_strong_signals',
    flags: { ...signals }
  };
}

module.exports = {
  classifyMessageIntent
};

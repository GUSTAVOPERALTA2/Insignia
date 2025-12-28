// modules/ai/coreIntentRouter.js
// VERSIÓN MEJORADA: Mejor detección de incidentes vs ayuda general

const DEBUG = (process.env.VICEBOT_DEBUG || '1') === '1';

const FOLIO_RE = /\b[A-Z]{2,8}-\d{3,6}\b/;

// ✅ AMPLIADO: Palabras que indican un problema/incidencia
const INCIDENT_HINTS = [
  // Problemas generales
  'no sirve', 'no prende', 'no enciende', 'no hay', 'se descompuso',
  'fallando', 'falla', 'fallo', 'no funciona', 'dejo de funcionar',
  'apagado', 'apagada', 'descompuesto', 'descompuesta',
  // Agua/plomería
  'fuga', 'gotea', 'goteo', 'tirando agua', 'tapado', 'tapada',
  'atascado', 'atascada', 'no cae agua', 'sin agua', 'agua fria',
  'agua caliente', 'regadera', 'lavamanos', 'lavabo', 'inodoro', 'wc',
  // Eléctrico
  'corto', 'cortocircuito', 'chispa', 'quemado', 'quemada', 'fundido',
  'sin luz', 'no hay luz', 'apagon', 'contacto', 'enchufe',
  // A/C
  'aire', 'clima', 'a/c', 'ac', 'no enfria', 'muy frio', 'muy caliente',
  // Mecánico/estructural
  'trabado', 'trabada', 'atorado', 'atorada', 'roto', 'rota',
  'rompio', 'quebrado', 'quebrada', 'dañado', 'dañada',
  'no abre', 'no cierra', 'flojo', 'floja', 'caido', 'caida',
  // Limpieza
  'sucio', 'sucia', 'manchado', 'manchada', 'huele', 'olor', 'basura',
  'cucaracha', 'insecto', 'bicho', 'hormiga',
  // Mobiliario
  'cortina', 'persiana', 'lampara', 'foco', 'television', 'tv', 'tele',
  'control', 'puerta', 'ventana', 'llave', 'cerradura', 'chapa',
  'cama', 'colchon', 'sabana', 'toalla', 'almohada',
  // Urgencia
  'urgente', 'urge', 'emergencia', 'inmediato',
  // Solicitud de servicio
  'necesito', 'ocupo', 'requiero', 'hace falta', 'falta',
];

// ✅ NUEVO: Patrones regex para detectar incidentes
const INCIDENT_PATTERNS = [
  /no\s+(sirve|funciona|enciende|prende|hay|abre|cierra|enfria|calienta)\b/i,
  /esta\s+(tapado|tapada|roto|rota|trabado|trabada|atorado|atorada|sucio|sucia|dañado|dañada)\b/i,
  /se\s+(rompio|descompuso|atoro|trabo|tapo|cayo|quemo|fundio)\b/i,
  /\b(fuga|goteo|gotera)\s+(de|en)?\s*(agua)?\b/i,
  /\b(sin|no\s+hay)\s+(agua|luz|señal|internet|wifi)\b/i,
  /\b(habitacion|hab|cuarto|room)\s*\d{3,4}\b/i,
  /^\d{4}\b/i, // Empieza con número de habitación
];

const GREETING_HINTS = [
  'hola', 'buen dia', 'buenos dias', 'buenas tardes', 'buenas noches',
  'hey', 'hi', 'hello', 'que tal', 'como estas'
];

const META_BOT_HINTS = [
  'como te llamas', 'quien eres', 'que eres', 'que puedes hacer',
  'eres un bot', 'eres robot', 'eres humano'
];

// ✅ MODIFICADO: Ayuda general (sin contexto de problema)
const HELP_HINTS = ['como uso', 'como funciona', 'instrucciones', 'tutorial'];

const STATUS_QUERY_HINTS = [
  'como va', 'como vamos', 'como sigue', 'que ha pasado',
  'ya quedaron', 'ya lo arreglaron', 'estatus', 'status',
  'alguna novedad', 'hay novedad', 'ya esta listo'
];

function norm(text = '') {
  return String(text)
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/@\d+/g, '') // Eliminar menciones
    .trim();
}

function containsAny(haystack, needles) {
  const t = norm(haystack);
  return needles.some(n => t.includes(norm(n)));
}

function matchesAnyPattern(text, patterns) {
  const t = norm(text);
  return patterns.some(p => p.test(t));
}

function looksLikeCommand(text) {
  return /^\/\w+/.test(String(text).trim());
}

function isShortGreeting(text) {
  const t = norm(text);
  if (!t) return false;
  if (t.length > 40) return false;
  return containsAny(t, GREETING_HINTS);
}

function looksLikeMetaBotQuestion(text) {
  return containsAny(text, META_BOT_HINTS);
}

// ✅ MODIFICADO: Ayuda general solo si NO tiene indicios de problema
function looksLikeHelpQuestion(text) {
  const t = norm(text);
  // Si contiene hints de ayuda general
  if (containsAny(t, HELP_HINTS)) return true;
  // "ayuda" solo si es muy corto y sin número de habitación
  if (t.includes('ayuda') && t.length < 30 && !/\d{4}/.test(t)) return true;
  return false;
}

// ✅ MEJORADO: Detección de incidentes más robusta
function looksIncidentLike(text) {
  const t = norm(text);
  if (t.length < 6) return false;
  
  // 1) Contiene palabras clave de incidente
  if (containsAny(t, INCIDENT_HINTS)) return true;
  
  // 2) Coincide con patrones de incidente
  if (matchesAnyPattern(t, INCIDENT_PATTERNS)) return true;
  
  // 3) Tiene número de habitación (4 dígitos) + algo más
  if (/\b\d{4}\b/.test(t) && t.length > 10) return true;
  
  return false;
}

// ✅ NUEVO: Detectar si parece reporte de habitación
function hasRoomNumber(text) {
  const t = norm(text);
  return /\b\d{4}\b/.test(t);
}

function looksLikeStatusQuery(text = '') {
  const t = norm(text);
  if (!t) return false;
  if (t.length > 140) return false;
  return STATUS_QUERY_HINTS.some(h => t.includes(h));
}

function isGroupChatId(chatId = '') {
  return /@g\.us$/.test(String(chatId));
}

function looksLikeTicketFeedback({ text, hasFolioInBody, hasQuotedFolio }) {
  if (hasFolioInBody || hasQuotedFolio) return true;
  const t = norm(text);
  if (t.length <= 60 && (t.includes('gracias') || t.includes('ya quedo'))) {
    return true;
  }
  return false;
}

async function extractBasicSignals({ msg, text }) {
  const body = text || msg.body || '';
  const tNorm = norm(body);
  const chatId = msg.from || '';
  const isGroup = isGroupChatId(chatId);
  const fromMe = !!msg.fromMe;

  const hasFolioInBody = FOLIO_RE.test(String(body).toUpperCase());

  let hasQuotedFolio = false;
  if (msg.hasQuotedMsg && typeof msg.getQuotedMessage === 'function') {
    try {
      const quoted = await msg.getQuotedMessage();
      if (quoted && FOLIO_RE.test(String(quoted.body || '').toUpperCase())) {
        hasQuotedFolio = true;
      }
    } catch {}
  }

  const isGreeting = isShortGreeting(body);
  const isCommand = looksLikeCommand(body);
  const isMetaBot = looksLikeMetaBotQuestion(body);
  const isHelpLike = looksLikeHelpQuestion(body);
  const isIncidentLike = looksIncidentLike(body);
  const isStatusQuery = looksLikeStatusQuery(body);
  const hasRoom = hasRoomNumber(body);

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
    isStatusQuery,
    hasRoom,
  };
}

/**
 * ✅ ESTRATEGIA MEJORADA:
 * - Comandos → commandRouter
 * - Folios / feedback → routeRequesterReply o routeTeamFeedback
 * - Saludos puros (sin problema) → smalltalk
 * - Meta bot → smalltalk
 * - Mensajes con número de habitación + contexto → N-I (prioridad alta)
 * - Mensajes con indicios de problema → N-I
 * - TODO LO DEMÁS en DM → N-I (por defecto)
 */
async function classifyMessageIntent({ msg, text, context = {} }) {
  const signals = await extractBasicSignals({ msg, text });
  const {
    body,
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
    isStatusQuery,
    hasRoom,
  } = signals;

  const { hasActiveNISession = false } = context;

  if (DEBUG) {
    console.log('[INTENT] signals', {
      chatId,
      isGroup,
      hasActiveNISession,
      hasFolioInBody,
      hasQuotedFolio,
      isGreeting,
      isCommand,
      isMetaBot,
      isHelpLike,
      isIncidentLike,
      isStatusQuery,
      hasRoom,
    });
  }

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

  // 2) Meta / ayuda sobre el bot
  if (isMetaBot) {
    return {
      intent: 'smalltalk',
      target: 'smalltalkHandler',
      confidence: 0.95,
      reason: 'meta_bot_question',
      flags: { ...signals, isMetaBot: true }
    };
  }

  // ✅ PRIORIDAD ALTA: Mensaje con número de habitación → probablemente es reporte
  if (!isGroup && hasRoom && body.length >= 15) {
    return {
      intent: 'ni_new',
      target: 'routeIncomingNI',
      confidence: 0.92,
      reason: 'has_room_number_dm',
      flags: { ...signals, hasRoom: true }
    };
  }

  // ✅ Si tiene indicios claros de incidente → N-I
  if (!isGroup && isIncidentLike) {
    return {
      intent: 'ni_new',
      target: 'routeIncomingNI',
      confidence: 0.9,
      reason: 'incident_like_dm',
      flags: { ...signals }
    };
  }

  // ✅ Ayuda general (sin problema específico, sin habitación)
  if (isHelpLike && !isIncidentLike && !hasRoom) {
    return {
      intent: 'help',
      target: 'smalltalkHandler',
      confidence: 0.9,
      reason: 'help_like_question',
      flags: { ...signals, isHelp: true }
    };
  }

  // Saludos PUROS (sin folio, sin problema, sin habitación)
  if (isGreeting && !isIncidentLike && !hasFolioInBody && !hasQuotedFolio && !hasRoom && body.length < 50) {
    return {
      intent: 'smalltalk',
      target: 'smalltalkHandler',
      confidence: 0.9,
      reason: 'short_greeting_no_incident',
      flags: { ...signals }
    };
  }

  // 3) Feedback con folio
  if (looksLikeTicketFeedback({ text: body, hasFolioInBody, hasQuotedFolio })) {
    if (isGroup) {
      return {
        intent: 'team_feedback',
        target: 'routeTeamFeedback',
        confidence: 0.9,
        reason: 'folio_in_group',
        flags: { ...signals }
      };
    }
    return {
      intent: 'requester_feedback',
      target: 'routeRequesterReply',
      confidence: 0.9,
      reason: 'folio_in_dm',
      flags: { ...signals }
    };
  }

  // 4) Pregunta de estatus SIN folio → routeRequesterReply
  if (!isGroup && isStatusQuery && !hasFolioInBody && !hasQuotedFolio) {
    return {
      intent: 'requester_feedback',
      target: 'routeRequesterReply',
      confidence: 0.8,
      reason: 'status_query_no_folio_dm',
      flags: { ...signals, isStatusQuery: true }
    };
  }

  // 5) Sesión N-I activa → N-I
  if (hasActiveNISession) {
    return {
      intent: 'ni_turn',
      target: 'routeIncomingNI',
      confidence: 0.9,
      reason: 'hasActiveNISession',
      flags: { ...signals }
    };
  }

  // ✅ DEFAULT: TODO DM que no sea saludo puro → N-I
  if (!isGroup && body.length >= 8) {
    return {
      intent: 'ni_new',
      target: 'routeIncomingNI',
      confidence: 0.85,
      reason: 'dm_default_to_ni',
      flags: { ...signals }
    };
  }

  // 7) Grupos sin folio → ignorar o smalltalk
  if (isGroup && !hasFolioInBody && !hasQuotedFolio) {
    return {
      intent: 'smalltalk',
      target: 'smalltalkHandler',
      confidence: 0.6,
      reason: 'group_chatter',
      flags: { ...signals }
    };
  }

  // 8) Fallback
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
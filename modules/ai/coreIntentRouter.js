// modules/ai/coreIntentRouter.js
// VERSIÓN FINAL (AJUSTADA): Incidencias (N-I) conservador, smalltalk y unknown SOLO cuando es claramente no-incidencia

const DEBUG = (process.env.VICEBOT_DEBUG || '1') === '1';

const FOLIO_RE = /\b[A-Z]{2,8}-\d{3,6}\b/;

// ─────────────────────────────────────────────
// Palabras que indican un problema/incidencia
// ─────────────────────────────────────────────
const INCIDENT_HINTS = [
  'no sirve','no prende','no enciende','no hay','se descompuso',
  'fallando','falla','fallo','no funciona','dejo de funcionar',
  'apagado','apagada','descompuesto','descompuesta',
  'fuga','gotea','goteo','tirando agua','tapado','tapada',
  'atascado','atascada','no cae agua','sin agua','agua fria','agua caliente',
  'regadera','lavamanos','lavabo','inodoro','wc',
  'corto','cortocircuito','chispa','quemado','quemada','fundido',
  'sin luz','no hay luz','apagon','contacto','enchufe',
  'aire','clima','a/c','ac','no enfria','muy frio','muy caliente',
  'trabado','trabada','atorado','atorada','roto','rota','rompio',
  'quebrado','quebrada','dañado','dañada',
  'sucio','sucia','manchado','manchada','huele','olor','basura',
  'cucaracha','insecto','bicho','hormiga',
  'urgente','urge','emergencia','inmediato',
  'necesito','ocupo','requiero','hace falta','falta'
];

const INCIDENT_PATTERNS = [
  /no\s+(sirve|funciona|enciende|prende|hay|abre|cierra|enfria|calienta)\b/i,
  /esta\s+(tapado|tapada|roto|rota|sucio|sucia|dañado|dañada)\b/i,
  /se\s+(rompio|descompuso|atoro|trabo|tapo|cayo|quemo)\b/i,
  /\b(fuga|goteo|gotera)\b/i,
  /\b(sin|no\s+hay)\s+(agua|luz|internet|wifi)\b/i,
  /\b(habitacion|hab|cuarto|room)\s*\d{3,4}\b/i,
  /^\d{4}\b/
];

const GREETING_HINTS = [
  'hola','buen dia','buenos dias','buenas tardes','buenas noches',
  'hey','hi','hello','que tal','como estas'
];

const META_BOT_HINTS = [
  'como te llamas','quien eres','que eres','que puedes hacer',
  'eres un bot','eres robot','eres humano'
];

const HELP_HINTS = ['como uso','como funciona','instrucciones','tutorial'];

const STATUS_QUERY_HINTS = [
  'como va','como vamos','como sigue','que ha pasado',
  'ya quedaron','ya lo arreglaron','estatus','status',
  'alguna novedad','hay novedad','ya esta listo'
];

// ─────────────────────────────────────────────
// Utils
// ─────────────────────────────────────────────
function norm(text = '') {
  return String(text)
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/@\d+/g, '')
    .trim();
}

function escapeRegExp(s) {
  return String(s || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ✅ FIX: tokens cortos como "ac" NO deben matchear dentro de "space"
// - needles de 1–3 chars => palabra completa (\b..\b)
// - frases/largos => substring normal
function containsAny(haystack, needles) {
  const t = norm(haystack);
  if (!t) return false;

  return (needles || []).some((n) => {
    const nn = norm(n);
    if (!nn) return false;

    // tokens cortos => match por palabra completa
    // (ac, wc, tv, rs, etc.)
    if (nn.length <= 3) {
      const re = new RegExp(`\\b${escapeRegExp(nn)}\\b`, 'i');
      return re.test(t);
    }

    // frases normales => substring
    return t.includes(nn);
  });
}

function matchesAnyPattern(text, patterns) {
  const t = norm(text);
  return patterns.some(p => p.test(t));
}

function looksLikeCommand(text) {
  return /^\/\w+/.test(String(text).trim());
}

function isGroupChatId(chatId = '') {
  return /@g\.us$/.test(String(chatId));
}

function looksIncidentLike(text) {
  const t = norm(text);
  if (t.length < 6) return false;

  // 1) keywords (con fix de tokens cortos)
  if (containsAny(t, INCIDENT_HINTS)) return true;

  // 2) patrones regex
  if (matchesAnyPattern(t, INCIDENT_PATTERNS)) return true;

  // 3) habitación 4 dígitos + algo más
  if (/\b\d{4}\b/.test(t) && t.length > 10) return true;

  return false;
}

function looksLikeHelpQuestion(text) {
  const t = norm(text);
  if (containsAny(t, HELP_HINTS)) return true;
  if (t.includes('ayuda') && t.length < 30 && !/\d{4}/.test(t)) return true;
  return false;
}

function looksLikeMetaBotQuestion(text) {
  return containsAny(text, META_BOT_HINTS);
}

function isShortGreeting(text) {
  const t = norm(text);
  if (!t || t.length > 40) return false;
  return containsAny(t, GREETING_HINTS);
}

function looksLikeStatusQuery(text) {
  const t = norm(text);
  if (!t || t.length > 140) return false;
  return STATUS_QUERY_HINTS.some(h => t.includes(h));
}

function hasRoomNumber(text) {
  return /\b\d{4}\b/.test(norm(text));
}

function looksLikeTicketFeedback({ text, hasFolioInBody, hasQuotedFolio }) {
  if (hasFolioInBody || hasQuotedFolio) return true;
  const t = norm(text);
  return t.length <= 60 && (t.includes('gracias') || t.includes('ya quedo'));
}

// ─────────────────────────────────────────────
// ✅ NUEVO: Unknown SOLO cuando es claramente NO-incidencia
// ─────────────────────────────────────────────
function hasAnyNumber(text = '') {
  return /\b\d{3,6}\b/.test(norm(text));
}

function hasHotelContextWord(text = '') {
  const t = norm(text);
  return /\b(hab(itacion)?|room|villa|torre|piso|elevador|pasillo|lobby|recepcion|front\s*desk|spa|alberca|piscina|restaurante|bar|cocina|mantenimiento|hs?kp|ama|it|seguridad|puerta|llave|regadera|wc|inodoro|aire|clima|tv|tele|internet|wifi|router|switch|impresora)\b/.test(t);
}

function looksLikeGeneralQuestion(text = '') {
  const raw = String(text || '');
  const t = norm(raw);
  if (!t) return false;

  if (/[¿?]/.test(raw)) return true;

  if (/^(que|quien|quienes|como|donde|cuando|por\s+que|porque|cual|cuanto|cuantos)\b/.test(t)) return true;

  if (/\b(explica|define|significa|historia|resumen|recomienda|recomiendas|has\s+jugado|conoces|sabes)\b/.test(t)) return true;

  return false;
}

/**
 * ✅ Alta precisión: solo manda a unknown si es MUY probablemente charla general.
 * Si hay cualquier olor de hotel/operación, NO lo manda a unknown.
 */
function isClearlyNonIncident(text = '') {
  const t = norm(text);
  if (!t) return false;

  if (!looksLikeGeneralQuestion(text)) return false;

  // Si menciona habitación o números con contexto hotelero → NO
  if (hasRoomNumber(t)) return false;
  if (hasAnyNumber(t) && hasHotelContextWord(t)) return false;

  // Si huele a incidente (keywords o patrones) → NO
  if (looksIncidentLike(t)) return false;

  // Si menciona contexto de hotel (aunque sea pregunta) → NO (conservador)
  // Si quieres que "horario del spa" caiga en unknown, cambia a: `return true;`
  if (hasHotelContextWord(t)) return false;

  return true;
}

// ─────────────────────────────────────────────
// Señales básicas
// ─────────────────────────────────────────────
async function extractBasicSignals({ msg, text }) {
  const body = text || msg.body || '';
  const chatId = msg.from || '';
  const isGroup = isGroupChatId(chatId);
  const fromMe = !!msg.fromMe;
  const hasMedia = !!msg.hasMedia;  // ✅ NUEVO: detectar si tiene media

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

  return {
    body,
    tNorm: norm(body),
    chatId,
    isGroup,
    fromMe,
    hasMedia,  // ✅ NUEVO
    hasFolioInBody,
    hasQuotedFolio,
    isGreeting: isShortGreeting(body),
    isCommand: looksLikeCommand(body),
    isMetaBot: looksLikeMetaBotQuestion(body),
    isHelpLike: looksLikeHelpQuestion(body),
    isIncidentLike: looksIncidentLike(body),
    isStatusQuery: looksLikeStatusQuery(body),
    hasRoom: hasRoomNumber(body),
  };
}

// ─────────────────────────────────────────────
// Clasificador principal
// ─────────────────────────────────────────────
async function classifyMessageIntent({ msg, text, context = {} }) {
  const signals = await extractBasicSignals({ msg, text });
  const {
    body,
    chatId,
    isGroup,
    fromMe,
    hasMedia,  // ✅ NUEVO
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
      chatId, isGroup, hasActiveNISession, hasMedia,
      isGreeting, isCommand, isMetaBot,
      isHelpLike, isIncidentLike, isStatusQuery, hasRoom
    });
  }

  if (fromMe) {
    return { intent:'self_message', target:null, confidence:1, reason:'from_me', flags:signals };
  }

  if (isCommand) {
    return { intent:'command', target:'commandRouter', confidence:0.99, reason:'slash', flags:signals };
  }

  // ✅ CRÍTICO: Si hay sesión NI activa, TODO va a routeIncomingNI
  // (incluyendo saludos, smalltalk, etc. - el handler de NI decidirá qué hacer)
  if (hasActiveNISession) {
    return { intent:'ni_turn', target:'routeIncomingNI', confidence:0.9, reason:'active_ni', flags:signals };
  }

  // ✅ NUEVO: Si tiene media (imagen/archivo), enviar a N-I para que se almacene
  // Esto permite que el usuario envíe primero una foto y luego la descripción
  if (!isGroup && hasMedia) {
    return { intent:'ni_new', target:'routeIncomingNI', confidence:0.85, reason:'dm_has_media', flags:signals };
  }

  // Solo si NO hay sesión NI activa, procesar smalltalk
  if (isMetaBot || isHelpLike || isGreeting) {
    return { intent:'smalltalk', target:'smalltalkHandler', confidence:0.9, reason:'smalltalk', flags:signals };
  }

  if (!isGroup && (hasRoom || isIncidentLike)) {
    return { intent:'ni_new', target:'routeIncomingNI', confidence:0.9, reason:'incident_dm', flags:signals };
  }

  if (looksLikeTicketFeedback({ text: body, hasFolioInBody, hasQuotedFolio })) {
    return isGroup
      ? { intent:'team_feedback', target:'routeTeamFeedback', confidence:0.9, reason:'folio_group', flags:signals }
      : { intent:'requester_feedback', target:'routeRequesterReply', confidence:0.9, reason:'folio_dm', flags:signals };
  }

  if (!isGroup && isStatusQuery) {
    return { intent:'requester_feedback', target:'routeRequesterReply', confidence:0.8, reason:'status_query', flags:signals };
  }

  // ✅ SOLO manda a unknown si es claramente charla / pregunta general (alta precisión)
  if (!isGroup && body.length >= 4 && isClearlyNonIncident(body)) {
    return {
      intent: 'unknown',
      target: 'unknownHandler',
      confidence: 0.9,
      reason: 'dm_clearly_non_incident',
      flags: signals
    };
  }

  // ✅ Si NO estamos seguros, mejor N-I (conservador)
  if (!isGroup && body.length >= 6) {
    return {
      intent: 'ni_new',
      target: 'routeIncomingNI',
      confidence: 0.75,
      reason: 'dm_default_to_ni_conservative',
      flags: signals
    };
  }

  return {
    intent: 'unknown',
    target: 'unknownHandler',
    confidence: 0.4,
    reason: 'fallback',
    flags: signals
  };
}

module.exports = { classifyMessageIntent };
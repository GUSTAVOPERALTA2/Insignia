/**
 * niHandlers/shared.js
 * Funciones compartidas y constantes para todos los handlers de modo
 */

const path = require('path');

const DEBUG = (process.env.VICEBOT_DEBUG || '1') === '1';

// ═══════════════════════════════════════════════════════════════
// CONSTANTES
// ═══════════════════════════════════════════════════════════════

const MEDIA_BATCH_WINDOW_MS = parseInt(process.env.VICEBOT_MEDIA_BATCH_WINDOW_MS || '8000', 10);
const ASK_PLACE_COOLDOWN_MS = parseInt(process.env.VICEBOT_ASK_PLACE_COOLDOWN_MS || '15000', 10);
const ATTACH_DIR = path.join(process.cwd(), 'data', 'attachments');
const ATTACH_BASEURL = '/attachments';

const AREA_LABELS = {
  man: 'Mantenimiento',
  it: 'IT',
  ama: 'HSKP',
  rs: 'Room Service',
  seg: 'Seguridad',
  exp: 'Experiencias',
};

const AREA_ALIASES = {
  mantenimiento: 'man', man: 'man', mant: 'man', mantto: 'man',
  it: 'it', sistemas: 'it', tech: 'it', tecnologia: 'it',
  ama: 'ama', hskp: 'ama', housekeeping: 'ama', limpieza: 'ama', camarista: 'ama',
  rs: 'rs', roomservice: 'rs', 'room service': 'rs', alimentos: 'rs',
  seg: 'seg', seguridad: 'seg', vigilancia: 'seg', security: 'seg',
  exp: 'exp', experiencias: 'exp',
};

// ═══════════════════════════════════════════════════════════════
// NORMALIZACIÓN Y TOKENS
// ═══════════════════════════════════════════════════════════════

function norm(s = '') {
  return String(s)
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().trim();
}

function toKey(s) {
  return String(s || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

// Precomputar aliases normalizados para matching más robusto
const NORMALIZED_AREA_ALIASES = (() => {
  const map = Object.create(null);
  for (const k of Object.keys(AREA_ALIASES)) {
    map[toKey(k)] = AREA_ALIASES[k];
  }
  return map;
})();

const YES_TOKENS = new Set([
  'si', 'sí', 'yes', 'ok', 'okay', 'vale', 'va', 'dale', 'listo',
  'correcto', 'enviar', 'mandalo', 'mándalo', 'confirmo', 'confirmar',
  'afirmativo', 'send', 'simon', 'claro', 'sale'
]);

const NO_TOKENS = new Set([
  'no', 'nop', 'nopes', 'nel', 'cancelar', 'cancela', 'negativo', 'ninguno'
]);

const YES_PATTERNS = [
  /^s[ií]\b/i,
  /\benv[ií]alo?\b/i,
  /\bm[aá]ndalo?\b/i,
  /\bconfirmo\b/i,
  /\bdale\b/i,
  /\bperfecto\b/i,
  /\best[aá]\s+bien\b/i,
  /\bas[ií]\s+(est[aá]|queda)\s+bien\b/i,
  /\bde\s+acuerdo\b/i,
  /\bprocede\b/i,
  /\bhazlo\b/i,
  /\badelante\b/i,
];

function isYes(text) {
  const t = norm(text);
  if (YES_TOKENS.has(t)) return true;
  if (/^(si|sí)[.!?]*$/.test(t)) return true;
  if (['👍', '✅', '✔️'].some(e => String(text).includes(e))) return true;
  if (YES_PATTERNS.some(rx => rx.test(t))) return true;
  return false;
}

function isNo(text) {
  const t = norm(text);
  if (NO_TOKENS.has(t)) return true;
  if (/^no[.!?]*$/.test(t)) return true;
  if (['❌', '✖️'].some(e => String(text).includes(e))) return true;
  if (/\bno\s+(lo\s+)?(env[ií]|mand)/i.test(t)) return true;
  return false;
}

function areaLabel(code) {
  if (!code) return '—';
  const k = String(code).toLowerCase();
  return AREA_LABELS[k] || String(code).toUpperCase();
}

function areaListLabel(arr) {
  if (!Array.isArray(arr) || !arr.length) return '—';
  return arr.map(areaLabel).join(', ');
}

function normalizeAreaCode(text) {
  if (!text) return null;
  // usar toKey para normalizar entrada
  const tKey = toKey(text);
  if (!tKey) return null;

  // chequeo directo en mapa normalizado
  if (NORMALIZED_AREA_ALIASES[tKey]) return NORMALIZED_AREA_ALIASES[tKey];

  // coincidencia por inclusión (ej: "ayb" vs "a y b" o "ama" vs "ama?")
  for (const k of Object.keys(NORMALIZED_AREA_ALIASES)) {
    if (k.includes(tKey) || tKey.includes(k)) return NORMALIZED_AREA_ALIASES[k];
  }

  // alias manuales comunes adicionales
  const MANUAL_ALIASES = {
    'ama': 'ama',
    'hskp': 'ama',
    'ama de llaves': 'ama',
    'housekeeping': 'ama',
    'mantto': 'man',
    'mtn': 'man',
    'mantenimiento': 'man',
    'manto': 'man',
    'sistemas': 'it',
    'sys': 'it',
    'it': 'it',
    'rs': 'rs',
    'room service': 'rs',
    'ird': 'rs',
    'seguridad': 'seg',
    'security': 'seg',
    'exp': 'exp',
    'experiencias': 'exp',
  };
  if (MANUAL_ALIASES[tKey]) return MANUAL_ALIASES[tKey];

  return null;
}

// ═══════════════════════════════════════════════════════════════
// FORMATEO
// ═══════════════════════════════════════════════════════════════

function formatPreview(draft, { showMissing = false } = {}) {
  const lugarText = draft.lugar || (showMissing ? '❓ _Falta indicar_' : '—');
  const areaText = draft.area_destino ? areaLabel(draft.area_destino) : (showMissing ? '❓ _Sin detectar_' : '—');
  const descripcion = draft.descripcion || draft.descripcion_original || draft.incidente || '—';

  return [
    '📝 *Vista previa del ticket*\n',
    `• *Descripción:* ${descripcion}`,
    `• *Lugar:* ${lugarText}`,
    `• *Área destino:* ${areaText}`,
  ].join('\n');
}

function formatPreviewMessage(draft) {
  const missingLugar = !draft.lugar;
  const missingArea = !draft.area_destino;

  const preview = formatPreview(draft, { showMissing: true });

  if (missingLugar && missingArea) {
    return preview + '\n\n📍 Indícame el *lugar* (ej: "hab 1311", "Front Desk").';
  } else if (missingLugar) {
    return preview + '\n\n📍 Indícame el *lugar* para poder enviarlo.';
  } else if (missingArea) {
    return preview + '\n\n🏷️ No detecté el área. Dime: IT, Mantenimiento, HSKP, RS o Seguridad.';
  } else {
    // Retornamos solo la vista previa sin ninguna instrucción de envío/confirmación
    return preview;
  }
}

function formatTicketSummary(ticket, num) {
  const desc = (ticket.descripcion || '').substring(0, 50);
  const suffix = (ticket.descripcion || '').length > 50 ? '...' : '';
  return `*${num}.* ${desc}${suffix}\n   📍 ${ticket.lugar || '—'} | 🏷️ ${areaLabel(ticket.area_destino)}`;
}

function formatMultipleTicketsSummary(tickets) {
  let summary = `📋 *${tickets.length} tickets pendientes:*\n\n`;
  tickets.forEach((t, i) => {
    summary += formatTicketSummary(t, i + 1) + '\n\n';
  });
  return summary;
}

// ═══════════════════════════════════════════════════════════════
// VALIDACIÓN
// ═══════════════════════════════════════════════════════════════

function hasRequiredDraft(draft) {
  if (!draft) return false;
  return !!(draft.descripcion && draft.lugar && draft.area_destino);
}

function isVagueText(text) {
  if (!text) return true;
  const trimmed = String(text).trim();
  if (trimmed.length < 3) return true;
  const t = norm(trimmed);

  // Si es una sola palabra muy corta o saludo, consideramos vago
  if (t.split(/\s+/).length === 1 && t.length <= 4) return true;

  const vaguePatterns = [
    /^(hola|hey|buenas?|que tal)$/i,
    /^(ayuda|help)$/i,
    // dejamos fuera 'si/no/ok' porque se detectan con isYes/isNo
  ];
  return vaguePatterns.some(rx => rx.test(t));
}

function isSessionBareForNI(session) {
  if (!session || !session.draft) return true;
  const d = session.draft;
  const hasStruct = d.lugar || d.area_destino || d.descripcion;
  const hasMedia = Array.isArray(session._pendingMedia) && session._pendingMedia.length;
  return !hasStruct && !hasMedia;
}

// ═══════════════════════════════════════════════════════════════
// CLASIFICACIÓN DE MENSAJES EN MODO CONFIRM
// ═══════════════════════════════════════════════════════════════

function classifyConfirmMessage(text, draft = {}) {
  const raw = String(text || '').trim();
  const t = norm(raw);
  const len = raw.length;

  // Confirmaciones simples
  if (isYes(raw)) return 'confirm';
  if (isNo(raw)) return 'cancel';

  // Followup patterns: "también...", "además...", "y aparte..."
  const followupPatterns = [
    /^(tambi[eé]n|adem[aá]s|y\s+tambi[eé]n|aparte|y\s+aparte|otro\s+detalle|tambi[eé]n\s+hay)/i,
    /^(ah,?\s+)?(y\s+)?tambi[eé]n\b/i,
    /^(otra\s+cosa|y\s+otra\s+cosa)\b/i,
  ];

  if (followupPatterns.some(rx => rx.test(t))) {
    return 'detail_followup';
  }

  // Comandos de edición
  if (/^editar?\b/i.test(t) || /^modificar?\b/i.test(t) || (/^cambiar?\b/i.test(t) && len < 15)) {
    return 'edit_command';
  }

  const editCommands = [
    /^(borra|borrar|elimina|eliminar|quita|quitar)\s+(eso|esto|la\s+descripcion|el\s+detalle|todo)/i,
    /^(cambia|cambiar|reemplaza|reemplazar)\s+(la\s+)?descripcion/i,
    /^(actualiza|actualizar)\s+(la\s+)?descripcion/i,
  ];

  if (editCommands.some(rx => rx.test(t))) {
    return 'edit_command';
  }

  // Detectar si parece nuevo incidente con lugar diferente
  const problemWords = /\b(no\s+(funciona|sirve|enciende|prende|tiene)|roto|rota|dañado|dañada|averiado|falla|fuga|gotea|necesita|requiere|falta|sucio|sucia|apagado|apagada)\b/i;
  const requestWords = /\b(traer|traigan|llevar|cambiar|revisar|arreglar|reparar|limpiar|necesito|ocupo|ayuda|ayudan|necesitamos)\b/i;
  const deviceWords = /\b(tv|television|impresora|internet|wifi|aire|clima|luz|foco|agua|regadera|control|puerta|cerradura)\b/i;

  const looksLikeProblem = problemWords.test(raw) ||
    (deviceWords.test(raw) && requestWords.test(raw)) ||
    (len > 25 && requestWords.test(raw));

  // detectar número de habitación con mayor control (3-4 dígitos)
  const hasPlace = /\b(en|lugar|hab)\b.*\b\d{3,4}\b/i.test(raw) || /\b\d{3,4}\b/.test(raw);

  if (looksLikeProblem && hasPlace && len > 20) {
    return 'new_incident_candidate';
  }

  // Cambio express de lugar
  const placeChangePatterns = [
    /^en\s+\S+$/i,
    /^en\s+(la\s+)?hab(itacion|itación)?\s*\d{3,4}$/i,
    /^es\s+en\s+\S+/i,
    /^(cambia|cambiar?)\s+(el\s+)?lugar\s+(a|para)\s+/i,
    /^el\s+lugar\s+es\s+/i,
    /^lugar[:\s]+/i,
  ];

  if (len < 40 && placeChangePatterns.some(rx => rx.test(t))) {
    return 'place_change';
  }

  // Cambio de área
  const areaChangePatterns = [
    /^(es\s+)?(para|de)\s+(it|mantenimiento|ama|hskp|seguridad|rs|room\s*service)/i,
    /^(cambia|cambiar?)\s+(el\s+)?[aá]rea\s+(a|para)\s+/i,
    /^[aá]rea[:\s]+/i,
  ];

  if (len < 30 && areaChangePatterns.some(rx => rx.test(t))) {
    return 'area_change';
  }

  // Número de habitación suelto
  if (/^\d{3,4}$/.test(t)) {
    return 'room_number';
  }

  // Mensaje largo = posible descripción adicional o nuevo problema
  if (len > 50) {
    return 'long_message';
  }

  return 'unknown';
}

// ═══════════════════════════════════════════════════════════════
// LIMPIEZA DE DESCRIPCIÓN
// ═══════════════════════════════════════════════════════════════

function cleanDescription(rawText) {
  if (!rawText) return '';

  let text = String(rawText).trim();

  // Eliminar menciones tipo @usuario o @123456
  text = text.replace(/@\S+/g, '');

  // Eliminar número de habitación al inicio si está solo (3-4 dígitos)
  text = text.replace(/^\d{3,4}\s*[,.:;-]?\s*/i, '');

  // Patrones de introducción a eliminar
  const introPatterns = [
    /^menciona\s+(a\s+[\w\s]+\s+)?(que\s+)?/i,
    /^dice\s+(a\s+[\w\s]+\s+)?(que\s+)?/i,
    /^reporta\s+(a\s+[\w\s]+\s+)?(que\s+)?/i,
    /^(por\s+favor|pf|porfa|please|pls)[,.]?\s*/i,
    /^(hola|buenos?\s+(d[ií]as?|tardes?|noches?))[,.]?\s*/i,
  ];

  for (const pattern of introPatterns) {
    text = text.replace(pattern, '').trim();
  }

  // Eliminar referencias redundantes
  text = text.replace(/\s+de\s+(la\s+)?habitaci[oó]n\s+\d+/gi, '');
  text = text.replace(/\s+de\s+adentro\s+de\s+(la\s+)?habitaci[oó]n/gi, '');

  // Limpiar puntuación
  text = text.replace(/^[,.:;!¡¿?\-–—]+\s*/g, '');
  text = text.replace(/\s*[,.:;]+$/g, '');

  // Corregir typos comunes
  const typoFixes = [
    [/\bfrotn\b/gi, 'front'],
    [/\bfrton\b/gi, 'front'],
    [/\bfornt\b/gi, 'front'],
    [/\baire\s*acondicion?ado\b/gi, 'A/C'],
    [/\bno\s+sirve\b/gi, 'no funciona'],
    [/\bno\s+jala\b/gi, 'no funciona'],
  ];

  for (const [pattern, replacement] of typoFixes) {
    text = text.replace(pattern, replacement);
  }

  // Limpiar espacios
  text = text.replace(/\s+/g, ' ').trim();

  // Capitalizar
  if (text.length > 0) {
    text = text.charAt(0).toUpperCase() + text.slice(1);
  }

  return text;
}

// ═══════════════════════════════════════════════════════════════
// MEDIA BATCH
// ═══════════════════════════════════════════════════════════════

function ensureMediaBatch(s) {
  if (!s._mediaBatch) s._mediaBatch = { count: 0, lastTs: 0, sentAck: false, askedPlace: false };
  return s._mediaBatch;
}

function inActiveMediaBatch(s, now = Date.now()) {
  const b = s._mediaBatch;
  return !!(b && b.lastTs && (now - b.lastTs) <= MEDIA_BATCH_WINDOW_MS);
}

// Helper para limpiar campos temporales de sesión relacionados con NI
function cleanupSessionMedia(s = {}) {
  try {
    delete s._pendingMedia;
    delete s._mediaBatch;
    delete s._placeCandidates;
    delete s._multiAreaPending;
    delete s._lastAskPlaceTs;
    // no borramos draft/other persistent state
    return true;
  } catch (err) {
    if (DEBUG) console.error('[shared.cleanupSessionMedia] error', err);
    return false;
  }
}

// Simple logger controlado por DEBUG
function log(...args) {
  if (DEBUG) {
    console.log('[niHandlers/shared]', ...args);
  }
}

// ═══════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════

module.exports = {
  // Constantes
  DEBUG,
  MEDIA_BATCH_WINDOW_MS,
  ASK_PLACE_COOLDOWN_MS,
  ATTACH_DIR,
  ATTACH_BASEURL,
  AREA_LABELS,
  AREA_ALIASES,

  // Normalización
  norm,
  toKey,
  isYes,
  isNo,
  areaLabel,
  areaListLabel,
  normalizeAreaCode,

  // Formateo
  formatPreview,
  formatPreviewMessage,
  formatTicketSummary,
  formatMultipleTicketsSummary,

  // Validación
  hasRequiredDraft,
  isVagueText,
  isSessionBareForNI,

  // Clasificación
  classifyConfirmMessage,

  // Limpieza
  cleanDescription,

  // Media
  ensureMediaBatch,
  inActiveMediaBatch,
  cleanupSessionMedia,

  // Util
  log,
};
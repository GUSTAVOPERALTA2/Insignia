// modules/router/routeIncomingNI.js
// Orquestador del flujo N-I con:
// - Memoria por chat (niSession)
// - Detección de LUGAR (catálogo + señales fuertes + "relajación")
// - Detección de ÁREA (texto + hints de visión, con política de prioridad)
// - Integración de visión (niVision) y enriquecimiento de interpretación
// - Confirmación estricta (evita "123", números sueltos, etc.)
// - Persistencia (SQLite/JSONL)
// - Envío a grupos y reenvío de multimedia al confirmar
// - NEW: Persistencia de adjuntos en disco + registro en DB para dashboard
// - NEW RULE: No se muestra resumen sin antes sugerir/fijar *área destino*
// - NEW GUARD: Evita disparar N-I para saludos / smalltalk / "no es reporte"
// - NEW META: IA puede marcar nuevos incidentes vs correcciones de lugar
// - NEW RESET: comando contextual "reinicio" / "reset" / ...
// - FIX: Validación estricta de lugares contra catálogo (no acepta texto arbitrario)

const fs = require('fs');
const path = require('path');

const { interpretTurn } = require('../ai/dialogInterpreter');
const { deriveIncidentText } = require('../ai/incidentText');
const { recordGroupDispatch } = require('../state/lastGroupDispatch'); // NEW

const { detectPlace, loadLocationCatalogIfNeeded } = require('../ai/placeExtractor');
const { detectArea } = require('../ai/areaDetector');
const { analyzeNIImage } = require('../ai/niVision');
const {
  ensureReady,
  persistIncident,
  appendIncidentAttachments, // NEW
  appendDispatchedToGroupsEvent, // NEW
} = require('../db/incidenceDB');

const {
  ensureSession, resetSession, pushTurn,
  setMode, setDraftField, replaceAreas, addArea, removeArea,
  isReadyForPreview, closeSession,
} = require('../state/niSession');

const {
  loadGroupsConfig,
  resolveTargetGroups,
  formatIncidentMessage,
  sendIncidentToGroups
} = require('../groups/groupRouter');

const { MessageMedia } = require('whatsapp-web.js');
const { classifyNiGuard } = require('./niGuard'); // NEW GUARD

const DEBUG = (process.env.VICEBOT_DEBUG || '1') === '1';

// ✅ NUEVO: Generar respuesta contextual con IA para mensajes no relacionados con incidencias
async function generateContextualResponse(userMessage) {
  try {
    const OpenAI = require('openai');
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    
    const systemPrompt = `Eres un bot de incidencias de un hotel. Tu trabajo es recibir reportes de problemas (cosas que no funcionan, están dañadas, etc.).

El usuario acaba de enviarte un mensaje que NO es un reporte de incidencia. Responde de forma:
1. Breve y amigable (1-2 oraciones máximo respondiendo al contexto del mensaje)
2. Luego recuérdale amablemente para qué sirves

Formato de respuesta (usa exactamente este formato):
[Tu respuesta contextual breve]

---
🔧 *Este chat es para reportar incidencias del hotel* (algo no funciona, está dañado, etc.)
_Ejemplo: "No funciona el aire en hab 1205"_`;

    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      max_tokens: 150,
      temperature: 0.7,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage }
      ]
    });
    
    const aiResponse = response.choices?.[0]?.message?.content?.trim();
    if (aiResponse) {
      if (DEBUG) console.log('[NI] contextual AI response generated');
      return aiResponse;
    }
    
    throw new Error('Empty AI response');
  } catch (e) {
    if (DEBUG) console.warn('[NI] generateContextualResponse error:', e?.message);
    // Fallback
    return '👋 ¡Hola! Soy el bot de *incidencias* del hotel.\n\n' +
           'Si necesitas reportar algo que *no funciona* o está *dañado*, cuéntame qué pasó y dónde está.\n\n' +
           '_Ejemplo: "No funciona el aire en hab 1205"_';
  }
}

// ✅ SAFE REPLY (absorbe "Session closed" sin matar proceso)
let safeReply = null;
try {
  ({ safeReply } = require('../utils/safeReply'));
} catch (e) {
  safeReply = null;
  if (DEBUG) console.warn('[NI] safeReply missing:', e?.message || e);
}
async function replySafe(msg, text) {
  if (!msg || !text) return false;
  try {
    if (safeReply) return await safeReply(msg, text);
    await msg.reply(text);
    return true;
  } catch (e) {
    if (DEBUG) console.warn('[NI] replySafe err', e?.message || e);
    return false;
  }
}

// Ventanas y cooldowns
const MEDIA_BATCH_WINDOW_MS = parseInt(process.env.VICEBOT_MEDIA_BATCH_WINDOW_MS || '8000', 10);
const ASK_PLACE_COOLDOWN_MS = parseInt(process.env.VICEBOT_ASK_PLACE_COOLDOWN_MS || '15000', 10);

// Directorio de adjuntos (servido por /attachments desde index.js)
const ATTACH_DIR = path.join(process.cwd(), 'data', 'attachments');
const ATTACH_BASEURL = '/attachments';

// Alias visibles de áreas
const AREA_LABELS = {
  man: 'Mantenimiento',
  it:  'IT',
  ama: 'HSKP',
  rs:  'Room Service',
  seg: 'Seguridad',
};

/* ──────────────────────────────
 * Utilidades generales
 * ────────────────────────────── */
function ensureMediaBatch(s) {
  if (!s._mediaBatch) s._mediaBatch = { count: 0, lastTs: 0, sentAck: false, askedPlace: false };
  return s._mediaBatch;
}
function inActiveMediaBatch(s, now = Date.now()) {
  const b = s._mediaBatch;
  return !!(b && b.lastTs && (now - b.lastTs) <= MEDIA_BATCH_WINDOW_MS);
}

function areaLabel(code){
  if (!code) return '—';
  const k = String(code).toLowerCase();
  return AREA_LABELS[k] || String(code).toUpperCase();
}
function areaListLabel(arr) {
  if (!Array.isArray(arr) || !arr.length) return '—';
  return arr.map(areaLabel).join(', ');
}

// Normaliza para comparar (acentos/case/espacios)
function toKey(s) {
  return String(s || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function formatPreview(draft, { showMissing = false } = {}) {
  // Determinar qué falta
  const lugarText = draft.lugar || (showMissing ? '❓ _Falta indicar_' : '—');
  const areaText = draft.area_destino ? areaLabel(draft.area_destino) : (showMissing ? '❓ _Sin detectar_' : '—');
  
  // ✅ FIX: Usar descripcion completa (que incluye detalles agregados)
  // draft.descripcion contiene la descripción + detalles acumulados
  // draft.descripcion_original es solo el mensaje inicial
  const descripcion = draft.descripcion || draft.descripcion_original || draft.incidente || '—';
  
  return [
    '📝 *Vista previa del ticket*\n',
    `• *Descripción:* ${descripcion}`,
    `• *Lugar:* ${lugarText}`,
    `• *Área destino:* ${areaText}`,
  ].join('\n');
}

// ✅ NUEVO: Genera el mensaje de preview con instrucciones según lo que falte
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
    return preview + '\n\n¿Lo envío? Responde *sí* o *no*.';
  }
}

function dedupeOps(ops) {
  const out = [];
  const seen = new Set();
  for (const op of ops || []) {
    const key = JSON.stringify(op);
    if (!seen.has(key)) { seen.add(key); out.push(op); }
  }
  return out;
}

// Reglas obligatorias
function hasRequiredDraft(draft) {
  return Boolean(draft && draft.lugar && draft.area_destino);
}

// NEW: considerar si la sesión está "vacía" a efectos de N-I
function isSessionBareForNI(session) {
  if (!session || !session.draft) return true;
  const d = session.draft;
  const hasStruct =
    d.lugar ||
    d.area_destino ||
    (Array.isArray(d._details) && d._details.length) ||
    d.interpretacion;
  const hasMedia = Array.isArray(session._pendingMedia) && session._pendingMedia.length;
  const hasVision = Array.isArray(session._visionAreaHints) && session._visionAreaHints.length;
  return !hasStruct && !hasMedia && !hasVision;
}

/* ──────────────────────────────
 * Confirmación estricta
 * ────────────────────────────── */
function norm(s='') {
  return String(s)
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().trim();
}

const YES_TOKENS = new Set([
  'si','sí','yes','ok','okay','vale','va','dale','listo',
  'correcto','enviar','mandalo','mándalo','confirmo','confirmar',
  'afirmativo','send'
]);

const NO_TOKENS = new Set([
  'no','nop','nopes','nel','cancelar','cancela','no enviar','negativo'
]);

// Patrones que indican confirmación afirmativa en lenguaje natural
const YES_PATTERNS = [
  /^s[ií]\b/i,                           // Empieza con "si" o "sí"
  /\benv[ií]alo?\b/i,                    // "envíalo", "envialo"
  /\bm[aá]ndalo?\b/i,                    // "mándalo", "mandalo"  
  /\bconfirmo\b/i,                       // "confirmo"
  /\bdale\b/i,                           // "dale"
  /\bperfecto\b/i,                       // "perfecto"
  /\best[aá]\s+bien\b/i,                 // "está bien"
  /\basí\s+(est[aá]|queda)\s+bien\b/i,   // "así está bien"
  /\bde\s+acuerdo\b/i,                   // "de acuerdo"
  /\bprocede\b/i,                        // "procede"
  /\bhazlo\b/i,                          // "hazlo"
  /\badelante\b/i,                       // "adelante"
];

function isYes(text) {
  const t = norm(text);
  if (YES_TOKENS.has(t)) return true;
  if (/^(si|sí)[.!?]*$/.test(t)) return true;
  if (['👍','✅','✔️'].some(e => String(text).includes(e))) return true;
  
  // ✅ NUEVO: Verificar patrones de confirmación en frases más largas
  const tNorm = norm(text);
  if (YES_PATTERNS.some(rx => rx.test(tNorm))) return true;
  
  return false;
}

function isNo(text) {
  const t = norm(text);
  if (NO_TOKENS.has(t)) return true;
  if (/^no[.!?]*$/.test(t)) return true;
  if (['❌','✖️'].some(e => String(text).includes(e))) return true;
  // ✅ NUEVO: "no lo envíes", "no lo mandes"
  if (/\bno\s+(lo\s+)?(env[ií]|mand)/i.test(t)) return true;
  return false;
}

function isShortAmbiguousNumber(text) {
  return /^\d{1,3}$/.test(String(text).trim());
}

/* ──────────────────────────────
 * RESET NI: comandos contextuales
 * ────────────────────────────── */
const RESET_NI_TOKENS = new Set([
  'reinicio',
  'reset',
  'reinicia',
  'reiniciate',
  'reiniciar',
]);

function isResetNICommand(text = '') {
  const t = norm(text);
  if (!t) return false;
  if (t.length > 15) return false;
  return RESET_NI_TOKENS.has(t);
}

/* ──────────────────────────────
 * LUGAR: helpers
 * ────────────────────────────── */
function findStrongPlaceSignals(text) {
  if (!text) return null;
  const t = String(text).toLowerCase();
  const mv = t.match(/\bvilla\s*(\d{1,2})\b/i);
  if (mv) return { kind: 'villa', value: `Villa ${mv[1]}` };
  const mr = t.match(/\b(\d{4})\b/);
  if (mr) return { kind: 'room', value: mr[1] };
  return null;
}

function getStrongPlaceValue(text) {
  const strong = findStrongPlaceSignals(text);
  return strong ? strong.value : null;
}

function isDifferentStrongPlace(text, draft = {}) {
  const newVal = getStrongPlaceValue(text);
  if (!newVal) return false;
  if (!draft || !draft.lugar) return false;

  const keyNew = toKey(newVal);
  const keyOld = toKey(draft.lugar);

  if (!keyNew || !keyOld) return false;
  if (keyNew === keyOld) return false;
  if (keyOld.includes(keyNew) || keyNew.includes(keyOld)) return false;

  return true;
}

function looksStandaloneIncidentText(text = '') {
  const t = String(text).toLowerCase().trim();
  if (!t) return false;
  if (t.length < 12) return false;

  const strong = findStrongPlaceSignals(t);
  if (!strong) return false;

  const incidentVerbs = /(no sirve|no funcionan|no jala|no prende|no apaga|fuga|gotea|tirando agua|se rompio|se rompió|se cayo|se cayó|revisen|revisar|manden|mandar|necesito|urge|urgente|limpieza|limpien|sucio|tapado|no hay agua|no hay luz)/;
  const helpWords     = /\bayuda\b/;

  if (incidentVerbs.test(t) || helpWords.test(t)) return true;

  return false;
}

function looksGenericPrincipal(s) {
  if (!s) return false;
  const t = String(s).toLowerCase();
  const hasPrincipal = /\bprincipal\b/.test(t);
  const qualified   = /\btorre principal\b|\bedificio principal\b/.test(t);
  return hasPrincipal && !qualified;
}

/**
 * ✅ NUEVO: Clasifica el tipo de mensaje en modo confirm/preview
 * Retorna: 'place_change' | 'area_change' | 'description_change' | 'confirm' | 'cancel' | 'unknown'
 */
function classifyConfirmMessage(text, draft = {}) {
  const t = norm(text);
  const len = text.length;
  
  // Confirmaciones simples
  if (isYes(text)) return 'confirm';
  if (isNo(text)) return 'cancel';
  
  // ═══════════════════════════════════════════════════════════════
  // COMANDOS DE EDICIÓN (editar, borrar, cambiar descripción)
  // ═══════════════════════════════════════════════════════════════
  // Detectar "editar" solo o con target
  if (/^editar?\b/i.test(t) || /^modificar?\b/i.test(t) || /^cambiar?\b/i.test(t) && len < 15) {
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
  
  // ═══════════════════════════════════════════════════════════════
  // CAMBIO EXPRESS DE LUGAR (mensajes cortos con patrón específico)
  // ═══════════════════════════════════════════════════════════════
  // Patrones: "en X", "es en X", "cambia lugar a X", "el lugar es X"
  const placeChangePatterns = [
    /^en\s+\S+$/i,                                    // "en nido"
    /^en\s+(la\s+)?hab(itacion|itación)?\s*\d{4}$/i, // "en habitación 2102"
    /^es\s+en\s+\S+/i,                               // "es en front"
    /^(cambia|cambiar?)\s+(el\s+)?lugar\s+(a|para)\s+/i, // "cambia lugar a..."
    /^el\s+lugar\s+es\s+/i,                          // "el lugar es..."
    /^lugar[:\s]+/i,                                 // "lugar: 2102" o "lugar 2102"
    /^(perdon|perdón)\s+en\s+\S+$/i,                 // "perdón en 1312"
    /^(esta|está)\s+en\s+\S+$/i,                     // "está en lobby"
    /^\d{4}$/,                                       // solo número de habitación "1312"
    /^hab(itacion|itación)?\s*\d{4}$/i,              // "habitación 1313"
    /^villa\s*\d{1,2}$/i,                            // "villa 5"
    /^en\s+\d{4}$/i,                                 // "en 2102"
    /^en\s+(la|el)?\s*(family\s*pool|alberca|piscina|spa|gym|playa|nido|lobby)/i, // "en la family pool"
  ];
  
  // Considerar cambio de lugar si matchea patrón (sin límite estricto de chars para algunos)
  if (placeChangePatterns.some(rx => rx.test(t))) {
    return 'place_change';
  }
  
  // También si es mensaje corto (< 40) y parece lugar
  if (len < 40 && /\b(en|lugar|hab)\b.*\d{4}/i.test(t)) {
    return 'place_change';
  }
  
  // ✅ NUEVO: "En la X" o "En el X" seguido de lugar conocido (< 30 chars)
  if (len < 30 && /^en\s+(la|el)\s+\w+/i.test(t)) {
    return 'place_change';
  }
  
  // Nombres de lugares conocidos solos (sin más contexto)
  const knownPlaceAlone = /^(front|front\s*desk|nido|lobby|casero|cielomar|spa|gym|gimnasio|alberca|piscina|restaurante|awacate|playa|recepcion|recepción|family\s*pool|adults?\s*pool|infinity\s*pool|kids?\s*pool)\s*$/i;
  if (len < 25 && knownPlaceAlone.test(t)) {
    return 'place_change';
  }
  
  // ═══════════════════════════════════════════════════════════════
  // CAMBIO EXPRESS DE ÁREA (mensajes cortos con patrón específico)
  // ═══════════════════════════════════════════════════════════════
  // Patrones: "para X", "mándalo a X", "es para X", "envíalo a X"
  const areaChangePatterns = [
    /^(para|es\s+para)\s+(it|sistemas|mantenimiento|ama|housekeeping|seguridad|room\s*service)\s*$/i,
    /^(mandalo|mándalo|envialo|envíalo)\s+a\s+(it|sistemas|mantenimiento|ama|housekeeping|seguridad|room\s*service)\s*$/i,
    /^(cambia|cambiar?)\s+(el\s+)?area\s+(a|para)\s+/i,
    /^el\s+area\s+es\s+/i,
  ];
  
  if (len < 50 && areaChangePatterns.some(rx => rx.test(t))) {
    return 'area_change';
  }
  
  // Códigos de área solos
  const areaCodeAlone = /^(it|man|ama|seg|rs|sistemas|mantenimiento|housekeeping|seguridad|room\s*service)\s*$/i;
  if (len < 20 && areaCodeAlone.test(t)) {
    return 'area_change';
  }
  
  // ═══════════════════════════════════════════════════════════════
  // CAMBIO/ADICIÓN DE DESCRIPCIÓN (mensajes más largos o descriptivos)
  // ═══════════════════════════════════════════════════════════════
  // Si el mensaje es largo y/o contiene palabras que describen un problema
  const problemWords = /\b(no\s+(funciona|sirve|enciende|prende|tiene)|roto|rota|dañado|dañada|averiado|falla|fuga|gotea|necesita|requiere|falta|sucio|sucia|apagado|apagada)\b/i;
  const requestWords = /\b(traer|traigan|llevar|cambiar|revisar|arreglar|reparar|limpiar|necesito|ocupo|ayuda|ayudan|necesitamos)\b/i;
  
  // ✅ FIX: También detectar si menciona dispositivos/cosas
  const deviceWords = /\b(tv|television|impresora|internet|wifi|aire|clima|luz|foco|agua|regadera|control|puerta|cerradura)\b/i;
  
  if (problemWords.test(text)) {
    return 'description_change';
  }
  
  // Si menciona dispositivo + palabra de solicitud (sin importar longitud)
  if (deviceWords.test(text) && requestWords.test(text)) {
    return 'description_change';
  }
  
  // Si es largo (> 30 chars) y tiene palabras de solicitud
  if (len > 30 && requestWords.test(text)) {
    return 'description_change';
  }
  
  // Si es largo (> 50 chars) y no matcheó con lugar/área, probablemente es descripción
  if (len > 50) {
    return 'description_change';
  }
  
  return 'unknown';
}

/**
 * Detecta el tipo de problema para comparar si son diferentes
 */
function detectProblemType(text) {
  if (!text) return null;
  const t = norm(text);
  
  // Tipos de problemas - ordenados por especificidad (con plurales)
  if (/\b(ropa|lavar|lavanderia|planchar|tintorerria|prendas?)\b/i.test(t)) return 'laundry';
  if (/\b(agua|regaderas?|grifos?|lavabos?|wc|banos?|fugas?|gotea|inunda|drenajes?|tuberias?)\b/i.test(t)) return 'plumbing';
  if (/\b(luces?|focos?|lamparas?|apagador(es)?|enchufes?|contactos?|electricidad)\b/i.test(t)) return 'electrical';
  if (/\b(aires?|climas?|ventilador(es)?|calefaccion|frio|caliente)\b/i.test(t)) return 'hvac';
  if (/\b(tv|television(es)?|teles?|control(es)?(\s*remotos?)?|cables?|senales?|pantallas?)\b/i.test(t)) return 'tv';
  if (/\b(wifi|internet|redes?|conexion(es)?)\b/i.test(t)) return 'network';
  if (/\b(cerraduras?|puertas?|llaves?|tarjetas?|accesos?|chapas?)\b/i.test(t)) return 'door';
  if (/\b(comidas?|hambre|restaurantes?|menus?|alimentos?|desayunos?|cenas?|almuerzos?)\b/i.test(t)) return 'food';
  if (/\b(limpi(ar|eza)|sucios?|basuras?|toallas?|sabanas?|camas?|amenidad(es)?)\b/i.test(t)) return 'cleaning';
  if (/\b(tarjetas?\s*madres?|computadoras?|pc|impresoras?|sistemas?|mouse|teclados?)\b/i.test(t)) return 'computer';
  if (/\b(audio|sonidos?|bocinas?|microfonos?|altavoc(es)?|parlantes?|speakers?)\b/i.test(t)) return 'audio';
  if (/\b(seguridad|vigilancia|guardias?|robos?|sospech|emergen)\b/i.test(t)) return 'security';
  if (/\b(cay[oó]|accidentes?|lesion(es)?|heridos?|medicos?|doctor(es)?|enferm)\b/i.test(t)) return 'emergency';
  
  return 'general';
}

/**
 * Detecta si el texto menciona lugares diferentes al lugar actual del draft
 */
function detectMentionsDifferentPlace(text, currentLugar) {
  if (!text) return false;
  const t = norm(text);
  const current = norm(currentLugar || '');
  
  // Lista de lugares conocidos que podrían mencionarse
  const knownPlaces = [
    { pattern: /\b(front\s*desk|front|recepcion)\b/i, name: 'front desk' },
    { pattern: /\b(playa|beach)\b/i, name: 'playa' },
    { pattern: /\bnido\b/i, name: 'nido' },
    { pattern: /\b(spa)\b/i, name: 'spa' },
    { pattern: /\b(gym|gimnasio)\b/i, name: 'gym' },
    { pattern: /\b(lobby)\b/i, name: 'lobby' },
    { pattern: /\b(alberca|piscina|pool)\b/i, name: 'alberca' },
    { pattern: /\b(restaurante|restaurant)\b/i, name: 'restaurante' },
    { pattern: /\b(casero)\b/i, name: 'casero' },
    { pattern: /\b(cielomar)\b/i, name: 'cielomar' },
    { pattern: /\bhab(itacion)?\s*(\d{4})\b/i, name: 'habitacion' },
    { pattern: /\b(\d{4})\b/, name: 'habitacion' },
    { pattern: /\bvilla\s*(\d{1,2})\b/i, name: 'villa' },
  ];
  
  const mentionedPlaces = [];
  for (const { pattern, name } of knownPlaces) {
    if (pattern.test(t)) {
      mentionedPlaces.push(name);
    }
  }
  
  // Si no se menciona ningún lugar, no hay conflicto
  if (mentionedPlaces.length === 0) return false;
  
  // Si hay múltiples lugares mencionados, es probable que sea confuso
  if (mentionedPlaces.length >= 2) {
    if (DEBUG) console.log('[NI] multiple places detected', { places: mentionedPlaces });
    return true;
  }
  
  // Si menciona un lugar diferente al actual
  const mentioned = mentionedPlaces[0];
  if (current && !current.includes(mentioned) && !mentioned.includes(current.split(' ')[0])) {
    if (DEBUG) console.log('[NI] different place mentioned', { current, mentioned });
    return true;
  }
  
  return false;
}

/**
 * ✅ NUEVO: Extrae el primer lugar mencionado en un texto descriptivo
 * Útil para detectar lugares como "alberca" en "Huésped se cayó en la alberca"
 */
function extractPlaceFromText(text) {
  if (!text) return null;
  const t = norm(text);
  
  // Lista de lugares conocidos con su label canónico
  // ✅ IMPORTANTE: Las albercas específicas van ANTES que la genérica
  const knownPlaces = [
    { pattern: /\b(front\s*desk|front|recepcion)\b/i, label: 'Front Desk' },
    { pattern: /\b(playa|beach)\b/i, label: 'Playa' },
    { pattern: /\bnido\b/i, label: 'Nido' },
    { pattern: /\b(spa)\b/i, label: 'Spa' },
    { pattern: /\b(gym|gimnasio)\b/i, label: 'Gimnasio' },
    { pattern: /\b(lobby)\b/i, label: 'Lobby' },
    // Albercas específicas (detectar primero)
    { pattern: /\b(family\s*pool|alberca\s*familiar|piscina\s*familiar)\b/i, label: 'Alberca Familiar (Family Pool)' },
    { pattern: /\b(adults?\s*pool|alberca\s*(de\s*)?adultos|piscina\s*adultos)\b/i, label: 'Alberca de Adultos (Adults Pool)' },
    { pattern: /\b(infinity\s*pool|alberca\s*infinity|piscina\s*infinity)\b/i, label: 'Alberca Infinity' },
    { pattern: /\b(kids?\s*pool|alberca\s*(de\s*)?ni[ñn]os|chapoteadero|alberca\s*infantil)\b/i, label: 'Alberca de Niños' },
    // Alberca genérica (solo si no matcheó ninguna específica) - retorna null para preguntar
    { pattern: /\b(alberca|piscina)\b/i, label: null, askWhich: true },
    // Otros lugares
    { pattern: /\b(restaurante|restaurant)\b/i, label: 'Restaurante' },
    { pattern: /\b(casero)\b/i, label: 'Casero' },
    { pattern: /\b(cielomar)\b/i, label: 'Cielomar' },
    { pattern: /\b(awacate|aguacate)\b/i, label: 'Awacate' },
    { pattern: /\b(kids\s*club)\b/i, label: 'Kids Club' },
    { pattern: /\b(cinema|cine)\b/i, label: 'Cinema' },
    { pattern: /\bhab(itacion)?\s*(\d{4})\b/i, extract: (m) => `Habitación ${m[2]}` },
    { pattern: /\bvilla\s*(\d{1,2})\b/i, extract: (m) => `Villa ${m[1]}` },
  ];
  
  for (const { pattern, label, extract, askWhich } of knownPlaces) {
    const match = t.match(pattern);
    if (match) {
      // Si es alberca genérica, no extraer automáticamente
      if (askWhich) {
        if (DEBUG) console.log('[NI] extractPlaceFromText: alberca genérica detectada, no auto-extraer');
        return null; // Retornar null para que pregunte al usuario
      }
      const foundLabel = extract ? extract(match) : label;
      if (DEBUG) console.log('[NI] extractPlaceFromText found:', foundLabel);
      return foundLabel;
    }
  }
  
  return null;
}

/**
 * Detecta si el texto menciona un área diferente a la actual
 */
function detectDifferentArea(text, currentArea) {
  if (!text || !currentArea) return false;
  const t = norm(text);
  
  const areaPatterns = {
    it: /\b(it|sistemas|computadora|impresora|internet|wifi|red)\b/i,
    man: /\b(mantenimiento|plomeria|electricidad|aire|clima)\b/i,
    ama: /\b(ama|housekeeping|limpieza|toallas|sabanas|amenidades)\b/i,
    seg: /\b(seguridad|vigilancia|guardia)\b/i,
    rs: /\b(room\s*service|comida|alimentos|bebidas)\b/i,
  };
  
  // Detectar qué área menciona el texto
  let mentionedArea = null;
  for (const [area, pattern] of Object.entries(areaPatterns)) {
    if (pattern.test(t)) {
      mentionedArea = area;
      break;
    }
  }
  
  // Si no menciona área o es la misma, no hay diferencia
  if (!mentionedArea || mentionedArea === currentArea) return false;
  
  if (DEBUG) console.log('[NI] different area mentioned', { current: currentArea, mentioned: mentionedArea });
  return true;
}

function sanitizeLugarCandidate(raw) {
  if (!raw) return null;
  let s = String(raw)
    .replace(/[{}\[\]]+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/["""']/g, '')
    .trim();

  s = s.replace(/[,;.:]+$/g, '').trim();

  const mRoom = s.match(/\b\d{4}\b/);
  if (mRoom) s = mRoom[0];

  s = s.replace(/\b(porfa|por favor|gracias)\b/ig, '')
       .replace(/\b(en|a|al|del|de la|de el|la|el|los|las)\b/ig, ' ')
       .replace(/\s+/g, ' ')
       .trim();

  if (s.length > 60) s = s.slice(0, 60).trim();
  return s || null;
}

const RELAX_SCORE_MIN = 7.0;
const RELAX_MARGIN    = 1.25;

/* ──────────────────────────────
 * ✅ FIX: normalizeAndSetLugar CORREGIDO
 * Ya NO acepta texto arbitrario como fallback.
 * Solo acepta lugares que:
 * 1. Existan en el catálogo (detectPlace found=true)
 * 2. O sean señales fuertes (habitación 4 dígitos, villa)
 * 
 * Retorna: { ok: boolean, inCatalog: boolean, label: string } o false
 * ────────────────────────────── */
async function normalizeAndSetLugar(session, msg, candidate, { force = true, rawText = '' } = {}) {
  // 1) Primero: buscar señales fuertes (habitación 4 dígitos, villa)
  const strong = findStrongPlaceSignals(rawText);
  if (strong) {
    if (DEBUG) console.log('[PLACE] strong.signal', strong);
    try {
      const best = await detectPlace(rawText, { preferRoomsFirst: true });
      if (best?.found) {
        if (DEBUG) console.log('[PLACE] strong.set', { label: best.label, via: best.via, score: best.score ?? null });
        setDraftField(session, 'lugar', best.label);
        if (best.meta?.building) setDraftField(session, 'building', best.meta.building);
        if (best.meta?.floor)    setDraftField(session, 'floor', best.meta.floor);
        if (best.meta?.room)     setDraftField(session, 'room', best.meta.room);
        // ✅ inCatalog indica si realmente está en el catálogo
        return { ok: true, inCatalog: best.via !== 'room_pattern', label: best.label };
      }
      // ✅ Si hay señal fuerte pero no está en catálogo, aún así aceptar el valor
      // (ej: habitación 9999 que no existe pero es formato válido)
      const labelNotInCatalog = strong.kind === 'room' ? `Habitación ${strong.value}` : strong.value;
      setDraftField(session, 'lugar', labelNotInCatalog);
      if (DEBUG) console.log('[PLACE] strong.fallback (not in catalog)', { set: labelNotInCatalog });
      return { ok: true, inCatalog: false, label: labelNotInCatalog };
    } catch (e) {
      if (DEBUG) console.warn('[PLACE] strong.err', e?.message || e);
      // Aún con error, si tenemos señal fuerte la usamos
      const labelFallback = strong.kind === 'room' ? `Habitación ${strong.value}` : strong.value;
      setDraftField(session, 'lugar', labelFallback);
      return { ok: true, inCatalog: false, label: labelFallback };
    }
  }

  // 2) Limpiar candidato
  const cleaned = sanitizeLugarCandidate(candidate);
  if (DEBUG) console.log('[PLACE] normalize.start', { candidate: cleaned });

  if (!cleaned) {
    if (DEBUG) console.log('[PLACE] normalize.reject: empty candidate');
    return false;
  }

  // 3) Si es palabra genérica "principal" con señal fuerte, usar rawText
  if (looksGenericPrincipal(cleaned) && strong) {
    if (DEBUG) console.log('[PLACE] generic.principal + strong.signal → use rawText');
    try {
      const best = await detectPlace(rawText, { preferRoomsFirst: true });
      if (best?.found) {
        if (DEBUG) console.log('[PLACE] normalize.fromRaw', { label: best.label, via: best.via, score: best.score ?? null });
        setDraftField(session, 'lugar', best.label);
        if (best.meta?.building) setDraftField(session, 'building', best.meta.building);
        if (best.meta?.floor)    setDraftField(session, 'floor', best.meta.floor);
        if (best.meta?.room)     setDraftField(session, 'room', best.meta.room);
        return { ok: true, inCatalog: best.via !== 'room_pattern', label: best.label };
      }
    } catch (e) {
      if (DEBUG) console.warn('[PLACE] detectRaw.err', e?.message || e);
    }
  }

  // 4) Buscar en catálogo
  try {
    const normPlace = await detectPlace(cleaned, { preferRoomsFirst: true, force });
    if (normPlace?.found) {
      if (DEBUG) console.log('[PLACE] normalize.set', { label: normPlace.label, via: normPlace.via, score: normPlace.score ?? null });
      setDraftField(session, 'lugar', normPlace.label);
      if (normPlace.meta?.building) setDraftField(session, 'building', normPlace.meta.building);
      if (normPlace.meta?.floor)    setDraftField(session, 'floor', normPlace.meta.floor);
      if (normPlace.meta?.room)     setDraftField(session, 'room', normPlace.meta.room);
      return { ok: true, inCatalog: normPlace.via !== 'room_pattern', label: normPlace.label };
    }
    
    // ✅ NUEVO: Si hay sugerencias fuzzy, retornarlas para que el usuario elija
    if (normPlace?.reason === 'fuzzy_suggestions' && normPlace.suggestions?.length > 0) {
      if (DEBUG) console.log('[PLACE] normalize.fuzzy_suggestions', { 
        input: cleaned,
        suggestions: normPlace.suggestions.map(s => `${s.label} (${s.similarity}%)`)
      });
      return { 
        ok: false, 
        fuzzySuggestions: normPlace.suggestions,
        originalInput: cleaned
      };
    }
    
    // ✅ Si hay candidatos pero no match exacto, NO aceptar automáticamente
    // El flujo de ask_place se encargará de sugerir opciones
    if (normPlace?.candidates?.length > 0) {
      if (DEBUG) console.log('[PLACE] normalize.has_candidates_but_no_match', { 
        candidates: normPlace.candidates.slice(0, 3).map(c => c.label) 
      });
      // Retornar false para que el flujo principal maneje las sugerencias
      return false;
    }
  } catch (e) {
    if (DEBUG) console.warn('[PLACE] normalize.err', e?.message || e);
  }

  // 5) ✅ FIX: Verificar si es número de habitación válido (4 dígitos)
  const mRoom = cleaned.match(/\b\d{4}\b/);
  if (mRoom) {
    // Es un número de 4 dígitos, aceptar como habitación (pero no está en catálogo)
    const labelRoom = `Habitación ${mRoom[0]}`;
    setDraftField(session, 'lugar', labelRoom);
    if (DEBUG) console.log('[PLACE] normalize.room_pattern (not in catalog)', { set: labelRoom });
    return { ok: true, inCatalog: false, label: labelRoom };
  }

  // 6) ✅ FIX: NO HAY MÁS FALLBACK
  // Si llegamos aquí, el lugar NO es válido
  if (DEBUG) console.log('[PLACE] normalize.reject: not in catalog and no valid pattern', { candidate: cleaned });
  return false;
}

/* ──────────────────────────────
 * ÁREA: prioridad + sugerencia obligatoria
 * ────────────────────────────── */
function applyAreaPriority(session, { explicitArea, textArea, visionHints }) {
  if (explicitArea) {
    setDraftField(session, 'area_destino', explicitArea);
    if (!session.draft.areas?.includes(explicitArea)) addArea(session, explicitArea);
    return;
  }
  if (textArea && !session.draft.area_destino) {
    setDraftField(session, 'area_destino', textArea);
    addArea(session, textArea);
    return;
  }
  const topVision = Array.isArray(visionHints) && visionHints.length ? visionHints[0] : null;
  if (topVision && !session.draft.area_destino) {
    setDraftField(session, 'area_destino', topVision);
    addArea(session, topVision);
  }
}

// ✅ MEJORADO: Auto-asignar área considerando contexto de imagen
function autoAssignArea(session, { explicitArea, textArea, visionHints }) {
  if (DEBUG) console.log('[AREA] autoAssignArea', {
    area_destino: session.draft.area_destino,
    candidate: { explicitArea, textArea, visionHints },
  });

  // Si ya hay área, no hacer nada
  if (session.draft.area_destino) {
    return true;
  }

  // 1. Área explícita siempre gana
  if (explicitArea) {
    setDraftField(session, 'area_destino', explicitArea);
    if (!session.draft.areas?.includes(explicitArea)) addArea(session, explicitArea);
    if (DEBUG) console.log('[AREA] auto-assigned (explicit):', explicitArea);
    return true;
  }

  const hasVisionHints = Array.isArray(visionHints) && visionHints.length > 0;
  const topVision = hasVisionHints ? visionHints[0] : null;
  
  // 2. Si hay imagen con hints de visión, priorizar visión sobre texto ambiguo
  // Texto "ambiguo" = seg (seguridad) cuando no hay keywords específicas de seguridad
  if (hasVisionHints && textArea) {
    // Patrones que indican que el texto realmente ES de seguridad
    const securityKeywords = /\b(seguridad|vigilancia|robo|robaron|sospechos[oa]|emergencia|pelea|problema|altercado|intruso|alarma|incendio)\b/i;
    const textIsAmbiguous = !securityKeywords.test(session.draft.descripcion_original || '');
    
    // Si texto dice "seg" pero es ambiguo Y hay hints de visión específicos, priorizar visión
    if (textArea === 'seg' && textIsAmbiguous) {
      if (DEBUG) console.log('[AREA] text suggests seg but is ambiguous, using vision:', topVision);
      setDraftField(session, 'area_destino', topVision);
      if (!session.draft.areas?.includes(topVision)) addArea(session, topVision);
      if (DEBUG) console.log('[AREA] auto-assigned (vision priority):', topVision);
      return true;
    }
    
    // Si los hints de visión son muy específicos (comida, platos, room service), priorizar
    const visionIsSpecific = ['rs', 'ama'].includes(topVision) && 
      (session._visionTags || []).some(t => 
        /room\s*service|comida|plato|alimento|food|limpieza|housekeeping/i.test(t)
      );
    
    if (visionIsSpecific) {
      if (DEBUG) console.log('[AREA] vision is specific (food/cleaning), prioritizing:', topVision);
      setDraftField(session, 'area_destino', topVision);
      if (!session.draft.areas?.includes(topVision)) addArea(session, topVision);
      if (DEBUG) console.log('[AREA] auto-assigned (vision specific):', topVision);
      return true;
    }
  }

  // 3. Prioridad normal: texto > visión
  const candidate = textArea || topVision || null;
  
  if (candidate) {
    setDraftField(session, 'area_destino', candidate);
    if (!session.draft.areas?.includes(candidate)) addArea(session, candidate);
    if (DEBUG) console.log('[AREA] auto-assigned:', candidate);
    return true;
  }
  
  // No hay candidato - área quedará sin asignar
  if (DEBUG) console.log('[AREA] no candidate to auto-assign');
  return false;
}

/* ──────────────────────────────
 * Detalles acumulativos - se agregan a la descripción
 * ────────────────────────────── */

/**
 * Verifica si el detalle parece ser una nueva incidencia (otra habitación/área)
 */
function looksLikeNewIncident(detail, session) {
  if (!detail) return false;
  const t = String(detail).toLowerCase();
  
  // Detectar si menciona otra habitación diferente
  const roomMatch = t.match(/\b(?:hab(?:itaci[oó]n)?\.?\s*)?(\d{3,4})\b/i);
  if (roomMatch) {
    const newRoom = roomMatch[1];
    const currentPlace = String(session.draft?.lugar || '').toLowerCase();
    // Si ya hay una habitación y esta es diferente, es nueva incidencia
    if (currentPlace && !currentPlace.includes(newRoom)) {
      return { reason: 'different_room', newRoom };
    }
  }
  
  // Detectar si menciona explícitamente otra área
  const areaKeywords = {
    'it': /\b(it|sistemas?|tecnolog[ií]a)\b/i,
    'man': /\b(mant|mantenimiento)\b/i,
    'ama': /\b(ama|hskp|housekeep|limpieza)\b/i,
    'seg': /\b(seg|seguridad|vigilancia)\b/i,
    'rs': /\b(room\s*service|rs)\b/i,
  };
  
  for (const [code, rx] of Object.entries(areaKeywords)) {
    if (rx.test(t)) {
      const currentArea = session.draft?.area_destino;
      if (currentArea && currentArea !== code) {
        return { reason: 'different_area', newArea: code };
      }
    }
  }
  
  return false;
}

/**
 * Agrega un detalle a la descripción existente
 */
function addDetail(session, text) {
  if (!text || !session) return false;
  
  const detail = String(text).trim();
  if (!detail) return false;
  
  // Verificar si parece nueva incidencia
  const newIncident = looksLikeNewIncident(detail, session);
  if (newIncident) {
    // Marcar para que el sistema pregunte al usuario
    session._pendingNewIncident = newIncident;
    session._pendingDetail = detail;
    if (DEBUG) console.log('[NI] detail looks like new incident', newIncident);
    return false; // No agregar como detalle, manejar como nueva incidencia
  }
  
  // Agregar a la descripción existente
  const currentDesc = session.draft.descripcion || session.draft.descripcion_original || '';
  
  // ✅ MEJORADO: Evitar duplicados de forma más robusta
  const normalizedDetail = norm(detail);
  const normalizedDesc = norm(currentDesc);
  
  // Si el detalle ya está contenido en la descripción
  if (normalizedDesc.includes(normalizedDetail)) {
    if (DEBUG) console.log('[NI] detail already in description (exact), skipping');
    return false;
  }
  
  // ✅ NUEVO: Si la descripción contiene al detalle (o viceversa)
  if (normalizedDetail.includes(normalizedDesc) && normalizedDesc.length > 10) {
    if (DEBUG) console.log('[NI] detail contains current description, skipping (would duplicate)');
    return false;
  }
  
  // ✅ NUEVO: Si la descripción ya contiene la mayoría de las palabras del detalle
  const detailWords = normalizedDetail.split(/\s+/).filter(w => w.length > 2);
  const matchingWords = detailWords.filter(w => normalizedDesc.includes(w));
  if (detailWords.length > 0 && matchingWords.length / detailWords.length > 0.6) {
    if (DEBUG) console.log('[NI] detail mostly duplicated (60%+ words match), skipping', {
      detailWords: detailWords.length,
      matchingWords: matchingWords.length
    });
    return false;
  }
  
  // ✅ NUEVO: Si el detalle es muy similar a la descripción original
  const descOriginal = norm(session.draft.descripcion_original || '');
  if (descOriginal && normalizedDetail.length > 10) {
    // Comparar palabras con la descripción original también
    const origWords = descOriginal.split(/\s+/).filter(w => w.length > 2);
    const matchingOrigWords = detailWords.filter(w => descOriginal.includes(w));
    if (detailWords.length > 0 && matchingOrigWords.length / detailWords.length > 0.6) {
      if (DEBUG) console.log('[NI] detail duplicates original description (60%+ words), skipping');
      return false;
    }
  }
  
  // ✅ NUEVO: Si el detalle es el mismo mensaje del usuario que inició la sesión
  const lastUserText = norm(session._lastUserText || '');
  if (lastUserText && normalizedDetail.length > 10) {
    if (lastUserText.includes(normalizedDetail) || normalizedDetail.includes(lastUserText)) {
      if (DEBUG) console.log('[NI] detail matches last user text, skipping');
      return false;
    }
  }
  
  // Concatenar el detalle
  const separator = currentDesc.endsWith('.') || currentDesc.endsWith('!') || currentDesc.endsWith('?') ? ' ' : '. ';
  const newDesc = currentDesc ? `${currentDesc}${separator}${detail}` : detail;
  
  session.draft.descripcion = newDesc;
  session.draft.descripcion_original = session.draft.descripcion_original || currentDesc;
  
  if (DEBUG) console.log('[NI] detail added to description', { 
    detail: detail.substring(0, 50), 
    newLength: newDesc.length 
  });
  
  return true;
}

/**
 * Construye la descripción final con todos los detalles
 */
function buildDescripcionWithDetails(session, base = null) {
  // La descripción ya incluye los detalles agregados
  return session.draft.descripcion || base || session.draft.incidente || session.draft.descripcion_original || '';
}

/* ──────────────────────────────
 * Mapeo mode → focus (para IA)
 * ────────────────────────────── */
function modeToFocus(mode) {
  switch (mode) {
    case 'ask_place': return 'lugar';
    case 'ask_area': return 'area';
    case 'confirm': case 'preview': return 'confirm';
    default: return 'neutral';
  }
}

/* ──────────────────────────────
 * Área explícita (regex)
 * ────────────────────────────── */
function extractExplicitArea(text) {
  if (!text) return null;
  const t = String(text).toLowerCase();
  
  // Patrones para detectar área explícita
  if (/\b(solo\s+)?(it|sistemas?|tecnolog[ií]a)\b/.test(t)) return 'it';
  if (/\b(solo\s+)?(mant|mantenimiento)\b/.test(t)) return 'man';
  if (/\b(solo\s+)?(ama|hskp|housekeep|limpieza)\b/.test(t)) return 'ama';
  if (/\b(solo\s+)?(segur|vigilancia)\b/.test(t)) return 'seg';
  if (/\b(solo\s+)?(rs|room\s*service)\b/.test(t)) return 'rs';
  
  return null;
}

/* ──────────────────────────────
 * Generación de folio por área
 * ────────────────────────────── */
const FOLIO_COUNTER_FILE = path.join(process.cwd(), 'data', 'folio_counters.json');

function getAreaPrefix(areaCode) {
  // ✅ Formato estándar igual que incidenceDB
  const prefixes = {
    'man': 'MAN',
    'it': 'IT',
    'rs': 'RS',
    'ama': 'HSKP',
    'seg': 'SEG',
    'exp': 'EXP'
  };
  return prefixes[areaCode] || 'GEN';
}

function loadFolioCounters() {
  try {
    if (fs.existsSync(FOLIO_COUNTER_FILE)) {
      return JSON.parse(fs.readFileSync(FOLIO_COUNTER_FILE, 'utf8'));
    }
  } catch (e) {
    if (DEBUG) console.warn('[FOLIO] load counters err', e?.message);
  }
  return {};
}

function saveFolioCounters(counters) {
  try {
    const dir = path.dirname(FOLIO_COUNTER_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(FOLIO_COUNTER_FILE, JSON.stringify(counters, null, 2));
  } catch (e) {
    if (DEBUG) console.warn('[FOLIO] save counters err', e?.message);
  }
}

function generateFolio(areaCode) {
  const prefix = getAreaPrefix(areaCode);
  const counters = loadFolioCounters();
  
  // Obtener el siguiente número para esta área
  const currentCount = counters[prefix] || 0;
  const nextCount = currentCount + 1;
  
  // Guardar el nuevo contador
  counters[prefix] = nextCount;
  saveFolioCounters(counters);
  
  // Formatear con ceros a la izquierda (3 dígitos mínimo)
  const numStr = String(nextCount).padStart(3, '0');
  
  return `${prefix}-${numStr}`;
}

/* ──────────────────────────────
 * Finalizar y despachar
 * ────────────────────────────── */
async function finalizeAndDispatch({ client, msg, session }) {
  const s = session;
  const chatId = msg.from;

  // Generar folio con formato de área
  const folio = generateFolio(s.draft.area_destino);
  s.draft.folio = folio;
  s.draft.status = 'open';
  s.draft.created_at = new Date().toISOString();
  s.draft.requester_phone = chatId.replace('@c.us', '');
  s.draft.chat_id = chatId;  // Guardar el chat_id del solicitante

  // Persistir - el ID se genera en incidenceDB
  let incidentId = null;
  try {
    const result = await persistIncident(s.draft);
    incidentId = result?.id || null;
    s.draft.id = incidentId; // Actualizar el draft con el ID generado
    if (DEBUG) console.log('[NI] persisted', { id: incidentId, folio });
  } catch (e) {
    if (DEBUG) console.warn('[NI] persist.err', e?.message || e);
  }

  // Si no se pudo persistir, abortar
  if (!incidentId) {
    if (DEBUG) console.warn('[NI] no incidentId after persist, aborting dispatch');
    await replySafe(msg, '❌ Error al guardar el ticket. Intenta de nuevo.');
    return;
  }

  // Guardar adjuntos
  if (Array.isArray(s._pendingMedia) && s._pendingMedia.length) {
    try {
      if (!fs.existsSync(ATTACH_DIR)) fs.mkdirSync(ATTACH_DIR, { recursive: true });
      const attachments = [];
      for (let i = 0; i < s._pendingMedia.length; i++) {
        const m = s._pendingMedia[i];
        const ext = (m.mimetype || '').split('/')[1] || 'bin';
        const fname = `${folio}_${i}.${ext}`;
        const fpath = path.join(ATTACH_DIR, fname);
        fs.writeFileSync(fpath, Buffer.from(m.data, 'base64'));
        attachments.push({ filename: fname, url: `${ATTACH_BASEURL}/${fname}`, mimetype: m.mimetype });
      }
      await appendIncidentAttachments(incidentId, attachments);
      if (DEBUG) console.log('[NI] attachments.saved', { count: attachments.length });
    } catch (e) {
      if (DEBUG) console.warn('[NI] attachments.err', e?.message || e);
    }
  }

  // Enviar a grupos
  try {
    const cfg = await loadGroupsConfig();
    const { primaryId, ccIds, unknownAreas } = resolveTargetGroups(
      { area_destino: s.draft.area_destino, areas: s.draft.areas || [] },
      cfg
    );
    
    if (DEBUG) console.log('[NI] group targets', { primaryId, ccIds, unknownAreas });
    
    if (primaryId) {
      // Formatear mensaje
      const formatted = formatIncidentMessage({
        id: incidentId,
        folio: folio,
        descripcion: s.draft.descripcion_original || s.draft.descripcion,
        lugar: s.draft.lugar,
        originChatId: chatId
      });
      
      // Preparar media si hay
      let media = null;
      if (Array.isArray(s._pendingMedia) && s._pendingMedia.length > 0) {
        const firstMedia = s._pendingMedia[0];
        if (firstMedia && firstMedia.mimetype && firstMedia.data) {
          const { MessageMedia } = require('whatsapp-web.js');
          media = new MessageMedia(firstMedia.mimetype, firstMedia.data, firstMedia.filename || undefined);
        }
      }
      
      // Enviar
      const result = await sendIncidentToGroups(client, {
        message: formatted,
        primaryId,
        ccIds,
        media
      });
      
      if (result.sent && result.sent.length > 0) {
        const targetIds = result.sent.map(s => s.id);
        await appendDispatchedToGroupsEvent(incidentId, targetIds);
        recordGroupDispatch(incidentId, targetIds);
        if (DEBUG) console.log('[NI] dispatched', { folio, incidentId, sent: result.sent, errors: result.errors });
      } else {
        if (DEBUG) console.warn('[NI] dispatch failed', { errors: result.errors });
      }
    } else {
      if (DEBUG) console.warn('[NI] no primary group configured for area:', s.draft.area_destino);
    }
  } catch (e) {
    if (DEBUG) console.warn('[NI] dispatch.err', e?.message || e);
  }

  // Confirmar al usuario
  await replySafe(msg, `✅ *Ticket creado:* ${folio}\n\nTe avisaré cuando haya novedades.`);

  // Limpiar sesión
  closeSession(s);
  s._pendingMedia = [];
  s._visionAreaHints = null;
  s._mediaBatch = null;
  s._askedPlaceMuteUntil = 0;
  
  resetSession(chatId);
  if (DEBUG) console.log('[NI] closed: dispatched', { folio });
}

/* ──────────────────────────────
 * Detectar múltiples áreas/problemas en un mensaje
 * ────────────────────────────── */
async function detectMultipleAreas(text) {
  if (!text) return null;
  
  const t = text.toLowerCase();
  const detected = [];
  
  // ✅ NUEVO: Términos que indican que TODO el problema es de IT (aunque mencione TV)
  const itContextTerms = [
    /chromecast/i,
    /apple\s*tv/i,
    /roku/i,
    /streaming/i,
    /conectar(se)?\s+(a\s+)?(la\s+)?tv/i,  // "conectar a la TV" = IT
    /internet/i,
    /wifi|wi-fi/i,
    /netflix|youtube|prime|hbo|disney/i,
    /proyectar|mirror|screen\s*cast/i,
    /celular\s+(a|en)\s+(la\s+)?tv/i,  // "celular a la tv" = streaming
    /tel[eé]fono\s+(a|en)\s+(la\s+)?tv/i,
  ];
  
  // Si hay contexto de IT/streaming, NO es problema de mantenimiento
  const isITContext = itContextTerms.some(rx => rx.test(t));
  
  // Patrones para cada área con descripción
  const areaPatterns = [
    // HSKP / Limpieza
    {
      code: 'ama',
      patterns: [
        /limpieza|limpiar|limpien|limpio|limpia|sucia|sucio/i,
        /derramo|derram[oó]|cay[oó]\s+(agua|liquido|vaso|copa)/i,
        /toallas?|s[aá]banas?|almohadas?/i,
        /amenidades|amenities/i,
        /basura|bote de basura/i,
        /ba[ñn]o\s+(sucio|limpi)/i,
      ],
      extractDesc: (txt) => {
        const m = txt.match(/(se\s+(le\s+)?)?(cay[oó]|derramo|derram[oó])[^,.]*[,.]?/i) ||
                  txt.match(/(solicita|necesita|pide|requiere)\s+(que\s+)?(limpi|limpieza)[^,.]*[,.]?/i) ||
                  txt.match(/(limpieza|limpiar|limpien)[^,.]*[,.]?/i) ||
                  txt.match(/necesita\s+que\s+limpien[^,.]*[,.]?/i);
        return m ? m[0].trim() : 'Solicita limpieza';
      }
    },
    // Mantenimiento
    {
      code: 'man',
      patterns: [
        /no\s+(funciona|sirve|prende|enciende)/i,
        /televisi[oó]n|tv|tele\b/i,
        /aire\s*acondicionado|a\/c|clima/i,
        /fuga|gotea|tapado|tapada/i,
        /puerta|ventana|cortina|persiana/i,
        /luz|foco|l[aá]mpara|apagad[oa]/i,
        /descompuest[oa]|da[ñn]ad[oa]|rot[oa]/i,
        /regadera|lavamanos|lavabo|inodoro|wc/i,
        /revisar|revisen|checar|chequen/i,
      ],
      // ✅ NUEVO: Excluir si el contexto es claramente IT
      skipIf: () => isITContext,
      extractDesc: (txt) => {
        // Patrones específicos - se detienen en coma, punto, "y", o fin de oración
        const m = txt.match(/fuga\s+de\s+\w+/i) ||
                  txt.match(/(hay\s+una\s+)?fuga[^,.y]*(?=[,.y]|$)/i) ||
                  txt.match(/(la\s+)?televisi[oó]n[^,.y]*no\s+funciona/i) ||
                  txt.match(/(el\s+)?tv[^,.y]*no\s+(funciona|sirve)/i) ||
                  txt.match(/(la\s+)?(puerta|ventana|cortina)[^,.y]*(no\s+)?(funciona|abre|cierra|trabada?)/i) ||
                  txt.match(/(el\s+)?(aire|a\/c|clima)[^,.y]*no\s+(funciona|enfr[ií]a)/i) ||
                  txt.match(/(gotea|tapado|tapada)[^,.y]*/i) ||
                  txt.match(/revisen?\s+[^,.y]+/i);
        return m ? m[0].trim() : 'Requiere revisión de mantenimiento';
      }
    },
    // IT / Sistemas
    {
      code: 'it',
      patterns: [
        /internet|wifi|wi-fi/i,
        /chromecast|apple\s*tv|roku|streaming/i,
        /tel[eé]fono\s+(no\s+)?(funciona|sirve|tiene)/i,
        /computadora|laptop|tablet/i,
        /sistema|sistemas/i,
        /conectar(se)?\s+(a\s+)?(la\s+)?tv/i, // "conectar a la TV" = IT
        /proyectar|mirror|screen\s*cast/i,
      ],
      extractDesc: (txt) => {
        // Patrones específicos - se detienen en coma, punto, "y", o fin de oración
        const m = txt.match(/(no\s+sirve\s+el\s+)?internet/i) ||
                  txt.match(/(el\s+)?internet\s+no\s+(sirve|funciona)/i) ||
                  txt.match(/(wifi|wi-fi)[^,.y]*/i) ||
                  txt.match(/(chromecast|apple\s*tv|roku)[^,.y]*/i) ||
                  txt.match(/temas?\s+con\s+(su\s+)?(chromecast|internet|wifi)/i) ||
                  txt.match(/conectar(se)?\s+(a\s+)?(la\s+)?tv[^,.y]*/i) ||
                  txt.match(/tel[eé]fono[^,.y]*/i);
        return m ? m[0].trim() : 'Problema de sistemas';
      }
    },
    // Seguridad
    {
      code: 'seg',
      patterns: [
        /seguridad|vigilancia/i,
        /robo|robaron|perdido|perdi[oó]/i,
        /(persona|gente|alguien)\s+(sospechos[oa]|extra[ñn][oa])/i,  // Más específico
        /emergencia/i,
      ],
      extractDesc: (txt) => {
        const m = txt.match(/(seguridad|vigilancia)[^,.]*[,.]?/i) ||
                  txt.match(/(robo|perdido)[^,.]*[,.]?/i) ||
                  txt.match(/(persona|gente|alguien)\s+(sospechos[oa]|extra[ñn][oa])[^,.]*[,.]?/i);
        return m ? m[0].trim() : 'Asunto de seguridad';
      }
    },
    // Room Service
    {
      code: 'rs',
      patterns: [
        /room\s*service/i,
        /comida|alimentos|bebida/i,
        /desayuno|almuerzo|cena/i,
        /men[uú]|carta/i,
      ],
      extractDesc: (txt) => {
        const m = txt.match(/(room\s*service)[^,.]*[,.]?/i) ||
                  txt.match(/(comida|alimentos)[^,.]*[,.]?/i);
        return m ? m[0].trim() : 'Solicitud de room service';
      }
    },
  ];
  
  // Detectar qué áreas están presentes
  for (const area of areaPatterns) {
    // ✅ NUEVO: Saltar si hay condición de exclusión
    if (area.skipIf && area.skipIf()) {
      if (DEBUG) console.log('[NI] detectMultipleAreas: skipping', area.code, 'due to context');
      continue;
    }
    
    for (const pattern of area.patterns) {
      if (pattern.test(t)) {
        // Evitar duplicados
        if (!detected.find(d => d.code === area.code)) {
          const desc = area.extractDesc(text);
          detected.push({
            code: area.code,
            hint: desc.length > 50 ? desc.substring(0, 47) + '...' : desc,
            description: desc
          });
        }
        break;
      }
    }
  }
  
  // Solo retornar si hay más de un área
  if (detected.length > 1) {
    return detected;
  }
  
  return null;
}

/* ──────────────────────────────
 * Extraer descripción para una habitación específica
 * cuando hay múltiples habitaciones en el mensaje
 * ────────────────────────────── */
function extractDescriptionForRoom(fullText, targetRoom, allRooms) {
  if (!fullText || !targetRoom) return fullText;
  
  // Estrategia: dividir el texto por las habitaciones y tomar la parte relevante
  const text = fullText;
  
  // Buscar patrones que separan las habitaciones
  // Ej: "en 1202 revisar blackouts y en 1203 la puerta no funciona"
  
  // Crear regex para encontrar cada segmento
  const segments = [];
  
  for (let i = 0; i < allRooms.length; i++) {
    const room = allRooms[i];
    const nextRoom = allRooms[i + 1];
    
    // Patrón para encontrar desde esta habitación hasta la siguiente (o final)
    let pattern;
    if (nextRoom) {
      // Capturar desde esta habitación hasta antes de la siguiente
      pattern = new RegExp(
        `(?:en\\s+)?${room}[,.]?\\s*(.+?)(?=(?:y\\s+)?(?:en\\s+)?${nextRoom}|$)`,
        'i'
      );
    } else {
      // Última habitación: capturar hasta el final
      pattern = new RegExp(
        `(?:en\\s+)?${room}[,.]?\\s*(.+)$`,
        'i'
      );
    }
    
    const match = text.match(pattern);
    if (match && match[1]) {
      segments.push({
        room,
        description: match[1].trim()
      });
    }
  }
  
  // Buscar el segmento de la habitación objetivo
  const targetSegment = segments.find(s => s.room === targetRoom);
  
  if (targetSegment && targetSegment.description) {
    // Limpiar conectores al final ("y", "también", etc.)
    let desc = targetSegment.description
      .replace(/\s+y\s*$/i, '')
      .replace(/\s+también\s*$/i, '')
      .replace(/\s+además\s*$/i, '')
      .trim();
    
    return desc || fullText;
  }
  
  // Fallback: si no pudimos segmentar, buscar contexto alrededor del número
  const roomIndex = text.indexOf(targetRoom);
  if (roomIndex !== -1) {
    // Tomar desde la habitación hasta el siguiente número o final
    let endIndex = text.length;
    for (const room of allRooms) {
      if (room !== targetRoom) {
        const idx = text.indexOf(room, roomIndex + 4);
        if (idx !== -1 && idx < endIndex) {
          endIndex = idx;
        }
      }
    }
    
    let segment = text.substring(roomIndex, endIndex).trim();
    // Quitar el número de habitación del inicio
    segment = segment.replace(/^\d{4}[,.]?\s*/, '');
    // Limpiar conectores
    segment = segment.replace(/\s+y\s*$/i, '').trim();
    
    if (segment.length > 5) {
      return segment;
    }
  }
  
  return fullText;
}

/* ──────────────────────────────
 * Limpieza de descripción
 * ────────────────────────────── */
function cleanDescription(rawText) {
  if (!rawText) return '';
  
  let text = String(rawText).trim();
  
  // 1) Eliminar menciones de WhatsApp (formatos: @123456, @⁨Nombre⁩)
  text = text.replace(/@\d+/g, '');
  text = text.replace(/@⁨[^⁩]*⁩/g, ''); // Menciones con caracteres especiales
  text = text.replace(/@[\w\s]+(?=\s|$|,|\.)/g, ''); // Menciones simples
  
  // 2) Eliminar número de habitación SOLO al inicio (lo tenemos en el campo lugar)
  // ✅ FIX: Solo si está al inicio seguido de separador
  text = text.replace(/^\d{4}\s*[,.:;-]\s*/i, '');
  
  // 3) Eliminar frases introductorias comunes
  // ✅ FIX: Ser menos agresivo - solo eliminar cuando es claramente redundante
  const introPatterns = [
    // Patrones de huésped menciona/dice (estos SÍ son redundantes)
    /^(el\s+)?hu[eé]sped\s+(de\s+)?(la\s+)?(hab(itaci[oó]n)?\s*)?\d*\s*(menciona|dice|reporta|comenta|indica|pide|solicita)\s+(a\s+\w+\s+)?(que\s+)?/i,
    /^(la\s+)?hab(itaci[oó]n)?\s*\d*\s*(menciona|dice|reporta|comenta|indica)\s+(a\s+\w+\s+)?(que\s+)?/i,
    
    // "menciona a front que", "dice a sistemas que"
    /^menciona\s+(a\s+[\w\s]+\s+)?(que\s+)?/i,
    /^dice\s+(a\s+[\w\s]+\s+)?(que\s+)?/i,
    /^reporta\s+(a\s+[\w\s]+\s+)?(que\s+)?/i,
    /^comenta\s+(a\s+[\w\s]+\s+)?(que\s+)?/i,
    /^indica\s+(a\s+[\w\s]+\s+)?(que\s+)?/i,
    /^(nos\s+)?(avisa|informa|comunica)\s+(que\s+)?/i,
    
    // Cortesías simples (NO eliminar "necesito ayuda con" porque es contexto válido)
    /^(por\s+favor|pf|porfa|please|pls)[,.]?\s*/i,
    
    // "Hola, ..." al inicio
    /^(hola|buenos?\s+(d[ií]as?|tardes?|noches?))[,.]?\s*/i,
  ];
  
  for (const pattern of introPatterns) {
    text = text.replace(pattern, '').trim();
  }
  
  // 4) Eliminar "a front", "a sistemas", "a mantenimiento" sueltos
  text = text.replace(/^a\s+(front|sistemas|mantenimiento|seguridad|ama|hskp|rs|viceroy\s*connect)\s*(que\s+)?/i, '').trim();
  
  // 5) Eliminar referencias a habitación SOLO si ya tenemos el lugar establecido
  // ✅ FIX: Mantener "en 4302" si es parte de la descripción
  // Solo eliminar patrones muy específicos como "de la habitación 1234"
  text = text.replace(/\s+de\s+(la\s+)?habitaci[oó]n\s+\d+/gi, '');
  text = text.replace(/\s+de\s+adentro\s+de\s+(la\s+)?habitaci[oó]n/gi, '');
  
  // 6) Limpiar artículos/preposiciones al inicio que quedaron huérfanos
  // ✅ FIX: Solo si quedó algo muy corto al inicio
  if (/^(la|el)\s+\w{1,3}\s*$/i.test(text)) {
    text = text.replace(/^(la|el)\s+/i, '').trim();
  }
  
  // 7) Limpiar puntuación suelta al inicio/final
  text = text.replace(/^[,.:;!¡¿?\-–—]+\s*/g, '');
  text = text.replace(/\s*[,.:;]+$/g, '');
  
  // 8) Corregir typos comunes
  const typoFixes = [
    [/\bfrotn\b/gi, 'front'],
    [/\bfrton\b/gi, 'front'],
    [/\bfornt\b/gi, 'front'],
    [/\bmantenimeinto\b/gi, 'mantenimiento'],
    [/\bmantenimineto\b/gi, 'mantenimiento'],
    [/\bsegurdiad\b/gi, 'seguridad'],
    [/\bseguirdad\b/gi, 'seguridad'],
    [/\baire\s*acondicion?ado\b/gi, 'A/C'],
    [/\besta\s+tapado\b/gi, 'está tapado'],
    [/\besta\s+tapada\b/gi, 'está tapada'],
    [/\besta\s+trabado\b/gi, 'está trabado'],
    [/\besta\s+trabada\b/gi, 'está trabada'],
    [/\besta\s+roto\b/gi, 'está roto'],
    [/\besta\s+rota\b/gi, 'está rota'],
    [/\bno\s+sirve\b/gi, 'no funciona'],
    [/\bno\s+jala\b/gi, 'no funciona'],
  ];
  
  for (const [pattern, replacement] of typoFixes) {
    text = text.replace(pattern, replacement);
  }
  
  // 9) Simplificar frases redundantes
  text = text.replace(/cortinas?\s+de\s+adentro/gi, 'cortina interior');
  text = text.replace(/cortinas?\s+de\s+afuera/gi, 'cortina exterior');
  text = text.replace(/de\s+adentro/gi, 'interior');
  text = text.replace(/de\s+afuera/gi, 'exterior');
  
  // 10) Eliminar espacios múltiples y limpiar
  text = text.replace(/\s+/g, ' ').trim();
  
  // 11) Capitalizar primera letra
  if (text.length > 0) {
    text = text.charAt(0).toUpperCase() + text.slice(1);
  }
  
  // 12) Si quedó muy corto, intentar extraer el problema del texto original
  if (text.length < 5) {
    // Buscar patrones de problema en el texto original
    const problemPatterns = [
      /(?:que\s+)?((?:el|la|los|las)\s+)?(\w+)\s+(est[aá]\s+)?(tapado|tapada|trabado|trabada|roto|rota|no\s+funciona|no\s+sirve)/i,
      /(no\s+hay\s+\w+)/i,
      /(fuga\s+de\s+\w+)/i,
      /(se\s+\w+\s+(?:el|la)\s+\w+)/i,
    ];
    
    for (const pattern of problemPatterns) {
      const match = rawText.match(pattern);
      if (match) {
        text = match[0].trim();
        text = text.replace(/^que\s+/i, '');
        text = text.charAt(0).toUpperCase() + text.slice(1);
        break;
      }
    }
  }
  
  // 13) Fallback: si aún está vacío, usar algo del original
  if (text.length < 3) {
    text = String(rawText)
      .replace(/@⁨[^⁩]*⁩/g, '')
      .replace(/@\d+/g, '')
      .replace(/^\d{4}\s*[,.:;-]?\s*/i, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (text.length > 0) {
      text = text.charAt(0).toUpperCase() + text.slice(1);
    }
  }
  
  return text;
}

/* ──────────────────────────────
 * Refrescar descripción con IA
 * ────────────────────────────── */
async function refreshIncidentDescription(session, latestUserText, explicitBaseText=null) {
  const base =
    explicitBaseText ||
    session.draft.descripcion_original ||
    latestUserText ||
    session.draft.descripcion ||
    '';

  const lugarLabel = session.draft.lugar || null;
  const areaCode   = session.draft.area_destino || null;

  // Primero limpiar el texto
  const cleanedBase = cleanDescription(base);

  try {
    const { incident } = await deriveIncidentText({
      text: cleanedBase,
      lugarLabel,
      areaCode,
    });

    session.draft.incidente = incident;
    session.draft.descripcion = buildDescripcionWithDetails(session, incident);
    
    // Guardar también la versión limpia como original
    if (!session.draft.descripcion_original || session.draft.descripcion_original === base) {
      session.draft.descripcion_original = cleanedBase;
    }
  } catch (e) {
    if (DEBUG) console.warn('[NI] deriveIncidentText err, using cleaned text', e?.message);
    // Fallback: usar el texto limpio directamente
    session.draft.incidente = cleanedBase;
    session.draft.descripcion = cleanedBase;
    if (!session.draft.descripcion_original) {
      session.draft.descripcion_original = cleanedBase;
    }
  }
}

async function handleTurn(client, msg, { catalogPath } = {}) {
  if (!msg) return;

  // ✅ Anti doble-ejecución
  if (msg.__niTurnHandled === true) return;
  msg.__niTurnHandled = true;

  const chatId = msg.from;
  const text = (msg.body || '').trim();

  try {
    ensureReady();
  } catch (e) {
    if (DEBUG) console.warn('[NI] ensureReady err', e?.message || e);
  }

  try {
    await loadLocationCatalogIfNeeded(catalogPath);
  } catch (e) {
    if (DEBUG) console.warn('[NI] loadLocationCatalogIfNeeded err', e?.message || e);
  }

  const s = ensureSession(chatId);
  
  // ✅ NUEVO: Filtrar mensajes ambiguos/basura ANTES de procesarlos
  // Solo si NO hay sesión activa con draft
  if (isSessionBareForNI(s) && !msg.hasMedia) {
    const tNorm = norm(text);
    const words = tNorm.split(/\s+/).filter(w => w.length > 1);
    const wordCount = words.length;
    
    // Mensaje demasiado corto (< 3 palabras significativas) sin keywords de incidencia
    const incidentKeywords = /\b(ayuda|help|problema|issue|falla|fuga|roto|dañado|no\s+(funciona|sirve|enciende|prende)|urgente|urge|emergencia|accidente|cay[oó]|herido)\b/i;
    const roomKeywords = /\b(hab(itacion)?|room|villa|cuarto)\s*\d+|\d{4}\b/i;
    
    // ✅ NUEVO: Detectar mensajes tipo "x en el chat", "f de nada" (1 letra + relleno)
    const garbagePatterns = [
      /^[a-z]\s+(en|de|para|con|el|la|un|una)\s+/i,  // "f en el chat", "x de nada"
      /^(jaja|haha|lol|xd|😂|🤣|👍|👌|🙏)+$/i,
      /^[\?\!\.]+$/,  // Solo signos de puntuación
      /^[a-z]{1,2}$/i,  // Solo 1-2 letras
    ];
    
    if (garbagePatterns.some(rx => rx.test(tNorm))) {
      if (DEBUG) console.log('[NI] garbage message, generating contextual response', { text });
      
      // ✅ NUEVO: Generar respuesta contextual con IA
      try {
        const contextualResponse = await generateContextualResponse(text);
        await replySafe(msg, contextualResponse);
      } catch (e) {
        // Fallback si falla la IA
        if (DEBUG) console.warn('[NI] contextual response error, using fallback', e?.message);
        await replySafe(msg,
          '👋 ¡Hola! Soy el bot de *incidencias* del hotel.\n\n' +
          'Si necesitas reportar algo que *no funciona* o está *dañado*, cuéntame qué pasó y dónde está.\n\n' +
          '_Ejemplo: "No funciona el aire en hab 1205"_'
        );
      }
      return;
    }
    
    if (wordCount < 3 && !incidentKeywords.test(tNorm) && !roomKeywords.test(tNorm)) {
      // Verificar si es un saludo o mensaje casual
      const casualPatterns = [
        /^(hola|hi|hey|buenas?|que\s*tal|como\s*estas?)$/i,
        /^(ok|si|no|ya|listo|vale|dale)$/i,
      ];
      
      if (casualPatterns.some(rx => rx.test(tNorm)) || wordCount <= 1) {
        if (DEBUG) console.log('[NI] casual message, responding with intro', { text, wordCount });
        // Responder con introducción amigable
        await replySafe(msg,
          '👋 ¡Hola! Soy el bot de *incidencias* del hotel.\n\n' +
          '¿Tienes algo que reportar? Cuéntame:\n' +
          '• ¿Qué *problema* hay? (algo no funciona, está dañado, etc.)\n' +
          '• ¿*Dónde* está? (habitación, área del hotel)\n\n' +
          '_Ejemplo: "La regadera gotea en hab 1312"_'
        );
        return;
      }
      
      // ✅ MEJORADO: Si es un mensaje corto pero parece pregunta casual (como "ya comiste?"), usar IA
      const casualQuestionPatterns = [
        /\?$/,  // Termina en signo de pregunta
        /^(como|que|donde|cuando|quien|cual|por\s*que)\b/i,  // Pregunta
        /^(ya|tu|te|me|nos|les)\s+\w+/i,  // Pregunta casual
      ];
      
      if (wordCount === 2 && casualQuestionPatterns.some(rx => rx.test(tNorm))) {
        if (DEBUG) console.log('[NI] casual question, generating contextual response', { text });
        try {
          const contextualResponse = await generateContextualResponse(text);
          await replySafe(msg, contextualResponse);
        } catch (e) {
          await replySafe(msg,
            '👋 ¡Hola! Soy el bot de *incidencias* del hotel.\n\n' +
            'Si necesitas reportar algo que *no funciona* o está *dañado*, cuéntame qué pasó y dónde está.'
          );
        }
        return;
      }
      
      // Si es un mensaje corto pero no parece casual, preguntar clarificación
      if (wordCount === 2) {
        if (DEBUG) console.log('[NI] short message, asking clarification', { text });
        await replySafe(msg,
          '🤔 No entendí bien tu mensaje.\n\n' +
          'Si necesitas reportar un *problema* (algo no funciona, está dañado, etc.), cuéntame:\n' +
          '• ¿Qué pasó?\n' +
          '• ¿Dónde está? (habitación, área, etc.)'
        );
        return;
      }
    }
  }
  
  // ✅ NUEVO: Detectar mensajes de agradecimiento/seguimiento que NO son incidencias
  // Solo aplica si NO hay sesión activa con draft
  if (isSessionBareForNI(s) && !msg.hasMedia) {
    const tNorm = norm(text);
    
    // Patrones de agradecimiento/seguimiento (no son incidencias nuevas)
    const thankYouPatterns = [
      /^(gracias|muchas\s+gracias|ok\s+gracias|perfecto|excelente|genial)\b/i,
      /\b(quedo\s+al\s+pendiente|quedo\s+pendiente|quedamos\s+atentos?)\b/i,
      /^(listo|entendido|perfecto|recibido|enterado)\b/i,
      /\b(avisen\s+(cuando|si|por\s+favor))\b/i,
      /\b(me\s+avisan|nos\s+avisan)\b/i,
      /\b(pueden\s+hablarme|pueden\s+llamarme|me\s+llaman|me\s+hablan)\b/i,
    ];
    
    // Si parece mensaje de seguimiento/agradecimiento
    if (thankYouPatterns.some(rx => rx.test(tNorm))) {
      // Verificar si NO tiene keywords de incidencia NUEVA
      const incidentKeywords = /\b(fuga|gotea|no\s+funciona|no\s+enciende|roto|dañado|problema\s+nuevo|falla|averi[ao]|urge|urgente)\b/i;
      
      if (!incidentKeywords.test(tNorm)) {
        if (DEBUG) console.log('[NI] detected follow-up message', { text: text.substring(0, 50) });
        
        // ✅ MEJORADO: Buscar ticket reciente de este usuario para reenviar mensaje al equipo
        try {
          const { listIncidentsForChat, appendIncidentEvent, getIncidentById } = require('../db/incidenceDB');
          const recentTickets = await listIncidentsForChat(chatId, { 
            statuses: ['open', 'in_progress'], 
            limit: 1 
          });
          
          if (recentTickets && recentTickets.length > 0) {
            const lastTicket = recentTickets[0];
            const ticketAge = Date.now() - new Date(lastTicket.created_at).getTime();
            const maxAge = 30 * 60 * 1000; // 30 minutos
            
            // Solo si el ticket es reciente (< 30 min)
            if (ticketAge < maxAge) {
              // Guardar como comentario del solicitante
              await appendIncidentEvent(lastTicket.id, {
                event_type: 'requester_followup',
                wa_msg_id: msg.id?._serialized || null,
                payload: { 
                  message: text,
                  from: chatId,
                }
              });
              
              // Reenviar al grupo destino
              const cfg = await loadGroupsConfig();
              const { primaryId } = resolveTargetGroups(
                { area_destino: lastTicket.area_destino, areas: [lastTicket.area_destino] },
                cfg
              );
              
              if (primaryId && client) {
                const followupMsg = [
                  `📨 *Mensaje adicional* — ${lastTicket.folio}`,
                  ``,
                  `_"${text}"_`,
                  ``,
                  `— Solicitante`
                ].join('\n');
                
                try {
                  await client.sendMessage(primaryId, followupMsg);
                  if (DEBUG) console.log('[NI] forwarded follow-up to team', { folio: lastTicket.folio, groupId: primaryId });
                } catch (e) {
                  if (DEBUG) console.warn('[NI] forward follow-up error', e?.message);
                }
              }
              
              await replySafe(msg, `👍 Le paso tu mensaje al equipo de *${lastTicket.folio}*.`);
              return;
            }
          }
        } catch (e) {
          if (DEBUG) console.warn('[NI] follow-up lookup error', e?.message);
        }
        
        // Si no hay ticket reciente, responder cortésmente
        await replySafe(msg, '👍 Perfecto, quedo al pendiente. Te aviso en cuanto haya novedades.');
        return;
      }
    }
  }
  
  // ✅ NUEVO: Detectar solicitudes directas que NO son incidencias
  // (el usuario confunde al bot con room service, recepción, etc.)
  // ✅ NUEVO: Detectar solicitudes directas que NO son incidencias
  // Solo si NO hay sesión activa con draft Y no está en modo confirm
  if (isSessionBareForNI(s) && !msg.hasMedia && s.mode !== 'confirm' && s.mode !== 'preview') {
    const tNorm = norm(text);
    
    // Patrones de solicitudes directas (NO son reportes de incidencias)
    const directRequestPatterns = [
      /^(me\s+)?puedes?\s+(traer|llevar|enviar|mandar)/i,          // "me puedes traer..."
      /^(me\s+)?tra(e|iga)s?\s+(un|una|el|la|mi)/i,               // "tráeme un..."
      /^(quiero|necesito|ocupo)\s+(un|una|que|comida|agua)/i,     // "quiero comida"
      /^tengo\s+(hambre|sed|frío|calor|sueño)/i,                  // "tengo hambre"
      /^(dame|deme|tráeme|tráigame)\s+/i,                         // "dame..."
      /^(reserva|resérvame|apartame)\s+/i,                        // "resérvame..."
    ];
    
    // Si parece solicitud directa
    if (directRequestPatterns.some(rx => rx.test(tNorm))) {
      // Verificar que NO sea un reporte de problema
      const problemKeywords = /\b(no\s+funciona|no\s+sirve|no\s+enciende|no\s+prende|roto|dañado|averiado|falla|fuga|gotea|problema|prender|encender)\b/i;
      
      if (!problemKeywords.test(tNorm)) {
        if (DEBUG) console.log('[NI] detected direct request (not incident)', { text: text.substring(0, 50) });
        
        await replySafe(msg, 
          '🤖 Soy el bot de incidencias del hotel. No puedo procesar solicitudes directas de servicio.\n\n' +
          '📞 Para *Room Service*, marca la extensión del restaurante.\n' +
          '🛎️ Para solicitudes a tu habitación, contacta a *Recepción*.\n\n' +
          'Si tienes un *problema técnico* que reportar (algo no funciona, está dañado, etc.), con gusto te ayudo a crear el ticket.'
        );
        return;
      }
    }
  }
  
  // ✅ NUEVO: Detectar si el mensaje menciona un folio existente para agregar comentario
  const folioInText = text.match(/\b([A-Z]{2,5}-\d{2,6})\b/i);
  if (folioInText && isSessionBareForNI(s)) {
    const folio = folioInText[1].toUpperCase();
    
    // Patrones que indican que quiere agregar comentario/nota
    const commentPatterns = [
      /\b(comentario|nota|agregar|añadir|para\s+el\s+mismo)\b/i,
      /\b(no\s+(fue|es)\s+(un\s+)?ticket\s+nuevo)\b/i,
      /\b(es\s+para\s+(el|ese)\s+ticket)\b/i,
    ];
    
    if (commentPatterns.some(rx => rx.test(text))) {
      try {
        const { getIncidentByFolio, appendIncidentEvent } = require('../db/incidenceDB');
        const incident = await getIncidentByFolio(folio);
        
        if (incident) {
          // Extraer el comentario (quitar el folio y frases de contexto)
          let comment = text
            .replace(folioInText[0], '')
            .replace(/\b(comentario|nota|agregar|añadir|para\s+el\s+mismo|no\s+(fue|es)\s+(un\s+)?ticket\s+nuevo|es\s+(solo\s+)?(un\s+)?comentario|perdón|perdon)\b/gi, '')
            .replace(/\s+/g, ' ')
            .trim();
          
          if (comment.length > 5) {
            await appendIncidentEvent(incident.id, {
              event_type: 'requester_comment',
              wa_msg_id: msg.id?._serialized || null,
              payload: { 
                comment,
                from: chatId,
              }
            });
            
            await replySafe(msg, `📝 Agregué el comentario al ticket *${folio}*:\n_"${comment}"_`);
            if (DEBUG) console.log('[NI] added comment to existing ticket', { folio, comment: comment.substring(0, 50) });
            return;
          }
        }
      } catch (e) {
        if (DEBUG) console.warn('[NI] comment add error', e?.message);
      }
    }
  }

  if (DEBUG) console.log('[NI] turn.start', { chatId, body: text, mode: s.mode });
  pushTurn(s, 'user', text);

  // ✅ NUEVO: Manejar modos especiales PRIMERO (antes de cualquier otro procesamiento)
  if (s.mode === 'different_problem' && text) {
    const t = norm(text);
    const pendingNewText = s._pendingNewIncidentText || '';
    
    if (DEBUG) console.log('[DIFFERENT_PROBLEM] handling response', { response: text, pendingLength: pendingNewText.length });
    
    // Opción: enviar - enviar el ticket actual y crear uno nuevo
    if (/^envi[ao]r?\b/i.test(t) || /^si\b/i.test(t)) {
      try {
        await finalizeAndDispatch({ client, msg, session: s });
      } catch (e) {
        if (DEBUG) console.warn('[DIFFERENT_PROBLEM] dispatch error', e?.message);
      }
      
      // Crear nuevo draft (sin ID hasta persistir)
      s.draft = {};
      s.draft.descripcion_original = pendingNewText;
      s.draft.descripcion = pendingNewText;
      s._pendingNewIncidentText = null;
      s._pendingOldIncidentDraft = null;
      s._pendingNewArea = null;
      s._areDifferentAreas = null;
      
      const strong = findStrongPlaceSignals(pendingNewText);
      if (strong) {
        await normalizeAndSetLugar(s, msg, strong.value, { rawText: pendingNewText });
      }
      
      try {
        const a = await detectArea(pendingNewText);
        if (a?.area) {
          setDraftField(s, 'area_destino', a.area);
          addArea(s, a.area);
        }
      } catch {}
      
      await refreshIncidentDescription(s, pendingNewText);
      const preview = formatPreviewMessage(s.draft);
      await replySafe(msg, '📋 *Nuevo ticket:*\n\n' + preview);
      setMode(s, 'confirm');
      return;
    }
    
    // Opción: reemplazar
    if (/^reemplaz[ao]r?\b/i.test(t) || /^sustitu[iy]r?\b/i.test(t)) {
      s.draft.descripcion = pendingNewText;
      s.draft.descripcion_original = pendingNewText;
      s.draft._details = [];
      s._pendingNewIncidentText = null;
      s._pendingOldIncidentDraft = null;
      s._pendingNewArea = null;
      s._areDifferentAreas = null;
      
      const strong = findStrongPlaceSignals(pendingNewText);
      if (strong) {
        await normalizeAndSetLugar(s, msg, strong.value, { rawText: pendingNewText });
      }
      
      try {
        const a = await detectArea(pendingNewText);
        if (a?.area) {
          setDraftField(s, 'area_destino', a.area);
          s.draft.areas = [a.area];
        }
      } catch {}
      
      await refreshIncidentDescription(s, pendingNewText);
      const preview = formatPreviewMessage(s.draft);
      await replySafe(msg, '✅ Ticket reemplazado:\n\n' + preview);
      setMode(s, 'confirm');
      return;
    }
    
    // Opción: agregar (solo si NO son áreas diferentes)
    if (/^agregar\b/i.test(t)) {
      if (s._areDifferentAreas) {
        await replySafe(msg,
          '⚠️ No puedo agregar como detalle porque son *áreas diferentes*.\n\n' +
          'Opciones:\n' +
          '• *enviar* — enviar el ticket actual y crear uno nuevo\n' +
          '• *reemplazar* — descartar el actual y usar el nuevo\n' +
          '• *cancelar* — ignorar el mensaje'
        );
        return;
      }
      
      const currentDesc = s.draft.descripcion || '';
      const separator = currentDesc.endsWith('.') || currentDesc.endsWith('!') || currentDesc.endsWith('?') ? ' ' : '. ';
      s.draft.descripcion = currentDesc + separator + pendingNewText;
      
      s._pendingNewIncidentText = null;
      s._pendingOldIncidentDraft = null;
      s._pendingNewArea = null;
      s._areDifferentAreas = null;
      
      const preview = formatPreviewMessage(s.draft);
      await replySafe(msg, '✅ Agregado como detalle:\n\n' + preview);
      setMode(s, 'confirm');
      if (DEBUG) console.log('[DIFFERENT_PROBLEM] added as detail', { newDesc: s.draft.descripcion?.substring(0, 80) });
      return;
    }
    
    // Opción: cancelar
    if (/^cancelar?\b/i.test(t) || /^ignorar?\b/i.test(t) || /^no\b/i.test(t)) {
      s._pendingNewIncidentText = null;
      s._pendingOldIncidentDraft = null;
      s._pendingNewArea = null;
      s._areDifferentAreas = null;
      const preview = formatPreviewMessage(s.draft);
      await replySafe(msg, '👌 Mensaje ignorado. Tu ticket sigue así:\n\n' + preview);
      setMode(s, 'confirm');
      return;
    }
    
    // No entendí
    const options = s._areDifferentAreas 
      ? '• *enviar* — enviar el ticket actual y crear uno nuevo\n• *reemplazar* — descartar el actual y usar el nuevo\n• *cancelar* — ignorar'
      : '• *enviar* — enviar el ticket actual y crear uno nuevo\n• *reemplazar* — descartar el actual y usar el nuevo\n• *agregar* — agregar como detalle\n• *cancelar* — ignorar';
    await replySafe(msg, '🤔 No entendí. Opciones:\n' + options);
    return;
  }

  // RESET NI
  if (isResetNICommand(text)) {
    if (DEBUG) console.log('[NI] manual reset command received', { chatId, text });
    closeSession(s);
    s._pendingMedia = [];
    s._visionAreaHints = null;
    s._mediaBatch = null;
    s._askedPlaceMuteUntil = 0;
    resetSession(chatId);
    await replySafe(
      msg,
      '🔄 He reiniciado el flujo de incidencias para este chat.\n' +
      'Cuando quieras, mándame de nuevo el *reporte completo* (qué pasa y en dónde) y lo armamos desde cero.'
    );
    return;
  }

  // ✅ NUEVO: Detectar y construir múltiples tickets de forma consolidada
  if (!s._batchTickets && !s.draft.lugar) {
    const roomMatches = text.match(/\b\d{4}\b/g);
    const uniqueRooms = roomMatches ? [...new Set(roomMatches)] : [];
    
    if (uniqueRooms.length >= 1) {
      // Construir lista de tickets potenciales
      const tickets = [];
      
      for (const room of uniqueRooms) {
        const roomDesc = uniqueRooms.length > 1 
          ? extractDescriptionForRoom(text, room, uniqueRooms)
          : text;
        
        // Detectar áreas para esta habitación
        const areasForRoom = await detectMultipleAreas(roomDesc);
        
        if (areasForRoom && areasForRoom.length > 1) {
          // Múltiples áreas para esta habitación
          for (const area of areasForRoom) {
            tickets.push({
              id: tickets.length + 1,
              room: room,
              lugar: `Habitación ${room}`,
              area: area.code,
              descripcion: cleanDescription(area.description || area.hint),
              descripcion_raw: area.description || area.hint
            });
          }
        } else {
          // Una sola área (o ninguna detectada)
          let areaCode = null;
          try {
            const a = await detectArea(roomDesc);
            if (a?.area) areaCode = a.area;
          } catch {}
          
          tickets.push({
            id: tickets.length + 1,
            room: room,
            lugar: `Habitación ${room}`,
            area: areaCode || 'man', // Default a mantenimiento
            descripcion: cleanDescription(roomDesc),
            descripcion_raw: roomDesc
          });
        }
      }
      
      // Si hay más de 1 ticket, usar flujo batch
      if (tickets.length > 1) {
        if (DEBUG) console.log('[NI] batch tickets detected', { count: tickets.length, tickets: tickets.map(t => ({ room: t.room, area: t.area })) });
        
        s._batchTickets = tickets;
        s._batchOriginalText = text;
        
        // Mostrar preview consolidado
        const ticketList = tickets.map((t, i) => 
          `${i + 1}. *${areaLabel(t.area)}* — Hab ${t.room} — _${t.descripcion.substring(0, 40)}${t.descripcion.length > 40 ? '...' : ''}_`
        ).join('\n');
        
        await replySafe(
          msg,
          `📝 Voy a crear *${tickets.length} tickets*:\n\n` +
          `${ticketList}\n\n` +
          `¿Los envío? Responde *sí*, *no*, o el *número* para editar.`
        );
        
        setMode(s, 'confirm_batch');
        return;
      }
      // Si solo hay 1 ticket, continuar con flujo normal
    }
  }
  
  // ✅ Manejar confirmación/edición de batch
  if (s.mode === 'confirm_batch' && s._batchTickets) {
    const choice = text.trim().toLowerCase();
    const tickets = s._batchTickets;
    
    // Cancelar
    if (/^(no|cancelar|salir)$/i.test(choice)) {
      s._batchTickets = null;
      s._batchOriginalText = null;
      s._editingTicketIndex = null;
      closeSession(s);
      resetSession(chatId);
      await replySafe(msg, '❌ Cancelado. Si necesitas reportar algo, solo dime.');
      return;
    }
    
    // Confirmar todos
    if (/^(s[ií]|si|yes|ok|dale|enviar|confirmar|listo)$/i.test(choice)) {
      // Crear todos los tickets
      const folios = [];
      
      for (const ticket of tickets) {
        try {
          // Preparar draft temporal (sin ID - lo genera incidenceDB)
          const tempDraft = {
            descripcion: ticket.descripcion,
            descripcion_original: ticket.descripcion_raw,
            lugar: ticket.lugar,
            area_destino: ticket.area,
            areas: [ticket.area],
            status: 'open',
            created_at: new Date().toISOString(),
            chat_id: chatId,
            requester_phone: chatId.replace('@c.us', ''),
          };
          
          // Generar folio
          const folio = generateFolio(ticket.area);
          tempDraft.folio = folio;
          folios.push({ folio, area: ticket.area, lugar: ticket.lugar, descripcion: ticket.descripcion });
          
          // Persistir - el ID se genera en incidenceDB
          let incidentId = null;
          try {
            const result = await persistIncident(tempDraft);
            incidentId = result?.id || null;
            if (DEBUG) console.log('[NI] batch ticket persisted', { folio, incidentId });
          } catch (e) {
            if (DEBUG) console.warn('[NI] batch persist err', e?.message);
          }
          
          if (!incidentId) continue; // Skip si no se pudo persistir
          
          // Enviar a grupo
          try {
            const cfg = await loadGroupsConfig();
            const { primaryId, ccIds } = resolveTargetGroups(
              { area_destino: ticket.area, areas: [ticket.area] },
              cfg
            );
            
            if (primaryId) {
              const formatted = formatIncidentMessage({
                id: tempDraft.id,
                folio: folio,
                descripcion: ticket.descripcion,
                lugar: ticket.lugar,
                originChatId: chatId
              });
              
              await sendIncidentToGroups(client, {
                message: formatted,
                primaryId,
                ccIds,
                media: null
              });
              if (DEBUG) console.log('[NI] batch ticket dispatched', { folio, primaryId });
            }
          } catch (e) {
            if (DEBUG) console.warn('[NI] batch dispatch err', e?.message);
          }
        } catch (e) {
          if (DEBUG) console.warn('[NI] batch ticket creation err', e?.message);
        }
      }
      
      // Confirmar al usuario
      const folioList = folios.map(f => `• *${f.folio}* — ${f.lugar} — ${f.descripcion.substring(0, 30)}...`).join('\n');
      await replySafe(
        msg,
        `✅ *${folios.length} tickets creados:*\n\n${folioList}\n\nTe avisaré cuando haya novedades.`
      );
      
      // Limpiar
      s._batchTickets = null;
      s._batchOriginalText = null;
      s._editingTicketIndex = null;
      closeSession(s);
      resetSession(chatId);
      if (DEBUG) console.log('[NI] batch complete', { folios: folios.map(f => f.folio) });
      return;
    }
    
    // Editar ticket específico
    const numChoice = parseInt(choice, 10);
    if (!isNaN(numChoice) && numChoice >= 1 && numChoice <= tickets.length) {
      s._editingTicketIndex = numChoice - 1;
      const ticket = tickets[numChoice - 1];
      
      await replySafe(
        msg,
        `📝 *Editando ticket #${numChoice}:*\n\n` +
        `• *Descripción:* ${ticket.descripcion}\n` +
        `• *Lugar:* ${ticket.lugar}\n` +
        `• *Área:* ${areaLabel(ticket.area)}\n\n` +
        `Escribe un detalle para agregarlo, o:\n` +
        `• *"área [nombre]"* | *"lugar [núm]"*\n` +
        `• *"descripción [texto]"* reemplazar\n` +
        `• *"eliminar"* | *"listo"*`
      );
      
      setMode(s, 'edit_batch_ticket');
      return;
    }
    
    // No entendió
    await replySafe(
      msg,
      `No entendí. Responde *sí* para enviar todos, *no* para cancelar, o el *número* (1-${tickets.length}) para editar.`
    );
    return;
  }
  
  // ✅ Manejar edición de ticket individual en batch
  if (s.mode === 'edit_batch_ticket' && s._batchTickets && s._editingTicketIndex !== null) {
    const tickets = s._batchTickets;
    const idx = s._editingTicketIndex;
    const ticket = tickets[idx];
    const input = text.trim();
    
    // Volver al resumen
    if (/^(listo|volver|ok|regresar)$/i.test(input)) {
      s._editingTicketIndex = null;
      
      const ticketList = tickets.map((t, i) => 
        `${i + 1}. *${areaLabel(t.area)}* — Hab ${t.room} — _${t.descripcion.substring(0, 40)}${t.descripcion.length > 40 ? '...' : ''}_`
      ).join('\n');
      
      await replySafe(
        msg,
        `📝 *${tickets.length} tickets*:\n\n` +
        `${ticketList}\n\n` +
        `¿Los envío? Responde *sí*, *no*, o el *número* para editar.`
      );
      
      setMode(s, 'confirm_batch');
      return;
    }
    
    // Eliminar ticket
    if (/^(eliminar|quitar|borrar|remover)$/i.test(input)) {
      tickets.splice(idx, 1);
      // Re-numerar
      tickets.forEach((t, i) => t.id = i + 1);
      s._editingTicketIndex = null;
      
      if (tickets.length === 0) {
        s._batchTickets = null;
        closeSession(s);
        resetSession(chatId);
        await replySafe(msg, '❌ Todos los tickets fueron eliminados. Si necesitas reportar algo, solo dime.');
        return;
      }
      
      const ticketList = tickets.map((t, i) => 
        `${i + 1}. *${areaLabel(t.area)}* — Hab ${t.room} — _${t.descripcion.substring(0, 40)}${t.descripcion.length > 40 ? '...' : ''}_`
      ).join('\n');
      
      await replySafe(
        msg,
        `✅ Ticket eliminado.\n\n📝 *${tickets.length} tickets*:\n\n` +
        `${ticketList}\n\n` +
        `¿Los envío? Responde *sí*, *no*, o el *número* para editar.`
      );
      
      setMode(s, 'confirm_batch');
      return;
    }
    
    // Cambiar área - formato formal
    const areaMatch = input.match(/^[aá]rea\s+(.+)$/i);
    if (areaMatch) {
      const newAreaText = areaMatch[1].trim().toLowerCase();
      const areaMap = {
        'mantenimiento': 'man', 'man': 'man', 'mant': 'man',
        'it': 'it', 'sistemas': 'it', 'tecnologia': 'it', 'tech': 'it',
        'ama': 'ama', 'housekeeping': 'ama', 'hskp': 'ama', 'limpieza': 'ama', 'ama de llaves': 'ama',
        'seguridad': 'seg', 'seg': 'seg', 'security': 'seg',
        'room service': 'rs', 'rs': 'rs', 'roomservice': 'rs'
      };
      
      const newArea = areaMap[newAreaText];
      if (newArea) {
        ticket.area = newArea;
        await replySafe(msg, `✅ Área cambiada a *${areaLabel(newArea)}*.\n\nEscribe *"listo"* para volver al resumen.`);
      } else {
        await replySafe(msg, `❌ No reconozco esa área. Opciones: mantenimiento, it, ama, seguridad, room service`);
      }
      return;
    }
    
    // ✅ Cambiar área - formato natural: "para it", "es de mantenimiento", "mándalo a seguridad", etc.
    const areaNaturalMatch = input.match(/^(para|es de|es para|de|a|mand[ao]l?o?\s+a|env[ií]al?o?\s+a|cambia\s+a)\s+(.+)$/i);
    if (areaNaturalMatch) {
      const areaText = areaNaturalMatch[2].trim().toLowerCase();
      const areaMap = {
        'mantenimiento': 'man', 'man': 'man', 'mant': 'man',
        'it': 'it', 'sistemas': 'it', 'tecnologia': 'it', 'tech': 'it',
        'ama': 'ama', 'housekeeping': 'ama', 'hskp': 'ama', 'limpieza': 'ama', 'ama de llaves': 'ama',
        'seguridad': 'seg', 'seg': 'seg', 'security': 'seg',
        'room service': 'rs', 'rs': 'rs', 'roomservice': 'rs'
      };
      
      const newArea = areaMap[areaText];
      if (newArea) {
        ticket.area = newArea;
        await replySafe(msg, `✅ Área cambiada a *${areaLabel(newArea)}*.\n\nEscribe *"listo"* para volver al resumen.`);
        return;
      }
      // Si no matchea área, continúa al flujo de agregar detalle
    }
    
    // Cambiar lugar/habitación
    const lugarMatch = input.match(/^(lugar|habitaci[oó]n|hab|en|es en)\s+(\d{4})$/i);
    if (lugarMatch) {
      const newRoom = lugarMatch[2];
      ticket.room = newRoom;
      ticket.lugar = `Habitación ${newRoom}`;
      await replySafe(msg, `✅ Lugar cambiado a *Habitación ${newRoom}*.\n\nEscribe *"listo"* para volver al resumen.`);
      return;
    }
    
    // Detectar número de habitación suelto (ej: "1301")
    if (/^\d{4}$/.test(input)) {
      ticket.room = input;
      ticket.lugar = `Habitación ${input}`;
      await replySafe(msg, `✅ Lugar cambiado a *Habitación ${input}*.\n\nEscribe *"listo"* para volver al resumen.`);
      return;
    }
    
    // ✅ Deshacer / borrar último detalle agregado
    if (/^(deshacer|borra|borrar|quita|quitar|elimina|eliminar)\s*(eso|ese|esto|ultimo|[uú]ltimo|detalle|lo\s+(que|ultimo)|anterior)?$/i.test(input)) {
      // Buscar el último punto y quitar desde ahí
      const lastDotIndex = ticket.descripcion.lastIndexOf('. ');
      if (lastDotIndex > 0) {
        const previousDesc = ticket.descripcion.substring(0, lastDotIndex);
        ticket.descripcion = previousDesc;
        ticket.descripcion_raw = previousDesc;
        await replySafe(msg, `✅ Último detalle eliminado.\n\nDescripción actual: _${previousDesc}_`);
      } else {
        await replySafe(msg, `⚠️ No hay detalles que borrar. La descripción base es: _${ticket.descripcion}_`);
      }
      return;
    }
    
    // Cambiar descripción completamente
    const descMatch = input.match(/^descripci[oó]n\s+(.+)$/i);
    if (descMatch) {
      const newDesc = cleanDescription(descMatch[1].trim());
      ticket.descripcion = newDesc;
      ticket.descripcion_raw = descMatch[1].trim();
      await replySafe(msg, `✅ Descripción cambiada a: _${newDesc}_\n\nEscribe *"listo"* para volver al resumen.`);
      return;
    }
    
    // Agregar detalle a la descripción existente (con comando explícito)
    const agregarMatch = input.match(/^(agregar|a[ñn]adir|detalle|nota|m[aá]s)\s+(.+)$/i);
    if (agregarMatch) {
      const detalle = agregarMatch[2].trim();
      const newDesc = `${ticket.descripcion}. ${detalle.charAt(0).toUpperCase() + detalle.slice(1)}`;
      ticket.descripcion = newDesc;
      ticket.descripcion_raw = newDesc;
      await replySafe(msg, `✅ Detalle agregado: _${newDesc}_\n\nEscribe *"listo"* para volver al resumen.`);
      return;
    }
    
    // ✅ NUEVO: Si no es ningún comando reconocido, asumir que es un detalle a agregar
    // (siempre que tenga al menos 3 caracteres)
    if (input.length >= 3) {
      const detalle = input.charAt(0).toUpperCase() + input.slice(1);
      const newDesc = `${ticket.descripcion}. ${detalle}`;
      ticket.descripcion = newDesc;
      ticket.descripcion_raw = newDesc;
      await replySafe(msg, `✅ Detalle agregado: _${newDesc}_\n\nEscribe *"listo"* para volver, o *"deshacer"* para borrar.`);
      return;
    }
    
    // No entendió (texto muy corto)
    await replySafe(
      msg,
      `No entendí. Opciones:\n` +
      `• *"para [área]"* cambiar área\n` +
      `• *"[número]"* cambiar habitación\n` +
      `• Escribe texto para agregar detalle\n` +
      `• *"deshacer"* | *"eliminar"* | *"listo"*`
    );
    return;
  }

  if (!s.draft.descripcion) s.draft.descripcion = cleanDescription(text);
  if (!s.draft.descripcion_original) s.draft.descripcion_original = cleanDescription(text);

  /* 0) Visión si viene media (solo imágenes) */
  let visionHints = null;
  if (msg.hasMedia) {
    try {
      const media = await msg.downloadMedia();
      const mime = media?.mimetype || '';
      if (mime.startsWith('image/')) {
        const batch = ensureMediaBatch(s);
        batch.count += 1;
        batch.lastTs = Date.now();

        if (DEBUG) console.log('[VISION] media.info', { mimetype: mime, approxBytes: (media.data?.length || 0) });

        s._pendingMedia = Array.isArray(s._pendingMedia) ? s._pendingMedia : [];
        if (s._pendingMedia.length < 6) {
          s._pendingMedia.push({
            mimetype: media.mimetype,
            data: media.data,
            filename: media.filename || null,
            caption: null
          });
        }

        const v = await analyzeNIImage(
          { mimetype: media.mimetype, data: media.data, size: media.filesize || null },
          { text: s.draft?.descripcion || text }
        );
        if (DEBUG) console.log('[VISION] out', v);

        if (v?.interpretacion) {
          const add = `Visión: ${v.interpretacion}`;
          if (s.draft.interpretacion) {
            s.draft.interpretacion += (s.draft.interpretacion.endsWith('.') ? ' ' : '. ') + add;
          } else {
            s.draft.interpretacion = add;
          }
          if (DEBUG) console.log('[VISION] enrich.interpretation.added');
        }

        const noteBits = [];
        if (Array.isArray(v?.tags) && v.tags.length) {
          noteBits.push(`tags:${v.tags.join(',')}`);
          s._visionTags = v.tags;  // ✅ Guardar tags para usar en autoAssignArea
        }
        if (Array.isArray(v?.safety) && v.safety.length) noteBits.push(`safety:${v.safety.join(',')}`);
        if (noteBits.length) {
          s.draft.notes = Array.isArray(s.draft.notes) ? s.draft.notes : [];
          s.draft.notes.push(`[VISION] ${noteBits.join(' | ')}`);
          if (DEBUG) console.log('[VISION] notes.added', `[VISION] ${noteBits.join(' | ')}`);
        }

        if (Array.isArray(v?.area_hints) && v.area_hints.length) {
          s._visionAreaHints = v.area_hints.slice(0, 3);
          visionHints = s._visionAreaHints;
          if (DEBUG) console.log('[VISION] area.hints.stored', s._visionAreaHints);
        }

        if (!text && !batch.sentAck) {
          await replySafe(msg, '📸 Recibí la foto. Ya le eché un ojo — si me cuentas en una frase qué pasó, afino el reporte. 😉');
          batch.sentAck = true;
        }
      } else {
        if (DEBUG) console.log('[VISION] skip non-image', { mimetype: mime });
      }
    } catch (e) {
      if (DEBUG) console.warn('[VISION] err', e?.message || e);
    }
  } else {
    if (Array.isArray(s._visionAreaHints) && s._visionAreaHints.length) {
      visionHints = s._visionAreaHints;
    }
  }

  if (!text && msg.hasMedia) {
    if (DEBUG) console.log('[NI] turn.onlyMedia → stored media & vision, no dialog step');
    return;
  }

  /* ✅ Fast-path: si estábamos preguntando lugar... */
  if (s.mode === 'ask_place' && text) {
    // Intentar normalizar con el catálogo
    const placeResult = await normalizeAndSetLugar(s, msg, text, { force: false, rawText: text });
    
    // ✅ NUEVO: Si hay sugerencias fuzzy, mostrarlas al usuario
    if (placeResult && placeResult.fuzzySuggestions && placeResult.fuzzySuggestions.length > 0) {
      const suggestions = placeResult.fuzzySuggestions.slice(0, 3);
      const suggestionList = suggestions.map((s, i) => 
        `${i + 1}. *${s.label}* _(${s.similarity}% similar)_`
      ).join('\n');
      
      await replySafe(msg,
        `🤔 No encontré exactamente "*${placeResult.originalInput}*".\n\n` +
        `¿Quisiste decir?\n${suggestionList}\n\n` +
        `Responde el *número* (1, 2, 3) o escribe otro lugar.`
      );
      
      s._placeCandidates = suggestions.map(s => ({ label: s.label, via: 'fuzzy', score: s.similarity }));
      setMode(s, 'choose_place_from_candidates');
      return;
    }
    
    if (placeResult && placeResult.ok && s.draft.lugar) {
      // Lugar válido encontrado → auto-asignar área y mostrar preview
      await refreshIncidentDescription(s, text);
      
      // Auto-asignar área si no la tiene
      if (!s.draft.area_destino) {
        try {
          const a = await detectArea(s.draft.descripcion || text);
          if (a?.area) {
            setDraftField(s, 'area_destino', a.area);
            addArea(s, a.area);
          }
        } catch {}
      }
      
      // Mostrar preview
      const preview = formatPreviewMessage(s.draft);
      await replySafe(msg, preview);
      setMode(s, 'confirm');
      return;
    } else {
      // No se encontró en catálogo → intentar buscar sugerencias
      try {
        const fuzzyResult = await detectPlace(text, { 
          preferRoomsFirst: true,
          debugReturn: true 
        });

        // Usar sugerencias fuzzy si las hay
        if (fuzzyResult?.suggestions && fuzzyResult.suggestions.length > 0) {
          const suggestions = fuzzyResult.suggestions.slice(0, 3);
          const suggestionList = suggestions.map((s, i) => 
            `${i + 1}. *${s.label}* _(${s.similarity}% similar)_`
          ).join('\n');
          
          await replySafe(msg,
            `🤔 No encontré exactamente "*${text}*".\n\n` +
            `¿Quisiste decir?\n${suggestionList}\n\n` +
            `Responde el *número* (1, 2, 3) o escribe otro lugar.`
          );
          
          s._placeCandidates = suggestions.map(s => ({ label: s.label, via: 'fuzzy', score: s.similarity }));
          setMode(s, 'choose_place_from_candidates');
          return;
        }
        
        // O candidatos normales
        if (fuzzyResult?.candidates && fuzzyResult.candidates.length > 0) {
          const top3 = fuzzyResult.candidates.slice(0, 3);
          const suggestions = top3.map((c, i) => `${i + 1}. *${c.label}*`).join('\n');
          
          await replySafe(
            msg,
            `🤔 No encontré exactamente "${text}".\n\n` +
            `¿Quisiste decir?\n${suggestions}\n\n` +
            `Responde el *número* (1, 2, 3) o dame otro lugar.`
          );
          
          s._placeCandidates = top3;
          setMode(s, 'choose_place_from_candidates');
          return;
        }
      } catch (e) {
        if (DEBUG) console.warn('[PLACE] fuzzy search err', e?.message || e);
      }

      // Sin candidatos → mostrar preview con lugar faltante
      const preview = formatPreviewMessage(s.draft);
      await replySafe(msg, `❌ No encontré "${text}" en el catálogo.\n\n` + preview);
      setMode(s, 'confirm');
      return;
    }
  } else if (s.mode === 'choose_place_from_candidates' && text) {
    const t = text.trim();
    const candidates = s._placeCandidates || [];
    
    // Verificar si es un número (1, 2, 3)
    const num = parseInt(t, 10);
    if (!isNaN(num) && num >= 1 && num <= candidates.length) {
      const chosen = candidates[num - 1];
      setDraftField(s, 'lugar', chosen.label);
      await refreshIncidentDescription(s, text);
      s._placeCandidates = null;
      
      // Auto-asignar área si no la tiene
      if (!s.draft.area_destino) {
        try {
          const a = await detectArea(s.draft.descripcion || text);
          if (a?.area) {
            setDraftField(s, 'area_destino', a.area);
            addArea(s, a.area);
          }
        } catch {}
      }
      
      // Mostrar preview
      const preview = formatPreviewMessage(s.draft);
      await replySafe(msg, preview);
      setMode(s, 'confirm');
      return;
    } else {
      // No es número → intentar buscar de nuevo
      const ok = await normalizeAndSetLugar(s, msg, t, { force: false, rawText: t });
      if (ok && s.draft.lugar) {
        await refreshIncidentDescription(s, t);
        s._placeCandidates = null;
        
        // Auto-asignar área y mostrar preview
        if (!s.draft.area_destino) {
          try {
            const a = await detectArea(s.draft.descripcion || t);
            if (a?.area) {
              setDraftField(s, 'area_destino', a.area);
              addArea(s, a.area);
            }
          } catch {}
        }
        
        const preview = formatPreviewMessage(s.draft);
        await replySafe(msg, preview);
        setMode(s, 'confirm');
        return;
      } else {
        await replySafe(
          msg,
          '❌ No reconocí ese lugar. Responde el *número* de la opción (1, 2, 3) o escribe otro lugar válido.'
        );
        return;
      }
    }
  } else if (s.mode === 'context_switch' && text) {
    // ✅ NUEVO: Manejo de cambio de contexto
    const t = norm(text);
    const candidateText = s._candidateIncidentText || '';
    
    // Opción: nuevo - iniciar ticket nuevo
    if (/^nuev[oa]?\b/i.test(t)) {
      // Limpiar draft y empezar de nuevo con el texto candidato (sin ID hasta persistir)
      s.draft = {};
      s.draft.descripcion_original = candidateText;
      s.draft.descripcion = candidateText;
      s._candidateIncidentText = null;
      s._contextSwitchPending = false;
      s._lugarNotInCatalog = false;
      
      // Detectar lugar en el nuevo texto
      try {
        const placeResult = await detectPlace(candidateText, { preferRoomsFirst: true });
        if (placeResult?.found) {
          setDraftField(s, 'lugar', placeResult.label);
          if (placeResult.via === 'room_pattern') {
            s._lugarNotInCatalog = true;
          }
        }
      } catch {}
      
      // Detectar área del nuevo texto
      try {
        const a = await detectArea(candidateText);
        if (a?.area) {
          setDraftField(s, 'area_destino', a.area);
          addArea(s, a.area);
        }
      } catch {}
      
      await refreshIncidentDescription(s, candidateText);
      
      let preview = formatPreviewMessage(s.draft);
      if (s._lugarNotInCatalog && s.draft.lugar) {
        preview = `⚠️ *${s.draft.lugar}* no está en el catálogo.\n\n` + preview;
      }
      await replySafe(msg, '✅ Ticket nuevo iniciado:\n\n' + preview);
      setMode(s, 'confirm');
      return;
    }
    
    // ✅ NUEVO: Opción: anterior - continuar con el ticket anterior
    if (/^anterior\b/i.test(t) || /^continuar\b/i.test(t)) {
      s._candidateIncidentText = null;
      s._contextSwitchPending = false;
      
      const preview = formatPreviewMessage(s.draft);
      await replySafe(msg, '✅ Continuamos con el ticket anterior:\n\n' + preview);
      setMode(s, 'confirm');
      return;
    }
    
    // Opción: agregar - agregar como detalle al ticket actual
    if (/^agregar\b/i.test(t)) {
      const added = addDetail(s, candidateText);
      if (added) {
        await refreshIncidentDescription(s, candidateText);
      }
      s._candidateIncidentText = null;
      s._contextSwitchPending = false;
      
      const preview = formatPreviewMessage(s.draft);
      await replySafe(msg, '✅ Detalle agregado:\n\n' + preview);
      setMode(s, 'confirm');
      return;
    }
    
    // Opción: cancelar - descartar todo
    if (/^cancelar?\b/i.test(t) || /^no\b/i.test(t)) {
      closeSession(s);
      resetSession(chatId);
      s._candidateIncidentText = null;
      s._contextSwitchPending = false;
      await replySafe(msg, '❌ Ticket cancelado. Si necesitas reportar algo, solo escríbeme.');
      return;
    }
    
    // Si escribió algo más, asumir que es el lugar del nuevo ticket
    const placeResult = await normalizeAndSetLugar(s, msg, t, { force: false, rawText: t });
    if (placeResult && s.draft.lugar) {
      // Usar el texto candidato como descripción
      s.draft.descripcion_original = candidateText;
      s.draft.descripcion = candidateText;
      await refreshIncidentDescription(s, t);
      s._candidateIncidentText = null;
      s._contextSwitchPending = false;
      
      if (placeResult && typeof placeResult === 'object' && placeResult.inCatalog === false) {
        s._lugarNotInCatalog = true;
      }
      
      // Detectar área
      if (!s.draft.area_destino) {
        try {
          const a = await detectArea(candidateText);
          if (a?.area) {
            setDraftField(s, 'area_destino', a.area);
            addArea(s, a.area);
          }
        } catch {}
      }
      
      let preview = formatPreviewMessage(s.draft);
      if (s._lugarNotInCatalog && s.draft.lugar) {
        preview = `⚠️ *${s.draft.lugar}* no está en el catálogo.\n\n` + preview;
      }
      await replySafe(msg, preview);
      setMode(s, 'confirm');
      return;
    }
    
    // No entendí
    await replySafe(msg, 
      '🤔 No entendí. Opciones:\n' +
      '• *nuevo* — iniciar ticket nuevo\n' +
      '• *agregar* — agregar como detalle\n' +
      '• *cancelar* — descartar todo\n' +
      '• O escribe el *lugar* para continuar'
    );
    return;
  } else if (s.mode === 'multiple_tickets' && text) {
    // ✅ NUEVO: Manejo de tickets múltiples
    const t = norm(text);
    const tickets = s._multipleTickets || [];
    
    if (DEBUG) console.log('[MULTIPLE_TICKETS] handling response', { response: text, ticketCount: tickets.length });
    
    // Opción: enviar ambos
    if (/^enviar\s*(ambos|los\s*2|los\s*dos)?\b/i.test(t) || t === 'enviar') {
      if (tickets.length < 2) {
        await replySafe(msg, '⚠️ No hay tickets pendientes para enviar.');
        setMode(s, 'neutral');
        return;
      }
      
      const results = [];
      for (const ticket of tickets) {
        try {
          // Preparar el draft
          s.draft = { ...ticket };
          delete s.draft._ticketNum;
          
          // Generar folio y enviar
          await finalizeAndDispatch({ client, msg, session: s });
          results.push({ num: ticket._ticketNum, folio: s.draft.folio, ok: true });
        } catch (e) {
          if (DEBUG) console.warn('[MULTIPLE_TICKETS] dispatch error', e?.message);
          results.push({ num: ticket._ticketNum, ok: false, error: e?.message });
        }
      }
      
      // Limpiar
      s._multipleTickets = null;
      
      // Ya se envió mensaje de confirmación en finalizeAndDispatch
      // Solo necesitamos asegurarnos de que la sesión esté cerrada
      if (DEBUG) console.log('[MULTIPLE_TICKETS] both tickets dispatched', { results });
      return;
    }
    
    // Opción: editar ticket 1
    if (/^editar\s*1\b/i.test(t)) {
      if (!tickets[0]) {
        await replySafe(msg, '⚠️ No hay ticket 1 para editar.');
        return;
      }
      
      s.draft = { ...tickets[0] };
      delete s.draft._ticketNum;
      s._editingTicketNum = 1;
      
      await replySafe(msg,
        '✏️ *Editando Ticket 1*\n\n' +
        '¿Qué quieres cambiar?\n' +
        '• Escribe una nueva *descripción*\n' +
        '• Escribe un nuevo *lugar* (ej: "lugar 1205")\n' +
        '• *listo* — terminar edición\n' +
        '• *cancelar* — descartar cambios'
      );
      setMode(s, 'edit_multiple_ticket');
      return;
    }
    
    // Opción: editar ticket 2
    if (/^editar\s*2\b/i.test(t)) {
      if (!tickets[1]) {
        await replySafe(msg, '⚠️ No hay ticket 2 para editar.');
        return;
      }
      
      s.draft = { ...tickets[1] };
      delete s.draft._ticketNum;
      s._editingTicketNum = 2;
      
      await replySafe(msg,
        '✏️ *Editando Ticket 2*\n\n' +
        '¿Qué quieres cambiar?\n' +
        '• Escribe una nueva *descripción*\n' +
        '• Escribe un nuevo *lugar* (ej: "lugar 1205")\n' +
        '• *listo* — terminar edición\n' +
        '• *cancelar* — descartar cambios'
      );
      setMode(s, 'edit_multiple_ticket');
      return;
    }
    
    // Opción: solo ticket 1
    if (/^solo\s*1\b/i.test(t)) {
      if (!tickets[0]) {
        await replySafe(msg, '⚠️ No hay ticket 1.');
        return;
      }
      
      s.draft = { ...tickets[0] };
      delete s.draft._ticketNum;
      s._multipleTickets = null;
      
      const preview = formatPreviewMessage(s.draft);
      await replySafe(msg, '📋 *Solo Ticket 1:*\n\n' + preview + '\n\n¿Lo envío? Responde *sí* o *no*.');
      setMode(s, 'confirm');
      return;
    }
    
    // Opción: solo ticket 2
    if (/^solo\s*2\b/i.test(t)) {
      if (!tickets[1]) {
        await replySafe(msg, '⚠️ No hay ticket 2.');
        return;
      }
      
      s.draft = { ...tickets[1] };
      delete s.draft._ticketNum;
      s._multipleTickets = null;
      
      const preview = formatPreviewMessage(s.draft);
      await replySafe(msg, '📋 *Solo Ticket 2:*\n\n' + preview + '\n\n¿Lo envío? Responde *sí* o *no*.');
      setMode(s, 'confirm');
      return;
    }
    
    // Opción: cancelar
    if (/^cancelar?\b/i.test(t) || isNo(text)) {
      s._multipleTickets = null;
      resetSession(s);
      await replySafe(msg, '🗑️ Ambos tickets descartados.');
      return;
    }
    
    // No entendí
    await replySafe(msg,
      '🤔 No entendí. Opciones:\n' +
      '• *enviar ambos* — enviar los 2 tickets\n' +
      '• *editar 1* o *editar 2* — editar un ticket\n' +
      '• *solo 1* o *solo 2* — enviar solo uno\n' +
      '• *cancelar* — descartar ambos'
    );
    return;
  } else if (s.mode === 'edit_multiple_ticket' && text) {
    // ✅ NUEVO: Edición de ticket en modo múltiple
    const t = norm(text);
    const ticketNum = s._editingTicketNum || 1;
    
    // Listo - terminar edición
    if (/^listo\b/i.test(t) || /^terminar?\b/i.test(t)) {
      // Actualizar el ticket en la lista
      if (s._multipleTickets) {
        s._multipleTickets[ticketNum - 1] = { ...s.draft, _ticketNum: ticketNum };
      }
      
      // Mostrar vista de ambos tickets de nuevo
      const tickets = s._multipleTickets || [];
      const areaNames = {
        'it': 'IT/Sistemas',
        'man': 'Mantenimiento', 
        'ama': 'Ama de llaves',
        'seg': 'Seguridad',
        'rs': 'Room Service'
      };
      
      let preview = '📋 *Tickets actualizados:*\n\n';
      for (const ticket of tickets) {
        preview += `*Ticket ${ticket._ticketNum}* → ${areaNames[ticket.area_destino] || ticket.area_destino?.toUpperCase()}\n`;
        preview += `• Descripción: ${ticket.descripcion?.substring(0, 50)}${ticket.descripcion?.length > 50 ? '...' : ''}\n`;
        preview += `• Lugar: ${ticket.lugar || '(sin lugar)'}\n\n`;
      }
      
      preview += '━━━━━━━━━━━━━━━━━━━━━━\n';
      preview += '• *enviar ambos* — enviar los 2 tickets\n';
      preview += '• *editar 1* o *editar 2* — seguir editando\n';
      preview += '• *cancelar* — descartar ambos';
      
      await replySafe(msg, preview);
      s._editingTicketNum = null;
      setMode(s, 'multiple_tickets');
      return;
    }
    
    // Cancelar - descartar cambios
    if (/^cancelar?\b/i.test(t)) {
      // Restaurar ticket original
      if (s._multipleTickets && s._multipleTickets[ticketNum - 1]) {
        s.draft = { ...s._multipleTickets[ticketNum - 1] };
      }
      
      await replySafe(msg, '↩️ Cambios descartados.');
      s._editingTicketNum = null;
      setMode(s, 'multiple_tickets');
      return;
    }
    
    // Cambio de lugar
    if (/^lugar\s+/i.test(t)) {
      const newLugar = text.replace(/^lugar\s+/i, '').trim();
      const result = await normalizeAndSetLugar(s, msg, newLugar, { rawText: text });
      if (result?.ok) {
        await replySafe(msg, `✅ Lugar actualizado a *${s.draft.lugar}*\n\nEscribe *listo* para terminar o sigue editando.`);
      } else {
        await replySafe(msg, `⚠️ No encontré "${newLugar}" en el catálogo. Intenta con otro lugar o escribe *listo*.`);
      }
      return;
    }
    
    // Cualquier otro texto es nueva descripción
    if (text.length >= 5) {
      s.draft.descripcion = text;
      s.draft.descripcion_original = text;
      
      // Re-detectar área
      try {
        const a = await detectArea(text);
        if (a?.area) {
          setDraftField(s, 'area_destino', a.area);
          s.draft.areas = [a.area];
        }
      } catch {}
      
      await replySafe(msg, `✅ Descripción actualizada.\n\nEscribe *listo* para terminar o sigue editando.`);
      return;
    }
    
    await replySafe(msg, '🤔 Escribe una nueva descripción, "lugar [número]", o *listo* para terminar.');
    return;
  } else if (s.mode === 'description_or_new' && text) {
    // ✅ NUEVO: Manejo de cuando el usuario agrega descripción que menciona otro lugar/área
    const t = norm(text);
    const pendingText = s._pendingDescriptionText || '';
    
    // Opción: agregar - agregar como detalle al ticket actual
    if (/^agregar\b/i.test(t)) {
      const currentDesc = s.draft.descripcion || '';
      const currentLugar = s.draft.lugar || '';
      
      // ✅ FIX: Si la descripción actual es muy corta, es solo el lugar, o no tiene contenido real
      // → REEMPLAZAR en vez de agregar
      const descIsJustPlace = norm(currentDesc).includes(norm(currentLugar).replace('habitacion ', '')) ||
                              currentDesc.length < 25 ||
                              /^(habitacion|hab|villa|en)\s*\d+$/i.test(norm(currentDesc));
      
      if (descIsJustPlace || !currentDesc) {
        // Reemplazar descripción
        s.draft.descripcion = pendingText;
        s.draft.descripcion_original = pendingText;
        if (DEBUG) console.log('[CONFIRM] description REPLACED (was just place)', { old: currentDesc, new: pendingText });
      } else {
        // Agregar como detalle
        addDetail(s, pendingText);
        if (DEBUG) console.log('[CONFIRM] description added as detail');
      }
      
      s._pendingDescriptionText = null;
      
      // Re-detectar área basada en la nueva descripción
      try {
        const a = await detectArea(s.draft.descripcion);
        if (a?.area && a.area !== s.draft.area_destino) {
          setDraftField(s, 'area_destino', a.area);
          if (!s.draft.areas?.includes(a.area)) addArea(s, a.area);
          if (DEBUG) console.log('[CONFIRM] area updated based on new description:', a.area);
        }
      } catch {}
      
      await refreshIncidentDescription(s, pendingText);
      
      const preview = formatPreviewMessage(s.draft);
      await replySafe(msg, '✅ Descripción actualizada:\n\n' + preview);
      setMode(s, 'confirm');
      return;
    }
    
    // Opción: nuevo - crear ticket nuevo
    if (/^nuev[oa]?\b/i.test(t)) {
      // Limpiar draft y empezar de nuevo (sin ID hasta persistir)
      s.draft = {};
      s.draft.descripcion_original = pendingText;
      s.draft.descripcion = pendingText;
      s._pendingDescriptionText = null;
      s._lugarNotInCatalog = false;
      
      // Detectar lugar en el nuevo texto
      try {
        const placeResult = await detectPlace(pendingText, { preferRoomsFirst: true });
        if (placeResult?.found) {
          setDraftField(s, 'lugar', placeResult.label);
        }
      } catch {}
      
      // Detectar área
      try {
        const a = await detectArea(pendingText);
        if (a?.area) {
          setDraftField(s, 'area_destino', a.area);
          addArea(s, a.area);
        }
      } catch {}
      
      await refreshIncidentDescription(s, pendingText);
      
      const preview = formatPreviewMessage(s.draft);
      await replySafe(msg, '✅ Ticket nuevo iniciado:\n\n' + preview);
      setMode(s, 'confirm');
      if (DEBUG) console.log('[CONFIRM] new ticket started from description');
      return;
    }
    
    // Opción: cancelar - ignorar
    if (/^cancelar?\b/i.test(t) || /^ignorar?\b/i.test(t)) {
      s._pendingDescriptionText = null;
      const preview = formatPreviewMessage(s.draft);
      await replySafe(msg, '👌 Mensaje ignorado. Tu ticket sigue así:\n\n' + preview);
      setMode(s, 'confirm');
      return;
    }
    
    // No entendí
    await replySafe(msg,
      '🤔 No entendí. Opciones:\n' +
      '• *agregar* — agregar como detalle a este ticket\n' +
      '• *nuevo* — crear un ticket nuevo\n' +
      '• *cancelar* — ignorar el mensaje'
    );
    return;
  } else if (s.mode === 'edit' && text) {
    // ═══════════════════════════════════════════════════════════════
    // MODO EDIT UNIFICADO - editar descripción, lugar o área
    // ═══════════════════════════════════════════════════════════════
    const t = norm(text);
    
    if (DEBUG) console.log('[EDIT] handling input', { text: text.substring(0, 40), editTarget: s._editTarget });
    
    // Cancelar edición
    if (/^cancelar?\b/i.test(t) || /^mantener\b/i.test(t) || /^salir\b/i.test(t)) {
      s._editTarget = null;
      const preview = formatPreviewMessage(s.draft);
      await replySafe(msg, '👌 Sin cambios:\n\n' + preview);
      setMode(s, 'confirm');
      return;
    }
    
    // Si no hay target específico, detectar qué quiere editar
    if (!s._editTarget) {
      // Detectar intención de edición
      if (/\b(descripcion|problema|detalle|texto)\b/i.test(t)) {
        s._editTarget = 'descripcion';
        await replySafe(msg, '📝 Escribe la nueva descripción del problema:');
        return;
      }
      
      if (/\b(lugar|ubicacion|habitacion|hab|cuarto|donde)\b/i.test(t)) {
        s._editTarget = 'lugar';
        await replySafe(msg, '📍 Escribe el nuevo lugar (ej: "1205", "front desk", "alberca"):');
        return;
      }
      
      if (/\b(area|departamento|equipo|para\s*(quien|que\s*area))\b/i.test(t)) {
        s._editTarget = 'area';
        await replySafe(msg, 
          '🏢 ¿A qué área va?\n\n' +
          '• *IT* - Sistemas/tecnología\n' +
          '• *MAN* - Mantenimiento\n' +
          '• *AMA* - Ama de llaves\n' +
          '• *SEG* - Seguridad\n' +
          '• *RS* - Room Service'
        );
        return;
      }
      
      // Si escribió algo que parece una descripción directa (largo)
      if (text.length >= 10 && !s._editTarget) {
        s._editTarget = 'descripcion';
        // Continuar al procesamiento de descripción abajo
      } else {
        // Mostrar menú de edición
        await replySafe(msg,
          '✏️ *¿Qué quieres editar?*\n\n' +
          '• *descripción* — cambiar el problema\n' +
          '• *lugar* — cambiar la ubicación\n' +
          '• *área* — cambiar el departamento destino\n' +
          '• *cancelar* — volver sin cambios'
        );
        return;
      }
    }
    
    // ─────────────────────────────────────────────────────────────────
    // Procesar edición según el target
    // ─────────────────────────────────────────────────────────────────
    
    // EDITAR DESCRIPCIÓN
    if (s._editTarget === 'descripcion') {
      if (text.length < 5) {
        await replySafe(msg, '❌ Muy corto. Escribe una descripción más detallada o *cancelar*.');
        return;
      }
      
      s.draft.descripcion = text;
      s.draft.descripcion_original = text;
      s.draft._details = [];
      
      // Re-detectar área basada en nueva descripción
      try {
        const a = await detectArea(text);
        if (a?.area && a.area !== s.draft.area_destino) {
          setDraftField(s, 'area_destino', a.area);
          s.draft.areas = [a.area];
          if (DEBUG) console.log('[EDIT] area auto-updated', { newArea: a.area });
        }
      } catch {}
      
      s._editTarget = null;
      const preview = formatPreviewMessage(s.draft);
      await replySafe(msg, '✅ Descripción actualizada:\n\n' + preview);
      setMode(s, 'confirm');
      if (DEBUG) console.log('[EDIT] description updated', { newDesc: text.substring(0, 40) });
      return;
    }
    
    // EDITAR LUGAR
    if (s._editTarget === 'lugar') {
      const result = await normalizeAndSetLugar(s, msg, text, { force: true, rawText: text });
      
      if (result?.ok) {
        s._editTarget = null;
        const preview = formatPreviewMessage(s.draft);
        await replySafe(msg, `✅ Lugar actualizado a *${s.draft.lugar}*:\n\n` + preview);
        setMode(s, 'confirm');
        if (DEBUG) console.log('[EDIT] lugar updated', { newLugar: s.draft.lugar });
      } else {
        await replySafe(msg, 
          `⚠️ No encontré "${text}" en el catálogo.\n\n` +
          'Intenta con:\n' +
          '• Número de habitación (ej: 1205)\n' +
          '• Nombre de lugar (ej: front desk, alberca)\n' +
          '• O escribe *cancelar*'
        );
      }
      return;
    }
    
    // EDITAR ÁREA
    if (s._editTarget === 'area') {
      const areaMap = {
        'it': 'it', 'sistemas': 'it', 'tecnologia': 'it', 'tech': 'it',
        'man': 'man', 'mantenimiento': 'man', 'mantto': 'man', 'maintenance': 'man',
        'ama': 'ama', 'housekeeping': 'ama', 'hskp': 'ama', 'ama de llaves': 'ama', 'limpieza': 'ama',
        'seg': 'seg', 'seguridad': 'seg', 'security': 'seg', 'vigilancia': 'seg',
        'rs': 'rs', 'room service': 'rs', 'roomservice': 'rs', 'alimentos': 'rs',
      };
      
      const newArea = areaMap[t] || areaMap[t.replace(/\s+/g, ' ')];
      
      if (newArea) {
        setDraftField(s, 'area_destino', newArea);
        s.draft.areas = [newArea];
        s._editTarget = null;
        
        const areaNames = { 'it': 'IT/Sistemas', 'man': 'Mantenimiento', 'ama': 'Ama de llaves', 'seg': 'Seguridad', 'rs': 'Room Service' };
        const preview = formatPreviewMessage(s.draft);
        await replySafe(msg, `✅ Área cambiada a *${areaNames[newArea]}*:\n\n` + preview);
        setMode(s, 'confirm');
        if (DEBUG) console.log('[EDIT] area updated', { newArea });
      } else {
        await replySafe(msg,
          '❌ No reconozco esa área. Opciones:\n\n' +
          '• *IT* - Sistemas\n' +
          '• *MAN* - Mantenimiento\n' +
          '• *AMA* - Ama de llaves\n' +
          '• *SEG* - Seguridad\n' +
          '• *RS* - Room Service\n\n' +
          'O escribe *cancelar*'
        );
      }
      return;
    }
    
    // Fallback - no debería llegar aquí
    s._editTarget = null;
    await replySafe(msg, '🤔 No entendí. Escribe *editar* para ver opciones o *cancelar*.');
    setMode(s, 'confirm');
    return;
  } else if (s.mode === 'edit_description' && text) {
    // ═══════════════════════════════════════════════════════════════
    // LEGACY: Redirigir al modo edit unificado
    // ═══════════════════════════════════════════════════════════════
    s._editTarget = 'descripcion';
    setMode(s, 'edit');
    // Re-procesar el mensaje en el nuevo modo
    const t = norm(text);
    
    if (/^cancelar?\b/i.test(t) || /^mantener\b/i.test(t)) {
      s._editTarget = null;
      const preview = formatPreviewMessage(s.draft);
      await replySafe(msg, '👌 Se mantiene la descripción actual:\n\n' + preview);
      setMode(s, 'confirm');
      return;
    }
    
    if (text.length >= 5) {
      s.draft.descripcion = text;
      s.draft.descripcion_original = text;
      s.draft._details = [];
      
      try {
        const a = await detectArea(text);
        if (a?.area) {
          setDraftField(s, 'area_destino', a.area);
          s.draft.areas = [a.area];
        }
      } catch {}
      
      s._editTarget = null;
      const preview = formatPreviewMessage(s.draft);
      await replySafe(msg, `✅ Descripción actualizada:\n\n` + preview);
      setMode(s, 'confirm');
      if (DEBUG) console.log('[EDIT] description replaced', { newDesc: text });
      return;
    }
    
    await replySafe(msg, '❌ La descripción es muy corta. Escribe una descripción más detallada o *cancelar*.');
    return;
  } else if (s.mode === 'choose_incident_version' && text) {
    const t = text.toLowerCase();
    const candidateText = s._candidateIncidentText || '';

    if (t.includes('primero')) {
      s._candidateIncidentText = null;
      await replySafe(msg, '👌 Perfecto, conservo el primer reporte y descarto el segundo.');
      const preview = formatPreview(s.draft);
      await replySafe(msg, preview + '\n\n¿Lo envío? Responde "sí" o "no".');
      setMode(s, 'confirm');
      pushTurn(s, 'bot', '[preview]');
      if (DEBUG) console.log('[PREVIEW] sent (keep first)');
      return;
    }

    if (t.includes('segundo')) {
      if (candidateText) {
        s.draft = s.draft || {};
        s.draft._details = [];
        s.draft.interpretacion = null;
        s.draft.areas = [];
        s.draft.area_destino = null;
        s.draft.descripcion_original = candidateText;
        s.draft.descripcion = candidateText;

        const strongVal = getStrongPlaceValue(candidateText) || candidateText;
        const placeResult = await normalizeAndSetLugar(s, msg, strongVal, { force: true, rawText: candidateText });
        // ✅ FIX: Actualizar flag de catálogo
        if (placeResult && typeof placeResult === 'object' && placeResult.inCatalog === false) {
          s._lugarNotInCatalog = true;
        }

        let area = null;
        try {
          const a = await detectArea(candidateText);
          area = a?.area || null;
        } catch {}

        if (area) {
          setDraftField(s, 'area_destino', area);
          addArea(s, area);
        }

        await refreshIncidentDescription(s, candidateText);
      }

      s._candidateIncidentText = null;
      await replySafe(msg, '✅ Listo, usaré solo el segundo reporte como base del ticket.');
      const preview = formatPreview(s.draft);
      await replySafe(msg, preview + '\n\n¿Lo envío? Responde "sí" o "no".');
      setMode(s, 'confirm');
      pushTurn(s, 'bot', '[preview]');
      if (DEBUG) console.log('[PREVIEW] sent (use second)');
      return;
    }

    await replySafe(msg, 'No te entendí. Escribe *primero* para conservar el reporte anterior o *segundo* para usar el nuevo.');
    return;
  }

  /* 1) Confirmación - acepta sí/no O correcciones de lugar/área/descripción */
  const rawUser = (text || '').trim();
  
  // ✅ NUEVO: Guardar el texto del usuario para detectar duplicados
  if (rawUser && rawUser.length > 5) {
    s._lastUserText = rawUser;
  }
  
  if (s.mode === 'confirm') {
    // ✅ NUEVO: Si hay un lugar no catalogado pendiente y el usuario dice sí
    if (s._pendingUncatalogedPlace && isYes(rawUser)) {
      const uncatPlace = s._pendingUncatalogedPlace;
      setDraftField(s, 'lugar', uncatPlace);
      s._lugarNotInCatalog = true;
      s._pendingUncatalogedPlace = null;
      await refreshIncidentDescription(s, uncatPlace);
      
      let preview = formatPreviewMessage(s.draft);
      preview = `⚠️ *${uncatPlace}* no está en el catálogo.\n\n` + preview;
      await replySafe(msg, preview);
      if (DEBUG) console.log('[CONFIRM] uncataloged place accepted:', uncatPlace);
      return;
    }
    
    // Limpiar pendiente si el usuario dice otra cosa
    if (s._pendingUncatalogedPlace && !isYes(rawUser)) {
      s._pendingUncatalogedPlace = null;
    }
    
    // ✅ NUEVO: Clasificar el tipo de mensaje
    const msgType = classifyConfirmMessage(rawUser, s.draft);
    if (DEBUG) console.log('[CONFIRM] message classified as:', msgType, { text: rawUser.substring(0, 40) });
    
    // ═══════════════════════════════════════════════════════════════
    // CONFIRMACIÓN: Si el ticket está completo y el usuario dice sí
    // ═══════════════════════════════════════════════════════════════
    if (msgType === 'confirm' && hasRequiredDraft(s.draft)) {
      await finalizeAndDispatch({ client, msg, session: s });
      return;
    }
    
    // ═══════════════════════════════════════════════════════════════
    // CANCELACIÓN
    // ═══════════════════════════════════════════════════════════════
    if (msgType === 'cancel') {
      await replySafe(msg, '❌ Incidencia cancelada. Si necesitas algo más, dime.');
      closeSession(s);
      s._pendingMedia = [];
      s._visionAreaHints = null;
      s._mediaBatch = null;
      s._askedPlaceMuteUntil = 0;
      s._pendingUncatalogedPlace = null;
      resetSession(chatId);
      if (DEBUG) console.log('[NI] closed: canceled (strict deny)');
      return;
    }
    
    // ═══════════════════════════════════════════════════════════════
    // CAMBIO EXPRESS DE LUGAR
    // ═══════════════════════════════════════════════════════════════
    if (msgType === 'place_change') {
      const oldLugar = s.draft.lugar;
      const result = await normalizeAndSetLugar(s, msg, rawUser, { force: true, rawText: rawUser });
      
      if (result && result.fuzzySuggestions && result.fuzzySuggestions.length > 0) {
        // Mostrar sugerencias fuzzy
        const suggestions = result.fuzzySuggestions.slice(0, 3);
        const suggestionList = suggestions.map((sug, i) => 
          `${i + 1}. *${sug.label}* _(${sug.similarity}% similar)_`
        ).join('\n');
        
        await replySafe(msg,
          `🤔 No encontré exactamente "*${result.originalInput}*".\n\n` +
          `¿Quisiste decir?\n${suggestionList}\n\n` +
          `Responde el *número* (1, 2, 3) o escribe el lugar correcto.`
        );
        
        s._placeCandidates = suggestions.map(sug => ({ label: sug.label, via: 'fuzzy', score: sug.similarity }));
        setMode(s, 'choose_place_from_candidates');
        return;
      }
      
      if (result && result.ok && s.draft.lugar) {
        // Actualizar referencias en descripción si cambió el número de habitación
        if (oldLugar && s.draft.descripcion) {
          const oldRoomMatch = oldLugar.match(/\d{4}/);
          const newRoomMatch = s.draft.lugar.match(/\d{4}/);
          if (oldRoomMatch && newRoomMatch && oldRoomMatch[0] !== newRoomMatch[0]) {
            s.draft.descripcion = s.draft.descripcion.replace(new RegExp(oldRoomMatch[0], 'g'), newRoomMatch[0]);
            if (s.draft.descripcion_original) {
              s.draft.descripcion_original = s.draft.descripcion_original.replace(new RegExp(oldRoomMatch[0], 'g'), newRoomMatch[0]);
            }
          }
        }
        
        // Actualizar flag de catálogo
        if (result.inCatalog === false) {
          s._lugarNotInCatalog = true;
        } else if (result.inCatalog === true) {
          s._lugarNotInCatalog = false;
        }
        
        await refreshIncidentDescription(s, rawUser);
        
        let preview = formatPreviewMessage(s.draft);
        if (s._lugarNotInCatalog && s.draft.lugar) {
          preview = `⚠️ *${s.draft.lugar}* no está en el catálogo.\n\n` + preview;
        }
        await replySafe(msg, `✅ Lugar actualizado a *${s.draft.lugar}*\n\n` + preview);
        if (DEBUG) console.log('[CONFIRM] lugar updated:', s.draft.lugar);
        return;
      } else {
        // No se encontró - preguntar
        await replySafe(msg, 
          `❌ No encontré ese lugar en el catálogo.\n\n` +
          `Escribe el lugar correcto o responde *sí* para enviar el ticket como está.`
        );
        return;
      }
    }
    
    // ═══════════════════════════════════════════════════════════════
    // CAMBIO EXPRESS DE ÁREA
    // ═══════════════════════════════════════════════════════════════
    if (msgType === 'area_change') {
      const newArea = extractExplicitArea(rawUser);
      if (newArea) {
        setDraftField(s, 'area_destino', newArea);
        if (!s.draft.areas?.includes(newArea)) addArea(s, newArea);
        
        const areaNames = { it: 'IT/Sistemas', man: 'Mantenimiento', ama: 'Ama de Llaves', seg: 'Seguridad', rs: 'Room Service' };
        const preview = formatPreviewMessage(s.draft);
        await replySafe(msg, `✅ Área actualizada a *${areaNames[newArea] || newArea}*\n\n` + preview);
        if (DEBUG) console.log('[CONFIRM] area updated:', newArea);
        return;
      } else {
        await replySafe(msg, 
          `❌ No reconocí esa área.\n\n` +
          `Áreas válidas: *IT*, *Mantenimiento*, *Ama de Llaves*, *Seguridad*, *Room Service*`
        );
        return;
      }
    }
    
    // ═══════════════════════════════════════════════════════════════
    // COMANDOS DE EDICIÓN (borrar, cambiar descripción)
    // ═══════════════════════════════════════════════════════════════
    if (msgType === 'edit_command') {
      const t = norm(rawUser);
      
      // Detectar si quiere borrar/reemplazar
      const wantsBorrar = /\b(borra|borrar|elimina|eliminar|quita|quitar)\b/i.test(rawUser);
      const wantsActualizar = /\b(actualiza|actualizar|cambia|cambiar|reemplaza|reemplazar)\b/i.test(rawUser);
      
      // Extraer la nueva descripción si viene en el mismo mensaje
      // Ejemplo: "Borra eso. Lo que no funciona es la TV"
      // Ejemplo: "Actualiza la descripción: El internet no sirve"
      const newDescMatch = rawUser.match(/(?:borra\s+eso|elimina\s+eso|quita\s+eso)[.,]?\s*(.+)/i) ||
                           rawUser.match(/(?:actualiza|cambia|reemplaza)\s+(?:la\s+)?descripcion[:\s]*(.+)/i);
      
      if (newDescMatch && newDescMatch[1] && newDescMatch[1].trim().length > 5) {
        // Tiene nueva descripción en el mismo mensaje → REEMPLAZAR
        const newDesc = newDescMatch[1].trim();
        s.draft.descripcion = newDesc;
        s.draft.descripcion_original = newDesc;
        s.draft._details = []; // Limpiar detalles
        
        // Re-detectar área
        try {
          const a = await detectArea(newDesc);
          if (a?.area) {
            setDraftField(s, 'area_destino', a.area);
            s.draft.areas = [a.area];
          }
        } catch {}
        
        const preview = formatPreviewMessage(s.draft);
        await replySafe(msg, `✅ Descripción actualizada:\n\n` + preview);
        if (DEBUG) console.log('[CONFIRM] description replaced via edit command', { newDesc });
        return;
      }
      
      if (wantsBorrar) {
        // Solo quiere borrar, preguntar qué poner
        await replySafe(msg,
          '🗑️ ¿Qué quieres hacer?\n\n' +
          '• Escribe la *nueva descripción* del problema\n' +
          '• O escribe *cancelar* para mantener la descripción actual'
        );
        s._editTarget = 'descripcion';
        setMode(s, 'edit');
        if (DEBUG) console.log('[CONFIRM] entering edit mode for description (delete request)');
        return;
      }
      
      if (wantsActualizar) {
        // Quiere actualizar pero no dio nueva descripción
        await replySafe(msg,
          '📝 Escribe la nueva descripción del problema.\n\n' +
          '_La descripción anterior será reemplazada._'
        );
        s._editTarget = 'descripcion';
        setMode(s, 'edit');
        if (DEBUG) console.log('[CONFIRM] entering edit mode for description (update request)');
        return;
      }
      
      // Si solo dice "editar" sin especificar qué, mostrar menú
      await replySafe(msg,
        '✏️ *¿Qué quieres editar?*\n\n' +
        '• *descripción* — cambiar el problema\n' +
        '• *lugar* — cambiar la ubicación\n' +
        '• *área* — cambiar el departamento destino\n' +
        '• *cancelar* — volver sin cambios'
      );
      s._editTarget = null;
      setMode(s, 'edit');
      if (DEBUG) console.log('[CONFIRM] entering edit mode (menu)');
      return;
    }
    
    // ═══════════════════════════════════════════════════════════════
    // CAMBIO/ADICIÓN DE DESCRIPCIÓN
    // ═══════════════════════════════════════════════════════════════
    if (msgType === 'description_change') {
      // Verificar si menciona un lugar/área DIFERENTE al actual
      const mentionsDifferent = detectMentionsDifferentPlace(rawUser, s.draft.lugar);
      const differentArea = detectDifferentArea(rawUser, s.draft.area_destino);
      
      // ✅ NUEVO: Detectar si es un tipo de problema COMPLETAMENTE diferente
      const currentProblemType = detectProblemType(norm(s.draft.descripcion || ''));
      const newProblemType = detectProblemType(norm(rawUser));
      const isDifferentProblem = currentProblemType && newProblemType && 
                                  currentProblemType !== newProblemType &&
                                  currentProblemType !== 'general' &&
                                  newProblemType !== 'general' &&
                                  s.draft.descripcion && s.draft.descripcion.length > 15;
      
      // ✅ NUEVO: Detectar si las áreas destino serían diferentes
      let newAreaWouldBe = null;
      let newLugarWouldBe = null;
      if (isDifferentProblem) {
        try {
          const areaResult = await detectArea(rawUser);
          newAreaWouldBe = areaResult?.area || null;
        } catch {}
        
        // Detectar lugar del nuevo mensaje
        const strong = findStrongPlaceSignals(rawUser);
        if (strong) {
          const placeResult = await detectPlace(strong.value);
          newLugarWouldBe = placeResult?.label || strong.value;
        }
      }
      const areDifferentAreas = newAreaWouldBe && s.draft.area_destino && 
                                 newAreaWouldBe !== s.draft.area_destino;
      
      if (isDifferentProblem && areDifferentAreas) {
        if (DEBUG) console.log('[CONFIRM] different problem type detected - creating dual ticket view', { 
          current: currentProblemType, 
          new: newProblemType,
          currentArea: s.draft.area_destino,
          newArea: newAreaWouldBe,
        });
        
        // ✅ NUEVO: Crear segundo draft para el nuevo problema (sin ID hasta persistir)
        const secondDraft = {
          descripcion: rawUser,
          descripcion_original: rawUser,
          lugar: newLugarWouldBe || s.draft.lugar, // Usar mismo lugar si no se especifica otro
          area_destino: newAreaWouldBe,
          areas: [newAreaWouldBe],
        };
        
        // Guardar ambos drafts
        s._multipleTickets = [
          { ...s.draft, _ticketNum: 1 },
          { ...secondDraft, _ticketNum: 2 }
        ];
        
        // Formatear vista de ambos tickets
        const areaNames = {
          'it': 'IT/Sistemas',
          'man': 'Mantenimiento', 
          'ama': 'Ama de llaves',
          'seg': 'Seguridad',
          'rs': 'Room Service'
        };
        
        const ticket1Preview = [
          `*Ticket 1* → ${areaNames[s.draft.area_destino] || s.draft.area_destino?.toUpperCase()}`,
          `• Descripción: ${s.draft.descripcion?.substring(0, 60)}${s.draft.descripcion?.length > 60 ? '...' : ''}`,
          `• Lugar: ${s.draft.lugar || '(sin lugar)'}`,
        ].join('\n');
        
        const ticket2Preview = [
          `*Ticket 2* → ${areaNames[newAreaWouldBe] || newAreaWouldBe?.toUpperCase()}`,
          `• Descripción: ${secondDraft.descripcion?.substring(0, 60)}${secondDraft.descripcion?.length > 60 ? '...' : ''}`,
          `• Lugar: ${secondDraft.lugar || '(sin lugar)'}`,
        ].join('\n');
        
        await replySafe(msg,
          '📋 *Se detectaron 2 tickets diferentes:*\n\n' +
          ticket1Preview + '\n\n' +
          ticket2Preview + '\n\n' +
          '━━━━━━━━━━━━━━━━━━━━━━\n' +
          '¿Qué quieres hacer?\n' +
          '• *enviar ambos* — enviar los 2 tickets\n' +
          '• *editar 1* — editar el ticket 1\n' +
          '• *editar 2* — editar el ticket 2\n' +
          '• *solo 1* — enviar solo el ticket 1\n' +
          '• *solo 2* — enviar solo el ticket 2\n' +
          '• *cancelar* — descartar ambos'
        );
        
        setMode(s, 'multiple_tickets');
        return;
      }
      
      // Si es problema diferente pero misma área, permitir agregar
      if (isDifferentProblem && !areDifferentAreas) {
        if (DEBUG) console.log('[CONFIRM] different problem type but same area', { 
          current: currentProblemType, 
          new: newProblemType,
          area: s.draft.area_destino
        });
        
        await replySafe(msg,
          '🤔 Parece que esto es un *problema diferente* al que estabas reportando.\n\n' +
          `📋 *Ticket actual:* _"${s.draft.descripcion?.substring(0, 50)}..."_\n` +
          `📋 *Nuevo mensaje:* _"${rawUser.substring(0, 50)}..."_\n\n` +
          '¿Qué quieres hacer?\n' +
          '• *enviar* — enviar el ticket actual y luego crear uno nuevo\n' +
          '• *reemplazar* — descartar el actual y usar este nuevo\n' +
          '• *agregar* — agregar como detalle al ticket actual\n' +
          '• *cancelar* — ignorar este mensaje'
        );
        
        s._pendingNewIncidentText = rawUser;
        s._pendingOldIncidentDraft = { ...s.draft };
        s._pendingNewArea = newAreaWouldBe;
        s._areDifferentAreas = false;
        setMode(s, 'different_problem');
        return;
      }
      
      if (mentionsDifferent || differentArea) {
        // Podría ser un nuevo reporte - preguntar
        if (DEBUG) console.log('[CONFIRM] description mentions different place/area', { mentionsDifferent, differentArea });
        
        await replySafe(msg,
          '🤔 Tu mensaje menciona un lugar o área diferente.\n\n' +
          '¿Qué quieres hacer?\n' +
          '• *agregar* — agregar como detalle a este ticket\n' +
          '• *nuevo* — crear un ticket nuevo con esto\n' +
          '• *cancelar* — ignorar este mensaje'
        );
        
        s._pendingDescriptionText = rawUser;
        setMode(s, 'description_or_new');
        return;
      }
      
      // Agregar/actualizar descripción
      const oldDesc = s.draft.descripcion || '';
      const currentLugar = s.draft.lugar || '';
      
      // ✅ FIX: Detectar si la descripción actual es solo el lugar o muy corta
      const descIsJustPlace = norm(oldDesc).includes(norm(currentLugar).replace('habitacion ', '')) ||
                              oldDesc.length < 25 ||
                              /^(habitacion|hab|villa|en)\s*\d+$/i.test(norm(oldDesc));
      
      if (!oldDesc || descIsJustPlace) {
        // Si la descripción actual es muy corta, vacía, o es solo el lugar → REEMPLAZAR
        s.draft.descripcion = rawUser;
        s.draft.descripcion_original = rawUser;
        if (DEBUG) console.log('[CONFIRM] description REPLACED (was just place or too short)', { old: oldDesc, new: rawUser });
      } else {
        // Agregar como detalle
        addDetail(s, rawUser);
        if (DEBUG) console.log('[CONFIRM] description added as detail');
      }
      
      // ✅ FIX: Re-detectar área basada en la nueva descripción completa
      try {
        const a = await detectArea(s.draft.descripcion);
        if (a?.area && a.area !== s.draft.area_destino) {
          const oldArea = s.draft.area_destino;
          setDraftField(s, 'area_destino', a.area);
          if (!s.draft.areas?.includes(a.area)) addArea(s, a.area);
          if (DEBUG) console.log('[CONFIRM] area updated based on new description:', { old: oldArea, new: a.area });
        }
      } catch {}
      
      await refreshIncidentDescription(s, rawUser);
      
      let preview = formatPreviewMessage(s.draft);
      if (s._lugarNotInCatalog && s.draft.lugar) {
        preview = `⚠️ *${s.draft.lugar}* no está en el catálogo.\n\n` + preview;
      }
      await replySafe(msg, `✅ Descripción actualizada:\n\n` + preview);
      if (DEBUG) console.log('[CONFIRM] description updated');
      return;
    }
    
    // ═══════════════════════════════════════════════════════════════
    // DESCONOCIDO - intentar interpretar como lugar si falta
    // ═══════════════════════════════════════════════════════════════
    if (!s.draft.lugar) {
      // Si no tiene lugar, intentar interpretar como lugar
      const result = await normalizeAndSetLugar(s, msg, rawUser, { force: false, rawText: rawUser });
      if (result && result.ok) {
        s._unknownAttempts = 0; // Resetear contador
        await refreshIncidentDescription(s, rawUser);
        const preview = formatPreviewMessage(s.draft);
        await replySafe(msg, preview);
        return;
      }
    }
    
    // ✅ NUEVO: Intentar interpretar como lugar incluso si ya tiene uno
    // (usuario podría estar intentando cambiar el lugar)
    if (/\d{4}/.test(rawUser)) {
      const roomMatch = rawUser.match(/\d{4}/);
      if (roomMatch) {
        const result = await normalizeAndSetLugar(s, msg, roomMatch[0], { force: true, rawText: rawUser });
        if (result && result.ok) {
          s._unknownAttempts = 0;
          const preview = formatPreviewMessage(s.draft);
          await replySafe(msg, `✅ Lugar actualizado a *${s.draft.lugar}*\n\n` + preview);
          if (DEBUG) console.log('[CONFIRM] lugar updated from unknown message with room number');
          return;
        }
      }
    }
    
    // ✅ NUEVO: Contador de intentos fallidos
    s._unknownAttempts = (s._unknownAttempts || 0) + 1;
    
    if (s._unknownAttempts >= 3) {
      // Después de 3 intentos fallidos, ofrecer reiniciar
      await replySafe(msg,
        '😅 Parece que estamos teniendo dificultades para entendernos.\n\n' +
        '¿Qué prefieres hacer?\n' +
        '• *reiniciar* — empezar el ticket desde cero\n' +
        '• *enviar* — enviar el ticket como está ahora\n' +
        '• *cancelar* — descartar todo'
      );
      setMode(s, 'confused_recovery');
      return;
    }
    
    // No entendí (con ejemplos más claros)
    await replySafe(msg,
      '🤔 No entendí tu mensaje.\n\n' +
      'Puedes:\n' +
      '• Responder *sí* para enviar el ticket\n' +
      '• Responder *no* para cancelar\n' +
      '• Escribir el *lugar* (ej: "2102" o "front")\n' +
      '• Escribir el *área* (ej: "para IT")\n' +
      '• Agregar más *detalles* al problema'
    );
    return;
  }
  
  // ✅ NUEVO: Modo de recuperación cuando el bot está confundido
  if (s.mode === 'confused_recovery' && text) {
    const t = norm(text);
    
    if (/^reiniciar?\b/i.test(t) || /^empezar\b/i.test(t) || /^nuevo\b/i.test(t)) {
      // Reiniciar ticket (sin ID hasta persistir)
      const oldDesc = s.draft.descripcion || '';
      s.draft = {};
      s._unknownAttempts = 0;
      s._lugarNotInCatalog = false;
      
      await replySafe(msg,
        '🔄 ¡Empecemos de nuevo!\n\n' +
        'Cuéntame:\n' +
        '1️⃣ ¿Cuál es el *problema*?\n' +
        '2️⃣ ¿En qué *lugar* está? (habitación, área, etc.)'
      );
      setMode(s, 'neutral');
      if (DEBUG) console.log('[CONFUSED] restarting ticket');
      return;
    }
    
    if (/^enviar?\b/i.test(t) || isYes(text)) {
      // Enviar como está
      if (hasRequiredDraft(s.draft)) {
        s._unknownAttempts = 0;
        await finalizeAndDispatch({ client, msg, session: s });
        return;
      } else {
        const preview = formatPreviewMessage(s.draft);
        await replySafe(msg, '⚠️ El ticket está incompleto:\n\n' + preview);
        setMode(s, 'confirm');
        return;
      }
    }
    
    if (/^cancelar?\b/i.test(t) || isNo(text)) {
      closeSession(s);
      resetSession(chatId);
      s._unknownAttempts = 0;
      await replySafe(msg, '❌ Ticket cancelado. Cuando quieras, escríbeme de nuevo.');
      return;
    }
    
    // Si escribió otra cosa, intentar interpretar como nuevo mensaje
    s._unknownAttempts = 0;
    setMode(s, 'neutral');
    // Continuar con el procesamiento normal (caerá en el flujo de interpretación)
  }
    
  /* 2) Interpretación de turno */
  const focus = modeToFocus(s.mode);
  const ai = await interpretTurn({ text, focus, draft: s.draft });
  ai.ops = dedupeOps(ai.ops || []);

  const guardRes = classifyNiGuard(text, { aiAnalysis: ai.analysis || '' });
  if (DEBUG) console.log('[NI-GUARD] classify', {
    text,
    aiAnalysis: ai.analysis,
    tNorm: norm(text),
    isGreetingFlag: guardRes.isGreeting,
    nonIncidentFlag: guardRes.nonIncident,
    aiSmalltalkFlag: guardRes.aiSmalltalk,
    incidentLikeFlag: guardRes.incidentLike,
    shouldBypassNI: guardRes.shouldBypassNI,
    reason: guardRes.reason
  });

  if (guardRes.shouldBypassNI && isSessionBareForNI(s)) {
    if (DEBUG) console.log('[NI-GUARD] bypass NI', {
      reason: guardRes.reason,
      isGreeting: guardRes.isGreeting,
      aiSmalltalk: guardRes.aiSmalltalk,
    });
    
    // ✅ NUEVO: Responder con contexto antes de hacer bypass
    if (guardRes.aiSmalltalk || guardRes.isGreeting) {
      try {
        const contextualResponse = await generateContextualResponse(text);
        await replySafe(msg, contextualResponse);
        if (DEBUG) console.log('[NI-GUARD] responded to smalltalk with contextual message');
      } catch (e) {
        if (DEBUG) console.warn('[NI-GUARD] contextual response error', e?.message);
        await replySafe(msg,
          '👋 ¡Hola! Soy el bot de *incidencias* del hotel.\n\n' +
          'Si necesitas reportar algo que *no funciona* o está *dañado*, cuéntame qué pasó y dónde está.\n\n' +
          '_Ejemplo: "No funciona el aire en hab 1205"_'
        );
      }
    }
    return;
  }

  if (DEBUG) console.log('[TURN META]', {
    is_new_incident_candidate: ai.meta?.is_new_incident_candidate,
    is_place_correction_only: ai.meta?.is_place_correction_only,
    hasDraftStructure: !isSessionBareForNI(s),
    differentPlace: isDifferentStrongPlace(text, s.draft)
  });

  // ✅ MEJORADO: Detectar cambio drástico de contexto (nueva incidencia vs draft existente)
  // Aplica si hay un draft con descripción, en cualquier modo excepto context_switch
  if (!isSessionBareForNI(s) && s.draft.descripcion && s.mode !== 'context_switch') {
    const currentDesc = norm(s.draft.descripcion || '');
    const newText = norm(text);
    
    // ✅ NUEVO: Si estamos esperando lugar pero el mensaje parece un reporte completo nuevo
    if (s.mode === 'ask_place' || s.mode === 'confirm' || s.mode === 'preview') {
      // El mensaje parece un reporte nuevo si tiene:
      // 1. Descripción de problema (más de 20 chars)
      // 2. Palabras que indican problema técnico
      // 3. NO es solo un lugar/confirmación
      const looksLikeNewReport = 
        text.length > 25 && 
        /\b(no\s+funciona|no\s+sirve|no\s+enciende|no\s+prende|roto|dañado|falla|fuga|gotea|problema|necesito|traigan|traer|prender|encender|control|audio)\b/i.test(text) &&
        !isYes(text) && !isNo(text);
      
      // Detectar si menciona lugares DIFERENTES al draft actual
      const currentLugar = norm(s.draft.lugar || '');
      const mentionsDifferentPlace = detectMentionsDifferentPlace(text, s.draft.lugar);
      
      if (looksLikeNewReport && (mentionsDifferentPlace || !s.draft.lugar)) {
        // Detectar tipos de problema
        const currentProblemType = detectProblemType(currentDesc);
        const newProblemType = detectProblemType(newText);
        
        // Si son problemas diferentes O lugares diferentes, es cambio de contexto
        if ((currentProblemType !== newProblemType) || mentionsDifferentPlace) {
          if (DEBUG) console.log('[NI] context switch detected in ask_place/confirm', { 
            mode: s.mode,
            currentProblem: currentProblemType,
            newProblem: newProblemType,
            mentionsDifferentPlace
          });
          
          await replySafe(msg,
            '🤔 Parece que me estás reportando algo diferente.\n\n' +
            `Tu reporte anterior: _"${s.draft.descripcion.substring(0, 50)}${s.draft.descripcion.length > 50 ? '...' : ''}"_` +
            (s.draft.lugar ? ` en *${s.draft.lugar}*` : '') + '\n\n' +
            '¿Qué prefieres?\n' +
            '• *nuevo* — iniciar un ticket nuevo con esto\n' +
            '• *anterior* — continuar con el ticket anterior\n' +
            '• *cancelar* — descartar todo'
          );
          
          s._candidateIncidentText = text;
          s._contextSwitchPending = true;
          setMode(s, 'context_switch');
          return;
        }
      }
    }
    
    // Detectar si el nuevo mensaje parece un problema diferente (flujo original)
    const hasPlaceChange = isDifferentStrongPlace(text, s.draft);
    const hasNewProblem = /\b(no\s+funciona|no\s+sirve|no\s+enciende|roto|dañado|falla|fuga|gotea|problema)\b/i.test(text);
    const currentIsRequest = /\b(traer|comida|hambre|quiero|necesito)\b/i.test(currentDesc);
    
    // Si el draft actual era una solicitud y el nuevo es un problema técnico
    if (currentIsRequest && hasNewProblem && s.mode !== 'ask_place' && s.mode !== 'confirm') {
      if (DEBUG) console.log('[NI] context switch: request → incident', { 
        currentDesc: currentDesc.substring(0, 30),
        newText: newText.substring(0, 30)
      });
      
      // Preguntar al usuario
      await replySafe(msg,
        '🤔 Parece que me estás reportando algo diferente.\n\n' +
        `Tu reporte anterior era: _"${s.draft.descripcion.substring(0, 50)}..."_\n\n` +
        '¿Qué prefieres?\n' +
        '• Escribe *nuevo* para iniciar un ticket nuevo\n' +
        '• Escribe *cancelar* para descartar todo\n' +
        '• O simplemente dime el *lugar* para continuar con este nuevo reporte'
      );
      
      // Guardar el texto candidato
      s._candidateIncidentText = text;
      s._contextSwitchPending = true;
      setMode(s, 'context_switch');
      return;
    }
    
    // Si hay cambio de lugar + parece problema nuevo diferente
    if (hasPlaceChange && hasNewProblem && s.mode !== 'ask_place' && s.mode !== 'confirm') {
      const currentProblemType = detectProblemType(currentDesc);
      const newProblemType = detectProblemType(newText);
      
      if (currentProblemType && newProblemType && currentProblemType !== newProblemType) {
        if (DEBUG) console.log('[NI] context switch: different problem type', { 
          current: currentProblemType,
          new: newProblemType
        });
        
        await replySafe(msg,
          '🤔 Parece que me estás reportando algo diferente.\n\n' +
          `Tu reporte anterior: _"${s.draft.descripcion.substring(0, 50)}..."_ en *${s.draft.lugar || 'sin lugar'}*\n\n` +
          '¿Qué prefieres?\n' +
          '• *nuevo* — iniciar un ticket nuevo\n' +
          '• *agregar* — agregar esto como detalle al ticket actual\n' +
          '• *cancelar* — descartar todo'
        );
        
        s._candidateIncidentText = text;
        s._contextSwitchPending = true;
        setMode(s, 'context_switch');
        return;
      }
    }
  }

  if (DEBUG) console.log('[OPS] turn.out', ai);
  if (DEBUG) console.log('[OPS] analysis:', ai.analysis);

  // Área explícita en texto
  const explicitArea = extractExplicitArea(text);

  // Procesar ops
  let lugarChanged = false;
  let areaChanged = false;

  for (const op of ai.ops || []) {
    switch (op.op) {
      case 'set_field': {
        const field = op.field;
        const val = (op.value || '').toString().trim();
        
        if (field === 'lugar' && val) {
          // ✅ FIX: Validar lugar antes de aceptarlo
          const result = await normalizeAndSetLugar(s, msg, val, { rawText: text });
          
          // ✅ NUEVO: Si hay sugerencias fuzzy, guardarlas para preguntar al usuario
          if (result && result.fuzzySuggestions && result.fuzzySuggestions.length > 0) {
            // Guardar sugerencias para preguntarle al usuario después del preview
            s._pendingFuzzySuggestions = result.fuzzySuggestions;
            s._pendingFuzzyInput = result.originalInput;
            if (DEBUG) console.log('[OPS] set_field lugar has fuzzy suggestions, will ask user', { 
              input: result.originalInput,
              suggestions: result.fuzzySuggestions.map(s => s.label)
            });
            // NO marcar lugarChanged, seguir sin lugar para que pregunte
          } else if (result && result.ok) {
            lugarChanged = true;
            // ✅ FIX: Actualizar flag de catálogo
            if (typeof result === 'object' && result.inCatalog === false) {
              s._lugarNotInCatalog = true;
            } else if (typeof result === 'object' && result.inCatalog === true) {
              s._lugarNotInCatalog = false;
            }
            await refreshIncidentDescription(s, text);
          } else {
            if (DEBUG) console.log('[OPS] set_field lugar rejected:', val);
          }
        } else if (field === 'area' || field === 'area_destino') {
          const areaVal = val.toLowerCase();
          if (['it', 'man', 'ama', 'seg', 'rs'].includes(areaVal)) {
            setDraftField(s, 'area_destino', areaVal);
            if (!s.draft.areas?.includes(areaVal)) addArea(s, areaVal);
            areaChanged = true;
          }
        } else if (field === 'descripcion' || field === 'incidente') {
          // No sobrescribir descripción original
        }
        break;
      }
      case 'show_preview':
      case 'preview': {
        if (!s.draft.area_destino) {
          const textAreaResult = await detectArea(text).catch(() => null);
          const textArea = textAreaResult?.area || null;
          const { done } = await suggestAreaOrAsk(s, msg, {
            explicitArea,
            textArea,
            visionHints
          });
          if (!done) return;
        }
        if (!s.draft.lugar) {
          await replySafe(
            msg,
            '📍 *Falta el lugar*. ¿Dónde es?\n' +
            'Ejemplos: "hab 1311", "en Front Desk", "Pasillo F".'
          );
          setMode(s, 'ask_place');
          return;
        }
        const preview = formatPreview(s.draft);
        await replySafe(msg, preview + '\n\n¿Lo envío? Responde "sí" o "no".');
        setMode(s, 'confirm');
        pushTurn(s, 'bot', '[preview]');
        if (DEBUG) console.log('[PREVIEW] sent (by-op)');
        return;
      }
      case 'confirm': {
        if (s.mode === 'confirm' || s.mode === 'preview') {
          if (!hasRequiredDraft(s.draft)) {
            if (!s.draft.area_destino) {
              const textAreaResult = await detectArea(text).catch(() => null);
              const textArea = textAreaResult?.area || null;
              const { done } = await suggestAreaOrAsk(s, msg, {
                explicitArea,
                textArea,
                visionHints
              });
              if (!done) return;
            }
            if (!s.draft.lugar) {
              await replySafe(msg, '📍 Antes de enviar, dime *el lugar*.');
              setMode(s, 'ask_place');
              return;
            }
          }
          if (isYes(rawUser)) {
            await finalizeAndDispatch({ client, msg, session: s });
            return;
          }
        }
        break;
      }
      case 'append_detail': {
        const val = (op.value || '').trim();
        if (val) {
          // ✅ NUEVO: Verificar si es un problema DIFERENTE antes de agregar
          if (s.draft.descripcion && s.draft.descripcion.length > 15) {
            const currentProblemType = detectProblemType(norm(s.draft.descripcion || ''));
            const newProblemType = detectProblemType(norm(text));
            
            // Si son tipos de problema diferentes y no son "general"
            if (currentProblemType && newProblemType && 
                currentProblemType !== newProblemType &&
                currentProblemType !== 'general' && 
                newProblemType !== 'general') {
              
              // Detectar si las áreas serían diferentes
              let newAreaWouldBe = null;
              let newLugarWouldBe = null;
              try {
                const areaResult = await detectArea(text);
                newAreaWouldBe = areaResult?.area || null;
              } catch {}
              
              const strong = findStrongPlaceSignals(text);
              if (strong) {
                const placeResult = await detectPlace(strong.value);
                newLugarWouldBe = placeResult?.label || strong.value;
              }
              
              const areDifferentAreas = newAreaWouldBe && s.draft.area_destino && 
                                         newAreaWouldBe !== s.draft.area_destino;
              
              if (areDifferentAreas) {
                if (DEBUG) console.log('[OPS] append_detail: different problem detected, switching to multiple_tickets', {
                  current: currentProblemType,
                  new: newProblemType,
                  currentArea: s.draft.area_destino,
                  newArea: newAreaWouldBe
                });
                
                // Crear segundo draft (sin ID hasta persistir)
                const secondDraft = {
                  descripcion: text,
                  descripcion_original: text,
                  lugar: newLugarWouldBe || s.draft.lugar,
                  area_destino: newAreaWouldBe,
                  areas: [newAreaWouldBe],
                };
                
                // Guardar ambos drafts
                s._multipleTickets = [
                  { ...s.draft, _ticketNum: 1 },
                  { ...secondDraft, _ticketNum: 2 }
                ];
                
                // Formatear vista de ambos tickets
                const areaNames = {
                  'it': 'IT/Sistemas',
                  'man': 'Mantenimiento', 
                  'ama': 'Ama de llaves',
                  'seg': 'Seguridad',
                  'rs': 'Room Service'
                };
                
                const ticket1Preview = [
                  `*Ticket 1* → ${areaNames[s.draft.area_destino] || s.draft.area_destino?.toUpperCase()}`,
                  `• Descripción: ${s.draft.descripcion?.substring(0, 60)}${s.draft.descripcion?.length > 60 ? '...' : ''}`,
                  `• Lugar: ${s.draft.lugar || '(sin lugar)'}`,
                ].join('\n');
                
                const ticket2Preview = [
                  `*Ticket 2* → ${areaNames[newAreaWouldBe] || newAreaWouldBe?.toUpperCase()}`,
                  `• Descripción: ${secondDraft.descripcion?.substring(0, 60)}${secondDraft.descripcion?.length > 60 ? '...' : ''}`,
                  `• Lugar: ${secondDraft.lugar || '(sin lugar)'}`,
                ].join('\n');
                
                await replySafe(msg,
                  '📋 *Se detectaron 2 tickets diferentes:*\n\n' +
                  ticket1Preview + '\n\n' +
                  ticket2Preview + '\n\n' +
                  '━━━━━━━━━━━━━━━━━━━━━━\n' +
                  '¿Qué quieres hacer?\n' +
                  '• *enviar ambos* — enviar los 2 tickets\n' +
                  '• *editar 1* — editar el ticket 1\n' +
                  '• *editar 2* — editar el ticket 2\n' +
                  '• *solo 1* — enviar solo el ticket 1\n' +
                  '• *solo 2* — enviar solo el ticket 2\n' +
                  '• *cancelar* — descartar ambos'
                );
                
                setMode(s, 'multiple_tickets');
                return;
              }
            }
          }
          
          // Flujo normal: agregar detalle
          const added = addDetail(s, val);
          if (added) {
            await refreshIncidentDescription(s, null, s.draft.descripcion_original || s.draft.descripcion || '');
            s.draft.descripcion = buildDescripcionWithDetails(s);

            if (!s.draft.lugar) {
              const now = Date.now();
              const justMedia = msg.hasMedia && !text;
              const inBatch   = inActiveMediaBatch(s, now);

              if (s._askedPlaceMuteUntil && now < s._askedPlaceMuteUntil) {
                setMode(s, 'ask_place');
                return;
              }

              if (justMedia && inBatch) {
                const b = s._mediaBatch;
                if (b?.askedPlace) {
                  setMode(s, 'ask_place');
                  return;
                }
                if (b) b.askedPlace = true;
              }

              await replySafe(
                msg,
                '📍 *No ubico el lugar exacto*. ¿Me dices dónde es?\n' +
                'Ejemplos: "hab 1311", "en Front Desk", "Casero", "Villa 12".'
              );
              const now2 = Date.now();
              s._askedPlaceAt = now2;
              s._askedPlaceMuteUntil = now2 + ASK_PLACE_COOLDOWN_MS;
              setMode(s, 'ask_place');
              pushTurn(s, 'bot', '[ask_place:early]');
              if (DEBUG) console.log('[NI] ask_place (early from append_detail)');
              return;
            }
          }
        }
        break;
      }
      case 'cancel': {
        if (isNo(rawUser)) {
          await replySafe(msg, '❌ Incidencia cancelada. Si necesitas algo más, dime.');
          closeSession(s);
          s._pendingMedia = [];
          s._visionAreaHints = null;
          s._mediaBatch = null;
          s._askedPlaceMuteUntil = 0;
          resetSession(chatId);
          if (DEBUG) console.log('[NI] closed: canceled (by-op)');
          return;
        }
        break;
      }
      default: break;
    }
  }

  /* 4) Refuerzos automáticos: LUGAR */
  if (!s.draft.lugar && !lugarChanged) {
    try {
      const auto = await detectPlace(text, {
        preferRoomsFirst: true,
        allowFuzzy: true,
        wantCandidates: true,
      });
      if (auto?.found) {
        setDraftField(s, 'lugar', auto.label);
        if (auto.meta?.building) setDraftField(s, 'building', auto.meta.building);
        if (auto.meta?.floor)    setDraftField(s, 'floor', auto.meta.floor);
        if (auto.meta?.room)     setDraftField(s, 'room', auto.meta.room);
        // ✅ Rastrear si NO está en catálogo
        s._lugarNotInCatalog = (auto.via === 'room_pattern');
        await refreshIncidentDescription(s, text);
        if (DEBUG) console.log('[PLACE] auto.detect', { label: auto.label, via: auto.via, score: auto.score ?? null, inCatalog: !s._lugarNotInCatalog });
      } else if (auto?.candidates?.length) {
        const top = auto.candidates[0];
        const second = auto.candidates[1];
        const keyUser = toKey(text);
        const keyTop  = toKey(top.label);
        const topScore = typeof top.score === 'number' ? top.score : parseFloat(top.score || '0');
        const secondScore = second ? (typeof second.score === 'number' ? second.score : parseFloat(second.score || '0')) : 0;

        if (keyTop === keyUser || (topScore >= RELAX_SCORE_MIN && (auto.candidates.length === 1 || (topScore - secondScore) >= RELAX_MARGIN))) {
          setDraftField(s, 'lugar', top.label);
          s._lugarNotInCatalog = false; // Si viene de candidatos, está en catálogo
          await refreshIncidentDescription(s, text);
          if (DEBUG) console.log('[PLACE] auto.relax.accept', { label: top.label, topScore, secondScore });
        }
      }
    } catch (e) {
      if (DEBUG) console.warn('[PLACE] auto.err', e?.message || e);
    }
  }

  /* 5) Refuerzos automáticos: ÁREA con prioridad */
  let textArea = null;
  if (!areaChanged) {
    try {
      const a = await detectArea(text);
      if (a?.area) {
        textArea = a.area;
        if (DEBUG) console.log('[AREA] by.text', a);
      }
    } catch (e) {
      if (DEBUG) console.warn('[AREA] auto.err', e?.message || e);
    }
  }
  
  // ✅ NUEVO: Detectar si hay múltiples áreas/problemas en el mensaje
  if (!s._multiAreaPending && !s.draft.area_destino && s.draft.lugar) {
    const multiAreas = await detectMultipleAreas(text);
    if (DEBUG) console.log('[NI] detectMultipleAreas result', { 
      hasMultiple: multiAreas && multiAreas.length > 1,
      areas: multiAreas ? multiAreas.map(a => a.code) : null 
    });
    if (multiAreas && multiAreas.length > 1) {
      if (DEBUG) console.log('[NI] multiple areas detected in new message', { areas: multiAreas.map(a => a.code) });
      
      // Guardar las áreas pendientes
      s._multiAreaPending = multiAreas;
      s._multiAreaOriginalText = text;
      
      // Construir mensaje con opciones
      const areaOptions = multiAreas.map((a, i) => 
        `${i + 1}. *${areaLabel(a.code)}* — _${a.hint}_`
      ).join('\n');
      
      await replySafe(
        msg,
        `🏷️ Detecté *${multiAreas.length} tipos de problema* en tu mensaje:\n\n` +
        `${areaOptions}\n\n` +
        `¿Cuál quieres reportar *primero*? Responde con el número (1, 2, etc.)`
      );
      
      setMode(s, 'choose_area_multi');
      return;
    }
  }
  
  // ✅ SIMPLIFICADO: Auto-asignar área sin preguntar
  if (!s.draft.area_destino) {
    autoAssignArea(s, { explicitArea, textArea, visionHints });
  }

  // ✅ NUEVO: Si hay sugerencias fuzzy pendientes, mostrarlas antes del preview
  if (s._pendingFuzzySuggestions && s._pendingFuzzySuggestions.length > 0 && !s.draft.lugar) {
    const suggestions = s._pendingFuzzySuggestions.slice(0, 3);
    const suggestionList = suggestions.map((sug, i) => 
      `${i + 1}. *${sug.label}* _(${sug.similarity}% similar)_`
    ).join('\n');
    
    await replySafe(msg,
      `🤔 No encontré exactamente "*${s._pendingFuzzyInput}*" en el catálogo.\n\n` +
      `¿Quisiste decir?\n${suggestionList}\n\n` +
      `Responde el *número* (1, 2, 3) o escribe el lugar correcto.`
    );
    
    s._placeCandidates = suggestions.map(sug => ({ label: sug.label, via: 'fuzzy', score: sug.similarity }));
    s._pendingFuzzySuggestions = null;
    s._pendingFuzzyInput = null;
    setMode(s, 'choose_place_from_candidates');
    if (DEBUG) console.log('[NI] showing fuzzy suggestions instead of preview');
    return;
  }

  // ✅ NUEVO: Si no hay lugar detectado, intentar extraerlo del texto descriptivo
  if (!s.draft.lugar && s.draft.descripcion) {
    const extractedPlace = extractPlaceFromText(s.draft.descripcion);
    if (extractedPlace) {
      // Intentar validar el lugar extraído en el catálogo
      try {
        const placeResult = await detectPlace(extractedPlace, { preferRoomsFirst: false });
        if (placeResult?.found) {
          setDraftField(s, 'lugar', placeResult.label);
          if (DEBUG) console.log('[NI] lugar auto-extracted from description:', placeResult.label);
        } else {
          // Usar el label extraído aunque no esté en catálogo
          setDraftField(s, 'lugar', extractedPlace);
          s._lugarNotInCatalog = true;
          if (DEBUG) console.log('[NI] lugar auto-extracted (not in catalog):', extractedPlace);
        }
      } catch (e) {
        // Usar el label extraído aunque haya error
        setDraftField(s, 'lugar', extractedPlace);
        if (DEBUG) console.log('[NI] lugar auto-extracted (error, using as-is):', extractedPlace);
      }
    }
  }

  /* 6) Siguiente paso - SIMPLIFICADO: Siempre mostrar preview */
  if (DEBUG) {
    console.log('[NI] draft.before_preview', {
      descripcion: s.draft.descripcion,
      lugar: s.draft.lugar,
      area_destino: s.draft.area_destino,
      mode: s.mode,
    });
  }
  
  // Mostrar preview (indicando qué falta si aplica)
  let preview = formatPreviewMessage(s.draft);
  
  // ✅ Agregar advertencia si la habitación no está en catálogo
  if (s._lugarNotInCatalog && s.draft.lugar) {
    preview = `⚠️ *${s.draft.lugar}* no está en el catálogo. Verifica que sea correcto.\n\n` + preview;
  }
  
  await replySafe(msg, preview);
  setMode(s, 'confirm');
  pushTurn(s, 'bot', '[preview]');
  if (DEBUG) console.log('[PREVIEW] sent (simplified flow)');
}

module.exports = { handleTurn };
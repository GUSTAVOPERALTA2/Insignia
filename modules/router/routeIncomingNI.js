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
  
  // Usar descripcion_original para evitar duplicados
  const descripcion = draft.descripcion_original || draft.incidente || draft.descripcion || '—';
  
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

function isYes(text) {
  const t = norm(text);
  if (YES_TOKENS.has(t)) return true;
  if (/^(si|sí)[.!?]*$/.test(t)) return true;
  if (['👍','✅','✔️'].some(e => String(text).includes(e))) return true;
  return false;
}

function isNo(text) {
  const t = norm(text);
  if (NO_TOKENS.has(t)) return true;
  if (/^no[.!?]*$/.test(t)) return true;
  if (['❌','✖️'].some(e => String(text).includes(e))) return true;
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

// ✅ SIMPLIFICADO: Auto-asignar área sin preguntar al usuario
function autoAssignArea(session, { explicitArea, textArea, visionHints }) {
  if (DEBUG) console.log('[AREA] autoAssignArea', {
    area_destino: session.draft.area_destino,
    candidate: { explicitArea, textArea, visionHints },
  });

  // Si ya hay área, no hacer nada
  if (session.draft.area_destino) {
    return true;
  }

  // Prioridad: explícita > texto > visión
  const candidate = explicitArea || textArea || (Array.isArray(visionHints) && visionHints[0]) || null;
  
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
 * Detalles acumulativos
 * ────────────────────────────── */
// ✅ SIMPLIFICADO: Ya no usamos detalles separados, ignorar esta operación
function addDetail(session, text) {
  // No hacer nada - los detalles ya no se usan
  return false;
}

// ✅ SIMPLIFICADO: Ya no usamos detalles separados
function buildDescripcionWithDetails(session, base = null) {
  return base || session.draft.incidente || session.draft.descripcion_original || '';
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
  const prefixes = {
    'man': 'MAN',
    'it': 'IT',
    'rs': 'RS',
    'ama': 'HSKP',
    'seg': 'SEG'
  };
  return prefixes[areaCode] || 'GEN'; // GEN para casos sin área definida
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
  s.draft.chat_id = chatId;  // ✅ Guardar el chat_id del solicitante

  // Persistir
  try {
    await persistIncident(s.draft);
    if (DEBUG) console.log('[NI] persisted', { id: s.draft.id, folio });
  } catch (e) {
    if (DEBUG) console.warn('[NI] persist.err', e?.message || e);
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
      await appendIncidentAttachments(folio, attachments);
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
        id: s.draft.id,
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
        await appendDispatchedToGroupsEvent(folio, targetIds);
        recordGroupDispatch(folio, targetIds);
        if (DEBUG) console.log('[NI] dispatched', { folio, sent: result.sent, errors: result.errors });
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
  
  // 2) Eliminar número de habitación al inicio (lo tenemos en el campo lugar)
  text = text.replace(/^\d{4}\s*[,.:;-]?\s*/i, '');
  
  // 3) Eliminar frases introductorias comunes
  const introPatterns = [
    // Patrones de huésped menciona/dice
    /^(el\s+)?hu[eé]sped\s+(de\s+)?(la\s+)?(hab(itaci[oó]n)?\s*)?\d*\s*(menciona|dice|reporta|comenta|indica|pide|solicita)\s+(a\s+\w+\s+)?(que\s+)?/i,
    /^(la\s+)?hab(itaci[oó]n)?\s*\d*\s*(menciona|dice|reporta|comenta|indica)\s+(a\s+\w+\s+)?(que\s+)?/i,
    
    // "menciona a front que", "dice a sistemas que"
    /^menciona\s+(a\s+[\w\s]+\s+)?(que\s+)?/i,
    /^dice\s+(a\s+[\w\s]+\s+)?(que\s+)?/i,
    /^reporta\s+(a\s+[\w\s]+\s+)?(que\s+)?/i,
    /^comenta\s+(a\s+[\w\s]+\s+)?(que\s+)?/i,
    /^indica\s+(a\s+[\w\s]+\s+)?(que\s+)?/i,
    /^(nos\s+)?(avisa|informa|comunica)\s+(que\s+)?/i,
    
    // Cortesías
    /^(por\s+favor|pf|porfa|please|pls)[,.]?\s*/i,
    /^(me\s+)?pueden?\s+ayudar\s*(con\s+)?(que\s+|a\s+)?(please|porfa|pf)?[,.]?\s*/i,
    /^(me\s+)?ayudan?\s*(con\s+)?(que\s+|a\s+)?/i,
    /^necesito\s+(ayuda\s+)?(con\s+|para\s+)?/i,
    /^ocupo\s+(ayuda\s+)?(con\s+|para\s+)?/i,
    
    // "Hola, ..." al inicio
    /^(hola|buenos?\s+(d[ií]as?|tardes?|noches?))[,.]?\s*/i,
  ];
  
  for (const pattern of introPatterns) {
    text = text.replace(pattern, '').trim();
  }
  
  // 4) Eliminar "a front", "a sistemas", "a mantenimiento" sueltos
  text = text.replace(/^a\s+(front|sistemas|mantenimiento|seguridad|ama|hskp|rs|viceroy\s*connect)\s*(que\s+)?/i, '').trim();
  
  // 5) Eliminar "de la habitación" redundante (ya tenemos el lugar)
  text = text.replace(/\s+de\s+(la\s+)?habitaci[oó]n(\s+\d+)?/gi, '');
  text = text.replace(/\s+de\s+adentro\s+de\s+(la\s+)?habitaci[oó]n/gi, '');
  text = text.replace(/\s+en\s+(la\s+)?habitaci[oó]n(\s+\d+)?/gi, '');
  
  // 6) Limpiar artículos/preposiciones al inicio que quedaron huérfanos
  text = text.replace(/^(la|el|las|los|un|una|unos|unas)\s+/i, '').trim();
  text = text.replace(/^(que|de|del|a|al|en)\s+/i, '').trim();
  
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
  if (DEBUG) console.log('[NI] turn.start', { chatId, body: text });
  pushTurn(s, 'user', text);

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
          // Preparar draft temporal
          const tempDraft = {
            id: require('crypto').randomUUID(),
            descripcion: ticket.descripcion,
            descripcion_original: ticket.descripcion_raw,
            lugar: ticket.lugar,
            area_destino: ticket.area,
            areas: [ticket.area],
            status: 'open',
            createdAt: new Date().toISOString()
          };
          
          // Generar folio
          const folio = generateFolio(ticket.area);
          tempDraft.folio = folio;
          folios.push({ folio, area: ticket.area, lugar: ticket.lugar, descripcion: ticket.descripcion });
          
          // Persistir
          try {
            await persistIncident(tempDraft);
            if (DEBUG) console.log('[NI] batch ticket persisted', { folio });
          } catch (e) {
            if (DEBUG) console.warn('[NI] batch persist err', e?.message);
          }
          
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
        if (Array.isArray(v?.tags) && v.tags.length) noteBits.push(`tags:${v.tags.join(',')}`);
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
    const ok = await normalizeAndSetLugar(s, msg, text, { force: false, rawText: text });
    
    if (ok && s.draft.lugar) {
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
      // No se encontró en catálogo → intentar fuzzy match o sugerir
      try {
        const fuzzyResult = await detectPlace(text, { 
          preferRoomsFirst: true,
          allowFuzzy: true,
          fuzzyMinSim: 0.70,
          debugReturn: true 
        });

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
        await normalizeAndSetLugar(s, msg, strongVal, { force: true, rawText: candidateText });

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

  /* 1) Confirmación - acepta sí/no O correcciones de lugar/área */
  const rawUser = (text || '').trim();
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
    
    // Si el ticket está completo y el usuario dice sí → enviar
    if (hasRequiredDraft(s.draft) && isYes(rawUser)) {
      await finalizeAndDispatch({ client, msg, session: s });
      return;
    }
    
    // Cancelar
    if (isNo(rawUser)) {
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
    
    let lugarUpdated = false;
    let areaUpdated = false;
    let lugarNotInCatalog = false;
    
    // ✅ Detectar si el usuario quiere CAMBIAR el lugar
    const strongPlace = findStrongPlaceSignals(rawUser);
    
    // ✅ Detectar si parece una corrección de lugar (aunque no tenga señal fuerte)
    const looksLikePlaceCorrection = /\b(en|es en|perdón en|perdon en|está en|esta en)\s+\w+/i.test(rawUser) ||
                                      /^(front|nido|lobby|casero|cielomar|spa|gym|alberca|piscina|restaurante)/i.test(rawUser.trim());
    
    if (strongPlace) {
      const oldLugar = s.draft.lugar;
      const result = await normalizeAndSetLugar(s, msg, rawUser, { force: true, rawText: rawUser });
      const ok = result && (result.ok || result === true);
      if (ok && s.draft.lugar && s.draft.lugar !== oldLugar) {
        if (oldLugar && s.draft.descripcion) {
          const oldRoomMatch = oldLugar.match(/\d{4}/);
          const newRoomMatch = s.draft.lugar.match(/\d{4}/);
          if (oldRoomMatch && newRoomMatch) {
            s.draft.descripcion = s.draft.descripcion.replace(oldRoomMatch[0], newRoomMatch[0]);
            s.draft.descripcion_original = (s.draft.descripcion_original || '').replace(oldRoomMatch[0], newRoomMatch[0]);
          }
        }
        await refreshIncidentDescription(s, null, s.draft.descripcion_original || s.draft.descripcion);
        lugarUpdated = true;
        if (result && typeof result === 'object' && result.inCatalog === false) {
          lugarNotInCatalog = true;
        }
        if (DEBUG) console.log('[CONFIRM] lugar updated (strong):', s.draft.lugar, { inCatalog: !lugarNotInCatalog });
      }
    } else if (looksLikePlaceCorrection || !s.draft.lugar) {
      // ✅ MEJORADO: Buscar en catálogo aunque ya tenga lugar, si parece corrección
      const oldLugar = s.draft.lugar;
      const result = await normalizeAndSetLugar(s, msg, rawUser, { force: false, rawText: rawUser });
      const ok = result && (result.ok || result === true);
      if (ok && s.draft.lugar && s.draft.lugar !== oldLugar) {
        await refreshIncidentDescription(s, rawUser);
        lugarUpdated = true;
        if (result && typeof result === 'object' && result.inCatalog === false) {
          lugarNotInCatalog = true;
        }
        // ✅ Limpiar bandera de no-catálogo si el nuevo lugar SÍ está en catálogo
        if (result && typeof result === 'object' && result.inCatalog === true) {
          s._lugarNotInCatalog = false;
        }
        if (DEBUG) console.log('[CONFIRM] lugar updated (catalog):', s.draft.lugar, { inCatalog: !lugarNotInCatalog });
      } else if (ok && s.draft.lugar && !oldLugar) {
        await refreshIncidentDescription(s, rawUser);
        lugarUpdated = true;
        if (result && typeof result === 'object' && result.inCatalog === false) {
          lugarNotInCatalog = true;
        }
        if (DEBUG) console.log('[CONFIRM] lugar added:', s.draft.lugar, { inCatalog: !lugarNotInCatalog });
      } else if (!ok && looksLikePlaceCorrection) {
        // ✅ NUEVO: No se encontró en catálogo, pero parece corrección de lugar
        // Intentar buscar candidatos fuzzy para sugerir
        try {
          const fuzzyResult = await detectPlace(rawUser, { 
            preferRoomsFirst: true,
            allowFuzzy: true,
            wantCandidates: true 
          });
          
          if (fuzzyResult?.candidates && fuzzyResult.candidates.length > 0) {
            // Hay candidatos → sugerir
            const top3 = fuzzyResult.candidates.slice(0, 3);
            const suggestions = top3.map((c, i) => `${i + 1}. *${c.label}*`).join('\n');
            
            await replySafe(
              msg,
              `🤔 No encontré exactamente ese lugar.\n\n` +
              `¿Quisiste decir?\n${suggestions}\n\n` +
              `Responde el *número* (1, 2, 3) o escribe otro lugar.`
            );
            s._placeCandidates = top3;
            setMode(s, 'choose_place_from_candidates');
            return;
          } else {
            // ✅ NUEVO: Sin candidatos → extraer el lugar del texto y preguntar si continuar
            const lugarTexto = rawUser.replace(/\b(en|es en|perdón en|perdon en|está en|esta en)\s*/i, '').trim();
            if (lugarTexto && lugarTexto.length >= 3) {
              await replySafe(
                msg,
                `⚠️ "*${lugarTexto}*" no está en el catálogo.\n\n` +
                `¿Quieres usarlo de todos modos? Responde *sí* para aceptar o escribe otro lugar.`
              );
              s._pendingUncatalogedPlace = lugarTexto;
              return;
            }
          }
        } catch (e) {
          if (DEBUG) console.warn('[CONFIRM] fuzzy search err', e?.message || e);
        }
      }
    }
    
    // ✅ FIX: Solo cambiar área si el usuario lo indica EXPLÍCITAMENTE
    // No usar IA para detectar área en correcciones de lugar
    const explicitAreaInText = extractExplicitArea(rawUser);
    
    if (explicitAreaInText && explicitAreaInText !== s.draft.area_destino) {
      // El usuario indicó explícitamente un área diferente
      // ✅ REEMPLAZAR áreas, no agregar (para evitar envío a múltiples grupos)
      setDraftField(s, 'area_destino', explicitAreaInText);
      s.draft.areas = [explicitAreaInText];  // Reemplazar, no agregar
      areaUpdated = true;
      if (DEBUG) console.log('[CONFIRM] area explicitly changed:', explicitAreaInText);
    } else if (!s.draft.area_destino) {
      // Solo si NO tiene área, intentar detectarla
      let newArea = null;
      try { const a = await detectArea(rawUser); newArea = a?.area || null; } catch {}
      if (!newArea) {
        const t = rawUser.toLowerCase();
        if (/(\bit\b|\bsis|siste|sys|tecnolog|ti\b)/.test(t)) newArea = 'it';
        else if (/(mant|manten|man\b)/.test(t)) newArea = 'man';
        else if (/(ama|hskp|housek|limp)/.test(t)) newArea = 'ama';
        else if (/(segur|vigil)/.test(t)) newArea = 'seg';
        else if (/\brs\b|recep|front/.test(t)) newArea = 'rs';
      }
      if (newArea) {
        setDraftField(s, 'area_destino', newArea);
        if (!s.draft.areas?.includes(newArea)) addArea(s, newArea);
        areaUpdated = true;
        if (DEBUG) console.log('[CONFIRM] area added:', newArea);
      }
    }
    
    // Mostrar preview actualizado
    if (lugarUpdated || areaUpdated) {
      let preview = formatPreviewMessage(s.draft);
      
      // ✅ Agregar advertencia si la habitación no está en catálogo
      if (lugarNotInCatalog) {
        preview = `⚠️ *${s.draft.lugar}* no está en el catálogo. Verifica que sea correcto.\n\n` + preview;
      }
      
      await replySafe(msg, preview);
      return;
    }
    
    // Si no se detectó nada, y el ticket está completo, preguntar qué quiere hacer
    if (hasRequiredDraft(s.draft)) {
      await replySafe(msg, 'No entendí. Responde *sí* para enviar, *no* para cancelar, o indica el cambio (ej: "en 1201", "para IT").');
      return;
    }
    
    // Si aún falta algo, mostrar preview con lo que falta
    const preview = formatPreviewMessage(s.draft);
    await replySafe(msg, preview);
    return;
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
    // Dejar que otro handler maneje esto
    return;
  }

  if (DEBUG) console.log('[TURN META]', {
    is_new_incident_candidate: ai.meta?.is_new_incident_candidate,
    is_place_correction_only: ai.meta?.is_place_correction_only,
    hasDraftStructure: !isSessionBareForNI(s),
    differentPlace: isDifferentStrongPlace(text, s.draft)
  });

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
          const ok = await normalizeAndSetLugar(s, msg, val, { rawText: text });
          if (ok) {
            lugarChanged = true;
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
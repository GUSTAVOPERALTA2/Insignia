// modules/router/routeIncomingNI.js
// Orquestador del flujo N-I con:
// - Memoria por chat (niSession)
// - Detección de LUGAR (catálogo + señales fuertes + “relajación”)
// - Detección de ÁREA (texto + hints de visión, con política de prioridad)
// - Integración de visión (niVision) y enriquecimiento de interpretación
// - Confirmación estricta (evita “123”, números sueltos, etc.)
// - Persistencia (SQLite/JSONL)
// - Envío a grupos y reenvío de multimedia al confirmar
// - NEW: Persistencia de adjuntos en disco + registro en DB para dashboard
// - NEW RULE: No se muestra resumen sin antes sugerir/fijar *área destino*
// - NEW GUARD: Evita disparar N-I para saludos / smalltalk / “no es reporte”
// - NEW META: IA puede marcar nuevos incidentes vs correcciones de lugar
// - NEW RESET: comando contextual "reinicio" / "reset" / ...

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

function formatPreview(draft) {
  const dets = Array.isArray(draft._details) ? draft._details : [];
  const detalleLinea = dets.length ? `\n• *Detalle${dets.length>1?'s':''}:* ${dets.join('; ')}` : '';
  return [
    '📝 *Vista previa del ticket*\n',
    `• *Descripción:* ${draft.incidente || draft.descripcion || '—'}${detalleLinea}`,
    `• *Lugar:* ${draft.lugar || '—'}`,
    `• *Área destino:* ${areaLabel(draft.area_destino)} (Áreas: ${areaListLabel(draft.areas)})`,
  ].join('\n');
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

// NEW: considerar si la sesión está “vacía” a efectos de N-I
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
    .replace(/[“”"']/g, '')
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

async function normalizeAndSetLugar(session, msg, candidate, { force = true, rawText = '' } = {}) {
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
        return true;
      }
    } catch (e) {
      if (DEBUG) console.warn('[PLACE] strong.err', e?.message || e);
    }
  }

  const cleaned = sanitizeLugarCandidate(candidate);
  if (DEBUG) console.log('[PLACE] normalize.start', { candidate: cleaned });

  if (cleaned && looksGenericPrincipal(cleaned) && strong) {
    if (DEBUG) console.log('[PLACE] generic.principal + strong.signal → use rawText');
    try {
      const best = await detectPlace(rawText, { preferRoomsFirst: true });
      if (best?.found) {
        if (DEBUG) console.log('[PLACE] normalize.fromRaw', { label: best.label, via: best.via, score: best.score ?? null });
        setDraftField(session, 'lugar', best.label);
        if (best.meta?.building) setDraftField(session, 'building', best.meta.building);
        if (best.meta?.floor)    setDraftField(session, 'floor', best.meta.floor);
        if (best.meta?.room)     setDraftField(session, 'room', best.meta.room);
        return true;
      }
    } catch (e) {
      if (DEBUG) console.warn('[PLACE] detectRaw.err', e?.message || e);
    }
  }

  if (cleaned) {
    try {
      const normPlace = await detectPlace(cleaned, { preferRoomsFirst: true, force });
      if (normPlace?.found) {
        if (DEBUG) console.log('[PLACE] normalize.set', { label: normPlace.label, via: normPlace.via, score: normPlace.score ?? null });
        setDraftField(session, 'lugar', normPlace.label);
        if (normPlace.meta?.building) setDraftField(session, 'building', normPlace.meta.building);
        if (normPlace.meta?.floor)    setDraftField(session, 'floor', normPlace.meta.floor);
        if (normPlace.meta?.room)     setDraftField(session, 'room', normPlace.meta.room);
        return true;
      }
    } catch (e) {
      if (DEBUG) console.warn('[PLACE] normalize.err', e?.message || e);
    }
  }

  if (strong) {
    const fallback = strong.value;
    setDraftField(session, 'lugar', fallback);
    if (DEBUG) console.log('[PLACE] set.fallback.strong', { set: fallback });
    return true;
  }

  if (cleaned) {
    const mRoom = cleaned.match(/\b\d{4}\b/);
    if (mRoom) {
      setDraftField(session, 'lugar', mRoom[0]);
      if (DEBUG) console.log('[PLACE] normalize.fallback.room', { set: mRoom[0] });
      return true;
    }
    setDraftField(session, 'lugar', cleaned);
    if (DEBUG) console.log('[PLACE] normalize.fallback', { set: cleaned });
    return true;
  }

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

function pickAreaCandidate({ explicitArea, textArea, visionHints }) {
  if (explicitArea) return explicitArea;
  if (textArea) return textArea;
  if (Array.isArray(visionHints) && visionHints.length) return visionHints[0];
  return null;
}

async function suggestAreaOrAsk(session, msg, ctx = {}) {
  if (session.draft.area_destino) return { suggested: null, done: true };

  const candidate = pickAreaCandidate(ctx);
  if (candidate) {
    session._suggestedArea = candidate;
    await replySafe(
      msg,
      `🏷️ Sugerencia: esto parece de *${areaLabel(candidate)}*. ¿Lo uso como área destino? Responde **sí** o **no**.`
    );
    setMode(session, 'confirm_area_suggestion');
    pushTurn(session, 'bot', '[suggest_area]');
    if (DEBUG) console.log('[AREA] suggested', candidate);
    return { suggested: candidate, done: false };
  }

  await replySafe(msg, '🏷️ ¿A qué *área* lo envío? (IT, Mantenimiento, HSKP, Room Service o Seguridad).');
  setMode(session, 'ask_area');
  pushTurn(session, 'bot', '[ask_area]');
  if (DEBUG) console.log('[AREA] asked (no candidate)');
  return { suggested: null, done: false };
}

/* ──────────────────────────────
 * DETALLES: helpers
 * ────────────────────────────── */
function normalizeDetail(s='') {
  return String(s)
    .replace(/^[\-\*\•]\s*/,'')
    .replace(/\s+/g,' ')
    .replace(/[.，。]+$/,'')
    .trim();
}
function addDetail(session, detail) {
  const d = normalizeDetail(detail);
  if (!d) return false;
  const arr = Array.isArray(session.draft._details) ? session.draft._details : [];
  if (!arr.some(x => toKey(x) === toKey(d))) arr.push(d);
  session.draft._details = arr;
  session.draft.notes = Array.isArray(session.draft.notes) ? session.draft.notes : [];
  session.draft.notes.push(`[DETALLE] ${d}`);
  return true;
}
function buildDescripcionWithDetails(session, incidentText) {
  const base = incidentText || session.draft.incidente || session.draft.descripcion || '';
  const dets = Array.isArray(session.draft._details) ? session.draft._details : [];
  if (!dets.length) return base || '—';
  const cola = dets.join('; ');
  return base ? `${base}. Detalle${dets.length>1?'s':''}: ${cola}` : `Detalle${dets.length>1?'s':''}: ${cola}`;
}

/* ──────────────────────────────
 * Adjuntos: helpers
 * ────────────────────────────── */
function mimeToExt(m) {
  if (!m) return 'bin';
  const t = m.toLowerCase();
  if (t.includes('jpeg')) return 'jpg';
  if (t.includes('jpg'))  return 'jpg';
  if (t.includes('png'))  return 'png';
  if (t.includes('webp')) return 'webp';
  if (t.includes('gif'))  return 'gif';
  return t.split('/')[1] || 'bin';
}

function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

function persistPendingMediaToDisk(incidentId, pending = []) {
  if (!pending || !pending.length) return [];
  ensureDir(ATTACH_DIR);
  const dir = path.join(ATTACH_DIR, incidentId);
  ensureDir(dir);

  const metas = [];
  for (let i = 0; i < pending.length; i++) {
    const p = pending[i];
    try {
      const ext = mimeToExt(p.mimetype);
      const fname = p.filename
        ? p.filename.replace(/[^\w.\-]+/g, '_')
        : `${Date.now()}_${i}.${ext}`;
      const fpath = path.join(dir, fname);
      const buf = Buffer.from(p.data, 'base64');
      fs.writeFileSync(fpath, buf);
      metas.push({
        id: `${incidentId}-${i}`,
        mimetype: p.mimetype,
        filename: fname,
        url: `${ATTACH_BASEURL}/${incidentId}/${encodeURIComponent(fname)}`,
        size: buf.length
      });
    } catch (e) {
      if (DEBUG) console.warn('[ATTACH] write error', e?.message || e);
    }
  }
  return metas;
}

/* ──────────────────────────────
 * FINALIZAR: persistir + enviar a grupos + multimedia + cerrar
 * ────────────────────────────── */
async function finalizeAndDispatch({ client, msg, session }) {
  const s = session;
  const chatId = msg.from;

  if (!hasRequiredDraft(s.draft)) {
    if (!s.draft.lugar) {
      await replySafe(msg, '📍 Me falta el *lugar* para poder enviarlo. ¿Dónde fue?');
      setMode(s, 'ask_place');
      return { done: false };
    }
    if (!s.draft.area_destino) {
      await suggestAreaOrAsk(s, msg, {
        explicitArea: null,
        textArea: null,
        visionHints: s._visionAreaHints || null
      });
      return { done: false };
    }
  }

  const contact = await msg.getContact().catch(() => null);
  const originName =
    contact?.pushname || contact?.name || contact?.number || msg.from;

  let persisted = null;
  try {
    const meta = { chatId, source: 'whatsapp', originName };
    persisted = persistIncident(s.draft, meta);
    if (DEBUG) console.log('[DB] incident persisted', persisted);
  } catch (e) {
    if (DEBUG) console.warn('[DB] persistIncident.err', e?.message || e);
  }

  const incidentId = persisted?.id || s.draft?.id || String(Date.now());
  const incidentFolio = persisted?.folio || s.draft?.human_id || null;
  const displayId = incidentFolio || incidentId;

  try { recordGroupDispatch(incidentId, [], { requesterChat: chatId, folio: incidentFolio || null }); } catch {}

  let savedMetas = [];
  try {
    if (Array.isArray(s._pendingMedia) && s._pendingMedia.length) {
      savedMetas = persistPendingMediaToDisk(incidentId, s._pendingMedia);
      if (savedMetas.length) {
        try {
          appendIncidentAttachments(incidentId, savedMetas, { alsoEvent: true });
        } catch (e) {
          if (DEBUG) console.warn('[ATTACH] appendIncidentAttachments err', e?.message || e);
        }
        if (DEBUG) console.log('[ATTACH] metas stored', savedMetas.length);
      }
    }
  } catch (e) {
    if (DEBUG) console.warn('[ATTACH] persist metas err', e?.message || e);
  }

  const message = formatIncidentMessage({
    id: displayId,
    folio: incidentFolio,
    descripcion: s.draft.descripcion,
    lugar: s.draft.lugar,
    originName
  });

  let cfg = null;
  try {
    cfg = await loadGroupsConfig();
  } catch (e) {
    if (DEBUG) console.warn('[GROUPS] loadGroupsConfig err', e?.message || e);
    cfg = null;
  }

  const { primaryId, ccIds, unknownAreas } = resolveTargetGroups(
    { area_destino: s.draft.area_destino, areas: s.draft.areas || [] },
    cfg
  );

  if (!primaryId) {
    await replySafe(
      msg,
      `⚠️ No tengo configurado un *grupo* para el área *${s.draft.area_destino || '—'}*.\n` +
      `Pídele a un admin correr: \`/bind ${s.draft.area_destino || 'man'} <groupId>\``
    );
  } else {
    try {
      await sendIncidentToGroups(client, { message, primaryId, ccIds });
    } catch (e) {
      if (DEBUG) console.warn('[GROUPS] sendIncidentToGroups err', e?.message || e);
    }

    try {
      appendDispatchedToGroupsEvent(incidentId, { primaryId, ccIds });
    } catch (e) {
      if (DEBUG) console.warn('[DB] dispatched_to_groups event err', e?.message || e);
    }

    const targets = [primaryId, ...(ccIds || [])].filter(Boolean);

    try {
      recordGroupDispatch(incidentId, targets, { folio: incidentFolio || null, requesterChat: chatId });
    } catch {}

    // Reenviar multimedia
    if (Array.isArray(s._pendingMedia) && s._pendingMedia.length && targets.length) {
      for (const gid of targets) {
        for (const item of s._pendingMedia) {
          try {
            const media = new MessageMedia(item.mimetype, item.data, item.filename || 'evidencia.jpg');
            const caption = item.caption || '';
            await client.sendMessage(gid, media, caption ? { caption } : undefined);
          } catch (e) {
            if (DEBUG) console.warn('[GROUPS] media.send.err', e?.message || e);
          }
        }
      }
    }

    if (unknownAreas?.length) {
      await replySafe(
        msg,
        `⚠️ Aviso: no tengo grupos configurados para las áreas adicionales: ${unknownAreas.map(a => `*${a}*`).join(', ')}.\n` +
        `Pídele a un admin correr: \`/bind <area> <groupId>\``
      );
    }
    if (DEBUG) console.log('[GROUPS] sent to', { primaryId, ccIds, media: (s._pendingMedia || []).length });
  }

  await replySafe(msg, '✅ Incidencia enviada. ¡Gracias!');

  s._pendingMedia = [];
  s._mediaBatch = null;
  s._askedPlaceMuteUntil = 0;
  resetSession(chatId);
  if (DEBUG) console.log('[NI] closed: sent (dispatched)');

  return { done: true, incidentId, folio: incidentFolio || null };
}

/* ──────────────────────────────
 * Mapper modo → focus
 * ────────────────────────────── */
function modeToFocus(mode) {
  switch (mode) {
    case 'ask_place':
      return 'ask_place';
    case 'ask_area':
      return 'ask_area';
    case 'confirm':
      return 'confirm';
    case 'confirm_area_suggestion':
      return 'confirm_area_suggestion';
    case 'preview':
      return 'preview';
    case 'choose_incident_version':
      return 'neutral';
    default:
      return 'neutral';
  }
}

/* ──────────────────────────────
 * Router principal
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

  const { incident } = await deriveIncidentText({
    text: base,
    lugarLabel,
    areaCode,
  });

  session.draft.incidente   = incident;
  session.draft.descripcion = buildDescripcionWithDetails(session, incident);
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

  if (!s.draft.descripcion) s.draft.descripcion = text;
  if (!s.draft.descripcion_original) s.draft.descripcion_original = text;

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

  /* Fast-path: si estábamos preguntando lugar/área... */
  if (s.mode === 'ask_place' && text) {
    const ok = await normalizeAndSetLugar(s, msg, text, { force: true, rawText: text });
    if (ok) {
      await refreshIncidentDescription(s, text);
      await replySafe(msg, `📍 Perfecto, usaré: *${s.draft.lugar}*.`);
      setMode(s, 'neutral');
    } else {
      await replySafe(msg, 'No logré ubicar el lugar. Dame algo como "Habitación 3101", "Lobby", "Pasillo F".');
      return;
    }
  } else if (s.mode === 'ask_area' && text) {
    let area = null;
    try { const a = await detectArea(text); area = a?.area || null; } catch {}
    if (!area) {
      const t = text.toLowerCase();
      if (/(\bit\b|\bsis|siste|sys|tecnolog|ti\b)/.test(t)) area = 'it';
      else if (/(mant|manten)/.test(t)) area = 'man';
      else if (/(ama|hskp|housek|limp)/.test(t)) area = 'ama';
      else if (/(segur|vigil)/.test(t)) area = 'seg';
      else if (/\brs\b|recep|front/.test(t)) area = 'rs';
    }
    if (area) {
      setDraftField(s, 'area_destino', area);
      if (!s.draft.areas?.includes(area)) addArea(s, area);
      await refreshIncidentDescription(s, text);
      await replySafe(msg, `🏷️ Área asignada: *${area.toUpperCase()}*.`);
      setMode(s, 'neutral');
    } else {
      await replySafe(msg, 'No reconocí el área. Dime: IT, Mantenimiento, HSKP (Ama de llaves), Seguridad o RS.');
      return;
    }
  } else if (s.mode === 'confirm_area_suggestion' && text) {
    if (isYes(text)) {
      const chosen = s._suggestedArea;
      if (chosen) {
        setDraftField(s, 'area_destino', chosen);
        if (!s.draft.areas?.includes(chosen)) addArea(s, chosen);
        await refreshIncidentDescription(s, text);
        await replySafe(msg, `🏷️ Perfecto, usaré *${areaLabel(chosen)}* como área destino.`);
      }
      s._suggestedArea = null;
      setMode(s, 'neutral');
    } else if (isNo(text)) {
      s._suggestedArea = null;
      await replySafe(msg, 'Sin problema. ¿Qué *área* debo usar? (IT, Mantenimiento, HSKP, Seguridad o RS).');
      setMode(s, 'ask_area');
      return;
    } else if (isShortAmbiguousNumber(text)) {
      await replySafe(msg, '¿Eso fue un *sí* para usar el área sugerida o prefieres otra? Responde **sí** o **no**.');
      return;
    } else {
      let area = null;
      try { const a = await detectArea(text); area = a?.area || null; } catch {}
      if (!area) {
        const t = text.toLowerCase();
        if (/(\bit\b|\bsis|siste|sys|tecnolog|ti\b)/.test(t)) area = 'it';
        else if (/(mant|manten)/.test(t)) area = 'man';
        else if (/(ama|hskp|housek|limp)/.test(t)) area = 'ama';
        else if (/(segur|vigil)/.test(t)) area = 'seg';
        else if (/\brs\b|recep|front/.test(t)) area = 'rs';
      }
      if (area) {
        setDraftField(s, 'area_destino', area);
        if (!s.draft.areas?.includes(area)) addArea(s, area);
        await refreshIncidentDescription(s, text);
        await replySafe(msg, `🏷️ Entendido, usaré *${areaLabel(area)}*.`);
        setMode(s, 'neutral');
      } else {
        await replySafe(msg, 'No entendí. ¿Confirmas el área sugerida con **sí**, o dime la correcta (IT, Mantenimiento, HSKP, Seguridad o RS).');
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

  /* 1) Confirmación estricta */
  const rawUser = (text || '').trim();
  if (s.mode === 'confirm') {
    if (isYes(rawUser)) {
      await finalizeAndDispatch({ client, msg, session: s });
      return;
    }
    if (isNo(rawUser)) {
      await replySafe(msg, '❌ Incidencia cancelada. Si necesitas algo más, dime.');
      closeSession(s);
      s._pendingMedia = [];
      s._visionAreaHints = null;
      s._mediaBatch = null;
      s._askedPlaceMuteUntil = 0;
      resetSession(chatId);
      if (DEBUG) console.log('[NI] closed: canceled (strict deny)');
      return;
    }
    if (isShortAmbiguousNumber(rawUser)) {
      if (DEBUG) console.log('[CONFIRM] ambiguous input ignored', { rawUser });
      await replySafe(msg, '¿Eso fue un *sí* para enviar o quieres cambiar algo? Responde **sí** o **no** 😉');
      return;
    }
  }

  /* 2) Interpretación de turno */
  const focus = modeToFocus(s.mode);
  const ai = await interpretTurn({ text, focus, draft: s.draft });
  ai.ops = dedupeOps(ai.ops || []);

  const guardRes = classifyNiGuard(text, { aiAnalysis: ai.analysis || '' });
  if (guardRes.shouldBypassNI && isSessionBareForNI(s)) {
    if (DEBUG) console.log('[NI-GUARD] bypass NI', {
      reason: guardRes.reason,
      isGreeting: guardRes.isGreeting,
      aiSmalltalk: guardRes.aiSmalltalk,
    });

    if (guardRes.reason === 'greeting') {
      await replySafe(msg, '👋 ¡Hola! Si necesitas reportar algo (ej. aire, TV, limpieza), dime qué pasa y en dónde, y lo envío al área correspondiente.');
    } else if (guardRes.reason === 'explicit_non_incident') {
      await replySafe(msg, 'Perfecto, tomo tu saludo y quedo al pendiente por si necesitas reportar algo más adelante 🙂');
    }
    return;
  }

  const hasDraftStructure = !isSessionBareForNI(s);
  const differentPlace = isDifferentStrongPlace(text, s.draft);
  const meta = ai.meta || {};
  const aiNewIncident = !!meta.is_new_incident_candidate;
  const aiPlaceCorrection = !!meta.is_place_correction_only;

  if (DEBUG) {
    console.log('[TURN META]', {
      is_new_incident_candidate: aiNewIncident,
      is_place_correction_only: aiPlaceCorrection,
      hasDraftStructure,
      differentPlace
    });
  }

  if (hasDraftStructure && aiPlaceCorrection && differentPlace) {
    if (DEBUG) {
      console.log('[NI] IA marca corrección de lugar. Actualizando lugar en mismo ticket.', {
        prevLugar: s.draft.lugar,
        text
      });
    }

    const newLugarCandidate = getStrongPlaceValue(text) || text;
    await normalizeAndSetLugar(s, msg, newLugarCandidate, { force: true, rawText: text });
    await refreshIncidentDescription(s, text);

    await replySafe(msg, `📍 Entendido, actualizo el lugar del ticket a *${s.draft.lugar}*.`);

    ai.ops = (ai.ops || []).filter(o => o.op === 'show_preview');
  }

  const looksNewIncident =
    aiNewIncident ||
    (!guardRes.shouldBypassNI && guardRes.incidentLikeFlag) ||
    looksStandaloneIncidentText(text);

  if (hasDraftStructure && looksNewIncident && !differentPlace) {
    let newArea = null;
    try {
      const a = await detectArea(text);
      newArea = a?.area || null;
    } catch {}

    if (newArea && s.draft.area_destino && newArea !== s.draft.area_destino) {
      if (DEBUG) {
        console.log('[NI] candidate new incident (same place, different area) → ask user', {
          prevDraft: {
            descripcion: s.draft.descripcion,
            lugar: s.draft.lugar,
            area_destino: s.draft.area_destino,
          },
          newArea,
          text,
          fromMeta: aiNewIncident
        });
      }

      s._candidateIncidentText = text;
      const lugar        = s.draft.lugar || 'la misma habitación';
      const oldAreaLabel = areaLabel(s.draft.area_destino);
      const newAreaLabel = areaLabel(newArea);

      await replySafe(
        msg,
        '🆕 Ya tengo un ticket en esa misma habitación, pero este mensaje parece de *otra área*.\n' +
        `• Ticket actual: *${lugar}* / *${oldAreaLabel}*\n` +
        `• Nuevo mensaje: "${text}" → *${newAreaLabel}*\n\n` +
        '¿Con cuál quieres quedarte?\n' +
        '👉 Escribe *primero* para conservar el ticket actual.\n' +
        '👉 Escribe *segundo* para descartar el anterior y usar solo el nuevo.'
      );

      setMode(s, 'choose_incident_version');
      pushTurn(s, 'bot', '[choose_incident_version]');
      return;
    }
  }

  if (hasDraftStructure && looksNewIncident && differentPlace) {
    if (DEBUG) {
      console.log('[NI] candidate new incident detected while draft exists (other place, IA/heuristics)', {
        prevDraft: {
          descripcion: s.draft.descripcion,
          lugar: s.draft.lugar,
          area_destino: s.draft.area_destino,
        },
        text,
        fromMeta: aiNewIncident
      });
    }

    s._candidateIncidentText = text;
    const oldLugar = s.draft.lugar || 'un lugar anterior';
    const newLugar = getStrongPlaceValue(text) || 'otro lugar';

    await replySafe(
      msg,
      '🆕 Detecté que ya teníamos un ticket en borrador y este mensaje parece otro reporte en un lugar distinto.\n' +
      `• Ticket actual: *${oldLugar}*\n` +
      `• Nuevo mensaje: *${newLugar}*\n\n` +
      '¿Con cuál quieres quedarte?\n' +
      '👉 Escribe *primero* para conservar el ticket actual.\n' +
      '👉 Escribe *segundo* para descartar el anterior y usar solo el nuevo.'
    );
    setMode(s, 'choose_incident_version');
    pushTurn(s, 'bot', '[choose_incident_version]');
    return;
  }

  if (ai.ops.some(o => o.op === 'confirm') && !isYes(rawUser)) {
    ai.ops = ai.ops.filter(o => o.op !== 'confirm');
  }
  if (ai.ops.some(o => o.op === 'cancel') && !isNo(rawUser)) {
    ai.ops = ai.ops.filter(o => o.op !== 'cancel');
  }

  pushTurn(s, 'ai', JSON.stringify(ai));
  if (DEBUG) {
    console.log('[OPS] turn.out', ai);
    if (ai.analysis) console.log('[OPS] analysis:', ai.analysis);
  }

  /* 3) Aplicar ops */
  let lugarChanged = false;
  let areaChanged  = false;
  let explicitArea = null;

  for (const op of ai.ops) {
    switch (op.op) {
      case 'set_field': {
        if (op.field === 'lugar' && op.value) {
          lugarChanged = true;
          await normalizeAndSetLugar(s, msg, op.value, { force: true, rawText: text });
          await refreshIncidentDescription(s, text);
        } else if (op.field === 'area_destino' && op.value) {
          explicitArea = op.value;
          setDraftField(s, 'area_destino', op.value);
          areaChanged = true;
          if (!s.draft.areas?.includes(op.value)) addArea(s, op.value);
          await refreshIncidentDescription(s, text);
          if (DEBUG) console.log('[AREA] set.by-op', { area_destino: s.draft.area_destino, areas: s.draft.areas });
        }
        break;
      }
      case 'replace_areas': {
        if (Array.isArray(op.values) && op.values.length) {
          replaceAreas(s, op.values);
          setDraftField(s, 'area_destino', op.values[0] || null);
          areaChanged = true;
          explicitArea = s.draft.area_destino;
          await refreshIncidentDescription(s, text);
          if (DEBUG) console.log('[AREA] replace.by-op', { area_destino: s.draft.area_destino, areas: s.draft.areas });
        }
        break;
      }
      case 'add_area': {
        if (op.value) {
          addArea(s, op.value);
          if (!s.draft.area_destino) setDraftField(s, 'area_destino', op.value);
          areaChanged = true;
          await refreshIncidentDescription(s, text);
          if (DEBUG) console.log('[AREA] add.by-op', { area_destino: s.draft.area_destino, areas: s.draft.areas });
        }
        break;
      }
      case 'remove_area': {
        if (op.value) {
          removeArea(s, op.value);
          areaChanged = true;
          await refreshIncidentDescription(s, text);
          if (DEBUG) console.log('[AREA] remove.by-op', { area_destino: s.draft.area_destino, areas: s.draft.areas });
        }
        break;
      }
      case 'show_preview': {
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
            'Ejemplos: “hab 1311”, “en Front Desk”, “Pasillo F”.'
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
                'Ejemplos: “hab 1311”, “en Front Desk”, “Casero”, “Villa 12”.'
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
        await refreshIncidentDescription(s, text);
        if (DEBUG) console.log('[PLACE] auto.detect', { label: auto.label, via: auto.via, score: auto.score ?? null });
      } else if (auto?.candidates?.length) {
        const top = auto.candidates[0];
        const second = auto.candidates[1];
        const keyUser = toKey(text);
        const keyTop  = toKey(top.label);
        const topScore = typeof top.score === 'number' ? top.score : parseFloat(top.score || '0');
        const secondScore = second ? (typeof second.score === 'number' ? second.score : parseFloat(second.score || '0')) : 0;

        if (keyTop === keyUser || (topScore >= RELAX_SCORE_MIN && (auto.candidates.length === 1 || (topScore - secondScore) >= RELAX_MARGIN))) {
          setDraftField(s, 'lugar', top.label);
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
  if (explicitArea) {
    applyAreaPriority(s, { explicitArea, textArea, visionHints });
  }

  /* 6) Log estado */
  if (DEBUG) {
    console.log('[NI] draft.after', {
      descripcion: s.draft.descripcion,
      interpretacion: s.draft.interpretacion,
      lugar: s.draft.lugar,
      area_destino: s.draft.area_destino,
      areas: s.draft.areas,
      mode: s.mode,
      focus: s.focus,
    });
  }

  /* 7) Siguiente paso */
  if (s.draft.lugar && !s.draft.area_destino) {
    const { done } = await suggestAreaOrAsk(s, msg, {
      explicitArea,
      textArea,
      visionHints
    });
    if (!done) return;
  }

  if (hasRequiredDraft(s.draft)) {
    const preview = formatPreview(s.draft);
    await replySafe(msg, preview + '\n\n¿Lo envío? Responde "sí" o "no".');
    setMode(s, 'confirm');
    pushTurn(s, 'bot', '[preview]');
    if (DEBUG) console.log('[PREVIEW] sent');
    return;
  }

  const needsLugar = !s.draft.lugar;
  const needsArea  = !s.draft.area_destino;

  if (needsLugar) {
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
      'Ejemplos: “hab 1311”, “en Front Desk”, “Casero”, “Villa 12”.'
    );
    s._askedPlaceAt = now;
    s._askedPlaceMuteUntil = now + ASK_PLACE_COOLDOWN_MS;
    setMode(s, 'ask_place');
    pushTurn(s, 'bot', '[ask_place]');
    if (DEBUG) console.log('[NI] ask_place (gated)');
    return;
  }

  if (needsArea) {
    const { done } = await suggestAreaOrAsk(s, msg, {
      explicitArea,
      textArea,
      visionHints
    });
    if (!done) return;
  }

  await replySafe(
    msg,
    '¿Quieres ver un *resumen* antes de enviar? (Se mostrará en cuanto confirmemos el área). También puedes indicarme cambios (ej. “en Cielomar”, “solo IT”).'
  );
  setMode(s, 'neutral');
  pushTurn(s, 'bot', '[neutral_hint]');
  if (DEBUG) console.log('[NI] neutral');
}

module.exports = { handleTurn };

// modules/state/niSession.js
// Memoria por chat para el flujo N-I

const TTL_MS = Number(process.env.VICEBOT_NI_TTL_MS || 15 * 60 * 1000); // 15 min por defecto
const sessions = new Map(); // chatId -> NISession

function now() { return Date.now(); }

function newDraft() {
  return {
    descripcion: null,
    interpretacion: null,
    lugar: null,
    area_destino: null,
    areas: [],
    priority: null,
    severity: null,
    due_at: null,
    building: null,
    floor: null,
    room: null,
    tags: [],
    notes: [],
    lastAsk: null,
  };
}

function newSession(chatId) {
  return {
    chatId,
    draft: newDraft(),
    mode: 'neutral',      // 'neutral' | 'ask_place' | 'ask_area' | 'preview' | 'confirm'
    focus: 'neutral',     // mismo set que mode (alias sintético para interpretTurn)
    createdAt: now(),
    updatedAt: now(),
    history: [],          // { role:'user'|'bot'|'ai', text, at, meta? }
    closed: false,        // true cuando se envía o cancela

    // NEW: flags para controlar preguntas y preview
    flags: {
      asked_place: false,
      asked_area: false,
      preview_shown: false,
    },
  };
}

function getSession(chatId) {
  const s = sessions.get(chatId);
  if (!s) return null;
  // TTL
  if (now() - s.updatedAt > TTL_MS) {
    sessions.delete(chatId);
    return null;
  }
  return s;
}

// NEW: helper pensado para el coreMessageRouter / coreIntentRouter
// Usa el mismo mapa + TTL que getSession.
function getSessionForChat(chatId) {
  if (!chatId) return null;
  return getSession(chatId);
}

function ensureSession(chatId) {
  let s = getSession(chatId);
  if (!s) {
    s = newSession(chatId);
    sessions.set(chatId, s);
  }
  // Hardening: por si existen sesiones viejas sin flags
  if (!s.flags) {
    s.flags = {
      asked_place: false,
      asked_area: false,
      preview_shown: false,
    };
  }
  return s;
}

function touch(s) {
  s.updatedAt = now();
}

function resetSession(chatId) {
  sessions.delete(chatId);
}

function pushTurn(s, role, text, meta = null) {
  s.history.push({ role, text, at: now(), meta });
  if (s.history.length > 100) s.history.shift(); // recorte simple
  touch(s);
}

function setMode(s, mode) {
  s.mode = mode;
  s.focus = mode;  // lo usamos directo en interpretTurn
  touch(s);
}

function setDraftField(s, field, value) {
  s.draft[field] = value;
  touch(s);
}

function addDraftNote(s, note) {
  s.draft.notes.push(note);
  touch(s);
}

function replaceAreas(s, values) {
  s.draft.areas = Array.from(new Set(values || []));
  // si área_destino está vacío pero hay lista, proponer el primero
  if (!s.draft.area_destino && s.draft.areas.length) {
    s.draft.area_destino = s.draft.areas[0];
  }
  touch(s);
}

function addArea(s, a) {
  const set = new Set(s.draft.areas);
  set.add(a);
  s.draft.areas = Array.from(set);
  if (!s.draft.area_destino) s.draft.area_destino = a;
  touch(s);
}

function removeArea(s, a) {
  s.draft.areas = (s.draft.areas || []).filter(x => x !== a);
  if (s.draft.area_destino === a) s.draft.area_destino = s.draft.areas[0] || null;
  touch(s);
}

/**
 * ¿La descripción ya tiene “cuerpo” suficiente como para
 * que valga la pena pedir el lugar?
 */
function hasGoodDescription(draft = {}) {
  const d = (draft.descripcion || draft.interpretacion || '').trim();
  if (!d) return false;
  if (d.length < 20) return false;

  // Señales típicas de falla
  if (/(no funciona|no enciende|no prende|falla|fallo|aver[ií]a|no hay|fuga|gotea|gotera|sin luz|sin agua)/i.test(d)) {
    return true;
  }

  // Si es suficientemente larga, la consideramos usable
  return d.length >= 40;
}

/**
 * ¿Tenemos algún área asignada ya sea area_destino o en la lista de áreas?
 */
function hasAreaAssigned(draft = {}) {
  if (draft.area_destino) return true;
  if (Array.isArray(draft.areas) && draft.areas.length > 0) return true;
  return false;
}

/**
 * Regla para preguntar LUGAR temprano:
 * - No hay lugar aún.
 * - Ya tenemos área (destino o lista).
 * - Y la descripción ya tiene “cuerpo”.
 */
function shouldAskPlaceEarly(draft = {}) {
  if (draft.lugar && String(draft.lugar).trim()) return false;
  if (!hasAreaAssigned(draft)) return false;
  if (!hasGoodDescription(draft)) return false;
  return true;
}

/**
 * Versión basada en sesión para que el router pueda usarla directo.
 */
function shouldAskPlaceEarlyForSession(s) {
  if (!s || !s.draft) return false;
  return shouldAskPlaceEarly(s.draft);
}

function isReadyForPreview(s) {
  const d = s.draft;
  return Boolean(d.descripcion) && Boolean(d.lugar) && Boolean(d.area_destino);
}

function closeSession(s) {
  s.closed = true;
  touch(s);
}

module.exports = {
  ensureSession,
  getSession,
  getSessionForChat,       // ← NEW export para el core
  resetSession,
  pushTurn,
  setMode,
  setDraftField,
  replaceAreas,
  addArea,
  removeArea,
  isReadyForPreview,
  closeSession,
  touch,                   // ← NEW: para mantener sesión viva sin cambiar modo

  // NEW: helpers para el router N-I
  hasGoodDescription,
  hasAreaAssigned,
  shouldAskPlaceEarly,
  shouldAskPlaceEarlyForSession,
};
// modules/router/routeRequesterReply.js
// DM del solicitante: registra comentarios/acuse SOLO si podemos vincular con confianza
// y el texto NO parece una nueva N-I.
// Ahora usa coreFeedbackEngine para:
//  - clasificar el mensaje (feedback vs noise vs reopen/cancel/etc.)
//  - decidir el siguiente estado del ticket (next_status)

const FOLIO_RE = /\b[A-Z]{2,8}-\d{3,6}\b/;
const DEBUG = (process.env.VICEBOT_DEBUG || '1') === '1';

const TTL_MIN = parseInt(process.env.VICEBOT_REQ_REPLY_TTL_MIN || '30', 10);
const REQUIRE_QUOTE = (process.env.VICEBOT_REQ_REQUIRE_QUOTE || '0') === '1';
const MAX_FEEDBACK_CHARS = parseInt(process.env.VICEBOT_REQ_MAX_FEEDBACK_CHARS || '180', 10);

const MIN_CONF = parseFloat(process.env.VICEBOT_INTENT_CONFIDENCE_MIN || '0.50');

const DEFAULT_TZ = process.env.VICEBOT_TZ || 'America/Mexico_City';

// ✅ SAFE REPLY (absorbe "Session closed" sin matar proceso)
let safeReply = null;
try {
  ({ safeReply } = require('../utils/safeReply'));
} catch (e) {
  safeReply = null;
  if (DEBUG) console.warn('[REQ-FB] safeReply missing:', e?.message || e);
}
async function replySafe(msg, text) {
  if (!text) return false;
  try {
    if (safeReply) return await safeReply(msg, text);
    await msg.reply(text);
    return true;
  } catch (e) {
    if (DEBUG) console.warn('[REQ-FB] replySafe err', e?.message || e);
    return false;
  }
}

// Palabras que suelen ser acuses/retro breve del solicitante (tuneables por ENV)
function envList(name, defCsv) {
  return String(process.env[name] || defCsv || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

const ACK_WORDS = new Set(
  envList(
    'VICEBOT_REQ_ACK_WORDS',
    'gracias,ok,okay,va,va.,listo,ya quedo,ya quedó,ya esta,ya está,entendido,enterado,recibido,en proceso,en camino,vamos,vamos para alla,vamos para allá,de nada,cancelen'
  )
);

const NI_WORDS = new Set(
  envList(
    'VICEBOT_REQ_NI_WORDS',
    'no sirve,fuga,revisen,revisar,rompio,rompió,no enciende,no hay,se descompuso,necesito ayuda,ayuda mantenimiento,ayuda sistemas,ayuda limpieza,está fallando,esta fallando'
  )
);

// --- Heurística extra: detectar preguntas de ESTATUS del ticket ---
const STATUS_QUERY_PATTERNS = [
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

function normalizeForMatch(text = '') {
  return String(text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

function looksLikeStatusQuery(text = '') {
  const norm = normalizeForMatch(text);
  if (!norm) return false;
  return STATUS_QUERY_PATTERNS.some((p) => norm.includes(normalizeForMatch(p)));
}

// --- DB (carga perezosa) ---
function getDB() {
  try {
    return require('../db/incidenceDB');
  } catch {
    return {};
  }
}
const incidenceDB = getDB();

async function appendEvent(incidentId, evt) {
  if (typeof incidenceDB.appendIncidentEvent === 'function') {
    return incidenceDB.appendIncidentEvent(incidentId, evt);
  }
  if (typeof incidenceDB.appendEvent === 'function') return incidenceDB.appendEvent(incidentId, evt);
  return null;
}

async function getIncidentFull(incidentId) {
  if (typeof incidenceDB.getIncidentById === 'function') {
    try {
      if (DEBUG) console.log('[REQ-FB] getIncidentFull', { incidentId });
      return await incidenceDB.getIncidentById(incidentId);
    } catch (e) {
      if (DEBUG) console.warn('[REQ-FB] getIncidentById err', e?.message || e);
    }
  }
  // Fallback mínimo
  return {
    id: incidentId,
    folio: null,
    area_destino: null,
    areas: [],
    descripcion: null,
    interpretacion: null,
    lugar: null,
    status: null,
    created_at: null,
    updated_at: null,
    attachments: [],
    origin_name: null,
    events: [],
    meta: {},
  };
}

async function updateStatus(incidentId, status) {
  if (!incidentId || !status) return null;
  const candidates = ['updateIncidentStatus', 'setIncidentStatus', 'updateStatus'];
  for (const fn of candidates) {
    if (typeof incidenceDB[fn] === 'function') {
      try {
        if (DEBUG) console.log('[REQ-FB] updateStatus', { incidentId, status, fn });
        return await incidenceDB[fn](incidentId, status);
      } catch (e) {
        if (DEBUG) console.warn('[REQ-FB] status update err', fn, e?.message || e);
      }
    }
  }
  return null;
}

// Fallback: ticket "activo" más reciente del solicitante (open/in_progress/awaiting_confirmation)
async function findMostRelevantIncidentForStatusQuery(chatId) {
  if (!chatId) return null;
  if (typeof incidenceDB.listIncidentsForChat !== 'function') return null;

  try {
    const incidents = await incidenceDB.listIncidentsForChat(chatId, {
      statusFilter: ['open', 'in_progress', 'awaiting_confirmation'],
      limit: 5,
    });

    if (DEBUG) {
      console.log('[REQ-FB] findMostRelevantIncidentForStatusQuery', {
        chatId,
        count: incidents ? incidents.length : 0,
      });
    }

    if (!incidents || !incidents.length) return null;

    if (incidents.length === 1) return incidents[0].id;

    if (incidents.length <= 3) return incidents[0].id;

    // demasiados → no adivinar
    return null;
  } catch (e) {
    if (DEBUG) console.warn('[REQ-FB] statusQuery findMostRelevantIncident err', e?.message || e);
    return null;
  }
}

// Fallback: ticket abierto más reciente del solicitante (legacy, sigue disponible)
async function findMostRecentOpenIncidentForChat(chatId) {
  if (typeof incidenceDB.findCandidateOpenIncident === 'function') {
    try {
      const cand = await incidenceDB.findCandidateOpenIncident({
        chatId,
        placeLabelOrRoom: null,
        activeWindowMins: 90,
      });
      if (DEBUG) console.log('[REQ-FB] findMostRecentOpenIncidentForChat', { chatId, type: cand?.type });
      if (cand && cand.incident && cand.type) return cand.incident.id;
    } catch (e) {
      if (DEBUG) console.warn('[REQ-FB] findMostRecentOpenIncident err', e?.message || e);
    }
  }
  return null;
}

// Enviar al/los grupos (formato centralizado en groupRouter)
const { sendFollowUpToGroups } = require('../groups/groupRouter');

// CORE de feedback unificado
const { runFeedbackEngine } = require('../ai/coreFeedbackEngine');

// Cache REQ-CTX (chatId → { incidentId, ts })
const REQ_CTX = new Map();

// Contexto de menú de estatus (chatId → { incidentIds:[], ts })
const STATUS_MENU_CTX = new Map();
const STATUS_MENU_TTL_MIN = parseInt(process.env.VICEBOT_STATUS_MENU_TTL_MIN || '15', 10);

const { v4: uuidv4 } = require('uuid');

// API: marcar al último ticket al que se notificó a este solicitante (DM)
function noteRequesterNotify(chatId, incidentId) {
  if (!chatId || !incidentId) return;
  REQ_CTX.set(chatId, { incidentId, ts: Date.now() });
  if (DEBUG) console.log('[REQ-CTX] set', { chatId, incidentId });
}

function getRecentIncidentForChat(chatId) {
  const rec = REQ_CTX.get(chatId);
  if (!rec) return null;
  const ageMin = (Date.now() - rec.ts) / 60000;
  if (ageMin > TTL_MIN) {
    REQ_CTX.delete(chatId);
    return null;
  }
  return rec.incidentId;
}

// --- Helpers menú ---

function rememberStatusMenu(chatId, incidentIds) {
  if (!chatId || !incidentIds || !incidentIds.length) return;
  STATUS_MENU_CTX.set(chatId, { incidentIds, ts: Date.now() });
  if (DEBUG) console.log('[STATUS-MENU] set', { chatId, count: incidentIds.length });
}

function getStatusMenuForChat(chatId) {
  const rec = STATUS_MENU_CTX.get(chatId);
  if (!rec) return null;
  const ageMin = (Date.now() - rec.ts) / 60000;
  if (ageMin > STATUS_MENU_TTL_MIN) {
    STATUS_MENU_CTX.delete(chatId);
    return null;
  }
  return rec;
}

function clearStatusMenu(chatId) {
  STATUS_MENU_CTX.delete(chatId);
}

function looksLikeNumericChoice(text = '') {
  return /^\s*[1-9]\d*\s*$/.test(String(text || ''));
}

function isDM(msg) {
  const id = msg.from || '';
  return !/@g\.us$/.test(id);
}

function looksLikeAck(text = '') {
  if (looksLikeStatusQuery(text)) return false;
  const s = String(text || '').toLowerCase().trim();
  if (!s) return false;
  if (s.length <= 3) return true;
  for (const w of ACK_WORDS) {
    if (w && s.includes(w)) return true;
  }
  return false;
}

function looksLikeNI(text = '') {
  const s = String(text || '').toLowerCase();
  for (const w of NI_WORDS) {
    if (w && s.includes(w)) return true;
  }
  if (s.length > MAX_FEEDBACK_CHARS) return true;
  return false;
}

function isBareYesNo(text = '') {
  return /^\s*(s[ií]|no)\s*$/i.test(String(text || ''));
}

// Formateo fechas
function formatDateTime(isoString) {
  if (!isoString) return '—';
  const d = new Date(isoString);
  if (Number.isNaN(d.getTime())) return isoString;
  return d.toLocaleString('es-MX', {
    timeZone: DEFAULT_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

// Resumen de estado para el solicitante
function formatStatusSummaryForRequester(incident) {
  if (!incident) {
    return 'No pude encontrar el ticket asociado. Si puedes, responde citando el mensaje del folio.';
  }

  const st = (incident.status || 'open').toLowerCase();
  let stEmoji = '🟡';
  let stLabel = 'Abierto';
  if (st === 'open') {
    stEmoji = '🟡';
    stLabel = 'Abierto';
  } else if (st === 'in_progress') {
    stEmoji = '🟠';
    stLabel = 'En progreso';
  } else if (st === 'awaiting_confirmation') {
    stEmoji = '🟠';
    stLabel = 'En espera de tu confirmación';
  } else if (st === 'done' || st === 'closed') {
    stEmoji = '🟢';
    stLabel = 'Terminado';
  } else if (st === 'canceled') {
    stEmoji = '⚫️';
    stLabel = 'Cancelado';
  }

  const folio = incident.folio || '(sin folio)';
  const lugar = incident.lugar || 'Sin lugar asignado';
  const area = incident.area_destino || 'Sin área destino';

  const createdStr = formatDateTime(incident.created_at);
  const updatedStr = incident.updated_at ? formatDateTime(incident.updated_at) : null;

  const lines = [];
  lines.push(`Estado actual de tu ticket *${folio}* ${stEmoji} _${stLabel}_`);
  lines.push('');
  lines.push(`📍 *Lugar:* ${lugar}`);
  lines.push(`🛠 *Área destino:* ${area}`);
  lines.push(`🕒 *Creado:* ${createdStr}`);
  if (incident.updated_at) lines.push(`♻️ *Última actualización:* ${updatedStr}`);
  lines.push('');
  lines.push('Si quieres ver más detalles y adjuntos, puedes usar:');
  lines.push(`\`/tickets detalle ${folio}\``);

  return lines.join('\n');
}

async function findIncidentByQuotedFolio(msg) {
  try {
    if (!msg.hasQuotedMsg) return null;
    const quoted = await msg.getQuotedMessage();
    const m = String(quoted?.body || '').toUpperCase().match(FOLIO_RE);
    if (!m) return null;
    const folio = m[0];
    if (typeof incidenceDB.getIncidentByFolio === 'function') {
      const inc = await incidenceDB.getIncidentByFolio(folio);
      return inc?.id || null;
    }
  } catch (e) {
    if (DEBUG) console.warn('[REQ-FB] findIncidentByQuotedFolio err', e?.message || e);
  }
  return null;
}

async function findIncidentByFolioInBody(body) {
  const m = String(body || '').toUpperCase().match(FOLIO_RE);
  if (!m) return null;
  const folio = m[0];
  if (typeof incidenceDB.getIncidentByFolio === 'function') {
    try {
      const inc = await incidenceDB.getIncidentByFolio(folio);
      return inc?.id || null;
    } catch (e) {
      if (DEBUG) console.warn('[REQ-FB] findIncidentByFolioInBody err', e?.message || e);
    }
  }
  return null;
}

// Menú de selección de ticket cuando el usuario hace una pregunta de estatus
async function maybeHandleStatusMenu(client, msg, chatId) {
  if (typeof incidenceDB.listIncidentsForChat !== 'function') {
    if (DEBUG) console.log('[STATUS-MENU] listIncidentsForChat no disponible');
    return { handled: false, incidentId: null };
  }

  let incidents;
  try {
    incidents = await incidenceDB.listIncidentsForChat(chatId, {
      statusFilter: ['open', 'in_progress', 'awaiting_confirmation'],
      limit: 5,
    });
    if (DEBUG) {
      console.log('[STATUS-MENU] listIncidentsForChat OK', {
        chatId,
        count: incidents ? incidents.length : 0,
      });
    }
  } catch (e) {
    if (DEBUG) console.warn('[STATUS-MENU] listIncidentsForChat err', e?.message || e);
    return { handled: false, incidentId: null };
  }

  if (!incidents || incidents.length === 0) {
    await replySafe(
      msg,
      'Por el momento no encuentro tickets activos asociados a este número. Si crees que falta alguno, por favor envíame el folio o levanta un nuevo reporte.'
    );
    return { handled: true, incidentId: null };
  }

  if (incidents.length === 1) {
    if (DEBUG) console.log('[STATUS-MENU] único ticket activo, sin menú', { chatId, incidentId: incidents[0].id });
    return { handled: false, incidentId: incidents[0].id };
  }

  const lines = [];
  lines.push('Tienes varios tickets activos, ¿de cuál quieres saber el estado?');
  lines.push('');

  incidents.forEach((inc, idx) => {
    const num = idx + 1;
    const folio = inc.folio || '(sin folio)';
    const lugar = inc.lugar || 'Sin lugar asignado';
    const st = (inc.status || 'open').toLowerCase();

    let stEmoji = '🟡';
    let stLabel = 'Abierto';
    if (st === 'open') {
      stEmoji = '🟡';
      stLabel = 'Abierto';
    } else if (st === 'in_progress') {
      stEmoji = '🟠';
      stLabel = 'En progreso';
    } else if (st === 'awaiting_confirmation') {
      stEmoji = '🟠';
      stLabel = 'En espera de tu confirmación';
    } else if (st === 'done' || st === 'closed') {
      stEmoji = '🟢';
      stLabel = 'Terminado';
    } else if (st === 'canceled') {
      stEmoji = '⚫️';
      stLabel = 'Cancelado';
    }

    lines.push(`${num}) *${folio}* ${stEmoji} _${stLabel}_`);
    lines.push(`   📍 ${lugar}`);
  });

  lines.push('');
  lines.push('Responde con el *número* del ticket (por ejemplo: "1" o "2").');
  lines.push('Si prefieres, también puedes decirme el folio directamente (por ejemplo: "estatus HSKP-00003").');

  await replySafe(msg, lines.join('\n'));
  rememberStatusMenu(chatId, incidents.map((i) => i.id));

  return { handled: true, incidentId: null };
}

async function maybeHandleRequesterReply(client, msg) {
  if (!msg || msg.fromMe) return false;
  if (!isDM(msg)) return false;

  // ✅ Anti-doble-ejecución local (si el core por cualquier razón re-invoca)
  if (msg.__reqReplyHandled === true) return true;
  msg.__reqReplyHandled = true;

  const body = String(msg.body || '').trim();
  if (!body) return false;

  const chatId = msg.from;

  // Intent/flags si coreMessageRouter los inyectó
  const intentFlags = msg._intentFlags || {};
  const isStatusQueryFromIntent = !!intentFlags.isStatusQuery;

  if (DEBUG) {
    console.log('[REQ-FB] maybeHandleRequesterReply IN', {
      chatId,
      body,
      isStatusQueryFromIntent,
    });
  }

  // --- 0) ¿Está respondiendo a un MENÚ con un número? ---
  let incidentId = null;
  let selectedFromStatusMenu = false;
  const menuCtx = getStatusMenuForChat(chatId);

  if (DEBUG) {
    console.log('[REQ-FB] menuCtx', {
      hasMenu: !!menuCtx,
      menuSize: menuCtx?.incidentIds?.length || 0,
    });
  }

  if (menuCtx && looksLikeNumericChoice(body)) {
    const idx = parseInt(body, 10) - 1;
    const chosenId = menuCtx.incidentIds[idx];

    if (!chosenId) {
      await replySafe(msg, 'No reconocí ese número. Responde con uno de los números de la lista o dime el folio del ticket.');
      return true;
    }

    if (DEBUG) {
      console.log('[STATUS-MENU] elección numérica', {
        chatId,
        choice: body,
        incidentId: chosenId,
      });
    }

    clearStatusMenu(chatId);
    incidentId = chosenId;
    selectedFromStatusMenu = true;
  }

  const heuristicStatusQuery = isStatusQueryFromIntent || looksLikeStatusQuery(body);
  const isAck = looksLikeAck(body);

  if (DEBUG) {
    console.log('[REQ-FB] flags post-basic', {
      heuristicStatusQuery,
      isAck,
      selectedFromStatusMenu,
      incidentIdInitial: incidentId,
    });
  }

  // Evitar chocar con N-I
  if (isBareYesNo(body) && !msg.hasQuotedMsg && !FOLIO_RE.test(body)) {
    if (DEBUG) console.log('[REQ-FB] bare yes/no sin contexto → dejar pasar a N-I');
    return false;
  }

  if (looksLikeNI(body)) {
    if (DEBUG) console.log('[REQ-FB] looksLikeNI → dejar pasar al flujo N-I');
    return false;
  }

  // 1) quoted folio (si aún no tenemos incidentId por menú)
  if (!incidentId) {
    incidentId = await findIncidentByQuotedFolio(msg);
    if (DEBUG && incidentId) console.log('[REQ-FB] incidentId por quoted folio', { incidentId });
  }

  // REQUIRE_QUOTE NO aplica a statusQuery
  if (REQUIRE_QUOTE && !incidentId && !heuristicStatusQuery && !selectedFromStatusMenu) {
    if (DEBUG) console.log('[REQ-FB] REQUIRE_QUOTE activo y sin incidentId → abort DM feedback');
    return false;
  }

  // 2) folio en el texto
  if (!incidentId) {
    incidentId = await findIncidentByFolioInBody(body);
    if (DEBUG && incidentId) console.log('[REQ-FB] incidentId por folio en body', { incidentId });
  }

  // 3) REQ_CTX para acuses (no status queries)
  if (!incidentId && isAck && !heuristicStatusQuery && !selectedFromStatusMenu) {
    incidentId = getRecentIncidentForChat(chatId);
    if (DEBUG && incidentId) console.log('[REQ-FB] incidentId por REQ_CTX (acuse corto)', { incidentId });
  }

  // 3.bis) status query sin incidentId → menú UX
  if (!incidentId && heuristicStatusQuery && !isAck && !selectedFromStatusMenu) {
    if (DEBUG) console.log('[REQ-FB] statusQuery → evaluando menú de selección', { chatId, isAck, body });

    const menuRes = await maybeHandleStatusMenu(client, msg, chatId);
    if (menuRes.incidentId) {
      incidentId = menuRes.incidentId;
      if (DEBUG) console.log('[REQ-FB] incidentId recibido directamente de menú', { incidentId });
    }
    if (menuRes.handled && !incidentId) {
      if (DEBUG) console.log('[REQ-FB] menú manejado, sin incidentId → fin');
      return true;
    }
  }

  // 4) Fallback a “ticket activo más reciente” SOLO para acuses
  if (!incidentId && isAck && !heuristicStatusQuery && !selectedFromStatusMenu) {
    incidentId = await findMostRelevantIncidentForStatusQuery(chatId);
    if (!incidentId) incidentId = await findMostRecentOpenIncidentForChat(chatId);
    if (DEBUG && incidentId) console.log('[REQ-FB] incidentId por fallback de acuse', { incidentId });
  }

  if (!incidentId) {
    if (DEBUG) console.log('[REQ-FB] sin incidentId final → return false');
    return false;
  }

  if (DEBUG) console.log('[REQ-FB] usando incidentId', { incidentId });

  // 5) Cargar contexto completo del ticket
  const inc = await getIncidentFull(incidentId);

  const ticketCtx = {
    id: inc.id,
    folio: inc.folio || null,
    descripcion: inc.descripcion || inc.interpretacion || '',
    lugar: inc.lugar || null,
    status: (inc.status || '').toLowerCase() || null,
  };

  // 6) Feedback engine
  let fb;
  try {
    fb = await runFeedbackEngine({
      text: body,
      roleHint: 'requester',
      ticket: ticketCtx,
      history: [],
      source: 'requester_dm',
    });
  } catch (e) {
    if (DEBUG) console.error('[REQ-FB] runFeedbackEngine err', e?.message || e);
    fb = {
      is_relevant: false,
      role: 'requester',
      kind: 'smalltalk',
      status_intent: 'none',
      requester_side: 'unknown',
      polarity: 'neutral',
      normalized_note: body,
      rationale: 'fallback runFeedbackEngine error',
      confidence: 0.0,
      next_status: ticketCtx.status,
    };
  }

  if (DEBUG) console.log('[REQ-FB] classifier out', fb);

  // ✅ waId correcto
  const waId =
    msg.id?._serialized ||
    msg.id?.id ||
    (typeof msg.id === 'string' ? msg.id : null) ||
    uuidv4();

  const noteText = String((fb.normalized_note || body || '').trim() || '—');

  // 7) Registrar evento en DB (aunque sea noise)
  const eventPayload = {
    role: fb.role,
    kind: fb.kind,
    status_intent: fb.status_intent,
    requester_side: fb.requester_side,
    polarity: fb.polarity,
    note: noteText,
    raw_text: body,
    confidence: fb.confidence,
    via: msg.hasQuotedMsg ? 'reply_folio' : selectedFromStatusMenu ? 'status_menu_choice' : 'ctx_or_recent',
    ts: Date.now(),
  };

  try {
    await appendEvent(incidentId, {
      event_type: 'requester_feedback',
      wa_msg_id: waId,
      payload: eventPayload,
    });
  } catch (e) {
    if (DEBUG) console.warn('[REQ-FB] appendEvent err', e?.message || e);
  }

  // Flags de estatus (heurístico + IA)
  const aiStatusQuery =
    ((!fb.is_relevant &&
      fb.kind === 'smalltalk' &&
      typeof fb.normalized_note === 'string' &&
      /estado del ticket|estado del reporte|avance del ticket|avance de la solución|pregunta sobre el estado/i.test(
        fb.normalized_note
      )) ||
      isStatusQueryFromIntent);

  const isStatusQuery = selectedFromStatusMenu || heuristicStatusQuery || aiStatusQuery;

  if (DEBUG) {
    console.log('[REQ-FB] statusQuery flags', {
      heuristicStatusQuery,
      aiStatusQuery,
      isStatusQuery,
      selectedFromStatusMenu,
    });
  }

  // 8) Actualizar estado SOLO si relevante y confiable
  const currentStatus = ticketCtx.status || null;
  const nextStatusFromEngine = fb.next_status || currentStatus;

  if (fb.is_relevant && fb.confidence >= MIN_CONF) {
    if (nextStatusFromEngine && nextStatusFromEngine !== currentStatus) {
      await updateStatus(incidentId, nextStatusFromEngine);
    }

    // 9.a) Notificar a grupos
    try {
      await sendFollowUpToGroups(client, {
        incident: inc,
        message: noteText,
        media: [],
      });
    } catch (e) {
      if (DEBUG) console.warn('[REQ-FB] follow-up notify err', e?.message || e);
    }
  } else {
    // Confirmación implícita
    const st = (currentStatus || '').toLowerCase();
    const positiveAck = looksLikeAck(body) && fb.polarity !== 'negative';

    if (st === 'awaiting_confirmation' && positiveAck) {
      const finalStatus = 'done';
      await updateStatus(incidentId, finalStatus);
      if (DEBUG) console.log('[REQ-FB] cierre por confirmación del solicitante', { incidentId, finalStatus, body });
    } else if (DEBUG) {
      console.log('[REQ-FB] mensaje no relevante o baja confianza (solo se registra evento, sin cambio de estado)');
    }
  }

  // 9.b) Si es pregunta de estatus, avisar a los grupos
  let shouldPingTeam = false;
  try {
    const st = (inc.status || 'open').toLowerCase();
    shouldPingTeam = isStatusQuery && (st === 'open' || st === 'in_progress' || st === 'awaiting_confirmation');

    if (shouldPingTeam) {
      await sendFollowUpToGroups(client, {
        incident: inc,
        message: `📣 El solicitante pregunta por el estado de este ticket:\n"${body}"`,
        media: [],
      });
    }
  } catch (e) {
    if (DEBUG) console.warn('[REQ-FB] status-query notify err', e?.message || e);
  }

  // 10) Respuesta al solicitante
  if (isStatusQuery) {
    const summary = formatStatusSummaryForRequester(inc);
    await replySafe(msg, summary);

    if (shouldPingTeam) {
      await replySafe(msg, '🔔 Además, ya avisé al equipo para que le den seguimiento a este ticket.');
    }
  } else {
    await replySafe(msg, '✅ Tu mensaje se agregó al ticket. Te avisaré aquí cuando haya novedades.');
  }

  return true;
}

module.exports = {
  maybeHandleRequesterReply,
  noteRequesterNotify,
};

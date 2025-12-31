// modules/db/incidenceDB.js
// Persistencia de incidencias (SQLite + fallback JSONL), idempotencia, eventos y adjuntos
// Lecturas para Dashboard: listIncidents / getIncidentById
// + Soporte para cancelación desde grupos y desambiguación por grupo/área.

const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');

const DEBUG = (process.env.VICEBOT_DEBUG || '1') === '1';
const DB_PATH = process.env.VICEBOT_DB_PATH || path.join(process.cwd(), 'data', 'vicebot.sqlite');
const JSONL_PATH = process.env.VICEBOT_JSONL_FALLBACK || path.join(process.cwd(), 'data', 'incidents.jsonl');

// Permite emitir un evento auxiliar de ACK cuando se cancela (además del status_change)
const EMIT_GROUP_ACK_EVENT_DEFAULT = (process.env.VICEBOT_GROUP_EMIT_ACK_EVENT || '0') === '1';

let sqlite = null;
try { sqlite = require('better-sqlite3'); } catch { sqlite = null; if (DEBUG) console.warn('[DB] better-sqlite3 no instalado. Fallback a JSONL.'); }

let db = null;

// Prepared
let stmtInsertIncident = null;
let stmtInsertMsgHandled = null;
let stmtSelectMsgHandled = null;
let stmtInsertEvent = null;
let stmtUpdateIncidentTouch = null;
let stmtFindOpenByChat = null;
let stmtUpsertSeq = null;
let stmtReadSeq = null;
let stmtUpdateFolio = null;
let stmtSelectAttachmentsById = null;
let stmtUpdateAttachmentsById = null;
// NEW / ajustados
let stmtGetIncidentByFolio = null;
let stmtListOpenByArea = null;
let stmtListOpenDispatchedToGroupWithin = null;

function ensureDirs() {
  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const dirJson = path.dirname(JSONL_PATH);
  if (!fs.existsSync(dirJson)) fs.mkdirSync(dirJson, { recursive: true });
}
function tryAlter(sql) { try { db.exec(sql); } catch { /* ignore */ } }
function nowISO() { return new Date().toISOString(); }
function areaToPrefix(area) {
  const m = { man:'MAN', it:'IT', ama:'AMA', rs:'RS', seg:'SEG' };
  return m[(area || '').toLowerCase()] || 'GEN';
}
function safeParse(s) { try { return JSON.parse(s); } catch { return s; } }

function initSQLite() {
  if (!sqlite) return;
  ensureDirs();
  db = sqlite(DB_PATH);
  db.pragma('journal_mode = WAL');

  // Tabla base
  db.exec(`
    CREATE TABLE IF NOT EXISTS incidents (
      id TEXT PRIMARY KEY,
      folio TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT,
      last_msg_at TEXT,
      status TEXT,
      chat_id TEXT,
      wa_first_msg_id TEXT,
      descripcion TEXT,
      interpretacion TEXT,
      lugar TEXT,
      building TEXT,
      floor TEXT,
      room TEXT,
      area_destino TEXT,
      areas_json TEXT,
      notes_json TEXT,
      vision_tags_json TEXT,
      vision_safety_json TEXT,
      attachments_json TEXT,
      source TEXT,
      raw_draft_json TEXT,
      origin_name TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_incidents_created_at ON incidents(created_at);
    CREATE INDEX IF NOT EXISTS idx_incidents_area ON incidents(area_destino);
    CREATE INDEX IF NOT EXISTS idx_incidents_lugar ON incidents(lugar);
    CREATE INDEX IF NOT EXISTS idx_incidents_status ON incidents(status);
    CREATE INDEX IF NOT EXISTS idx_incidents_folio ON incidents(folio);
  `);

  // Migraciones seguras
  tryAlter(`CREATE UNIQUE INDEX IF NOT EXISTS ux_incidents_wa_first ON incidents(wa_first_msg_id)`);
  tryAlter(`ALTER TABLE incidents ADD COLUMN origin_name TEXT`);
  tryAlter(`ALTER TABLE incidents ADD COLUMN attachments_json TEXT`);

  db.exec(`
    CREATE TABLE IF NOT EXISTS messages_handled (
      wa_msg_id TEXT PRIMARY KEY,
      processed_at TEXT NOT NULL
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS incident_events (
      id TEXT PRIMARY KEY,
      incident_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      event_type TEXT NOT NULL,
      wa_msg_id TEXT,
      payload_json TEXT,
      FOREIGN KEY(incident_id) REFERENCES incidents(id)
    );
    CREATE INDEX IF NOT EXISTS idx_events_incident ON incident_events(incident_id);
    CREATE INDEX IF NOT EXISTS idx_events_type_time ON incident_events(event_type, created_at);
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS inc_sequences(
      prefix TEXT PRIMARY KEY,
      last_integer INTEGER NOT NULL
    );
  `);

  // Prepared
  stmtInsertIncident = db.prepare(`
    INSERT INTO incidents (
      id, folio, created_at, updated_at, last_msg_at, status,
      chat_id, wa_first_msg_id,
      descripcion, interpretacion,
      lugar, building, floor, room,
      area_destino, areas_json, notes_json,
      vision_tags_json, vision_safety_json, attachments_json,
      source, raw_draft_json, origin_name
    ) VALUES (
      @id, @folio, @created_at, @updated_at, @last_msg_at, @status,
      @chat_id, @wa_first_msg_id,
      @descripcion, @interpretacion,
      @lugar, @building, @floor, @room,
      @area_destino, @areas_json, @notes_json,
      @vision_tags_json, @vision_safety_json, @attachments_json,
      @source, @raw_draft_json, @origin_name
    )
  `);

  stmtInsertMsgHandled = db.prepare(`INSERT INTO messages_handled (wa_msg_id, processed_at) VALUES (?, ?)`);
  stmtSelectMsgHandled = db.prepare(`SELECT wa_msg_id FROM messages_handled WHERE wa_msg_id = ?`);

  stmtInsertEvent = db.prepare(`
    INSERT INTO incident_events (id, incident_id, created_at, event_type, wa_msg_id, payload_json)
    VALUES (@id, @incident_id, @created_at, @event_type, @wa_msg_id, @payload_json)
  `);

  stmtUpdateIncidentTouch = db.prepare(`
    UPDATE incidents
       SET updated_at = @ts,
           last_msg_at = @ts
     WHERE id = @incident_id
  `);

  // Hilos por chat (open) – se mantiene igual
  stmtFindOpenByChat = db.prepare(`
    SELECT *
      FROM incidents
     WHERE chat_id = ?
       AND status = 'open'
       AND (last_msg_at IS NULL OR last_msg_at >= datetime('now', ?))
  `);

  stmtReadSeq = db.prepare(`SELECT last_integer FROM inc_sequences WHERE prefix = ?`);
  stmtUpsertSeq = db.prepare(`
    INSERT INTO inc_sequences(prefix, last_integer)
    VALUES(@prefix, @val)
    ON CONFLICT(prefix) DO UPDATE SET last_integer = excluded.last_integer
  `);
  stmtUpdateFolio = db.prepare(`UPDATE incidents SET folio = @folio WHERE id = @id`);

  stmtSelectAttachmentsById = db.prepare(`SELECT attachments_json FROM incidents WHERE id = ?`);
  stmtUpdateAttachmentsById = db.prepare(`
    UPDATE incidents
       SET attachments_json = @attachments_json,
           updated_at = @ts,
           last_msg_at = @ts
     WHERE id = @id
  `);

  // NEW prepareds
  stmtGetIncidentByFolio = db.prepare(`
    SELECT id, folio, chat_id, descripcion, interpretacion, lugar, area_destino, status, created_at, updated_at,
           areas_json, notes_json, attachments_json, origin_name
    FROM incidents
    WHERE folio = ?
    LIMIT 1
  `);

  // ⬇️ PENDIENTES = open o in_progress
  stmtListOpenByArea = db.prepare(`
    SELECT *
      FROM incidents
    WHERE LOWER(status) IN ('open','in_progress')
      AND LOWER(area_destino) = @area
    ORDER BY updated_at DESC
    LIMIT @limit
  `);


  // ⬇️ PENDIENTES = open o in_progress
  stmtListOpenDispatchedToGroupWithin = db.prepare(`
    SELECT i.*
      FROM incidents i
      JOIN incident_events e ON e.incident_id = i.id
     WHERE LOWER(i.status) IN ('open','in_progress')
       AND e.event_type = 'dispatched_to_groups'
       AND e.created_at >= datetime('now', @windowExpr)
       AND e.payload_json LIKE @needle
     ORDER BY i.updated_at DESC
     LIMIT @limit
  `);

  if (DEBUG) console.log('[DB] SQLite listo en', DB_PATH);
}

function ensureReady() {
  if (!db && sqlite) initSQLite();
  else ensureDirs();
}

// Folios
function nextFolioForArea(areaCode) {
  if (!db) return null;
  const prefix = areaToPrefix(areaCode);
  let last = stmtReadSeq.get(prefix)?.last_integer || 0;
  last += 1;
  stmtUpsertSeq.run({ prefix, val: last });
  const n = String(last).padStart(5, '0');
  return `${prefix}-${n}`;
}

// Map + persist
function mapDraftToRecord(draft, meta = {}) {
  // ✅ FIX: Validar que draft no sea undefined/null
  const d = draft || {};
  
  // ✅ FIX: Usar ID del draft si existe
  const id = d.id || randomUUID();
  const ts = nowISO();

  const areas = Array.isArray(d.areas) ? d.areas : (d.area_destino ? [d.area_destino] : []);
  const notes = Array.isArray(d.notes) ? d.notes : (d.notes ? [String(d.notes)] : []);

  const visionTags   = Array.isArray(meta.visionTags) ? meta.visionTags : [];
  const visionSafety = Array.isArray(meta.visionSafety) ? meta.visionSafety : [];
  const attachments  = Array.isArray(d.attachments) ? d.attachments : [];

  // ✅ FIX: Usar folio del draft si existe
  const folio = d.folio || nextFolioForArea(d.area_destino) || null;

  return {
    id,
    folio,
    created_at: d.created_at || ts,
    updated_at: ts,
    last_msg_at: ts,
    status: d.status || 'open',
    chat_id: d.chat_id || meta.chatId || null,
    wa_first_msg_id: meta.waFirstMsgId || null,

    descripcion: d.descripcion || null,
    interpretacion: d.interpretacion || null,
    lugar: d.lugar || null,
    building: d.building || null,
    floor: d.floor || null,
    room: d.room || null,

    area_destino: d.area_destino || null,
    areas_json: JSON.stringify(areas),
    notes_json: JSON.stringify(notes),
    vision_tags_json: JSON.stringify(visionTags),
    vision_safety_json: JSON.stringify(visionSafety),
    attachments_json: JSON.stringify(attachments),
    source: meta.source || 'whatsapp',
    raw_draft_json: JSON.stringify(d),
    origin_name: meta.originName || null,
  };
}

function persistIncident(draft, meta = {}) {
  const rec = mapDraftToRecord(draft, meta);
  if (db && stmtInsertIncident) {
    stmtInsertIncident.run(rec);
    if (DEBUG) console.log('[DB] incident.inserted', rec.id, rec.folio || '(sin folio)');
    return { id: rec.id, folio: rec.folio || null, driver: 'sqlite', path: DB_PATH };
  }
  ensureDirs();
  fs.appendFileSync(JSONL_PATH, JSON.stringify({ type: 'incident', ...rec }) + '\n');
  if (DEBUG) console.log('[DB] incident.appended (JSONL)', rec.id, rec.folio || '(sin folio)');
  return { id: rec.id, folio: rec.folio || null, driver: 'jsonl', path: JSONL_PATH };
}

// Estado (legacy helpers)
function setIncidentClosed(incidentId) {
  if (!db) return;
  const ts = nowISO();
  db.prepare(`UPDATE incidents SET status='closed', updated_at=@ts WHERE id=@id`).run({ id: incidentId, ts });
}

function updateIncidentFolioIfMissing(incidentId, areaCode) {
  if (!db) return null;
  const row = db.prepare(`SELECT folio FROM incidents WHERE id=?`).get(incidentId);
  if (row && row.folio) return row.folio;
  const folio = nextFolioForArea(areaCode);
  if (folio) stmtUpdateFolio.run({ id: incidentId, folio });
  return folio;
}

// Idempotencia WA
function hasMessageBeenHandled(waMsgId) {
  if (!db) return false;
  return Boolean(stmtSelectMsgHandled.get(waMsgId));
}
function markMessageHandled(waMsgId) {
  if (!db) return false;
  try { stmtInsertMsgHandled.run(waMsgId, nowISO()); return true; }
  catch { if (DEBUG) console.log('[DB] msg already handled', waMsgId); return false; }
}

// Eventos
function appendIncidentEvent(incidentId, { event_type, payload = {}, wa_msg_id = null }) {
  if (!db) return null;
  const rec = {
    id: randomUUID(),
    incident_id: incidentId,
    created_at: nowISO(),
    event_type,
    wa_msg_id,
    payload_json: JSON.stringify(payload || {}),
  };
  const tx = db.transaction(() => {
    stmtInsertEvent.run(rec);
    stmtUpdateIncidentTouch.run({ incident_id: incidentId, ts: rec.created_at });
  });
  tx();
  if (DEBUG) console.log('[DB] event.appended', { incidentId, event_type, wa_msg_id });
  return rec.id;
}

// Adjuntos
function _getCurrentAttachmentsSQLite(incidentId) {
  const row = stmtSelectAttachmentsById.get(incidentId);
  if (!row) return [];
  const arr = safeParse(row.attachments_json || '[]');
  return Array.isArray(arr) ? arr : [];
}

/**
 * Registra un adjunto (solo metadatos, el archivo lo guarda la capa superior).
 * fileMeta = { id?, filename, mimetype, url, size }
 */
function appendIncidentAttachment(incidentId, fileMeta, opts = {}) {
  const ts = nowISO();
  const meta = {
    id: fileMeta.id || randomUUID(),
    filename: fileMeta.filename || null,
    mimetype: fileMeta.mimetype || 'application/octet-stream',
    url: fileMeta.url || null,
    size: fileMeta.size || null,
    created_at: ts,
  };

  // Soporta alias: createEvent / alsoEvent (por compat)
  const createEvent = (typeof opts.createEvent === 'boolean')
    ? opts.createEvent
    : (typeof opts.alsoEvent === 'boolean'
        ? opts.alsoEvent
        : true);

  if (db) {
    const arr = _getCurrentAttachmentsSQLite(incidentId);
    arr.push(meta);

    const tx = db.transaction(() => {
      stmtUpdateAttachmentsById.run({
        id: incidentId,
        attachments_json: JSON.stringify(arr),
        ts,
      });

      if (createEvent) {
        stmtInsertEvent.run({
          id: randomUUID(),
          incident_id: incidentId,
          created_at: ts,
          event_type: 'attachment_added',
          wa_msg_id: opts.wa_msg_id || null,
          payload_json: JSON.stringify({
            id: meta.id,
            filename: meta.filename,
            mimetype: meta.mimetype,
            size: meta.size,
            url: meta.url,
          }),
        });
      }
    });
    tx();

    if (DEBUG) console.log('[DB] attachment.added', { incidentId, file: meta.filename });
    return meta.id;
  }

  // JSONL
  ensureDirs();
  fs.appendFileSync(
    JSONL_PATH,
    JSON.stringify({ type: 'incident_attachment', incident_id: incidentId, meta, created_at: ts }) + '\n'
  );
  if (DEBUG) console.log('[DB] attachment.appended(JSONL)', { incidentId, file: meta.filename });
  return meta.id;
}

function appendIncidentAttachments(incidentId, metas = [], opts = {}) {
  let ok = true;
  for (const m of (metas || [])) ok = appendIncidentAttachment(incidentId, m, opts) && ok;
  return ok;
}

// Threading por chat (DM)
function findOpenIncidentsByChat(chatId, activeWindowMins = 60) {
  if (!db) return [];
  const windowExpr = `-${Math.max(1, activeWindowMins)} minutes`;
  return stmtFindOpenByChat.all(chatId, windowExpr) || [];
}
function findCandidateOpenIncident({ chatId, placeLabelOrRoom = null, activeWindowMins = 60 }) {
  const rows = findOpenIncidentsByChat(chatId, activeWindowMins);
  if (!rows.length) return { type: 'none', incidents: [] };

  if (placeLabelOrRoom) {
    const key = String(placeLabelOrRoom).toLowerCase();
    const matches = rows.filter(r => {
      const l = String(r.lugar || '').toLowerCase();
      const room = String(r.room || '').toLowerCase();
      return l.includes(key) || (!!room && key.includes(room)) || (!!room && room.includes(key));
    });
    if (matches.length === 1) return { type: 'strong', incident: matches[0], incidents: rows };
    if (matches.length > 1)  return { type: 'ambiguous', incidents: matches };
  }

  if (rows.length === 1) return { type: 'probable', incident: rows[0], incidents: rows };
  return { type: 'ambiguous', incidents: rows };
}

/* ──────────────────────────────
 * NUEVO: listar incidencias por chat (para /tickets)
 * ────────────────────────────── */

async function listIncidentsForChat(chatId, opts = {}) {
  ensureReady();
  if (!chatId) return [];

  const limit = Number(opts.limit || 10);
  const statuses = Array.isArray(opts.statusFilter)
    ? opts.statusFilter.map(s => String(s || '').toLowerCase()).filter(Boolean)
    : [];

  // Fallback JSONL
  if (!db) {
    if (!fs.existsSync(JSONL_PATH)) return [];

    const lines = fs.readFileSync(JSONL_PATH, 'utf8').split('\n').filter(Boolean);
    const incidents = [];
    const lastStatus = new Map();

    for (const ln of lines) {
      const obj = safeParse(ln);
      if (!obj) continue;
      if (obj.type === 'incident') {
        incidents.push(obj);
      } else if (obj.type === 'incident_status') {
        const st = String(obj.to || '').toLowerCase();
        lastStatus.set(obj.incident_id, st);
      }
    }

    const wanted = statuses.length ? new Set(statuses) : null;

    const filtered = incidents
      .filter(r => String(r.chat_id || '').trim() === String(chatId).trim())
      .map(r => {
        const effStatus = (lastStatus.get(r.id) || r.status || 'open').toLowerCase();
        return { ...r, _effStatus: effStatus };
      })
      .filter(r => !wanted || wanted.has(r._effStatus))
      .sort((a, b) => {
        const da = new Date(a.created_at || 0).getTime();
        const dbb = new Date(b.created_at || 0).getTime();
        return dbb - da;
      })
      .slice(0, Math.max(1, limit));

    return filtered.map(r => ({
      id: r.id,
      folio: r.folio || null,
      status: r._effStatus || (r.status || 'open').toLowerCase(),
      lugar: r.lugar || null,
      descripcion: r.descripcion || null,
      interpretacion: r.interpretacion || null,
      created_at: r.created_at || null,
      updated_at: r.updated_at || null,
      area_destino: r.area_destino || null,
      chat_id: r.chat_id || null,
    }));
  }

  // Con SQLite
  const wanted = statuses.length ? statuses : null;

  let sql = `
    SELECT
      id,
      folio,
      status,
      lugar,
      descripcion,
      interpretacion,
      created_at,
      updated_at,
      area_destino,
      chat_id
    FROM incidents
    WHERE chat_id = @chatId
  `;
  const params = { chatId: chatId, limit: Math.max(1, limit) };

  if (wanted && wanted.length) {
    const placeholders = wanted.map((_, i) => `@st${i}`).join(',');
    sql += ` AND LOWER(status) IN (${placeholders})`;
    wanted.forEach((st, i) => {
      params[`st${i}`] = st;
    });
  }

  sql += `
    ORDER BY created_at DESC, id DESC
    LIMIT @limit
  `;

  const rows = db.prepare(sql).all(params) || [];
  if (DEBUG) {
    console.log('[DB] listIncidentsForChat', {
      chatId,
      statuses: wanted,
      limit: params.limit,
      rows: rows.length,
    });
  }
  return rows.map(r => ({
    id: r.id,
    folio: r.folio || null,
    status: (r.status || 'open').toLowerCase(),
    lugar: r.lugar || null,
    descripcion: r.descripcion || null,
    interpretacion: r.interpretacion || null,
    created_at: r.created_at || null,
    updated_at: r.updated_at || null,
    area_destino: r.area_destino || null,
    chat_id: r.chat_id || null,
  }));
}

/* ──────────────────────────────
 * ✅ NUEVO: listar incidencias por ÁREA (para /tickets en grupos)
 * ────────────────────────────── */
async function listIncidentsByArea(areaCode, opts = {}) {
  ensureReady();
  const areaKey = String(areaCode || '').trim().toLowerCase();
  if (!areaKey) return [];

  const limit = Number(opts.limit || 25);
  const statuses = Array.isArray(opts.statusFilter)
    ? opts.statusFilter.map(s => String(s || '').toLowerCase()).filter(Boolean)
    : [];

  // JSONL fallback
  if (!db) {
    if (!fs.existsSync(JSONL_PATH)) return [];

    const lines = fs.readFileSync(JSONL_PATH, 'utf8').split('\n').filter(Boolean);
    const incidents = [];
    const lastStatus = new Map();

    for (const ln of lines) {
      const obj = safeParse(ln);
      if (!obj) continue;
      if (obj.type === 'incident') incidents.push(obj);
      else if (obj.type === 'incident_status') lastStatus.set(obj.incident_id, String(obj.to || '').toLowerCase());
    }

    const wanted = statuses.length ? new Set(statuses) : null;

    const filtered = incidents
      .filter(r => String(r.area_destino || '').toLowerCase() === areaKey)
      .map(r => {
        const effStatus = (lastStatus.get(r.id) || r.status || 'open').toLowerCase();
        return { ...r, _effStatus: effStatus };
      })
      .filter(r => !wanted || wanted.has(r._effStatus))
      .sort((a, b) => {
        const da = new Date(a.created_at || 0).getTime();
        const dbb = new Date(b.created_at || 0).getTime();
        return dbb - da;
      })
      .slice(0, Math.max(1, limit));

    return filtered.map(r => ({
      id: r.id,
      folio: r.folio || null,
      status: r._effStatus || (r.status || 'open').toLowerCase(),
      lugar: r.lugar || null,
      descripcion: r.descripcion || null,
      interpretacion: r.interpretacion || null,
      created_at: r.created_at || null,
      updated_at: r.updated_at || null,
      area_destino: r.area_destino || null,
      chat_id: r.chat_id || null,
    }));
  }

  // SQLite
  const wanted = statuses.length ? statuses : null;

  let sql = `
    SELECT
      id,
      folio,
      status,
      lugar,
      descripcion,
      interpretacion,
      created_at,
      updated_at,
      area_destino,
      chat_id
    FROM incidents
    WHERE LOWER(area_destino) = @area
  `;
  const params = { area: areaKey, limit: Math.max(1, limit) };

  if (wanted && wanted.length) {
    const placeholders = wanted.map((_, i) => `@st${i}`).join(',');
    sql += ` AND LOWER(status) IN (${placeholders})`;
    wanted.forEach((st, i) => (params[`st${i}`] = st));
  }

  sql += `
    ORDER BY created_at DESC, id DESC
    LIMIT @limit
  `;

  const rows = db.prepare(sql).all(params) || [];
  if (DEBUG) {
    console.log('[DB] listIncidentsByArea', {
      area: areaKey,
      statuses: wanted,
      limit: params.limit,
      rows: rows.length,
    });
  }

  return rows.map(r => ({
    id: r.id,
    folio: r.folio || null,
    status: (r.status || 'open').toLowerCase(),
    lugar: r.lugar || null,
    descripcion: r.descripcion || null,
    interpretacion: r.interpretacion || null,
    created_at: r.created_at || null,
    updated_at: r.updated_at || null,
    area_destino: r.area_destino || null,
    chat_id: r.chat_id || null,
  }));
}

/* ──────────────────────────────
 * LECTURAS PARA GRUPOS / UI
 * ────────────────────────────── */

async function getIncidentById(idOrFolio) {
  ensureReady();

  if (!db) {
    if (!fs.existsSync(JSONL_PATH)) return null;
    const lines = fs.readFileSync(JSONL_PATH, 'utf8').split('\n').filter(Boolean);
    let inc = null;
    const attachments = [];
    for (const ln of lines) {
      const obj = safeParse(ln);
      if (!obj) continue;
      if (obj.type === 'incident' && (obj.id === idOrFolio || obj.folio === idOrFolio)) inc = obj;
      else if (obj.type === 'incident_attachment' && inc && obj.incident_id === inc.id) attachments.push(obj.meta);
    }
    if (!inc) return null;

    const baseAtts = safeParse(inc.attachments_json || '[]');
    const allAtts = [...(Array.isArray(baseAtts) ? baseAtts : []), ...attachments];

    return {
      id: inc.id,
      folio: inc.folio,
      chat_id: inc.chat_id || null,
      descripcion: inc.descripcion,
      interpretacion: inc.interpretacion || null,
      lugar: inc.lugar,
      area_destino: inc.area_destino,
      status: inc.status || 'open',
      created_at: inc.created_at,
      updated_at: inc.updated_at,
      areas: safeParse(inc.areas_json || '[]') || [],
      notes: safeParse(inc.notes_json || '[]') || [],
      origin_name: inc.origin_name || null,
      events: [],
      attachments: allAtts
    };
  }

  const inc = db.prepare(`
    SELECT id, folio, chat_id, descripcion, interpretacion, lugar, area_destino, status, created_at, updated_at,
           areas_json, notes_json, attachments_json, origin_name
    FROM incidents WHERE id = ? OR folio = ? LIMIT 1
  `).get(idOrFolio, idOrFolio);

  if (!inc) return null;

  const events = db.prepare(`
    SELECT id, event_type, payload_json AS payload, created_at, wa_msg_id
    FROM incident_events
    WHERE incident_id = ?
    ORDER BY created_at ASC
  `).all(inc.id);

  const areas = safeParse(inc.areas_json || '[]'); 
  const notes = safeParse(inc.notes_json || '[]');
  const atts  = safeParse(inc.attachments_json || '[]');

  return {
    id: inc.id,
    folio: inc.folio,
    chat_id: inc.chat_id || null,
    descripcion: inc.descripcion,
    interpretacion: inc.interpretacion,
    lugar: inc.lugar,
    area_destino: inc.area_destino,
    status: inc.status,
    created_at: inc.created_at,
    updated_at: inc.updated_at,
    areas: Array.isArray(areas) ? areas : [],
    notes: Array.isArray(notes) ? notes : [],
    origin_name: inc.origin_name || null,
    events: (events || []).map(e => ({
      ...e,
      payload: typeof e.payload === 'string' ? safeParse(e.payload) : e.payload
    })),
    attachments: Array.isArray(atts) ? atts : []
  };
}

// Conveniencia explícita por folio
async function getIncidentByFolio(folio) {
  ensureReady();

  if (!folio) return null;
  if (!db) {
    return getIncidentById(folio);
  }

  const inc = stmtGetIncidentByFolio.get(String(folio));
  if (!inc) return null;

  const areas = safeParse(inc.areas_json || '[]'); 
  const notes = safeParse(inc.notes_json || '[]');
  const atts  = safeParse(inc.attachments_json || '[]');

  const events = db.prepare(`
    SELECT id, event_type, payload_json AS payload, created_at, wa_msg_id
    FROM incident_events
    WHERE incident_id = ?
    ORDER BY created_at ASC
  `).all(inc.id);

  return {
    id: inc.id,
    folio: inc.folio,
    chat_id: inc.chat_id || null,
    descripcion: inc.descripcion,
    interpretacion: inc.interpretacion,
    lugar: inc.lugar,
    area_destino: inc.area_destino,
    status: inc.status,
    created_at: inc.created_at,
    updated_at: inc.updated_at,
    areas: Array.isArray(areas) ? areas : [],
    notes: Array.isArray(notes) ? notes : [],
    origin_name: inc.origin_name || null,
    events: (events || []).map(e => ({
      ...e,
      payload: typeof e.payload === 'string' ? safeParse(e.payload) : e.payload
    })),
    attachments: Array.isArray(atts) ? atts : []
  };
}

// 2) Listar pendientes por área (para menús); PENDIENTES = open o in_progress
function listOpenIncidentsByArea(areaCode, { limit = 10 } = {}) {
  ensureReady();
  if (!areaCode) return [];

  if (!db) {
    // JSONL
    if (!fs.existsSync(JSONL_PATH)) return [];
    const lines = fs.readFileSync(JSONL_PATH, 'utf8').split('\n').filter(Boolean);
    const incidents = [];
    const statusMap = new Map();
    for (const ln of lines) {
      const obj = safeParse(ln);
      if (!obj) continue;
      if (obj.type === 'incident') incidents.push(obj);
      else if (obj.type === 'incident_status') statusMap.set(obj.incident_id, String(obj.to).toLowerCase());
    }
    const areaKey = String(areaCode).toLowerCase();
    const open = incidents
      .filter(r => String(r.area_destino || '').toLowerCase() === areaKey)
      .filter(r => {
        const st = String(statusMap.get(r.id) || r.status || 'open').toLowerCase();
        return st === 'open' || st === 'in_progress';
      })
      .sort((a,b)=> (new Date(b.updated_at) - new Date(a.updated_at)))
      .slice(0, Math.max(1, limit));
    return open;
  }

  return stmtListOpenByArea.all({
    area: String(areaCode).toLowerCase(),
    limit: Math.max(1, limit),
  });

}

// 3) Listar pendientes (open/in_progress) despachados a un grupo recientemente
function listOpenIncidentsRecentlyDispatchedToGroup(groupId, { windowMins = 60 * 24 * 3, limit = 20 } = {}) {
  ensureReady();
  if (!groupId) return [];

  if (!db) {
    // JSONL
    if (!fs.existsSync(JSONL_PATH)) return [];
    const lines = fs.readFileSync(JSONL_PATH, 'utf8').split('\n').filter(Boolean);
    const incidents = [];
    const statusMap = new Map();
    const dispatched = new Map(); // incId -> bool

    const cutoff = Date.now() - Math.max(1, windowMins) * 60 * 1000;

    for (const ln of lines) {
      const obj = safeParse(ln);
      if (!obj) continue;
      if (obj.type === 'incident') incidents.push(obj);
      else if (obj.type === 'incident_status') {
        statusMap.set(obj.incident_id, String(obj.to).toLowerCase());
      } else if (obj.type === 'incident_event') {
        if (obj.event_type === 'dispatched_to_groups') {
          const ts = new Date(obj.created_at || obj.at || Date.now()).getTime();
          if (ts >= cutoff) {
            const payload = obj.payload || obj.payload_json || {};
            const pStr = typeof payload === 'string' ? payload : JSON.stringify(payload);
            if (String(pStr).includes(groupId)) {
              dispatched.set(obj.incident_id, true);
            }
          }
        }
      }
    }

    const open = incidents
      .filter(r => {
        const st = String(statusMap.get(r.id) || r.status || 'open').toLowerCase();
        return st === 'open' || st === 'in_progress';
      })
      .filter(r => dispatched.get(r.id))
      .sort((a,b)=> (new Date(b.updated_at) - new Date(a.updated_at)))
      .slice(0, Math.max(1, limit));

    return open;
  }

  const windowExpr = `-${Math.max(1, windowMins)} minutes`;
  const needle = `%${groupId}%`;
  return stmtListOpenDispatchedToGroupWithin.all({ windowExpr, needle, limit: Math.max(1, limit) });
}

/* ──────────────────────────────
 * API genérica (opcional): por estados
 * ────────────────────────────── */
async function listGroupIncidentsByStatus(groupId, statuses = ['open','in_progress'], { windowMins = 60 * 24 * 3, limit = 30 } = {}) {
  ensureReady();
  if (!groupId) return [];

  const norm = s => String(s || '').trim().toLowerCase();
  const wanted = (statuses || []).map(norm).filter(Boolean);
  if (!wanted.length) return [];

  if (!db) {
    if (!fs.existsSync(JSONL_PATH)) return [];
    const lines = fs.readFileSync(JSONL_PATH, 'utf8').split('\n').filter(Boolean);

    const incidents = [];
    const lastStatus = new Map();
    const dispatched = new Map();
    const cutoff = Date.now() - Math.max(1, windowMins) * 60 * 1000;

    for (const ln of lines) {
      const obj = safeParse(ln);
      if (!obj) continue;
      if (obj.type === 'incident') incidents.push(obj);
      else if (obj.type === 'incident_status') {
        lastStatus.set(obj.incident_id, norm(obj.to));
      } else if (obj.type === 'incident_event') {
        if (obj.event_type === 'dispatched_to_groups') {
          const ts = new Date(obj.created_at || obj.at || Date.now()).getTime();
          if (ts >= cutoff) {
            const payload = obj.payload || obj.payload_json || {};
            const pStr = typeof payload === 'string' ? payload : JSON.stringify(payload);
            if (String(pStr).includes(groupId)) dispatched.set(obj.incident_id, true);
          }
        }
      }
    }

    const out = incidents
      .filter(r => dispatched.get(r.id))
      .filter(r => wanted.includes(norm(lastStatus.get(r.id) || r.status || 'open')))
      .sort((a,b)=> (new Date(b.updated_at) - new Date(a.updated_at)))
      .slice(0, Math.max(1, limit));

    return out;
  }

  const placeholders = wanted.map(() => '?').join(',');
  const windowExpr = `-${Math.max(1, windowMins)} minutes`;
  const needle = `%${groupId}%`;

  const sql = `
    SELECT i.*
      FROM incidents i
      JOIN incident_events e ON e.incident_id = i.id
     WHERE LOWER(i.status) IN (${placeholders})
       AND e.event_type = 'dispatched_to_groups'
       AND e.created_at >= datetime('now', ?)
       AND e.payload_json LIKE ?
     ORDER BY i.updated_at DESC
     LIMIT ?
  `;
  const args = [...wanted, windowExpr, needle, Math.max(1, limit)];
  return db.prepare(sql).all(...args);
}

/* ──────────────────────────────
 * Cerrar / Actualizar estado
 * ────────────────────────────── */
function updateIncidentStatus(incidentId, newStatus) {
  ensureReady();

  const ts = nowISO();

  if (!db) {
    fs.appendFileSync(
      JSONL_PATH,
      JSON.stringify({ type: 'incident_status', incident_id: incidentId, to: newStatus, at: ts }) + '\n'
    );
    return { from: null, to: newStatus, at: ts };
  }

  const row = db.prepare(`SELECT status FROM incidents WHERE id = ?`).get(incidentId);
  if (!row) return null;

  const tx = db.transaction(() => {
    db.prepare(`
      UPDATE incidents
         SET status = @st,
             updated_at = @ts,
             last_msg_at = @ts
       WHERE id = @id
    `).run({ id: incidentId, st: newStatus, ts });

    db.prepare(`
      INSERT INTO incident_events (id, incident_id, created_at, event_type, wa_msg_id, payload_json)
      VALUES (@id, @incident_id, @created_at, 'status_change', NULL, @payload_json)
    `).run({
      id: randomUUID(),
      incident_id: incidentId,
      created_at: ts,
      payload_json: JSON.stringify({ from: row.status, to: newStatus })
    });
  });
  tx();

  if (DEBUG) console.log('[DB] status.updated', { id: incidentId, from: row.status, to: newStatus });
  return { from: row.status, to: newStatus, at: ts };
}

/**
 * DEPRECADO (compatibilidad): cancelar incidente.
 * Ahora sólo hace status_change → 'canceled' y opcionalmente emite un ACK auxiliar.
 * opts: { reason?:string, by?:string, note?:string, wa_msg_id?:string, emitAckEvent?:boolean }
 */
function closeIncident(incidentId, opts = {}) {
  ensureReady();
  const emitAck = typeof opts.emitAckEvent === 'boolean'
    ? opts.emitAckEvent
    : EMIT_GROUP_ACK_EVENT_DEFAULT;

  // 1) Cambiar estado (esto genera el evento status_change)
  const res = updateIncidentStatus(incidentId, 'canceled');

  // 2) (Opcional) ACK auxiliar para UI/forense
  if (emitAck && db && res) {
    try {
      appendIncidentEvent(incidentId, {
        event_type: 'group_cancel_ack',
        wa_msg_id: opts.wa_msg_id || null,
        payload: {
          reason: opts.reason || 'cancelled_by_group',
          by: opts.by || null,
          note: opts.note || null
        }
      });
    } catch (e) {
      if (DEBUG) console.warn('[DB] closeIncident ack event error', e?.message || e);
    }
  } else if (!db && emitAck) {
    // JSONL fallback del ACK
    const ts = nowISO();
    fs.appendFileSync(JSONL_PATH, JSON.stringify({
      type: 'incident_event',
      incident_id: incidentId,
      event_type: 'group_cancel_ack',
      created_at: ts,
      wa_msg_id: opts.wa_msg_id || null,
      payload: {
        reason: opts.reason || 'cancelled_by_group',
        by: opts.by || null,
        note: opts.note || null
      }
    }) + '\n');
  }

  if (DEBUG) console.log('[DB] canceled (unified)', { incidentId });
  return { ok: true, at: nowISO() };
}

/* ──────────────────────────────
 * Extras de ergonomía
 * ────────────────────────────── */

// Estado directo (para routers)
function getIncidentStatus(incidentId) {
  ensureReady();
  if (!incidentId) return null;

  if (!db) {
    if (!fs.existsSync(JSONL_PATH)) return null;
    const lines = fs.readFileSync(JSONL_PATH, 'utf8').split('\n').filter(Boolean);
    for (const ln of lines) {
      const obj = safeParse(ln);
      if (obj && obj.type === 'incident' && obj.id === incidentId) {
        return obj.status || 'open';
      }
    }
    return null;
  }
  const row = db.prepare(`SELECT status FROM incidents WHERE id = ?`).get(incidentId);
  return row ? (row.status || null) : null;
}

// Contexto compacto (id, folio, chat del solicitante, etc.)
function getIncidentContext(incidentIdOrFolio) {
  ensureReady();
  if (!incidentIdOrFolio) return null;

  if (!db) {
    // Reusa la lectura JSONL completa y sintetiza
    const inc = fs.existsSync(JSONL_PATH)
      ? fs.readFileSync(JSONL_PATH, 'utf8')
          .split('\n').filter(Boolean)
          .map(ln => safeParse(ln))
          .filter(Boolean)
          .find(o => o.type === 'incident' && (o.id === incidentIdOrFolio || o.folio === incidentIdOrFolio))
      : null;
    if (!inc) return null;
    return {
      id: inc.id,
      folio: inc.folio || null,
      chatId: inc.chat_id || null,
      status: inc.status || 'open',
      area_destino: inc.area_destino || null,
      lugar: inc.lugar || null,
      descripcion: inc.descripcion || null,
      origin_name: inc.origin_name || null,
    };
  }

  const inc = db.prepare(`
    SELECT id, folio, chat_id, status, area_destino, lugar, descripcion, origin_name
    FROM incidents
    WHERE id = ? OR folio = ?
    LIMIT 1
  `).get(incidentIdOrFolio, incidentIdOrFolio);

  if (!inc) return null;
  return {
    id: inc.id,
    folio: inc.folio || null,
    chatId: inc.chat_id || null,
    status: inc.status || 'open',
    area_destino: inc.area_destino || null,
    lugar: inc.lugar || null,
    descripcion: inc.descripcion || null,
    origin_name: inc.origin_name || null,
  };
}

// Helper consistente para registrar "dispatched_to_groups"
function appendDispatchedToGroupsEvent(incidentId, { primaryId, ccIds = [] } = {}) {
  return appendIncidentEvent(incidentId, {
    event_type: 'dispatched_to_groups',
    payload: { primaryId: primaryId || null, ccIds: ccIds || [] },
    wa_msg_id: null,
  });
}

/* ──────────────────────────────
 * Lecturas para Dashboard
 * ────────────────────────────── */
async function listIncidents(filters = {}) {
  ensureReady();

  const {
    q = null,
    area = null,
    estado = null,
    from = null,
    to = null,
    page = 1,
    limit = 25,
    sort = 'created_at:desc'
  } = filters;

  if (!db) {
    // Fallback JSONL
    const items = [];
    const attachByIncident = {};
    const lastStatus = new Map();

    if (fs.existsSync(JSONL_PATH)) {
      const lines = fs.readFileSync(JSONL_PATH, 'utf8').split('\n').filter(Boolean);
      for (const ln of lines) {
        const obj = safeParse(ln);
        if (!obj) continue;
        if (obj.type === 'incident') items.push(obj);
        else if (obj.type === 'incident_attachment') {
          attachByIncident[obj.incident_id] = (attachByIncident[obj.incident_id] || 0) + 1;
        } else if (obj.type === 'incident_status') {
          lastStatus.set(obj.incident_id, String(obj.to).toLowerCase());
        }
      }
    }
    let arr = items;
    const qv = q ? String(q).toLowerCase() : null;
    if (qv) {
      arr = arr.filter(r =>
        String(r.descripcion || '').toLowerCase().includes(qv) ||
        String(r.folio || '').toLowerCase().includes(qv) ||
        String(r.lugar || '').toLowerCase().includes(qv)
      );
    }
    if (area) arr = arr.filter(r => String(r.area_destino || '').toLowerCase() === String(area).toLowerCase());
    if (estado) arr = arr.filter(r => (lastStatus.get(r.id) || String(r.status || 'open').toLowerCase()) === String(estado).toLowerCase());
    if (from)   arr = arr.filter(r => new Date(r.created_at) >= new Date(from));
    if (to)     arr = arr.filter(r => new Date(r.created_at) <= new Date(to));

    const [sf, sdRaw] = String(sort || '').split(':');
    const sd = (sdRaw || 'desc').toLowerCase() === 'asc' ? 1 : -1;
    const field = ['created_at','updated_at','folio'].includes(sf) ? sf : 'created_at';
    arr.sort((a,b)=> (a[field] > b[field] ? sd : -sd));

    const total = arr.length;
    const start = (Math.max(1, page) - 1) * Math.max(1, limit);
    const slice = arr.slice(start, start + Math.max(1, limit));

    const itemsOut = slice.map(r => {
      const baseAtts = safeParse(r.attachments_json || '[]');
      const count = Array.isArray(baseAtts) ? baseAtts.length : 0;
      const statusNow = (lastStatus.get(r.id) || String(r.status || 'open').toLowerCase());
      return {
        id: r.id,
        folio: r.folio,
        descripcion: r.descripcion,
        lugar: r.lugar,
        area_destino: r.area_destino,
        estado: statusNow,
        created_at: r.created_at,
        updated_at: r.updated_at,
        attachments_count: count,
        first_attachment_url: (Array.isArray(baseAtts) && baseAtts[0]?.url) || null
      };
    });

    return { page, limit, total, items: itemsOut };
  }

  // Con SQLite
  const [sortField, sortDirRaw] = String(sort || '').split(':');
  const sortDir = (sortDirRaw || 'desc').toUpperCase() === 'ASC' ? 'ASC' : 'DESC';
  const allowed = new Set(['created_at','updated_at','folio']);
  const orderBy = allowed.has(sortField) ? sortField : 'created_at';

  const where = [];
  const args = {};
  if (q)    { where.push(`(descripcion LIKE @q OR folio LIKE @q OR lugar LIKE @q)`); args.q = `%${q}%`; }
  if (area) { where.push(`LOWER(area_destino) = @area`); args.area = String(area).toLowerCase(); }
  if (estado) { where.push(`LOWER(status) = @estado`); args.estado = String(estado).toLowerCase(); }
  if (from) { where.push(`datetime(created_at) >= datetime(@from)`); args.from = from; }
  if (to)   { where.push(`datetime(created_at) <= datetime(@to)`);   args.to = to; }

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const safeLimit = Math.min(Math.max(parseInt(limit, 10) || 25, 1), 200);
  const safePage  = Math.max(parseInt(page, 10) || 1, 1);
  const offset = (safePage - 1) * safeLimit;

  const sqlCount = `SELECT COUNT(*) as total FROM incidents ${whereSql}`;
  const sqlRows = `
    SELECT id, folio, descripcion, lugar, area_destino, status, created_at, updated_at, attachments_json
    FROM incidents
    ${whereSql}
    ORDER BY ${orderBy} ${sortDir}
    LIMIT @limit OFFSET @offset
  `;

  const total = db.prepare(sqlCount).get(args).total;
  const rows = db.prepare(sqlRows).all({ ...args, limit: safeLimit, offset });

  const items = rows.map(r => {
    const atts = safeParse(r.attachments_json || '[]');
    const attachments = Array.isArray(atts) ? atts : [];
    const first = attachments[0] || null;
    return {
      id: r.id,
      folio: r.folio,
      descripcion: r.descripcion,
      lugar: r.lugar,
      area_destino: r.area_destino,
      estado: String(r.status || 'open').toLowerCase(),
      created_at: r.created_at,
      updated_at: r.updated_at,
      attachments_count: attachments.length,
      first_attachment_url: first?.url || null
    };
  });

  return { page: safePage, limit: safeLimit, total, items };
}

module.exports = {
  ensureReady,
  persistIncident,
  setIncidentClosed,
  updateIncidentFolioIfMissing,

  hasMessageBeenHandled,
  markMessageHandled,

  appendIncidentEvent,
  appendIncidentAttachment,
  appendIncidentAttachments,

  findOpenIncidentsByChat,
  findCandidateOpenIncident,

  // NUEVO: listado por chat para /tickets
  listIncidentsForChat,

  // ✅ NUEVO: listado por área para /tickets en grupos
  listIncidentsByArea,

  // Lecturas existentes
  listIncidents,
  getIncidentById,

  // APIs para router de grupos (pendientes = open/in_progress)
  getIncidentByFolio,
  listOpenIncidentsByArea,
  listOpenIncidentsRecentlyDispatchedToGroup,

  // Estado
  updateIncidentStatus,

  // Compat: cancelar (status_change only + ack opcional)
  closeIncident,

  // Ergonomía y utilidades
  getIncidentStatus,
  getIncidentContext,
  appendDispatchedToGroupsEvent,

  // Opcional: por estados (default open + in_progress)
  listGroupIncidentsByStatus,
};
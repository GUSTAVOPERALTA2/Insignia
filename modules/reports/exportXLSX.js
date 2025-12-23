// modules/reports/exportXLSX.js
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const ExcelJS = require('exceljs');

const DEBUG = (process.env.VICEBOT_DEBUG || '1') === '1';

const DB_PATH =
  process.env.VICEBOT_DB_PATH || path.join(process.cwd(), 'data', 'vicebot.sqlite');

const USERS_PATH =
  process.env.VICEBOT_USERS_PATH || path.join(process.cwd(), 'data', 'users.json');

const REPORTS_DIR =
  process.env.VICEBOT_REPORTS_DIR || path.join(process.cwd(), 'data', 'reports');

const KEEP_MAX = Number(process.env.VICEBOT_REPORTS_KEEP || 20);
const TZ = process.env.VICEBOT_TZ || 'America/Mexico_City';

function safeParse(s, fallback) {
  try { return JSON.parse(s); } catch { return fallback; }
}

function limpiarReportesAntiguos(dirPath, maxArchivos = 20) {
  try {
    const archivos = fs.readdirSync(dirPath)
      .map(name => ({ name, time: fs.statSync(path.join(dirPath, name)).mtime.getTime() }))
      .sort((a, b) => b.time - a.time);

    for (const a of archivos.slice(maxArchivos)) {
      fs.unlinkSync(path.join(dirPath, a.name));
      if (DEBUG) console.log(`🗑️ Reporte eliminado: ${a.name}`);
    }
  } catch (e) {
    console.warn('[EXPORT] limpiarReportesAntiguos err', e?.message || e);
  }
}

function isoStartOfDay(dateStr) {
  if (!dateStr) return null; // YYYY-MM-DD
  return new Date(`${dateStr}T00:00:00.000Z`).toISOString();
}

function isoEndOfDay(dateStr) {
  if (!dateStr) return null;
  return new Date(`${dateStr}T23:59:59.999Z`).toISOString();
}

function formatDateTime(isoString) {
  if (!isoString) return '';
  const d = new Date(isoString);
  if (Number.isNaN(d.getTime())) return String(isoString);
  return d.toLocaleString('es-MX', {
    timeZone: TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function prettyStatus(statusRaw) {
  const s = String(statusRaw || '').toLowerCase();
  if (s === 'open') return 'ABIERTO';
  if (s === 'in_progress') return 'EN PROCESO';
  if (s === 'done' || s === 'closed') return 'COMPLETADO';
  if (s === 'canceled' || s === 'cancelled') return 'CANCELADO';
  return String(statusRaw || '').toUpperCase();
}

function statusFill(statusRaw) {
  const s = String(statusRaw || '').toLowerCase();
  if (s === 'done' || s === 'closed') return 'FF00FF00';
  if (s === 'canceled' || s === 'cancelled') return 'FFFF0000';
  if (s === 'in_progress') return 'FFFFFF00';
  if (s === 'open') return 'FFB0E0E6';
  return null;
}

async function loadUsers() {
  try {
    if (!fs.existsSync(USERS_PATH)) return {};
    let raw = await fsp.readFile(USERS_PATH, 'utf8');
    raw = raw.replace(/^\uFEFF/, '');
    const obj = JSON.parse(raw || '{}');
    const normalized = {};
    for (const [k, v] of Object.entries(obj || {})) {
      normalized[String(k).trim()] = v;
    }
    return normalized;
  } catch (e) {
    if (DEBUG) console.warn('[EXPORT] users.json read error', e?.message || e);
    return {};
  }
}

function displayUser(users, chatIdOrUserId, fallbackName) {
  const id = String(chatIdOrUserId || '').trim();
  const u = users[id];
  if (!u) return fallbackName ? String(fallbackName) : (id || '');
  const nombre = u.nombre || (fallbackName ? String(fallbackName) : id);
  const cargo = u.cargo ? ` (${u.cargo})` : '';
  return `${nombre}${cargo}`;
}

function openSqlite() {
  // eslint-disable-next-line global-require
  const sqlite = require('better-sqlite3');
  const db = sqlite(DB_PATH);
  db.pragma('journal_mode = WAL');
  return db;
}

/**
 * Export XLSX para esquema de Vicebot actual
 * filters:
 *  - startDate: 'YYYY-MM-DD'
 *  - endDate: 'YYYY-MM-DD'
 *  - areas: ['it','man','ama',...]
 *  - statuses: ['open','in_progress','done','canceled']
 */
async function exportXLSX(filters = {}) {
  const { startDate, endDate, areas, statuses } = filters;

  await fsp.mkdir(REPORTS_DIR, { recursive: true });

  const users = await loadUsers();
  const db = openSqlite();

  const clauses = [];
  const params = {};

  if (startDate) {
    clauses.push(`i.created_at >= @start`);
    params.start = isoStartOfDay(startDate);
  }
  if (endDate) {
    clauses.push(`i.created_at <= @end`);
    params.end = isoEndOfDay(endDate);
  }

  if (Array.isArray(areas) && areas.length) {
    clauses.push(`LOWER(i.area_destino) IN (${areas.map((_, idx) => `@a${idx}`).join(',')})`);
    areas.forEach((a, idx) => (params[`a${idx}`] = String(a).trim().toLowerCase()));
  }

  if (Array.isArray(statuses) && statuses.length) {
    clauses.push(`LOWER(i.status) IN (${statuses.map((_, idx) => `@s${idx}`).join(',')})`);
    statuses.forEach((s, idx) => (params[`s${idx}`] = String(s).trim().toLowerCase()));
  }

  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';

  const incidents = db.prepare(`
    SELECT
      i.id,
      i.folio,
      i.status,
      i.chat_id,
      i.origin_name,
      i.descripcion,
      i.interpretacion,
      i.lugar,
      i.area_destino,
      i.created_at,
      i.updated_at,
      i.attachments_json
    FROM incidents i
    ${where}
    ORDER BY i.created_at DESC
  `).all(params);

  if (!incidents.length) {
    db.close();
    throw new Error('No hay incidencias para el filtro especificado');
  }

  const ids = incidents.map(i => i.id);
  const placeholders = ids.map(() => '?').join(',');
  const events = db.prepare(`
    SELECT
      incident_id,
      event_type,
      payload_json,
      created_at,
      wa_msg_id
    FROM incident_events
    WHERE incident_id IN (${placeholders})
    ORDER BY created_at ASC
  `).all(...ids);

  db.close();

  // Workbook
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Vicebot';
  workbook.created = new Date();

  // ───────────────
  // Hoja: Incidencias
  // ───────────────
  const ws = workbook.addWorksheet('Incidencias');
  ws.columns = [
    { header: 'Folio', key: 'folio', width: 14 },
    { header: 'Estado', key: 'status', width: 14 },
    { header: 'Área', key: 'area', width: 10 },
    { header: 'Lugar', key: 'lugar', width: 22 },
    { header: 'Descripción', key: 'desc', width: 45 },
    { header: 'Reportado Por', key: 'reportadoPor', width: 30 },
    { header: 'Creado', key: 'created', width: 20 },
    { header: 'Actualizado', key: 'updated', width: 20 },
    { header: 'Adjuntos', key: 'attachments_count', width: 10 },
    { header: 'ID', key: 'id', width: 24 },
  ];
  ws.getRow(1).font = { bold: true };
  ws.views = [{ state: 'frozen', ySplit: 1 }];

  for (const inc of incidents) {
    const desc = String(inc.descripcion || inc.interpretacion || '').trim();
    const atts = safeParse(inc.attachments_json || '[]', []);
    const attachments = Array.isArray(atts) ? atts : [];
    const reportedBy = displayUser(users, inc.chat_id, inc.origin_name);

    const row = ws.addRow({
      folio: inc.folio || '',
      status: prettyStatus(inc.status),
      area: String(inc.area_destino || '').toUpperCase(),
      lugar: inc.lugar || '',
      desc,
      reportadoPor: reportedBy,
      created: formatDateTime(inc.created_at),
      updated: formatDateTime(inc.updated_at),
      attachments_count: attachments.length,
      id: inc.id,
    });

    const fill = statusFill(inc.status);
    if (fill) {
      const cell = row.getCell(2);
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: fill } };
      cell.alignment = { vertical: 'middle', horizontal: 'center' };
    }
  }

  // ───────────────
  // Hoja: Eventos (incident_events)
  // ───────────────
  const evs = workbook.addWorksheet('Eventos');
  evs.columns = [
    { header: 'Folio', key: 'folio', width: 14 },
    { header: 'Tipo', key: 'event_type', width: 22 },
    { header: 'Usuario', key: 'usuario', width: 30 },
    { header: 'Equipo', key: 'equipo', width: 12 },
    { header: 'Detalle', key: 'detalle', width: 60 },
    { header: 'Fecha', key: 'fecha', width: 20 },
    { header: 'wa_msg_id', key: 'wa_msg_id', width: 28 },
  ];
  evs.getRow(1).font = { bold: true };
  evs.views = [{ state: 'frozen', ySplit: 1 }];

  const idToFolio = new Map(incidents.map(i => [i.id, i.folio || '']));

  for (const e of events || []) {
    const payload = safeParse(e.payload_json || '{}', {});
    const usuario =
      // en varios eventos tu payload puede traer "by", "usuario", etc.
      payload?.by || payload?.usuario || payload?.user || '';
    const equipo = payload?.equipo || payload?.team || payload?.area || '';

    // Un texto “humano”:
    let detalle = '';
    if (e.event_type === 'status_change') {
      detalle = `from: ${payload?.from || ''} → to: ${payload?.to || ''}`;
    } else if (e.event_type === 'dispatched_to_groups') {
      const p = payload || {};
      detalle = `primaryId: ${p.primaryId || ''} | ccIds: ${(p.ccIds || []).join(', ')}`;
    } else if (e.event_type === 'attachment_added') {
      detalle = `${payload?.filename || ''} (${payload?.mimetype || ''}) ${payload?.url || ''}`.trim();
    } else {
      // fallback: JSON compacto
      detalle = typeof payload === 'object' ? JSON.stringify(payload) : String(payload || '');
    }

    evs.addRow({
      folio: idToFolio.get(e.incident_id) || '',
      event_type: String(e.event_type || '').toUpperCase(),
      usuario: displayUser(users, usuario),
      equipo: String(equipo || '').toUpperCase(),
      detalle,
      fecha: formatDateTime(e.created_at),
      wa_msg_id: e.wa_msg_id || '',
    });
  }

  // ───────────────
  // Hoja: Adjuntos (desde incidents.attachments_json)
  // ───────────────
  const at = workbook.addWorksheet('Adjuntos');
  at.columns = [
    { header: 'Folio', key: 'folio', width: 14 },
    { header: 'Archivo', key: 'filename', width: 30 },
    { header: 'MIME', key: 'mimetype', width: 20 },
    { header: 'Tamaño', key: 'size', width: 12 },
    { header: 'URL', key: 'url', width: 60 },
    { header: 'Fecha', key: 'created_at', width: 20 },
  ];
  at.getRow(1).font = { bold: true };
  at.views = [{ state: 'frozen', ySplit: 1 }];

  for (const inc of incidents) {
    const folio = inc.folio || '';
    const atts = safeParse(inc.attachments_json || '[]', []);
    const attachments = Array.isArray(atts) ? atts : [];
    for (const a of attachments) {
      at.addRow({
        folio,
        filename: a?.filename || '',
        mimetype: a?.mimetype || '',
        size: a?.size || '',
        url: a?.url || '',
        created_at: formatDateTime(a?.created_at || ''),
      });
    }
  }

  // Guardar
  const ts = new Date().toISOString().replace(/[:.]/g, '').replace('T', '_').slice(0, 15);
  let filename = `vicebot_incidencias_${ts}`;
  if (areas?.length) filename += `_areas-${areas.join('-')}`;
  if (startDate && endDate) filename += `_fechas-${startDate}-${endDate}`;
  if (statuses?.length) filename += `_status-${statuses.join('-')}`;
  filename += `.xlsx`;

  const outPath = path.join(REPORTS_DIR, filename);
  await workbook.xlsx.writeFile(outPath);

  limpiarReportesAntiguos(REPORTS_DIR, KEEP_MAX);

  return outPath;
}

module.exports = { exportXLSX };

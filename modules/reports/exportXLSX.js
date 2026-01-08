// modules/reports/exportXLSX.js
// ═══════════════════════════════════════════════════════════════════════════
// Exportador de reportes XLSX para Vicebot
// Combina formato visual profesional con estructura de datos SQLite actual
// ═══════════════════════════════════════════════════════════════════════════

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const ExcelJS = require('exceljs');

const DEBUG = (process.env.VICEBOT_DEBUG || '1') === '1';

// ──────────────────────────────────────────────────────────────
// Configuración
// ──────────────────────────────────────────────────────────────

const DB_PATH =
  process.env.VICEBOT_DB_PATH || path.join(process.cwd(), 'data', 'vicebot.sqlite');

const USERS_PATH =
  process.env.VICEBOT_USERS_PATH || path.join(process.cwd(), 'data', 'users.json');

const REPORTS_DIR =
  process.env.VICEBOT_REPORTS_DIR || path.join(process.cwd(), 'data', 'reports');

const LOGO_PATH =
  process.env.VICEBOT_LOGO_PATH || path.join(process.cwd(), 'data', 'logo.png');

const KEEP_MAX = Number(process.env.VICEBOT_REPORTS_KEEP || 20);
const TZ = process.env.VICEBOT_TZ || 'America/Mexico_City';

// Color corporativo (naranja Viceroy)
const HEADER_COLOR = 'FFCC7722';
const HEADER_FONT_COLOR = 'FFFFFFFF';

// ──────────────────────────────────────────────────────────────
// Utilidades
// ──────────────────────────────────────────────────────────────

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
  if (!dateStr) return null;
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

function formatDateShort(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  if (Number.isNaN(d.getTime())) return dateStr;
  return d.toLocaleDateString('es-MX', {
    timeZone: TZ,
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
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
  if (s === 'done' || s === 'closed') return 'FF00FF00';      // Verde
  if (s === 'canceled' || s === 'cancelled') return 'FFFF0000'; // Rojo
  if (s === 'in_progress') return 'FFFFFF00';                  // Amarillo
  if (s === 'open') return 'FFB0E0E6';                         // Azul claro
  return null;
}

function prettyArea(area) {
  const map = {
    'it': 'IT',
    'man': 'MANTENIMIENTO',
    'ama': 'AMA DE LLAVES',
    'seg': 'SEGURIDAD',
    'rs': 'ROOM SERVICE',
    'exp': 'EXPERIENCIAS',
  };
  const a = String(area || '').toLowerCase();
  return map[a] || String(area || '').toUpperCase();
}

// ──────────────────────────────────────────────────────────────
// Carga de usuarios
// ──────────────────────────────────────────────────────────────

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

// ──────────────────────────────────────────────────────────────
// Base de datos
// ──────────────────────────────────────────────────────────────

function openSqlite() {
  const sqlite = require('better-sqlite3');
  const db = sqlite(DB_PATH);
  db.pragma('journal_mode = WAL');
  return db;
}

// ──────────────────────────────────────────────────────────────
// Agregar encabezado con logo a una hoja
// ──────────────────────────────────────────────────────────────

function addSheetHeader(workbook, worksheet, headerText, columnCount) {
  // Insertar fila de encabezado en la parte superior
  worksheet.spliceRows(1, 0, []);
  
  // Configurar altura de la fila del encabezado
  worksheet.getRow(1).height = 60;
  
  // Agregar logo si existe
  if (fs.existsSync(LOGO_PATH)) {
    try {
      const logoId = workbook.addImage({
        filename: LOGO_PATH,
        extension: 'png',
      });
      worksheet.addImage(logoId, {
        tl: { col: 0, row: 0 },
        br: { col: 1.5, row: 0.95 },
      });
    } catch (e) {
      if (DEBUG) console.warn('[EXPORT] Error adding logo:', e?.message);
    }
  }
  
  // Merge celdas para el título
  worksheet.mergeCells(1, 1, 1, columnCount);
  
  // Estilo del encabezado
  const headerCell = worksheet.getCell(1, 1);
  headerCell.value = headerText;
  headerCell.font = {
    bold: true,
    size: 14,
    color: { argb: HEADER_FONT_COLOR },
  };
  headerCell.alignment = {
    horizontal: 'center',
    vertical: 'middle',
  };
  headerCell.fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: HEADER_COLOR },
  };
  
  // La fila 2 ahora tiene los headers de columnas
  worksheet.getRow(2).font = { bold: true };
  worksheet.getRow(2).alignment = { vertical: 'middle', horizontal: 'center' };
  
  // Ajustar vista congelada para incluir encabezado
  worksheet.views = [{ state: 'frozen', ySplit: 2 }];
}

// ──────────────────────────────────────────────────────────────
// Construir texto de encabezado dinámico
// ──────────────────────────────────────────────────────────────

function buildHeaderText(filters = {}) {
  const { startDate, endDate, areas, statuses } = filters;
  
  const noFilters = !startDate && !endDate && 
                    (!areas || !areas.length) && 
                    (!statuses || !statuses.length);
  
  if (noFilters) {
    return 'REPORTE DE INCIDENCIAS — GLOBAL';
  }
  
  const parts = ['REPORTE DE INCIDENCIAS'];
  
  // Áreas
  if (areas?.length) {
    const areaLabels = areas.map(a => prettyArea(a));
    parts.push(areaLabels.join(', '));
  }
  
  // Fechas
  if (startDate && endDate) {
    parts.push(`${formatDateShort(startDate)} - ${formatDateShort(endDate)}`);
  } else if (startDate) {
    parts.push(`Desde ${formatDateShort(startDate)}`);
  } else if (endDate) {
    parts.push(`Hasta ${formatDateShort(endDate)}`);
  }
  
  // Estados
  if (statuses?.length) {
    const statusLabels = statuses.map(s => prettyStatus(s));
    parts.push(statusLabels.join(', '));
  }
  
  return parts.join(' | ');
}

// ──────────────────────────────────────────────────────────────
// Función principal de exportación
// ──────────────────────────────────────────────────────────────

/**
 * Exporta incidencias a XLSX con formato profesional
 * @param {object} filters - Filtros opcionales
 * @param {string} filters.startDate - Fecha inicio 'YYYY-MM-DD'
 * @param {string} filters.endDate - Fecha fin 'YYYY-MM-DD'
 * @param {string[]} filters.areas - Áreas ['it','man','ama',...]
 * @param {string[]} filters.statuses - Estados ['open','in_progress','done','canceled']
 * @returns {Promise<string>} Ruta del archivo generado
 */
async function exportXLSX(filters = {}) {
  const { startDate, endDate, areas, statuses } = filters;

  await fsp.mkdir(REPORTS_DIR, { recursive: true });

  const users = await loadUsers();
  const db = openSqlite();

  // ═══════════════════════════════════════════════════════════════
  // Construir query con filtros
  // ═══════════════════════════════════════════════════════════════
  
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

  // ═══════════════════════════════════════════════════════════════
  // Obtener incidencias
  // ═══════════════════════════════════════════════════════════════
  
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

  // ═══════════════════════════════════════════════════════════════
  // Obtener eventos relacionados
  // ═══════════════════════════════════════════════════════════════
  
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

  // ═══════════════════════════════════════════════════════════════
  // Crear workbook
  // ═══════════════════════════════════════════════════════════════
  
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Vicebot';
  workbook.created = new Date();

  const headerText = buildHeaderText(filters);
  const idToFolio = new Map(incidents.map(i => [i.id, i.folio || '']));

  // ═══════════════════════════════════════════════════════════════
  // HOJA 1: Incidencias
  // ═══════════════════════════════════════════════════════════════
  
  const wsInc = workbook.addWorksheet('Incidencias');
  wsInc.columns = [
    { header: 'Folio', key: 'folio', width: 14 },
    { header: 'Estado', key: 'status', width: 14 },
    { header: 'Área', key: 'area', width: 16 },
    { header: 'Lugar', key: 'lugar', width: 25 },
    { header: 'Descripción', key: 'desc', width: 50 },
    { header: 'Reportado Por', key: 'reportadoPor', width: 28 },
    { header: 'Fecha Creación', key: 'created', width: 18 },
    { header: 'Última Actualización', key: 'updated', width: 18 },
    { header: 'Adjuntos', key: 'attachments', width: 10 },
  ];

  // Agregar datos
  for (const inc of incidents) {
    const desc = String(inc.descripcion || inc.interpretacion || '').trim();
    const atts = safeParse(inc.attachments_json || '[]', []);
    const attachments = Array.isArray(atts) ? atts : [];
    const reportedBy = displayUser(users, inc.chat_id, inc.origin_name);

    const row = wsInc.addRow({
      folio: inc.folio || '',
      status: prettyStatus(inc.status),
      area: prettyArea(inc.area_destino),
      lugar: inc.lugar || '',
      desc,
      reportadoPor: reportedBy,
      created: formatDateTime(inc.created_at),
      updated: formatDateTime(inc.updated_at),
      attachments: attachments.length,
    });

    // Color de estado
    const fill = statusFill(inc.status);
    if (fill) {
      const cell = row.getCell(2);
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: fill } };
      cell.alignment = { vertical: 'middle', horizontal: 'center' };
    }
  }

  // Agregar encabezado con logo
  addSheetHeader(workbook, wsInc, headerText, 9);

  // ═══════════════════════════════════════════════════════════════
  // HOJA 2: Eventos / Historial
  // ═══════════════════════════════════════════════════════════════
  
  const wsEvents = workbook.addWorksheet('Historial');
  wsEvents.columns = [
    { header: 'Folio', key: 'folio', width: 14 },
    { header: 'Tipo de Evento', key: 'event_type', width: 22 },
    { header: 'Usuario', key: 'usuario', width: 28 },
    { header: 'Equipo', key: 'equipo', width: 14 },
    { header: 'Detalle', key: 'detalle', width: 55 },
    { header: 'Fecha', key: 'fecha', width: 18 },
  ];

  for (const e of events || []) {
    const payload = safeParse(e.payload_json || '{}', {});
    const usuario = payload?.by || payload?.usuario || payload?.user || '';
    const equipo = payload?.equipo || payload?.team || payload?.area || '';

    // Formatear detalle según tipo de evento
    let detalle = '';
    const eventType = String(e.event_type || '').toLowerCase();
    
    if (eventType === 'status_change') {
      const from = prettyStatus(payload?.from);
      const to = prettyStatus(payload?.to);
      detalle = `${from} → ${to}`;
    } else if (eventType === 'dispatched_to_groups') {
      detalle = `Enviado a grupos`;
    } else if (eventType === 'attachment_added') {
      detalle = `Adjunto: ${payload?.filename || 'archivo'}`;
    } else if (eventType === 'comment' || eventType === 'feedback') {
      detalle = payload?.comment || payload?.mensaje || payload?.text || '';
    } else if (eventType === 'confirmation') {
      detalle = `Confirmado por ${displayUser(users, usuario)}`;
    } else {
      detalle = typeof payload === 'object' ? JSON.stringify(payload) : String(payload || '');
    }

    wsEvents.addRow({
      folio: idToFolio.get(e.incident_id) || '',
      event_type: String(e.event_type || '').toUpperCase().replace(/_/g, ' '),
      usuario: displayUser(users, usuario),
      equipo: prettyArea(equipo),
      detalle,
      fecha: formatDateTime(e.created_at),
    });
  }

  addSheetHeader(workbook, wsEvents, headerText, 6);

  // ═══════════════════════════════════════════════════════════════
  // HOJA 3: Adjuntos
  // ═══════════════════════════════════════════════════════════════
  
  const wsAtt = workbook.addWorksheet('Adjuntos');
  wsAtt.columns = [
    { header: 'Folio', key: 'folio', width: 14 },
    { header: 'Archivo', key: 'filename', width: 30 },
    { header: 'Tipo', key: 'mimetype', width: 20 },
    { header: 'Tamaño', key: 'size', width: 12 },
    { header: 'URL', key: 'url', width: 55 },
    { header: 'Fecha', key: 'created_at', width: 18 },
  ];

  let hasAttachments = false;
  for (const inc of incidents) {
    const folio = inc.folio || '';
    const atts = safeParse(inc.attachments_json || '[]', []);
    const attachments = Array.isArray(atts) ? atts : [];
    
    for (const a of attachments) {
      hasAttachments = true;
      wsAtt.addRow({
        folio,
        filename: a?.filename || '',
        mimetype: a?.mimetype || '',
        size: a?.size ? `${Math.round(a.size / 1024)} KB` : '',
        url: a?.url || '',
        created_at: formatDateTime(a?.created_at || inc.created_at),
      });
    }
  }

  if (!hasAttachments) {
    wsAtt.addRow({
      folio: '',
      filename: 'No hay adjuntos en este reporte',
      mimetype: '',
      size: '',
      url: '',
      created_at: '',
    });
  }

  addSheetHeader(workbook, wsAtt, headerText, 6);

  // ═══════════════════════════════════════════════════════════════
  // HOJA 4: Resumen estadístico
  // ═══════════════════════════════════════════════════════════════
  
  const wsResumen = workbook.addWorksheet('Resumen');
  
  // Calcular estadísticas
  const stats = {
    total: incidents.length,
    byStatus: {},
    byArea: {},
  };
  
  for (const inc of incidents) {
    const status = String(inc.status || 'open').toLowerCase();
    const area = String(inc.area_destino || 'sin_area').toLowerCase();
    
    stats.byStatus[status] = (stats.byStatus[status] || 0) + 1;
    stats.byArea[area] = (stats.byArea[area] || 0) + 1;
  }

  wsResumen.columns = [
    { header: 'Métrica', key: 'metric', width: 25 },
    { header: 'Valor', key: 'value', width: 15 },
  ];

  wsResumen.addRow({ metric: 'TOTAL DE INCIDENCIAS', value: stats.total });
  wsResumen.addRow({ metric: '', value: '' });
  wsResumen.addRow({ metric: 'POR ESTADO', value: '' });
  
  for (const [status, count] of Object.entries(stats.byStatus)) {
    wsResumen.addRow({ metric: `  ${prettyStatus(status)}`, value: count });
  }
  
  wsResumen.addRow({ metric: '', value: '' });
  wsResumen.addRow({ metric: 'POR ÁREA', value: '' });
  
  for (const [area, count] of Object.entries(stats.byArea)) {
    wsResumen.addRow({ metric: `  ${prettyArea(area)}`, value: count });
  }

  addSheetHeader(workbook, wsResumen, headerText, 2);

  // ═══════════════════════════════════════════════════════════════
  // Guardar archivo
  // ═══════════════════════════════════════════════════════════════
  
  const ts = new Date().toISOString().replace(/[:.]/g, '').replace('T', '_').slice(0, 15);
  let filename = `incidencias_${ts}`;
  if (areas?.length) filename += `_${areas.join('-')}`;
  if (startDate && endDate) filename += `_${startDate.replace(/-/g, '')}-${endDate.replace(/-/g, '')}`;
  if (statuses?.length) filename += `_${statuses.join('-')}`;
  filename += `.xlsx`;

  const outPath = path.join(REPORTS_DIR, filename);
  await workbook.xlsx.writeFile(outPath);

  limpiarReportesAntiguos(REPORTS_DIR, KEEP_MAX);

  if (DEBUG) {
    console.log('[EXPORT] Reporte generado:', outPath);
  }

  return outPath;
}

// ──────────────────────────────────────────────────────────────
// Exports
// ──────────────────────────────────────────────────────────────

module.exports = { exportXLSX };

// ──────────────────────────────────────────────────────────────
// CLI: permite ejecutar desde línea de comandos
// node exportXLSX.js [startDate] [endDate] [area1] [area2] [status1] ...
// ──────────────────────────────────────────────────────────────

if (require.main === module) {
  const [,, start, end, ...rest] = process.argv;
  const validAreas = ['it', 'man', 'ama', 'seg', 'rs', 'exp'];
  const validStatuses = ['open', 'in_progress', 'done', 'canceled'];
  const areas = [];
  const statuses = [];

  rest.forEach(p => {
    const l = p.toLowerCase();
    if (validAreas.includes(l)) areas.push(l);
    if (validStatuses.includes(l)) statuses.push(l);
  });

  exportXLSX({
    startDate: start || undefined,
    endDate: end || undefined,
    areas: areas.length ? areas : undefined,
    statuses: statuses.length ? statuses : undefined,
  })
    .then(p => console.log('✅ Reporte generado en:', p))
    .catch(e => console.error('❌ Error:', e.message));
}
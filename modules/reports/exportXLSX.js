// modules/reports/exportXLSX.js
// ═══════════════════════════════════════════════════════════════════════════
// Exportador de reportes XLSX para Vicebot
// Versión 2.0 - Formato profesional mejorado
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

// ══════════════════════════════════════════════════════════════════════════
// ESTILOS CORPORATIVOS
// ══════════════════════════════════════════════════════════════════════════

const COLORS = {
  // Colores principales
  primary: 'CC7722',          // Naranja Viceroy (título principal)
  primaryDark: 'A65D00',      // Naranja oscuro (headers de columna)
  secondary: '2C3E50',        // Azul oscuro (textos secundarios)
  
  // Fondos
  lightGray: 'F8F9FA',        // Gris muy claro (filas alternas)
  mediumGray: 'E9ECEF',       // Gris medio (subtítulo)
  borderGray: 'DEE2E6',       // Gris para bordes
  
  // Estados
  statusOpen: 'E3F2FD',       // Azul claro - Abierto
  statusProgress: 'FFF8E1',   // Amarillo claro - En proceso
  statusDone: 'E8F5E9',       // Verde claro - Completado
  statusCanceled: 'FFEBEE',   // Rojo claro - Cancelado
  
  // Texto
  white: 'FFFFFF',
  black: '000000',
  textDark: '212529',
  textMuted: '6C757D',
};

// Estilos predefinidos
const STYLES = {
  // Título principal (Fila 1)
  titleCell: {
    font: { bold: true, size: 18, color: { argb: COLORS.white } },
    fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: COLORS.primary } },
    alignment: { horizontal: 'center', vertical: 'middle' },
  },
  
  // Subtítulo (Fila 2)
  subtitleCell: {
    font: { italic: true, size: 10, color: { argb: COLORS.textMuted } },
    fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: COLORS.mediumGray } },
    alignment: { horizontal: 'center', vertical: 'middle' },
  },
  
  // Headers de columna (Fila 3)
  headerCell: {
    font: { bold: true, size: 11, color: { argb: COLORS.white } },
    fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: COLORS.primaryDark } },
    alignment: { horizontal: 'center', vertical: 'middle', wrapText: true },
    border: {
      top: { style: 'medium', color: { argb: COLORS.primaryDark } },
      bottom: { style: 'medium', color: { argb: COLORS.primaryDark } },
      left: { style: 'thin', color: { argb: COLORS.primaryDark } },
      right: { style: 'thin', color: { argb: COLORS.primaryDark } },
    },
  },
  
  // Celdas de datos
  dataCell: {
    font: { size: 10, color: { argb: COLORS.textDark } },
    alignment: { vertical: 'middle', wrapText: true },
    border: {
      top: { style: 'thin', color: { argb: COLORS.borderGray } },
      bottom: { style: 'thin', color: { argb: COLORS.borderGray } },
      left: { style: 'thin', color: { argb: COLORS.borderGray } },
      right: { style: 'thin', color: { argb: COLORS.borderGray } },
    },
  },
  
  // Fila alterna (zebra)
  dataCellAlt: {
    fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: COLORS.lightGray } },
  },
};

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

function formatNow() {
  return new Date().toLocaleString('es-MX', {
    timeZone: TZ,
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
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

function statusFillColor(statusRaw) {
  const s = String(statusRaw || '').toLowerCase();
  if (s === 'done' || s === 'closed') return COLORS.statusDone;
  if (s === 'canceled' || s === 'cancelled') return COLORS.statusCanceled;
  if (s === 'in_progress') return COLORS.statusProgress;
  if (s === 'open') return COLORS.statusOpen;
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
  
  // Usar la ruta de la variable de entorno (seteada por el dashboard)
  const dbPath = process.env.VICEBOT_DB_PATH || DB_PATH;
  
  console.log('[exportXLSX] Opening DB at:', dbPath);
  console.log('[exportXLSX] File exists:', require('fs').existsSync(dbPath));
  
  const db = sqlite(dbPath);
  db.pragma('journal_mode = WAL');
  
  // Verificar tablas
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
  console.log('[exportXLSX] Tables in DB:', tables.map(t => t.name).join(', '));
  
  return db;
}

// ══════════════════════════════════════════════════════════════════════════
// FUNCIONES DE FORMATO MEJORADO
// ══════════════════════════════════════════════════════════════════════════

/**
 * Aplica estilo a una celda
 */
function applyStyle(cell, style) {
  if (style.font) cell.font = style.font;
  if (style.fill) cell.fill = style.fill;
  if (style.alignment) cell.alignment = style.alignment;
  if (style.border) cell.border = style.border;
}

/**
 * Construye el texto del subtítulo basado en los filtros
 */
function buildSubtitle(filters = {}) {
  const { startDate, endDate, areas, statuses } = filters;
  const parts = [];
  
  // Periodo
  if (startDate && endDate) {
    parts.push(`Periodo: ${formatDateShort(startDate)} - ${formatDateShort(endDate)}`);
  } else if (startDate) {
    parts.push(`Desde: ${formatDateShort(startDate)}`);
  } else if (endDate) {
    parts.push(`Hasta: ${formatDateShort(endDate)}`);
  } else {
    parts.push('Periodo: Todo el historial');
  }
  
  // Áreas
  if (areas?.length) {
    const areaLabels = areas.map(a => prettyArea(a));
    parts.push(`Áreas: ${areaLabels.join(', ')}`);
  } else {
    parts.push('Áreas: Todas');
  }
  
  // Estados
  if (statuses?.length) {
    const statusLabels = statuses.map(s => prettyStatus(s));
    parts.push(`Estados: ${statusLabels.join(', ')}`);
  }
  
  // Fecha de generación
  parts.push(`Generado: ${formatNow()}`);
  
  return parts.join('  │  ');
}

/**
 * Agrega encabezado profesional a una hoja
 * - Fila 1: Título principal (con logo opcional)
 * - Fila 2: Subtítulo con filtros y fecha
 * - Fila 3: Headers de columna estilizados
 */
function addProfessionalHeader(workbook, worksheet, config) {
  const {
    title = 'REPORTE DE INCIDENCIAS',
    subtitle = '',
    columnCount = 5,
    logoPath = null,
  } = config;
  
  // ─────────────────────────────────────────────────────────────
  // FILA 1: Título principal
  // ─────────────────────────────────────────────────────────────
  worksheet.spliceRows(1, 0, [], []);  // Insertar 2 filas vacías
  
  worksheet.getRow(1).height = 40;
  worksheet.mergeCells(1, 1, 1, columnCount);
  
  const titleCell = worksheet.getCell(1, 1);
  titleCell.value = `📊  ${title}`;
  applyStyle(titleCell, STYLES.titleCell);
  
  // Aplicar fondo a todas las celdas de fila 1
  for (let col = 1; col <= columnCount; col++) {
    const cell = worksheet.getCell(1, col);
    cell.fill = STYLES.titleCell.fill;
  }
  
  // Logo (opcional)
  if (logoPath && fs.existsSync(logoPath)) {
    try {
      const logoId = workbook.addImage({
        filename: logoPath,
        extension: 'png',
      });
      worksheet.addImage(logoId, {
        tl: { col: 0.1, row: 0.1 },
        ext: { width: 80, height: 35 },
      });
    } catch (e) {
      if (DEBUG) console.warn('[EXPORT] Error adding logo:', e?.message);
    }
  }
  
  // ─────────────────────────────────────────────────────────────
  // FILA 2: Subtítulo
  // ─────────────────────────────────────────────────────────────
  worksheet.getRow(2).height = 22;
  worksheet.mergeCells(2, 1, 2, columnCount);
  
  const subtitleCell = worksheet.getCell(2, 1);
  subtitleCell.value = subtitle;
  applyStyle(subtitleCell, STYLES.subtitleCell);
  
  // Aplicar fondo a todas las celdas de fila 2
  for (let col = 1; col <= columnCount; col++) {
    const cell = worksheet.getCell(2, col);
    cell.fill = STYLES.subtitleCell.fill;
  }
  
  // ─────────────────────────────────────────────────────────────
  // FILA 3: Headers de columna (ya existen, solo estilizar)
  // ─────────────────────────────────────────────────────────────
  worksheet.getRow(3).height = 28;
  
  for (let col = 1; col <= columnCount; col++) {
    const cell = worksheet.getCell(3, col);
    applyStyle(cell, STYLES.headerCell);
  }
  
  // Habilitar filtros automáticos en headers
  const lastCol = String.fromCharCode(64 + Math.min(columnCount, 26));
  worksheet.autoFilter = `A3:${lastCol}3`;
  
  // Congelar paneles (título + subtítulo + headers)
  worksheet.views = [{ state: 'frozen', ySplit: 3 }];
  
  return worksheet;
}

/**
 * Estiliza las filas de datos
 */
function styleDataRows(worksheet, startRow, endRow, columnCount) {
  for (let row = startRow; row <= endRow; row++) {
    const isAltRow = (row - startRow) % 2 === 1;
    
    for (let col = 1; col <= columnCount; col++) {
      const cell = worksheet.getCell(row, col);
      applyStyle(cell, STYLES.dataCell);
      
      // Zebra striping
      if (isAltRow) {
        cell.fill = STYLES.dataCellAlt.fill;
      }
    }
  }
}

/**
 * Aplica color de estado a la celda de status
 */
function applyStatusColor(cell, statusRaw) {
  const fillColor = statusFillColor(statusRaw);
  if (fillColor) {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: fillColor } };
    cell.font = { ...STYLES.dataCell.font, bold: true };
    cell.alignment = { horizontal: 'center', vertical: 'middle' };
  }
}

// ══════════════════════════════════════════════════════════════════════════
// FUNCIÓN PRINCIPAL DE EXPORTACIÓN
// ══════════════════════════════════════════════════════════════════════════

/**
 * Exporta incidencias a XLSX con formato profesional
 * @param {object} filters - Filtros opcionales
 * @param {string} filters.startDate - Fecha inicio 'YYYY-MM-DD'
 * @param {string} filters.endDate - Fecha fin 'YYYY-MM-DD'
 * @param {string[]} filters.areas - Áreas ['it','man','ama',...]
 * @param {string[]} filters.statuses - Estados ['open','in_progress','done','canceled']
 * @returns {Promise<string>} Ruta del archivo generado
 */
async function exportXLSX(filters = {}, externalDb = null) {
  const { startDate, endDate, areas, statuses } = filters;

  // ═══════════════════════════════════════════════════════════════
  // 🔥 LOG: Filtros recibidos
  // ═══════════════════════════════════════════════════════════════
  console.log('[exportXLSX] ═══════════════════════════════════════');
  console.log('[exportXLSX] Filtros recibidos:', JSON.stringify(filters, null, 2));
  console.log('[exportXLSX] startDate:', startDate);
  console.log('[exportXLSX] endDate:', endDate);
  console.log('[exportXLSX] areas:', areas, '(type:', typeof areas, ', isArray:', Array.isArray(areas), ')');
  console.log('[exportXLSX] statuses:', statuses, '(type:', typeof statuses, ', isArray:', Array.isArray(statuses), ')');
  console.log('[exportXLSX] ═══════════════════════════════════════');

  await fsp.mkdir(REPORTS_DIR, { recursive: true });

  const users = await loadUsers();
  const db = externalDb || openSqlite();
  const shouldCloseDb = !externalDb;

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
  // 🔥 LOG: Query construida
  // ═══════════════════════════════════════════════════════════════
  console.log('[exportXLSX] ───────────────────────────────────────');
  console.log('[exportXLSX] WHERE clauses:', clauses);
  console.log('[exportXLSX] WHERE string:', where);
  console.log('[exportXLSX] Params:', JSON.stringify(params, null, 2));
  console.log('[exportXLSX] ───────────────────────────────────────');

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

  // ═══════════════════════════════════════════════════════════════
  // 🔥 LOG: Resultados
  // ═══════════════════════════════════════════════════════════════
  console.log('[exportXLSX] ───────────────────────────────────────');
  console.log('[exportXLSX] Incidencias encontradas:', incidents.length);
  if (incidents.length > 0) {
    console.log('[exportXLSX] Primera incidencia:', {
      folio: incidents[0].folio,
      status: incidents[0].status,
      area: incidents[0].area_destino,
      created_at: incidents[0].created_at
    });
    console.log('[exportXLSX] Estados en resultados:', [...new Set(incidents.map(i => i.status))].join(', '));
    console.log('[exportXLSX] Áreas en resultados:', [...new Set(incidents.map(i => i.area_destino))].join(', '));
  }
  console.log('[exportXLSX] ───────────────────────────────────────');

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

  const subtitle = buildSubtitle(filters);
  const idToFolio = new Map(incidents.map(i => [i.id, i.folio || '']));
  
  // Mapas para resolver usuarios en eventos
  const idToChatId = new Map(incidents.map(i => [i.id, i.chat_id || '']));
  const idToOriginName = new Map(incidents.map(i => [i.id, i.origin_name || '']));

  // ═══════════════════════════════════════════════════════════════
  // HOJA 1: Incidencias
  // ═══════════════════════════════════════════════════════════════
  
  const wsInc = workbook.addWorksheet('Incidencias');
  const incColumns = [
    { header: 'Folio', key: 'folio', width: 14 },
    { header: 'Estado', key: 'status', width: 14 },
    { header: 'Área', key: 'area', width: 18 },
    { header: 'Lugar', key: 'lugar', width: 22 },
    { header: 'Descripción', key: 'desc', width: 45 },
    { header: 'Reportado Por', key: 'reportadoPor', width: 26 },
    { header: 'Fecha Creación', key: 'created', width: 18 },
    { header: 'Última Actualización', key: 'updated', width: 18 },
    { header: 'Adj.', key: 'attachments', width: 6 },
  ];
  
  wsInc.columns = incColumns;

  // Agregar datos
  const incDataStartRow = 2;
  for (const inc of incidents) {
    const desc = String(inc.descripcion || inc.interpretacion || '').trim();
    const atts = safeParse(inc.attachments_json || '[]', []);
    const attachments = Array.isArray(atts) ? atts : [];
    const reportedBy = displayUser(users, inc.chat_id, inc.origin_name);

    wsInc.addRow({
      folio: inc.folio || '',
      status: prettyStatus(inc.status),
      area: prettyArea(inc.area_destino),
      lugar: inc.lugar || '',
      desc,
      reportadoPor: reportedBy,
      created: formatDateTime(inc.created_at),
      updated: formatDateTime(inc.updated_at),
      attachments: attachments.length || '',
    });
  }

  // Aplicar encabezado profesional
  addProfessionalHeader(workbook, wsInc, {
    title: 'REPORTE DE INCIDENCIAS',
    subtitle,
    columnCount: incColumns.length,
    logoPath: fs.existsSync(LOGO_PATH) ? LOGO_PATH : null,
  });

  // Estilizar filas de datos (ahora empiezan en fila 4)
  const incDataEndRow = 3 + incidents.length;
  styleDataRows(wsInc, 4, incDataEndRow, incColumns.length);

  // Aplicar colores de estado
  for (let row = 4; row <= incDataEndRow; row++) {
    const statusCell = wsInc.getCell(row, 2);
    const statusValue = incidents[row - 4]?.status;
    applyStatusColor(statusCell, statusValue);
  }

  // ═══════════════════════════════════════════════════════════════
  // HOJA 2: Eventos / Historial
  // ═══════════════════════════════════════════════════════════════
  
  const wsEvents = workbook.addWorksheet('Historial');
  const eventColumns = [
    { header: 'Folio', key: 'folio', width: 14 },
    { header: 'Tipo de Evento', key: 'event_type', width: 22 },
    { header: 'Usuario', key: 'usuario', width: 26 },
    { header: 'Equipo', key: 'equipo', width: 16 },
    { header: 'Detalle', key: 'detalle', width: 50 },
    { header: 'Fecha', key: 'fecha', width: 18 },
  ];
  
  wsEvents.columns = eventColumns;

  for (const e of events || []) {
    const payload = safeParse(e.payload_json || '{}', {});
    const eventType = String(e.event_type || '').toLowerCase();
    
    // ─────────────────────────────────────────────────────────────
    // Resolver usuario de múltiples fuentes
    // ─────────────────────────────────────────────────────────────
    let usuarioRaw = payload?.by || payload?.usuario || payload?.user || payload?.author || '';
    let usuarioResuelto = '';
    
    // Primero verificar si hay un nombre guardado en el payload (eventos nuevos)
    if (payload?.author_name) {
      usuarioResuelto = payload.author_name;
    } else if (payload?.by_name) {
      usuarioResuelto = payload.by_name;
    } else if (usuarioRaw && usuarioRaw.includes('@lid')) {
      // Es un LID sin nombre guardado - no podemos resolverlo
      usuarioResuelto = 'Miembro del equipo';
    } else if (usuarioRaw && usuarioRaw.includes('@c.us')) {
      // Es un ID de teléfono, buscar en users
      usuarioResuelto = displayUser(users, usuarioRaw);
    } else if (usuarioRaw) {
      // Es un nombre directo
      usuarioResuelto = usuarioRaw;
    }
    
    // Si no hay usuario pero es un evento del solicitante (role: requester), 
    // usar el chat_id de la incidencia
    if (!usuarioResuelto && payload?.role === 'requester') {
      const incidentChatId = idToChatId.get(e.incident_id);
      const incidentOriginName = idToOriginName.get(e.incident_id);
      if (incidentChatId) {
        usuarioResuelto = displayUser(users, incidentChatId, incidentOriginName);
      }
    }
    
    // Si aún no hay usuario pero es feedback/comentario sin rol especificado,
    // asumir que es del solicitante
    if (!usuarioResuelto && (eventType === 'feedback' || payload?.kind === 'feedback')) {
      const incidentChatId = idToChatId.get(e.incident_id);
      const incidentOriginName = idToOriginName.get(e.incident_id);
      if (incidentChatId) {
        usuarioResuelto = displayUser(users, incidentChatId, incidentOriginName);
      }
    }
    
    // Extraer equipo/área
    let equipo = payload?.equipo || payload?.team || payload?.area || '';
    
    // Construir detalle según tipo de evento y estructura del payload
    let detalle = '';
    let tipoEvento = String(e.event_type || '').toUpperCase().replace(/_/g, ' ');
    
    // ─────────────────────────────────────────────────────────────
    // Detectar estructura del payload para mejor interpretación
    // ─────────────────────────────────────────────────────────────
    
    if (payload?.newStatus) {
      // Cambio de estado (estructura con newStatus)
      const newStatus = prettyStatus(payload.newStatus);
      const oldStatus = payload.oldStatus ? prettyStatus(payload.oldStatus) : null;
      const source = payload.source || '';
      const text = payload.text || '';
      
      tipoEvento = 'CAMBIO DE ESTADO';
      
      if (oldStatus) {
        detalle = `${oldStatus} → ${newStatus}`;
      } else {
        detalle = `→ ${newStatus}`;
      }
      
      if (text) {
        detalle += ` | "${text}"`;
      }
      
      if (source === 'quoted_message') {
        detalle += ' (vía respuesta)';
      }
      
    } else if (payload?.kind === 'feedback' || payload?.role) {
      // Feedback/comentario estructurado
      const role = payload.role || '';
      const kind = payload.kind || '';
      const polarity = payload.polarity || '';
      const rawText = payload.raw_text || '';
      const note = payload.note || '';
      const via = payload.via || '';
      
      // Determinar tipo de evento más descriptivo
      if (kind === 'feedback') {
        tipoEvento = role === 'requester' ? 'COMENTARIO SOLICITANTE' : 'COMENTARIO';
      }
      
      // Construir detalle
      if (rawText) {
        detalle = `"${rawText}"`;
      }
      
      if (note && note !== rawText) {
        detalle += detalle ? ` — ${note}` : note;
      }
      
      // Agregar indicador de polaridad si es relevante
      if (polarity && polarity !== 'neutral') {
        const polarityIcon = polarity === 'positive' ? '👍' : polarity === 'negative' ? '👎' : '';
        if (polarityIcon) detalle = `${polarityIcon} ${detalle}`;
      }
      
      // Indicar vía si es relevante
      if (via === 'reply_folio') {
        detalle += ' (respuesta a folio)';
      }
      
    } else if (eventType === 'status_change') {
      // Cambio de estado (estructura legacy con from/to)
      const from = prettyStatus(payload?.from);
      const to = prettyStatus(payload?.to);
      detalle = `${from} → ${to}`;
      
    } else if (eventType === 'dispatched_to_groups') {
      const groups = payload?.groups || payload?.groupIds || [];
      if (Array.isArray(groups) && groups.length) {
        detalle = `Enviado a ${groups.length} grupo(s)`;
      } else {
        detalle = 'Enviado a grupos';
      }
      
    } else if (eventType === 'attachment_added') {
      const filename = payload?.filename || payload?.name || 'archivo';
      const mimetype = payload?.mimetype || '';
      detalle = `Adjunto: ${filename}`;
      if (mimetype) {
        const typeShort = mimetype.split('/')[0];
        if (typeShort === 'image') detalle = `📷 ${detalle}`;
        else if (typeShort === 'video') detalle = `🎥 ${detalle}`;
        else if (typeShort === 'audio') detalle = `🔊 ${detalle}`;
        else detalle = `📎 ${detalle}`;
      }
      
    } else if (eventType === 'comment' || eventType === 'feedback') {
      detalle = payload?.comment || payload?.mensaje || payload?.text || payload?.raw_text || '';
      
    } else if (eventType === 'confirmation') {
      detalle = `Confirmado por ${usuarioResuelto || 'usuario'}`;
      
    } else if (eventType === 'created') {
      detalle = payload?.descripcion || payload?.description || 'Incidencia creada';
      
    } else {
      // Fallback: intentar extraer información útil del payload
      const usefulFields = ['text', 'message', 'descripcion', 'comment', 'note', 'raw_text'];
      for (const field of usefulFields) {
        if (payload?.[field]) {
          detalle = String(payload[field]);
          break;
        }
      }
      
      // Si no encontró nada útil, mostrar JSON resumido (sin campos técnicos)
      if (!detalle && typeof payload === 'object' && Object.keys(payload).length > 0) {
        const cleanPayload = { ...payload };
        // Remover campos técnicos que no aportan al usuario
        delete cleanPayload.ts;
        delete cleanPayload.confidence;
        delete cleanPayload.wa_msg_id;
        delete cleanPayload.source;
        delete cleanPayload.via;
        
        if (Object.keys(cleanPayload).length > 0) {
          detalle = JSON.stringify(cleanPayload);
        }
      }
    }

    wsEvents.addRow({
      folio: idToFolio.get(e.incident_id) || '',
      event_type: tipoEvento,
      usuario: usuarioResuelto || '',
      equipo: prettyArea(equipo),
      detalle: detalle || '',
      fecha: formatDateTime(e.created_at),
    });
  }

  addProfessionalHeader(workbook, wsEvents, {
    title: 'HISTORIAL DE EVENTOS',
    subtitle,
    columnCount: eventColumns.length,
  });

  const eventsDataEndRow = 3 + (events?.length || 0);
  styleDataRows(wsEvents, 4, eventsDataEndRow, eventColumns.length);

  // ═══════════════════════════════════════════════════════════════
  // HOJA 3: Adjuntos
  // ═══════════════════════════════════════════════════════════════
  
  const wsAtt = workbook.addWorksheet('Adjuntos');
  const attColumns = [
    { header: 'Folio', key: 'folio', width: 14 },
    { header: 'Archivo', key: 'filename', width: 30 },
    { header: 'Tipo', key: 'mimetype', width: 18 },
    { header: 'Tamaño', key: 'size', width: 12 },
    { header: 'URL', key: 'url', width: 50 },
    { header: 'Fecha', key: 'created_at', width: 18 },
  ];
  
  wsAtt.columns = attColumns;

  let attachmentCount = 0;
  for (const inc of incidents) {
    const folio = inc.folio || '';
    const atts = safeParse(inc.attachments_json || '[]', []);
    const attachments = Array.isArray(atts) ? atts : [];
    
    for (const a of attachments) {
      attachmentCount++;
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

  if (attachmentCount === 0) {
    wsAtt.addRow({
      folio: '',
      filename: 'No hay adjuntos en este reporte',
      mimetype: '',
      size: '',
      url: '',
      created_at: '',
    });
    attachmentCount = 1;
  }

  addProfessionalHeader(workbook, wsAtt, {
    title: 'ADJUNTOS',
    subtitle,
    columnCount: attColumns.length,
  });

  styleDataRows(wsAtt, 4, 3 + attachmentCount, attColumns.length);

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
    { header: 'Métrica', key: 'metric', width: 28 },
    { header: 'Valor', key: 'value', width: 15 },
  ];

  wsResumen.addRow({ metric: 'TOTAL DE INCIDENCIAS', value: stats.total });
  wsResumen.addRow({ metric: '', value: '' });
  wsResumen.addRow({ metric: '📊 POR ESTADO', value: '' });
  
  for (const [status, count] of Object.entries(stats.byStatus)) {
    wsResumen.addRow({ metric: `    ${prettyStatus(status)}`, value: count });
  }
  
  wsResumen.addRow({ metric: '', value: '' });
  wsResumen.addRow({ metric: '🏷️ POR ÁREA', value: '' });
  
  for (const [area, count] of Object.entries(stats.byArea)) {
    wsResumen.addRow({ metric: `    ${prettyArea(area)}`, value: count });
  }

  addProfessionalHeader(workbook, wsResumen, {
    title: 'RESUMEN ESTADÍSTICO',
    subtitle,
    columnCount: 2,
  });

  const resumenRows = 2 + Object.keys(stats.byStatus).length + 2 + Object.keys(stats.byArea).length + 2;
  styleDataRows(wsResumen, 4, 3 + resumenRows, 2);

  // Estilizar fila de total
  const totalRow = wsResumen.getRow(4);
  totalRow.font = { bold: true, size: 12 };

  // ═══════════════════════════════════════════════════════════════
  // Guardar archivo
  // ═══════════════════════════════════════════════════════════════
  
  const now = new Date();
  const dateStr = now.toISOString().slice(0, 10).replace(/-/g, ''); // YYYYMMDD
  const timeStr = now.toTimeString().slice(0, 5).replace(':', ''); // HHMM

  let filename = `incidencias_${dateStr}_${timeStr}`;

  // Solo agregar filtros si NO son todos
  const todasAreas = ['man', 'it', 'ama', 'rs', 'seg', 'exp'];
  const todosEstados = ['open', 'in_progress', 'done', 'canceled'];

  // Áreas
  if (areas?.length && areas.length < todasAreas.length) {
    const areasShort = areas.slice(0, 3).join('-');
    filename += `_${areasShort}${areas.length > 3 ? '+' : ''}`;
  }

  // Periodo
  if (startDate && endDate) {
    const start = startDate.slice(5).replace('-', ''); // MMDD
    const end = endDate.slice(5).replace('-', '');     // MMDD
    filename += `_${start}-${end}`;
  } else if (startDate) {
    filename += `_desde${startDate.slice(5).replace('-', '')}`;
  } else if (endDate) {
    filename += `_hasta${endDate.slice(5).replace('-', '')}`;
  }

  // Estados (solo si no son todos)
  if (statuses?.length && statuses.length < todosEstados.length) {
    const statusesShort = statuses.map(s => {
      if (s === 'open') return 'abierto';
      if (s === 'in_progress') return 'proceso';
      if (s === 'done') return 'hecho';
      if (s === 'canceled') return 'cancelado';
      return s;
    }).slice(0, 2).join('-');
    filename += `_${statusesShort}${statuses.length > 2 ? '+' : ''}`;
  }

  filename += `.xlsx`;

  const outPath = path.join(REPORTS_DIR, filename);
  await workbook.xlsx.writeFile(outPath);

  limpiarReportesAntiguos(REPORTS_DIR, KEEP_MAX);

  if (DEBUG) {
    console.log('[EXPORT] Reporte generado:', outPath);
  }
  if (shouldCloseDb && db) {
    db.close();
  }
  return outPath;
}

// ──────────────────────────────────────────────────────────────
// Exports
// ──────────────────────────────────────────────────────────────

module.exports = { exportXLSX };

// ──────────────────────────────────────────────────────────────
// CLI
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
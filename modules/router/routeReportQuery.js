// modules/router/routeReportQuery.js
// ═══════════════════════════════════════════════════════════════════════════
// Router para solicitudes de reportes en lenguaje natural
// Detecta cuando el usuario quiere generar un reporte Excel
// ═══════════════════════════════════════════════════════════════════════════

const fs = require('fs');
const path = require('path');
const { MessageMedia } = require('whatsapp-web.js');

const DEBUG = (process.env.VICEBOT_DEBUG || '1') === '1';

// ──────────────────────────────────────────────────────────────
// Imports
// ──────────────────────────────────────────────────────────────

let reportAI = null;
try {
  reportAI = require('../ai/reportQueryInterpreter');
} catch (e) {
  if (DEBUG) console.warn('[REPORT-QUERY] reportQueryInterpreter not available:', e?.message);
}

let exportXLSX = null;
try {
  ({ exportXLSX } = require('../reports/exportXLSX'));
} catch (e) {
  if (DEBUG) console.warn('[REPORT-QUERY] exportXLSX not available:', e?.message);
}

// ──────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────

function isGroupId(id) {
  return /@g\.us$/.test(String(id || ''));
}

function prettyArea(area) {
  const map = {
    'it': 'IT',
    'man': 'Mantenimiento',
    'ama': 'Ama de Llaves',
    'seg': 'Seguridad',
    'rs': 'Room Service',
    'exp': 'Experiencias',
  };
  const a = String(area || '').toLowerCase();
  return map[a] || String(area || '').toUpperCase();
}

function prettyStatus(status) {
  const map = {
    'open': 'Abiertos',
    'in_progress': 'En Proceso',
    'done': 'Completados',
    'canceled': 'Cancelados',
  };
  const s = String(status || '').toLowerCase();
  return map[s] || String(status || '').toUpperCase();
}

function formatDateShort(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  if (Number.isNaN(d.getTime())) return dateStr;
  return d.toLocaleDateString('es-MX', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  });
}

// ──────────────────────────────────────────────────────────────
// Safe Reply
// ──────────────────────────────────────────────────────────────

let safeReply = null;
try {
  ({ safeReply } = require('../core/safeReply'));
} catch {}

async function replySafe(msg, text) {
  if (!text) return false;
  try {
    if (safeReply) return await safeReply(msg, text);
    await msg.reply(text);
    return true;
  } catch (e) {
    if (DEBUG) console.warn('[REPORT-QUERY] replySafe err', e?.message);
    return false;
  }
}

// ──────────────────────────────────────────────────────────────
// Handler principal
// ──────────────────────────────────────────────────────────────

/**
 * Maneja solicitudes de reportes en lenguaje natural
 * @param {object} client - Cliente de WhatsApp
 * @param {object} msg - Mensaje
 * @param {object} options - Opciones adicionales
 * @returns {boolean} true si manejó el mensaje
 */
async function maybeHandleReportQuery(client, msg, options = {}) {
  const chatId = msg.from;
  const body = String(msg.body || '').trim();
  const isGroup = isGroupId(chatId);
  
  // Solo permitir reportes en DM (no en grupos)
  if (isGroup) {
    return false;
  }
  
  // ═══════════════════════════════════════════════════════════════
  // Ignorar mensajes que parecen selecciones de menú (1-9)
  // Estos deben ser manejados por routeRequesterReply
  // ═══════════════════════════════════════════════════════════════
  if (/^\s*[1-9]\s*$/.test(body)) {
    return false;
  }
  
  // Verificar que tengamos los módulos necesarios
  if (!reportAI || !exportXLSX) {
    if (DEBUG) console.warn('[REPORT-QUERY] Missing required modules');
    return false;
  }
  
  // ═══════════════════════════════════════════════════════════════
  // Interpretar con IA
  // ═══════════════════════════════════════════════════════════════
  
  let result;
  try {
    result = await reportAI.interpret(body);
  } catch (e) {
    if (DEBUG) console.warn('[REPORT-QUERY] interpret error:', e?.message);
    return false;
  }
  
  // Si no es solicitud de reporte, no manejar
  if (!result || !result.is_report_request) {
    return false;
  }
  
  if (DEBUG) {
    console.log('[REPORT-QUERY] processing', {
      chatId: chatId.substring(0, 15),
      areas: result.areas,
      statuses: result.statuses,
      startDate: result.start_date,
      endDate: result.end_date,
    });
  }
  
  // ═══════════════════════════════════════════════════════════════
  // Construir mensaje de confirmación
  // ═══════════════════════════════════════════════════════════════
  
  const filters = {
    startDate: result.start_date || null,
    endDate: result.end_date || null,
    areas: result.areas || null,
    statuses: result.statuses || null,
  };
  
  const confirmLines = ['📄 *Generando reporte XLSX...*', ''];
  
  // Fechas
  if (filters.startDate && filters.endDate) {
    if (filters.startDate === filters.endDate) {
      confirmLines.push(`📅 *Fecha:* ${formatDateShort(filters.startDate)}`);
    } else {
      confirmLines.push(`📅 *Fechas:* ${formatDateShort(filters.startDate)} — ${formatDateShort(filters.endDate)}`);
    }
  } else {
    confirmLines.push(`📅 *Fechas:* Todas (global)`);
  }
  
  // Áreas
  if (filters.areas && filters.areas.length > 0) {
    const areaNames = filters.areas.map(a => prettyArea(a));
    confirmLines.push(`🏷️ *Áreas:* ${areaNames.join(', ')}`);
  } else {
    confirmLines.push(`🏷️ *Áreas:* Todas`);
  }
  
  // Estados
  if (filters.statuses && filters.statuses.length > 0) {
    const statusNames = filters.statuses.map(s => prettyStatus(s));
    confirmLines.push(`📊 *Estados:* ${statusNames.join(', ')}`);
  } else {
    confirmLines.push(`📊 *Estados:* Todos`);
  }
  
  confirmLines.push('');
  confirmLines.push('_Espera un momento..._');
  
  await replySafe(msg, confirmLines.join('\n'));
  
  // ═══════════════════════════════════════════════════════════════
  // Generar reporte
  // ═══════════════════════════════════════════════════════════════
  
  try {
    const outputPath = await exportXLSX(filters);
    
    // Enviar archivo
    const data = fs.readFileSync(outputPath, 'base64');
    const media = new MessageMedia(
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      data,
      path.basename(outputPath)
    );
    
    await client.sendMessage(chatId, media);
    
    await replySafe(msg, `✅ *Reporte generado:* ${path.basename(outputPath)}`);
    
    if (DEBUG) {
      console.log('[REPORT-QUERY] Report sent:', outputPath);
    }
    
    return true;
    
  } catch (e) {
    if (DEBUG) console.error('[REPORT-QUERY] Export error:', e?.message || e);
    
    const errorMsg = e?.message || 'Error desconocido';
    
    if (errorMsg.includes('No hay incidencias')) {
      await replySafe(msg, 
        '📭 *No se encontraron incidencias* con los filtros especificados.\n\n' +
        '💡 Prueba con otros filtros:\n' +
        '• "reporte de hoy"\n' +
        '• "reporte de IT"\n' +
        '• "exportar todos los pendientes"'
      );
    } else {
      await replySafe(msg, `❌ *Error al generar el reporte:* ${errorMsg}`);
    }
    
    return true; // Manejamos el mensaje aunque haya error
  }
}

// ──────────────────────────────────────────────────────────────
// Exports
// ──────────────────────────────────────────────────────────────

module.exports = {
  maybeHandleReportQuery,
};
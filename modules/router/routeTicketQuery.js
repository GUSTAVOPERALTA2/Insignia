// modules/router/routeTicketQuery.js
// Router para consultas de tickets con lenguaje natural
// Maneja consultas como "muéstrame tickets pendientes de mantenimiento de hoy"

const DEBUG = (process.env.VICEBOT_DEBUG || '1') === '1';
const PAGE_SIZE = parseInt(process.env.VICEBOT_TICKETS_PAGE_SIZE || '10', 10);

const path = require('path');
const fs = require('fs');

// ──────────────────────────────────────────────────────────────
// Imports
// ──────────────────────────────────────────────────────────────

const { parseTicketQuery, buildQueryLabel } = require('../ai/ticketQueryNL');

let incidenceDB = null;
try {
  incidenceDB = require('../db/incidenceDB');
} catch (e) {
  if (DEBUG) console.warn('[TICKET-QUERY] incidenceDB not available:', e?.message);
}

let groupRouter = null;
try {
  groupRouter = require('../groups/groupRouter');
} catch (e) {
  if (DEBUG) console.warn('[TICKET-QUERY] groupRouter not available:', e?.message);
}

// ──────────────────────────────────────────────────────────────
// Cache de usuarios (para obtener team del usuario)
// ──────────────────────────────────────────────────────────────

let usersCache = null;
let usersCacheTime = 0;
const USERS_CACHE_TTL = 60000;

function loadUsersCache() {
  const now = Date.now();
  if (usersCache && (now - usersCacheTime) < USERS_CACHE_TTL) {
    return usersCache;
  }
  
  try {
    const usersPath = process.env.USERS_PATH || './data/users.json';
    const fullPath = path.resolve(process.cwd(), usersPath);
    
    if (fs.existsSync(fullPath)) {
      const data = fs.readFileSync(fullPath, 'utf8');
      usersCache = JSON.parse(data);
      usersCacheTime = now;
    }
  } catch (e) {
    if (DEBUG) console.warn('[TICKET-QUERY] loadUsersCache err:', e?.message);
  }
  
  return usersCache || {};
}

function getUserTeam(chatId) {
  const users = loadUsersCache();
  const user = users[chatId];
  return user?.team || null;
}

function getUserName(chatId) {
  const users = loadUsersCache();
  const user = users[chatId];
  return user?.nombre || user?.name || null;
}

// ──────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────

function isGroupId(id) {
  return /@g\.us$/.test(String(id || ''));
}

function formatDateTime(isoString) {
  if (!isoString) return '—';
  const d = new Date(isoString);
  if (Number.isNaN(d.getTime())) return String(isoString);
  
  return d.toLocaleString('es-MX', {
    timeZone: process.env.VICEBOT_TZ || 'America/Mexico_City',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatStatus(statusRaw) {
  const s = String(statusRaw || 'open').toLowerCase();
  if (s === 'open') return { emoji: '🟢', label: 'Abierto' };
  if (s === 'in_progress') return { emoji: '🟡', label: 'En proceso' };
  if (s === 'awaiting_confirmation') return { emoji: '🟣', label: 'Por confirmar' };
  if (s === 'done' || s === 'closed') return { emoji: '✅', label: 'Completado' };
  if (s === 'canceled' || s === 'cancelled') return { emoji: '⛔', label: 'Cancelado' };
  return { emoji: '⚪', label: s || 'desconocido' };
}

function formatTicketList(items, { page, pageSize, label, isGroup = false }) {
  if (!items.length) {
    const lines = [
      `📋 *${label}*`,
      '',
      'No encontré tickets con esos filtros.',
      '',
      '💡 *Prueba con:*',
    ];
    
    if (isGroup) {
      lines.push('• "tickets pendientes"');
      lines.push('• "tickets completados de hoy"');
      lines.push('• "buscar cocina"');
    } else {
      lines.push('• "tickets abiertos de mantenimiento"');
      lines.push('• "mis tickets pendientes"');
      lines.push('• "tickets de IT de hoy"');
      lines.push('• "todos los tickets cerrados"');
    }
    
    return lines.join('\n');
  }
  
  const lines = [];
  lines.push(`📋 *${label}* (pág. ${page})`);
  lines.push('');
  
  const startIndex = (page - 1) * pageSize;
  
  items.forEach((t, idx) => {
    const n = startIndex + idx + 1;
    const folio = t.folio || (t.id ? String(t.id).slice(0, 8) : 'SIN-FOLIO');
    const st = formatStatus(t.status);
    const lugar = (t.lugar || '').trim() || '(sin lugar)';
    const baseDesc = (t.descripcion || t.interpretacion || '').trim() || '(sin descripción)';
    const desc = baseDesc.length > 60 ? baseDesc.slice(0, 57) + '…' : baseDesc;
    
    lines.push(`${n}. *${folio}* ${st.emoji}`);
    lines.push(`   📍 ${lugar}`);
    lines.push(`   ${desc}`);
    lines.push('');
  });
  
  // Footer con navegación
  const hasMore = items.length >= pageSize;
  
  lines.push('─────────────────');
  if (hasMore) {
    lines.push(`📄 Página ${page + 1}: di "página ${page + 1}" o "más"`);
  }
  lines.push('🔍 Detalle: di "detalle FOLIO"');
  
  if (isGroup) {
    lines.push('');
    lines.push('📩 _Para consultas de otras áreas, envía DM directo._');
  }
  
  return lines.join('\n');
}

function formatTicketDetail(inc) {
  if (!inc) return 'No encontré ese ticket. Verifica el folio.';
  
  const folio = inc.folio || inc.id || 'Ticket';
  const st = formatStatus(inc.status);
  
  const lines = [];
  lines.push(`🎫 *${folio}* ${st.emoji} _${st.label}_`);
  lines.push('');
  
  if (inc.lugar) lines.push(`📍 *Lugar:* ${inc.lugar}`);
  if (inc.area_destino) {
    const areaLabels = {
      'it': 'IT', 'man': 'Mantenimiento', 'ama': 'Housekeeping',
      'seg': 'Seguridad', 'rs': 'Room Service', 'exp': 'Experiencia',
    };
    lines.push(`🏷️ *Área:* ${areaLabels[inc.area_destino] || inc.area_destino}`);
  }
  
  const descTxt = (inc.descripcion || inc.interpretacion || '').trim();
  if (descTxt) {
    lines.push('');
    lines.push('📝 *Descripción:*');
    lines.push(descTxt);
  }
  
  lines.push('');
  if (inc.created_at) {
    lines.push(`🕒 *Creado:* ${formatDateTime(inc.created_at)}`);
  }
  if (inc.updated_at && inc.updated_at !== inc.created_at) {
    lines.push(`♻️ *Actualizado:* ${formatDateTime(inc.updated_at)}`);
  }
  
  // Origen
  if (inc.origin_name) {
    lines.push(`👤 *Reportado por:* ${inc.origin_name}`);
  }
  
  return lines.join('\n');
}

function formatTicketCount(count, label) {
  return [
    `📊 *Conteo de Tickets*`,
    '',
    `${label}: *${count}* ticket${count !== 1 ? 's' : ''}`,
  ].join('\n');
}

// ──────────────────────────────────────────────────────────────
// Safe Reply
// ──────────────────────────────────────────────────────────────

let safeReply = null;
try {
  ({ safeReply } = require('../utils/safeReply'));
} catch {}

async function replySafe(msg, text) {
  if (!text) return false;
  try {
    if (safeReply) return await safeReply(msg, text);
    await msg.reply(text);
    return true;
  } catch (e) {
    if (DEBUG) console.warn('[TICKET-QUERY] replySafe err', e?.message);
    return false;
  }
}

// ──────────────────────────────────────────────────────────────
// Ejecutar consulta
// ──────────────────────────────────────────────────────────────

async function executeQuery(query) {
  if (!incidenceDB) {
    return { items: [], total: 0, error: 'DB not available' };
  }
  
  const { status, areas, dateRange, searchText, folio, onlyMine, page, context } = query;
  
  // Consulta de detalle por folio
  if (folio && query.queryType === 'detail') {
    try {
      const inc = await incidenceDB.getIncidentByFolio(folio);
      return { item: inc, queryType: 'detail' };
    } catch (e) {
      if (DEBUG) console.warn('[TICKET-QUERY] getIncidentByFolio err:', e?.message);
      return { item: null, queryType: 'detail' };
    }
  }
  
  try {
    let items = [];
    let total = 0;
    
    // Decidir qué función usar según los filtros
    if (onlyMine && context.chatId) {
      // Consulta por chat del usuario (mis tickets)
      const result = await incidenceDB.listIncidentsForChat(context.chatId, {
        statusFilter: status, // listIncidentsForChat sí acepta statusFilter como array
        limit: 200,
      });
      items = result || [];
      total = items.length;
    } else if (areas && areas.length > 0) {
      // Consulta por área
      const result = await incidenceDB.listIncidentsByArea(areas[0], {
        statusFilter: status, // listIncidentsByArea sí acepta statusFilter como array
        limit: 200,
      });
      items = result?.items || result || [];
      total = items.length;
    } else {
      // Consulta general - listIncidents usa 'estado' (singular), no array
      // Si tenemos múltiples estados, hacemos consulta sin filtro y filtramos en memoria
      const result = await incidenceDB.listIncidents({
        page: 1,
        limit: 500, // Pedir muchos para filtrar después
        sort: 'created_at:desc',
        // estado: status?.[0] || null, // Solo acepta un estado
      });
      items = result?.items || [];
      total = items.length;
    }
    
    // ✅ FILTRAR POR ESTADO EN MEMORIA (siempre, para asegurar consistencia)
    if (status && status.length > 0 && items.length > 0) {
      const statusSet = new Set(status.map(s => String(s).toLowerCase()));
      items = items.filter(t => {
        const ticketStatus = String(t.status || t.estado || 'open').toLowerCase();
        return statusSet.has(ticketStatus);
      });
      if (DEBUG) {
        console.log('[TICKET-QUERY] filtered by status', { 
          requested: status, 
          remaining: items.length 
        });
      }
    }
    
    // Filtrar por fecha en memoria si es necesario
    if (dateRange && items.length > 0) {
      items = items.filter(t => {
        const created = new Date(t.created_at);
        return created >= dateRange.start && created <= dateRange.end;
      });
    }
    
    // Filtrar por texto de búsqueda
    if (searchText && items.length > 0) {
      const searchLower = searchText.toLowerCase();
      items = items.filter(t => {
        const folioStr = String(t.folio || '').toLowerCase();
        const lugar = String(t.lugar || '').toLowerCase();
        const desc = String(t.descripcion || t.interpretacion || '').toLowerCase();
        return folioStr.includes(searchLower) || lugar.includes(searchLower) || desc.includes(searchLower);
      });
    }
    
    // Actualizar total después de filtros
    total = items.length;
    
    // Paginar resultados
    const startIdx = (page - 1) * PAGE_SIZE;
    const pageItems = items.slice(startIdx, startIdx + PAGE_SIZE);
    
    return { 
      items: pageItems, 
      total,
      page,
      queryType: query.queryType,
    };
    
  } catch (e) {
    if (DEBUG) console.warn('[TICKET-QUERY] executeQuery err:', e?.message);
    return { items: [], total: 0, error: e?.message };
  }
}

// ──────────────────────────────────────────────────────────────
// Handler principal
// ──────────────────────────────────────────────────────────────

/**
 * Maneja consultas de tickets en lenguaje natural
 * @param {object} client - Cliente de WhatsApp
 * @param {object} msg - Mensaje
 * @param {object} options - Opciones adicionales
 * @returns {boolean} true si manejó el mensaje
 */
async function maybeHandleTicketQuery(client, msg, options = {}) {
  const chatId = msg.from;
  const body = String(msg.body || '').trim();
  const isGroup = isGroupId(chatId);
  
  // Obtener contexto
  let groupArea = null;
  if (isGroup && groupRouter) {
    try {
      groupArea = groupRouter.getAreaByGroupId(chatId);
    } catch {}
  }
  
  const userTeam = getUserTeam(chatId);
  
  // Parsear la consulta
  const query = parseTicketQuery(body, {
    chatId,
    isGroup,
    userTeam,
    groupArea,
  });
  
  // Si no es una consulta de tickets, no manejar
  if (!query.isQuery) {
    return false;
  }
  
  if (DEBUG) {
    console.log('[TICKET-QUERY] processing', {
      chatId: chatId.substring(0, 15),
      isGroup,
      queryType: query.queryType,
      areas: query.areas,
      status: query.status,
    });
  }
  
  // En grupo: verificar si pidieron otra área
  if (isGroup && query.areas.length > 0 && groupArea) {
    const requestedArea = query.areas[0];
    if (requestedArea !== groupArea && !query.allAreas) {
      await replySafe(msg, 
        `📩 Para consultar tickets de *${requestedArea.toUpperCase()}*, envía un mensaje directo.\n\n` +
        `Aquí solo puedo mostrar tickets de *${groupArea.toUpperCase()}*.`
      );
      // Continuar mostrando los del área del grupo
      query.areas = [groupArea];
    }
  }
  
  // Ejecutar la consulta
  const result = await executeQuery(query);
  
  // Formatear respuesta según el tipo de consulta
  let response;
  
  if (result.queryType === 'detail') {
    response = formatTicketDetail(result.item);
  } else if (query.queryType === 'count') {
    const label = buildQueryLabel(query);
    response = formatTicketCount(result.total, label);
  } else {
    // Lista
    const label = buildQueryLabel(query);
    response = formatTicketList(result.items, {
      page: query.page,
      pageSize: PAGE_SIZE,
      label,
      isGroup,
    });
  }
  
  await replySafe(msg, response);
  
  return true;
}

// ──────────────────────────────────────────────────────────────
// Detectar si un mensaje es una consulta (para el intent router)
// ──────────────────────────────────────────────────────────────

function isTicketQueryMessage(text) {
  const query = parseTicketQuery(text);
  return query.isQuery;
}

// ──────────────────────────────────────────────────────────────
// Exports
// ──────────────────────────────────────────────────────────────

module.exports = {
  maybeHandleTicketQuery,
  isTicketQueryMessage,
  parseTicketQuery,
  executeQuery,
};
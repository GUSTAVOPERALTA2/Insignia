// modules/router/routeTicketQuery.js
// ═══════════════════════════════════════════════════════════════════════════
// Router para consultas de tickets con lenguaje natural
// Usa IA para interpretar consultas flexibles
// ═══════════════════════════════════════════════════════════════════════════

const DEBUG = (process.env.VICEBOT_DEBUG || '1') === '1';
const PAGE_SIZE = parseInt(process.env.VICEBOT_TICKETS_PAGE_SIZE || '10', 10);

const path = require('path');
const fs = require('fs');

// ──────────────────────────────────────────────────────────────
// Imports
// ──────────────────────────────────────────────────────────────

const { parseTicketQueryAsync, buildQueryLabel } = require('../ai/ticketQueryNL');

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
// Cache de usuarios
// ──────────────────────────────────────────────────────────────

let usersCache = null;
let usersCacheTime = 0;
const USERS_CACHE_TTL = 60000;

// ──────────────────────────────────────────────────────────────
// Cache de última consulta (para paginación)
// ──────────────────────────────────────────────────────────────

const lastQueryCache = new Map(); // chatId -> { query, timestamp }
const QUERY_CACHE_TTL = 5 * 60 * 1000; // 5 minutos

function getLastQuery(chatId) {
  const cached = lastQueryCache.get(chatId);
  if (!cached) return null;
  
  if (Date.now() - cached.timestamp > QUERY_CACHE_TTL) {
    lastQueryCache.delete(chatId);
    return null;
  }
  
  return cached.query;
}

function setLastQuery(chatId, query) {
  lastQueryCache.set(chatId, {
    query,
    timestamp: Date.now(),
  });
}

function clearLastQuery(chatId) {
  lastQueryCache.delete(chatId);
}

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

function getUser(chatId) {
  const users = loadUsersCache();
  return users[chatId] || null;
}

function getUserTeam(chatId) {
  const user = getUser(chatId);
  return user?.team || null;
}

function getUserName(chatId) {
  const user = getUser(chatId);
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

function formatTicketList(items, { page, pageSize, label, isGroup = false, sections = null }) {
  if (!items.length && !sections) {
    const lines = [
      `📋 *${label}*`,
      '',
      'No encontré tickets con esos filtros.',
      '',
      '💡 *Prueba con:*',
    ];
    
    if (isGroup) {
      lines.push('• "pendientes"');
      lines.push('• "completadas de hoy"');
    } else {
      lines.push('• "mis pendientes"');
      lines.push('• "pendientes de IT"');
      lines.push('• "completadas de hoy"');
    }
    
    return lines.join('\n');
  }
  
  const lines = [];
  lines.push(`📋 *${label}*`);
  
  // Si hay secciones (para "mis pendientes" con prioridad)
  if (sections) {
    for (const section of sections) {
      if (section.items.length === 0) continue;
      
      lines.push('');
      lines.push(`*${section.title}*`);
      
      section.items.forEach((t, idx) => {
        const folio = t.folio || (t.id ? String(t.id).slice(0, 8) : 'SIN-FOLIO');
        const st = formatStatus(t.status);
        const lugar = (t.lugar || '').trim() || '(sin lugar)';
        const baseDesc = (t.descripcion || t.interpretacion || '').trim() || '(sin descripción)';
        const desc = baseDesc.length > 50 ? baseDesc.slice(0, 47) + '…' : baseDesc;
        
        lines.push(`  ${idx + 1}. *${folio}* ${st.emoji}`);
        lines.push(`     📍 ${lugar}`);
        lines.push(`     ${desc}`);
      });
    }
  } else {
    // Lista normal
    lines.push(`(pág. ${page})`);
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
  }
  
  // Footer
  const hasMore = items.length >= pageSize;
  
  lines.push('─────────────────');
  if (hasMore) {
    lines.push(`📄 Más resultados: "página ${page + 1}"`);
  }
  lines.push('🔍 Detalle: responde con el folio');
  
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
  ({ safeReply } = require('../core/safeReply'));
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
  
  const { status, areas, dateRange, searchText, folio, onlyMine, priorityOwnArea, page, context } = query;
  
  // ═══════════════════════════════════════════════════════════════
  // Consulta de detalle por folio
  // ═══════════════════════════════════════════════════════════════
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
    
    // ═══════════════════════════════════════════════════════════════
    // Obtener tickets según filtros
    // ═══════════════════════════════════════════════════════════════
    
    if (onlyMine && context.chatId) {
      // Mis tickets (creados por mí)
      const result = await incidenceDB.listIncidentsForChat(context.chatId, {
        statusFilter: status,
        limit: 200,
      });
      items = result || [];
    } else if (areas && areas.length > 0) {
      // Tickets de área(s) específica(s)
      const result = await incidenceDB.listIncidentsByArea(areas[0], {
        statusFilter: status,
        limit: 200,
      });
      items = result?.items || result || [];
    } else {
      // Consulta general
      const result = await incidenceDB.listIncidents({
        page: 1,
        limit: 500,
        sort: 'created_at:desc',
      });
      items = result?.items || [];
    }
    
    // ═══════════════════════════════════════════════════════════════
    // Filtrar por estado en memoria
    // ═══════════════════════════════════════════════════════════════
    if (status && status.length > 0 && items.length > 0) {
      const statusSet = new Set(status.map(s => String(s).toLowerCase()));
      items = items.filter(t => {
        const ticketStatus = String(t.status || t.estado || 'open').toLowerCase();
        return statusSet.has(ticketStatus);
      });
    }
    
    // ═══════════════════════════════════════════════════════════════
    // Filtrar por fecha
    // ═══════════════════════════════════════════════════════════════
    if (dateRange && items.length > 0) {
      items = items.filter(t => {
        const created = new Date(t.created_at);
        return created >= dateRange.start && created <= dateRange.end;
      });
    }
    
    // ═══════════════════════════════════════════════════════════════
    // Filtrar por texto de búsqueda
    // ═══════════════════════════════════════════════════════════════
    if (searchText && items.length > 0) {
      const searchLower = searchText.toLowerCase();
      items = items.filter(t => {
        const folioStr = String(t.folio || '').toLowerCase();
        const lugar = String(t.lugar || '').toLowerCase();
        const desc = String(t.descripcion || t.interpretacion || '').toLowerCase();
        return folioStr.includes(searchLower) || lugar.includes(searchLower) || desc.includes(searchLower);
      });
    }
    
    // ═══════════════════════════════════════════════════════════════
    // PRIORIZACIÓN: "mis pendientes" muestra primero los que YO creé
    // ═══════════════════════════════════════════════════════════════
    let sections = null;
    
    if (priorityOwnArea && context.userTeam && onlyMine) {
      const userArea = context.userTeam;
      
      // Separar: tickets que yo creé vs tickets de mi área (creados por otros)
      const myCreatedTickets = items.filter(t => t.origin_chat === context.chatId);
      const myAreaTickets = items.filter(t => 
        t.area_destino === userArea && 
        t.origin_chat !== context.chatId
      );
      
      if (myCreatedTickets.length > 0 || myAreaTickets.length > 0) {
        sections = [];
        
        // PRIMERO: Los que yo abrí
        if (myCreatedTickets.length > 0) {
          sections.push({
            title: '📝 Abiertos por mí',
            items: myCreatedTickets.slice(0, 5),
          });
        }
        
        // SEGUNDO: Los de mi área (creados por otros)
        if (myAreaTickets.length > 0) {
          sections.push({
            title: `📌 De mi área (${userArea.toUpperCase()})`,
            items: myAreaTickets.slice(0, 5),
          });
        }
      }
    }
    
    // ═══════════════════════════════════════════════════════════════
    // Paginar resultados
    // ═══════════════════════════════════════════════════════════════
    const total = items.length;
    const startIdx = (page - 1) * PAGE_SIZE;
    const pageItems = items.slice(startIdx, startIdx + PAGE_SIZE);
    
    return { 
      items: pageItems, 
      total,
      page,
      queryType: query.queryType,
      sections,
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
  
  // ═══════════════════════════════════════════════════════════════
  // Ignorar mensajes que parecen selecciones de menú (1-9)
  // Estos deben ser manejados por routeRequesterReply
  // ═══════════════════════════════════════════════════════════════
  if (/^\s*[1-9]\s*$/.test(body)) {
    return false;
  }
  
  // Obtener contexto del usuario
  let groupArea = null;
  if (isGroup && groupRouter) {
    try {
      groupArea = groupRouter.getAreaByGroupId(chatId);
    } catch {}
  }
  
  const userTeam = getUserTeam(chatId);
  const userName = getUserName(chatId);
  
  // ═══════════════════════════════════════════════════════════════
  // Detectar paginación local (antes de IA para mayor rapidez)
  // ═══════════════════════════════════════════════════════════════
  const paginationMatch = body.match(/^p[aá]gina\s*(\d+)$/i) ||
                          body.match(/^pag\.?\s*(\d+)$/i) ||
                          body.match(/^(\d+)$/); // Solo número
  
  if (paginationMatch) {
    const requestedPage = parseInt(paginationMatch[1], 10);
    const lastQuery = getLastQuery(chatId);
    
    if (lastQuery && requestedPage > 0) {
      // Usar la última consulta con nueva página
      lastQuery.page = requestedPage;
      
      if (DEBUG) {
        console.log('[TICKET-QUERY] pagination request', {
          chatId: chatId.substring(0, 15),
          page: requestedPage,
        });
      }
      
      const result = await executeQuery(lastQuery);
      const label = buildQueryLabel(lastQuery);
      const response = formatTicketList(result.items, {
        page: requestedPage,
        pageSize: PAGE_SIZE,
        label,
        isGroup,
        sections: null, // Sin secciones en paginación
      });
      
      await replySafe(msg, response);
      return true;
    }
  }
  
  // ═══════════════════════════════════════════════════════════════
  // Parsear consulta con IA
  // ═══════════════════════════════════════════════════════════════
  const query = await parseTicketQueryAsync(body, {
    chatId,
    isGroup,
    userTeam,
    userName,
    groupArea,
  });
  
  // Si no es consulta, no manejar
  if (!query.isQuery) {
    return false;
  }
  
  // ═══════════════════════════════════════════════════════════════
  // Manejar paginación desde IA
  // ═══════════════════════════════════════════════════════════════
  if (query._aiResult?.is_pagination && query._aiResult?.page) {
    const lastQuery = getLastQuery(chatId);
    
    if (lastQuery) {
      lastQuery.page = query._aiResult.page;
      
      const result = await executeQuery(lastQuery);
      const label = buildQueryLabel(lastQuery);
      const response = formatTicketList(result.items, {
        page: lastQuery.page,
        pageSize: PAGE_SIZE,
        label,
        isGroup,
        sections: null,
      });
      
      await replySafe(msg, response);
      return true;
    }
  }
  
  if (DEBUG) {
    console.log('[TICKET-QUERY] processing', {
      chatId: chatId.substring(0, 15),
      isGroup,
      queryType: query.queryType,
      areas: query.areas,
      status: query.status,
      onlyMine: query.onlyMine,
      priorityOwnArea: query.priorityOwnArea,
    });
  }
  
  // ═══════════════════════════════════════════════════════════════
  // En grupo: verificar área
  // ═══════════════════════════════════════════════════════════════
  if (isGroup && query.areas.length > 0 && groupArea) {
    const requestedArea = query.areas[0];
    if (requestedArea !== groupArea && !query.allAreas) {
      await replySafe(msg, 
        `📩 Para ver tickets de *${requestedArea.toUpperCase()}*, envía un mensaje directo.\n\n` +
        `Aquí solo puedo mostrar tickets de *${groupArea.toUpperCase()}*.`
      );
      query.areas = [groupArea];
    }
  }
  
  // ═══════════════════════════════════════════════════════════════
  // Guardar consulta para paginación futura
  // ═══════════════════════════════════════════════════════════════
  setLastQuery(chatId, { ...query });
  
  // ═══════════════════════════════════════════════════════════════
  // Ejecutar consulta
  // ═══════════════════════════════════════════════════════════════
  const result = await executeQuery(query);
  
  // ═══════════════════════════════════════════════════════════════
  // Formatear respuesta
  // ═══════════════════════════════════════════════════════════════
  let response;
  
  if (result.queryType === 'detail') {
    response = formatTicketDetail(result.item);
  } else if (query.queryType === 'count') {
    const label = buildQueryLabel(query);
    response = formatTicketCount(result.total, label);
  } else {
    const label = buildQueryLabel(query);
    response = formatTicketList(result.items, {
      page: query.page,
      pageSize: PAGE_SIZE,
      label,
      isGroup,
      sections: result.sections,
    });
  }
  
  await replySafe(msg, response);
  
  return true;
}

// ──────────────────────────────────────────────────────────────
// Exports
// ──────────────────────────────────────────────────────────────

module.exports = {
  maybeHandleTicketQuery,
  executeQuery,
};
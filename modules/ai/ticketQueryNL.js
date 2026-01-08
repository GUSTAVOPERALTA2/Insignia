// modules/ai/ticketQueryNL.js
// ═══════════════════════════════════════════════════════════════════════════
// Parser de consultas de tickets - VERSIÓN CON IA
// Usa IA para interpretar la intención del usuario de forma flexible
// ═══════════════════════════════════════════════════════════════════════════

const DEBUG = (process.env.VICEBOT_DEBUG || '1') === '1';

// Importar intérprete de IA
let ticketsAI = null;
try {
  ticketsAI = require('./ticketsQueryInterpreter');
} catch (e) {
  if (DEBUG) console.warn('[QUERY-NL] ticketsQueryInterpreter not available:', e?.message);
}

// ──────────────────────────────────────────────────────────────
// Constantes exportadas (para compatibilidad)
// ──────────────────────────────────────────────────────────────

const STATUS_MAP = {
  'open': ['open', 'in_progress'],
  'done': ['done'],
  'canceled': ['canceled'],
};

const AREA_SYNONYMS = {
  'it': 'it',
  'sistemas': 'it',
  'man': 'man',
  'mantenimiento': 'man',
  'ama': 'ama',
  'hskp': 'ama',
  'seg': 'seg',
  'seguridad': 'seg',
  'rs': 'rs',
  'room service': 'rs',
  'exp': 'exp',
  'experiencias': 'exp',
};

const DATE_PATTERNS = {
  'today': () => {
    const now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const end = new Date(start.getTime() + 24 * 60 * 60 * 1000 - 1);
    return { start, end, label: 'hoy' };
  },
  'yesterday': () => {
    const now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
    const end = new Date(start.getTime() + 24 * 60 * 60 * 1000 - 1);
    return { start, end, label: 'ayer' };
  },
  'this_week': () => {
    const now = new Date();
    const dayOfWeek = now.getDay();
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - dayOfWeek);
    const end = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59);
    return { start, end, label: 'esta semana' };
  },
  'last_week': () => {
    const now = new Date();
    const dayOfWeek = now.getDay();
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - dayOfWeek - 7);
    const end = new Date(now.getFullYear(), now.getMonth(), now.getDate() - dayOfWeek - 1, 23, 59, 59);
    return { start, end, label: 'semana pasada' };
  },
  'this_month': () => {
    const now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth(), 1);
    const end = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59);
    return { start, end, label: 'este mes' };
  },
};

// ──────────────────────────────────────────────────────────────
// Detección de folio (siempre local, no necesita IA)
// ──────────────────────────────────────────────────────────────

function detectFolio(text) {
  const match = text.match(/\b([A-Z]{2,8}-\d{3,6})\b/i);
  return match ? match[1].toUpperCase() : null;
}

// ──────────────────────────────────────────────────────────────
// Función principal de parsing (ASYNC - usa IA)
// ──────────────────────────────────────────────────────────────

async function parseTicketQueryAsync(text, context = {}) {
  const originalText = String(text || '').trim();
  
  const result = {
    originalText,
    isQuery: false,
    queryType: null,
    status: null,
    areas: [],
    dateRange: null,
    searchText: null,
    folio: null,
    page: 1,
    onlyMine: false,
    allAreas: false,
    priorityOwnArea: false,
    context: {
      chatId: context.chatId || null,
      isGroup: context.isGroup || false,
      userTeam: context.userTeam || null,
      userName: context.userName || null,
      groupArea: context.groupArea || null,
    },
    _aiResult: null,
  };
  
  // Mensaje vacío
  if (!originalText) {
    return result;
  }
  
  // ═══════════════════════════════════════════════════════════════
  // PASO 1: Detectar folio (no necesita IA)
  // ═══════════════════════════════════════════════════════════════
  const folio = detectFolio(originalText);
  if (folio) {
    result.isQuery = true;
    result.folio = folio;
    result.queryType = 'detail';
    return result;
  }
  
  // ═══════════════════════════════════════════════════════════════
  // PASO 2: Usar IA para interpretar
  // ═══════════════════════════════════════════════════════════════
  if (!ticketsAI) {
    if (DEBUG) console.warn('[QUERY-NL] No AI interpreter available');
    return result;
  }
  
  try {
    const aiResult = await ticketsAI.interpret(originalText, {
      userTeam: context.userTeam,
      userArea: context.userTeam,
      userName: context.userName,
    });
    
    result._aiResult = aiResult;
    
    if (!aiResult || !aiResult.is_tickets_query) {
      if (DEBUG) {
        console.log('[QUERY-NL] AI says not a query:', aiResult?.rationale || 'unknown');
      }
      return result;
    }
    
    // ═══════════════════════════════════════════════════════════════
    // PASO 3: Convertir resultado de IA a formato de query
    // ═══════════════════════════════════════════════════════════════
    result.isQuery = true;
    
    // Status
    if (aiResult.status && STATUS_MAP[aiResult.status]) {
      result.status = STATUS_MAP[aiResult.status];
    }
    
    // Áreas
    if (aiResult.areas && Array.isArray(aiResult.areas)) {
      result.areas = aiResult.areas;
    }
    
    // Fecha
    if (aiResult.date_filter && DATE_PATTERNS[aiResult.date_filter]) {
      result.dateRange = DATE_PATTERNS[aiResult.date_filter]();
    }
    
    // Búsqueda
    if (aiResult.search_text) {
      result.searchText = aiResult.search_text;
      result.queryType = 'search';
    }
    
    // Scope
    if (aiResult.scope === 'mine') {
      result.onlyMine = true;
    } else if (aiResult.scope === 'all') {
      result.allAreas = true;
    }
    
    // Prioridad de área propia
    if (aiResult.priority_own_area) {
      result.priorityOwnArea = true;
    }
    
    // Query type
    if (!result.queryType) {
      result.queryType = 'list';
    }
    
    // En grupo: si no hay área específica, usar área del grupo
    if (result.context.isGroup && result.context.groupArea) {
      if (result.areas.length === 0 && !result.allAreas) {
        result.areas = [result.context.groupArea];
      }
    }
    
    if (DEBUG) {
      console.log('[QUERY-NL] parsed (AI):', {
        isQuery: result.isQuery,
        queryType: result.queryType,
        status: result.status,
        areas: result.areas,
        dateRange: result.dateRange?.label,
        onlyMine: result.onlyMine,
        priorityOwnArea: result.priorityOwnArea,
      });
    }
    
  } catch (e) {
    if (DEBUG) console.error('[QUERY-NL] AI error:', e?.message || e);
  }
  
  return result;
}

// ──────────────────────────────────────────────────────────────
// Función SYNC (para compatibilidad - usa fallback simple)
// ──────────────────────────────────────────────────────────────

function parseTicketQuery(text, context = {}) {
  const originalText = String(text || '').trim();
  
  const result = {
    originalText,
    isQuery: false,
    queryType: null,
    status: null,
    areas: [],
    dateRange: null,
    searchText: null,
    folio: null,
    page: 1,
    onlyMine: false,
    allAreas: false,
    priorityOwnArea: false,
    context: {
      chatId: context.chatId || null,
      isGroup: context.isGroup || false,
      userTeam: context.userTeam || null,
      userName: context.userName || null,
      groupArea: context.groupArea || null,
    },
  };
  
  if (!originalText) return result;
  
  // Detectar folio
  const folio = detectFolio(originalText);
  if (folio) {
    result.isQuery = true;
    result.folio = folio;
    result.queryType = 'detail';
    return result;
  }
  
  // Fallback sync usando el intérprete de fallback
  if (ticketsAI && ticketsAI.interpretTicketsQueryFallback) {
    const fallback = ticketsAI.interpretTicketsQueryFallback(originalText);
    
    if (fallback && fallback.is_tickets_query) {
      result.isQuery = true;
      
      if (fallback.status && STATUS_MAP[fallback.status]) {
        result.status = STATUS_MAP[fallback.status];
      }
      
      if (fallback.areas) {
        result.areas = fallback.areas;
      }
      
      if (fallback.scope === 'mine') {
        result.onlyMine = true;
      } else if (fallback.scope === 'all') {
        result.allAreas = true;
      }
      
      result.priorityOwnArea = fallback.priority_own_area || false;
      result.queryType = 'list';
    }
  }
  
  return result;
}

// ──────────────────────────────────────────────────────────────
// Label builder
// ──────────────────────────────────────────────────────────────

function buildQueryLabel(query) {
  const parts = [];
  
  // Status
  if (query.status && query.status.length > 0) {
    const statusLabels = {
      'open': 'abiertos',
      'in_progress': 'en progreso',
      'done': 'completados',
      'canceled': 'cancelados',
    };
    
    const labels = [...new Set(query.status.map(s => statusLabels[s] || s))];
    
    if (labels.includes('abiertos') && labels.includes('en progreso')) {
      parts.push('Tickets pendientes');
    } else {
      parts.push(`Tickets ${labels.join(' y ')}`);
    }
  } else {
    parts.push('Tickets');
  }
  
  // Áreas
  if (query.areas && query.areas.length > 0) {
    const areaLabels = {
      'it': 'IT',
      'man': 'Mantenimiento',
      'ama': 'Housekeeping',
      'seg': 'Seguridad',
      'rs': 'Room Service',
      'exp': 'Experiencia',
    };
    const areaNames = query.areas.map(a => areaLabels[a] || a.toUpperCase());
    parts.push(`de ${areaNames.join(' y ')}`);
  } else if (query.allAreas) {
    parts.push('de todas las áreas');
  }
  
  // Fecha
  if (query.dateRange) {
    parts.push(`(${query.dateRange.label})`);
  }
  
  // Búsqueda
  if (query.searchText) {
    parts.push(`— búsqueda: "${query.searchText}"`);
  }
  
  // Míos
  if (query.onlyMine) {
    parts.push('(míos)');
  }
  
  return parts.join(' ');
}

// ──────────────────────────────────────────────────────────────
// API para verificar si es query (sync)
// ──────────────────────────────────────────────────────────────

function isTicketQuery(text) {
  const query = parseTicketQuery(text);
  return query.isQuery;
}

// ──────────────────────────────────────────────────────────────
// Exports
// ──────────────────────────────────────────────────────────────

module.exports = {
  // Funciones principales
  parseTicketQuery,        // Sync (fallback)
  parseTicketQueryAsync,   // Async (usa IA)
  buildQueryLabel,
  isTicketQuery,
  
  // Constantes
  STATUS_MAP,
  AREA_SYNONYMS,
  DATE_PATTERNS,
};
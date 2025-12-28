// modules/ai/ticketQueryNL.js
// Parser de consultas de tickets con lenguaje natural
// Convierte frases como "tickets abiertos de mantenimiento de hoy" en filtros estructurados

const DEBUG = (process.env.VICEBOT_DEBUG || '1') === '1';

// ──────────────────────────────────────────────────────────────
// Mapeos de sinónimos
// ──────────────────────────────────────────────────────────────

const STATUS_SYNONYMS = {
  // Abiertos / Pendientes (open + in_progress)
  'abierto': ['open', 'in_progress'],
  'abiertos': ['open', 'in_progress'],
  'abierta': ['open', 'in_progress'],
  'abiertas': ['open', 'in_progress'],
  'pendiente': ['open', 'in_progress'],
  'pendientes': ['open', 'in_progress'],
  'activo': ['open', 'in_progress'],
  'activos': ['open', 'in_progress'],
  'activa': ['open', 'in_progress'],
  'activas': ['open', 'in_progress'],
  'sin resolver': ['open', 'in_progress'],
  'sin cerrar': ['open', 'in_progress'],
  
  // En progreso específico
  'en progreso': ['in_progress'],
  'en proceso': ['in_progress'],
  'en curso': ['in_progress'],
  'atendiendo': ['in_progress'],
  'trabajando': ['in_progress'],
  
  // Solo abiertos (sin atender)
  'sin atender': ['open'],
  'nuevos': ['open'],
  'nuevo': ['open'],
  'recién creados': ['open'],
  'recien creados': ['open'],
  
  // Completados / Cerrados
  'completado': ['done'],
  'completados': ['done'],
  'completada': ['done'],
  'completadas': ['done'],
  'terminado': ['done'],
  'terminados': ['done'],
  'terminada': ['done'],
  'terminadas': ['done'],
  'finalizado': ['done'],
  'finalizados': ['done'],
  'finalizada': ['done'],
  'finalizadas': ['done'],
  'resuelto': ['done'],
  'resueltos': ['done'],
  'resuelta': ['done'],
  'resueltas': ['done'],
  'cerrado': ['done'],
  'cerrados': ['done'],
  'cerrada': ['done'],
  'cerradas': ['done'],
  'hecho': ['done'],
  'hechos': ['done'],
  'listo': ['done'],
  'listos': ['done'],
  
  // Cancelados
  'cancelado': ['canceled'],
  'cancelados': ['canceled'],
  'cancelada': ['canceled'],
  'canceladas': ['canceled'],
  'anulado': ['canceled'],
  'anulados': ['canceled'],
  'descartado': ['canceled'],
  'descartados': ['canceled'],
  
  // Por confirmar
  'por confirmar': ['awaiting_confirmation'],
  'esperando confirmación': ['awaiting_confirmation'],
  'esperando confirmacion': ['awaiting_confirmation'],
  'pendiente de confirmación': ['awaiting_confirmation'],
  'pendiente de confirmacion': ['awaiting_confirmation'],
  'sin confirmar': ['awaiting_confirmation'],
  
  // Todos
  'todos': null,
  'todas': null,
  'todo': null,
  'toda': null,
};

const AREA_SYNONYMS = {
  // IT
  'it': 'it',
  'sistemas': 'it',
  'tecnología': 'it',
  'tecnologia': 'it',
  'soporte técnico': 'it',
  'soporte tecnico': 'it',
  'informática': 'it',
  'informatica': 'it',
  'computación': 'it',
  'computacion': 'it',
  'tech': 'it',
  
  // Mantenimiento
  'man': 'man',
  'mantenimiento': 'man',
  'mant': 'man',
  'mtto': 'man',
  'maintenance': 'man',
  'técnico': 'man',
  'tecnico': 'man',
  'reparaciones': 'man',
  'electricidad': 'man',
  'plomería': 'man',
  'plomeria': 'man',
  
  // Ama de llaves / Housekeeping
  'ama': 'ama',
  'hskp': 'ama',
  'housekeeping': 'ama',
  'limpieza': 'ama',
  'ama de llaves': 'ama',
  'camaristas': 'ama',
  'habitaciones': 'ama',
  'cuartos': 'ama',
  
  // Seguridad
  'seg': 'seg',
  'seguridad': 'seg',
  'vigilancia': 'seg',
  'security': 'seg',
  'guardias': 'seg',
  
  // Room Service
  'rs': 'rs',
  'room service': 'rs',
  'servicio a cuartos': 'rs',
  'servicio cuartos': 'rs',
  'alimentos': 'rs',
  'comida': 'rs',
  
  // Experiencia
  'exp': 'exp',
  'experiencia': 'exp',
  'guest experience': 'exp',
  'concierge': 'exp',
  'recepción': 'exp',
  'recepcion': 'exp',
  'front desk': 'exp',
};

const DATE_PATTERNS = {
  'hoy': () => {
    const now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const end = new Date(start.getTime() + 24 * 60 * 60 * 1000 - 1);
    return { start, end, label: 'hoy' };
  },
  'ayer': () => {
    const now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
    const end = new Date(start.getTime() + 24 * 60 * 60 * 1000 - 1);
    return { start, end, label: 'ayer' };
  },
  'esta semana': () => {
    const now = new Date();
    const dayOfWeek = now.getDay();
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - dayOfWeek);
    const end = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59);
    return { start, end, label: 'esta semana' };
  },
  'semana pasada': () => {
    const now = new Date();
    const dayOfWeek = now.getDay();
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - dayOfWeek - 7);
    const end = new Date(now.getFullYear(), now.getMonth(), now.getDate() - dayOfWeek - 1, 23, 59, 59);
    return { start, end, label: 'semana pasada' };
  },
  'este mes': () => {
    const now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth(), 1);
    const end = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59);
    return { start, end, label: 'este mes' };
  },
  'mes pasado': () => {
    const now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const end = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59);
    return { start, end, label: 'mes pasado' };
  },
  'últimos 7 días': () => {
    const now = new Date();
    const start = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const end = now;
    return { start, end, label: 'últimos 7 días' };
  },
  'ultimos 7 dias': () => DATE_PATTERNS['últimos 7 días'](),
  'última semana': () => DATE_PATTERNS['últimos 7 días'](),
  'ultima semana': () => DATE_PATTERNS['últimos 7 días'](),
  'últimos 30 días': () => {
    const now = new Date();
    const start = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    const end = now;
    return { start, end, label: 'últimos 30 días' };
  },
  'ultimos 30 dias': () => DATE_PATTERNS['últimos 30 días'](),
  'último mes': () => DATE_PATTERNS['últimos 30 días'](),
  'ultimo mes': () => DATE_PATTERNS['últimos 30 días'](),
};

// Palabras a ignorar
const STOPWORDS = new Set([
  'de', 'del', 'la', 'las', 'el', 'los', 'un', 'una', 'unos', 'unas',
  'para', 'por', 'con', 'sin', 'a', 'al', 'en', 'y', 'o', 'que',
  'me', 'mi', 'mis', 'tu', 'tus', 'su', 'sus', 'nos', 'nuestro', 'nuestra',
  'muestrame', 'muéstrame', 'dame', 'dime', 'ver', 'mostrar', 'listar',
  'cuales', 'cuáles', 'cuantos', 'cuántos', 'hay', 'son', 'están', 'estan',
  'tickets', 'ticket', 'tareas', 'tarea', 'incidencias', 'incidencia',
  'reportes', 'reporte', 'solicitudes', 'solicitud',
  'área', 'area', 'áreas', 'areas',
]);

// ──────────────────────────────────────────────────────────────
// Función principal de parsing
// ──────────────────────────────────────────────────────────────

/**
 * Parsea una consulta en lenguaje natural y extrae filtros estructurados
 * @param {string} text - Texto de la consulta
 * @param {object} context - Contexto adicional (chatId, isGroup, userTeam, groupArea)
 * @returns {object} Filtros estructurados
 */
function parseTicketQuery(text, context = {}) {
  const originalText = String(text || '').trim();
  const normalized = originalText.toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // Quitar acentos para comparación
    .replace(/[¿?¡!.,;:]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  
  const result = {
    originalText,
    isQuery: false,
    queryType: null, // 'list', 'detail', 'search', 'count', 'summary'
    
    // Filtros
    status: null,           // array de estados o null para todos
    areas: [],              // array de áreas
    dateRange: null,        // { start, end, label }
    searchText: null,       // texto de búsqueda libre
    folio: null,            // folio específico para detalle
    
    // Paginación
    page: 1,
    
    // Flags especiales
    onlyMine: false,        // solo mis tickets
    allAreas: false,        // todas las áreas (para DM)
    
    // Contexto
    context: {
      chatId: context.chatId || null,
      isGroup: context.isGroup || false,
      userTeam: context.userTeam || null,
      groupArea: context.groupArea || null,
    },
    
    // Debug
    _parsed: {
      tokens: [],
      matchedStatus: [],
      matchedAreas: [],
      matchedDates: [],
    }
  };
  
  // Detectar si es una consulta de tickets
  const queryIndicators = [
    /\b(tickets?|tareas?|incidencias?|reportes?|solicitudes?)\b/i,
    /\b(pendientes?|abiertos?|cerrados?|completados?|cancelados?)\b/i,
    /\b(muestrame|muéstrame|dame|dime|ver|mostrar|listar|cuales|cuáles|cuantos|cuántos)\b/i,
    /\b(buscar?|encontrar?|detalle)\b/i,
    /\bfolio\b/i,
    /\b[A-Z]{2,8}-\d{3,6}\b/, // Patrón de folio
  ];
  
  if (!queryIndicators.some(rx => rx.test(originalText))) {
    return result;
  }
  
  result.isQuery = true;
  
  // ──────────────────────────────────────────────────────────────
  // Detectar folio específico (consulta de detalle)
  // ──────────────────────────────────────────────────────────────
  const folioMatch = originalText.match(/\b([A-Z]{2,8}-\d{3,6})\b/i);
  if (folioMatch) {
    result.folio = folioMatch[1].toUpperCase();
    result.queryType = 'detail';
    return result;
  }
  
  // Detectar "detalle de X" o "detalle X"
  const detalleMatch = normalized.match(/detalle\s+(?:de\s+)?(\S+)/i);
  if (detalleMatch) {
    const possibleFolio = detalleMatch[1].toUpperCase();
    if (/^[A-Z]{2,8}-\d{3,6}$/.test(possibleFolio)) {
      result.folio = possibleFolio;
      result.queryType = 'detail';
      return result;
    }
  }
  
  // ──────────────────────────────────────────────────────────────
  // Detectar búsqueda de texto
  // ──────────────────────────────────────────────────────────────
  const searchMatch = normalized.match(/busca(?:r)?\s+(.+)/i) ||
                      normalized.match(/encontra(?:r)?\s+(.+)/i) ||
                      normalized.match(/(?:que\s+)?(?:contengan?|mencionen?|digan?)\s+(.+)/i);
  if (searchMatch) {
    result.searchText = searchMatch[1].trim();
    result.queryType = 'search';
  }
  
  // ──────────────────────────────────────────────────────────────
  // Detectar "mis tickets" o "que yo reporté"
  // ──────────────────────────────────────────────────────────────
  if (/\b(mis|mios|míos|mias|mías|yo\s+reporte|yo\s+reporté|que\s+reporte|que\s+reporté)\b/i.test(normalized)) {
    result.onlyMine = true;
  }
  
  // ──────────────────────────────────────────────────────────────
  // Detectar "todos" / "todas las áreas"
  // ──────────────────────────────────────────────────────────────
  if (/\b(todos?|todas?)\s*(las?)?\s*(areas?|áreas?)?\b/i.test(normalized) ||
      /\b(todas?\s+las?\s+areas?|todas?\s+areas?)\b/i.test(normalized)) {
    result.allAreas = true;
  }
  
  // ──────────────────────────────────────────────────────────────
  // Detectar página
  // ──────────────────────────────────────────────────────────────
  const pageMatch = normalized.match(/\bpagina\s+(\d+)\b/i) ||
                    normalized.match(/\bpag\s+(\d+)\b/i) ||
                    normalized.match(/\bpág\s+(\d+)\b/i) ||
                    normalized.match(/\b(\d+)\s*(?:pagina|pag|página)?\s*$/i);
  if (pageMatch) {
    result.page = Math.max(1, parseInt(pageMatch[1], 10));
  }
  
  // ──────────────────────────────────────────────────────────────
  // Detectar fechas
  // ──────────────────────────────────────────────────────────────
  for (const [pattern, fn] of Object.entries(DATE_PATTERNS)) {
    if (normalized.includes(pattern)) {
      result.dateRange = fn();
      result._parsed.matchedDates.push(pattern);
      break; // Solo una fecha
    }
  }
  
  // ──────────────────────────────────────────────────────────────
  // Detectar estados (frases multi-palabra primero)
  // ──────────────────────────────────────────────────────────────
  const sortedStatusKeys = Object.keys(STATUS_SYNONYMS)
    .sort((a, b) => b.length - a.length); // Más largo primero
  
  for (const phrase of sortedStatusKeys) {
    if (normalized.includes(phrase)) {
      const statuses = STATUS_SYNONYMS[phrase];
      if (statuses === null) {
        // "todos" - no filtrar por estado
        result.status = null;
      } else if (statuses) {
        result.status = result.status || [];
        result.status.push(...statuses);
        result._parsed.matchedStatus.push(phrase);
      }
    }
  }
  
  // Deduplicar estados
  if (Array.isArray(result.status)) {
    result.status = [...new Set(result.status)];
  }
  
  // ──────────────────────────────────────────────────────────────
  // Detectar áreas (frases multi-palabra primero)
  // ──────────────────────────────────────────────────────────────
  const sortedAreaKeys = Object.keys(AREA_SYNONYMS)
    .sort((a, b) => b.length - a.length);
  
  for (const phrase of sortedAreaKeys) {
    if (normalized.includes(phrase)) {
      const area = AREA_SYNONYMS[phrase];
      if (!result.areas.includes(area)) {
        result.areas.push(area);
        result._parsed.matchedAreas.push(phrase);
      }
    }
  }
  
  // ──────────────────────────────────────────────────────────────
  // Detectar tipo de consulta
  // ──────────────────────────────────────────────────────────────
  if (!result.queryType) {
    if (/\bcuantos|cuántos|cuantas|cuántas|total|conteo|contar\b/i.test(normalized)) {
      result.queryType = 'count';
    } else if (/\bresumen|estadisticas|estadísticas|reporte\b/i.test(normalized)) {
      result.queryType = 'summary';
    } else {
      result.queryType = 'list';
    }
  }
  
  // ──────────────────────────────────────────────────────────────
  // Aplicar contexto (grupo vs DM)
  // ──────────────────────────────────────────────────────────────
  if (result.context.isGroup && result.context.groupArea) {
    // En grupo: si no pidieron área específica, usar el área del grupo
    if (result.areas.length === 0 && !result.allAreas) {
      result.areas = [result.context.groupArea];
    }
  }
  
  if (DEBUG) {
    console.log('[QUERY-NL] parsed', {
      input: originalText.substring(0, 50),
      queryType: result.queryType,
      status: result.status,
      areas: result.areas,
      dateRange: result.dateRange?.label,
      searchText: result.searchText,
      folio: result.folio,
      onlyMine: result.onlyMine,
      allAreas: result.allAreas,
      page: result.page,
    });
  }
  
  return result;
}

// ──────────────────────────────────────────────────────────────
// Construir label descriptivo para la consulta
// ──────────────────────────────────────────────────────────────

function buildQueryLabel(query) {
  const parts = [];
  
  // Tipo de tickets
  if (query.status && query.status.length > 0) {
    const statusLabels = {
      'open': 'abiertos',
      'in_progress': 'en progreso',
      'done': 'completados',
      'canceled': 'cancelados',
      'awaiting_confirmation': 'por confirmar',
    };
    
    const labels = [...new Set(query.status.map(s => statusLabels[s] || s))];
    
    // Si tiene open + in_progress, simplificar a "pendientes"
    if (labels.includes('abiertos') && labels.includes('en progreso')) {
      parts.push('Tickets pendientes');
    } else {
      parts.push(`Tickets ${labels.join(' y ')}`);
    }
  } else {
    parts.push('Tickets');
  }
  
  // Áreas
  if (query.areas.length > 0) {
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
    parts.push('(solo míos)');
  }
  
  return parts.join(' ');
}

// ──────────────────────────────────────────────────────────────
// Detectar si un mensaje es una consulta de tickets
// ──────────────────────────────────────────────────────────────

function isTicketQuery(text) {
  const query = parseTicketQuery(text);
  return query.isQuery;
}

// ──────────────────────────────────────────────────────────────
// Exports
// ──────────────────────────────────────────────────────────────

module.exports = {
  parseTicketQuery,
  buildQueryLabel,
  isTicketQuery,
  STATUS_SYNONYMS,
  AREA_SYNONYMS,
  DATE_PATTERNS,
};
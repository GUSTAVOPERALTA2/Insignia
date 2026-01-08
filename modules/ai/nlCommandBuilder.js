// modules/ai/nlCommandBuilder.js
// ═══════════════════════════════════════════════════════════════════════════
// Convierte lenguaje natural a comandos de tickets
// VERSIÓN MEJORADA: Usa ticketQueryNL para detección robusta
// ═══════════════════════════════════════════════════════════════════════════

const DEBUG = (process.env.VICEBOT_DEBUG || '1') === '1';

// Importar parser de consultas
let ticketQueryNL = null;
try {
  ticketQueryNL = require('./ticketQueryNL');
} catch (e) {
  if (DEBUG) console.warn('[NL-CMD] ticketQueryNL missing:', e?.message);
}

// ──────────────────────────────────────────────────────────────
// Mapeo de status a argumentos del comando
// ──────────────────────────────────────────────────────────────

function mapStatusToArg(statusArray) {
  if (!statusArray || statusArray.length === 0) return null;
  
  // Si tiene open + in_progress → "abiertos" (pendientes)
  if (statusArray.includes('open') && statusArray.includes('in_progress')) {
    return 'abiertos';
  }
  
  // Si solo tiene done → "cerrados"
  if (statusArray.includes('done') && statusArray.length === 1) {
    return 'cerrados';
  }
  
  // Si solo tiene canceled → "cancelados"
  if (statusArray.includes('canceled') && statusArray.length === 1) {
    return 'cancelados';
  }
  
  // Si tiene in_progress → "en_progreso"
  if (statusArray.includes('in_progress') && statusArray.length === 1) {
    return 'en_progreso';
  }
  
  // Default: primer estado
  const statusMap = {
    'open': 'abiertos',
    'in_progress': 'en_progreso',
    'done': 'cerrados',
    'canceled': 'cancelados',
  };
  
  return statusMap[statusArray[0]] || null;
}

// ──────────────────────────────────────────────────────────────
// Construir comando /tickets desde query parseada
// ──────────────────────────────────────────────────────────────

function buildCommandFromQuery(query) {
  if (!query || !query.isQuery) return null;
  
  const parts = [];
  
  // Área
  if (query.areas && query.areas.length > 0) {
    parts.push(query.areas[0]);
  }
  
  // Estado
  const statusArg = mapStatusToArg(query.status);
  if (statusArg) {
    parts.push(statusArg);
  }
  
  // Búsqueda
  if (query.searchText) {
    parts.push(`buscar ${query.searchText}`);
  }
  
  // Folio específico
  if (query.folio) {
    return `/tickets detalle ${query.folio}`;
  }
  
  const args = parts.join(' ').trim();
  return args ? `/tickets ${args}` : '/tickets';
}

// ──────────────────────────────────────────────────────────────
// API Principal
// ──────────────────────────────────────────────────────────────

/**
 * Intenta convertir texto en lenguaje natural a comando /tickets
 * @param {object} params - { text, context }
 * @returns {object} { command, confidence, reason }
 */
async function buildNLCommand({ text, context = {} }) {
  const body = String(text || '').trim();
  
  if (!body) {
    return { command: null, confidence: 0, reason: 'empty_text' };
  }
  
  // Verificar si tenemos el parser
  if (!ticketQueryNL) {
    return { command: null, confidence: 0, reason: 'parser_missing' };
  }
  
  // Parsear la consulta
  const query = ticketQueryNL.parseTicketQuery(body, context);
  
  // Si no es consulta, retornar null
  if (!query.isQuery) {
    if (DEBUG) {
      console.log('[NL-CMD] BYPASS:', query._rejected || 'not_a_query', {
        text: body.substring(0, 50)
      });
    }
    return { 
      command: null, 
      confidence: 0, 
      reason: query._rejected || 'not_a_query' 
    };
  }
  
  // Construir comando
  const command = buildCommandFromQuery(query);
  
  if (DEBUG) {
    console.log('[NL-CMD] converted', {
      from: body.substring(0, 50),
      to: command,
      queryType: query.queryType,
      status: query.status,
      areas: query.areas,
    });
  }
  
  return {
    command,
    confidence: 0.9,
    reason: 'parsed_successfully',
    query, // Para debugging
  };
}

module.exports = { buildNLCommand };
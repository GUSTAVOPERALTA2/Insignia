// modules/ai/nlCommandBuilder.js
// ✅ VERSIÓN CORREGIDA: NO convierte reportes en comandos de búsqueda

const DEBUG = (process.env.VICEBOT_DEBUG || '1') === '1';
const MIN_TICKETS_AI_CONF = Number(process.env.VICEBOT_MIN_TICKETS_AI_CONF || '0.75'); // ← Aumentado

let _ticketsAI = null;
function getTicketsAI() {
  if (_ticketsAI !== null) return _ticketsAI;
  try {
    _ticketsAI = require('./ticketsQueryInterpreter');
  } catch (e) {
    _ticketsAI = null;
    if (DEBUG) console.warn('[NL-CMD] ticketsQueryInterpreter missing:', e?.message || e);
  }
  return _ticketsAI;
}

function normalizeText(s = '') {
  return String(s || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

// ✅ NUEVO: Detecta si es un REPORTE (no una consulta)
function looksLikeReport(text = '') {
  const t = normalizeText(text);
  
  // Patrones de REPORTE (problema actual)
  const reportPatterns = [
    /\bno\s+(hay|funciona|sirve|prende|enciende|jala)\b/,
    /\b(fuga|gotea|tirando agua|se rompi[oó]|descompuesto)\b/,
    /\b(necesito|urge|urgente|ayuda)\s+(con|en|mantenimiento|limpieza|sistemas)\b/,
    /\b(está|esta)\s+(sucio|roto|fallando|malo)\b/,
  ];

  if (reportPatterns.some(p => p.test(t))) {
    return true;
  }

  // ✅ Si menciona "el/la/los/las" + problema → es reporte
  if (/\b(el|la|los|las)\s+\w+\s+(no|está|esta)\b/.test(t)) {
    return true;
  }

  return false;
}

// ✅ NUEVO: Detecta si es una CONSULTA (buscar tickets existentes)
function looksLikeQuery(text = '') {
  const t = normalizeText(text);
  
  // Patrones de CONSULTA (buscar info de tickets)
  const queryPatterns = [
    /\b(como\s+va|como\s+vamos|que\s+paso\s+con|estatus|status)\b/,
    /\b(mis\s+tickets|mis\s+reportes|mis\s+incidencias)\b/,
    /\b(buscar?|encuentra|dame|muestra|ver)\s+(tickets?|reportes?)\b/,
    /\b(cuantos|cuales)\s+(tickets?|reportes?)\b/,
    /\b(tickets?\s+(abiertos?|cerrados?|pendientes?|cancelados?))\b/,
  ];

  return queryPatterns.some(p => p.test(t));
}

function mapStatusToArg(status) {
  const s = String(status || '').toLowerCase().trim();
  if (!s) return null;

  if (['open', 'opened', 'abierto', 'abiertos', 'abierta', 'abiertas', 'pendiente', 'pendientes', 'in_progress', 'progreso', 'en_curso'].includes(s)) {
    return 'abiertos';
  }
  if (['closed', 'cerrado', 'cerrados', 'completado', 'completados', 'done', 'resolved', 'resuelto', 'resueltos', 'finalizado', 'finalizados'].includes(s)) {
    return 'cerrados';
  }
  if (['canceled', 'cancelled', 'cancelado', 'cancelados', 'cancelada', 'canceladas'].includes(s)) {
    return 'cancelados';
  }

  return null;
}

function isExplicitGlobal(textNorm) {
  return /\b(todos|todas|global|general|de todas las areas|todas las areas|toda la operacion)\b/i.test(textNorm);
}

function buildTicketsCommandFromAI(ai, originalText = '') {
  if (!ai || ai.is_tickets_query !== true) return null;

  const conf = Number(ai.confidence || 0);
  if (conf < MIN_TICKETS_AI_CONF) return null;

  const tNorm = normalizeText(originalText);
  const area = ai.area ? String(ai.area).toLowerCase().trim() : null;
  const mine = ai.mine !== false;

  const parts = [];

  if (!mine) {
    if (area) {
      parts.push(area);
    } else if (!isExplicitGlobal(tNorm)) {
      // No permitimos global implícito
    }
  }

  const statusArg = mapStatusToArg(ai.status);
  if (statusArg) parts.push(statusArg);

  const place = ai.place ? String(ai.place).trim() : '';
  if (place) parts.push(`buscar ${place}`);

  const args = parts.join(' ').trim();
  return args ? `/tickets ${args}` : '/tickets';
}

/**
 * ✅ API PRINCIPAL (corregida)
 */
async function buildNLCommand({ text, context = {} }) {
  const body = String(text || '').trim();
  if (!body) return { command: null, confidence: 0, reason: 'empty_text' };

  // ✅ GUARD 1: Si parece reporte, NO convertir a comando
  if (looksLikeReport(body)) {
    if (DEBUG) {
      console.log('[NL-CMD] BYPASS: parece reporte, no comando', {
        text: body.substring(0, 50)
      });
    }
    return { command: null, confidence: 0, reason: 'looks_like_incident_report' };
  }

  // ✅ GUARD 2: Si NO parece consulta, NO convertir
  if (!looksLikeQuery(body)) {
    if (DEBUG) {
      console.log('[NL-CMD] BYPASS: no parece consulta de tickets', {
        text: body.substring(0, 50)
      });
    }
    return { command: null, confidence: 0, reason: 'not_a_query' };
  }

  const ticketsAI = getTicketsAI();
  if (!ticketsAI || typeof ticketsAI.interpretTicketsQuery !== 'function') {
    return { command: null, confidence: 0, reason: 'tickets_ai_missing' };
  }

  let ai = null;
  try {
    ai = await ticketsAI.interpretTicketsQuery({ text: body, context });
  } catch (e) {
    if (DEBUG) console.warn('[NL-CMD] interpretTicketsQuery err', e?.message || e);
    return { command: null, confidence: 0, reason: 'tickets_ai_error' };
  }

  // ✅ GUARD 3: Si la IA dice que NO es tickets_query, respetar
  if (ai && ai.is_tickets_query !== true) {
    if (DEBUG) {
      console.log('[NL-CMD] BYPASS: IA dice que no es tickets_query', {
        text: body.substring(0, 50),
        ai_reason: ai.rationale || ai.reason
      });
    }
    return { command: null, confidence: 0, reason: 'ai_not_tickets_query' };
  }

  const cmd = buildTicketsCommandFromAI(ai, body);

  const out = {
    command: cmd,
    confidence: Number(ai?.confidence || 0),
    reason: ai?.rationale || ai?.reason || 'ok',
    raw: ai || null
  };

  if (DEBUG) {
    console.log('[NL-CMD] out', {
      from: body,
      to: out.command,
      confidence: out.confidence,
      reason: out.reason
    });
  }

  return out;
}

module.exports = { buildNLCommand };
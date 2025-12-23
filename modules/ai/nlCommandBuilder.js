// modules/ia/nlCommandBuilder.js
const DEBUG = (process.env.VICEBOT_DEBUG || '1') === '1';

const MIN_TICKETS_AI_CONF = Number(process.env.VICEBOT_MIN_TICKETS_AI_CONF || '0.65');

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

/**
 * Normaliza texto para logs/chequeos ligeros (NO heurística dura de intención).
 */
function normalizeText(s = '') {
  return String(s || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

/**
 * Mapea status IA → arg de /tickets
 * routerTicketsCommand acepta: abiertos/abiertas/pendientes, cerrados, cancelados, buscar <q>
 */
function mapStatusToArg(status) {
  const s = String(status || '').toLowerCase().trim();

  if (!s) return null;

  // abiertos
  if (['open', 'opened', 'abierto', 'abiertos', 'abierta', 'abiertas', 'pendiente', 'pendientes', 'in_progress', 'progreso', 'en_curso'].includes(s)) {
    return 'abiertos';
  }

  // cerrados
  if (['closed', 'cerrado', 'cerrados', 'completado', 'completados', 'done', 'resolved', 'resuelto', 'resueltos', 'finalizado', 'finalizados'].includes(s)) {
    return 'cerrados';
  }

  // cancelados
  if (['canceled', 'cancelled', 'cancelado', 'cancelados', 'cancelada', 'canceladas'].includes(s)) {
    return 'cancelados';
  }

  return null;
}

/**
 * Reglas de "global" SOLO explícito
 */
function isExplicitGlobal(textNorm) {
  return /\b(todos|todas|global|general|de todas las areas|todas las areas|todas las areas|toda la operacion)\b/i.test(textNorm);
}

/**
 * Construye comando /tickets según salida IA (sin heurística de keywords).
 */
function buildTicketsCommandFromAI(ai, originalText = '') {
  if (!ai || ai.is_tickets_query !== true) return null;

  const conf = Number(ai.confidence || 0);
  if (conf < MIN_TICKETS_AI_CONF) return null;

  const tNorm = normalizeText(originalText);

  const area = ai.area ? String(ai.area).toLowerCase().trim() : null;

  // mine: default true. Si IA dice mine=false, solo permitimos "global" si el usuario lo pidió explícito
  const mine = ai.mine !== false;

  const parts = [];

  // Prefijo por área:
  // - Si mine=true -> NO ponemos área (son "mis tickets").
  // - Si mine=false y hay área -> /tickets <area> ...
  // - Si mine=false y no hay área -> SOLO global si es explícito, si no, cae a "mis tickets".
  if (!mine) {
    if (area) {
      parts.push(area);
    } else if (!isExplicitGlobal(tNorm)) {
      // no permitimos global implícito
      // => lo tratamos como "mis tickets" (sin prefijo)
    } else {
      // global explícito => sin prefijo, pero se permite mostrar más (tu /tickets ya soporta "mis tickets",
      // el "global" real lo controlas dentro de routerTicketsCommand si lo llegas a agregar después)
      // Por ahora lo dejamos sin prefijo para no romper.
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
 * API principal: retorna { command, confidence, reason, raw }
 */
async function buildNLCommand({ text, context = {} }) {
  const body = String(text || '').trim();
  if (!body) return { command: null, confidence: 0, reason: 'empty_text' };

  const ticketsAI = getTicketsAI();
  if (!ticketsAI || typeof ticketsAI.interpretTicketsQuery !== 'function') {
    return { command: null, confidence: 0, reason: 'tickets_ai_missing' };
  }

  // 100% IA: el detector decide si es tickets query, status/area/place/mine.
  let ai = null;
  try {
    ai = await ticketsAI.interpretTicketsQuery({ text: body, context });
  } catch (e) {
    if (DEBUG) console.warn('[NL-CMD] interpretTicketsQuery err', e?.message || e);
    return { command: null, confidence: 0, reason: 'tickets_ai_error' };
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

// modules/ai/coreFeedbackEngine.js
// CORE unificado para feedback de EQUIPO y SOLICITANTE.
// - Envuelve coreFeedbackClassifier (intención, tono, etc.).
// - Determina next_status apoyándose en coreStatusMachine si está disponible,
//   y si no, con una lógica interna de respaldo.

const DEBUG = (process.env.VICEBOT_DEBUG || '1') === '1';

let _statusCore = null;
function getStatusCore() {
  if (_statusCore !== null) return _statusCore;
  try {
    // Ajusta la ruta si lo pusiste en otro lado
    _statusCore = require('./coreStatusMachine');
  } catch {
    _statusCore = null;
  }
  return _statusCore;
}

let _classifier = null;
function getClassifier() {
  if (_classifier) return _classifier;
  try {
    _classifier = require('./coreFeedbackClassifier');
  } catch {
    _classifier = null;
  }
  return _classifier;
}

/**
 * Normaliza estado a algo manejable (minúsculas, sin espacios).
 */
function normStatus(s) {
  if (!s) return null;
  return String(s).trim().toLowerCase();
}

/**
 * Aplica la "state machine" central si existe, con un contrato flexible.
 * Intentos de función:
 *   - core.stepIncidentStatus({ currentStatus, actor, status_intent, requester_side, classifier })
 *   - core.stepStatus(...)
 *   - core.decideNextStatus(...)
 *
 * Si algo falla, regresa null y cae al fallback.
 */
async function tryStatusMachine({ currentStatus, actor, status_intent, requester_side, classifier }) {
  const core = getStatusCore();
  if (!core) return null;

  const candidates = [
    core.stepIncidentStatus,
    core.stepStatus,
    core.decideNextStatus
  ].filter(fn => typeof fn === 'function');

  if (!candidates.length) return null;

  const fn = candidates[0];

  try {
    const res = await fn({
      currentStatus,
      actor,
      status_intent,
      requester_side,
      classifier
    });

    if (!res) return null;

    // Aceptamos varias formas:
    //  - { next_status }
    //  - { nextStatus }
    const next =
      res.next_status ||
      res.nextStatus ||
      null;

    if (!next) return null;

    return {
      next_status: next,
      reason: res.reason || res.rationale || 'coreStatusMachine'
    };
  } catch (e) {
    if (DEBUG) console.warn('[FB-ENGINE] statusCore error:', e?.message || e);
    return null;
  }
}

/**
 * Fallback interno para decidir siguiente estado si no hay coreStatusMachine
 * o si algo falla dentro de ella.
 *
 * current: estado actual (string o null)
 * actor: 'team' | 'requester'
 * status_intent: 'none'|'in_progress'|'done_claim'|'cancel_request'|'reopen_request'
 * requester_side: (solo relevante para requester) 'still_broken', 'happy', etc.
 */
function fallbackNextStatus({ currentStatus, actor, status_intent, requester_side }) {
  const cur = normStatus(currentStatus);
  const actorNorm = actor === 'requester' ? 'requester' : 'team';
  const intent = status_intent || 'none';
  const reqSide = requester_side || 'unknown';

  let next = cur || 'open';
  let reason = 'fallback_rules';

  // 1) Si el equipo dice que está "en progreso"
  if (intent === 'in_progress' && actorNorm === 'team') {
    if (!cur || ['new', 'pending', 'open', 'awaiting_confirmation'].includes(cur)) {
      next = 'in_progress';
      reason = 'team_in_progress';
    }
  }

  // 2) Done claim (equipo dice "ya quedó")
  if (intent === 'done_claim' && actorNorm === 'team') {
    // Regla pactada: pasa a awaiting_confirmation
    next = process.env.VICEBOT_STATUS_ON_DONE_CLAIM || 'awaiting_confirmation';
    reason = 'team_done_claim';
  }

  // 3) Cancel request (quieren cancelar)
  if (intent === 'cancel_request') {
    // Si lo pide el solicitante, respetamos
    if (actorNorm === 'requester') {
      next = process.env.VICEBOT_STATUS_ON_CANCEL_REQUEST || 'canceled';
      reason = 'requester_cancel';
    } else {
      next = process.env.VICEBOT_STATUS_ON_CANCEL_REQUEST || 'canceled';
      reason = 'team_cancel';
    }
  }

  // 4) Reopen request (reportan que sigue fallando / regresó la falla)
  if (intent === 'reopen_request') {
    next = process.env.VICEBOT_STATUS_ON_REOPEN_REQUEST || 'open';
    reason = 'reopen_request';
  }

  // 5) Caso típico: solicitante dice que sigue sin servir DESPUÉS de un cierre
  if (actorNorm === 'requester' && reqSide === 'still_broken') {
    if (cur && ['resolved', 'awaiting_confirmation', 'done', 'closed'].includes(cur)) {
      next = process.env.VICEBOT_STATUS_ON_REOPEN_REQUEST || 'open';
      reason = 'requester_still_broken_from_closed';
    }
  }

  // 6) Solicitante feliz con algo que parece cerrado
  if (actorNorm === 'requester' && reqSide === 'happy') {
    if (!cur || ['awaiting_confirmation', 'in_progress', 'open', 'pending'].includes(cur)) {
      // Podríamos cerrar automáticamente si así lo decides
      if (process.env.VICEBOT_AUTOCLOSE_ON_HAPPY === '1') {
        next = 'resolved';
        reason = 'requester_happy_autoclose';
      }
    }
  }

  return { next_status: next, reason };
}

/**
 * API principal del CORE
 *
 * @param {Object} params
 * @param {string} params.text              - Mensaje crudo.
 * @param {('team'|'requester')} params.roleHint
 * @param {Object} params.ticket            - { id, folio, descripcion, lugar, status, ... }
 * @param {Array}  params.history           - historial relevante (opcional).
 * @param {string} [params.source]          - tag de origen: 'team_group', 'requester_dm', etc.
 */
async function runFeedbackEngine({ text, roleHint, ticket = {}, history = [], source = 'unknown' }) {
  const t0 = Date.now();
  const classifierMod = getClassifier();
  if (!classifierMod || typeof classifierMod.classifyFeedbackMessage !== 'function') {
    if (DEBUG) console.warn('[FB-ENGINE] coreFeedbackClassifier no disponible, usando fallback mínimo');
    const note = (text || '').trim();
    return {
      is_relevant: true,
      role: roleHint === 'team' ? 'team' : 'requester',
      kind: 'feedback',
      status_intent: 'none',
      requester_side: roleHint === 'requester' ? 'neutral' : 'unknown',
      polarity: 'neutral',
      normalized_note: note.slice(0, 200) || 'Mensaje de seguimiento sin clasificar.',
      rationale: 'coreFeedbackClassifier ausente; resultado mínimo.',
      confidence: 0.4,
      next_status: ticket.status || null,
      _latency_ms: Date.now() - t0,
      _source: source,
      _engine: 'coreFeedbackEngine-fallback'
    };
  }

  // 1) Clasificar mensaje
  const fb = await classifierMod.classifyFeedbackMessage({
    text,
    roleHint,
    ticket,
    history
  });

  if (DEBUG) console.log('[FB-ENGINE] classifier out', fb);

  // Si el clasificador ya dice que no es relevante, devolvemos eso sin tocar estado
  if (!fb.is_relevant) {
    return {
      ...fb,
      next_status: ticket.status || null,
      _latency_ms: Date.now() - t0,
      _source: source,
      _engine: 'coreFeedbackEngine'
    };
  }

  const actor = fb.role || (roleHint === 'team' ? 'team' : 'requester');
  const currentStatus = ticket.status || null;

  // 2) Intentar usar coreStatusMachine
  let statusRes = await tryStatusMachine({
    currentStatus,
    actor,
    status_intent: fb.status_intent,
    requester_side: fb.requester_side,
    classifier: fb
  });

  // 3) Si no hay status machine o falló, usar fallback interno
  if (!statusRes) {
    statusRes = fallbackNextStatus({
      currentStatus,
      actor,
      status_intent: fb.status_intent,
      requester_side: fb.requester_side
    });
  }

  const next_status = statusRes.next_status || currentStatus || null;
  const status_reason = statusRes.reason || null;

  // 4) Componer salida final
  const out = {
    is_relevant: fb.is_relevant,
    role: fb.role,
    kind: fb.kind,
    status_intent: fb.status_intent,
    requester_side: fb.requester_side,
    polarity: fb.polarity,
    normalized_note: fb.normalized_note,
    rationale: fb.rationale
      ? `${fb.rationale} | status_reason: ${status_reason || 'n/a'}`
      : `status_reason: ${status_reason || 'n/a'}`,
    confidence: fb.confidence,
    next_status,
    _latency_ms: Date.now() - t0,
    _source: source,
    _engine: 'coreFeedbackEngine'
  };

  if (DEBUG) console.log('[FB-ENGINE] out', out);
  return out;
}

module.exports = {
  runFeedbackEngine
};

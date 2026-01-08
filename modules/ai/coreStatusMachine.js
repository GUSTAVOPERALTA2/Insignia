// modules/ai/coreStatusMachine.js
// State machine centralizada para decidir next_status a partir del
// clasificador de feedback (coreFeedbackClassifier).
//
// Reglas pensadas para alinear con testFeedbackEngine:
//
// - Equipo (actor = 'team'):
//    * in_progress sobre OPEN/PENDING  → in_progress
//    * done_claim                     → awaiting_confirmation
//    * cancel_request                 → canceled
//
// - Solicitante (actor = 'requester'):
//    * cancel_request / wants_cancel  → canceled
//    * reopen_request / still_broken:
//         - si estaba en resolved/done/closed/awaiting_confirmation → open
//         - si ya estaba open/in_progress/etc.                      → se queda igual
//    * done_claim + happy:
//         - NO autocierra: si estaba en awaiting_confirmation → se queda ahí
//         - en otros estados → no cambia (conservador)
//    * intent none / smalltalk / neutro → no cambia

const DEBUG = (process.env.VICEBOT_DEBUG || '1') === '1';

function normStatus(s) {
  if (!s) return null;
  return String(s).trim().toLowerCase();
}

function stepIncidentStatus({
  currentStatus,
  actor,           // 'team' | 'requester'
  status_intent,   // 'none' | 'in_progress' | 'done_claim' | 'cancel_request' | 'reopen_request'
  requester_side,  // 'happy' | 'still_broken' | 'wants_cancel' | ...
  classifier       // objeto completo del clasificador (por si se quiere loggear)
}) {
  const cur = normStatus(currentStatus) || 'open';

  // Normalizamos actor → source lógico
  const src = actor === 'team' ? 'team' : 'requester';
  const intent = status_intent || 'none';
  const reqSide = requester_side || 'unknown';

  let next = cur;
  let reason = 'intent_none';

  const isTerminal = (st) =>
    ['resolved', 'done', 'closed'].includes(normStatus(st));
  const isAwaiting = (st) =>
    ['awaiting_confirmation'].includes(normStatus(st));

  if (DEBUG) {
    console.log('[STATUS-MACHINE] in =>', {
      currentStatus: cur,
      source: src,
      rawIntent: intent,
      effective_intent: intent,
      requester_side: reqSide
    });
  }

  // ──────────────────────────────
  // Rama: EQUIPO
  // ──────────────────────────────
  if (src === 'team') {
    // Equipo indica que ya está trabajando
    if (intent === 'in_progress') {
      if (['open', 'pending', 'new'].includes(cur)) {
        next = 'in_progress';
        reason = 'team_in_progress_from_open_or_pending';
      } else {
        // Si ya estaba en otro estado (ej. in_progress), lo dejamos igual
        next = cur;
        reason = 'team_in_progress_no_change';
      }
    }

    // Equipo dice "ya quedó" → siempre pedimos confirmación del huésped
    else if (intent === 'done_claim') {
      next = 'awaiting_confirmation';
      reason = 'team_done_claim_requires_confirmation';
    }

    // Equipo pide cancelar (huésped ya no requiere, duplicado, etc.)
    else if (intent === 'cancel_request') {
      next = 'canceled';
      reason = 'team_cancel_request';
    }

    // Otros casos de equipo → no cambian estado
    else {
      next = cur;
      reason = 'team_intent_none_or_ignored';
    }
  }

  // ──────────────────────────────
  // Rama: SOLICITANTE
  // ──────────────────────────────
  else {
    // Cancelación desde el solicitante
    if (intent === 'cancel_request' || reqSide === 'wants_cancel') {
      next = 'canceled';
      reason = 'requester_cancel_request';
    }

    // Reopen request / still_broken
    else if (intent === 'reopen_request' || reqSide === 'still_broken') {
      if (isTerminal(cur) || isAwaiting(cur)) {
        // Reabre tickets ya “cerrados” o en awaiting
        next = 'open';
        reason = 'reopen_after_terminal_or_awaiting';
      } else {
        // Si ya estaba “activo” (open, in_progress, pending), no cambiamos
        next = cur;
        reason = 'reopen_on_active_no_change';
      }
    }

    // Solicitante feliz con done_claim
    else if (intent === 'done_claim' && reqSide === 'happy') {
      if (isTerminal(cur)) {
        // Ya está en done/resolved/closed → se queda igual
        next = cur;
        reason = 'requester_happy_on_terminal_no_change';
      } else {
        // ✅ CAMBIO: Si el solicitante confirma que quedó resuelto, cerrar el ticket
        // Esto aplica tanto si estaba en awaiting_confirmation como en open/in_progress
        next = 'done';
        reason = 'requester_confirmed_done';
      }
    }

    // Sin intención de estado clara (nota neutra, aclaración, smalltalk, etc.)
    else {
      next = cur;
      reason = 'intent_none';
    }
  }

  const changed = next !== cur;

  if (DEBUG) {
    console.log('[STATUS-MACHINE] out =>', {
      nextStatus: next,
      changed,
      reason
    });
  }

  return {
    next_status: next,
    nextStatus: next, // por compatibilidad
    changed,
    reason
  };
}

module.exports = {
  stepIncidentStatus
};
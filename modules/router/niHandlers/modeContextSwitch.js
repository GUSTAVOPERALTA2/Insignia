/**
 * niHandlers/modeContextSwitch.js
 * Handlers para cambios de contexto y decisiones de followup:
 * - context_switch: cambio de contexto general
 * - different_problem: problema diferente detectado
 * - description_or_new: decidir agregar descripción o crear nuevo
 * - followup_decision: decisión sobre followup con área diferente
 * - followup_place_decision: decisión sobre followup con lugar diferente
 */

const {
  DEBUG,
  norm,
  isYes,
  isNo,
  areaLabel,
  formatPreviewMessage,
} = require('./shared');

/**
 * Handler para modo different_problem
 * Menú: enviar/reemplazar/agregar/cancelar
 */
async function handleDifferentProblem(ctx) {
  const {
    s, msg, text, replySafe, setMode, setDraftField, addArea, resetSession,
    finalizeAndDispatch, client, findStrongPlaceSignals, normalizeAndSetLugar,
    detectArea, refreshIncidentDescription, addDetail
  } = ctx;

  const t = norm(text);
  const pendingNewText = s._pendingNewIncidentText || '';

  if (DEBUG) console.log('[DIFFERENT_PROBLEM] handling', { response: text });

  // Opción: enviar - enviar actual y crear nuevo
  if (/^envi[ao]r?\b/i.test(t) || (/^(si|confirmar?)\b/i.test(t) && pendingNewText)) {
    try {
      await finalizeAndDispatch({ client, msg, session: s, silent: false });
    } catch (e) {
      if (DEBUG) console.warn('[DIFFERENT_PROBLEM] dispatch error', e?.message);
    }

    // Crear nuevo draft
    s.draft = {
      descripcion: pendingNewText,
      descripcion_original: pendingNewText,
    };
    s._pendingNewIncidentText = null;
    s._pendingOldIncidentDraft = null;
    s._pendingNewArea = null;
    s._areDifferentAreas = null;

    const strong = findStrongPlaceSignals ? findStrongPlaceSignals(pendingNewText) : null;
    if (strong) {
      await normalizeAndSetLugar(s, msg, strong.value, { rawText: pendingNewText });
    }

    try {
      const a = await detectArea(pendingNewText);
      if (a?.area) {
        setDraftField(s, 'area_destino', a.area);
        addArea(s, a.area);
      }
    } catch {}

    if (refreshIncidentDescription) {
      await refreshIncidentDescription(s, pendingNewText);
    }

    const preview = formatPreviewMessage(s.draft);
    await replySafe(msg, '📋 *Nuevo ticket:*\n\n' + preview);
    setMode(s, 'confirm');
    return true;
  }

  // Opción: reemplazar
  if (/^reemplaz[ao]r?\b/i.test(t) || /^sustitu[iy]r?\b/i.test(t) || /^cambiar?\b/i.test(t)) {
    s.draft.descripcion = pendingNewText;
    s.draft.descripcion_original = pendingNewText;
    s.draft._details = [];
    s._pendingNewIncidentText = null;
    s._pendingOldIncidentDraft = null;
    s._pendingNewArea = null;
    s._areDifferentAreas = null;

    const strong = findStrongPlaceSignals ? findStrongPlaceSignals(pendingNewText) : null;
    if (strong) {
      await normalizeAndSetLugar(s, msg, strong.value, { rawText: pendingNewText });
    }

    try {
      const a = await detectArea(pendingNewText);
      if (a?.area) {
        setDraftField(s, 'area_destino', a.area);
        s.draft.areas = [a.area];
      }
    } catch {}

    if (refreshIncidentDescription) {
      await refreshIncidentDescription(s, pendingNewText);
    }

    const preview = formatPreviewMessage(s.draft);
    await replySafe(msg, '✅ Ticket reemplazado:\n\n' + preview);
    setMode(s, 'confirm');
    return true;
  }

  // Opción: agregar (solo si NO son áreas diferentes)
  if (/^agregar\b/i.test(t) || /^a[ñn]adir\b/i.test(t)) {
    if (s._areDifferentAreas) {
      await replySafe(msg,
        '⚠️ No puedo agregar como detalle porque son *áreas diferentes*.\n\n' +
        'Opciones:\n' +
        '• *enviar* — enviar el ticket actual y crear uno nuevo\n' +
        '• *reemplazar* — descartar el actual y usar el nuevo\n' +
        '• *cancelar* — ignorar el mensaje'
      );
      return true;
    }

    addDetail(s, pendingNewText);
    s._pendingNewIncidentText = null;
    s._pendingOldIncidentDraft = null;
    s._pendingNewArea = null;
    s._areDifferentAreas = null;

    const preview = formatPreviewMessage(s.draft);
    await replySafe(msg, '✅ Detalle agregado:\n\n' + preview);
    setMode(s, 'confirm');
    return true;
  }

  // Opción: cancelar
  if (/^cancelar?\b/i.test(t) || /^ignorar?\b/i.test(t) || /^no\b/i.test(t)) {
    s._pendingNewIncidentText = null;
    s._pendingOldIncidentDraft = null;
    s._pendingNewArea = null;
    s._areDifferentAreas = null;

    const preview = formatPreviewMessage(s.draft);
    await replySafe(msg, '↩️ Mensaje ignorado. Tu ticket sigue así:\n\n' + preview);
    setMode(s, 'confirm');
    return true;
  }

  // No reconoció
  await replySafe(msg,
    '🤔 No entendí. Por favor elige una opción:\n\n' +
    '• *enviar* — enviar el ticket actual y crear uno nuevo\n' +
    '• *reemplazar* — descartar el actual y usar el nuevo\n' +
    '• *agregar* — agregar como detalle al ticket actual\n' +
    '• *cancelar* — ignorar el mensaje'
  );
  return true;
}

/**
 * Handler para modo description_or_new
 * Menú: agregar/nuevo/cancelar
 */
async function handleDescriptionOrNew(ctx) {
  const {
    s, msg, text, replySafe, setMode, setDraftField, addArea, addDetail,
    findStrongPlaceSignals, normalizeAndSetLugar, detectArea, refreshIncidentDescription
  } = ctx;

  const t = norm(text);
  const pendingText = s._pendingDescriptionText || '';

  if (DEBUG) console.log('[DESC_OR_NEW] handling', { response: text });

  // Opción: agregar
  if (/^agregar\b/i.test(t) || /^a[ñn]adir\b/i.test(t) || isYes(text)) {
    addDetail(s, pendingText);
    s._pendingDescriptionText = null;

    const preview = formatPreviewMessage(s.draft);
    await replySafe(msg, '✅ Detalle agregado:\n\n' + preview);
    setMode(s, 'confirm');
    return true;
  }

  // Opción: nuevo ticket
  if (/^nuevo\b/i.test(t) || /^crear\b/i.test(t) || /^separar\b/i.test(t)) {
    // Guardar draft actual
    s._pendingOldIncidentDraft = { ...s.draft };

    // Crear nuevo draft
    s.draft = {
      descripcion: pendingText,
      descripcion_original: pendingText,
    };
    s._pendingDescriptionText = null;

    const strong = findStrongPlaceSignals ? findStrongPlaceSignals(pendingText) : null;
    if (strong) {
      await normalizeAndSetLugar(s, msg, strong.value, { rawText: pendingText });
    }

    try {
      const a = await detectArea(pendingText);
      if (a?.area) {
        setDraftField(s, 'area_destino', a.area);
        addArea(s, a.area);
      }
    } catch {}

    if (refreshIncidentDescription) {
      await refreshIncidentDescription(s, pendingText);
    }

    const preview = formatPreviewMessage(s.draft);
    await replySafe(msg, '📋 *Nuevo ticket:*\n\n' + preview);
    setMode(s, 'confirm');
    return true;
  }

  // Opción: cancelar
  if (/^cancelar?\b/i.test(t) || /^ignorar?\b/i.test(t) || isNo(text)) {
    s._pendingDescriptionText = null;

    const preview = formatPreviewMessage(s.draft);
    await replySafe(msg, '↩️ Mensaje ignorado. Tu ticket sigue así:\n\n' + preview);
    setMode(s, 'confirm');
    return true;
  }

  // No reconoció
  await replySafe(msg,
    '🤔 No entendí. Por favor elige:\n\n' +
    '• *agregar* — agregar como detalle al ticket actual\n' +
    '• *nuevo* — crear un ticket separado\n' +
    '• *cancelar* — ignorar el mensaje'
  );
  return true;
}

/**
 * Handler para modo context_switch
 */
async function handleContextSwitchMode(ctx) {
  const { s, msg, text, replySafe, setMode, resetSession } = ctx;

  const t = norm(text);

  if (DEBUG) console.log('[CONTEXT_SWITCH] handling', { response: text });

  // Continuar con actual
  if (/^continuar?\b/i.test(t) || /^seguir\b/i.test(t) || isYes(text)) {
    const preview = formatPreviewMessage(s.draft);
    await replySafe(msg, '👍 Continuamos con tu ticket:\n\n' + preview);
    setMode(s, 'confirm');
    return true;
  }

  // Empezar de nuevo
  if (/^nuevo\b/i.test(t) || /^reiniciar?\b/i.test(t) || /^empezar\b/i.test(t)) {
    resetSession(s.chatId);
    await replySafe(msg,
      '🔄 Ticket descartado.\n\n' +
      'Cuéntame el nuevo problema que quieres reportar.'
    );
    return true;
  }

  // Cancelar
  if (/^cancelar?\b/i.test(t) || isNo(text)) {
    resetSession(s.chatId);
    await replySafe(msg, '❌ Ticket cancelado.');
    return true;
  }

  await replySafe(msg,
    '🤔 No entendí. Opciones:\n\n' +
    '• *continuar* — seguir con el ticket actual\n' +
    '• *nuevo* — empezar un ticket nuevo\n' +
    '• *cancelar* — descartar todo'
  );
  return true;
}

/**
 * Handler para modo followup_decision
 * Decisión de followup con área diferente
 */
async function handleFollowupDecision(ctx) {
  const {
    s, msg, text, replySafe, setMode, resetSession, finalizeAndDispatch, client,
    refreshIncidentDescription
  } = ctx;

  const t = norm(text);
  const candidate = s._candidateFollowup;

  if (!candidate) {
    setMode(s, 'confirm');
    return true;
  }

  if (DEBUG) console.log('[FOLLOWUP_DECISION] handling', { response: text });

  // Opción 1: agregar al ticket actual
  if (/^(1|agregar|añadir|actual)\b/i.test(t)) {
    const currentDesc = s.draft.descripcion || '';
    const separator = currentDesc.endsWith('.') || currentDesc.endsWith('!') || currentDesc.endsWith('?') ? ' ' : '. ';
    s.draft.descripcion = currentDesc + separator + 'También ' + candidate.detail;

    if (refreshIncidentDescription) {
      await refreshIncidentDescription(s, null, s.draft.descripcion);
    }
    s._candidateFollowup = null;

    const preview = formatPreviewMessage(s.draft);
    await replySafe(msg, '✅ Detalle agregado al ticket actual:\n\n' + preview);
    setMode(s, 'confirm');
    return true;
  }

  // Opción 2: crear ticket separado
  if (/^(2|nuevo|separado)\b/i.test(t)) {
    const currentTicket = { ...s.draft, _ticketNum: 1 };

    const newTicket = {
      descripcion: candidate.detail,
      descripcion_original: candidate.detail,
      lugar: candidate.place || s.draft.lugar,
      area_destino: candidate.area,
      areas: [candidate.area],
      _ticketNum: 2,
    };

    s._multipleTickets = [currentTicket, newTicket];
    s._candidateFollowup = null;

    let msg1 = `📝 *Ticket 1* (${areaLabel(currentTicket.area_destino)}):\n`;
    msg1 += `   ${(currentTicket.descripcion || '').substring(0, 60)}...\n`;
    msg1 += `   📍 ${currentTicket.lugar}\n\n`;

    let msg2 = `📝 *Ticket 2* (${areaLabel(newTicket.area_destino)}):\n`;
    msg2 += `   ${(newTicket.descripcion || '').substring(0, 60)}...\n`;
    msg2 += `   📍 ${newTicket.lugar}\n\n`;

    await replySafe(msg,
      '✅ *Se crearon 2 tickets:*\n\n' +
      msg1 + msg2 +
      '¿Qué deseas hacer?\n' +
      '• *enviar* — Enviar ambos tickets\n' +
      '• *editar 1* — Editar ticket 1\n' +
      '• *editar 2* — Editar ticket 2\n' +
      '• *cancelar* — Descartar ambos'
    );
    setMode(s, 'multiple_tickets');
    return true;
  }

  // Opción 3: enviar ambos
  if (/^(3|ambos|los\s*dos)\b/i.test(t)) {
    const currentArea = s.draft.area_destino;

    await finalizeAndDispatch({ client, msg, session: s, silent: true });
    const folio1 = s._lastCreatedTicket?.folio || 'Ticket 1';

    s.draft = {
      descripcion: candidate.detail,
      descripcion_original: candidate.detail,
      lugar: candidate.place || s.draft?.lugar,
      area_destino: candidate.area,
      areas: [candidate.area],
    };

    if (refreshIncidentDescription) {
      await refreshIncidentDescription(s, candidate.detail);
    }

    await finalizeAndDispatch({ client, msg, session: s, silent: true });
    const folio2 = s._lastCreatedTicket?.folio || 'Ticket 2';

    s._candidateFollowup = null;

    await replySafe(msg,
      '✅ *2 tickets enviados:*\n\n' +
      `1️⃣ *${folio1}* — ${areaLabel(currentArea)}\n` +
      `2️⃣ *${folio2}* — ${areaLabel(candidate.area)}`
    );

    resetSession(s.chatId);
    return true;
  }

  // Opción 4: cancelar
  if (/^(4|cancelar|ignorar)\b/i.test(t)) {
    s._candidateFollowup = null;
    const preview = formatPreviewMessage(s.draft);
    await replySafe(msg, '👌 Ignorado. Tu ticket actual:\n\n' + preview);
    setMode(s, 'confirm');
    return true;
  }

  // No entendí
  await replySafe(msg,
    '🤔 No entendí. Responde:\n' +
    '• *1* o *agregar* — Agregar al ticket actual\n' +
    '• *2* o *nuevo* — Crear ticket separado\n' +
    '• *3* o *ambos* — Crear y enviar ambos\n' +
    '• *4* o *cancelar* — Ignorar'
  );
  return true;
}

/**
 * Handler para modo followup_place_decision
 * Decisión de followup con lugar diferente
 */
async function handleFollowupPlaceDecision(ctx) {
  const {
    s, msg, text, replySafe, setMode, setDraftField,
    refreshIncidentDescription
  } = ctx;

  const t = norm(text);
  const candidate = s._candidateFollowup;

  if (!candidate) {
    setMode(s, 'confirm');
    return true;
  }

  if (DEBUG) console.log('[FOLLOWUP_PLACE] handling', { response: text });

  // Opción 1: actualizar lugar
  if (/^(1|actualizar|cambiar)\b/i.test(t)) {
    const oldLugar = s.draft.lugar;
    setDraftField(s, 'lugar', candidate.place);

    const currentDesc = s.draft.descripcion || '';
    const separator = currentDesc.endsWith('.') || currentDesc.endsWith('!') || currentDesc.endsWith('?') ? ' ' : '. ';
    s.draft.descripcion = currentDesc + separator + 'También ' + candidate.detail;

    if (refreshIncidentDescription) {
      await refreshIncidentDescription(s, null, s.draft.descripcion);
    }
    s._candidateFollowup = null;

    const preview = formatPreviewMessage(s.draft);
    await replySafe(msg, `✅ Lugar actualizado a *${candidate.place}*:\n\n` + preview);
    setMode(s, 'confirm');
    return true;
  }

  // Opción 2: crear ticket separado
  if (/^(2|nuevo|separado)\b/i.test(t)) {
    const currentTicket = { ...s.draft, _ticketNum: 1 };
    const newTicket = {
      descripcion: candidate.detail,
      descripcion_original: candidate.detail,
      lugar: candidate.place,
      area_destino: candidate.area || s.draft.area_destino,
      areas: [candidate.area || s.draft.area_destino],
      _ticketNum: 2,
    };

    s._multipleTickets = [currentTicket, newTicket];
    s._candidateFollowup = null;

    await replySafe(msg,
      '✅ *Se crearon 2 tickets:*\n\n' +
      `📝 *Ticket 1:* ${currentTicket.lugar}\n` +
      `📝 *Ticket 2:* ${newTicket.lugar}\n\n` +
      '• *enviar* — Enviar ambos\n' +
      '• *editar 1/2* — Editar\n' +
      '• *cancelar* — Descartar'
    );
    setMode(s, 'multiple_tickets');
    return true;
  }

  // Opción 3: cancelar
  if (/^(3|cancelar|ignorar)\b/i.test(t)) {
    s._candidateFollowup = null;
    const preview = formatPreviewMessage(s.draft);
    await replySafe(msg, '👌 Ignorado. Tu ticket actual:\n\n' + preview);
    setMode(s, 'confirm');
    return true;
  }

  // No entendí
  await replySafe(msg,
    '🤔 No entendí. Responde:\n' +
    '• *1* o *actualizar* — Cambiar lugar\n' +
    '• *2* o *nuevo* — Crear ticket separado\n' +
    '• *3* o *cancelar* — Ignorar'
  );
  return true;
}

/**
 * Handler principal para modos de cambio de contexto
 */
async function handleContextSwitch(ctx) {
  const { s, text } = ctx;

  if (!text) return false;

  switch (s.mode) {
    case 'different_problem':
      return handleDifferentProblem(ctx);
    case 'description_or_new':
      return handleDescriptionOrNew(ctx);
    case 'context_switch':
      return handleContextSwitchMode(ctx);
    case 'followup_decision':
      return handleFollowupDecision(ctx);
    case 'followup_place_decision':
      return handleFollowupPlaceDecision(ctx);
    default:
      return false;
  }
}

module.exports = { handleContextSwitch };

/**
 * niHandlers/modeConfirm.js
 * Handlers para modos de confirmación:
 * - confirm/preview: confirmación de ticket individual
 * - confirm_batch: confirmación de múltiples tickets
 * - confirm_new_ticket_decision: manejo de decisión para nuevo ticket con lugar diferente
 */

const {
  DEBUG,
  norm,
  isYes,
  isNo,
  areaLabel,
  formatPreviewMessage,
  formatTicketSummary,
  classifyConfirmMessage,
  hasRequiredDraft,
  normalizeAreaCode,
} = require('./shared');

const { interpretEditMessage } = require('./interpretEditMessage');

// Áreas permitidas (exportar desde shared.js en el futuro)
const ALLOWED_AREAS = new Set(['RS', 'AMA', 'MAN', 'IT', 'SEG']);

/**
 * Handler IA para edición de UN SOLO ticket dentro de modo 'confirm'
 */
async function handleEditSingleTicket(ctx) {
  const {
    s, text = '', msg, replySafe,
    interpretEditMessage: ctxInterpret,
    normalizeAndSetLugar, detectPlace,
    formatPreviewMessage: fmtPreview, finalizeAndDispatch,
    setMode, resetSession, client
  } = ctx;

  const interpret = ctxInterpret || interpretEditMessage;
  const formatPreviewFn = fmtPreview || formatPreviewMessage;

  if (!text) return false;

  const draft = s.draft || s._editingDraft;
  if (!draft) {
    if (DEBUG) console.warn('[EDIT-SINGLE] no draft found');
    await replySafe(msg, 'Error interno: no hay borrador activo. Volviendo al menú.');
    setMode(s, 'neutral');
    return true;
  }

  const tRaw = (text || '').trim();
  const t = tRaw.toLowerCase();

  // Confirmación directa: enviar
  if (isYes(t)) {
    if (DEBUG) console.log('[EDIT-SINGLE] user confirmed send');
    try {
      const result = await finalizeAndDispatch({ client, msg, session: s });
      if (result?.success) {
        await replySafe(msg, `✅ Ticket enviado: *${result.folio || result.id || 'SIN_FOLIO'}*`);
        s.draft = undefined;
        s._editingDraft = undefined;
        try { resetSession(s.chatId); } catch (e) { if (DEBUG) console.warn('[EDIT-SINGLE] resetSession err', e?.message); }
        setMode(s, 'neutral');
      } else {
        await replySafe(msg, '❌ Error al enviar el ticket. Intenta de nuevo.');
      }
    } catch (e) {
      if (DEBUG) console.warn('[EDIT-SINGLE] finalize error', e?.message);
      await replySafe(msg, '❌ Error al enviar el ticket. Intenta de nuevo.');
    }
    return true;
  }

  // Confirmación: cancelar envío
  if (isNo(t)) {
    await replySafe(msg, 'Ok — no se envió. Puedes seguir editando o escribir *listo* para volver al menú.');
    return true;
  }

  // "listo" -> terminar edición y volver al menú (sin enviar)
  if (['listo', 'ok', 'terminar', 'finalizar', 'hecho'].includes(t)) {
    s._editingDraft = undefined;
    setMode(s, 'neutral');
    await replySafe(msg, 'Edición finalizada. Volviendo al menú principal.');
    return true;
  }

  // Evitar enviar mensajes cortos a la IA
  if (tRaw.length < 3) {
    await replySafe(msg, 'Escribe la edición que quieres aplicar (p.ej. "Cambia el lugar a 2101" o "Es una fuga de agua").');
    return true;
  }

  // Invocamos al intérprete IA para obtener acciones
  let editIntent = null;
  try {
    editIntent = await interpret(ctx, tRaw, { currentTicket: draft, mode: 'single' });
    if (DEBUG) console.log('[EDIT-SINGLE] interpretEditMessage result', { editIntent });
  } catch (e) {
    if (DEBUG) console.warn('[EDIT-SINGLE] interpret error', e?.message);
    editIntent = null;
  }

  if (editIntent?.needsClarification) {
    await replySafe(msg, editIntent.clarify || '¿Puedes especificar con más detalle qué quieres cambiar?');
    return true;
  }

  if (editIntent && Array.isArray(editIntent.actions) && editIntent.actions.length) {
    for (const a of editIntent.actions) {
      const { field, value } = a;
      if (value === undefined || value === null) continue;

      if (field === 'descripcion') {
        draft.descripcion = String(value).trim();
        draft.descripcion_original = draft.descripcion;

      } else if (field === 'lugar') {
        let placeRes = null;
        try {
          if (typeof normalizeAndSetLugar === 'function') {
            placeRes = await normalizeAndSetLugar(s, msg, value, { fromEdit: true });
          } else if (typeof detectPlace === 'function') {
            placeRes = await detectPlace(value);
          }
        } catch (e) {
          if (DEBUG) console.warn('[EDIT-SINGLE] normalize/detectPlace error', e?.message);
          placeRes = null;
        }

        const hasCandidates = placeRes && Array.isArray(placeRes.candidates) && placeRes.candidates.length > 0;
        const found = !!(placeRes && (placeRes.found || placeRes.label || placeRes.lugar || placeRes.canonical_label));

        if (found) {
          draft.lugar = placeRes.label || placeRes.lugar || placeRes.canonical_label || String(value).trim();
        } else if (hasCandidates) {
          s._placeCandidates = placeRes.candidates;
          s._pendingPlaceText = value;
          await replySafe(msg,
            `⚠️ No hay un match exacto para el lugar "${value}". Encontré coincidencias posibles:\n\n` +
            placeRes.candidates.slice(0, 5).map((c, i) => `• ${i + 1}. ${c.label || c}`).join('\n') +
            `\n\nResponde con el número para elegir, o escribe el lugar exactamente como aparece.`);
          setMode(s, 'choose_place_from_candidates');
          return true;
        } else {
          if (DEBUG) console.warn('[EDIT-SINGLE] place not recognized', { value, placeRes });
          let suggestions = null;
          try {
            if (typeof ctx?.findPlaceSuggestions === 'function') {
              suggestions = await ctx.findPlaceSuggestions(value);
            } else if (typeof detectPlace === 'function') {
              const fuzzy = await detectPlace(value, { fuzzy: true });
              suggestions = fuzzy?.candidates || fuzzy?.suggestions || null;
            }
          } catch (e) {
            if (DEBUG) console.warn('[EDIT-SINGLE] suggestion lookup error', e?.message);
          }
          if (Array.isArray(suggestions) && suggestions.length) {
            s._placeCandidates = suggestions;
            s._pendingPlaceText = value;
            await replySafe(msg,
              `⚠️ LUGAR NO RECONOCIDO: "${value}".\n\nPosibles sugerencias:\n` +
              suggestions.slice(0, 5).map((c, i) => `• ${i + 1}. ${c.label || c}`).join('\n') +
              `\n\nResponde con el número para elegir, o escribe el lugar exactamente como aparece.`);
            setMode(s, 'choose_place_from_candidates');
            return true;
          }
          await replySafe(msg,
            `⚠️ LUGAR NO RECONOCIDO: "${value}".\n` +
            `El lugar debe existir en el catálogo. Escribe el lugar de nuevo o usa un nombre más específico (p.ej. "Front Desk", "Lobby", "Habitación 2301").`);
          return true;
        }

      } else if (field === 'area_destino' || field === 'area') {
        draft.area_destino = String(value).toLowerCase();

      } else {
        const piece = String(value).trim();
        if (piece) {
          draft.descripcion = draft.descripcion ? draft.descripcion + ' ' + piece : piece;
          draft.descripcion_original = draft.descripcion;
        }
      }
    }

    s.draft = draft;
    s._editingDraft = draft;

    const preview = (typeof formatPreviewFn === 'function') ? formatPreviewFn(draft) : JSON.stringify(draft, null, 2);

    const resp =
      `✅ Cambios aplicados:\n\n` +
      `${preview}\n\n` +
      `Responde *sí* para enviar o *no* para cancelar.`;

    await replySafe(msg, resp);
    return true;
  }

  await replySafe(msg, 'No entendí la edición. ¿Qué deseas cambiar exactamente? (p.ej. "Cambia la descripción a ...", "Poner lugar 2101")');
  return true;
}

/**
 * Handler para modo confirm/preview
 */
async function handleConfirmMode(ctx) {
  const { s, msg, text, replySafe, setMode } = ctx;

  if (!text) return false;

  const classification = classifyConfirmMessage(text, s.draft);

  if (DEBUG) console.log('[CONFIRM] classification', { text, classification, mode: s.mode });

  switch (classification) {
    case 'confirm':
      return await handleConfirmYes(ctx);

    case 'cancel':
      return await handleConfirmNo(ctx);

    case 'edit_command':
      return await handleEditCommand(ctx);

    case 'place_change':
      return await handlePlaceChange(ctx);

    case 'area_change':
      return await handleAreaChange(ctx);

    case 'room_number':
      return await handleRoomNumber(ctx);

    case 'detail_followup':
      return await handleDetailFollowup(ctx);

    case 'new_incident_candidate':
      return await handleNewIncidentCandidate(ctx);

    case 'long_message':
      return await handleEditSingleTicket(ctx);

    default:
      if (text && text.trim().length >= 3) {
        return await handleEditSingleTicket(ctx);
      }
      const preview = formatPreviewMessage(s.draft);
      await replySafe(msg, preview + '\n\n_Responde *sí* para enviar o *no* para cancelar._');
      return true;
  }
}

/**
 * Confirmación positiva - enviar ticket
 */
async function handleConfirmYes(ctx) {
  const { s, msg, replySafe, finalizeAndDispatch, client, resetSession, setMode } = ctx;

  if (!hasRequiredDraft(s.draft)) {
    const preview = formatPreviewMessage(s.draft);
    await replySafe(msg, '⚠️ Faltan datos:\n\n' + preview);
    return true;
  }

  try {
    const result = await finalizeAndDispatch({ client, msg, session: s });
    if (!result?.success) {
      await replySafe(msg, '❌ Error al enviar el ticket. Intenta de nuevo.');
      return true;
    } else {
      await replySafe(msg, `✅ Ticket enviado: *${result.folio || result.id || 'SIN_FOLIO'}*`);
      try { resetSession(s.chatId); } catch (e) { if (DEBUG) console.warn('[CONFIRM] resetSession error', e?.message); }
      setMode(s, 'neutral');
      return true;
    }
  } catch (e) {
    if (DEBUG) console.error('[CONFIRM] dispatch error', e?.message);
    await replySafe(msg, '❌ Error al enviar el ticket. Intenta de nuevo.');
    return true;
  }
}

/**
 * Cancelación - descartar ticket
 */
async function handleConfirmNo(ctx) {
  const { s, msg, replySafe, resetSession, setMode } = ctx;

  resetSession(s.chatId);
  setMode(s, 'neutral');
  await replySafe(msg, '❌ Ticket cancelado. Si necesitas reportar algo más, cuéntame.');
  return true;
}

/**
 * Comando de edición
 */
async function handleEditCommand(ctx) {
  const { s, msg, replySafe, setMode } = ctx;

  setMode(s, 'edit_menu');
  await replySafe(msg,
    '✏️ ¿Qué quieres editar?\n\n' +
    '• *1* — Descripción\n' +
    '• *2* — Lugar\n' +
    '• *3* — Área\n' +
    '• *cancelar* — Volver al ticket'
  );
  return true;
}

/**
 * Cambio express de lugar
 */
async function handlePlaceChange(ctx) {
  const { s, msg, text, replySafe, normalizeAndSetLugar, setMode, detectPlace } = ctx;

  const placeMatch = text.match(/(?:en|lugar[:\s]*)\s*(.+)/i);
  const placeText = placeMatch ? placeMatch[1].trim() : text;

  let placeRes = null;
  try {
    if (typeof normalizeAndSetLugar === 'function') {
      placeRes = await normalizeAndSetLugar(s, msg, placeText, { rawText: text });
    } else if (typeof detectPlace === 'function') {
      placeRes = await detectPlace(placeText);
    }
  } catch (e) {
    if (DEBUG) console.warn('[PLACE-CHANGE] normalize/detect error', e?.message);
    placeRes = null;
  }

  const found = !!(placeRes && (placeRes.found || placeRes.label || placeRes.lugar || placeRes.canonical_label));
  const hasCandidates = placeRes && Array.isArray(placeRes.candidates) && placeRes.candidates.length > 0;

  if (found) {
    s.draft.lugar = placeRes.label || placeRes.lugar || placeRes.canonical_label || placeText;
    const preview = formatPreviewMessage(s.draft);
    await replySafe(msg, '✅ Lugar actualizado:\n\n' + preview);
    setMode(s, 'confirm');
    return true;
  } else if (hasCandidates) {
    s._placeCandidates = placeRes.candidates;
    s._pendingPlaceText = placeText;
    await replySafe(msg,
      `⚠️ No hay un match exacto para el lugar "${placeText}". Coincidencias posibles:\n\n` +
      placeRes.candidates.slice(0, 5).map((c, i) => `• ${i + 1}. ${c.label || c}`).join('\n') +
      `\n\nResponde con el número para elegir, o escribe el lugar exactamente como aparece.`
    );
    setMode(s, 'choose_place_from_candidates');
    return true;
  } else {
    if (DEBUG) console.warn('[PLACE-CHANGE] place not recognized', { placeText, placeRes });
    let suggestions = null;
    try {
      if (typeof ctx?.findPlaceSuggestions === 'function') {
        suggestions = await ctx.findPlaceSuggestions(placeText);
      } else if (typeof detectPlace === 'function') {
        const fuzzy = await detectPlace(placeText, { fuzzy: true });
        suggestions = fuzzy?.candidates || fuzzy?.suggestions || null;
      }
    } catch (e) {
      if (DEBUG) console.warn('[PLACE-CHANGE] suggestion lookup error', e?.message);
    }
    if (Array.isArray(suggestions) && suggestions.length) {
      s._placeCandidates = suggestions;
      s._pendingPlaceText = placeText;
      await replySafe(msg,
        `⚠️ LUGAR NO RECONOCIDO: "${placeText}".\n\nPosibles sugerencias:\n` +
        suggestions.slice(0, 5).map((c, i) => `• ${i + 1}. ${c.label || c}`).join('\n') +
        `\n\nResponde con el número para elegir, o escribe el lugar exactamente como aparece.`
      );
      setMode(s, 'choose_place_from_candidates');
      return true;
    }

    await replySafe(msg,
      `⚠️ LUGAR NO RECONOCIDO: "${placeText}".\n` +
      `El lugar debe existir en el catálogo. Escribe el lugar de nuevo o usa un nombre más específico (p.ej. "Front Desk", "Lobby", "Habitación 2301").`);
    return true;
  }
}

/**
 * Cambio de área
 */
async function handleAreaChange(ctx) {
  const { s, msg, text, replySafe, setMode, setDraftField, addArea } = ctx;

  const areaMatch = text.match(/(?:para|de|área[:\s]*)\s*(it|mantenimiento|man|ama|hskp|seguridad|seg|rs|room\s*service)/i);

  if (areaMatch) {
    const areaMap = {
      'it': 'it', 'mantenimiento': 'man', 'man': 'man',
      'ama': 'ama', 'hskp': 'ama',
      'seguridad': 'seg', 'seg': 'seg',
      'rs': 'rs', 'room service': 'rs', 'roomservice': 'rs'
    };
    const areaCode = areaMap[areaMatch[1].toLowerCase().replace(/\s+/g, '')] || areaMatch[1].toLowerCase();

    setDraftField(s, 'area_destino', areaCode);
    addArea(s, areaCode);

    const preview = formatPreviewMessage(s.draft);
    await replySafe(msg, `✅ Área: *${areaLabel(areaCode)}*\n\n` + preview);
    setMode(s, 'confirm');
    return true;
  }

  setMode(s, 'choose_area_multi');
  await replySafe(msg,
    '🏷️ Elige el área destino:\n\n' +
    '• *1* — Mantenimiento\n' +
    '• *2* — IT\n' +
    '• *3* — HSKP\n' +
    '• *4* — Room Service\n' +
    '• *5* — Seguridad'
  );
  return true;
}

/**
 * Número de habitación suelto
 */
async function handleRoomNumber(ctx) {
  const { s, msg, text, replySafe, setDraftField, setMode } = ctx;

  const roomNum = text.trim();
  setDraftField(s, 'lugar', `Habitación ${roomNum}`);

  const preview = formatPreviewMessage(s.draft);
  await replySafe(msg, `✅ Lugar: *Habitación ${roomNum}*\n\n` + preview);
  setMode(s, 'confirm');
  return true;
}

/**
 * Detalle adicional (también..., además...)
 */
async function handleDetailFollowup(ctx) {
  const { s, msg, text, replySafe, addDetail, setMode } = ctx;

  const detail = text.replace(/^(tambi[eé]n|adem[aá]s|y\s+tambi[eé]n|aparte|y\s+aparte|otro\s+detalle|otra\s+cosa)[,.]?\s*/i, '').trim();

  if (detail) {
    addDetail(s, detail);
    const preview = formatPreviewMessage(s.draft);
    await replySafe(msg, '✅ Detalle agregado:\n\n' + preview);
  } else {
    await replySafe(msg, '¿Qué más quieres agregar?');
  }

  setMode(s, 'confirm');
  return true;
}

/**
 * Posible nuevo incidente con lugar diferente
 */
async function handleNewIncidentCandidate(ctx) {
  const {
    s, msg, text, replySafe, setMode,
    findStrongPlaceSignals, detectArea
  } = ctx;

  const newPlace = findStrongPlaceSignals ? findStrongPlaceSignals(text) : null;
  const currentPlace = s.draft?.lugar || '';

  let isDifferentPlace = false;
  if (newPlace && currentPlace) {
    const newPlaceNorm = norm(newPlace.value);
    const currentPlaceNorm = norm(currentPlace);
    isDifferentPlace = !currentPlaceNorm.includes(newPlaceNorm) && !newPlaceNorm.includes(currentPlaceNorm);
  }

  let newArea = null;
  try {
    const areaResult = await detectArea(text);
    newArea = areaResult?.area;
  } catch {}

  const isDifferentArea = newArea && s.draft?.area_destino && newArea !== s.draft.area_destino;

  if (isDifferentPlace || isDifferentArea) {
    s._pendingNewTicket = {
      descripcion: text,
      lugar: newPlace?.value || null,
      area_destino: newArea || null,
    };

    const currentDesc = (s.draft.descripcion || '').substring(0, 60);
    const newDesc = text.substring(0, 60);

    await replySafe(msg,
      '🤔 *Detecté un problema en otro lugar.*\n\n' +
      `📋 *Ticket actual:*\n   _"${currentDesc}..."_\n   📍 ${s.draft.lugar}\n\n` +
      `🆕 *Nuevo problema:*\n   _"${newDesc}..."\n\n` +
      '¿Qué quieres hacer?\n' +
      '• *1* — Crear ticket *nuevo* (además del actual)\n' +
      '• *2* — *Reemplazar* lugar del ticket actual\n' +
      '• *cancelar* — Descartar el nuevo mensaje'
    );
    setMode(s, 'confirm_new_ticket_decision');
    return true;
  }

  await replySafe(msg,
    '🤔 Recibí más información. ¿Qué hago?\n\n' +
    '• *agregar* — Agregar como detalle al ticket actual\n' +
    '• *nuevo* — Crear un ticket separado\n' +
    '• *ignorar* — Descartar este mensaje'
  );
  s._pendingDescriptionText = text;
  setMode(s, 'description_or_new');
  return true;
}

/**
 * Handler para modo confirm_new_ticket_decision
 * Maneja la respuesta del usuario para crear nuevo ticket o reemplazar lugar
 */
async function handleConfirmNewTicketDecision(ctx) {
  const { s, text, replySafe, setMode } = ctx;
  const t = (text || '').trim().toLowerCase();

  if (!s._pendingNewTicket) {
    setMode(s, 'neutral');
    await replySafe(ctx.msg, 'No hay nuevo ticket pendiente. Volviendo al menú principal.');
    return true;
  }

  if (t === '1') {
    s._multipleTickets = s._multipleTickets || [];
    if (s.draft && !s.draft._migratedToMultiple) {
      s.draft._migratedToMultiple = true;
      s._multipleTickets.push({ ...s.draft });
    }
    s._multipleTickets.push({ ...s._pendingNewTicket, _ticketNum: s._multipleTickets.length + 1 });

    s.draft = {};
    delete s._pendingNewTicket;

    setMode(s, 'multiple_tickets');
    await replySafe(ctx.msg, '✅ Nuevo ticket creado además del actual. Ahora puedes gestionar múltiples tickets.');
    return true;
  }

  if (t === '2') {
    s.draft.lugar = s._pendingNewTicket.lugar;
    s.draft.area_destino = s._pendingNewTicket.area_destino || s.draft.area_destino;
    s.draft.descripcion = s._pendingNewTicket.descripcion;

    delete s._pendingNewTicket;
    setMode(s, 'confirm');

    await replySafe(ctx.msg, '✅ Lugar y descripción del ticket actual actualizados.');
    return true;
  }

  if (t === 'cancelar' || t === 'cancel') {
    delete s._pendingNewTicket;
    setMode(s, 'neutral');
    await replySafe(ctx.msg, '❌ Nuevo mensaje descartado, manteniendo el ticket actual.');
    return true;
  }

  await replySafe(ctx.msg, 'Por favor responde con *1*, *2* o *cancelar*.');
  return true;
}

/**
 * Handler para modo confirm_batch
 */
async function handleConfirmBatch(ctx) {
  const { s, msg, text, replySafe, finalizeAndDispatch, client, setMode, resetSession } = ctx;

  const batchTickets = s._batchTickets || [];
  const t = norm(text);

  if (DEBUG) console.log('[CONFIRM_BATCH] handling', { response: text, ticketCount: batchTickets.length });

  // Confirmar todos
  if (isYes(text)) {
    const results = [];

    for (let i = 0; i < batchTickets.length; i++) {
      const ticket = batchTickets[i];
      try {
        const originalDraft = s.draft;
        s.draft = { ...ticket };

        // Normalizar / validar área
        const rawArea = (s.draft.area_destino || '').toString().trim();
        let normArea = null;
        try {
          normArea = normalizeAreaCode(rawArea);
        } catch (e) {
          if (DEBUG) console.warn('[CONFIRM_BATCH] normalizeAreaCode error', e?.message);
        }
        const areaToUse = (normArea || rawArea || '').toString().trim().toUpperCase();

        if (!areaToUse || !ALLOWED_AREAS.has(areaToUse)) {
          if (DEBUG) console.warn('[CONFIRM_BATCH] invalid area', { idx: i, rawArea, normArea, areaToUse });
          results.push({ success: false, index: i, ticket, error: 'invalid_area', rawArea, normArea });
          s.draft = originalDraft;
          continue;
        }

        s.draft.area_destino = areaToUse;

        if (!hasRequiredDraft(s.draft)) {
          if (DEBUG) console.warn('[CONFIRM_BATCH] missing fields', { idx: i, draft: s.draft });
          results.push({ success: false, index: i, ticket, error: 'missing_fields' });
          s.draft = originalDraft;
          continue;
        }

        const result = await finalizeAndDispatch({ client, msg, session: s, silent: true });

        if (result?.success) {
          results.push({ success: true, index: i, ticket, folio: result.folio, id: result.id });
        } else {
          const err = result?.error || result?.message || 'dispatch_failed';
          if (DEBUG) console.warn('[CONFIRM_BATCH] finalizeAndDispatch failed', { idx: i, err, result });
          results.push({ success: false, index: i, ticket, error: err });
        }

        s.draft = originalDraft;
      } catch (e) {
        if (DEBUG) console.warn('[CONFIRM_BATCH] dispatch error', e?.message);
        results.push({ success: false, index: i, ticket, error: e?.message || 'exception' });
      }
    }

    const successful = results.filter(r => r.success);
    const failed = results.filter(r => !r.success);

    let response = `✅ *${successful.length} ticket(s) enviado(s)*`;
    if (successful.length > 0) {
      response += ':\n' + successful.map(r => `• ${r.folio || r.id || 'SIN_FOLIO'}`).join('\n');
    }

    if (failed.length > 0) {
      response += `\n\n❌ *${failed.length} ticket(s) fallaron*:`;
      failed.forEach((f) => {
        const i = f.index + 1;
        const shortErr = f.error || 'error desconocido';
        const summary = formatTicketSummary(f.ticket, i);
        response += `\n\n${i}. ${shortErr}\n${summary}`;
      });

      s._batchTickets = failed.map(f => f.ticket);
      setMode(s, 'confirm_batch');

      response += `\n\nOpciones:\n• *editar N* — editar ticket N\n• *reenviar N* — intentar enviar solo N\n• *reenviar fallidos* — intentar enviar todos los fallidos\n• *cancelar* — descartar los tickets fallidos`;
      await replySafe(msg, response);
      return true;
    }

    s._batchTickets = [];
    await replySafe(msg, response);
    try { resetSession(s.chatId); } catch (e) { if (DEBUG) console.warn('[CONFIRM_BATCH] resetSession error', e?.message); }
    return true;
  }

  // Cancelar
  if (isNo(text)) {
    s._batchTickets = [];
    try { resetSession(s.chatId); } catch (e) { if (DEBUG) console.warn('[CONFIRM_BATCH] resetSession error', e?.message); }
    await replySafe(msg, '❌ Tickets cancelados.');
    return true;
  }

  // Reenviar fallidos
  if (t === 'reenviar fallidos' || t === 'reenviar fallidos.' || t === 'reenviar fallidos!') {
    if ((s._batchTickets || []).length === 0) {
      await replySafe(msg, 'No hay tickets fallidos pendientes para reenviar.');
      return true;
    }
    return handleConfirmBatch({ ...ctx, text: 'sí' });
  }

  // Editar un ticket específico
  const editMatch = t.match(/^editar?\s*(\d+)/i);
  if (editMatch) {
    const ticketNum = parseInt(editMatch[1], 10) - 1;
    if (ticketNum >= 0 && ticketNum < batchTickets.length) {
      s._editingTicketNum = ticketNum;
      setMode(s, 'edit_batch_ticket');

      const ticket = batchTickets[ticketNum];
      await replySafe(msg,
        `✏️ Editando ticket ${ticketNum + 1}:\n\n` +
        `• Descripción: ${ticket.descripcion || '—'}\n` +
        `• Lugar: ${ticket.lugar || '—'}\n` +
        `• Área: ${areaLabel(ticket.area_destino)}\n\n` +
        '¿Qué quieres cambiar? (descripción/lugar/área/listo)'
      );
      return true;
    }
  }

  // Reenviar un ticket específico
  const resendMatch = t.match(/^reenviar\s*(\d+)/i);
  if (resendMatch) {
    const ticketNum = parseInt(resendMatch[1], 10) - 1;
    if (ticketNum >= 0 && ticketNum < batchTickets.length) {
      const onlyTicket = batchTickets[ticketNum];
      const originalDraft = s.draft;
      s.draft = { ...onlyTicket };

      let normArea = null;
      try {
        normArea = normalizeAreaCode(s.draft.area_destino || '');
      } catch (e) {
        if (DEBUG) console.warn('[CONFIRM_BATCH] normalizeAreaCode error', e?.message);
      }
      const areaToUse = (normArea || (s.draft.area_destino || '')).toString().trim().toUpperCase();

      if (!areaToUse || !ALLOWED_AREAS.has(areaToUse)) {
        await replySafe(msg, `Área inválida para el ticket ${ticketNum + 1}. Usa: RS, AMA, MAN, IT, SEG. Usa *editar ${ticketNum + 1}* para corregirlo.`);
        s.draft = originalDraft;
        return true;
      }
      s.draft.area_destino = areaToUse;

      if (!hasRequiredDraft(s.draft)) {
        await replySafe(msg, `Faltan campos en el ticket ${ticketNum + 1}. Usa *editar ${ticketNum + 1}* para completarlo.`);
        s.draft = originalDraft;
        return true;
      }

      try {
        const result = await finalizeAndDispatch({ client, msg, session: s, silent: true });
        s.draft = originalDraft;
        if (result?.success) {
          const remaining = batchTickets.filter((_, idx) => idx !== ticketNum);
          s._batchTickets = remaining;
          await replySafe(msg, `✅ Ticket reenviado: ${result.folio || result.id}`);
          if (!s._batchTickets.length) {
            try { resetSession(s.chatId); } catch (e) { if (DEBUG) console.warn('[CONFIRM_BATCH] resetSession error', e?.message); }
          }
        } else {
          await replySafe(msg, `❌ No se pudo reenviar el ticket: ${result?.error || 'error desconocido'}`);
        }
      } catch (e) {
        if (DEBUG) console.warn('[CONFIRM_BATCH] resend error', e?.message);
        await replySafe(msg, `❌ Error reenviando ticket: ${e?.message || 'exception'}`);
        s.draft = originalDraft;
      }
      return true;
    }
  }

  // Mostrar resumen por defecto
  let summary = `📋 *${batchTickets.length} tickets pendientes:*\n\n`;
  batchTickets.forEach((tkt, i) => {
    summary += formatTicketSummary(tkt, i + 1) + '\n\n';
  });
  summary += '_Responde *sí* para enviar todos, *no* para cancelar, *editar N* para modificar, o *reenviar N* para reenviar solo N._';

  await replySafe(msg, summary);
  return true;
}

/**
 * Handler principal para modos de confirmación
 */
async function handleConfirm(ctx) {
  const { s, text } = ctx;

  if (!text) return false;

  switch (s.mode) {
    case 'confirm':
    case 'preview':
      return handleConfirmMode(ctx);
    case 'confirm_batch':
      return handleConfirmBatch(ctx);
    case 'confirm_new_ticket_decision':
      return handleConfirmNewTicketDecision(ctx);
    default:
      return false;
  }
}

module.exports = { handleConfirm };
/**
 * niHandlers/modeConfirm.js
 * Handlers para modos de confirmación:
 * - confirm/preview: confirmación de ticket individual
 * - confirm_batch: confirmación de múltiples tickets
 * - confirm_new_ticket_decision: manejo de decisión para nuevo ticket con lugar diferente
 *
 * ✅ Cambios incluidos:
 * - Todos los handlers para classifyConfirmMessage implementados
 * - Anti doble-dispatch por áreas
 * - Manejo robusto de errores
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

// Áreas permitidas
const ALLOWED_AREAS = new Set(['RS', 'AMA', 'MAN', 'IT', 'SEG']);

// ──────────────────────────────────────────────────────────────
// Heurísticas
// ──────────────────────────────────────────────────────────────
function looksLikeIncidentText(text = '') {
  const t = norm(text);
  if (!t || t.length < 6) return false;

  return /(no\s+(hay|tiene|sirve|funciona|prende|enciende|apoyan)|sin\s+(agua|luz|internet|wifi)|fuga|gotea|tapad|atorad|roto|dañad|fall(a|o)|agua\s+(fria|caliente)|wc|inodoro|regadera|clima|aire|tv|chromecast|internet|wifi|plunge|plush\s*pool|pool|jacuzzi)/i.test(t);
}

function isDifferentPlaceStrong(currentPlace = '', newPlaceValue = '') {
  const a = norm(currentPlace);
  const b = norm(newPlaceValue);
  if (!a || !b) return false;
  return !a.includes(b) && !b.includes(a);
}

/**
 * Helper defensivo: alinear areas[] con area_destino
 */
function syncAreasWithPrimary(s, draft) {
  const d = draft || s?.draft;
  if (!d) return;

  const a = (d.area_destino || '').toString().trim().toUpperCase();
  if (!a || !ALLOWED_AREAS.has(a)) return;

  d.area_destino = a;
  d.areas = [a];

  if (Array.isArray(s.areas)) s.areas = [a];
  if (Array.isArray(s._areas)) s._areas = [a];
}

/**
 * Extrae número de habitación de un texto
 */
function extractRoomNumber(text = '') {
  const match = text.match(/\b(\d{3,4})\b/);
  return match ? match[1] : null;
}

/**
 * Extrae lugar de patrones comunes
 */
function extractPlaceFromText(text = '') {
  const patterns = [
    /(?:en\s+(?:la\s+)?(?:hab(?:itaci[oó]n)?)?\s*)(\d{3,4})/i,
    /(?:lugar[:\s]+)(.+)/i,
    /(?:es\s+en\s+)(.+)/i,
    /(?:cambia(?:r)?\s+(?:el\s+)?lugar\s+(?:a|para)\s+)(.+)/i,
  ];

  for (const rx of patterns) {
    const m = text.match(rx);
    if (m && m[1]) return m[1].trim();
  }

  const roomMatch = text.match(/^\d{3,4}$/);
  if (roomMatch) return roomMatch[0];

  return null;
}

/**
 * Extrae área de patrones comunes
 */
function extractAreaFromText(text = '') {
  const t = norm(text);
  
  const areaMap = {
    'it': 'IT',
    'sistemas': 'IT',
    'mantenimiento': 'MAN',
    'mantto': 'MAN',
    'ama': 'AMA',
    'hskp': 'AMA',
    'housekeeping': 'AMA',
    'seguridad': 'SEG',
    'rs': 'RS',
    'room service': 'RS',
    'roomservice': 'RS',
  };

  for (const [key, value] of Object.entries(areaMap)) {
    if (t.includes(key)) return value;
  }

  return null;
}

// ──────────────────────────────────────────────────────────────
// HANDLERS INDIVIDUALES
// ──────────────────────────────────────────────────────────────

/**
 * Handler para confirmación: enviar ticket
 */
async function handleConfirmYes(ctx) {
  const { s, msg, replySafe, finalizeAndDispatch, client, resetSession, setMode } = ctx;

  const draft = s?.draft;
  if (!draft) {
    setMode(s, 'neutral');
    await replySafe(msg, '⚠️ No hay ticket activo para confirmar. Volviendo al menú.');
    return true;
  }

  syncAreasWithPrimary(s, draft);

  if (!hasRequiredDraft(draft)) {
    const preview = formatPreviewMessage(draft);
    await replySafe(msg, preview + '\n\n⚠️ Aún faltan datos. Indícame lo que falta para poder enviarlo.');
    return true;
  }

  try {
    const result = await finalizeAndDispatch({ client, msg, session: s });
    if (result?.success) {
      await replySafe(msg, `✅ Ticket enviado: *${result.folio || result.id || 'SIN_FOLIO'}*`);
      try { resetSession(s.chatId); } catch {}
      setMode(s, 'neutral');
      return true;
    }
    await replySafe(msg, '❌ No pude enviar el ticket. Intenta de nuevo.');
    return true;
  } catch (e) {
    if (DEBUG) console.warn('[CONFIRM] finalizeAndDispatch error', e?.message);
    await replySafe(msg, '❌ Error al enviar el ticket. Intenta de nuevo.');
    return true;
  }
}

/**
 * Handler para cancelación
 */
async function handleConfirmNo(ctx) {
  const { s, msg, replySafe, resetSession, setMode } = ctx;

  try { resetSession(s.chatId); } catch {}
  setMode(s, 'neutral');
  await replySafe(msg, '❌ Ticket cancelado. Si necesitas reportar algo más, dime.');
  return true;
}

/**
 * Handler para comando de edición explícito ("editar", "modificar")
 */
async function handleEditCommand(ctx) {
  const { s, msg, replySafe, setMode } = ctx;

  const draft = s?.draft;
  if (!draft) {
    await replySafe(msg, '⚠️ No hay ticket activo para editar.');
    return true;
  }

  s._editingDraft = draft;
  setMode(s, 'edit_ticket');

  await replySafe(msg,
    '✏️ *Modo edición*\n\n' +
    'Dime qué quieres cambiar:\n' +
    '• "Cambiar descripción a ..."\n' +
    '• "Cambiar lugar a 1234"\n' +
    '• "Cambiar área a IT"\n\n' +
    'O escribe *listo* para terminar de editar.'
  );
  return true;
}

/**
 * Handler para cambio de lugar ("en la 1234", "lugar: lobby")
 */
async function handlePlaceChange(ctx) {
  const { s, msg, text, replySafe, detectPlace, normalizeAndSetLugar } = ctx;

  const draft = s?.draft;
  if (!draft) {
    await replySafe(msg, '⚠️ No hay ticket activo.');
    return true;
  }

  const newPlace = extractPlaceFromText(text);
  if (!newPlace) {
    await replySafe(msg, '⚠️ No pude identificar el nuevo lugar. Escríbelo de nuevo (ej: "en la 1234" o "lugar: lobby").');
    return true;
  }

  let placeResult = null;
  try {
    if (typeof normalizeAndSetLugar === 'function') {
      placeResult = await normalizeAndSetLugar(s, msg, newPlace, { fromEdit: true });
    } else if (typeof detectPlace === 'function') {
      placeResult = await detectPlace(newPlace);
    }
  } catch (e) {
    if (DEBUG) console.warn('[PLACE_CHANGE] detectPlace error', e?.message);
  }

  const found = placeResult && (placeResult.found || placeResult.label || placeResult.lugar);

  if (found) {
    draft.lugar = placeResult.label || placeResult.lugar || placeResult.canonical_label || newPlace;
  } else {
    draft.lugar = newPlace;
  }
  s.draft = draft;

  const preview = formatPreviewMessage(draft);
  await replySafe(msg, `✅ Lugar actualizado a: *${draft.lugar}*\n\n${preview}\n\n_Responde *sí* para enviar o *no* para cancelar._`);
  return true;
}

/**
 * Handler para cambio de área ("es para IT", "área: mantenimiento")
 */
async function handleAreaChange(ctx) {
  const { s, msg, text, replySafe } = ctx;

  const draft = s?.draft;
  if (!draft) {
    await replySafe(msg, '⚠️ No hay ticket activo.');
    return true;
  }

  const newArea = extractAreaFromText(text);
  if (!newArea || !ALLOWED_AREAS.has(newArea)) {
    await replySafe(msg, '⚠️ No pude identificar el área. Opciones válidas: IT, Mantenimiento, AMA/HSKP, RS/Room Service, Seguridad.');
    return true;
  }

  draft.area_destino = newArea;
  draft.areas = [newArea];
  s.draft = draft;

  syncAreasWithPrimary(s, draft);

  const preview = formatPreviewMessage(draft);
  await replySafe(msg, `✅ Área actualizada a: *${areaLabel(newArea)}*\n\n${preview}\n\n_Responde *sí* para enviar o *no* para cancelar._`);
  return true;
}

/**
 * Handler para número de habitación suelto ("1234")
 */
async function handleRoomNumber(ctx) {
  const { s, msg, text, replySafe, detectPlace } = ctx;

  const draft = s?.draft;
  if (!draft) {
    await replySafe(msg, '⚠️ No hay ticket activo.');
    return true;
  }

  const roomNum = extractRoomNumber(text);
  if (!roomNum) {
    await replySafe(msg, '⚠️ No pude identificar el número de habitación.');
    return true;
  }

  let placeResult = null;
  try {
    if (typeof detectPlace === 'function') {
      placeResult = await detectPlace(roomNum);
    }
  } catch (e) {
    if (DEBUG) console.warn('[ROOM_NUMBER] detectPlace error', e?.message);
  }

  const label = placeResult?.label || placeResult?.lugar || `Habitación ${roomNum}`;
  draft.lugar = label;
  s.draft = draft;

  const preview = formatPreviewMessage(draft);
  await replySafe(msg, `✅ Lugar actualizado a: *${label}*\n\n${preview}\n\n_Responde *sí* para enviar o *no* para cancelar._`);
  return true;
}

/**
 * Handler para detalle adicional ("también...", "además...")
 */
async function handleDetailFollowup(ctx) {
  const { s, msg, text, replySafe } = ctx;

  const draft = s?.draft;
  if (!draft) {
    await replySafe(msg, '⚠️ No hay ticket activo.');
    return true;
  }

  let detail = text
    .replace(/^(tambi[eé]n|adem[aá]s|y\s+tambi[eé]n|aparte|y\s+aparte|otro\s+detalle|otra\s+cosa|y\s+otra\s+cosa|ah,?\s+y?\s*)/i, '')
    .trim();

  if (!detail) {
    await replySafe(msg, '¿Qué detalle adicional quieres agregar?');
    return true;
  }

  draft.descripcion = draft.descripcion
    ? `${draft.descripcion}. ${detail}`
    : detail;
  draft.descripcion_original = draft.descripcion;
  s.draft = draft;

  const preview = formatPreviewMessage(draft);
  await replySafe(msg, `✅ Detalle agregado.\n\n${preview}\n\n_Responde *sí* para enviar o *no* para cancelar._`);
  return true;
}

/**
 * Handler IA para edición de UN SOLO ticket
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

  if (isYes(t)) {
    if (DEBUG) console.log('[EDIT-SINGLE] user confirmed send');
    syncAreasWithPrimary(s, draft);

    try {
      const result = await finalizeAndDispatch({ client, msg, session: s });
      if (result?.success) {
        await replySafe(msg, `✅ Ticket enviado: *${result.folio || result.id || 'SIN_FOLIO'}*`);
        s.draft = undefined;
        s._editingDraft = undefined;
        try { resetSession(s.chatId); } catch (e) {}
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

  if (isNo(t)) {
    await replySafe(msg, 'Ok — no se envió. Puedes seguir editando o escribir *listo* para volver al menú.');
    return true;
  }

  if (['listo', 'ok', 'terminar', 'finalizar', 'hecho'].includes(t)) {
    s._editingDraft = undefined;
    setMode(s, 'neutral');
    await replySafe(msg, 'Edición finalizada. Volviendo al menú principal.');
    return true;
  }

  if (tRaw.length < 3) {
    await replySafe(msg, 'Escribe la edición que quieres aplicar (p.ej. "Cambia el lugar a 2101").');
    return true;
  }

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
          if (DEBUG) console.warn('[EDIT-SINGLE] detectPlace error', e?.message);
        }

        const found = placeRes && (placeRes.found || placeRes.label || placeRes.lugar);
        draft.lugar = found
          ? (placeRes.label || placeRes.lugar || placeRes.canonical_label)
          : String(value).trim();

      } else if (field === 'area_destino' || field === 'area') {
        const raw = String(value).trim();
        let areaCode = null;
        try {
          areaCode = typeof normalizeAreaCode === 'function' ? normalizeAreaCode(raw) : raw;
        } catch (e) {
          areaCode = raw;
        }
        areaCode = String(areaCode || '').trim().toUpperCase();

        if (ALLOWED_AREAS.has(areaCode)) {
          draft.area_destino = areaCode;
          draft.areas = [areaCode];
        }

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

    const preview = (typeof formatPreviewFn === 'function')
      ? formatPreviewFn(draft)
      : JSON.stringify(draft, null, 2);

    await replySafe(msg, `✅ Cambios aplicados:\n\n${preview}\n\nResponde *sí* para enviar o *no* para cancelar.`);
    return true;
  }

  await replySafe(msg, 'No entendí la edición. ¿Qué deseas cambiar? (p.ej. "Cambia la descripción a ...", "Poner lugar 2101")');
  return true;
}

/**
 * Posible nuevo incidente con lugar diferente
 */
async function handleNewIncidentCandidate(ctx) {
  const { s, msg, text, replySafe, setMode, findStrongPlaceSignals, detectArea } = ctx;

  const hasNewIncident = looksLikeIncidentText(text);
  const newPlace = (typeof findStrongPlaceSignals === 'function') ? findStrongPlaceSignals(text) : null;
  const currentPlace = s.draft?.lugar || '';
  const isDifferentPlace = !!(newPlace?.value && currentPlace && isDifferentPlaceStrong(currentPlace, newPlace.value));

  let newArea = null;
  try {
    const areaResult = typeof detectArea === 'function' ? await detectArea(text) : null;
    newArea = areaResult?.area || null;
  } catch {}

  if (isDifferentPlace && hasNewIncident) {
    s._pendingNewTicket = {
      descripcion: text,
      lugar: newPlace?.value || null,
      area_destino: newArea || null,
    };

    const currentDesc = (s.draft?.descripcion || '').substring(0, 60);
    const newDesc = String(text || '').substring(0, 60);

    await replySafe(msg,
      '🤔 *Detecté un problema en otro lugar.*\n\n' +
      `📋 *Ticket actual:*\n   _"${currentDesc}..."_\n   📍 ${s.draft?.lugar || '—'}\n\n` +
      `🆕 *Nuevo problema:*\n   _"${newDesc}..."_\n\n` +
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
 * Handler para modo confirm/preview
 */
async function handleConfirmMode(ctx) {
  const { s, msg, text, replySafe, findStrongPlaceSignals } = ctx;

  if (!text) return false;

  // PRE-CHECK: nuevo lugar + nuevo incidente
  try {
    const tRaw = String(text || '').trim();

    if (!isYes(tRaw) && !isNo(tRaw) && tRaw.length >= 6 && s?.draft?.lugar) {
      const newPlace = (typeof findStrongPlaceSignals === 'function') ? findStrongPlaceSignals(tRaw) : null;
      const hasNewPlace = !!newPlace?.value && isDifferentPlaceStrong(s.draft.lugar, newPlace.value);
      const hasNewIncident = looksLikeIncidentText(tRaw);

      if (hasNewPlace && hasNewIncident) {
        if (DEBUG) console.log('[CONFIRM] precheck => new ticket');
        return await handleNewIncidentCandidate(ctx);
      }
    }
  } catch (e) {
    if (DEBUG) console.warn('[CONFIRM] precheck error', e?.message);
  }

  const classification = classifyConfirmMessage(text, s.draft);
  if (DEBUG) console.log('[CONFIRM] classification', { text, classification });

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
    case 'unknown':
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
 * Handler para modo confirm_new_ticket_decision
 */
async function handleConfirmNewTicketDecision(ctx) {
  const { s, text, msg, replySafe, setMode } = ctx;
  const t = (text || '').trim().toLowerCase();

  if (!s._pendingNewTicket) {
    setMode(s, 'neutral');
    await replySafe(msg, 'No hay nuevo ticket pendiente. Volviendo al menú principal.');
    return true;
  }

  if (t === '1') {
    s._multipleTickets = s._multipleTickets || [];
    if (s.draft && !s.draft._migratedToMultiple) {
      s.draft._migratedToMultiple = true;
      syncAreasWithPrimary(s, s.draft);
      s._multipleTickets.push({ ...s.draft });
    }

    const pending = { ...s._pendingNewTicket };
    syncAreasWithPrimary(s, pending);
    s._multipleTickets.push({ ...pending, _ticketNum: s._multipleTickets.length + 1 });

    s.draft = {};
    delete s._pendingNewTicket;
    setMode(s, 'multiple_tickets');
    await replySafe(msg, '✅ Nuevo ticket creado además del actual.');
    return true;
  }

  if (t === '2') {
    s.draft.lugar = s._pendingNewTicket.lugar;
    s.draft.area_destino = s._pendingNewTicket.area_destino || s.draft.area_destino;
    s.draft.descripcion = s._pendingNewTicket.descripcion;
    syncAreasWithPrimary(s, s.draft);

    delete s._pendingNewTicket;
    setMode(s, 'confirm');

    const preview = formatPreviewMessage(s.draft);
    await replySafe(msg, `✅ Ticket actualizado.\n\n${preview}\n\n_Responde *sí* para enviar o *no* para cancelar._`);
    return true;
  }

  if (t === 'cancelar' || t === 'cancel') {
    delete s._pendingNewTicket;
    setMode(s, 'confirm');
    const preview = formatPreviewMessage(s.draft);
    await replySafe(msg, `❌ Descartado.\n\n${preview}\n\n_Responde *sí* para enviar o *no* para cancelar._`);
    return true;
  }

  await replySafe(msg, 'Por favor responde con *1*, *2* o *cancelar*.');
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

  if (isYes(text)) {
    const results = [];

    for (let i = 0; i < batchTickets.length; i++) {
      const ticket = batchTickets[i];
      try {
        const originalDraft = s.draft;
        s.draft = { ...ticket };

        const rawArea = (s.draft.area_destino || '').toString().trim();
        let normArea = null;
        try { normArea = normalizeAreaCode(rawArea); } catch (e) {}
        const areaToUse = (normArea || rawArea || '').toString().trim().toUpperCase();

        if (!areaToUse || !ALLOWED_AREAS.has(areaToUse)) {
          results.push({ success: false, index: i, ticket, error: 'invalid_area' });
          s.draft = originalDraft;
          continue;
        }

        s.draft.area_destino = areaToUse;
        s.draft.areas = [areaToUse];

        if (!hasRequiredDraft(s.draft)) {
          results.push({ success: false, index: i, ticket, error: 'missing_fields' });
          s.draft = originalDraft;
          continue;
        }

        const result = await finalizeAndDispatch({ client, msg, session: s, silent: true });
        if (result?.success) {
          results.push({ success: true, index: i, ticket, folio: result.folio, id: result.id });
        } else {
          results.push({ success: false, index: i, ticket, error: result?.error || 'dispatch_failed' });
        }
        s.draft = originalDraft;
      } catch (e) {
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
      response += `\n\n❌ *${failed.length} ticket(s) fallaron*`;
      s._batchTickets = failed.map(f => f.ticket);
      setMode(s, 'confirm_batch');
      response += '\n\nOpciones: *editar N*, *reenviar N*, *cancelar*';
      await replySafe(msg, response);
      return true;
    }

    s._batchTickets = [];
    await replySafe(msg, response);
    try { resetSession(s.chatId); } catch (e) {}
    return true;
  }

  if (isNo(text)) {
    s._batchTickets = [];
    try { resetSession(s.chatId); } catch (e) {}
    await replySafe(msg, '❌ Tickets cancelados.');
    return true;
  }

  // Mostrar resumen
  let summary = `📋 *${batchTickets.length} tickets pendientes:*\n\n`;
  batchTickets.forEach((tkt, i) => {
    summary += formatTicketSummary(tkt, i + 1) + '\n\n';
  });
  summary += '_Responde *sí* para enviar todos o *no* para cancelar._';
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
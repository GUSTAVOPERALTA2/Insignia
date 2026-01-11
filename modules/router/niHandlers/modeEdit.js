/**
 * niHandlers/modeEdit.js
 * Handlers para modos de edición (IA-potenciado).
 *
 * Conserva los handlers originales (edit_menu, edit_description, edit_menu_place, edit_batch_ticket)
 * y mejora handleEditMultipleTicket para usar interpretEditMessage con un prompt más asertivo.
 */

const {
  DEBUG,
  norm,
  isYes,
  isNo,
  areaLabel, // función importada desde shared - NO desestructurar desde ctx
  normalizeAreaCode,
  formatPreviewMessage,
  formatTicketSummary,
  cleanDescription,
} = require('./shared');

const { interpretEditMessage } = require('./interpretEditMessage');
const { handleMultipleTickets } = require('./modeMultipleTickets');

/**
 * Handler para modo edit_menu
 */
async function handleEditMenu(ctx) {
  const { s, msg, text, replySafe, setMode, setDraftField, addArea, resetSession, detectPlace, refreshIncidentDescription, finalizeAndDispatch, client } = ctx;

  const t = norm(text);

  if (s._conflictNewText) {
    return handleEditMenuConflict(ctx);
  }

  if (DEBUG) console.log('[EDIT_MENU] handling response', { response: text });

  if (t === '1' || /^desc/i.test(t)) {
    setMode(s, 'edit_description');
    await replySafe(msg,
      '✏️ Escribe la nueva descripción del problema:\n\n' +
      `_Actual: "${s.draft.descripcion || '—'}"_`
    );
    return true;
  }

  if (t === '2' || /^lugar/i.test(t) || /^ubica/i.test(t)) {
    setMode(s, 'ask_place');
    await replySafe(msg,
      '📍 Escribe el nuevo lugar:\n\n' +
      `_Actual: "${s.draft.lugar || '—'}"_`
    );
    return true;
  }

  if (t === '3' || /^[aá]rea/i.test(t)) {
    setMode(s, 'choose_area_multi');

    // Intentamos obtener un listado de áreas desde ctx (si existe), si no usamos códigos comunes.
    const defaultAreas = ['man', 'ama', 'it', 'rs', 'seg'];
    const areaKeys = (ctx && ctx.AREA_LABELS) ? Object.keys(ctx.AREA_LABELS) : defaultAreas;

    let options = '🏷️ Elige el área destino:\n\n';
    areaKeys.forEach((key, i) => {
      try {
        options += `• *${i + 1}* — ${areaLabel(key)}\n`;
      } catch (e) {
        options += `• *${i + 1}* — ${key}\n`;
      }
    });
    try {
      options += `\n_Actual: ${areaLabel(s.draft.area_destino)}_`;
    } catch (e) {
      options += `\n_Actual: ${String(s.draft.area_destino || '—')}_`;
    }
    await replySafe(msg, options);
    return true;
  }

  if (/^cancelar?/i.test(t) || /^volver/i.test(t) || /^atras/i.test(t)) {
    setMode(s, 'confirm');
    const preview = formatPreviewMessage(s.draft);
    await replySafe(msg, preview);
    return true;
  }

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
 * Handler para conflicto de área diferente en edit_menu
 */
async function handleEditMenuConflict(ctx) {
  const { s, msg, text, replySafe, setMode, setDraftField, addArea, resetSession, detectPlace, refreshIncidentDescription, finalizeAndDispatch, client } = ctx;

  const t = norm(text);
  const conflictText = s._conflictNewText || '';
  const conflictArea = s._conflictNewArea || null;
  const conflictPlace = s._conflictNewPlace || null;

  // Opción 1: Enviar AMBOS tickets
  if (/^1\b/.test(t) || /^ambos\b/i.test(t)) {
    try {
      const result = await finalizeAndDispatch({ client, msg, session: s, silent: true });
      if (result?.success) {
        await replySafe(msg, `✅ Ticket 1 enviado: *${result.folio}* → ${areaLabel(s.draft.area_destino)}`);
      }
    } catch (e) {
      if (DEBUG) console.warn('[EDIT-MENU] error sending current ticket:', e?.message);
    }

    s.draft = {
      descripcion: conflictText,
      descripcion_original: conflictText,
      lugar: null,
      area_destino: conflictArea,
      areas: conflictArea ? [conflictArea] : [],
    };

    if (conflictPlace) {
      try {
        const placeRes = await detectPlace(conflictPlace, { preferRoomsFirst: true });
        setDraftField(s, 'lugar', placeRes?.label || conflictPlace);
      } catch {
        setDraftField(s, 'lugar', conflictPlace);
      }
    }

    s._conflictNewText = null;
    s._conflictNewArea = null;
    s._conflictNewPlace = null;

    if (refreshIncidentDescription) {
      await refreshIncidentDescription(s, conflictText);
    }

    const preview = formatPreviewMessage(s.draft);
    await replySafe(msg, '📝 *Ticket 2 (nuevo):*\n\n' + preview);
    setMode(s, 'confirm');
    return true;
  }

  // Opción 2: Continuar con el actual
  if (/^2\b/.test(t) || /^actual\b/i.test(t) || /^editar\b/i.test(t)) {
    s._conflictNewText = null;
    s._conflictNewArea = null;
    s._conflictNewPlace = null;

    const preview = formatPreviewMessage(s.draft);
    await replySafe(msg, '✅ Continuamos con el ticket actual (nuevo descartado):\n\n' + preview);
    setMode(s, 'confirm');
    return true;
  }

  // Opción 3: Crear ticket NUEVO
  if (/^3\b/.test(t) || /^nuevo\b/i.test(t)) {
    s.draft = {
      descripcion: conflictText,
      descripcion_original: conflictText,
      lugar: null,
      area_destino: conflictArea,
      areas: conflictArea ? [conflictArea] : [],
    };

    if (conflictPlace) {
      try {
        const placeRes = await detectPlace(conflictPlace, { preferRoomsFirst: true });
        setDraftField(s, 'lugar', placeRes?.label || conflictPlace);
      } catch {
        setDraftField(s, 'lugar', conflictPlace);
      }
    }

    s._conflictNewText = null;
    s._conflictNewArea = null;
    s._conflictNewPlace = null;

    if (refreshIncidentDescription) {
      await refreshIncidentDescription(s, conflictText);
    }

    const preview = formatPreviewMessage(s.draft);
    await replySafe(msg, '✅ Ticket nuevo iniciado (anterior descartado):\n\n' + preview);
    setMode(s, 'confirm');
    return true;
  }

  // Cancelar
  if (/^cancelar?\b/i.test(t) || /^no\b/i.test(t)) {
    s._conflictNewText = null;
    s._conflictNewArea = null;
    s._conflictNewPlace = null;
    resetSession(s.chatId);
    await replySafe(msg, '❌ Tickets cancelados. Si necesitas reportar algo, solo escríbeme.');
    return true;
  }

  await replySafe(msg,
    '🤔 No entendí. Responde con:\n' +
    '• *1* — Enviar ambos tickets\n' +
    '• *2* — Continuar con el actual\n' +
    '• *3* — Crear ticket nuevo\n' +
    '• *cancelar* — Descartar todo'
  );
  return true;
}

/**
 * Handler para modo edit_menu_place
 */
async function handleEditMenuPlace(ctx) {
  const { s, msg, text, replySafe, setMode, setDraftField, detectPlace, refreshIncidentDescription } = ctx;

  const t = norm(text);
  const conflictText = s._conflictNewText || '';
  const conflictArea = s._conflictNewArea || null;
  const conflictPlace = s._conflictNewPlace || null;

  if (DEBUG) console.log('[EDIT_MENU_PLACE] handling', { response: text, conflictPlace });

  if (/^1\b/.test(t) || /^nuevo\b/i.test(t)) {
    const currentTicket = { ...s.draft, _ticketNum: 1 };

    let newTicketLugar = null;
    if (conflictPlace) {
      try {
        const placeRes = await detectPlace(conflictPlace, { preferRoomsFirst: true });
        newTicketLugar = placeRes?.label || conflictPlace;
      } catch {
        newTicketLugar = conflictPlace;
      }
    }

    const newTicket = {
      descripcion: conflictText,
      descripcion_original: conflictText,
      lugar: newTicketLugar,
      area_destino: conflictArea || s.draft.area_destino,
      areas: [conflictArea || s.draft.area_destino],
      _ticketNum: 2,
    };

    s._multipleTickets = [currentTicket, newTicket];

    s._conflictNewText = null;
    s._conflictNewArea = null;
    s._conflictNewPlace = null;

    let msg1 = `📝 *Ticket 1* (${areaLabel(currentTicket.area_destino)}):\n`;
    msg1 += `   _"${(currentTicket.descripcion || '').substring(0, 50)}..."_\n`;
    msg1 += `   📍 ${currentTicket.lugar || 'Sin lugar'}\n\n`;

    let msg2 = `📝 *Ticket 2* (${areaLabel(newTicket.area_destino)}):\n`;
    msg2 += `   _"${(newTicket.descripcion || '').substring(0, 50)}..."_\n`;
    msg2 += `   📍 ${newTicket.lugar || 'Sin lugar'}\n\n`;

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

  if (/^2\b/.test(t) || /^reemplazar\b/i.test(t) || /^cambiar\b/i.test(t)) {
    if (conflictPlace) {
      try {
        const placeRes = await detectPlace(conflictPlace, { preferRoomsFirst: true });
        setDraftField(s, 'lugar', placeRes?.label || conflictPlace);
      } catch {
        setDraftField(s, 'lugar', conflictPlace);
      }
    }

    s._conflictNewText = null;
    s._conflictNewArea = null;
    s._conflictNewPlace = null;

    const preview = formatPreviewMessage(s.draft);
    await replySafe(msg, '✅ Lugar actualizado:\n\n' + preview);
    setMode(s, 'confirm');
    return true;
  }

  if (/^cancelar?\b/i.test(t) || /^no\b/i.test(t)) {
    s._conflictNewText = null;
    s._conflictNewArea = null;
    s._conflictNewPlace = null;

    const preview = formatPreviewMessage(s.draft);
    await replySafe(msg, '✅ Nuevo mensaje descartado. Continuamos con:\n\n' + preview);
    setMode(s, 'confirm');
    return true;
  }

  await replySafe(msg,
    '🤔 No entendí. Responde con:\n' +
    '• *1* — Crear ticket nuevo\n' +
    '• *2* — Reemplazar lugar\n' +
    '• *cancelar* — Descartar nuevo mensaje'
  );
  return true;
}

/**
 * Handler para modo edit_description
 */
async function handleEditDescription(ctx) {
  const { s, msg, text, replySafe, setMode, refreshIncidentDescription } = ctx;

  if (DEBUG) console.log('[EDIT_DESC] handling response', { response: text });

  if (/^cancelar?/i.test(norm(text))) {
    setMode(s, 'confirm');
    const preview = formatPreviewMessage(s.draft);
    await replySafe(msg, '↩️ Edición cancelada.\n\n' + preview);
    return true;
  }

  s.draft.descripcion = text;
  s.draft.descripcion_original = text;
  s.draft._details = [];

  if (refreshIncidentDescription) {
    await refreshIncidentDescription(s, text);
  }

  setMode(s, 'confirm');
  const preview = formatPreviewMessage(s.draft);
  await replySafe(msg, '✅ Descripción actualizada:\n\n' + preview);
  return true;
}

/**
 * Handler para modo edit_batch_ticket
 */
async function handleEditBatchTicket(ctx) {
  const { s, msg, text, replySafe, setMode } = ctx;

  const ticketNum = s._editingTicketNum;
  const batchTickets = s._batchTickets || [];

  if (ticketNum === undefined || ticketNum >= batchTickets.length) {
    if (s._isEditingMultiple) {
      setMode(s, 'multiple_tickets');
    } else {
      setMode(s, 'confirm_batch');
    }
    return false;
  }

  const ticket = batchTickets[ticketNum];
  const t = norm(text);

  if (DEBUG) console.log('[EDIT_BATCH] handling', { response: text, ticketNum });

  if (/^listo/i.test(t) || /^ok\b/i.test(t) || /^terminar?/i.test(t)) {
    s._editingTicketNum = undefined;
    s._editingField = undefined;

    if (s._isEditingMultiple) {
      s._multipleTickets = s._batchTickets.map((tk, i) => ({ ...tk, _ticketNum: i + 1 }));
      s._batchTickets = undefined;
      s._isEditingMultiple = false;
      s._multipleEditing = null;
      setMode(s, 'multiple_tickets');

      let summary = `📋 *${s._multipleTickets.length} tickets pendientes:*\n\n`;
      s._multipleTickets.forEach((tk, i) => {
        summary += formatTicketSummary(tk, i + 1) + '\n\n';
      });
      summary += '_Responde *sí* para enviar todos._';
      await replySafe(msg, summary);
      return true;
    } else {
      s._batchTickets = undefined;
      setMode(s, 'confirm_batch');

      let summary = `📋 *${(s._batchTickets || []).length} tickets pendientes:*\n\n`;
      summary += '_Responde *sí* para enviar todos._';
      await replySafe(msg, summary);
      return true;
    }
  }

  if (/^desc/i.test(t) || /^descrip/i.test(t)) {
    s._editingField = 'descripcion';
    await replySafe(msg, `✏️ Escribe la nueva descripción:\n_Actual: "${ticket.descripcion || '—'}"_`);
    return true;
  }

  if (/^lugar/i.test(t) || /^ubicaci/i.test(t)) {
    s._editingField = 'lugar';
    await replySafe(msg, `📍 Escribe el nuevo lugar:\n_Actual: "${ticket.lugar || '—'}"_`);
    return true;
  }

  if (/^[aá]rea/i.test(t) || /^area/i.test(t)) {
    s._editingField = 'area';
    await replySafe(msg,
      '🏷️ Escribe el código o nombre del área:\n' +
      'Ejemplo: man, it, ama, rs, seg'
    );
    return true;
  }

  if (s._editingField) {
    const field = s._editingField;
    s._editingField = undefined;

    if (field === 'descripcion') {
      ticket.descripcion = text;
      ticket.descripcion_original = text;
    } else if (field === 'lugar') {
      if (/^\d{3,4}$/.test(text.trim())) {
        ticket.lugar = `Habitación ${text.trim()}`;
      } else {
        ticket.lugar = text.trim();
      }
    } else if (field === 'area') {
      const areaCode = normalizeAreaCode(text) || text.toLowerCase();
      ticket.area_destino = areaCode;
    }

    await replySafe(msg,
      `✅ ${field} actualizado.\n\n` +
      `Ticket ${ticketNum + 1}:\n` +
      `• Descripción: ${ticket.descripcion || '—'}\n` +
      `• Lugar: ${ticket.lugar || '—'}\n` +
      `• Área: ${areaLabel(ticket.area_destino)}\n\n` +
      '¿Qué más quieres cambiar? (descripción/lugar/área/listo)'
    );
    return true;
  }

  if (/^\d{3,4}$/.test(t)) {
    ticket.lugar = `Habitación ${text.trim()}`;
    await replySafe(msg, `✅ Lugar: *Habitación ${text.trim()}*\n\nEscribe *listo* para volver.`);
    return true;
  }

  if (text && text.trim().length >= 3) {
    const detail = text.charAt(0).toUpperCase() + text.slice(1);
    ticket.descripcion = (ticket.descripcion || '').trim();
    if (ticket.descripcion && !/[.?!]$/.test(ticket.descripcion)) ticket.descripcion += '.';
    ticket.descripcion += ' ' + detail;
    ticket.descripcion_original = ticket.descripcion;
    await replySafe(msg, `✅ Detalle agregado.\n\nEscribe *listo* para volver, o sigue editando.`);
    return true;
  }

  await replySafe(msg,
    `✏️ Editando ticket ${ticketNum + 1}:\n\n` +
    '¿Qué quieres cambiar?\n' +
    '• *descripción*\n' +
    '• *lugar*\n' +
    '• *área*\n' +
    '• *listo* — terminar edición'
  );
  return true;
}

/**
 * Handler para modo edit_multiple_ticket (IA-potenciado).
 */
async function handleEditMultipleTicket(ctx) {
  const {
    s, text = '', replySafe, setMode,
    DEBUG, formatPreviewMessage,
    interpretEditMessage: ctxInterpret,
    detectPlace, normalizeAndSetLugar, norm, addArea,
    formatTicketSummary, finalizeAndDispatch, client, msg,
    isYes, isNo, resetSession
  } = ctx;

  // Asegurarnos de usar el interpretador pasado en ctx si existe
  const interpret = ctxInterpret || interpretEditMessage;

  if (DEBUG) console.log('[EDIT-MULTIPLE] enter', { chatId: s?.chatId, editingIdx: s?._editingTicketNum, text });

  const ticketNum = s._editingTicketNum;
  const multipleTickets = s._multipleTickets || [];

  if (ticketNum === undefined || ticketNum >= multipleTickets.length) {
    if (DEBUG) console.log('[EDIT-MULTIPLE] invalid editing index, returning to multiple_tickets');
    s._isEditingMultiple = false;
    setMode(s, 'multiple_tickets');
    return false;
  }

  if (!s._batchTickets) {
    // Crear copia de trabajo
    s._batchTickets = JSON.parse(JSON.stringify(multipleTickets));
    if (DEBUG) console.log('[EDIT-MULTIPLE] created _batchTickets copy', { len: s._batchTickets.length });
  }
  s._isEditingMultiple = true;

  const ticket = s._batchTickets[ticketNum];
  const tRaw = (text || '').trim();
  const t = tRaw.toLowerCase();

  // 1) Interceptar respuestas cortas que confunden a la IA (ej. "si", "sí", "no")
  if (/^(si|sí|s|no|n)$/i.test(t)) {
    await replySafe(msg, 'Para finalizar la edición y volver al menú escribe: *listo*.\nSi quieres cambiar algo, escribe la edición (p.ej. "Cambia el lugar a 2301").');
    return true;
  }

  // 2) Comando "listo" para terminar edición y volver al menú principal (sin confirmación extra)
  if (['listo', 'ok', 'terminar', 'finalizar', 'hecho'].includes(t)) {
    if (DEBUG) console.log('[EDIT-MULTIPLE] user finished editing, syncing and returning to menu');
    s._multipleTickets = s._batchTickets.map((tk, i) => ({
      ...tk,
      _ticketNum: i + 1,
      descripcion: tk.descripcion || tk.descripcion_original,
      area_destino: tk.area_destino || 'man'
    }));

    s._editingTicketNum = undefined;
    s._editingField = undefined;
    s._isEditingMultiple = false;
    s._batchTickets = undefined;

    setMode(s, 'multiple_tickets');

    try {
      await handleMultipleTickets({ ...ctx, text: 'mostrar' });
    } catch (e) {
      if (DEBUG) console.warn('[EDIT-MULTIPLE] handleMultipleTickets error on listo', e?.message);
      let summary = `📋 ${s._multipleTickets.length} tickets pendientes:\n\n`;
      s._multipleTickets.forEach((tk, i) => {
        summary += formatTicketSummary(tk, i + 1) + '\n\n';
      });
      await replySafe(msg, summary);
    }
    return true;
  }

  // 3) Solo invocar la IA para interpretaciones cuando el texto sea suficientemente informativo (>= 3 chars)
  if (tRaw.length >= 3) {
    if (DEBUG) console.log('[EDIT-MULTIPLE] interpretEditMessage:', { text: tRaw, ticketNum: ticketNum + 1 });

    // Construir contexto claro para el interpretador IA
    const aiCtx = {
      ...ctx,
      s,
      ticketIndex: ticketNum,
      ticket,
      DEBUG,
    };

    const options = {
      currentTicket: ticket,
      allTickets: s._batchTickets,
      mode: 'multiple',
      allowedAreas: { man: 'Mantenimiento', ama: 'Housekeeping', it: 'Sistemas', rs: 'Room Service', seg: 'Seguridad' },
      instruction: 'Eres un asistente que interpreta ediciones de tickets. Devuelve acciones concretas en el formato { actions: [{ field, value }, ...] }.',
      requireClearActions: true,
    };

    let editIntent;
    try {
      editIntent = await interpret(aiCtx, tRaw, options);
      if (DEBUG) console.log('[EDIT-MULTIPLE] interpretEditMessage result', { editIntent });
    } catch (e) {
      if (DEBUG) console.warn('[EDIT-MULTIPLE] interpretEditMessage error', e?.message);
      editIntent = null;
    }

    if (editIntent && !editIntent.needsClarification && editIntent.actions?.length > 0) {
      if (DEBUG) console.log('[EDIT-MULTIPLE] applying AI actions', { actions: editIntent.actions.length });

      for (const a of editIntent.actions) {
        const { field, value } = a;
        if (value === undefined || value === null) continue;

        if (field === 'descripcion') {
          // REEMPLAZAR descripción en lugar de concatenar (más seguro en ediciones múltiples)
          ticket.descripcion = String(value).trim();
          ticket.descripcion_original = ticket.descripcion;

        } else if (field === 'lugar') {
          // Intentar normalizar el lugar con helper si está disponible
          try {
            if (typeof normalizeAndSetLugar === 'function') {
              const res = await normalizeAndSetLugar(s, msg, value, { fromEdit: true }).catch(() => null);
              // normalizeAndSetLugar puede devolver { lugar, label, canonical_label, encontrado, ... }
              ticket.lugar = res?.label || res?.lugar || res?.canonical_label || String(value).trim();
            } else if (typeof detectPlace === 'function') {
              const res = await detectPlace(value, { fuzzy: true }).catch(() => null);
              ticket.lugar = res?.label || res?.lugar || String(value).trim();
            } else {
              ticket.lugar = String(value).trim();
            }
          } catch (e) {
            if (DEBUG) console.warn('[EDIT-MULTIPLE] normalizeAndSetLugar error', e?.message);
            ticket.lugar = String(value).trim();
          }

        } else if (field === 'area_destino' || field === 'area') {
          // Normalizar área con helper compartido
          let areaCode = String(value).trim();
          try {
            const normArea = normalizeAreaCode(areaCode);
            if (normArea) areaCode = normArea;
          } catch (e) {
            if (DEBUG) console.warn('[EDIT-MULTIPLE] normalizeAreaCode error', e?.message);
          }
          areaCode = (areaCode || '').toString().toLowerCase();
          ticket.area_destino = areaCode;
          // Registrar área en la sesión si la función está disponible
          try { if (typeof addArea === 'function') addArea(s, areaCode); } catch (e) { if (DEBUG) console.warn('[EDIT-MULTIPLE] addArea error', e?.message); }

        } else {
          const piece = String(value).trim();
          if (piece) {
            ticket.descripcion = ticket.descripcion ? ticket.descripcion + ' ' + piece : piece;
            ticket.descripcion_original = ticket.descripcion;
          }
        }
      }

      // Vista previa limpia (sin preguntas de confirmación repetidas)
      const preview = formatPreviewMessage(ticket);

      const resp = `✅ Cambios aplicados al Ticket ${ticketNum + 1}:\n\n${preview}\n\nSi ya terminaste, escribe *listo* para volver al menú.`;
      await replySafe(msg, resp);
      if (DEBUG) console.log('[EDIT-MULTIPLE] preview sent for ticket', ticketNum + 1);
      return true;
    }

    if (editIntent?.needsClarification) {
      if (DEBUG) console.log('[EDIT-MULTIPLE] AI requests clarification', { clarify: editIntent.clarify });
      await replySafe(msg, editIntent.clarify || '¿Puedes especificar exactamente qué quieres cambiar?');
      return true;
    }
  }

  // Fallback / ayuda
  if (DEBUG) console.log('[EDIT-MULTIPLE] fallback help message for ticket', ticketNum + 1);
  await replySafe(msg,
    `✏️ Editando Ticket ${ticketNum + 1}. Puedes decir:\n` +
    `- "Cambia el lugar a la 2301"\n` +
    `- "Ponlo para mantenimiento"\n` +
    `- Escribe *listo* para volver al menú principal.`
  );

  return true;
}

/**
 * Handler principal para modos de edición
 */
async function handleEdit(ctx) {
  const { s, text } = ctx;

  if (!text) return false;

  switch (s.mode) {
    case 'edit':
    case 'edit_menu':
      return handleEditMenu(ctx);
    case 'edit_description':
      return handleEditDescription(ctx);
    case 'edit_menu_place':
      return handleEditMenuPlace(ctx);
    case 'edit_batch_ticket':
      return handleEditBatchTicket(ctx);
    case 'edit_multiple_ticket':
      return handleEditMultipleTicket(ctx);
    default:
      return false;
  }
}

module.exports = { handleEdit };
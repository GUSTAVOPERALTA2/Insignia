/**
 * niHandlers/modeMultipleTickets.js
 * Handler para modo multiple_tickets:
 * - Gestión de múltiples tickets detectados en un mensaje
 */

const {
  DEBUG,
  norm,
  isYes,
  isNo,
  areaLabel,
  formatPreviewMessage,
  formatTicketSummary,
} = require('./shared');

/**
 * Handler para modo multiple_tickets
 */
async function handleMultipleTicketsMode(ctx) {
  const {
    s, msg, text, replySafe, setMode, resetSession, finalizeAndDispatch, client,
  } = ctx;

  const multipleTickets = s._multipleTickets || [];
  const t = norm(text);

  if (DEBUG) console.log('[MULTIPLE] handling', { response: text, ticketCount: multipleTickets.length });

  // Confirmar todos / enviar todos
  // Acepta: 'sí', 'si', 'enviar', 'todos'
  if (isYes(text) || /^si$/i.test(t) || /^todos$/i.test(t) || /^enviar\s*(ambos|los\s*2|los\s*dos)?$/i.test(t) || /^enviar$/i.test(t)) {
    if (multipleTickets.length === 0) {
      await replySafe(msg, '⚠️ No hay tickets pendientes para enviar.');
      setMode(s, 'neutral');
      return true;
    }

    // ═══════════════════════════════════════════════════════════════
    // VALIDAR QUE TODOS LOS TICKETS ESTÉN COMPLETOS
    // ═══════════════════════════════════════════════════════════════
    const incompleteTickets = multipleTickets.filter(t => 
      !t.descripcion || !t.lugar || !t.area_destino
    );
    
    if (incompleteTickets.length > 0) {
      // Buscar el primer ticket incompleto
      const incompleteIdx = multipleTickets.findIndex(t => 
        !t.descripcion || !t.lugar || !t.area_destino
      );
      const ticket = multipleTickets[incompleteIdx];
      
      let missingFields = [];
      if (!ticket.descripcion) missingFields.push('descripción');
      if (!ticket.lugar) missingFields.push('lugar');
      if (!ticket.area_destino) missingFields.push('área destino');
      
      // Redirigir a completar el dato faltante
      if (!ticket.lugar) {
        s._completingMultipleTicket = incompleteIdx;
        s.draft = { ...ticket };
        
        await replySafe(msg,
          `⚠️ El ticket ${incompleteIdx + 1} está incompleto.\n` +
          `Falta: *${missingFields.join(', ')}*\n\n` +
          `📍 Indica el *lugar* del ticket ${incompleteIdx + 1}:\n` +
          `   _"${(ticket.descripcion || '').substring(0, 50)}..."_`
        );
        
        setMode(s, 'ask_place');
        return true;
      }
      
      if (!ticket.area_destino) {
        s._completingMultipleTicketArea = incompleteIdx;
        
        await replySafe(msg,
          `⚠️ El ticket ${incompleteIdx + 1} está incompleto.\n` +
          `Falta: *${missingFields.join(', ')}*\n\n` +
          `🏷️ Indica el *área* del ticket ${incompleteIdx + 1}:\n` +
          `   _"${(ticket.descripcion || '').substring(0, 50)}..."_\n\n` +
          '• *MAN* — Mantenimiento\n' +
          '• *AMA* — Ama de llaves\n' +
          '• *RS* — Room Service\n' +
          '• *IT* — Sistemas\n' +
          '• *SEG* — Seguridad'
        );
        
        setMode(s, 'ask_area_multiple');
        return true;
      }
      
      // Si falta descripción (raro pero posible)
      await replySafe(msg,
        `⚠️ El ticket ${incompleteIdx + 1} no tiene descripción.\n` +
        'Por favor usa *editar ' + (incompleteIdx + 1) + '* para completarlo.'
      );
      return true;
    }

    const results = [];

    for (const ticket of multipleTickets.slice()) {
      try {
        // Guardar estado original
        const originalDraft = s.draft;
        const originalPendingMedia = s._pendingMedia;
        
        // Preparar el draft temporalmente
        s.draft = { ...ticket };
        delete s.draft._ticketNum;
        delete s.draft._needsPlace;
        
        // ═══════════════════════════════════════════════════════════════
        // IMPORTANTE: Usar los adjuntos del ticket, no de la sesión
        // ═══════════════════════════════════════════════════════════════
        if (ticket._pendingMedia && ticket._pendingMedia.length > 0) {
          s._pendingMedia = ticket._pendingMedia;
          if (DEBUG) console.log('[MULTIPLE] using ticket media', { 
            ticketNum: ticket._ticketNum, 
            mediaCount: ticket._pendingMedia.length 
          });
        } else {
          // Este ticket no tiene adjuntos
          s._pendingMedia = [];
          if (DEBUG) console.log('[MULTIPLE] ticket has no media', { ticketNum: ticket._ticketNum });
        }
        delete s.draft._pendingMedia; // No guardar en el draft que va a DB

        const result = await finalizeAndDispatch({ client, msg, session: s, silent: true });
        results.push({
          num: ticket._ticketNum,
          folio: result?.folio,
          success: result?.success
        });

        // Restaurar estado original
        s.draft = originalDraft;
        s._pendingMedia = originalPendingMedia;
      } catch (e) {
        if (DEBUG) console.warn('[MULTIPLE] dispatch error', e?.message);
        results.push({ num: ticket._ticketNum, success: false, error: e?.message });
      }
    }

    // Limpiar
    s._multipleTickets = [];
    s._pendingMedia = []; // Limpiar media después de enviar todo

    // Reportar resultados
    const successful = results.filter(r => r.success);
    const failed = results.filter(r => !r.success);

    let response = `✅ *${successful.length} ticket(s) enviado(s)*`;
    if (successful.length > 0) {
      response += ':\n' + successful.map(r => `• ${r.folio}`).join('\n');
    }
    if (failed.length > 0) {
      response += `\n\n❌ ${failed.length} ticket(s) fallaron`;
    }

    await replySafe(msg, response);
    resetSession(s.chatId);
    return true;
  }

  // Cancelar todos
  if (isNo(text) || /^cancelar$/i.test(t) || /^cancel$/i.test(t)) {
    s._multipleTickets = [];
    s._pendingMedia = [];
    resetSession(s.chatId);
    await replySafe(msg, '❌ Tickets cancelados.');
    return true;
  }

  // Editar uno específico
  const editMatch = t.match(/^editar?\s*(\d+)/i);
  if (editMatch) {
    const ticketNum = parseInt(editMatch[1], 10) - 1;
    if (ticketNum >= 0 && ticketNum < multipleTickets.length) {
      // Marcar edición en contexto múltiple
      s._multipleEditing = { index: ticketNum, field: null };
      s._editingTicketNum = ticketNum;
      s._isEditingMultiple = true;

      setMode(s, 'edit_multiple_ticket');

      const ticket = multipleTickets[ticketNum];
      const hasMedia = ticket._pendingMedia && ticket._pendingMedia.length > 0;
      
      await replySafe(msg,
        `✏️ Editando ticket ${ticketNum + 1}:\n\n` +
        `• Descripción: ${ticket.descripcion || '—'}\n` +
        `• Lugar: ${ticket.lugar || '—'}\n` +
        `• Área: ${areaLabel(ticket.area_destino) || '—'}\n` +
        (hasMedia ? `• 📎 ${ticket._pendingMedia.length} adjunto(s)\n` : '') +
        '\n¿Qué quieres cambiar? (escribe `descripción`, `lugar`, `área` o `listo`)'
      );
      return true;
    } else {
      await replySafe(msg, `⚠️ No existe el ticket ${ticketNum + 1}. Responde con *editar N* donde N es el número del ticket.`);
      return true;
    }
  }

  // Eliminar uno
  const removeMatch = t.match(/^(eliminar?|quitar?|borrar?)\s*(\d+)/i);
  if (removeMatch) {
    const ticketNum = parseInt(removeMatch[2], 10) - 1;
    if (ticketNum >= 0 && ticketNum < multipleTickets.length) {
      const removed = multipleTickets.splice(ticketNum, 1)[0];

      if (multipleTickets.length === 0) {
        s._multipleTickets = [];
        s._pendingMedia = [];
        resetSession(s.chatId);
        await replySafe(msg, '❌ Todos los tickets eliminados.');
        return true;
      }

      if (multipleTickets.length === 1) {
        // Solo queda uno, convertir a ticket normal
        const remaining = multipleTickets[0];
        s.draft = { ...remaining };
        delete s.draft._ticketNum;
        delete s.draft._needsPlace;
        
        // Restaurar los adjuntos del ticket restante a la sesión
        if (remaining._pendingMedia && remaining._pendingMedia.length > 0) {
          s._pendingMedia = remaining._pendingMedia;
        }
        delete s.draft._pendingMedia;
        
        s._multipleTickets = [];
        setMode(s, 'confirm');

        const preview = formatPreviewMessage(s.draft);
        await replySafe(msg, `🗑️ Ticket eliminado. Queda uno:\n\n` + preview);
        return true;
      }

      // Re-numerar
      multipleTickets.forEach((t, i) => t._ticketNum = i + 1);
      s._multipleTickets = multipleTickets;

      await replySafe(msg, `🗑️ Ticket ${ticketNum + 1} eliminado. Quedan ${multipleTickets.length}.`);
      return true;
    } else {
      await replySafe(msg, `⚠️ No existe el ticket ${ticketNum + 1}.`);
      return true;
    }
  }

  // Enviar solo uno
  const sendMatch = t.match(/^enviar?\s*(\d+)/i);
  if (sendMatch) {
    const ticketNum = parseInt(sendMatch[1], 10) - 1;
    if (ticketNum >= 0 && ticketNum < multipleTickets.length) {
      const ticketToSend = multipleTickets.splice(ticketNum, 1)[0];

      // Guardar estado original
      const originalDraft = s.draft;
      const originalPendingMedia = s._pendingMedia;
      
      // Preparar para envío
      s.draft = { ...ticketToSend };
      delete s.draft._ticketNum;
      delete s.draft._needsPlace;
      
      // Usar adjuntos del ticket
      if (ticketToSend._pendingMedia && ticketToSend._pendingMedia.length > 0) {
        s._pendingMedia = ticketToSend._pendingMedia;
      } else {
        s._pendingMedia = [];
      }
      delete s.draft._pendingMedia;

      try {
        await finalizeAndDispatch({ client, msg, session: s });
      } catch (e) {
        if (DEBUG) console.warn('[MULTIPLE] dispatch error', e?.message);
      }

      // Restaurar
      s.draft = originalDraft;
      s._pendingMedia = originalPendingMedia;

      if (multipleTickets.length === 0) {
        s._multipleTickets = [];
        s._pendingMedia = [];
        resetSession(s.chatId);
        return true;
      }

      // Re-numerar
      multipleTickets.forEach((t, i) => t._ticketNum = i + 1);
      s._multipleTickets = multipleTickets;

      await replySafe(msg, `Quedan ${multipleTickets.length} ticket(s) pendientes.`);
      return true;
    } else {
      await replySafe(msg, `⚠️ No existe el ticket ${ticketNum + 1}.`);
      return true;
    }
  }

  // ---------------------------
  // Mostrar lista de tickets (formato solicitado)
  // ---------------------------
  let summary = `📋 ${multipleTickets.length} tickets detectados:\n\n`;

  multipleTickets.forEach((ticket, i) => {
    const idx = i + 1;
    const descLine = ticket.descripcion ? ticket.descripcion.trim() : '—';
    const lugar = ticket.lugar || 'Sin lugar';
    const area = areaLabel(ticket.area_destino) || '—';
    const hasMedia = ticket._pendingMedia && ticket._pendingMedia.length > 0;

    // Línea con descripción y luego una línea con lugar y área
    summary += `${idx}. ${descLine}\n`;
    summary += `   📍 ${lugar} | 🏷️ ${area}`;
    if (hasMedia) {
      summary += ` | 📎 ${ticket._pendingMedia.length}`;
    }
    summary += '\n\n';
  });

  summary += 'Opciones:\n';
  summary += '• *sí/enviar* — enviar todos\n';
  summary += '• *editar N* — editar ticket N\n';
  summary += '• *eliminar N* — quitar ticket N\n';
  summary += '• *enviar N* — enviar solo ticket N\n';
  summary += '• *cancelar* — descartar todos';

  await replySafe(msg, summary);
  return true;
}

/**
 * Handler principal
 */
async function handleMultipleTickets(ctx) {
  const { s, text } = ctx;

  if (!text) return false;

  if (s.mode === 'multiple_tickets') {
    return handleMultipleTicketsMode(ctx);
  }

  return false;
}

module.exports = { handleMultipleTickets };
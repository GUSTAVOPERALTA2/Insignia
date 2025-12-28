// modules/groups/groupMessageHandler.js
// Procesa respuestas en grupos destino, actualiza tickets y notifica al solicitante.

const DEBUG = (process.env.VICEBOT_DEBUG || '1') === '1';
const ENABLE_AI_REWRITE = !!process.env.OPENAI_API_KEY;
const AI_MODEL = process.env.GROUP_REWRITE_MODEL || 'gpt-4o-mini';

// ──────────────────────────────────────────────────────────────
// OpenAI para reescribir mensajes
// ──────────────────────────────────────────────────────────────
let openai = null;

async function ensureOpenAI() {
  if (!ENABLE_AI_REWRITE) return null;
  if (openai) return openai;
  try {
    const OpenAI = (await import('openai')).default;
    openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    return openai;
  } catch (e) {
    if (DEBUG) console.warn('[GROUP-HANDLER] OpenAI init failed:', e?.message);
    return null;
  }
}

/**
 * Reescribe el mensaje del técnico de forma profesional y concisa
 */
async function rewriteUpdateMessage(originalMessage, context = {}) {
  const client = await ensureOpenAI();
  if (!client) {
    // Fallback: limpiar el mensaje básicamente
    return cleanMessage(originalMessage);
  }

  const { status, folio, lugar } = context;
  const statusLabel = status === 'done' ? 'completado' : status === 'in_progress' ? 'en progreso' : 'actualizado';

  try {
    const response = await client.chat.completions.create({
      model: AI_MODEL,
      messages: [
        {
          role: 'system',
          content: `Eres un asistente que reescribe mensajes de técnicos de mantenimiento/IT para notificar a huéspedes o solicitantes.

REGLAS:
- Sé breve y profesional (1-2 oraciones máximo)
- Usa un tono amable y cortés
- NO agregues información que no esté en el mensaje original
- NO uses emojis excesivos
- Si el mensaje indica que está resuelto, confirma que quedó listo
- Si indica que van en camino o están trabajando, indica que están atendiendo
- Mantén los detalles técnicos relevantes pero simplificados
- Responde SOLO con el mensaje reescrito, nada más`
        },
        {
          role: 'user',
          content: `Ticket: ${folio || 'N/A'}
Lugar: ${lugar || 'N/A'}
Estado: ${statusLabel}
Mensaje original del técnico: "${originalMessage}"

Reescribe este mensaje para notificar al solicitante:`
        }
      ],
      temperature: 0.3,
      max_tokens: 150
    });

    const rewritten = response.choices?.[0]?.message?.content?.trim();
    return rewritten || cleanMessage(originalMessage);
  } catch (e) {
    if (DEBUG) console.warn('[GROUP-HANDLER] AI rewrite failed:', e?.message);
    return cleanMessage(originalMessage);
  }
}

/**
 * Limpia el mensaje básicamente (fallback sin IA)
 */
function cleanMessage(text) {
  return String(text || '')
    .replace(/@\d+/g, '') // Quitar menciones de WhatsApp
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Resuelve el nombre del usuario que envió el mensaje
 */
async function resolveAuthorName(msg, usersCache = null) {
  try {
    // Intentar obtener el contacto
    const contact = await msg.getContact();
    if (contact) {
      // Prioridad: pushname > name > number
      const name = contact.pushname || contact.name || contact.number;
      if (name) return name;
    }
  } catch (e) {
    if (DEBUG) console.warn('[GROUP-HANDLER] getContact failed:', e?.message);
  }

  // Fallback: extraer del author
  const author = msg.author || msg.from;
  if (author) {
    const num = String(author).replace('@c.us', '').replace('@s.whatsapp.net', '');
    
    // Buscar en cache de usuarios si existe
    if (usersCache && usersCache[author]) {
      const u = usersCache[author];
      if (u.nombre) return u.nombre;
    }
    
    return num;
  }

  return 'Técnico';
}

/**
 * Extrae el folio del mensaje citado o del contexto
 */
function extractFolioFromQuoted(quotedBody) {
  if (!quotedBody) return null;
  
  // Buscar patrones de folio: SYS-00001, MANT-00001, HSKP-00001, etc.
  const folioMatch = quotedBody.match(/\b(SYS|MANT|HSKP|SEG|RS|IT|MAN|GEN)-\d{3,5}\b/i);
  if (folioMatch) return folioMatch[0].toUpperCase();
  
  // Buscar 🆔 *FOLIO*
  const idMatch = quotedBody.match(/🆔\s*\*?([A-Z]+-\d{3,5})\*?/i);
  if (idMatch) return idMatch[1].toUpperCase();
  
  return null;
}

/**
 * Formatea el mensaje de notificación al solicitante
 */
function formatNotificationMessage({ folio, authorName, rewrittenMessage, status }) {
  const statusEmoji = status === 'done' ? '✅' : status === 'in_progress' ? '🔄' : '📝';
  const statusLabel = status === 'done' ? 'Completado' : status === 'in_progress' ? 'En progreso' : 'Actualización';
  
  const lines = [
    `${statusEmoji} *${folio}* — ${statusLabel}`,
    ``,
    `${rewrittenMessage}`,
    ``,
    `— _${authorName}_`
  ];
  
  return lines.join('\n');
}

/**
 * Procesa un mensaje de grupo y determina si es una actualización de ticket
 * 
 * @param {Object} params
 * @param {Object} params.client - Cliente de WhatsApp
 * @param {Object} params.msg - Mensaje de WhatsApp
 * @param {Function} params.classifyGroupMessage - Clasificador de mensajes
 * @param {Function} params.getIncidentByFolio - Buscar incidente por folio
 * @param {Function} params.updateIncidentStatus - Actualizar estado del incidente
 * @param {Function} params.appendIncidentEvent - Agregar evento al incidente
 * @param {Function} params.getAreaByGroupId - Obtener área por ID de grupo
 * @param {Function} params.listOpenIncidentsRecentlyDispatchedToGroup - Listar incidentes abiertos
 * @param {Object} params.usersCache - Cache de usuarios (opcional)
 */
async function handleGroupMessage({
  client,
  msg,
  classifyGroupMessage,
  getIncidentByFolio,
  updateIncidentStatus,
  appendIncidentEvent,
  getAreaByGroupId,
  listOpenIncidentsRecentlyDispatchedToGroup,
  loadGroupsConfig,
  usersCache = null
}) {
  const groupId = msg.from;
  const body = msg.body || '';
  const author = msg.author || msg.from;
  
  if (DEBUG) console.log('[GROUP-HANDLER] processing', { groupId, bodyPreview: body.substring(0, 50) });
  
  // 1. Clasificar el mensaje
  const classification = await classifyGroupMessage(body);
  
  if (DEBUG) console.log('[GROUP-HANDLER] classification', classification);
  
  // Si no es una actualización de estado, ignorar
  if (classification.intent === 'OTRO' || classification.confidence < 0.6) {
    if (DEBUG) console.log('[GROUP-HANDLER] skipped (not a status update)');
    return { handled: false, reason: 'not_status_update' };
  }
  
  // Mapear intent a status
  const statusMap = {
    'T-L': 'done',      // Terminado/Listo
    'T-P': 'in_progress', // En progreso
    'T-C': 'canceled'   // Cancelado
  };
  const newStatus = statusMap[classification.intent] || null;
  
  if (!newStatus) {
    return { handled: false, reason: 'unknown_intent' };
  }
  
  // 2. Encontrar el ticket relacionado
  let incident = null;
  let folio = null;
  
  // 2a. Buscar en mensaje citado
  if (msg.hasQuotedMsg) {
    try {
      const quoted = await msg.getQuotedMessage();
      const quotedBody = quoted?.body || '';
      folio = extractFolioFromQuoted(quotedBody);
      
      if (folio) {
        incident = await getIncidentByFolio(folio);
        if (DEBUG) console.log('[GROUP-HANDLER] found folio from quoted:', folio, { found: !!incident });
      }
    } catch (e) {
      if (DEBUG) console.warn('[GROUP-HANDLER] quoted msg error:', e?.message);
    }
  }
  
  // 2b. Buscar folio en el propio mensaje
  if (!incident) {
    folio = extractFolioFromQuoted(body);
    if (folio) {
      incident = await getIncidentByFolio(folio);
      if (DEBUG) console.log('[GROUP-HANDLER] found folio in body:', folio, { found: !!incident });
    }
  }
  
  // 2c. Buscar el ticket abierto más reciente para este grupo
  if (!incident) {
    try {
      const cfg = await loadGroupsConfig();
      const area = getAreaByGroupId(groupId, cfg);
      
      if (area) {
        // Buscar tickets abiertos recientemente despachados a este grupo
        const candidates = await listOpenIncidentsRecentlyDispatchedToGroup(groupId, {
          windowMins: 120, // últimas 2 horas
          limit: 1
        });
        
        if (candidates && candidates.length > 0) {
          incident = candidates[0];
          folio = incident.folio;
          if (DEBUG) console.log('[GROUP-HANDLER] found recent open ticket:', folio);
        }
      }
    } catch (e) {
      if (DEBUG) console.warn('[GROUP-HANDLER] search open tickets error:', e?.message);
    }
  }
  
  // Si no encontramos ticket, no podemos procesar
  if (!incident) {
    if (DEBUG) console.log('[GROUP-HANDLER] no ticket found');
    return { handled: false, reason: 'no_ticket_found' };
  }
  
  folio = incident.folio || folio;
  
  // 3. Verificar que el ticket no esté ya cerrado
  const currentStatus = (incident.status || 'open').toLowerCase();
  if (currentStatus === 'done' || currentStatus === 'closed' || currentStatus === 'canceled') {
    if (DEBUG) console.log('[GROUP-HANDLER] ticket already closed:', folio, currentStatus);
    return { handled: false, reason: 'ticket_already_closed' };
  }
  
  // 4. Actualizar estado del ticket
  try {
    await updateIncidentStatus(incident.id, newStatus, {
      updatedBy: author,
      source: 'group_response',
      comment: body
    });
    
    if (DEBUG) console.log('[GROUP-HANDLER] status updated', { folio, newStatus });
  } catch (e) {
    if (DEBUG) console.warn('[GROUP-HANDLER] update status error:', e?.message);
    return { handled: false, reason: 'update_failed', error: e?.message };
  }
  
  // 5. Registrar evento
  try {
    await appendIncidentEvent(incident.id, {
      event_type: 'group_response',
      payload: {
        groupId,
        author,
        message: body,
        classification,
        newStatus
      }
    });
  } catch (e) {
    if (DEBUG) console.warn('[GROUP-HANDLER] append event error:', e?.message);
  }
  
  // 6. Notificar al solicitante
  const requesterChatId = incident.chat_id;
  
  if (requesterChatId) {
    try {
      // Resolver nombre del autor
      const authorName = await resolveAuthorName(msg, usersCache);
      
      // Reescribir mensaje con IA
      const rewrittenMessage = await rewriteUpdateMessage(body, {
        status: newStatus,
        folio,
        lugar: incident.lugar
      });
      
      // Formatear notificación
      const notification = formatNotificationMessage({
        folio,
        authorName,
        rewrittenMessage,
        status: newStatus
      });
      
      // Enviar al solicitante
      await client.sendMessage(requesterChatId, notification);
      
      if (DEBUG) console.log('[GROUP-HANDLER] notified requester', { requesterChatId, folio });
    } catch (e) {
      if (DEBUG) console.warn('[GROUP-HANDLER] notify requester error:', e?.message);
    }
  } else {
    if (DEBUG) console.log('[GROUP-HANDLER] no requester chat_id for ticket:', folio);
  }
  
  return {
    handled: true,
    folio,
    newStatus,
    classification,
    notifiedRequester: !!requesterChatId
  };
}

module.exports = {
  handleGroupMessage,
  rewriteUpdateMessage,
  extractFolioFromQuoted,
  formatNotificationMessage,
  resolveAuthorName
};
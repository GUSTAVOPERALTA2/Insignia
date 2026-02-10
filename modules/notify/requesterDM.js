const { allow } = require('../utils/rateLimiter');
const tpl = require('./templates');

// Importar safeSendMessage de groupRouter que ya tiene el fix de markedUnread
const { safeSendMessage } = require('../groups/groupRouter');

// Intenta obtener el chat del solicitante desde DB; si no, usa el cache de últimos despachos
function getDB(){ try { return require('../db/incidenceDB'); } catch { return {}; } }
const incidenceDB = getDB();
const { getRequesterForIncident } = require('../state/lastGroupDispatch');

const DEBUG = (process.env.VICEBOT_DEBUG || '1') === '1';

async function getIncident(ctxOrId) {
  if (typeof ctxOrId === 'object' && ctxOrId && ctxOrId.id) return ctxOrId;
  const fn = incidenceDB.getIncidentById || incidenceDB.getIncident || null;
  if (!fn) return null;
  try { return await fn(ctxOrId); } catch { return null; }
}

function pickRequesterChat(incident) {
  // 1) chat_id directo en el incidente (campo principal de la DB)
  if (incident?.chat_id) return incident.chat_id;
  
  // 2) meta.chatId / requester_chat en DB (compatibilidad)
  const meta = incident?.meta || incident?.meta_json || null;
  const dbChat = meta?.chatId || meta?.requester_chat || incident?.requester_chat || null;
  if (dbChat) return dbChat;
  
  // 3) cache por último despacho (memoria temporal)
  const cached = getRequesterForIncident(incident?.id);
  if (cached) return cached;
  
  return null;
}

function rlKey(incidentId, kind){ return `dm:${incidentId}:${kind}`; }

async function sendDM({ client, incident, kind, data = {}, media = [] }) {
  const inc = await getIncident(incident);
  if (!inc) {
    if (DEBUG) console.log('[DM] incident_not_found');
    return { ok: false, reason: 'incident_not_found' };
  }

  const to = pickRequesterChat(inc);
  if (!to) {
    if (DEBUG) console.log('[DM] requesterChat_not_found for incident:', inc.id);
    return { ok: false, reason: 'requesterChat_not_found' };
  }

  if (DEBUG) console.log(`[DM] Sending ${kind} to ${to} for folio ${inc.folio}`);
  if (DEBUG) console.log(`[DM] Description: "${inc.description?.substring(0, 50)}..."`);

  // Rate limit básico (1 DM / 60s por tipo)
  const winSec = parseInt(process.env.VICEBOT_DM_RATE_WINDOW_SEC || '60', 10);
  if (!allow(rlKey(inc.id, kind), { windowMs: winSec * 1000, max: 1 })) {
    if (DEBUG) console.log('[DM] rate_limited');
    return { ok: false, reason: 'rate_limited' };
  }

  // Render template
  const folio = inc.folio || inc.human_id || inc.id;
  const description = inc.descripcion || inc.description || '';  // descripcion (español) o description (inglés)
  
  let text;
  switch (kind) {
    // Templates existentes (actuales)
    case 'ack_start':
      text = tpl.ackStart({ folio, area: inc.area_destino || data.area });
      break;
      
    case 'question':
      text = tpl.question({ folio, question: data.question });
      break;
      
    case 'eta':
      text = tpl.eta({ folio, etaText: data.etaText });
      break;
      
    case 'blocked':
      text = tpl.blocked({ folio, reason: data.reason });
      break;
      
    case 'reroute':
      text = tpl.reroute({ folio, newArea: data.newArea });
      break;
      
    case 'evidence':
      text = tpl.evidence({ folio, note: data.note || '' });
      break;
      
    case 'done_claim':
      text = tpl.doneClaim({ folio });
      break;
      
    case 'closed':
      text = tpl.closed({ folio });
      break;
      
    case 'reopened':
      text = tpl.reopened({ folio });
      break;
    
    // ── NUEVOS: Estados desde Dashboard ──
    case 'done':
      text = tpl.done({ folio, description });
      break;
      
    case 'in_progress':
      text = tpl.inProgress({ folio, description });
      break;
      
    case 'canceled':
      text = tpl.canceled({ folio, description });
      break;
      
    case 'open':
      text = tpl.open({ folio, description });
      break;
    
    default:
      // Fallback genérico
      text = `ℹ️ ${folio}: actualización del ticket.`;
      break;
  }

  // Enviar mensaje principal usando safeSendMessage (mismo método que grupos)
  const result = await safeSendMessage(client, to, text);
  
  if (!result.ok) {
    if (DEBUG) console.log(`[DM] Failed to send: ${result.error}`);
    return { ok: false, reason: result.error };
  }

  // Enviar media si hay
  if (Array.isArray(media) && media.length) {
    for (const m of media) {
      const mediaResult = await safeSendMessage(client, to, m);
      if (!mediaResult.ok && DEBUG) {
        console.log(`[DM] Failed to send media: ${mediaResult.error}`);
      }
    }
  }

  if (DEBUG) console.log(`[DM] Sent ${kind} to ${to} successfully`);
  return { ok: true };
}

module.exports = { sendDM };
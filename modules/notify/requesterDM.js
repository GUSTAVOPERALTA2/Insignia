const { allow } = require('../utils/rateLimiter');
const tpl = require('./templates');

// Intenta obtener el chat del solicitante desde DB; si no, usa el cache de últimos despachos
function getDB(){ try { return require('../db/incidenceDB'); } catch { return {}; } }
const incidenceDB = getDB();
const { getRequesterForIncident } = require('../state/lastGroupDispatch');

async function getIncident(ctxOrId) {
  if (typeof ctxOrId === 'object' && ctxOrId && ctxOrId.id) return ctxOrId;
  const fn = incidenceDB.getIncidentById || incidenceDB.getIncident || null;
  if (!fn) return null;
  try { return await fn(ctxOrId); } catch { return null; }
}

function pickRequesterChat(incident) {
  // 1) meta.chatId / requester_chat en DB
  const meta = incident?.meta || incident?.meta_json || null;
  const dbChat = meta?.chatId || meta?.requester_chat || incident?.requester_chat || null;
  if (dbChat) return dbChat;
  // 2) cache por último despacho
  const cached = getRequesterForIncident(incident?.id);
  if (cached) return cached;
  return null;
}

function rlKey(incidentId, kind){ return `dm:${incidentId}:${kind}`; }

async function sendDM({ client, incident, kind, data = {}, media = [] }) {
  const inc = await getIncident(incident);
  if (!inc) return { ok:false, reason:'incident_not_found' };

  const to = pickRequesterChat(inc);
  if (!to) return { ok:false, reason:'requesterChat_not_found' };

  // Rate limit básico (1 DM / 60s por tipo)
  const winSec = parseInt(process.env.VICEBOT_DM_RATE_WINDOW_SEC || '60', 10);
  if (!allow(rlKey(inc.id, kind), { windowMs: winSec * 1000, max: 1 })) {
    return { ok:false, reason:'rate_limited' };
  }

  // Render template
  const folio = inc.folio || inc.human_id || inc.id;
  let text;
  switch (kind) {
    case 'ack_start':       text = tpl.ackStart({ folio, area: inc.area_destino || data.area }); break;
    case 'question':        text = tpl.question({ folio, question: data.question }); break;
    case 'eta':             text = tpl.eta({ folio, etaText: data.etaText }); break;
    case 'blocked':         text = tpl.blocked({ folio, reason: data.reason }); break;
    case 'reroute':         text = tpl.reroute({ folio, newArea: data.newArea }); break;
    case 'evidence':        text = tpl.evidence({ folio, note: data.note || '' }); break;
    case 'done_claim':      text = tpl.doneClaim({ folio }); break;
    case 'closed':          text = tpl.closed({ folio }); break;
    case 'reopened':        text = tpl.reopened({ folio }); break;
    default:                text = `ℹ️ ${folio}: actualización del ticket.`; break;
  }

  // Enviar
  try {
    // Si hay 1-2 imágenes pequeñas, primero texto y luego evidencias
    await client.sendMessage(to, text);
    if (Array.isArray(media) && media.length) {
      for (const m of media) {
        await client.sendMessage(to, m);
      }
    }
    return { ok:true };
  } catch (e) {
    return { ok:false, reason:e?.message || 'send_failed' };
  }
}

module.exports = { sendDM };

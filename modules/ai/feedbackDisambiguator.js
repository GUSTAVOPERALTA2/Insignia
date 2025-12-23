// modules/router/routeTeamFeedback.js
// Router para mensajes del equipo (retroalimentación). Flujo:
// - Determina si el mensaje parece provenir de equipo (grupo)
// - Vincula mensaje → incidencia (reply/folio en texto; NUEVO: desambiguación multi-ticket por grupo)
// - Clasifica intención con IA baseline (intentTeamReply)
// - Si relevante: guarda evento/nota, adjuntos, y pone estado en 'in_process' (si aplica)
// - Notifica al EMISOR (DM) con un resumen de la retro

const path = require('path');
const fs = require('fs');

const { interpretTeamReply } = require('../ai/intentTeamReply');
const { linkMessageToIncident } = require('../linker/messageIncidentLinker');

// DB (carga perezosa)
function getDB() {
  try { return require('../db/incidenceDB'); } catch { return {}; }
}
const incidenceDB = getDB();

// Helpers DB
async function appendEvent(incidentId, evt) {
  if (typeof incidenceDB.appendIncidentEvent === 'function') {
    return incidenceDB.appendIncidentEvent(incidentId, evt);
  }
  if (typeof incidenceDB.appendEvent === 'function') return incidenceDB.appendEvent(incidentId, evt);
  if (typeof incidenceDB.addIncidentEvent === 'function') return incidenceDB.addIncidentEvent(incidentId, evt);
  if (typeof incidenceDB.addEvent === 'function') return incidenceDB.addEvent(incidentId, evt);
  return null;
}
async function updateStatus(incidentId, status) {
  const candidates = ['updateIncidentStatus', 'setIncidentStatus', 'updateStatus'];
  for (const fn of candidates) if (typeof incidenceDB[fn] === 'function') return incidenceDB[fn](incidentId, status);
  return null;
}
async function getStatus(incidentId) {
  if (typeof incidenceDB.getIncidentStatus === 'function') {
    try { return await incidenceDB.getIncidentStatus(incidentId); } catch {}
  }
  if (typeof incidenceDB.getStatus === 'function') {
    try { return await incidenceDB.getStatus(incidentId); } catch {}
  }
  if (typeof incidenceDB.getIncidentById === 'function') {
    try {
      const r = await incidenceDB.getIncidentById(incidentId);
      if (r && typeof r.status === 'string') return r.status;
    } catch {}
  }
  return null;
}
async function appendAttachments(incidentId, metas, opts) {
  const fn = incidenceDB.appendIncidentAttachments || incidenceDB.appendIncidentAttachment;
  if (typeof fn === 'function') return fn(incidentId, metas, opts || {});
  return null;
}

// Evidencias persistidas
const ATTACH_DIR = path.join(process.cwd(), 'data', 'attachments');
const ATTACH_BASEURL = '/attachments';
function ensureDir(p) { if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true }); }
function mimeToExt(m) {
  if (!m) return 'bin';
  const t = m.toLowerCase();
  if (t.includes('jpeg')) return 'jpg';
  if (t.includes('jpg'))  return 'jpg';
  if (t.includes('png'))  return 'png';
  if (t.includes('webp')) return 'webp';
  if (t.includes('gif'))  return 'gif';
  return t.split('/')[1] || 'bin';
}
function persistMediasToDisk(incidentId, medias = []) {
  if (!medias?.length) return [];
  ensureDir(ATTACH_DIR);
  const dir = path.join(ATTACH_DIR, incidentId);
  ensureDir(dir);
  const metas = [];
  for (let i = 0; i < medias.length; i++) {
    const p = medias[i];
    try {
      const ext = mimeToExt(p.mimetype);
      const fname = p.filename ? p.filename.replace(/[^\w.\-]+/g, '_') : `${Date.now()}_${i}.${ext}`;
      const fpath = path.join(dir, fname);
      const buf = Buffer.from(p.data, 'base64');
      fs.writeFileSync(fpath, buf);
      metas.push({
        id: `${incidentId}-team-${i}`,
        mimetype: p.mimetype,
        filename: fname,
        url: `${ATTACH_BASEURL}/${incidentId}/${encodeURIComponent(fname)}`,
        size: buf.length,
        by: 'team',
        kind: 'evidence_team',
      });
    } catch {}
  }
  return metas;
}

// Canal
function looksLikeTeamChannel(msg) {
  const chatId = msg.from || '';
  const isGroup = chatId.endsWith('@g.us');
  return isGroup;
}

// Cache de último despacho y requester
const { getRecentForGroup, getRequesterForIncident } = require('../state/lastGroupDispatch');

const DEBUG = (process.env.VICEBOT_DEBUG || '1') === '1';

/* ──────────────────────────────────────────────────────────────
 * NUEVO: Desambiguación cuando hay varios tickets abiertos en el grupo
 * ────────────────────────────────────────────────────────────── */

function tokens(s='') {
  return String(s)
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}
function roomCandidatesFrom(text='') {
  return (text.match(/\b\d{3,4}\b/g) || []).map(x => x.trim());
}

function scoreCandidateByText(c, text) {
  let score = 0;
  const tks = tokens(text);
  const rooms = roomCandidatesFrom(text);
  const lugar = (c.lugar || '').toLowerCase();
  const desc  = (c.descripcion || '').toLowerCase();

  // coincidencias por room
  if (c.room && rooms.includes(String(c.room))) score += 3;
  if (c.lugar && rooms.includes(String(c.lugar))) score += 2;

  // tokens del lugar
  for (const tk of tks) {
    if (!tk || tk.length < 3) continue;
    if (lugar.includes(tk)) score += 1;
  }

  // leve: tokens presentes en la descripción del ticket
  for (const tk of tks) {
    if (!tk || tk.length < 4) continue;
    if (desc.includes(tk)) score += 0.5;
  }

  // área como pista
  const area = String(c.area_destino || '').toLowerCase();
  if (tks.includes('sistemas') || tks.includes('it')) {
    if (area === 'it') score += 1;
  }

  return score;
}

async function listOpenForGroup(groupId) {
  if (typeof incidenceDB.listOpenIncidentsRecentlyDispatchedToGroup === 'function') {
    try {
      return incidenceDB.listOpenIncidentsRecentlyDispatchedToGroup(groupId, {
        windowMins: parseInt(process.env.VICEBOT_TEAM_REPLY_LOOKBACK_MIN || '1440', 10),
        limit: 20
      }) || [];
    } catch {}
  }
  return [];
}

async function trySmartPickByText(groupId, text) {
  const arr = await listOpenForGroup(groupId);
  if (!arr.length) return null;
  if (arr.length === 1) return arr[0];

  const scored = arr
    .map(c => ({ c, s: scoreCandidateByText(c, text || '') }))
    .sort((a,b)=> b.s - a.s);

  if (DEBUG) console.log('[TEAMFB] smartPick scores:', scored.map(x => ({ folio: x.c.folio, lugar: x.c.lugar, s: x.s })));

  if (scored[0].s > 0 && (scored.length === 1 || scored[0].s >= (scored[1].s + 2))) {
    return scored[0].c;
  }
  return null; // ambiguo
}

function formatDisambiguationList(items) {
  const top = items.slice(0, 5);
  const lines = [
    'Tengo varios tickets abiertos en este grupo. Indica el *folio* (por ejemplo `#SYS-00016`) o responde al card del ticket:',
    ''
  ];
  for (const it of top) {
    lines.push(`• ${it.folio || it.id} — *${it.lugar || '—'}* · ${it.descripcion?.slice(0,60) || '—'}`);
  }
  if (items.length > top.length) lines.push(`…y ${items.length - top.length} más recientes.`);
  return lines.join('\n');
}

/**
 * Fallback mejorado:
 * - Si hay 0 abiertos → intenta cache "último del grupo".
 * - Si hay 1 abierto → usa ese.
 * - Si hay >1 abiertos:
 *     - intenta smart pick; si falla, NO usar “último”: pedir desambiguación.
 */
async function fallbackLinkByRecentGroupDispatchOrSmart(msg) {
  const open = await listOpenForGroup(msg.from);

  if (open.length === 0) {
    const winMin = parseInt(process.env.VICEBOT_TEAM_REPLY_LINK_WINDOW_MIN || '30', 10);
    const rec = getRecentForGroup(msg.from, winMin);
    if (!rec) return null;
    return {
      incidentId: rec.incidentId,
      via: 'recent_group_window_cache',
      linkMeta: { quotedHasFolio: false, bodyHasFolio: false, folioFromText: rec.folio || null, quotedMsgId: null }
    };
  }

  if (open.length === 1) {
    return {
      incidentId: open[0].id,
      via: 'group_open_single',
      linkMeta: { quotedHasFolio: false, bodyHasFolio: false, folioFromText: open[0].folio || null, quotedMsgId: null }
    };
  }

  // >1 abiertos
  const smart = await trySmartPickByText(msg.from, msg.body || '');
  if (smart) {
    return {
      incidentId: smart.id,
      via: 'group_open_smart_pick',
      linkMeta: { quotedHasFolio: false, bodyHasFolio: false, folioFromText: smart.folio || null, quotedMsgId: null }
    };
  }

  // Ambiguo: forzar desambiguación (NO caer al "último del grupo")
  return { needDisambiguation: true, candidates: open };
}

async function tryGetIncidentContext(incidentId) {
  const fns = ['getIncidentById', 'getIncidentContext'];
  for (const fn of fns) if (typeof incidenceDB[fn] === 'function') { try { return await incidenceDB[fn](incidentId); } catch {} }
  return { id: incidentId, folio: null, meta: {} };
}
async function safeGetSender(client, msg) {
  try { const c = await msg.getContact(); return c?.pushname || c?.name || c?.number || null; }
  catch { return null; }
}

// Notificación al emisor
function extractRequesterChatId(incidentObj) {
  if (!incidentObj) return null;
  return (
    incidentObj.meta?.chatId ||
    incidentObj.chatId ||
    incidentObj.requester_chat ||
    incidentObj.originChatId ||
    null
  );
}
function formatRequesterDM({ folio, note, intent, extracted, newStatus }) {
  const lines = [];
  lines.push(`🔔 *Actualización de tu ticket*${folio ? ` *${folio}*` : ''}`);
  if (newStatus) lines.push(`• *Estado:* ${String(newStatus).replace(/_/g, ' ')}`);
  if (intent === 'status.eta' && (extracted?.eta_minutes || extracted?.eta_iso)) {
    const etaTxt = extracted?.eta_minutes ? `${extracted.eta_minutes} minutos` : 'próximamente';
    lines.push(`• *ETA del equipo:* ${etaTxt}`);
  }
  if (intent === 'status.blocker' && extracted?.blocking_reason) {
    lines.push(`• *Bloqueo:* ${extracted.blocking_reason}`);
  }
  if (intent === 'feedback.assignment' && extracted?.assignee) {
    lines.push(`• *Asignado a:* ${extracted.assignee}`);
  }
  lines.push(`• *Nota del equipo:* ${note || '—'}`);
  lines.push('\nSi falta algo, respóndeme aquí y lo agrego al ticket.');
  return lines.join('\n');
}

// Entry point
async function maybeHandleTeamFeedback(client, msg) {
  if (msg.fromMe) return false;
  if (!looksLikeTeamChannel(msg)) return false;

  // 1) Intento principal (reply o folio en el texto)
  let link = await linkMessageToIncident(msg, incidenceDB);
  if (DEBUG) console.log('[TEAMFB] link.1', link);

  // 2) Fallback mejorado
  if (!link?.incidentId) {
    const fb = await fallbackLinkByRecentGroupDispatchOrSmart(msg);
    if (fb?.incidentId) {
      link = fb;
    } else if (fb?.needDisambiguation) {
      try {
        const txt = formatDisambiguationList(fb.candidates || []);
        await msg.reply(txt);
      } catch {}
      return true; // consumimos el mensaje mostrando las opciones
    }
  }
  if (DEBUG) console.log('[TEAMFB] link.final', link);
  if (!link?.incidentId) return false;

  // 3) IA
  const channelMeta = { inAreaGroup: true };
  const incidentCtx = await tryGetIncidentContext(link.incidentId);
  const ai = await interpretTeamReply({
    text: msg.body || '',
    linkMeta: link.linkMeta || {},
    channelMeta,
    incidentContext: incidentCtx,
  });

  const MIN = parseFloat(process.env.VICEBOT_INTENT_CONFIDENCE_MIN || '0.50');
  if (!ai.is_relevant || ai.confidence < MIN) {
    try {
      const cands = await listOpenForGroup(msg.from);
      if (cands.length > 1) {
        const txt = formatDisambiguationList(cands);
        await msg.reply(txt);
      } else {
        await msg.reply(`¿Este mensaje es sobre el folio *${incidentCtx?.folio || link.incidentId}*? Si no, por favor indica el folio (#FOLIO) o responde al card del ticket.`);
      }
    } catch {}
    return true;
  }

  // 4) Adjuntos
  let metas = [];
  if (msg.hasMedia) {
    try {
      const media = await msg.downloadMedia();
      if (media?.mimetype?.startsWith('image/')) {
        metas.push({ mimetype: media.mimetype, data: media.data, filename: media.filename || null });
      }
    } catch {}
  }
  if (metas.length) {
    const saved = persistMediasToDisk(link.incidentId, metas);
    if (saved.length) await appendAttachments(link.incidentId, saved, { alsoEvent: true });
  }

  // 5) Evento
  const waId = msg.id?.id || null;
  const eventPayload = {
    intent: ai.intent,
    note: ai.normalized_note || msg.body || '',
    extracted: ai.extracted || {},
    confidence: ai.confidence,
    by_group: msg.from,
    by_user: await safeGetSender(client, msg),
    via: link.via,
    ts: Date.now(),
  };
  await appendEvent(link.incidentId, {
    event_type: 'team_feedback',
    wa_msg_id: waId,
    payload: eventPayload,
  });

  // 6) Estado
  let newStatus = null;
  const current = await getStatus(link.incidentId);
  if (!current || current === 'new' || current === 'pending' || current === 'open') {
    newStatus = 'in_process';
    await updateStatus(link.incidentId, newStatus);
  }
  if (ai.intent === 'status.done_claim') {
    newStatus = process.env.VICEBOT_STATUS_ON_DONE_CLAIM || 'awaiting_confirmation';
    await updateStatus(link.incidentId, newStatus);
  }
  if (!newStatus) newStatus = current || null;

  // 7) Notificar EMISOR (DM)
  try {
    const enable = String(process.env.VICEBOT_NOTIFY_REQUESTER_ON_TEAM_FEEDBACK || '1') !== '0';
    if (enable) {
      let requesterChat = extractRequesterChatId(incidentCtx);
      if (!requesterChat) requesterChat = getRequesterForIncident(link.incidentId);
      if (requesterChat && !/@g\.us$/.test(requesterChat)) {
        const dm = formatRequesterDM({
          folio: incidentCtx?.folio || null,
          note: eventPayload.note,
          intent: ai.intent,
          extracted: ai.extracted,
          newStatus,
        });
        await client.sendMessage(requesterChat, dm);
      } else if (DEBUG) {
        console.warn('[TEAMFB] requesterChat not found; DM skipped');
      }
    }
  } catch (e) {
    if (DEBUG) console.warn('[TEAMFB] notify requester err', e?.message || e);
  }

  // 8) Acuse en grupo
  try { await msg.reply('✅ Retro registrada. ¡Gracias!'); } catch {}

  return true;
}

module.exports = { maybeHandleTeamFeedback };

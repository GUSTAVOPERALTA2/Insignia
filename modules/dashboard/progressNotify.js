// modules/dashboard/progressNotify.js
// Notifica “en progreso” a grupos y emisor (DM) desde el Dashboard.
// Se usa como hook desde onStatusChange del API.

const { getIncidentById, appendIncidentEvent } = require('../db/incidenceDB');

const DEBUG = (process.env.VICEBOT_DEBUG || '1') === '1';

const isDM    = (id='') => /@c\.us$/.test(String(id));
const isGroup = (id='') => /@g\.us$/.test(String(id));

function extractDmId(inc = {}) {
  if (inc.chat_id && isDM(inc.chat_id)) return inc.chat_id;
  const evs = Array.isArray(inc.events) ? inc.events : [];
  for (let i = evs.length - 1; i >= 0; i--) {
    const e = evs[i];
    const payload = e?.payload ?? e?.payload_json ?? null;
    const s = typeof payload === 'string' ? payload : JSON.stringify(payload || {});
    const m = s && s.match(/[0-9A-Za-z\-]+@c\.us/);
    if (m && m[0]) return m[0];
  }
  return null;
}

function extractGroupIdsFromEvents(events = []) {
  const arr = Array.isArray(events) ? events : [];
  const last = [...arr].reverse().find(e => e?.event_type === 'dispatched_to_groups');
  if (!last) return [];
  const p = last.payload || {};

  if (Array.isArray(p.group_ids)) return p.group_ids.filter(isGroup);
  if (p.primaryId || (Array.isArray(p.ccIds) && p.ccIds.length)) {
    const out = [];
    if (p.primaryId && isGroup(p.primaryId)) out.push(p.primaryId);
    for (const g of (p.ccIds || [])) if (isGroup(g)) out.push(g);
    return out;
  }
  if (Array.isArray(p.sent)) return p.sent.map(x => x && x.id).filter(isGroup);

  const s = typeof p === 'string' ? p : JSON.stringify(p || {});
  const rx = /[0-9A-Za-z\-]+@g\.us/g;
  const m = s.match(rx);
  return Array.from(new Set(m || [])).filter(isGroup);
}

async function notifyGroupsExplicit(client, groupIds = [], message) {
  const ok = [], fail = [];
  for (const gid of Array.from(new Set(groupIds))) {
    try { await client.sendMessage(gid, message); ok.push(gid); }
    catch (e) { if (DEBUG) console.warn('[PROG] send group fail', gid, e?.message || e); fail.push({ gid, error: String(e?.message || e) }); }
  }
  return { ok, fail };
}

// ───────────────────────────────────────────────────────────────
// Builders de mensajes (estilo consistente con cancel/done)
// ───────────────────────────────────────────────────────────────
function buildGroupProgressMessage(inc, { by, note }) {
  const tarea = (inc.descripcion || '—').trim();
  const lugar = (inc.lugar || '—').trim();
  const folio = (inc.folio || inc.id || '—').trim();

  let msg = `🟦 *Ticket en progreso* — *${folio}*\n\n${tarea}\n\n*Lugar:* ${lugar}`;
  if (note) msg += `\n*Nota:* ${note}`;
  if (by)   msg += `\n*Atiende:* ${by}`;
  return msg;
}

function buildUserProgressMessage(inc, { by }) {
  const folio = (inc.folio || inc.id || '—').trim();
  let msg = `🔵 Tu ticket *${folio}* está *en progreso*.\nEn cuanto tengamos actualización te avisamos.`;
  if (by) msg += `\n(Atiende: ${by})`;
  return msg;
}

// ───────────────────────────────────────────────────────────────
// Hook-friendly
// ───────────────────────────────────────────────────────────────
async function handleDashboardInProgressStatusChange({
  client,
  incidentId,
  by = 'dashboard',
  note = null,
  sendFollowUpToGroups
}) {
  // 1) Cargar incidente (incluye events para detectar grupos previos)
  const inc = await getIncidentById(incidentId);
  if (!inc) return;

  // (Opcional) si no está realmente en in_progress, solo log
  const st = String(inc.status || '').toLowerCase();
  if (st !== 'in_progress' && DEBUG) {
    console.warn('[PROG] incidente no está en in_progress, status=', st);
  }

  const msgGroup = buildGroupProgressMessage(inc, { by, note });
  const msgDM    = buildUserProgressMessage(inc, { by });

  // 2) Notificar grupos
  let groups_ok = [], groups_fail = [];
  const groupIds = extractGroupIdsFromEvents(inc.events || []);
  if (client && groupIds.length) {
    const sent = await notifyGroupsExplicit(client, groupIds, msgGroup);
    groups_ok = sent.ok; groups_fail = sent.fail;
  } else if (client && typeof sendFollowUpToGroups === 'function') {
    try {
      await sendFollowUpToGroups(client, { incident: inc, message: msgGroup, media: null });
    } catch (e) { if (DEBUG) console.warn('[PROG] fallback-by-area err', e?.message || e); }
  }

  // 3) Notificar emisor (si es DM; usa chat_id o lo infiere de eventos)
  let dmSent = null;
  if (client) {
    const dmId = extractDmId(inc);
    if (!dmId) {
      if (DEBUG) console.warn('[PROG] no DM id found for incident', inc.id, 'chat_id=', inc.chat_id);
    } else if (!isDM(dmId)) {
      if (DEBUG) console.warn('[PROG] detected non-DM id:', dmId);
    } else {
      try { await client.sendMessage(dmId, msgDM); dmSent = dmId; }
      catch (e) { if (DEBUG) console.warn('[PROG] DM send fail', dmId, e?.message || e); }
    }
  }

  // 4) Trazabilidad
  try {
    await appendIncidentEvent(inc.id, {
      event_type: 'in_progress_notice_sent',
      wa_msg_id: null,
      payload: { by, note, groups_ok, groups_fail, dm: dmSent }
    });
  } catch (_) {}
}

module.exports = {
  handleDashboardInProgressStatusChange
};

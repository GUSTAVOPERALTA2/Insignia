// modules/dashboard/doneNotify.js
// Notifica terminación a grupos y emisor (DM) con la misma filosofía que cancelNotify.

const { getIncidentById, updateIncidentStatus, appendIncidentEvent } = require('../db/incidenceDB');

const DEBUG = (process.env.VICEBOT_DEBUG || '1') === '1';

const isDM    = (id='') => /@c\.us$/.test(String(id));
const isGroup = (id='') => /@g\.us$/.test(String(id));

// Busca un @c.us en eventos si no tenemos inc.chat_id
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

  const s = typeof p === 'string' ? p : JSON.stringify(p);
  const rx = /[0-9A-Za-z\-]+@g\.us/g;
  const m = s.match(rx);
  return Array.from(new Set(m || [])).filter(isGroup);
}

async function notifyGroupsExplicit(client, groupIds = [], message) {
  const ok = [], fail = [];
  for (const gid of Array.from(new Set(groupIds))) {
    try { await client.sendMessage(gid, message); ok.push(gid); }
    catch (e) { if (DEBUG) console.warn('[DASH-DONE] send group fail', gid, e?.message || e); fail.push({ gid, error: String(e?.message || e) }); }
  }
  return { ok, fail };
}

function buildGroupDoneMessage(inc, { by, note }) {
  const tarea = (inc.descripcion || inc.interpretacion || '—').trim();
  const lugar = (inc.lugar || '—').trim();
  return [
    '🟩 *Ticket terminado*',
    '',
    tarea,
    '',
    `*Lugar:* ${lugar}`,
    ...(note ? ['', `*Nota:* ${note}`] : []),
    ...(by ?   ['', `*Por:* ${by}`]     : []),
  ].join('\n');
}

function buildUserDoneMessage(inc, { note }) {
  const tarea = (inc.descripcion || inc.interpretacion || '—').trim();
  const lugar = (inc.lugar || '—').trim();
  return [
    '🟩 *Ticket terminado*',
    '',
    tarea,
    '',
    `*Lugar:* ${lugar}`,
    ...(note ? ['', `*Nota:* ${note}`] : []),
    // Si quieres: 'Si algo persiste, responde "reabrir FOLIO".'
  ].join('\n');
}

/**
 * FUNCIÓN PURA: notifica cuando YA está en estado done.
 * @param {{ incidentId:string, by?:string, note?:string, client?:any, notifyFallbackByArea?:boolean, sendFollowUpToGroups?:Function }} opts
 */
async function notifyOnDone({ incidentId, by = 'dashboard', note = null, client = null, notifyFallbackByArea = false, sendFollowUpToGroups = null } = {}) {
  const inc = await getIncidentById(incidentId);
  if (!inc) throw new Error('INCIDENT_NOT_FOUND');

  const st = String(inc.status || '').toLowerCase();
  if (st !== 'done') {
    if (DEBUG) console.warn('[DASH-DONE] notifyOnDone: incident not in done state, skipping notify', { incidentId, status: st });
    return { ok: false, notified: { groups_ok: [], groups_fail: [], dm: null } };
  }

  const msgGroup = buildGroupDoneMessage(inc, { by, note });
  const msgDM    = buildUserDoneMessage(inc, { note });

  // 1) grupos (preferir rastro)
  const gIds = extractGroupIdsFromEvents(inc.events || []);
  let sentGroups = { ok: [], fail: [] };

  if (client && gIds.length) {
    sentGroups = await notifyGroupsExplicit(client, gIds, msgGroup);
  } else if (client && notifyFallbackByArea) {
    try {
      const _send = sendFollowUpToGroups || require('../groups/groupRouter').sendFollowUpToGroups;
      await _send(client, { incident: inc, message: msgGroup, media: null });
    } catch (e) {
      if (DEBUG) console.warn('[DASH-DONE] fallback-by-area err', e?.message || e);
    }
  }

  // 2) emisor DM
  let dmSent = null;
  if (client) {
    const dmId = inc.chat_id && isDM(inc.chat_id) ? inc.chat_id : extractDmId(inc);
    if (dmId && isDM(dmId)) {
      try { await client.sendMessage(dmId, msgDM); dmSent = dmId; }
      catch (e) { if (DEBUG) console.warn('[DASH-DONE] DM send fail', dmId, e?.message || e); }
    } else {
      if (DEBUG) console.warn('[DASH-DONE] no DM id found for incident', inc.id, 'chat_id=', inc.chat_id);
    }
  }

  // 3) trazabilidad
  try {
    await appendIncidentEvent(inc.id, {
      event_type: 'done_notice_sent',
      wa_msg_id: null,
      payload: { by, note: note || null, groups_ok: sentGroups.ok, groups_fail: sentGroups.fail, dm: dmSent }
    });
  } catch (e) {
    if (DEBUG) console.warn('[DASH-DONE] append event fail', e?.message || e);
  }

  return { ok: true, notified: { groups_ok: sentGroups.ok, groups_fail: sentGroups.fail, dm: dmSent } };
}

/**
 * ENDPOINT OPCIONAL: POST /api/incidents/:id/done
 * - Cambia estado a 'done'
 * - Notifica grupos y emisor
 * - Registra done_notice_sent
 */
function attachDoneNotifyApi(app, { client, sendFollowUpToGroups } = {}) {
  app.post('/api/incidents/:id/done', async (req, res) => {
    const idOrFolio = String(req.params.id || '').trim();
    const by   = (req.body && req.body.by)   || 'dashboard';
    const note = (req.body && req.body.note) || null;
    const doFallbackByArea = !!(req.body && req.body.notifyFallbackByArea);

    try {
      const before = await getIncidentById(idOrFolio);
      if (!before) return res.status(404).json({ ok: false, error: 'INCIDENT_NOT_FOUND' });

      if (String(before.status || '').toLowerCase() !== 'done') {
        await updateIncidentStatus(before.id, 'done'); // crea status_change
      }

      const out = await notifyOnDone({
        incidentId: before.id, by, note, client,
        notifyFallbackByArea: doFallbackByArea,
        sendFollowUpToGroups
      });

      return res.json({ ok: true, ...out });
    } catch (e) {
      console.error('[DASH-DONE] fatal', e);
      return res.status(500).json({ ok: false, error: 'INTERNAL_ERROR', detail: String(e?.message || e) });
    }
  });
}

/**
 * HOOK para usar desde PATCH /status (cuando newStatus === 'done')
 */
async function handleDashboardDoneStatusChange({ client, incidentId, by = 'dashboard', note = null, sendFollowUpToGroups }) {
  try {
    await notifyOnDone({ incidentId, by, note, client, notifyFallbackByArea: true, sendFollowUpToGroups });
  } catch (e) {
    if (DEBUG) console.warn('[DASH-DONE] handleHook error', e?.message || e);
  }
}

module.exports = {
  notifyOnDone,
  attachDoneNotifyApi,
  handleDashboardDoneStatusChange
};

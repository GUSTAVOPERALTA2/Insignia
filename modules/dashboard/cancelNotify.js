// modules/dashboard/cancelNotify.js
// Notifica cancelación a grupos y emisor (DM) desde el Dashboard.

const {
  getIncidentById,
  closeIncident,
  appendIncidentEvent,
} = require('../db/incidenceDB');

const DEBUG = (process.env.VICEBOT_DEBUG || '1') === '1';

// ────────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────────
function isDM(id = '')     { return /@c\.us$/.test(String(id)); }
function isGroup(id = '')  { return /@g\.us$/.test(String(id)); }
function trimId(id='') { return String(id || '').trim(); }

// ────────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────────
function isDM(id = '')     { return /@c\.us$/.test(String(id)); }
function isGroup(id = '')  { return /@g\.us$/.test(String(id)); }
function trimId(id='')     { return String(id || '').trim(); }

// Intenta formar un @c.us desde un texto con teléfono
function waIdFromText(s='') {
  const digits = String(s || '').replace(/\D/g, '');
  // Heurística: números de 8 a 15 dígitos son candidatos razonables
  if (digits.length >= 8 && digits.length <= 15) return `${digits}@c.us`;
  return null;
}

// Busca un @c.us para notificar al emisor
function extractDmId(inc = {}) {
  // 0) chat_id directo
  const cid = trimId(inc.chat_id || '');
  if (cid && isDM(cid)) return cid;

  // 1) eventos
  const evs = Array.isArray(inc.events) ? inc.events : [];
  for (let i = evs.length - 1; i >= 0; i--) {
    const e = evs[i];
    const payload = e?.payload ?? e?.payload_json ?? null;
    const s = typeof payload === 'string' ? payload : JSON.stringify(payload || {});
    // patrón @c.us en payload
    const m = s && s.match(/[0-9A-Za-z\-]+@c\.us/);
    if (m && m[0]) return trimId(m[0]);
    // si no hay, intenta derivar del texto del payload
    const guess = waIdFromText(s);
    if (guess) return guess;
  }

  // 2) origin_name (a veces viene el número como "521XXXXXXXXXX")
  if (inc.origin_name) {
    const g = waIdFromText(inc.origin_name);
    if (g) return g;
  }

  // 3) raw_draft / raw_draft_json si están presentes en el objeto
  const raw = inc.raw_draft || inc.raw_draft_json || null;
  if (raw) {
    const s = typeof raw === 'string' ? raw : JSON.stringify(raw || {});
    const m = s && s.match(/[0-9A-Za-z\-]+@c\.us/);
    if (m && m[0]) return trimId(m[0]);
    const g = waIdFromText(s);
    if (g) return g;
  }

  return null;
}


async function safeSendDM(client, waIdRaw, message) {
  const waId = trimId(waIdRaw);
  if (!waId) return false;

  // 1) Intento directo
  try {
    await client.sendMessage(waId, message);
    return true;
  } catch (e1) {
    if (DEBUG) console.warn('[DASH-CANCEL] DM direct send fail:', waId, e1?.message || e1);
  }

  // 2) Reintento con getNumberId (cuando sólo mandar al número funciona)
  try {
    const number = waId.replace('@c.us','');
    if (!number) return false;
    const wid = await client.getNumberId(number);
    if (wid && wid._serialized) {
      await client.sendMessage(wid._serialized, message);
      return true;
    }
  } catch (e2) {
    if (DEBUG) console.warn('[DASH-CANCEL] DM send via getNumberId fail:', waId, e2?.message || e2);
  }
  return false;
}

function buildGroupCancelMessage(inc, { reason, by }) {
  const tarea = (inc.descripcion || '—').trim();
  const lugar = (inc.lugar || '—').trim();
  const folio = (inc.folio || inc.id || '—').trim();

  let msg = `🟥 *Ticket Cancelado*\n\n${tarea}\n\n*Lugar:* ${lugar}\n*Folio:* ${folio}`;
  if (reason) msg += `\n*Motivo:* ${reason}`;
  if (by)     msg += `\n*Por:* ${by}`;
  return msg;
}

function buildUserCancelMessage(inc, { reason }) {
  const tarea = (inc.descripcion || '—').trim();
  const lugar = (inc.lugar || '—').trim();
  const folio = (inc.folio || inc.id || '—').trim();

  let msg = `🟥 *Ticket cancelado*\n\n${tarea}\n\n*Lugar:* ${lugar}\n*Folio:* ${folio}`;
  if (reason) msg += `\n*Motivo:* ${reason}`;
  return msg;
}

/** Extrae groupIds del último 'dispatched_to_groups' */
function extractGroupIdsFromEvents(events = []) {
  const arr = Array.isArray(events) ? events : [];
  const last = [...arr].reverse().find(e => (e?.event_type === 'dispatched_to_groups'));
  if (!last) return [];

  const p = last.payload || {};
  if (Array.isArray(p.group_ids)) return p.group_ids.filter(isGroup);

  if (p.primaryId || (Array.isArray(p.ccIds) && p.ccIds.length)) {
    const out = [];
    if (p.primaryId && isGroup(p.primaryId)) out.push(p.primaryId);
    for (const g of (p.ccIds || [])) if (isGroup(g)) out.push(g);
    return out;
  }

  if (Array.isArray(p.sent)) {
    return p.sent.map(x => x && x.id).filter(isGroup);
  }

  const s = typeof p === 'string' ? p : JSON.stringify(p);
  const rx = /[0-9A-Za-z\-]+@g\.us/g;
  const m = s.match(rx);
  return Array.from(new Set(m || [])).filter(isGroup);
}

async function notifyGroupsExplicit(client, groupIds = [], message) {
  const ok = [];
  const fail = [];
  for (const gid of Array.from(new Set(groupIds.map(trimId)))) {
    try {
      await client.sendMessage(gid, message);
      ok.push(gid);
    } catch (e) {
      if (DEBUG) console.warn('[DASH-CANCEL] send group fail', gid, e?.message || e);
      fail.push({ gid, error: String(e?.message || e) });
    }
  }
  return { ok, fail };
}

// ────────────────────────────────────────────────────────────────────────────
// 1) FUNCIÓN para usar después de PATCH /status (estado YA es 'canceled')
// ────────────────────────────────────────────────────────────────────────────
async function notifyOnCancel({
  incidentId,
  reason = null,
  by = 'dashboard',
  client = null,
  notifyFallbackByArea = false,
  sendFollowUpToGroups = null
} = {}) {
  const inc = await getIncidentById(incidentId);
  if (!inc) throw new Error('INCIDENT_NOT_FOUND');

  const status = String(inc.status || '').toLowerCase();
  if (status !== 'canceled') {
    if (DEBUG) console.warn('[DASH-CANCEL] notifyOnCancel: not canceled, skipping', { incidentId, status });
    return { ok: false, notified: { groups_ok: [], groups_fail: [], dm: null } };
  }

  const msgGroup = buildGroupCancelMessage(inc, { reason, by });
  const msgDM    = buildUserCancelMessage(inc, { reason });

  // 1) Grupos
  const groupIdsFromEvents = extractGroupIdsFromEvents(inc.events || []);
  let sentGroups = { ok: [], fail: [] };

  if (client && groupIdsFromEvents.length) {
    sentGroups = await notifyGroupsExplicit(client, groupIdsFromEvents, msgGroup);
  } else if (client && notifyFallbackByArea) {
    try {
      const _send = sendFollowUpToGroups || require('../groups/groupRouter').sendFollowUpToGroups;
      await _send(client, { incident: inc, message: msgGroup, media: null });
    } catch (e) {
      if (DEBUG) console.warn('[DASH-CANCEL] fallback-by-area err', e?.message || e);
    }
  }

  // 2) DM al emisor
  let dmSent = null;
  if (client) {
    const dmId = extractDmId(inc);   // ← FIX: antes usabas "after"
    if (!dmId) {
      if (DEBUG) console.warn('[DASH-CANCEL] no DM detected (empty or not @c.us)');
    } else if (!isDM(dmId)) {
      if (DEBUG) console.warn('[DASH-CANCEL] detected id is not @c.us:', dmId);
    } else {
      const ok = await safeSendDM(client, dmId, msgDM);
      if (ok) dmSent = dmId;
    }
  }

  // 3) Trazabilidad
  try {
    await appendIncidentEvent(inc.id, {
      event_type: 'cancel_notice_sent',
      wa_msg_id: null,
      payload: { reason: reason || null, by, groups_ok: sentGroups.ok, groups_fail: sentGroups.fail, dm: dmSent }
    });
  } catch (e) {
    if (DEBUG) console.warn('[DASH-CANCEL] append event fail', e?.message || e);
  }

  return { ok: true, notified: { groups_ok: sentGroups.ok, groups_fail: sentGroups.fail, dm: dmSent } };
}

// ────────────────────────────────────────────────────────────────────────────
/** ENDPOINT opcional: POST /api/incidents/:id/cancel */
function attachCancelNotifyApi(app, { client, sendFollowUpToGroups } = {}) {
  if (!app) throw new Error('express app required');

  if (!client) {
    console.warn('[DASH-CANCEL] WhatsApp client no disponible; sólo DB.');
  }

  app.post('/api/incidents/:id/cancel', async (req, res) => {
    const idOrFolio = String(req.params.id || '').trim();
    const reason = (req.body && req.body.reason) || null;
    const by = (req.body && req.body.by) || 'dashboard';
    const doFallbackByArea = !!(req.body && req.body.notifyFallbackByArea);

    try {
      const before = await getIncidentById(idOrFolio);
      if (!before) return res.status(404).json({ ok: false, error: 'INCIDENT_NOT_FOUND' });

      if (String(before.status || '').toLowerCase() === 'canceled') {
        const out = await notifyOnCancel({
          incidentId: before.id, reason, by, client,
          notifyFallbackByArea: doFallbackByArea,
          sendFollowUpToGroups
        });
        return res.json({ ok: true, alreadyCanceled: true, ...out });
      }

      await closeIncident(before.id, {
        reason: reason || 'cancelled_by_dashboard',
        by,
        note: reason || null,
        wa_msg_id: null
      });

      const out = await notifyOnCancel({
        incidentId: before.id, reason, by, client,
        notifyFallbackByArea: doFallbackByArea,
        sendFollowUpToGroups
      });

      return res.json({ ok: true, ...out });
    } catch (e) {
      console.error('[DASH-CANCEL] fatal', e);
      return res.status(500).json({ ok: false, error: 'INTERNAL_ERROR', detail: String(e?.message || e) });
    }
  });
}

// ────────────────────────────────────────────────────────────────────────────
/** Hook invocado tras PATCH /status=canceled */
async function handleDashboardCancelStatusChange({
  client,
  incidentId,
  reason,
  by = 'dashboard',
  sendFollowUpToGroups
}) {
  const inc = await getIncidentById(incidentId);
  if (!inc) return;

  const msgGroup = buildGroupCancelMessage(inc, { reason, by });
  const msgDM    = buildUserCancelMessage(inc, { reason });

  // 1) Grupos
  const groupIds = extractGroupIdsFromEvents(inc.events || []);
  if (client && groupIds.length) {
    await notifyGroupsExplicit(client, groupIds, msgGroup);
  } else if (client && typeof sendFollowUpToGroups === 'function') {
    try { await sendFollowUpToGroups(client, { incident: inc, message: msgGroup, media: null }); } catch {}
  }

  // 2) DM
  if (client) {
    const dmId = extractDmId(inc); // usa chat_id o eventos
    if (dmId && isDM(dmId)) {
      await safeSendDM(client, dmId, msgDM);
    } else if (DEBUG) {
      console.warn('[DASH-CANCEL] handleHook: no DM id found for incident', inc.id, 'chat_id=', inc.chat_id);
    }
  }

  // 3) Trazabilidad
  try {
    await appendIncidentEvent(inc.id, {
      event_type: 'cancel_notice_sent',
      wa_msg_id: null,
      payload: { reason: reason || null, by }
    });
  } catch {}
}

module.exports = {
  notifyOnCancel,
  attachCancelNotifyApi,
  handleDashboardCancelStatusChange
};

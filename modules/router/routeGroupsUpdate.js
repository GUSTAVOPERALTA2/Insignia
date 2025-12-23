// modules/router/routeGroupUpdate.js
// ─────────────────────────────────────────────────────────────────────────────
// CANCELAR incidencias desde mensajes en GRUPO (WhatsApp)
// - Detecta intención T-C (cancelar) con el clasificador de grupos
// - Anclaje por FOLIO explícito (preferido)
// - (Opcional) Reply al mensaje del bot (stub)
// - Desambiguación asistida por lista (grupo/área → tickets abiertos)
// - NUEVO: si sólo hay 1 ticket abierto, pide confirmación (SI/NO) antes de cancelar
// - Usa incidenceDB actualizado (closeIncident, getIncidentByFolio, etc.)
// ─────────────────────────────────────────────────────────────────────────────

const { classifyGroupMessage } = require('../groups/groupUpdate');
const { loadGroupsConfig, safeSendMessage } = require('../groups/groupRouter'); // ✅ safeSendMessage

const {
  getIncidentByFolio,
  listOpenIncidentsByArea,
  listOpenIncidentsRecentlyDispatchedToGroup,
  closeIncident,
  appendIncidentEvent,
} = require('../db/incidenceDB');

const DEBUG = (process.env.VICEBOT_DEBUG || '1') === '1';

// ──────────────────────────────────────────────
// Safe reply (evita crash por session closed)
// ─────────────────────────────────────────────-
async function safeReply(client, msg, text, options) {
  try {
    return await msg.reply(text, undefined, options);
  } catch (e) {
    if (DEBUG) console.warn('[GROUP-CANCEL] msg.reply failed; fallback sendMessage', e?.message || e);
    try {
      if (typeof safeSendMessage === 'function') {
        return await safeSendMessage(client, msg.from, text, options);
      }
      // fallback ultra mínimo (por si safeSendMessage no existe)
      return await client.sendMessage(msg.from, text, options);
    } catch (e2) {
      if (DEBUG) console.warn('[GROUP-CANCEL] fallback send failed', e2?.message || e2);
      return null;
    }
  }
}

// ──────────────────────────────────────────────
// Ayudas
// ─────────────────────────────────────────────-
function isGroupId(id = '') { return /@g\.us$/.test(String(id || '')); }
function actorKey(msg) {
  const gid = String(msg.from || '');
  const uid = String(msg.author || msg.from || '');
  return `${gid}:${uid}`;
}
function parseFoliosFromText(text = '') {
  const rx = /\b([A-Z]{2,5}-\d{3,6})\b/gi; // SYS-00006, MANT-123, etc.
  const out = [];
  let m;
  while ((m = rx.exec(text))) out.push(m[1].toUpperCase());
  return Array.from(new Set(out));
}
function brief(inc) {
  const lugar = inc?.lugar || '—';
  const desc = (inc?.descripcion || '').trim();
  const d = desc.length > 60 ? desc.slice(0, 57) + '…' : (desc || '—');
  const folio = inc?.folio || inc?.id || '—';
  return `${folio} — ${lugar} — “${d}”`;
}
function nowISO() { return new Date().toISOString(); } // (no se usa ahora, pero ok)
function isYes(text='') {
  const t = text.trim().toLowerCase();
  return /^(si|sí|s[ií]|afirmativo|ok|dale|confirmo|confirmar|correcto|yes|yep|sip)$/i.test(t);
}
function isNo(text='') {
  const t = text.trim().toLowerCase();
  return /^(no|nel|negativo|nah|nop|nopes)$/i.test(t);
}

// ──────────────────────────────────────────────
// Sesiones de desambiguación/confirmación (in-memory)
// Clave: groupId:actorId → { expiresAt, kind:'cancel'|'confirm_cancel', ... }
// ─────────────────────────────────────────────-
const CANCEL_SESSIONS = new Map();
const SESSION_TTL_MS = parseInt(process.env.VICEBOT_GROUP_CANCEL_TTL_MS || '480000', 10); // 8 min

function setCancelSession(key, data) {
  CANCEL_SESSIONS.set(key, { ...data, expiresAt: Date.now() + SESSION_TTL_MS });
}
function getCancelSession(key) {
  const s = CANCEL_SESSIONS.get(key);
  if (!s) return null;
  if (Date.now() > s.expiresAt) { CANCEL_SESSIONS.delete(key); return null; }
  return s;
}
function clearCancelSession(key) { CANCEL_SESSIONS.delete(key); }

// ──────────────────────────────────────────────
// Paso 1: ¿El mensaje es T-C (cancelar)?
// ─────────────────────────────────────────────-
async function isCancelIntentInGroup(msg) {
  const text = (msg.body || '').trim();
  if (!isGroupId(msg.from)) return false;

  try {
    const r = await classifyGroupMessage(text);
    if (DEBUG) console.log('[GROUP-CANCEL] classify:', r);
    return r && r.intent === 'T-C' && (r.confidence ?? 0) >= 0.6;
  } catch (e) {
    if (DEBUG) console.warn('[GROUP-CANCEL] classify error', e?.message || e);
    return false;
  }
}

// ──────────────────────────────────────────────
/** Paso 2: Cancelar por FOLIO (posible múltiple). Mantiene “cancelación directa”.
 *  La nueva regla de confirmación aplica a “hay 1 sola abierta” SIN folio, no a folio explícito. */
// ─────────────────────────────────────────────-
async function tryCancelByFolio(client, msg) {
  const text = (msg.body || '').trim();
  const folios = parseFoliosFromText(text);
  if (!folios.length) return null;

  const results = [];
  for (const folio of folios) {
    try {
      const inc = await getIncidentByFolio(folio);
      if (!inc) { results.push({ folio, ok: false, reason: 'NOT_FOUND' }); continue; }
      if (String(inc.status || '').toLowerCase() !== 'open') {
        results.push({ folio, ok: false, reason: 'NOT_OPEN' }); continue;
      }

      const res = await closeIncident(inc.id, {
        reason: 'group_cancel_by_folio',
        by: msg.author || msg.from,
        note: text,
        wa_msg_id: msg.id?._serialized || null,
      });

      if (res?.ok) {
        await appendIncidentEvent(inc.id, {
          event_type: 'group_cancel_ack',
          wa_msg_id: msg.id?._serialized || null,
          payload: { source: 'folio_explicit', text }
        });
        results.push({ folio, ok: true, incident: inc });
      } else {
        results.push({ folio, ok: false, reason: 'CANCEL_FAILED' });
      }
    } catch (e) {
      if (DEBUG) console.warn('[GROUP-CANCEL] by folio err', folio, e?.message || e);
      results.push({ folio, ok: false, reason: 'EXCEPTION' });
    }
  }

  const oks = results.filter(r => r.ok).map(r => r.folio);
  const fails = results.filter(r => !r.ok).map(r => `${r.folio}${r.reason ? ` (${r.reason})` : ''}`);

  if (oks.length && !fails.length) {
    await safeReply(client, msg, `🟨 Cancelado${oks.length>1?'s':''}: ${oks.join(', ')}`);
  } else if (!oks.length && fails.length) {
    await safeReply(client, msg, `⚠️ No pude cancelar: ${fails.join(', ')}. Verifica el folio.`);
  } else if (oks.length && fails.length) {
    await safeReply(client, msg, `🟨 Cancelado${oks.length>1?'s':''}: ${oks.join(', ')}\n⚠️ Falló: ${fails.join(', ')}`);
  }

  return { handled: true, multi: folios.length > 1, results };
}

// ──────────────────────────────────────────────
// Paso 2b: Cancelar por reply (OPCIONAL - stub)
// ─────────────────────────────────────────────-
async function tryCancelByReply(_client, msg) {
  if (!msg.hasQuotedMsg) return null;
  return null;
}

// ──────────────────────────────────────────────
// Paso 3: Desambiguación por lista (grupo/área)
//  - NUEVO: si sólo hay 1 candidato → pedir confirmación SI/NO
// ─────────────────────────────────────────────-
function areasForGroupId(cfg, groupId) {
  const out = [];
  const map = (cfg && cfg.areas) || {};
  for (const [area, gid] of Object.entries(map)) {
    if (String(gid || '').trim() === String(groupId || '').trim()) out.push(area.toLowerCase());
  }
  return out;
}

async function startDisambiguationCancel(client, msg) {
  let candidates = [];
  try {
    candidates = await listOpenIncidentsRecentlyDispatchedToGroup(msg.from, {
      windowMins: parseInt(process.env.VICEBOT_GROUP_WINDOW_MINS || '4320', 10), // 72h
      limit: 20
    });
  } catch (e) {
    if (DEBUG) console.warn('[GROUP-CANCEL] recent-dispatched query err', e?.message || e);
  }

  if (!Array.isArray(candidates) || !candidates.length) {
    const cfg = await loadGroupsConfig();
    const areas = areasForGroupId(cfg, msg.from);
    for (const area of areas) {
      try {
        const list = await listOpenIncidentsByArea(area, { limit: 10 });
        if (Array.isArray(list) && list.length) candidates = candidates.concat(list);
      } catch (e) {
        if (DEBUG) console.warn('[GROUP-CANCEL] listByArea err', area, e?.message || e);
      }
    }
  }

  const seen = new Set();
  candidates = (candidates || []).filter(x => {
    const k = x.id || x.folio;
    if (!k) return false;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  if (!candidates.length) {
    await safeReply(client, msg, 'No encuentro tickets *abiertos* asociados a este grupo. Indica el *folio* a cancelar (ej. SYS-00006).');
    return { handled: true, started: false };
  }

  if (candidates.length === 1) {
    const inc = candidates[0];
    const key = actorKey(msg);
    setCancelSession(key, { kind: 'confirm_cancel', incident: inc });

    await safeReply(
      client,
      msg,
      `Solo tengo *1 ticket abierto* asociado a este grupo:\n` +
      `• ${brief(inc)}\n` +
      `¿Deseas *cancelarlo*? Responde *SI* o *NO*.`
    );
    return { handled: true, started: true, confirm: true };
  }

  const key = actorKey(msg);
  setCancelSession(key, { kind: 'cancel', candidates });

  const lines = candidates.slice(0, 8).map((c, i) => `${i + 1}) ${brief(c)}`);
  let tail = 'Responde el *número* o el *folio* a cancelar.';
  if (candidates.length > 8) tail = `Mostrando 8 de ${candidates.length}. ${tail}`;

  await safeReply(
    client,
    msg,
    'Tengo varios tickets *abiertos* asociados a este grupo. ¿Cuál quieres *cancelar*?\n' +
    lines.join('\n') + '\n' + tail
  );
  return { handled: true, started: true, count: candidates.length };
}

// ──────────────────────────────────────────────
// Paso 4: Manejo de sesiones (desambiguación y confirmación)
// ─────────────────────────────────────────────-
async function maybeHandleCancelSelection(client, msg) {
  const key = actorKey(msg);
  const s = getCancelSession(key);
  if (!s) return false;

  const text = (msg.body || '').trim();

  if (s.kind === 'confirm_cancel' && s.incident) {
    if (isYes(text)) {
      clearCancelSession(key);
      try {
        const res = await closeIncident(s.incident.id, {
          reason: 'group_cancel_confirmed',
          by: msg.author || msg.from,
          note: text,
          wa_msg_id: msg.id?._serialized || null,
        });
        if (res?.ok) {
          await appendIncidentEvent(s.incident.id, {
            event_type: 'group_cancel_ack',
            wa_msg_id: msg.id?._serialized || null,
            payload: { source: 'confirm_one_open', text }
          });
          await safeReply(client, msg, `🟨 Cancelado *${s.incident.folio || s.incident.id}* — ${s.incident.lugar || '—'}.`);
          return true;
        }
      } catch (e) {
        if (DEBUG) console.warn('[GROUP-CANCEL] confirm err', e?.message || e);
      }
      await safeReply(client, msg, '⚠️ No pude cancelar ese ticket. Indica el *folio* para confirmarlo.');
      return true;
    }

    if (isNo(text)) {
      clearCancelSession(key);
      await safeReply(client, msg, 'De acuerdo, no se cancela. 👍');
      return true;
    }

    await safeReply(client, msg, 'No entendí. Responde *SI* para cancelar o *NO* para dejarla abierta.');
    return true;
  }

  if (s.kind !== 'cancel' || !Array.isArray(s.candidates)) return false;

  const folios = parseFoliosFromText(text);
  if (folios.length) {
    clearCancelSession(key);
    return !!(await tryCancelByFolio(client, msg));
  }

  const m = text.match(/^\s*(\d{1,2})\s*$/);
  if (!m) {
    await safeReply(client, msg, 'No entendí. Responde con *número* (ej. 2) o *folio* (ej. SYS-00006).');
    return true;
  }

  const idx = parseInt(m[1], 10) - 1;
  const cand = s.candidates[idx];
  if (!cand) {
    await safeReply(client, msg, 'Número fuera de rango. Elige uno de la lista mostrada o indica el *folio*.');
    return true;
  }

  clearCancelSession(key);
  try {
    const res = await closeIncident(cand.id, {
      reason: 'group_cancel_disambiguated',
      by: msg.author || msg.from,
      note: text,
      wa_msg_id: msg.id?._serialized || null,
    });
    if (res?.ok) {
      await appendIncidentEvent(cand.id, {
        event_type: 'group_cancel_ack',
        wa_msg_id: msg.id?._serialized || null,
        payload: { source: 'disambiguation', pick: idx + 1, text }
      });
      await safeReply(client, msg, `🟨 Cancelado *${cand.folio || cand.id}* — ${cand.lugar || '—'}.`);
      return true;
    }
  } catch (e) {
    if (DEBUG) console.warn('[GROUP-CANCEL] cancel disamb err', e?.message || e);
  }

  await safeReply(client, msg, '⚠️ No pude cancelar ese ticket. Indica el *folio* para confirmarlo.');
  return true;
}

// ──────────────────────────────────────────────
// ENTRYPOINT público
// ─────────────────────────────────────────────-
async function maybeHandleGroupCancel(client, msg) {
  if (!isGroupId(msg.from)) return false;

  const handledBySession = await maybeHandleCancelSelection(client, msg);
  if (handledBySession) return true;

  const seemsCancel = await isCancelIntentInGroup(msg);
  if (!seemsCancel) return false;

  const folioRes = await tryCancelByFolio(client, msg);
  if (folioRes?.handled) return true;

  const replyRes = await tryCancelByReply(client, msg);
  if (replyRes?.handled) return true;

  const disamb = await startDisambiguationCancel(client, msg);
  if (disamb?.handled) return true;

  await safeReply(client, msg, '¿Me indicas el *folio* a cancelar? (Ej. SYS-00006)');
  return true;
}

module.exports = {
  maybeHandleGroupCancel,
  maybeHandleCancelSelection,
};

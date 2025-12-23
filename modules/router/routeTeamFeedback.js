// modules/router/routeTeamFeedback.js
// Router para mensajes del equipo (retroalimentación). Política estricta:
// SOLO se acepta retro si:
//   (A) es REPLY al card principal del ticket, o
//   (B) el usuario elige una opción del MENÚ (1..9) que envía el bot.
// Cualquier otro caso: no se registra; si hay abiertos se muestra menú + se
// guarda la retro original como draft para registrarla cuando elijan 1..9.

const path = require('path');
const fs = require('fs');
const { MessageMedia } = require('whatsapp-web.js');

const { noteRequesterNotify } = require('./routeRequesterReply');
const { runFeedbackEngine } = require('../ai/coreFeedbackEngine');
const { linkMessageToIncident } = require('../linker/messageIncidentLinker');

// ✅ IMPORTANTE: usar el safeSendMessage ya centralizado en groupRouter
const { safeSendMessage } = require('../groups/groupRouter');

// DB (carga perezosa)
function getDB() {
  try { return require('../db/incidenceDB'); } catch { return {}; }
}
const incidenceDB = getDB();

// Helpers DB
async function appendEvent(incidentId, evt) {
  if (typeof incidenceDB.appendIncidentEvent === 'function') return incidenceDB.appendIncidentEvent(incidentId, evt);
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
  return chatId.endsWith('@g.us');
}

// Cache requester
const { getRequesterForIncident } = require('../state/lastGroupDispatch');

const DEBUG = (process.env.VICEBOT_DEBUG || '1') === '1';

/* ──────────────────────────────────────────────────────────────
 * ENV / Config comandos y validación de draft
 * ────────────────────────────────────────────────────────────── */

function envList(name, defCsv) {
  const raw = String(process.env[name] || defCsv || '').trim();
  return raw.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
}
const MENU_CMDS   = new Set(envList('VICEBOT_TEAM_MENU_COMMANDS', 'menu,pendientes,lista,tickets'));
const RESET_CMDS  = new Set(envList('VICEBOT_TEAM_DRAFT_RESET_COMMANDS', 'reset,borrar,limpiar'));
const ADD_CMDS    = new Set(envList('VICEBOT_TEAM_DRAFT_ADD_COMMANDS', 'sumar,agregar,añadir'));

const DRAFT_MINLEN = parseInt(process.env.VICEBOT_TEAM_DRAFT_MINLEN || '3', 10);

const DEFAULT_DRAFT_VALID_RE = /^[\p{L}\p{N}\w\s.,:;!?()\-_\/#+%'"@]+$/u;

let DRAFT_VALID_RE = DEFAULT_DRAFT_VALID_RE;
(() => {
  const fromEnv = process.env.VICEBOT_TEAM_DRAFT_VALID_RE;
  if (fromEnv && fromEnv.trim()) {
    try {
      DRAFT_VALID_RE = new RegExp(fromEnv.trim(), 'u');
    } catch (e) {
      console.warn('[TEAMFB] VICEBOT_TEAM_DRAFT_VALID_RE inválida, usando default:', e.message);
      DRAFT_VALID_RE = DEFAULT_DRAFT_VALID_RE;
    }
  }
})();

const ENFORCE_FIRST_DRAFT = (process.env.VICEBOT_TEAM_ENFORCE_FIRST_DRAFT || '1') === '1';

function isValidDraftText(text='') {
  const s = String(text || '').trim();
  if (!s || s.length < DRAFT_MINLEN) return false;
  if (!DRAFT_VALID_RE.test(s)) return false;
  if (!/[\p{L}\p{N}]/u.test(s)) return false;
  return true;
}

/* ──────────────────────────────────────────────────────────────
 * Desambiguación con menú + "draft" de retro pendiente
 * ────────────────────────────────────────────────────────────── */

const PENDING_MENU   = new Map(); // groupId -> { items:[{id, folio, lugar, descripcion}], ts }
const PENDING_DRAFT  = new Map(); // groupId -> { text, medias:[], ts, valid:boolean }
const MENU_WINDOW_MIN = parseInt(process.env.VICEBOT_TEAM_REPLY_MENU_WINDOW_MIN || '15', 10);

function setPendingMenu(groupId, items) { PENDING_MENU.set(groupId, { items, ts: Date.now() }); }
function getPendingMenu(groupId) {
  const rec = PENDING_MENU.get(groupId);
  if (!rec) return null;
  const ageMin = (Date.now() - rec.ts) / 60000;
  if (ageMin > MENU_WINDOW_MIN) { PENDING_MENU.delete(groupId); return null; }
  return rec.items;
}

function getPendingDraft(groupId) {
  const rec = PENDING_DRAFT.get(groupId);
  if (!rec) return null;
  const ageMin = (Date.now() - rec.ts) / 60000;
  if (ageMin > MENU_WINDOW_MIN) { PENDING_DRAFT.delete(groupId); return null; }
  return rec;
}
function setPendingDraft(groupId, draft) { PENDING_DRAFT.set(groupId, { ...draft, ts: Date.now() }); }
function popPendingDraft(groupId) {
  const rec = getPendingDraft(groupId);
  if (rec) PENDING_DRAFT.delete(groupId);
  return rec || null;
}
function clearMenuAndDraft(groupId) {
  PENDING_MENU.delete(groupId);
  PENDING_DRAFT.delete(groupId);
}

function maybeStoreDraft(groupId, { text, medias = [] }, mode = 'set') {
  const trimmed = String(text || '').trim();
  const existing = getPendingDraft(groupId);

  if (mode === 'append') {
    if (!existing || !existing.text) return false;
    const payload = trimmed.replace(/^(\w+):?\s*/i, '').trim();
    if (!isValidDraftText(payload)) return false;
    const merged = `${existing.text} ${payload}`.trim();
    setPendingDraft(groupId, { text: merged, medias: existing.medias || [], valid: isValidDraftText(merged) });
    return true;
  }

  const incomingIsValid = isValidDraftText(trimmed);
  if (!existing) {
    if (!incomingIsValid) return false;
    setPendingDraft(groupId, { text: trimmed, medias, valid: true });
    return true;
  }

  if (ENFORCE_FIRST_DRAFT && existing.valid) return false;

  if (!existing.valid && incomingIsValid) {
    setPendingDraft(groupId, { text: trimmed, medias, valid: true });
    return true;
  }

  return false;
}

/**
 * Menú de desambiguación:
 * {no}. {LUGAR}-{FOLIO}: {DESCRIPCION}
 */
function formatDisambiguationMenu(items) {
  const list = Array.isArray(items) ? items : [];
  const top = list.slice(0, 9);
  const lines = [
    'Tengo varios tickets abiertos en este grupo. *Responde con el número* (1-9) o *responde al card* del ticket:\n'
  ];

  top.forEach((it, idx) => {
    const n = idx + 1;
    const folio = it.folio || it.id || 'SIN-FOLIO';
    const lugarTxt = it.lugar && String(it.lugar).trim() ? String(it.lugar).trim() : 'Sin lugar';
    const rawDesc =
      (it.descripcion && String(it.descripcion).trim()) ||
      (it.interpretacion && String(it.interpretacion).trim()) ||
      '(sin descripción)';
    const desc = rawDesc.length > 120 ? rawDesc.slice(0, 117) + '…' : rawDesc;

    lines.push(`${n}. *${lugarTxt}* - *${folio}*: ${desc}`);
  });

  if (list.length > top.length) {
    lines.push(`…y ${list.length - top.length} más recientes.`);
  }

  return lines.join('\n');
}

function resolveMenuChoiceIfAny(groupId, text) {
  const items = getPendingMenu(groupId);
  if (!items || !items.length || !text) return null;

  const patts = [
    /^\s*(\d{1,2})\s*$/i,
    /^\s*(?:op(?:cion|ción)?|num|número)\s*(\d{1,2})\s*$/i,
    /^\s*la\s*(\d{1,2})\s*$/i
  ];
  let m = null;
  for (const re of patts) { m = text.match(re); if (m) break; }
  if (!m) return null;

  const n = parseInt(m[1], 10);
  const itemsLen = items.length;
  if (isNaN(n) || n < 1 || n > itemsLen) return null;

  const picked = items[n - 1];
  return picked ? { incidentId: picked.id, via: 'group_menu_choice', folio: picked.folio || null } : null;
}

// resolver por reply al card con folio
const FOLIO_RE = /\b[A-Z]{2,8}-\d{3,6}\b/;

async function tryLinkByQuotedFolio(msg) {
  try {
    if (!msg.hasQuotedMsg) return null;
    const quoted = await msg.getQuotedMessage();
    if (!quoted) return null;

    const body = (quoted.body || '').toUpperCase();
    const m = body.match(FOLIO_RE);
    if (!m) return null;

    const folio = m[0];
    if (typeof incidenceDB.getIncidentByFolio !== 'function') return null;

    const inc = await incidenceDB.getIncidentByFolio(folio);
    if (!inc || !inc.id) return null;

    return {
      incidentId: inc.id,
      via: 'reply_folio',
      linkMeta: {
        quotedHasFolio: true,
        bodyHasFolio: false,
        folioFromText: folio,
        quotedMsgId: quoted.id?._serialized || null
      }
    };
  } catch {
    return null;
  }
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

async function showMenuAndMaybeStoreDraft(msg, opts = {}) {
  const {
    forceReplyIfNoOpen = true,
    storeDraft = true,
  } = opts;

  let medias = [];
  if (storeDraft) {
    const body = String(msg.body || '').trim();
    const isMenuChoice = !!resolveMenuChoiceIfAny(msg.from, body);
    if (!isMenuChoice && isValidDraftText(body)) {
      if (msg.hasMedia) {
        try {
          const media = await msg.downloadMedia();
          if (media?.mimetype?.startsWith('image/')) {
            medias.push({
              mimetype: media.mimetype,
              data: media.data,
              filename: media.filename || null,
            });
          }
        } catch {}
      }
      maybeStoreDraft(msg.from, { text: body, medias }, 'set');
    }
  }

  const open = await listOpenForGroup(msg.from);
  if (!open.length) {
    if (forceReplyIfNoOpen) {
      try {
        await msg.reply('No identifiqué el ticket. Por favor, *responde directamente al card del ticket* para registrar la retro.');
      } catch {}
    }
    return { shown: false };
  }

  setPendingMenu(msg.from, open);
  const txt = formatDisambiguationMenu(open);
  try { await msg.reply(txt); } catch {}
  return { shown: true };
}

/* ──────────────────────────────────────────────────────────────
 * Contexto del incidente
 * ────────────────────────────────────────────────────────────── */
async function tryGetIncidentContext(incidentId) {
  if (typeof incidenceDB.getIncidentById === 'function') {
    try {
      const full = await incidenceDB.getIncidentById(incidentId);
      if (full && full.id) return full;
    } catch {}
  }
  if (typeof incidenceDB.getIncidentContext === 'function') {
    try {
      const ctx = await incidenceDB.getIncidentContext(incidentId);
      if (ctx) return ctx;
    } catch {}
  }
  return { id: incidentId, folio: null, chat_id: null, chatId: null, meta: {} };
}

async function safeGetSender(client, msg) {
  try { const c = await msg.getContact(); return c?.pushname || c?.name || c?.number || null; }
  catch { return null; }
}

function extractRequesterChatId(incidentObj) {
  if (!incidentObj) return null;

  const candidates = [
    incidentObj.chatId,
    incidentObj.chat_id,
    incidentObj.meta?.chatId,
    incidentObj.requester_chat,
    incidentObj.originChatId
  ];

  for (const v of candidates) {
    if (v && typeof v === 'string' && !/@g\.us$/.test(v)) return v;
  }
  return null;
}

/**
 * Formato del DM al solicitante:
 * {ID} - {desc corta}
 *
 * ACTUALIZACION DEL TICKET:
 * {comentario}
 */
function formatRequesterDM({ folio, descripcion, note }) {
  const idTxt = folio || 'Ticket';

  const baseDesc = (descripcion || '').trim();
  const shortDesc = baseDesc
    ? (baseDesc.length > 80 ? baseDesc.slice(0, 77) + '…' : baseDesc)
    : 'Actualización';

  const comment = (note || '').trim() || '—';

  const lines = [];
  lines.push(`*${idTxt}* - ${shortDesc}`);
  lines.push('');
  lines.push('*ACTUALIZACIÓN DEL TICKET:*');
  lines.push(comment);

  return lines.join('\n');
}

// Entry point
async function maybeHandleTeamFeedback(client, msg) {
  if (msg.fromMe) return false;
  if (!looksLikeTeamChannel(msg)) return false;

  const rawBody = (msg.body || '').trim();
  const bodyLc = rawBody.toLowerCase();

  // 0.1) Comandos
  if (MENU_CMDS.has(bodyLc)) {
    await showMenuAndMaybeStoreDraft(msg, { forceReplyIfNoOpen: false, storeDraft: false });
    return true;
  }

  if (RESET_CMDS.has(bodyLc)) {
    clearMenuAndDraft(msg.from);
    try { await msg.reply('🧹 Borré tu borrador. Escribe la retro y luego elige el número del ticket.'); } catch {}
    await showMenuAndMaybeStoreDraft(msg, { forceReplyIfNoOpen: false, storeDraft: false });
    return true;
  }

  if ([...ADD_CMDS].some(c => bodyLc.startsWith(c))) {
    const ok = maybeStoreDraft(msg.from, { text: rawBody }, 'append');
    try {
      await msg.reply(ok
        ? '➕ Texto agregado a tu borrador. Cuando estés listo, elige el número (1-9).'
        : 'No pude agregar ese texto. Verifica que sea claro y contenga letras o números.'
      );
    } catch {}
    return true;
  }

  // 0.2) ¿Viene respuesta a menú?
  const choice = resolveMenuChoiceIfAny(msg.from, rawBody);
  let frozenDraft = null;

  if (choice) {
    frozenDraft = getPendingDraft(msg.from);
    if (DEBUG) console.log('[TEAMFB] menu choice', { choice, hasDraft: !!frozenDraft });
  }

  // 0.3) Primero intentamos reply al card con folio
  let link = null;
  if (!choice) link = await tryLinkByQuotedFolio(msg);

  // 1) fallback link estándar
  if (!link) {
    link = choice
      ? { incidentId: choice.incidentId, via: choice.via, linkMeta: { quotedHasFolio: false, bodyHasFolio: false, folioFromText: choice.folio || null, quotedMsgId: null } }
      : await linkMessageToIncident(msg, incidenceDB);
  }

  if (DEBUG) console.log('[TEAMFB] link.1', link);

  const via = link?.via || '';
  const isAllowedDirect = via === 'reply_folio' || via === 'group_menu_choice';

  if (!isAllowedDirect) {
    await showMenuAndMaybeStoreDraft(msg);
    return true;
  }

  if (!link?.incidentId) {
    try { await msg.reply('No identifiqué el ticket. Por favor, *responde directamente al card del ticket* o elige una opción del menú.'); } catch {}
    return true;
  }

  // 2) Texto fuente para la IA
  let sourceText = '';
  if (choice) {
    if (frozenDraft && frozenDraft.valid) {
      sourceText = frozenDraft.text;
    } else {
      try { await msg.reply('Necesito tu retro (texto) antes de enviar. Escribe tu mensaje y luego elige el número del ticket.'); } catch {}
      return true;
    }
  } else {
    if (isValidDraftText(rawBody)) sourceText = rawBody;
    else {
      try { await msg.reply('Por favor escribe la retro (texto claro) y vuelve a responder al card del ticket.'); } catch {}
      return true;
    }
  }

  // 2.1) Contexto ticket
  const incidentCtx = await tryGetIncidentContext(link.incidentId);

  // 2.2) Feedback engine
  let fb;
  try {
    fb = await runFeedbackEngine({
      text: sourceText,
      roleHint: 'team',
      ticket: {
        id: incidentCtx?.id || link.incidentId,
        folio: incidentCtx?.folio || null,
        descripcion: incidentCtx?.descripcion || incidentCtx?.interpretacion || '',
        lugar: incidentCtx?.lugar || null,
        status: incidentCtx?.status || null,
      },
      history: [],
      source: 'team_group',
    });
  } catch (e) {
    if (DEBUG) console.warn('[TEAMFB] runFeedbackEngine err', e?.message || e);
    fb = {
      is_relevant: false,
      role: 'team',
      kind: 'note',
      status_intent: 'none',
      requester_side: 'unknown',
      polarity: 'neutral',
      normalized_note: sourceText,
      rationale: 'fallback engine error',
      confidence: 0.0,
      next_status: incidentCtx?.status || null,
    };
  }

  if (DEBUG) console.log('[TEAMFB] engine out', fb);

  const MIN = parseFloat(process.env.VICEBOT_INTENT_CONFIDENCE_MIN || '0.50');

  const shouldTreatAsNote = isAllowedDirect && isValidDraftText(sourceText);
  const shouldApplyAutomation = fb.is_relevant && fb.confidence >= MIN;

  if (!shouldApplyAutomation && !shouldTreatAsNote) {
    await showMenuAndMaybeStoreDraft(msg, { forceReplyIfNoOpen: false, storeDraft: false });
    return true;
  }

  // 3) Adjuntos
  let medias = [];
  if (choice) {
    if (frozenDraft && Array.isArray(frozenDraft.medias) && frozenDraft.medias.length) medias = frozenDraft.medias;
  } else if (msg.hasMedia) {
    try {
      const media = await msg.downloadMedia();
      if (media?.mimetype?.startsWith('image/')) {
        medias.push({ mimetype: media.mimetype, data: media.data, filename: media.filename || null });
      }
    } catch {}
  }

  if (medias.length) {
    const saved = persistMediasToDisk(link.incidentId, medias);
    if (saved.length) await appendAttachments(link.incidentId, saved, { alsoEvent: true });
  }

  // 4) Evento en DB
  const waId = msg.id?.id || null;
  const eventPayload = {
    engine: 'coreFeedbackEngine',
    role: fb.role,
    kind: fb.kind,
    status_intent: fb.status_intent,
    requester_side: fb.requester_side,
    polarity: fb.polarity,
    note: fb.normalized_note || sourceText,
    raw_text: sourceText,
    confidence: fb.confidence,
    next_status: fb.next_status || null,
    rationale: fb.rationale || null,
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

  if (choice) clearMenuAndDraft(msg.from);

  // 5) Estado
  const current = await getStatus(link.incidentId);
  const targetStatus = fb.next_status || current || null;

  try {
    if (targetStatus && targetStatus !== current) {
      await updateStatus(link.incidentId, targetStatus);
    }
  } catch (e) {
    if (DEBUG) console.warn('[TEAMFB] status update err', e?.message || e);
  }

  // 6) Notificar solicitante (DM) + reenviar evidencias
  try {
    const enable = String(process.env.VICEBOT_NOTIFY_REQUESTER_ON_TEAM_FEEDBACK || '1') !== '0';
    if (enable) {
      let requesterChat = extractRequesterChatId(incidentCtx);
      if (!requesterChat && typeof getRequesterForIncident === 'function') requesterChat = getRequesterForIncident(link.incidentId);

      if (requesterChat && !/@g\.us$/.test(requesterChat)) {
        const dm = formatRequesterDM({
          folio: incidentCtx?.folio || null,
          descripcion: incidentCtx?.descripcion || incidentCtx?.interpretacion || null,
          note: eventPayload.note,
        });

        // ✅ protegido contra session closed
        const dmRes = await safeSendMessage(client, requesterChat, dm);
        if (dmRes.ok) {
          noteRequesterNotify(requesterChat, link.incidentId);
        } else if (DEBUG) {
          console.warn('[TEAMFB] DM to requester failed (safe)', { requesterChat, err: dmRes.error });
        }

        // ✅ reenviar evidencias protegido
        if (medias.length) {
          for (let i = 0; i < medias.length; i++) {
            const m = medias[i];
            try {
              const mm = new MessageMedia(m.mimetype, m.data, m.filename || undefined);
              const caption = i === 0 ? 'Evidencia enviada por el equipo para este ticket.' : '';
              const res = await safeSendMessage(client, requesterChat, mm, caption ? { caption } : undefined);
              if (!res.ok) {
                if (DEBUG) console.warn('[TEAMFB] media->requester failed (safe)', { requesterChat, err: res.error });
                // evitamos seguir mandando si el cliente está tronado
                break;
              }
            } catch (e) {
              if (DEBUG) console.warn('[TEAMFB] error building/sending media', e?.message || e);
              break;
            }
          }

          if (DEBUG) {
            console.log('[TEAMFB] medias reenviadas (intentado)', {
              incidentId: link.incidentId,
              requesterChat,
              count: medias.length,
            });
          }
        }
      } else if (DEBUG) {
        console.warn('[TEAMFB] requesterChat not found; DM skipped');
      }
    }
  } catch (e) {
    if (DEBUG) console.warn('[TEAMFB] notify requester err', e?.message || e);
  }

  // 7) Acuse en grupo
  try { await msg.reply('✅ Retro registrada. ¡Gracias!'); } catch {}

  return true;
}

module.exports = { maybeHandleTeamFeedback };

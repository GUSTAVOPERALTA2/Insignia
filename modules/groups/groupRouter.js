// modules/groups/groupRouter.js
// Resolución y envío de incidencias a grupos de WhatsApp basados en un catálogo JSON plano.

const fsp = require('fs/promises');
const fs = require('fs'); // ✅ lectura sync con cache (formatIncidentMessage es sync)
const path = require('path');

const DEBUG = (process.env.VICEBOT_DEBUG || '1') === '1';
const GROUPS_PATH =
  process.env.VICEBOT_GROUPS_PATH ||
  path.join(process.cwd(), 'data', 'groups.json');

const DRYRUN = (process.env.VICEBOT_GROUPS_DRYRUN || '0') === '1';

// ✅ users.json (para resolver Origen: Nombre (Cargo))
const USERS_PATH =
  process.env.USERS_PATH ||
  process.env.VICEBOT_USERS_PATH ||
  path.join(process.cwd(), 'data', 'users.json');

// Cache de users.json (60s)
let _usersCache = null;
let _usersCacheTs = 0;

// ──────────────────────────────────────────────────────────────
// ✅ SAFE SEND (protege contra "Session closed" / desconexión / puppeteer)
// ──────────────────────────────────────────────────────────────
const SAFE_SEND_MAX_RETRIES = parseInt(process.env.VICEBOT_SAFE_SEND_MAX_RETRIES || '2', 10);
const SAFE_SEND_BASE_DELAY_MS = parseInt(process.env.VICEBOT_SAFE_SEND_BASE_DELAY_MS || '350', 10);

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function isSessionClosedError(e) {
  const msg = String(e?.message || e || '').toLowerCase();

  // típicos de whatsapp-web.js / puppeteer / chromium
  return (
    msg.includes('session closed') ||
    msg.includes('protocol error') ||
    msg.includes('target closed') ||
    msg.includes('execution context was destroyed') ||
    msg.includes('most likely the page has been closed') ||
    msg.includes('cannot read properties of null') ||
    msg.includes('navigation failed') ||
    msg.includes('evaluation failed') ||
    msg.includes('socket hang up') ||
    msg.includes('ecconnreset') ||
    msg.includes('econnreset') ||
    msg.includes('epipe') ||
    msg.includes('detached frame') ||
    msg.includes('timeout') ||
    msg.includes('timed out')
  );
}

async function safeSendMessage(client, chatId, content, options = undefined) {
  const gid = String(chatId || '').trim();
  if (!gid) return { ok: false, error: 'EMPTY_CHAT_ID' };
  if (!client || typeof client.sendMessage !== 'function') return { ok: false, error: 'INVALID_CLIENT' };

  if (DRYRUN) {
    if (DEBUG) {
      console.log('[GROUPS DRYRUN] ->', gid, {
        hasOptions: !!options,
        preview: typeof content === 'string' ? content.slice(0, 250) : '[media]',
      });
    }
    return { ok: true, dryrun: true };
  }

  for (let attempt = 0; attempt <= SAFE_SEND_MAX_RETRIES; attempt++) {
    try {
      await client.sendMessage(gid, content, options);
      return { ok: true };
    } catch (e) {
      const msg = e?.message || String(e);
      const retryable = isSessionClosedError(e);

      if (DEBUG) {
        console.warn('[GROUPS] safeSendMessage failed', {
          gid,
          attempt: `${attempt + 1}/${SAFE_SEND_MAX_RETRIES + 1}`,
          retryable,
          msg,
        });
      }

      if (!retryable || attempt >= SAFE_SEND_MAX_RETRIES) {
        return { ok: false, error: msg };
      }

      const wait = SAFE_SEND_BASE_DELAY_MS * (attempt + 1);
      await sleep(wait);
    }
  }

  return { ok: false, error: 'UNKNOWN_SEND_FAIL' };
}

// ──────────────────────────────────────────────────────────────
// Users helpers
// ──────────────────────────────────────────────────────────────
function canonWaId(v) {
  const s = String(v || '').trim();
  if (!s) return '';
  if (/^\d{8,16}$/.test(s)) return `${s}@c.us`;
  return s;
}

function loadUsersMapCached() {
  const now = Date.now();
  if (_usersCache && (now - _usersCacheTs) < 60_000) return _usersCache;

  try {
    let raw = fs.readFileSync(USERS_PATH, 'utf8');
    raw = String(raw || '').replace(/^\uFEFF/, '');
    const json = JSON.parse(raw);
    _usersCache = (json && typeof json === 'object') ? json : {};
  } catch {
    _usersCache = {};
  }

  _usersCacheTs = now;
  return _usersCache;
}

// Devuelve: "Nombre (Cargo)" o fallback al waId
function resolveOriginDisplay(originWaLike) {
  const waId = canonWaId(originWaLike);
  if (!waId) return null;

  const users = loadUsersMapCached();
  const u = users[waId];

  if (!u) return waId;

  const nombre = (u.nombre || '').trim();
  const cargo = (u.cargo || '').trim();

  if (nombre && cargo) return `${nombre} (${cargo})`;
  if (nombre) return nombre;

  return waId;
}

// ──────────────────────────────────────────────────────────────
// Normalización de áreas (alias)
// ──────────────────────────────────────────────────────────────
function normalizeAreaKey(area) {
  const k = String(area || '').trim().toLowerCase();
  if (!k) return '';
  if (k === 'hskp') return 'ama';
  return k;
}

// ──────────────────────────────────────────────────────────────
// Carga / guardado catálogo
// ──────────────────────────────────────────────────────────────
let _groupsCache = null;

function invalidateGroupsCache() {
  _groupsCache = null;
}

function defaultGroupsConfig() {
  return { areas: { it: null, man: null, ama: null, rs: null, seg: null, exp: null } };
}

async function loadGroupsConfig(filePath = GROUPS_PATH) {
  if (_groupsCache) return _groupsCache;

  try {
    let raw = await fsp.readFile(filePath, 'utf8');
    raw = String(raw || '').replace(/^\uFEFF/, '');
    const parsed = JSON.parse(raw);

    if (!parsed || typeof parsed !== 'object') throw new Error('INVALID_CFG');
    if (!parsed.areas || typeof parsed.areas !== 'object') parsed.areas = {};

    const normalized = { areas: {} };
    for (const [k, v] of Object.entries(parsed.areas)) {
      const nk = normalizeAreaKey(k);
      if (!nk) continue;
      normalized.areas[nk] = v || null;
    }

    const def = defaultGroupsConfig();
    for (const k of Object.keys(def.areas)) {
      if (!(k in normalized.areas)) normalized.areas[k] = null;
    }

    _groupsCache = normalized;
    return _groupsCache;
  } catch (e) {
    if (DEBUG) console.warn('[GROUPS] no config o inválida, creando default:', { filePath, err: e?.message || e });
    _groupsCache = defaultGroupsConfig();
    await saveGroupsConfig(_groupsCache, filePath);
    return _groupsCache;
  }
}

async function saveGroupsConfig(cfg, filePath = GROUPS_PATH) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });

  const out = { areas: {} };
  const areas = (cfg && cfg.areas && typeof cfg.areas === 'object') ? cfg.areas : {};
  for (const [k, v] of Object.entries(areas)) {
    const nk = normalizeAreaKey(k);
    if (!nk) continue;
    out.areas[nk] = v || null;
  }

  const def = defaultGroupsConfig();
  for (const k of Object.keys(def.areas)) {
    if (!(k in out.areas)) out.areas[k] = null;
  }

  await fsp.writeFile(filePath, JSON.stringify(out, null, 2), 'utf8');
  if (DEBUG) console.log('[GROUPS] saved', { filePath });

  _groupsCache = out;
  return out;
}

// ──────────────────────────────────────────────────────────────
// Resolver area por groupId (grupoId → area)
// ──────────────────────────────────────────────────────────────
function getAreaByGroupId(groupId, cfg) {
  const gid = String(groupId || '').trim();
  if (!gid) return null;

  const map = (cfg && cfg.areas) || {};
  for (const [area, boundGid] of Object.entries(map)) {
    if (!boundGid) continue;
    if (String(boundGid).trim() === gid) return normalizeAreaKey(area);
  }
  return null;
}

function getBoundGroupIdByArea(areaCode, cfg) {
  const k = normalizeAreaKey(areaCode);
  if (!k) return null;
  const map = (cfg && cfg.areas) || {};
  return map[k] || null;
}

// ──────────────────────────────────────────────────────────────
// Resolver grupo(s) destino
// ──────────────────────────────────────────────────────────────
function resolveTargetGroups({ area_destino, areas = [] }, cfg) {
  const map = (cfg && cfg.areas) || {};
  const primaryKey = normalizeAreaKey(area_destino);
  const primary = map[primaryKey] || null;

  const ccIds = [];
  const unknownAreas = [];

  for (const a of (Array.isArray(areas) ? areas : [])) {
    const k = normalizeAreaKey(a);
    if (!k || k === primaryKey) continue;
    const gid = map[k] || null;
    if (gid) ccIds.push(gid);
    else unknownAreas.push(k);
  }

  return { primaryId: primary, ccIds, unknownAreas };
}

// ──────────────────────────────────────────────────────────────
// Formato del mensaje principal
// ──────────────────────────────────────────────────────────────
function looksLikeWaId(s = '') {
  const v = String(s || '').trim();
  return /@c\.us$/i.test(v) || /^\d{8,16}$/.test(v);
}

function formatIncidentMessage({ id, folio, descripcion, lugar, originName, originChatId }) {
  const header = folio ? `🆔 *${folio}*` : `🆔 *${id}*`;

  let prettyOrigin = null;

  if (originName && String(originName).trim()) {
    const raw = String(originName).trim();
    prettyOrigin = looksLikeWaId(raw) ? resolveOriginDisplay(raw) : raw;
  } else if (originChatId) {
    prettyOrigin = resolveOriginDisplay(originChatId);
  }

  const lines = [
    header,
    `• *Lugar:* ${lugar || '—'}`,
    `• *Descripción:* ${descripcion || '—'}`,
    prettyOrigin ? `• *Origen:* ${prettyOrigin}` : null,
  ].filter(Boolean);

  return lines.join('\n');
}

// Encabezado + descripción corta + comentario (Formato A)
function formatRequesterFollowup(incident, comment) {
  const folio = incident?.folio || `INC-${incident?.id?.slice(0, 6) || '????'}`;

  const rawDesc =
    (incident?.descripcion && String(incident.descripcion).trim()) ||
    (incident?.interpretacion && String(incident.interpretacion).trim()) ||
    'Actualización';

  const desc = rawDesc.length > 80 ? rawDesc.slice(0, 77) + '…' : rawDesc;

  const c = String(comment || '').trim() || '—';

  return `🆔 *${folio}* — ${desc}\n\n*ACTUALIZACIÓN DEL TICKET:*\n${c}`;
}

// ──────────────────────────────────────────────────────────────
// Enviar a grupos (NUEVOS tickets)
// ──────────────────────────────────────────────────────────────
async function sendIncidentToGroups(client, { message, primaryId, ccIds = [], media = null, additionalMedia = [] }) {
  const sent = [];
  const errors = [];

  if (!primaryId) return { sent, errors: ['NO_PRIMARY'] };

  // Helper para enviar a un grupo (mensaje principal + imágenes adicionales)
  const sendToGroup = async (gid, isCC = false) => {
    try {
      // 1) Enviar mensaje principal (con o sin primera imagen)
      if (media) {
        const res = await safeSendMessage(client, gid, media, { caption: message });
        if (!res.ok) {
          errors.push({ id: gid, error: res.error || 'SEND_FAIL' });
          return;
        }
      } else {
        const res = await safeSendMessage(client, gid, message);
        if (!res.ok) {
          errors.push({ id: gid, error: res.error || 'SEND_FAIL' });
          return;
        }
      }
      
      // 2) Enviar imágenes adicionales (sin caption)
      if (Array.isArray(additionalMedia) && additionalMedia.length > 0) {
        for (let i = 0; i < additionalMedia.length; i++) {
          await sleep(300);  // Anti-spam delay
          const addRes = await safeSendMessage(client, gid, additionalMedia[i]);
          if (!addRes.ok && DEBUG) {
            console.warn('[GROUPS] additional media failed', { gid, index: i, error: addRes.error });
          }
        }
      }
      
      sent.push({ id: gid, ...(isCC ? { cc: true } : {}) });
    } catch (e) {
      if (DEBUG) console.warn('[GROUPS] send failed', gid, e?.message || e);
      errors.push({ id: gid, error: e?.message || String(e) });
    }
  };

  // Enviar al grupo principal
  await sendToGroup(primaryId, false);

  // CC con delay anti-spam
  for (const gid of ccIds) {
    await sleep(250);
    await sendToGroup(gid, true);
  }

  return { sent, errors };
}

/**
 * Follow-ups hacia los grupos (comentarios, cambios de estado, etc.)
 */
async function sendFollowUpToGroups(client, { incident, message, media = [] }) {
  const cfg = await loadGroupsConfig();
  const areasFromJson = (() => {
    try { return JSON.parse(incident.areas_json || '[]'); } catch { return []; }
  })();

  const { primaryId, ccIds } = resolveTargetGroups(
    { area_destino: incident.area_destino, areas: areasFromJson },
    cfg
  );

  if (!primaryId && (!ccIds || !ccIds.length)) return { sent: [], errors: ['NO_TARGETS'] };

  const text = formatRequesterFollowup(incident, message);

  const sent = [];
  const errors = [];

  const sendTo = async (gid) => {
    try {
      if (media && Array.isArray(media) && media.length > 0) {
        // 1) primera media con caption
        const first = media[0];
        const r1 = await safeSendMessage(client, gid, first, { caption: text });
        if (!r1.ok) {
          errors.push({ id: gid, error: r1.error || 'SEND_FAIL' });
          if (DEBUG) console.warn('[GROUPS] follow-up send failed (first media)', gid, r1.error);
          return;
        }

        // 2) resto sin caption
        for (let i = 1; i < media.length; i++) {
          await sleep(200);
          const ri = await safeSendMessage(client, gid, media[i]);
          if (!ri.ok) {
            errors.push({ id: gid, error: ri.error || 'SEND_FAIL' });
            if (DEBUG) console.warn('[GROUPS] follow-up send failed (media)', gid, ri.error);
            // seguimos intentando las siguientes? mejor NO, para no spamear
            break;
          }
        }

        sent.push({ id: gid, ...(r1.dryrun ? { dryrun: true } : {}) });
      } else {
        const r = await safeSendMessage(client, gid, text);
        if (r.ok) sent.push({ id: gid, ...(r.dryrun ? { dryrun: true } : {}) });
        else errors.push({ id: gid, error: r.error || 'SEND_FAIL' });
      }
    } catch (e) {
      errors.push({ id: gid, error: e?.message || String(e) });
      if (DEBUG) console.warn('[GROUPS] follow-up send failed', gid, e?.message || e);
    }
  };

  if (primaryId) await sendTo(primaryId);

  for (const gid of ccIds || []) {
    await sleep(250);
    await sendTo(gid);
  }

  return { sent, errors };
}

// ──────────────────────────────────────────────────────────────
// Utilidades admin
// ──────────────────────────────────────────────────────────────
function isAdmin(chatId) {
  const admins = (process.env.ADMINS || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!admins.length) return true;
  const num = String(chatId).split('@')[0];
  return admins.includes(num);
}

async function listAllGroups(client) {
  const chats = await client.getChats();
  const groups = chats.filter(c => c.isGroup);
  return groups.map(g => ({ name: g.name, id: g.id?._serialized || g.id || '' }));
}

async function bindGroup(area, groupId, filePath = GROUPS_PATH) {
  const cfg = await loadGroupsConfig(filePath);
  const k = normalizeAreaKey(area);
  if (!k) throw new Error('AREA_INVALID');

  if (!cfg.areas) cfg.areas = {};
  cfg.areas[k] = groupId;

  const saved = await saveGroupsConfig(cfg, filePath);

  invalidateGroupsCache();

  return saved;
}

module.exports = {
  loadGroupsConfig,
  saveGroupsConfig,
  resolveTargetGroups,
  sendIncidentToGroups,
  formatIncidentMessage,
  sendFollowUpToGroups,
  isAdmin,
  listAllGroups,
  bindGroup,

  // ✅ EXPORTS
  getAreaByGroupId,
  getBoundGroupIdByArea,
  normalizeAreaKey,
  invalidateGroupsCache,

  // ✅ (opcional) export para debugging
  safeSendMessage,
};
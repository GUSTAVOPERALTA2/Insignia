// modules/core/adminCommandRouter.js
// Router ÚNICO de comandos "slash" ("/...") para Vicebot.
// Se llama desde index.js ANTES del coreMessageRouter.
//
// 🔧 CAMBIOS (según tu decisión):
// ✅ ACL SOLO en DM (users.json o ADMINS bootstrap).
// ✅ En GRUPOS NO se aplica ACL para comandos de usuario.
// ✅ Comandos ADMIN se BLOQUEAN en GRUPOS.
// ✅ /tickets en GRUPOS filtra por el @g.us del grupo → área (data/groups.json).
// ✅ /tickets en DM sigue siendo personal por actorCanon.
// ✅ /who y /export SOLO en DM (evita exponer datos en grupos).
//
// ✅ EXTRA (lo que pediste):
// - Si en GRUPO intentan consultar otra área con "/tickets <area> ...", se avisa:
//   "📩 Para ver tickets por área manda DM directo"
//   y se sigue mostrando el listado del área REAL del grupo (no la solicitada).

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { MessageMedia } = require('whatsapp-web.js');
const moment = require('moment-timezone');

const incidenceDB = require('../db/incidenceDB');
const {
  listAllGroups,
  bindGroup,
  loadGroupsConfig,
  getAreaByGroupId,
  normalizeAreaKey,
} = require('../groups/groupRouter');

const { exportXLSX } = require('../reports/exportXLSX');

const DEBUG = (process.env.VICEBOT_DEBUG || '1') === '1';
const HTTP_PORT = Number(process.env.VICEBOT_HTTP_PORT || 3030);

let USERS_CACHE = null;
let USERS_CACHE_AT = 0;
const USERS_CACHE_TTL_MS = Number(process.env.VICEBOT_USERS_CACHE_TTL_MS || 15000);

const PUBLIC_BASE_URL =
  process.env.VICEBOT_PUBLIC_BASE_URL || `http://localhost:${HTTP_PORT}`;

const USERS_PATH =
  process.env.VICEBOT_USERS_PATH || path.join(process.cwd(), 'data', 'users.json');
console.log('[BOOT] USERS_PATH =', USERS_PATH);

const DB_PATH =
  process.env.VICEBOT_DB_PATH || path.join(process.cwd(), 'data', 'vicebot.sqlite');

const JSONL_PATH =
  process.env.VICEBOT_JSONL_FALLBACK || path.join(process.cwd(), 'data', 'incidents.jsonl');

const PAGE_SIZE = parseInt(process.env.VICEBOT_TICKETS_PAGE_SIZE || '10', 10);

// ──────────────────────────────────────────────────────────────
// Helpers básicos
// ──────────────────────────────────────────────────────────────
function isGroupId(id) {
  return /@g\.us$/.test(String(id || ''));
}
function isDM(msg) {
  return !isGroupId(msg?.from || '');
}
function isCUs(id) {
  return /@c\.us$/.test(String(id || ''));
}
function isLid(id) {
  return /@lid$/.test(String(id || ''));
}
function extractDigits(anyId) {
  const s = String(anyId || '').trim();
  if (!s) return '';
  const base = s.split('@')[0] || '';
  const digits = base.replace(/[^\d]/g, '');
  return digits || '';
}

// Cache simple de resolución lid->c.us
const LID_RESOLVE_CACHE = new Map(); // key: lid, val: { canon, at }
const LID_RESOLVE_TTL_MS = Number(process.env.VICEBOT_LID_RESOLVE_TTL_MS || 60_000);

/**
 * Actor RAW:
 * - Grupo: msg.id.participant / msg._data.participant / msg.author (a veces lid)
 * - DM: msg.from
 */
function getActorIdRaw(msg) {
  const p1 = msg?.id?.participant;
  const p2 = msg?._data?.participant;
  const a = msg?.author;
  const f = msg?.from;
  return String(p1 || p2 || a || f || '').trim();
}

/**
 * Resuelve actor a ID utilizable para ACL/tickets:
 * - Si viene @c.us → igual
 * - Si viene @lid → intenta resolver contacto y regresar 52XXXXXXXXXX@c.us
 * - Si falla → regresa raw (para log)
 */
async function resolveActorCanon(client, msg) {
  const raw = getActorIdRaw(msg);
  if (!raw) return { raw: '', canon: '' };

  if (isCUs(raw)) return { raw, canon: raw };

  if (!isLid(raw)) {
    const digits = extractDigits(raw);
    return { raw, canon: digits ? `${digits}@c.us` : raw };
  }

  const now = Date.now();
  const cached = LID_RESOLVE_CACHE.get(raw);
  if (cached && (now - cached.at) < LID_RESOLVE_TTL_MS) {
    return { raw, canon: cached.canon };
  }

  try {
    const pid = msg?.id?.participant || msg?._data?.participant || msg?.author || raw;

    let contact = null;

    if (client && typeof client.getContactById === 'function' && pid) {
      try { contact = await client.getContactById(pid); } catch {}
    }
    if (!contact && msg && typeof msg.getContact === 'function') {
      try { contact = await msg.getContact(); } catch {}
    }

    const cId = contact?.id?._serialized;
    if (cId && isCUs(cId)) {
      LID_RESOLVE_CACHE.set(raw, { canon: cId, at: now });
      return { raw, canon: cId };
    }

    const number = String(contact?.number || '').trim();
    if (number && /^\d+$/.test(number)) {
      const canon = `${number}@c.us`;
      LID_RESOLVE_CACHE.set(raw, { canon, at: now });
      return { raw, canon };
    }

    const user = contact?.id?.user;
    if (user && /^\d+$/.test(String(user))) {
      const canon = `${String(user)}@c.us`;
      LID_RESOLVE_CACHE.set(raw, { canon, at: now });
      return { raw, canon };
    }

    LID_RESOLVE_CACHE.set(raw, { canon: raw, at: now });
    return { raw, canon: raw };
  } catch (e) {
    if (DEBUG) console.warn('[ADMIN-CMD] resolveActorCanon error', e?.message || e);
    LID_RESOLVE_CACHE.set(raw, { canon: raw, at: Date.now() });
    return { raw, canon: raw };
  }
}

function parseCommand(msg) {
  const body = String(msg?.body || '').trim();
  if (!body.startsWith('/')) return null;

  const withoutSlash = body.slice(1).trim();
  if (!withoutSlash) return null;

  const [rawCmd, ...rest] = withoutSlash.split(/\s+/);
  const name = String(rawCmd || '').toLowerCase();
  const args = rest.join(' ').trim();

  return { from: msg.from, name, args, raw: body };
}

function normalizeId(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  if (/@(c|g)\.us$/.test(s)) return s;

  const digits = s.replace(/[^\d]/g, '');
  if (!digits) return s;

  return `${digits}@c.us`;
}

// ──────────────────────────────────────────────────────────────
// Users.json (ACL - solo DM)
// ──────────────────────────────────────────────────────────────
async function ensureUsersFile() {
  await fsp.mkdir(path.dirname(USERS_PATH), { recursive: true });
  if (!fs.existsSync(USERS_PATH)) {
    await fsp.writeFile(USERS_PATH, JSON.stringify({}, null, 2), 'utf8');
  }
}

async function loadUsers({ force = false } = {}) {
  const now = Date.now();
  if (!force && USERS_CACHE && (now - USERS_CACHE_AT) < USERS_CACHE_TTL_MS) {
    return USERS_CACHE;
  }

  await ensureUsersFile();
  try {
    let raw = await fsp.readFile(USERS_PATH, 'utf8');
    raw = raw.replace(/^\uFEFF/, '');

    const obj = JSON.parse(raw || '{}');
    const normalized = {};

    if (obj && typeof obj === 'object') {
      for (const [k, v] of Object.entries(obj)) {
        normalized[String(k).trim()] = v;
      }
    }

    USERS_CACHE = normalized;
    USERS_CACHE_AT = now;

    if (DEBUG && process.env.VICEBOT_DEBUG_USERS === '1') {
      const sample = Object.keys(normalized).slice(0, 5);
      console.log('[ADMIN-CMD] users loaded', {
        USERS_PATH,
        keys: Object.keys(normalized).length,
        sampleKeys: sample,
      });
    }

    return normalized;
  } catch (e) {
    if (DEBUG) {
      console.warn('[ADMIN-CMD] users.json read/parse error', {
        USERS_PATH,
        error: e?.message || String(e),
      });
    }
    USERS_CACHE = {};
    USERS_CACHE_AT = now;
    return {};
  }
}

async function saveUsers(usersObj) {
  await ensureUsersFile();
  await fsp.writeFile(USERS_PATH, JSON.stringify(usersObj || {}, null, 2), 'utf8');
  return true;
}

// Bootstrap admins: se comparan por dígitos
function isBootstrapAdmin(anyId) {
  const admins = (process.env.ADMINS || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!admins.length) return false;

  const digits = extractDigits(anyId);
  return digits ? admins.includes(digits) : false;
}

async function isRegisteredUser(canonId) {
  const id = String(canonId || '').trim();
  if (!id) return false;
  const users = await loadUsers();
  return !!users[id];
}

async function hasAccess(canonId) {
  if (isBootstrapAdmin(canonId)) return true;
  return await isRegisteredUser(canonId);
}

async function replyAccessDenied(msg) {
  await msg.reply(
    '🚫 No tienes acceso a *Vicebot* todavía.\n\n' +
    'Para darte de alta, contacta a un *administrador* (IT/Connect).\n' +
    'Cuando estés registrado podrás usar comandos y reportar incidencias.'
  );
}

async function isAdminUser(canonId) {
  const id = String(canonId || '').trim();
  if (!id) return false;

  const users = await loadUsers();
  const u = users[id];
  if (u && String(u.rol || '').toLowerCase() === 'admin') return true;

  return isBootstrapAdmin(id);
}

async function getUserRecord(canonId) {
  const users = await loadUsers();
  return users[String(canonId || '').trim()] || null;
}

// ──────────────────────────────────────────────────────────────
// /export  (DM only)
// ──────────────────────────────────────────────────────────────
async function handleExport(client, msg, args) {
  const TZ = process.env.VICEBOT_TZ || 'America/Mexico_City';

  const bodyArgs = String(args || '').trim();
  const parts = bodyArgs ? bodyArgs.split(/\s+/) : [];

  let startDate = null;
  let endDate = null;
  let idx = 0;

  if (parts[0] && parts[0].toLowerCase() === 'hoy') {
    const hoy = moment().tz(TZ).format('YYYY-MM-DD');
    startDate = hoy;
    endDate = hoy;
    idx = 1;
  } else if (
    parts[0] && /^\d{4}-\d{2}-\d{2}$/.test(parts[0]) &&
    parts[1] && /^\d{4}-\d{2}-\d{2}$/.test(parts[1])
  ) {
    startDate = parts[0];
    endDate = parts[1];
    idx = 2;
  }

  const validAreas = new Set(['it', 'man', 'ama', 'rs', 'seg', 'exp']);

  // ✅ actualizado: incluye awaiting_confirmation y aliases UX
  const statusMap = {
    pendiente: 'open',
    pendientes: 'open',
    abierta: 'open',
    abiertas: 'open',

    en_proceso: 'in_progress',
    proceso: 'in_progress',
    in_progress: 'in_progress',

    completada: 'done',
    completadas: 'done',
    finalizada: 'done',
    finalizadas: 'done',
    done: 'done',
    closed: 'closed',

    cancelada: 'canceled',
    canceladas: 'canceled',
    canceled: 'canceled',
    cancelled: 'canceled',

    por_confirmar: 'awaiting_confirmation',
    porconfirmar: 'awaiting_confirmation',
    confirmar: 'awaiting_confirmation',
    revision: 'awaiting_confirmation',
    revisar: 'awaiting_confirmation',
    awaiting_confirmation: 'awaiting_confirmation',
  };

  const areas = [];
  const statuses = [];

  for (let i = idx; i < parts.length; i++) {
    const p = parts[i].toLowerCase();
    if (validAreas.has(p)) areas.push(p);
    else if (statusMap[p]) statuses.push(statusMap[p]);
  }

  const uniq = (arr) => [...new Set(arr)];

  await msg.reply(
    `📄 Generando reporte XLSX...\n` +
    `• Fechas: ${startDate && endDate ? `${startDate} a ${endDate}` : 'GLOBAL'}\n` +
    `• Áreas: ${areas.length ? uniq(areas).join(', ') : 'TODAS'}\n` +
    `• Estados: ${statuses.length ? uniq(statuses).join(', ') : 'TODOS'}`
  );

  try {
    const outputPath = await exportXLSX({
      startDate,
      endDate,
      areas: uniq(areas),
      statuses: uniq(statuses),
      tz: TZ,
    });

    const data = fs.readFileSync(outputPath, 'base64');
    const media = new MessageMedia(
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      data,
      path.basename(outputPath)
    );

    await client.sendMessage(msg.from, media);
    await msg.reply(`✅ Reporte enviado: *${path.basename(outputPath)}*`);
    return true;
  } catch (err) {
    console.error('[CMD]/export error:', err);
    await msg.reply(`❌ Error al generar el reporte: ${err?.message || err}`);
    return true;
  }
}

// ──────────────────────────────────────────────────────────────
// /who (DM only)
// ──────────────────────────────────────────────────────────────
function formatWhoCard(chatId, userRecord) {
  const id = String(chatId || '—');

  const nombre = userRecord?.nombre || '—';
  const cargo = userRecord?.cargo || '—';
  const rol = String(userRecord?.rol || 'user').toLowerCase();
  const team = userRecord?.team || '—';

  const lines = [];
  lines.push(`👤 *WHO*`);
  lines.push('');
  lines.push(`• *ID:* \`${id}\``);
  lines.push(`• *Nombre:* ${nombre}`);
  lines.push(`• *Cargo:* ${cargo}`);
  lines.push(`• *Rol:* ${rol}`);
  lines.push(`• *Team:* ${team}`);

  return lines.join('\n');
}

async function handleWho(msg, args, isAdmin, actorCanon) {
  const fromId = String(actorCanon || msg.from || '').trim();
  const raw = String(args || '').trim();

  if (!raw) {
    const rec = await getUserRecord(fromId);
    const text = formatWhoCard(fromId, rec);
    await msg.reply(text);
    return true;
  }

  if (!isAdmin) {
    await msg.reply('⚠️ Solo administradores pueden usar `/who <id>`.\nUsa `/who` para ver tu propia info.');
    return true;
  }

  const targetId = normalizeId(raw);
  const rec = await getUserRecord(targetId);
  const text = formatWhoCard(targetId, rec);
  await msg.reply(text);
  return true;
}

// ──────────────────────────────────────────────────────────────
// /tickets
// ──────────────────────────────────────────────────────────────
function formatDateTime(isoString) {
  if (!isoString) return '—';
  const d = new Date(isoString);
  if (Number.isNaN(d.getTime())) return String(isoString);

  return d.toLocaleString('es-MX', {
    timeZone: process.env.VICEBOT_TZ || 'America/Mexico_City',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatStatus(statusRaw) {
  const s = String(statusRaw || 'open').toLowerCase();
  if (s === 'open') return { emoji: '🟢', label: 'Abierto' };
  if (s === 'in_progress') return { emoji: '🟡', label: 'En proceso' };
  if (s === 'awaiting_confirmation') return { emoji: '🟣', label: 'Por confirmar' };
  if (s === 'done' || s === 'closed') return { emoji: '✅', label: 'Completado' };
  if (s === 'canceled' || s === 'cancelled') return { emoji: '⛔', label: 'Cancelado' };
  return { emoji: '⚪', label: s || 'desconocido' };
}

function formatTicketList(items, { page, pageSize, label }) {
  if (!items.length) {
    return (
      `No encontré tickets para ese filtro.\n\n` +
      `Prueba con:\n` +
      `• */tickets abiertas*\n` +
      `• */tickets cerradas*\n` +
      `• */tickets por_confirmar*\n` +
      `• */tickets buscar cocina*`
    );
  }

  const lines = [];
  lines.push(`📋 *${label}* (página ${page})`);
  lines.push('');

  const startIndex = (page - 1) * pageSize;

  items.forEach((t, idx) => {
    const n = startIndex + idx + 1;
    const folio = t.folio || (t.id ? String(t.id).slice(0, 8) : 'SIN-FOLIO');
    const st = formatStatus(t.status);
    const lugar = (t.lugar || '').trim() || '(sin lugar)';
    const baseDesc = (t.descripcion || t.interpretacion || '').trim() || '(sin descripción)';
    const desc = baseDesc.length > 80 ? baseDesc.slice(0, 77) + '…' : baseDesc;

    lines.push(`${n}) *${folio}* ${st.emoji} _${st.label}_`);
    lines.push(`    ${lugar} — ${desc}`);
  });

  lines.push('');
  lines.push('Sigue explorando con:');
  lines.push(`• */tickets ${page + 1}* para ver más`);
  lines.push('• */tickets abiertas* / */tickets cerradas* / */tickets por_confirmar*');
  lines.push('• */tickets detalle FOLIO* para ver uno a detalle');

  return lines.join('\n');
}

function formatTicketDetail(inc) {
  if (!inc) return 'No encontré ese ticket. Revisa el folio o intenta con */tickets*.';

  const folio = inc.folio || inc.id || 'Ticket';
  const st = formatStatus(inc.status);

  const lines = [];
  lines.push(`*${folio}* ${st.emoji} _${st.label}_`);
  lines.push('');

  if (inc.lugar) lines.push(`📍 *Lugar:* ${inc.lugar}`);
  if (inc.area_destino) lines.push(`🏷️ *Área:* ${inc.area_destino}`);

  const descTxt = (inc.descripcion || inc.interpretacion || '').trim();
  if (descTxt) {
    lines.push('');
    lines.push('📝 *Descripción:*');
    lines.push(descTxt);
  }

  if (inc.created_at) {
    lines.push('');
    lines.push(`🕒 *Creado:* ${formatDateTime(inc.created_at)}`);
  }
  if (inc.updated_at && inc.updated_at !== inc.created_at) {
    lines.push(`♻️ *Última actualización:* ${formatDateTime(inc.updated_at)}`);
  }

  return lines.join('\n');
}

// ✅ NUEVO: “footer” para mostrar “Por confirmar” al final cuando el usuario vea cerradas/completadas
function formatAwaitingFooter(items, { limit = 5 } = {}) {
  const list = Array.isArray(items) ? items.slice(0, limit) : [];
  if (!list.length) return '';

  const lines = [];
  lines.push('');
  lines.push('🟣 *POR CONFIRMAR*');
  lines.push('_(tickets que requieren revisión/confirmación del solicitante)_');
  lines.push('');

  list.forEach((t, idx) => {
    const n = idx + 1;
    const folio = t.folio || (t.id ? String(t.id).slice(0, 8) : 'SIN-FOLIO');
    const st = formatStatus(t.status);
    const lugar = (t.lugar || '').trim() || '(sin lugar)';
    const baseDesc = (t.descripcion || t.interpretacion || '').trim() || '(sin descripción)';
    const desc = baseDesc.length > 80 ? baseDesc.slice(0, 77) + '…' : baseDesc;
    lines.push(`${n}) *${folio}* ${st.emoji} _${st.label}_`);
    lines.push(`    ${lugar} — ${desc}`);
  });

  lines.push('');
  lines.push('Para ver solo estos:');
  lines.push('• */tickets por_confirmar*');
  return lines.join('\n');
}

// DM: tus tickets (por chatId = actorCanon) O por área si mandas /tickets <area>
async function handleTicketsCommandDM(client, msg, { chatId, args }) {
  const rawArgs = String(args || '').trim();

  // 1) detalle (siempre permite, sea de quien sea)
  const mDet = rawArgs.match(/^detalle\s+(\S+)/i);
  if (mDet) {
    const folio = mDet[1];
    if (DEBUG) console.log('[CMD]/tickets detalle (DM)', { chatId, folio });

    const inc = await incidenceDB.getIncidentByFolio(folio);
    const txt = formatTicketDetail(inc);
    await msg.reply(txt);
    return true;
  }

  // 2) buscar (puede ser por chat o por área)
  const mSearch = rawArgs.match(/^buscar\s+(.+)/i);
  if (mSearch && !/^\w+\s+buscar\s+/i.test(rawArgs)) {
    const query = mSearch[1].trim().toLowerCase();
    if (!query) {
      await msg.reply('Escribe algo para buscar. Ejemplo:\n*/tickets buscar cocina*');
      return true;
    }

    if (DEBUG) console.log('[CMD]/tickets buscar (DM)', { chatId, query });

    const all = await incidenceDB.listIncidentsForChat(chatId, { limit: 200, statusFilter: null });
    const filtered = (all || []).filter((t) => {
      const folio = String(t.folio || '').toLowerCase();
      const lugar = String(t.lugar || '').toLowerCase();
      const desc = String(t.descripcion || t.interpretacion || '').toLowerCase();
      return folio.includes(query) || lugar.includes(query) || desc.includes(query);
    });

    const page = 1;
    const pageSize = Math.min(PAGE_SIZE, 10);
    const pageItems = filtered.slice(0, pageSize);

    const label = `Resultados para "${query}"`;
    const txt = formatTicketList(pageItems, { page, pageSize, label });
    await msg.reply('🔎 ' + txt);
    return true;
  }

  // ──────────────────────────────────────────────────────────────
  // Parser tipo /export: áreas + estados + página + buscar (en cualquier orden)
  // ──────────────────────────────────────────────────────────────

  const parts = rawArgs ? rawArgs.split(/\s+/).filter(Boolean) : [];

  const idxBuscar = parts.findIndex(p => String(p).toLowerCase() === 'buscar');
  let buscarQuery = '';
  let partsNoBuscar = parts;

  if (idxBuscar >= 0) {
    buscarQuery = parts.slice(idxBuscar + 1).join(' ').trim().toLowerCase();
    partsNoBuscar = parts.slice(0, idxBuscar);
  }

  const validAreas = new Set(['it', 'man', 'ama', 'rs', 'seg', 'hskp', 'exp']);

  const statusMap = {
    abiertas: ['open', 'in_progress'],
    abiertos: ['open', 'in_progress'],
    pendientes: ['open', 'in_progress'],
    activos: ['open', 'in_progress'],

    completadas: ['done'],
    completados: ['done'],
    finalizadas: ['done'],
    finalizados: ['done'],

    cerradas: ['done', 'canceled'],
    cerrados: ['done', 'canceled'],

    canceladas: ['canceled'],
    cancelados: ['canceled'],

    por_confirmar: ['awaiting_confirmation'],
    porconfirmar: ['awaiting_confirmation'],
    confirmar: ['awaiting_confirmation'],
    revision: ['awaiting_confirmation'],
    revisar: ['awaiting_confirmation'],
    pendientes_confirmacion: ['awaiting_confirmation'],

    open: ['open'],
    in_progress: ['in_progress'],
    done: ['done'],
    canceled: ['canceled'],
    cancelled: ['canceled'],
    awaiting_confirmation: ['awaiting_confirmation'],
  };

  let page = 1;

  if (partsNoBuscar.length && /^\d+$/.test(partsNoBuscar[partsNoBuscar.length - 1])) {
    page = Math.max(1, parseInt(partsNoBuscar.pop(), 10));
  }

  const areas = [];
  let statusFilter = null;
  let askedClosedOrCompleted = false;

  for (const token of partsNoBuscar) {
    const t = String(token).toLowerCase();

    if (validAreas.has(t)) {
      areas.push(t);
      continue;
    }

    if (t === 'cerradas' || t === 'cerrados' || t === 'completadas' || t === 'completados' || t === 'finalizadas' || t === 'finalizados') {
      askedClosedOrCompleted = true;
    }

    if (statusMap[t]) {
      const add = statusMap[t];
      const base = Array.isArray(statusFilter) ? statusFilter : [];
      statusFilter = [...new Set([...base, ...add])];
      continue;
    }
  }

  const uniq = (arr) => [...new Set(arr)];
  const areasUniq = uniq(areas);

  const pageSize = PAGE_SIZE;
  const limit = page * pageSize;

  // ──────────────────────────────────────────────────────────────
  // MODO A) Si pidieron área en DM → listar por área (global)
  // ──────────────────────────────────────────────────────────────
  if (areasUniq.length) {
    const area = areasUniq[0];
    let label = `Tickets de ${area.toUpperCase()}`;

    if (idxBuscar >= 0) {
      if (!buscarQuery) {
        await msg.reply('Escribe algo para buscar. Ejemplo:\n*/tickets man buscar casero*');
        return true;
      }

      const pack = await incidenceDB.listIncidents({
        area,
        page: 1,
        limit: 200,
        sort: 'created_at:desc'
      });

      const items = (pack?.items || []).map(it => ({
        id: it.id,
        folio: it.folio || null,
        status: String(it.estado || 'open').toLowerCase(),
        lugar: it.lugar || null,
        descripcion: it.descripcion || null,
        interpretacion: null,
        created_at: it.created_at || null,
        updated_at: it.updated_at || null,
      }));

      const filtered = items.filter(t => {
        const folio = String(t.folio || '').toLowerCase();
        const lugar = String(t.lugar || '').toLowerCase();
        const desc = String(t.descripcion || '').toLowerCase();
        return folio.includes(buscarQuery) || lugar.includes(buscarQuery) || desc.includes(buscarQuery);
      });

      const pageItems = filtered.slice(0, Math.min(pageSize, 10));
      label = `Tickets de ${area.toUpperCase()} — resultados "${buscarQuery}"`;

      const txt = formatTicketList(pageItems, { page: 1, pageSize: Math.min(pageSize, 10), label });
      await msg.reply('🔎 ' + txt);
      return true;
    }

    if (Array.isArray(statusFilter) && statusFilter.length) {
      const openSet = new Set(['open', 'in_progress']);
      const onlyOpen = statusFilter.every(s => openSet.has(String(s)));

      if (onlyOpen) {
        label = `Tickets ABIERTOS de ${area.toUpperCase()}`;
        const rows = incidenceDB.listOpenIncidentsByArea(area, { limit });

        const items = (rows || []).map(r => ({
          id: r.id,
          folio: r.folio || null,
          status: String(r.status || 'open').toLowerCase(),
          lugar: r.lugar || null,
          descripcion: r.descripcion || null,
          interpretacion: r.interpretacion || null,
          created_at: r.created_at || null,
          updated_at: r.updated_at || null,
        }));

        const start = (page - 1) * pageSize;
        const pageItems = items.slice(start, start + pageSize);

        const txt = formatTicketList(pageItems, { page, pageSize, label });
        await msg.reply(txt);
        return true;
      }

      const pack = await incidenceDB.listIncidents({
        area,
        page: 1,
        limit: limit * 3,
        sort: 'created_at:desc'
      });

      const all = (pack?.items || []).map(it => ({
        id: it.id,
        folio: it.folio || null,
        status: String(it.estado || 'open').toLowerCase(),
        lugar: it.lugar || null,
        descripcion: it.descripcion || null,
        interpretacion: null,
        created_at: it.created_at || null,
        updated_at: it.updated_at || null,
      }));

      const wanted = new Set(statusFilter.map(s => String(s).toLowerCase()));
      const filtered = all.filter(x => wanted.has(String(x.status || '').toLowerCase()));

      const start = (page - 1) * pageSize;
      const pageItems = filtered.slice(start, start + pageSize);

      if (statusFilter.length === 1 && statusFilter[0] === 'awaiting_confirmation') {
        label = `Tickets POR CONFIRMAR de ${area.toUpperCase()}`;
      } else if (statusFilter.length === 1 && statusFilter[0] === 'canceled') {
        label = `Tickets CANCELADOS de ${area.toUpperCase()}`;
      } else if (statusFilter.length === 1 && statusFilter[0] === 'done') {
        label = `Tickets COMPLETADOS de ${area.toUpperCase()}`;
      } else {
        const closedSet = new Set(['done', 'canceled']);
        const onlyClosed = statusFilter.every(s => closedSet.has(String(s)));
        if (onlyClosed) label = `Tickets CERRADOS de ${area.toUpperCase()}`;
      }

      let txt = formatTicketList(pageItems, { page, pageSize, label });

      if (askedClosedOrCompleted && statusFilter.some(s => s === 'done' || s === 'canceled')) {
        const pack2 = await incidenceDB.listIncidents({
          area,
          page: 1,
          limit: 120,
          sort: 'created_at:desc'
        });
        const all2 = (pack2?.items || []).map(it => ({
          id: it.id,
          folio: it.folio || null,
          status: String(it.estado || 'open').toLowerCase(),
          lugar: it.lugar || null,
          descripcion: it.descripcion || null,
          interpretacion: null,
          created_at: it.created_at || null,
          updated_at: it.updated_at || null,
        }));
        const awaiting = all2.filter(x => String(x.status || '').toLowerCase() === 'awaiting_confirmation');
        txt += formatAwaitingFooter(awaiting, { limit: 5 });
      }

      await msg.reply(txt);
      return true;
    }

    const pack = await incidenceDB.listIncidents({
      area,
      page: 1,
      limit,
      sort: 'created_at:desc'
    });

    const items = (pack?.items || []).map(it => ({
      id: it.id,
      folio: it.folio || null,
      status: String(it.estado || 'open').toLowerCase(),
      lugar: it.lugar || null,
      descripcion: it.descripcion || null,
      interpretacion: null,
      created_at: it.created_at || null,
      updated_at: it.updated_at || null,
    }));

    const start = (page - 1) * pageSize;
    const pageItems = items.slice(start, start + pageSize);

    const txt = formatTicketList(pageItems, { page, pageSize, label });
    await msg.reply(txt);
    return true;
  }

  // ──────────────────────────────────────────────────────────────
  // MODO B) Sin área → “mis tickets”
  // ──────────────────────────────────────────────────────────────

  if (idxBuscar >= 0) {
    if (!buscarQuery) {
      await msg.reply('Escribe algo para buscar. Ejemplo:\n*/tickets buscar cocina*');
      return true;
    }

    const all = await incidenceDB.listIncidentsForChat(chatId, { limit: 200, statusFilter: null });
    const filtered = (all || []).filter((t) => {
      const folio = String(t.folio || '').toLowerCase();
      const lugar = String(t.lugar || '').toLowerCase();
      const desc = String(t.descripcion || t.interpretacion || '').toLowerCase();
      return folio.includes(buscarQuery) || lugar.includes(buscarQuery) || desc.includes(buscarQuery);
    });

    const pageItems = filtered.slice(0, Math.min(pageSize, 10));
    const label = `Resultados para "${buscarQuery}"`;

    const txt = formatTicketList(pageItems, { page: 1, pageSize: Math.min(pageSize, 10), label });
    await msg.reply('🔎 ' + txt);
    return true;
  }

  let label = 'Tus tickets recientes';

  if (Array.isArray(statusFilter) && statusFilter.length) {
    const openSet = new Set(['open', 'in_progress']);
    const closedSet = new Set(['done', 'canceled']);
    const onlyOpen = statusFilter.every(s => openSet.has(String(s)));
    const onlyClosed = statusFilter.every(s => closedSet.has(String(s)));

    if (statusFilter.length === 1 && statusFilter[0] === 'awaiting_confirmation') {
      label = 'Tus tickets por confirmar';
    } else if (onlyOpen) {
      label = 'Tus tickets abiertos / en proceso';
    } else if (onlyClosed) {
      label = 'Tus tickets cerrados';
    } else {
      label = 'Tus tickets filtrados';
    }
  }

  const all = await incidenceDB.listIncidentsForChat(chatId, { limit, statusFilter: statusFilter || null });
  const start = (page - 1) * pageSize;
  const pageItems = (all || []).slice(start, start + pageSize);

  let txt = formatTicketList(pageItems, { page, pageSize, label });

  if (askedClosedOrCompleted && Array.isArray(statusFilter) && statusFilter.some(s => s === 'done' || s === 'canceled')) {
    const awaiting = await incidenceDB.listIncidentsForChat(chatId, { limit: 80, statusFilter: ['awaiting_confirmation'] });
    txt += formatAwaitingFooter(awaiting || [], { limit: 5 });
  }

  await msg.reply(txt);
  return true;
}

// GRUPO: tickets del área vinculada al grupoId (@g.us)
async function handleTicketsCommandGroup(client, msg, { groupId, args }) {
  const rawArgsOriginal = String(args || '').trim();

  const cfg = await loadGroupsConfig();
  const areaRaw = getAreaByGroupId(groupId, cfg);
  const area = normalizeAreaKey(areaRaw);

  if (!area) {
    await msg.reply(
      '⚠️ Este grupo no está vinculado a ninguna área.\n' +
      'Un admin puede vincularlo desde DM con:\n' +
      '`/bind <area> <groupId>`\n' +
      'Ej: `/bind man 1203630xxxx@g.us`'
    );
    return true;
  }

  let rawArgs = rawArgsOriginal;
  let notice = '';

  if (rawArgsOriginal) {
    const parts0 = rawArgsOriginal.split(/\s+/).filter(Boolean);
    const maybeAreaToken = parts0[0] || '';
    const requestedArea = normalizeAreaKey(maybeAreaToken);

    if (requestedArea && requestedArea !== area) {
      notice =
        '📩 Para ver tickets de *otra área*, manda *DM directo* a Vicebot.\n' +
        `En este grupo solo se muestran tickets del área *${area.toUpperCase()}*.`;
      rawArgs = parts0.slice(1).join(' ').trim();
    } else if (requestedArea && requestedArea === area) {
      rawArgs = parts0.slice(1).join(' ').trim();
    }
  }

  const mDet = rawArgs.match(/^detalle\s+(\S+)/i);
  if (mDet) {
    const folio = mDet[1];
    if (DEBUG) console.log('[CMD]/tickets detalle (GRUPO)', { groupId, area, folio });

    const inc = await incidenceDB.getIncidentByFolio(folio);
    if (!inc) {
      const msgTxt = 'No encontré ese ticket. Revisa el folio o intenta con */tickets*.';
      await msg.reply(notice ? `${notice}\n\n${msgTxt}` : msgTxt);
      return true;
    }
    if (String(inc.area_destino || '').toLowerCase() !== String(area).toLowerCase()) {
      const msgTxt = '⚠️ Ese ticket no pertenece al área de este grupo.';
      await msg.reply(notice ? `${notice}\n\n${msgTxt}` : msgTxt);
      return true;
    }

    const txt = formatTicketDetail(inc);
    await msg.reply(notice ? `${notice}\n\n${txt}` : txt);
    return true;
  }

  const mSearch = rawArgs.match(/^buscar\s+(.+)/i);
  if (mSearch) {
    const query = mSearch[1].trim().toLowerCase();
    if (!query) {
      const msgTxt = 'Escribe algo para buscar. Ejemplo:\n*/tickets buscar cocina*';
      await msg.reply(notice ? `${notice}\n\n${msgTxt}` : msgTxt);
      return true;
    }

    const pack = await incidenceDB.listIncidents({
      area,
      page: 1,
      limit: 200,
      sort: 'created_at:desc'
    });

    const items = (pack?.items || []).map(it => ({
      id: it.id,
      folio: it.folio || null,
      status: String(it.estado || 'open').toLowerCase(),
      lugar: it.lugar || null,
      descripcion: it.descripcion || null,
      interpretacion: null,
      created_at: it.created_at || null,
      updated_at: it.updated_at || null,
    }));

    const filtered = items.filter(t => {
      const folio = String(t.folio || '').toLowerCase();
      const lugar = String(t.lugar || '').toLowerCase();
      const desc = String(t.descripcion || '').toLowerCase();
      return folio.includes(query) || lugar.includes(query) || desc.includes(query);
    });

    const page = 1;
    const pageSize = Math.min(PAGE_SIZE, 10);
    const pageItems = filtered.slice(0, pageSize);

    const label = `Tickets de ${area.toUpperCase()} — resultados "${query}"`;
    const txt = formatTicketList(pageItems, { page, pageSize, label });
    await msg.reply(notice ? `${notice}\n\n🔎 ${txt}` : `🔎 ${txt}`);
    return true;
  }

  // listados por filtro/página
  let page = 1;
  let mode = 'recientes'; // recientes | abiertos | cerrados | cancelados | por_confirmar
  let label = `Tickets de ${area.toUpperCase()}`;
  let askedClosedOrCompleted = false;

  if (!rawArgs) {
    // default
  } else if (/^\d+$/.test(rawArgs)) {
    page = Math.max(1, parseInt(rawArgs, 10));
  } else {
    const parts = rawArgs.split(/\s+/);
    const maybePage =
      parts.length > 1 && /^\d+$/.test(parts[parts.length - 1]) ? parseInt(parts.pop(), 10) : 1;

    page = isNaN(maybePage) || maybePage < 1 ? 1 : maybePage;
    const keyStr = parts.join(' ').toLowerCase();

    if (/(abiert[ao]s?|pendientes|activos)/.test(keyStr)) {
      mode = 'abiertos';
      label = `Tickets ABIERTOS de ${area.toUpperCase()}`;
    } else if (/(por[_\s-]?confirmar|por[_\s-]?revisar|revisar|revision|confirmar)/.test(keyStr)) {
      mode = 'por_confirmar';
      label = `Tickets POR CONFIRMAR de ${area.toUpperCase()}`;
    } else if (/(cerrad[ao]s?|completad[ao]s?|finalizad[ao]s?)/.test(keyStr)) {
      mode = 'cerrados';
      askedClosedOrCompleted = true;
      label = `Tickets CERRADOS de ${area.toUpperCase()}`;
    } else if (/(cancelad[ao]s?)/.test(keyStr)) {
      mode = 'cancelados';
      label = `Tickets CANCELADOS de ${area.toUpperCase()}`;
    } else {
      mode = 'recientes';
      label = `Tickets de ${area.toUpperCase()}`;
    }
  }

  const pageSize = PAGE_SIZE;
  const limit = page * pageSize;

  let items = [];

  if (mode === 'abiertos') {
    const rows = incidenceDB.listOpenIncidentsByArea(area, { limit });
    items = (rows || []).map(r => ({
      id: r.id,
      folio: r.folio || null,
      status: String(r.status || 'open').toLowerCase(),
      lugar: r.lugar || null,
      descripcion: r.descripcion || null,
      interpretacion: r.interpretacion || null,
      created_at: r.created_at || null,
      updated_at: r.updated_at || null,
    }));
  } else if (mode === 'por_confirmar') {
    // ✅ robusto: no depender de listIncidents({estado})
    const pack = await incidenceDB.listIncidents({ area, page: 1, limit: limit * 3, sort: 'created_at:desc' });
    const all = (pack?.items || []).map(it => ({
      id: it.id,
      folio: it.folio || null,
      status: String(it.estado || 'open').toLowerCase(),
      lugar: it.lugar || null,
      descripcion: it.descripcion || null,
      interpretacion: null,
      created_at: it.created_at || null,
      updated_at: it.updated_at || null,
    }));
    items = all.filter(x => String(x.status || '').toLowerCase() === 'awaiting_confirmation').slice(0, limit);
  } else if (mode === 'cancelados') {
    // ✅ robusto: no depender de listIncidents({estado})
    const pack = await incidenceDB.listIncidents({ area, page: 1, limit: limit * 3, sort: 'created_at:desc' });
    const all = (pack?.items || []).map(it => ({
      id: it.id,
      folio: it.folio || null,
      status: String(it.estado || 'open').toLowerCase(),
      lugar: it.lugar || null,
      descripcion: it.descripcion || null,
      interpretacion: null,
      created_at: it.created_at || null,
      updated_at: it.updated_at || null,
    }));
    items = all.filter(x => String(x.status || '').toLowerCase() === 'canceled').slice(0, limit);
  } else if (mode === 'cerrados') {
    const pack = await incidenceDB.listIncidents({ area, page: 1, limit: limit * 3, sort: 'created_at:desc' });
    const all = (pack?.items || []).map(it => ({
      id: it.id,
      folio: it.folio || null,
      status: String(it.estado || 'open').toLowerCase(),
      lugar: it.lugar || null,
      descripcion: it.descripcion || null,
      interpretacion: null,
      created_at: it.created_at || null,
      updated_at: it.updated_at || null,
    }));
    const closedSet = new Set(['done', 'canceled']);
    items = all.filter(x => closedSet.has(String(x.status || '').toLowerCase())).slice(0, limit);
  } else {
    const pack = await incidenceDB.listIncidents({ area, page: 1, limit, sort: 'created_at:desc' });
    items = (pack?.items || []).map(it => ({
      id: it.id,
      folio: it.folio || null,
      status: String(it.estado || 'open').toLowerCase(),
      lugar: it.lugar || null,
      descripcion: it.descripcion || null,
      interpretacion: null,
      created_at: it.created_at || null,
      updated_at: it.updated_at || null,
    }));
  }

  const start = (page - 1) * pageSize;
  const pageItems = (items || []).slice(start, start + pageSize);

  let txt = formatTicketList(pageItems, { page, pageSize, label });

  // ✅ FOOTER en grupos cuando piden “cerrados/completados”
  if (askedClosedOrCompleted && mode === 'cerrados') {
    const pack2 = await incidenceDB.listIncidents({ area, page: 1, limit: 80, sort: 'created_at:desc' });
    const awaiting = (pack2?.items || []).map(it => ({
      id: it.id,
      folio: it.folio || null,
      status: String(it.estado || '').toLowerCase(),
      lugar: it.lugar || null,
      descripcion: it.descripcion || null,
      interpretacion: null,
      created_at: it.created_at || null,
      updated_at: it.updated_at || null,
    })).filter(x => x.status === 'awaiting_confirmation');

    txt += formatAwaitingFooter(awaiting, { limit: 5 });
  }

  await msg.reply(notice ? `${notice}\n\n${txt}` : txt);
  return true;
}

// ──────────────────────────────────────────────────────────────
// Admin: megadeth/deleteid
// ──────────────────────────────────────────────────────────────
function tryOpenSqlite() {
  try {
    const sqlite = require('better-sqlite3');
    const db = sqlite(DB_PATH);
    db.pragma('journal_mode = WAL');
    return db;
  } catch (e) {
    if (DEBUG) console.warn('[ADMIN][SQLITE] open failed', e?.message || e);
    return null;
  }
}

async function megadethWipe() {
  const db = tryOpenSqlite();
  if (db) {
    const tx = db.transaction(() => {
      db.exec(`DELETE FROM incidents;`);
      db.exec(`DELETE FROM incident_events;`);
      db.exec(`DELETE FROM incident_attachments;`);
      db.exec(`DELETE FROM messages_handled;`);
      db.exec(`DELETE FROM inc_sequences;`);
    });

    tx();
    db.close();
    return { driver: 'sqlite', ok: true, path: DB_PATH };
  }

  await fsp.mkdir(path.dirname(JSONL_PATH), { recursive: true });
  await fsp.writeFile(JSONL_PATH, '', 'utf8');
  return { driver: 'jsonl', ok: true, path: JSONL_PATH };
}

async function deleteIncidentByIdOrFolio(idOrFolio) {
  const key = String(idOrFolio || '').trim();
  if (!key) return { ok: false, reason: 'MISSING_KEY' };

  const db = tryOpenSqlite();
  if (db) {
    const found = db
      .prepare(`SELECT id, folio FROM incidents WHERE id = ? OR folio = ? LIMIT 1`)
      .get(key, key);

    if (!found) {
      db.close();
      return { ok: false, reason: 'NOT_FOUND' };
    }

    const tx = db.transaction(() => {
      db.prepare(`DELETE FROM incident_events WHERE incident_id = ?`).run(found.id);
      db.prepare(`DELETE FROM incident_attachments WHERE incident_id = ?`).run(found.id);
      db.prepare(`DELETE FROM incidents WHERE id = ?`).run(found.id);
    });
    tx();
    db.close();

    return { ok: true, driver: 'sqlite', deleted: { id: found.id, folio: found.folio || null } };
  }

  return { ok: false, driver: 'jsonl', reason: 'UNSUPPORTED_IN_JSONL' };
}

// ──────────────────────────────────────────────────────────────
// Ayuda / helpadmin
// ──────────────────────────────────────────────────────────────
async function handleAyuda(msg) {
  const text =
`🤖 *Vicebot — Ayuda*

*Comandos disponibles en CUALQUIER chat (DM o Grupo):*
• \`/tickets\` — lista tickets
• \`/tickets 2\` — ver página 2 (y así sucesivamente)
• \`/tickets abiertas\` — abiertos / en proceso
• \`/tickets cerradas\` — cerrados / cancelados (y al final “por confirmar”)
• \`/tickets canceladas\` — solo cancelados
• \`/tickets por_confirmar\` — solo “por confirmar”
• \`/tickets detalle FOLIO\` — ver un ticket a detalle
• \`/tickets buscar texto\` — buscar por folio, lugar o descripción

📌 *Importante según dónde lo uses:*

*✅ En GRUPOS (ej. Mantenimiento / HSKP / etc.)*
• \`/tickets\` muestra *solo tickets del área de este grupo*.
• Si intentas consultar otra área (ej. \`/tickets man\` en un grupo de IT),
  te indicaré que lo hagas por DM.

*✅ En DM (privado)*
• \`/tickets\` muestra *tus tickets*.
• También puedes consultar *por área*:
  • \`/tickets man\` (mantenimiento)
  • \`/tickets it\` (sistemas)
  • \`/tickets ama\` (hskp)
  • \`/tickets rs\` (room service)
  • \`/tickets seg\` (seguridad)
• Puedes combinar filtros:
  • \`/tickets man abiertas\`
  • \`/tickets ama buscar cocina\`
  • \`/tickets seg cerradas 2\`

📝 *Tip:* también puedes reportar incidencias escribiendo normal (sin \`/\`).`;

  await msg.reply(text);
  return true;
}

async function handleHelpAdmin(msg) {
  const text =
`🛡️ *COMANDOS ADMIN* (SOLO DM)
• \`/helpadmin\`
• \`/groups\`
• \`/bind <area> <groupId>\`
• \`/registerUser <id> | <nombre> | <cargo> | <rol> | <team>\`
• \`/editUser <id> | <nombre> | <cargo> | <rol> | <team>\`
• \`/removeUser <id>\`
• \`/viewUsers\`
• \`/megadeth\`
• \`/deleteid <ID|FOLIO>\``;

  await msg.reply(text);
  return true;
}

// ──────────────────────────────────────────────────────────────
// users.json CRUD (DM only)
// ──────────────────────────────────────────────────────────────
async function handleRegisterUser(msg, args) {
  const parts = String(args || '').split('|').map((s) => s.trim());
  if (parts.length < 4) {
    await msg.reply('Uso: `/registerUser <id> | <nombre> | <cargo> | <rol> | <team>`');
    return true;
  }

  const id = normalizeId(parts[0]);
  const nombre = parts[1] || '';
  const cargo = parts[2] || '';
  const rol = String(parts[3] || 'user').toLowerCase();
  const team = parts[4] ? String(parts[4]).trim() : '';

  const users = await loadUsers();
  if (users[id]) {
    await msg.reply(`⚠️ Ya existe el usuario: \`${id}\`. Usa \`/editUser\`.`);
    return true;
  }

  users[id] = { nombre, cargo, rol, team };
  await saveUsers(users);

  await msg.reply(
    `✅ Usuario registrado:\n` +
    `• ID: \`${id}\`\n` +
    `• Nombre: *${nombre || '—'}*\n` +
    `• Cargo: ${cargo || '—'}\n` +
    `• Rol: ${rol}\n` +
    `• Team: ${team || '—'}`
  );
  return true;
}

async function handleEditUser(msg, args) {
  const parts = String(args || '').split('|').map((s) => s.trim());
  if (parts.length < 4) {
    await msg.reply('Uso: `/editUser <id> | <nombre> | <cargo> | <rol> | <team>`');
    return true;
  }

  const id = normalizeId(parts[0]);
  const nombre = parts[1] || '';
  const cargo = parts[2] || '';
  const rol = String(parts[3] || 'user').toLowerCase();
  const team = parts[4] ? String(parts[4]).trim() : '';

  const users = await loadUsers();
  if (!users[id]) {
    await msg.reply(`⚠️ No existe el usuario: \`${id}\`. Usa \`/registerUser\`.`);
    return true;
  }

  users[id] = { nombre, cargo, rol, team };
  await saveUsers(users);

  await msg.reply(
    `✅ Usuario actualizado:\n` +
    `• ID: \`${id}\`\n` +
    `• Nombre: *${nombre || '—'}*\n` +
    `• Cargo: ${cargo || '—'}\n` +
    `• Rol: ${rol}\n` +
    `• Team: ${team || '—'}`
  );
  return true;
}

async function handleRemoveUser(msg, args) {
  const id = normalizeId(String(args || '').trim());
  if (!id) {
    await msg.reply('Uso: `/removeUser <id>`');
    return true;
  }

  const users = await loadUsers();
  if (!users[id]) {
    await msg.reply(`⚠️ No existe el usuario: \`${id}\``);
    return true;
  }

  delete users[id];
  await saveUsers(users);

  await msg.reply(`🗑️ Usuario eliminado: \`${id}\``);
  return true;
}

async function handleViewUsers(msg) {
  const users = await loadUsers();
  const keys = Object.keys(users || {});
  if (!keys.length) {
    await msg.reply('No hay usuarios registrados en users.json');
    return true;
  }

  const lines = [];
  lines.push(`👥 *Usuarios registrados (${keys.length})*`);
  lines.push('');

  keys.slice(0, 80).forEach((id) => {
    const u = users[id] || {};
    lines.push(
      `• \`${id}\` — ${u.nombre || '—'} | ${u.cargo || '—'} | rol:${u.rol || 'user'} | team:${u.team || '—'}`
    );
  });

  await msg.reply(lines.join('\n'));
  return true;
}

// ──────────────────────────────────────────────────────────────
// Router principal
// ──────────────────────────────────────────────────────────────
async function tryHandleAdminCommands(client, msg) {
  const cmd = parseCommand(msg);
  if (!cmd) return false;

  let name = cmd.name;
  if (name === 'ticket') name = 'tickets';

  const chatId = String(cmd.from || '').trim();
  const inGroup = isGroupId(chatId);

  if (inGroup) {
    if (DEBUG) console.log('[ADMIN-CMD][GROUP] cmd', { chatId, name, args: cmd.args });

    if (name === 'ayuda') return handleAyuda(msg);

    if (name === 'tickets') {
      try {
        return await handleTicketsCommandGroup(client, msg, { groupId: chatId, args: cmd.args || '' });
      } catch (e) {
        console.error('[ADMIN-CMD][GROUP] /tickets error:', e);
        try { await msg.reply('⚠️ Error interno procesando /tickets en grupo. Revisa logs.'); } catch {}
        return true;
      }
    }

    if (name === 'who') {
      await msg.reply('ℹ️ `/who` está disponible solo por DM (privado).');
      return true;
    }
    if (name === 'export') {
      await msg.reply('ℹ️ `/export` está disponible solo por DM (privado).');
      return true;
    }

    const adminLike = new Set([
      'helpadmin',
      'groups',
      'bind',
      'registeruser',
      'edituser',
      'removeuser',
      'viewusers',
      'viewuser',
      'megadeth',
      'deleteid',
    ]);
    if (adminLike.has(name)) {
      await msg.reply('🚫 Comandos de administración deshabilitados en grupos. Úsalos por DM.');
      return true;
    }

    await msg.reply('⚠️ No reconozco ese comando. Usa `/ayuda`.');
    return true;
  }

  const { raw: actorId, canon: actorCanon } = await resolveActorCanon(client, msg);

  if (DEBUG) console.log('[ADMIN-CMD][DM] parsed', {
    chatId,
    actorId,
    actorCanon,
    name,
    args: cmd.args,
    rawAuthor: msg?.author,
    rawParticipant: msg?.id?.participant,
    rawDataParticipant: msg?._data?.participant,
  });

  const allowed = await hasAccess(actorCanon);
  if (!allowed) {
    await replyAccessDenied(msg);
    return true;
  }

  if (name === 'ayuda') return handleAyuda(msg);

  if (name === 'who') {
    const isAdmin = await isAdminUser(actorCanon);
    return handleWho(msg, cmd.args, isAdmin, actorCanon);
  }

  if (name === 'tickets') {
    return handleTicketsCommandDM(client, msg, { chatId: actorCanon, args: cmd.args });
  }

  if (name === 'export') {
    return handleExport(client, msg, cmd.args);
  }

  const isAdmin = await isAdminUser(actorCanon);
  const adminLike = new Set([
    'helpadmin',
    'groups',
    'bind',
    'registeruser',
    'edituser',
    'removeuser',
    'viewusers',
    'viewuser',
    'megadeth',
    'deleteid',
  ]);

  if (!isAdmin && adminLike.has(name)) {
    await msg.reply('⚠️ Comando sólo para administradores.');
    return true;
  }

  if (name === 'helpadmin') return handleHelpAdmin(msg);

  if (name === 'groups') {
    const all = await listAllGroups(client);
    if (!all.length) {
      await msg.reply('No encontré grupos en tu sesión.');
      return true;
    }
    const lines = all.slice(0, 40).map((g) => `• ${g.name}\n  \`${g.id}\``);
    await msg.reply(['📋 *Grupos detectados*', ...lines].join('\n'));
    return true;
  }

  if (name === 'bind') {
    const m = (cmd.raw || '').match(/^\/bind\s+(\w+)\s+([^\s]+)$/i);
    if (!m) {
      await msg.reply('Uso: /bind <area> <groupId>\nEj: /bind man 1203630xxxx@g.us');
      return true;
    }
    const area = m[1].toLowerCase();
    const gid = m[2];
    await bindGroup(area, gid);
    await msg.reply(`✅ Vinculado área *${area}* → \`${gid}\`\n(Guardado en data/groups.json)`);
    return true;
  }

  if (name === 'registeruser') return handleRegisterUser(msg, cmd.args);
  if (name === 'edituser') return handleEditUser(msg, cmd.args);
  if (name === 'removeuser') return handleRemoveUser(msg, cmd.args);
  if (name === 'viewusers' || name === 'viewuser') return handleViewUsers(msg);

  if (name === 'megadeth') {
    const arg = String(cmd.args || '').trim().toUpperCase();
    if (arg !== 'CONFIRMAR') {
      await msg.reply(
        '⚠️ *MEGADETH* borra TODA la base de datos.\n\n' +
        'Para confirmar escribe:\n' +
        '`/megadeth CONFIRMAR`'
      );
      return true;
    }

    try {
      const res = await megadethWipe();
      await msg.reply(
        `🤖💥 *MEGADETH ejecutado*\n` +
        `• Driver: ${res.driver}\n` +
        `• DB: ${res.path}\n` +
        `✅ Registros eliminados. (Contadores reiniciados)`
      );
    } catch (e) {
      await msg.reply(`❌ Error ejecutando /megadeth: ${e?.message || e}`);
    }
    return true;
  }

  if (name === 'deleteid') {
    const arg = String(cmd.args || '').trim();
    if (!arg) {
      await msg.reply('Uso: `/deleteid <ID|FOLIO>`\nEj: `/deleteid SYS-00012`');
      return true;
    }

    try {
      const res = await deleteIncidentByIdOrFolio(arg);

      if (!res.ok && res.reason === 'NOT_FOUND') {
        await msg.reply('📭 No encontré ese ticket para borrar.');
        return true;
      }
      if (!res.ok && res.reason === 'UNSUPPORTED_IN_JSONL') {
        await msg.reply('⚠️ /deleteid no está soportado en modo JSONL fallback. (SQLite requerido)');
        return true;
      }
      if (!res.ok) {
        await msg.reply(`❌ No se pudo borrar: ${res.reason || 'UNKNOWN'}`);
        return true;
      }

      await msg.reply(
        `🗑️ Ticket eliminado:\n` +
        `• ID: \`${res.deleted?.id || '—'}\`\n` +
        `• Folio: *${res.deleted?.folio || '—'}*`
      );
    } catch (e) {
      await msg.reply(`❌ Error ejecutando /deleteid: ${e?.message || e}`);
    }
    return true;
  }

  await msg.reply('⚠️ No reconozco ese comando. Usa `/ayuda`.');
  return true;
}

module.exports = {
  tryHandleAdminCommands,
};

// modules/groups/groupSender.js
// Resuelve los grupos por área (desde .env o desde config JSON) y envía el ticket formateado.
// Además provee utilidades robustas de envío a grupos (texto/media) con saneado.

const fs = require('fs');
const path = require('path');
const { MessageMedia } = require('whatsapp-web.js');

const DEBUG = (process.env.VICEBOT_DEBUG || '1') === '1';

// ──────────────────────────────────────────────────────────────
// Utilidades de saneado y envío robusto
// ──────────────────────────────────────────────────────────────

function stripInvalidControls(s) {
  // Permite TAB, LF, CR y U+0020..U+FFFF. Elimina NUL y otros controles.
  return s.replace(/[^\x09\x0A\x0D\x20-\uFFFF]/g, '');
}

function sanitizeForWA(input, maxLen = 3500) {
  let s = '';
  try { s = String(input ?? ''); } catch { s = ''; }
  // Limpieza básica y controles
  s = s.replace(/\s+$/g, '');
  s = s.replace(/\u0000/g, '');
  s = stripInvalidControls(s);
  s = s.trim();
  if (!s) s = '—';
  if (s.length > maxLen) s = s.slice(0, maxLen) + '…';
  return s;
}

/**
 * Envía texto plano (string) al grupo. No acepta objetos/plantillas.
 */
async function sendTextOnly(client, groupId, text) {
  const safe = sanitizeForWA(text);
  return client.sendMessage(groupId, safe, { linkPreview: false });
}

/**
 * Envía media con caption opcional. Filtra falsos o media mal formado.
 */
async function sendMediaWithCaption(client, groupId, mediaList, caption) {
  const medias = Array.isArray(mediaList) ? mediaList.filter(Boolean) : [];
  const cap = caption != null ? sanitizeForWA(caption) : undefined;

  if (!medias.length) {
    // Si no hay media, degradamos a texto (si hay caption)
    if (cap) return sendTextOnly(client, groupId, cap);
    return null;
  }

  // Si hay varias, mandamos la primera con caption y el resto sin caption
  const [first, ...rest] = medias;

  // Asegurar que son MessageMedia válidos
  const ensureMedia = (m) => {
    if (!m) return null;
    if (m instanceof MessageMedia) return m;
    // Permitir {mimetype, data, filename}
    const { mimetype, data, filename } = m || {};
    if (typeof mimetype === 'string' && typeof data === 'string') {
      return new MessageMedia(mimetype, data, filename || undefined);
    }
    return null;
  };

  const firstOk = ensureMedia(first);
  if (!firstOk) {
    // si la primera no es válida, probamos a degradar a texto
    if (cap) return sendTextOnly(client, groupId, cap);
    return null;
  }

  await client.sendMessage(groupId, firstOk, cap ? { caption: cap } : {});
  for (const m of rest) {
    const ok = ensureMedia(m);
    if (!ok) continue;
    await client.sendMessage(groupId, ok);
  }
  return true;
}

/**
 * API principal de envío a grupos desde otros módulos.
 * Acepta:
 *  - message: string (opcional)
 *  - media: MessageMedia | MessageMedia[] (opcional)
 */
async function sendToGroup(client, groupId, { message, media }) {
  const hasMedia = !!(media && (Array.isArray(media) ? media.length : true));
  if (hasMedia) {
    try {
      return await sendMediaWithCaption(client, groupId, media, message);
    } catch (e) {
      if (DEBUG) console.warn('[GROUPS] media send failed, fallback to text:', e?.message || e);
      if (message != null) return sendTextOnly(client, groupId, message);
      return null;
    }
  }

  if (message != null) {
    return sendTextOnly(client, groupId, message);
  }

  // Nada que enviar (evitar body inválido)
  return null;
}

// ──────────────────────────────────────────────────────────────
/** Mapa ENV por área */
const AREA_ENV_MAP = {
  it:  'VICEBOT_GROUP_IT',
  man: 'VICEBOT_GROUP_MAN',
  ama: 'VICEBOT_GROUP_AMA',
  rs:  'VICEBOT_GROUP_RS',
  seg: 'VICEBOT_GROUP_SEG',
  // fallback general
  default: 'VICEBOT_GROUP_DEFAULT',
};

/** Normaliza un ID de grupo: añade sufijo @g.us si no está presente. */
function normalizeGroupId(groupId) {
  if (!groupId) return null;
  let g = String(groupId).trim();
  if (!/@g\.us$/.test(g)) g = g + '@g.us';
  return g;
}

/**
 * Intenta cargar un JSON de grupos opcional (si lo deseas en tu plan).
 * Estructura sugerida:
 * {
 *   "areas": {
 *     "it": ["120000@g.us"],
 *     "man": ["150000@g.us","160000@g.us"],
 *     ...
 *   },
 *   "default": ["199999@g.us"]
 * }
 */
function loadGroupsConfig(configPath) {
  try {
    if (!configPath) return null;
    const full = path.isAbsolute(configPath) ? configPath : path.join(process.cwd(), configPath);
    if (!fs.existsSync(full)) return null;
    const raw = fs.readFileSync(full, 'utf8');
    return JSON.parse(raw);
  } catch (e) {
    if (DEBUG) console.warn('[GROUPS] config.load.err', e?.message || e);
    return null;
  }
}

/**
 * Resuelve IDs de grupos para enviar, usando:
 *  1) Archivo JSON (si lo pasas en options.groupsConfigPath)
 *  2) Variables de entorno (.env)
 */
function resolveGroupIdsForAreas(areas, { groupsConfigPath } = {}) {
  const out = new Set();
  const cfg = loadGroupsConfig(groupsConfigPath);

  // Helper para añadir desde config JSON
  const addFromConfig = (code) => {
    const arr = cfg?.areas?.[code];
    if (Array.isArray(arr)) {
      arr.forEach((g) => {
        const n = normalizeGroupId(g);
        if (n) out.add(n);
      });
    }
  };

  // Helper para añadir desde ENV
  const addFromEnv = (code) => {
    const envKey = AREA_ENV_MAP[code];
    const raw = envKey ? process.env[envKey] : null;
    if (!raw) return;
    // Soporta coma-separado
    for (const piece of String(raw).split(',').map(s => s.trim()).filter(Boolean)) {
      const n = normalizeGroupId(piece);
      if (n) out.add(n);
    }
  };

  // 1) Áreas específicas
  for (const code of (areas || [])) {
    if (!code) continue;
    if (cfg) addFromConfig(code);
    addFromEnv(code);
  }

  // 2) Si no hay nada, usar default
  if (out.size === 0) {
    if (cfg?.default) {
      for (const g of cfg.default) {
        const n = normalizeGroupId(g);
        if (n) out.add(n);
      }
    }
    const envDefault = process.env[AREA_ENV_MAP.default];
    if (envDefault) {
      for (const piece of String(envDefault).split(',').map(s => s.trim()).filter(Boolean)) {
        const n = normalizeGroupId(piece);
        if (n) out.add(n);
      }
    }
  }

  return Array.from(out);
}

/** Construye el mensaje para postear en el grupo */
function buildIncidentMessage(incidentOrDraft) {
  const i = incidentOrDraft || {};
  const idLine  = i.id ? `*ID:* ${i.id}` : null;
  const lines = [
    '🚨 *Nueva incidencia (N-I)*',
    idLine,
    `*Descripción:* ${i.descripcion || '—'}`,
    `*Interpretación:* ${i.interpretacion || '—'}`,
    `*Lugar:* ${i.lugar || '—'}`,
    `*Área destino:* ${i.area_destino || '—'}`,
    i.building ? `*Edificio:* ${i.building}` : null,
    i.floor ? `*Piso:* ${i.floor}` : null,
    i.room ? `*Habitación:* ${i.room}` : null,
    i.source ? `*Origen:* ${i.source}` : null,
  ].filter(Boolean);

  // Saneamos por si acaso antes de devolver
  return sanitizeForWA(lines.join('\n'));
}

/**
 * Envía la incidencia a los grupos resueltos por área(s).
 * options:
 *  - groupsConfigPath: ruta a json opcional (si lo usas)
 *  - echoToUser: si true, responde al usuario a qué grupos se envió
 */
async function sendIncidentToAreaGroups(client, incident, {
  groupsConfigPath = null,
  echoToUser = false,
  msg = null,          // para responder al usuario
} = {}) {

  // Áreas candidatas: prioridad a area_destino + “areas”
  const candidateAreas = [];
  if (incident?.area_destino) candidateAreas.push(incident.area_destino);
  if (Array.isArray(incident?.areas)) {
    for (const a of incident.areas) if (a && !candidateAreas.includes(a)) candidateAreas.push(a);
  }

  const groups = resolveGroupIdsForAreas(candidateAreas, { groupsConfigPath });
  if (DEBUG) console.log('[GROUPS] resolved', { candidateAreas, groups });

  if (!groups.length) {
    if (DEBUG) console.warn('[GROUPS] no targets resolved');
    if (echoToUser && msg) {
      await msg.reply('ℹ️ No tengo grupo configurado para esa área. (Revisa tus .env o el JSON de grupos).');
    }
    return { ok: false, sent: [], errors: ['no_targets'] };
  }

  const text = buildIncidentMessage(incident);
  const sent = [];
  const errors = [];

  for (const gid of groups) {
    try {
      await sendTextOnly(client, gid, text);
      sent.push(gid);
    } catch (e) {
      errors.push({ gid, error: e?.message || String(e) });
      if (DEBUG) console.warn('[GROUPS] send.err', gid, e?.message || e);
    }
  }

  // Opcional eco al usuario
  if (echoToUser && msg) {
    if (sent.length) {
      await msg.reply(`📤 Enviado a: ${sent.join(', ')}`);
    } else {
      await msg.reply('⚠️ No pude enviar al(los) grupo(s).');
    }
  }

  return { ok: sent.length > 0, sent, errors };
}

module.exports = {
  // Resolución por áreas + envío formateado
  sendIncidentToAreaGroups,
  resolveGroupIdsForAreas,
  buildIncidentMessage,

  // utilidades de envío robusto para uso general
  sendToGroup,
  sendTextOnly,
  sendMediaWithCaption,
  sanitizeForWA,
};

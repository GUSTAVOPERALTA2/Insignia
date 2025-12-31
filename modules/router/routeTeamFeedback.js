// modules/router/routeTeamFeedback.js
// ─────────────────────────────────────────────────────────────────────────────
// Router para mensajes del equipo CON EVIDENCIAS (fotos).
// SOLO procesa cuando:
//   (A) El mensaje tiene una FOTO/MEDIA adjunta, O
//   (B) El mensaje CITA el card del ticket (reply con folio)
// 
// Los mensajes de texto simples (sin foto, sin citar) se dejan pasar
// para que routeGroupsUpdate los maneje con su lógica de auto-selección.
// ─────────────────────────────────────────────────────────────────────────────

const path = require('path');
const fs = require('fs');

const DEBUG = (process.env.VICEBOT_DEBUG || '1') === '1';
const ENABLE_AI_REWRITE = !!process.env.OPENAI_API_KEY;
const AI_MODEL = process.env.GROUP_REWRITE_MODEL || 'gpt-4o-mini';

// ──────────────────────────────────────────────────────────────
// DB (carga perezosa)
// ──────────────────────────────────────────────────────────────
function getDB() {
  try { return require('../db/incidenceDB'); } catch { return {}; }
}
const incidenceDB = getDB();

// Safe send
let safeSendMessage = null;
try {
  ({ safeSendMessage } = require('../groups/groupRouter'));
} catch {}

// ──────────────────────────────────────────────────────────────
// OpenAI para reescribir mensajes
// ──────────────────────────────────────────────────────────────
let openai = null;

async function ensureOpenAI() {
  if (!ENABLE_AI_REWRITE) return null;
  if (openai) return openai;
  try {
    const OpenAI = (await import('openai')).default;
    openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    return openai;
  } catch (e) {
    if (DEBUG) console.warn('[TEAMFB] OpenAI init failed:', e?.message);
    return null;
  }
}

async function rewriteMessage(originalMessage, context = {}) {
  const client = await ensureOpenAI();
  if (!client) return cleanMessage(originalMessage);

  try {
    const response = await client.chat.completions.create({
      model: AI_MODEL,
      messages: [
        {
          role: 'system',
          content: `Reescribe mensajes de técnicos para notificar a solicitantes.
REGLAS:
- Máximo 1-2 oraciones, breve y profesional
- Tono amable y cortés
- NO agregues información que no esté en el mensaje
- NO uses emojis
- Responde SOLO con el mensaje reescrito`
        },
        {
          role: 'user',
          content: `Mensaje: "${originalMessage}"\n\nReescribe:`
        }
      ],
      temperature: 0.3,
      max_tokens: 100
    });
    return response.choices?.[0]?.message?.content?.trim() || cleanMessage(originalMessage);
  } catch (e) {
    if (DEBUG) console.warn('[TEAMFB] AI rewrite failed:', e?.message);
    return cleanMessage(originalMessage);
  }
}

function cleanMessage(text) {
  return String(text || '').replace(/@[\d]+/g, '').replace(/\s+/g, ' ').trim();
}

// ──────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────
function isGroupId(id = '') { return /@g\.us$/.test(String(id || '')); }

const FOLIO_RE = /\b([A-Z]{2,8}-\d{3,6})\b/i;

function parseFolioFromText(text = '') {
  const m = String(text || '').match(FOLIO_RE);
  return m ? m[1].toUpperCase() : null;
}

// ──────────────────────────────────────────────────────────────
// Cache de usuarios (users.json)
// ──────────────────────────────────────────────────────────────
let usersCache = null;
let usersCacheTime = 0;
const USERS_CACHE_TTL = 60000; // 1 minuto

function loadUsersCache() {
  const now = Date.now();
  if (usersCache && (now - usersCacheTime) < USERS_CACHE_TTL) {
    return usersCache;
  }
  
  try {
    const usersPath = process.env.USERS_PATH || './data/users.json';
    const fullPath = path.resolve(process.cwd(), usersPath);
    
    if (fs.existsSync(fullPath)) {
      const data = fs.readFileSync(fullPath, 'utf8');
      usersCache = JSON.parse(data);
      usersCacheTime = now;
    }
  } catch (e) {
    if (DEBUG) console.warn('[TEAMFB] loadUsersCache err:', e?.message);
  }
  
  return usersCache || {};
}

function findUserByPhone(phoneId) {
  const users = loadUsersCache();
  if (!users || !phoneId) return null;
  
  const digits = String(phoneId).replace(/\D/g, '');
  if (digits.length < 10) return null;
  
  const shortSuffix = digits.slice(-10);
  for (const [userId, userData] of Object.entries(users)) {
    const userDigits = String(userId).replace(/\D/g, '');
    if (userDigits.slice(-10) === shortSuffix) {
      return { id: userId, ...userData };
    }
  }
  
  return null;
}

async function resolveAuthorName(msg) {
  const authorId = msg.author || msg.from;
  
  // 1. Buscar en users.json primero
  const userFromCache = findUserByPhone(authorId);
  if (userFromCache) {
    const name = userFromCache.nombre || userFromCache.name;
    const cargo = userFromCache.cargo;
    return cargo ? `${name} (${cargo})` : name;
  }
  
  // 2. Intentar obtener contacto de WhatsApp
  try {
    const contact = await msg.getContact();
    if (contact) {
      const name = contact.pushname || contact.name || contact.number;
      if (name) return name;
    }
  } catch {}
  
  // 3. Fallback
  return authorId ? String(authorId).replace(/@.*$/, '').replace(/\D/g, '').slice(-10) : 'Técnico';
}

// ──────────────────────────────────────────────────────────────
// Evidencias (persistir a disco)
// ──────────────────────────────────────────────────────────────
const ATTACH_DIR = path.join(process.cwd(), 'data', 'attachments');

function ensureDir(p) { 
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true }); 
}

function mimeToExt(m) {
  if (!m) return 'bin';
  const t = m.toLowerCase();
  if (t.includes('jpeg') || t.includes('jpg')) return 'jpg';
  if (t.includes('png')) return 'png';
  if (t.includes('webp')) return 'webp';
  if (t.includes('gif')) return 'gif';
  return t.split('/')[1] || 'bin';
}

function persistMediaToDisk(incidentId, media) {
  if (!media?.mimetype || !media?.data) return null;
  
  ensureDir(ATTACH_DIR);
  const dir = path.join(ATTACH_DIR, incidentId);
  ensureDir(dir);
  
  try {
    const ext = mimeToExt(media.mimetype);
    const fname = media.filename 
      ? media.filename.replace(/[^\w.\-]+/g, '_') 
      : `${Date.now()}.${ext}`;
    const fpath = path.join(dir, fname);
    const buf = Buffer.from(media.data, 'base64');
    fs.writeFileSync(fpath, buf);
    
    return {
      id: `${incidentId}-evidence-${Date.now()}`,
      mimetype: media.mimetype,
      filename: fname,
      url: `/attachments/${incidentId}/${encodeURIComponent(fname)}`,
      size: buf.length,
      by: 'team',
      kind: 'evidence_team',
    };
  } catch (e) {
    if (DEBUG) console.warn('[TEAMFB] persistMedia err:', e?.message);
    return null;
  }
}

// ──────────────────────────────────────────────────────────────
// Buscar ticket por mensaje citado
// ──────────────────────────────────────────────────────────────
async function findTicketByQuotedMessage(msg) {
  if (!msg.hasQuotedMsg) return null;
  
  try {
    const quoted = await msg.getQuotedMessage();
    const quotedBody = quoted?.body || '';
    const folio = parseFolioFromText(quotedBody);
    
    if (!folio) return null;
    
    if (typeof incidenceDB.getIncidentByFolio === 'function') {
      const inc = await incidenceDB.getIncidentByFolio(folio);
      if (inc?.id) return inc;
    }
  } catch (e) {
    if (DEBUG) console.warn('[TEAMFB] quoted lookup err:', e?.message);
  }
  
  return null;
}

// ──────────────────────────────────────────────────────────────
// Notificar al solicitante
// ──────────────────────────────────────────────────────────────
async function notifyRequester(client, msg, incident, { hasEvidence = false } = {}) {
  const requesterChatId = incident.chat_id || incident.chatId;
  if (!requesterChatId || isGroupId(requesterChatId)) {
    if (DEBUG) console.log('[TEAMFB] no valid requester chat_id');
    return false;
  }

  try {
    const authorName = await resolveAuthorName(msg);
    const originalMessage = (msg.body || '').trim();
    const rewrittenMessage = await rewriteMessage(originalMessage);

    const evidenceNote = hasEvidence ? '\n📷 _Se adjuntó evidencia fotográfica_' : '';
    
    const notification = [
      `📝 *${incident.folio}* — Actualización`,
      ``,
      rewrittenMessage,
      evidenceNote,
      ``,
      `— _${authorName}_`
    ].filter(Boolean).join('\n');

    if (typeof safeSendMessage === 'function') {
      const res = await safeSendMessage(client, requesterChatId, notification);
      if (!res.ok) throw new Error(res.error);
    } else {
      await client.sendMessage(requesterChatId, notification);
    }

    if (DEBUG) console.log('[TEAMFB] notified requester', { chatId: requesterChatId, folio: incident.folio });
    return true;
  } catch (e) {
    if (DEBUG) console.warn('[TEAMFB] notify requester err:', e?.message);
    return false;
  }
}

// ──────────────────────────────────────────────────────────────
// Safe reply
// ──────────────────────────────────────────────────────────────
async function safeReply(client, msg, text) {
  try {
    return await msg.reply(text);
  } catch (e) {
    if (DEBUG) console.warn('[TEAMFB] reply failed, trying sendMessage:', e?.message);
    try {
      if (typeof safeSendMessage === 'function') {
        return await safeSendMessage(client, msg.from, text);
      }
      return await client.sendMessage(msg.from, text);
    } catch (e2) {
      if (DEBUG) console.warn('[TEAMFB] sendMessage also failed:', e2?.message);
      return null;
    }
  }
}

// ──────────────────────────────────────────────────────────────
// ENTRY POINT
// ──────────────────────────────────────────────────────────────

// ✅ NUEVO: Patrones que indican actualización de estado (no feedback)
const statusUpdatePatterns = [
  // T-L (completado)
  /^\s*(completar?|completad[oa]|terminad?|terminad[oa]|list[oa]|hecho|resuelto|arreglad[oa])\s*$/i,
  /^\s*(completar?|terminar?|cerrar)\s+\d+\s*$/i,
  /\b(ya\s+)?qued[oó]\b/i,
  // T-P (en progreso)
  /^\s*(voy|vamos|enterado|en\s+camino)\s*$/i,
  // T-C (cancelar)
  /^\s*(cancelar?|cancela|cancelad[oa])\s*$/i,
];

function looksLikeStatusUpdate(text) {
  const t = (text || '').trim();
  return statusUpdatePatterns.some(rx => rx.test(t));
}

async function maybeHandleTeamFeedback(client, msg) {
  // Solo grupos
  if (!isGroupId(msg.from)) return false;
  if (msg.fromMe) return false;

  const hasMedia = msg.hasMedia;
  const hasQuoted = msg.hasQuotedMsg;
  const body = (msg.body || '').trim();

  // ════════════════════════════════════════════════════════════
  // REGLA PRINCIPAL: Solo procesar si:
  // 1. Tiene MEDIA (foto/evidencia), O
  // 2. CITA un mensaje (reply al card del ticket)
  // 
  // Si es texto simple sin citar → dejar pasar para routeGroupsUpdate
  // ════════════════════════════════════════════════════════════
  
  if (!hasMedia && !hasQuoted) {
    // Mensaje de texto simple sin citar → NO procesamos aquí
    // Lo manejará routeGroupsUpdate con su lógica de auto-selección
    return false;
  }

  // ✅ NUEVO: Si parece actualización de estado, dejarlo para routeGroupsUpdate
  if (!hasMedia && hasQuoted && looksLikeStatusUpdate(body)) {
    if (DEBUG) console.log('[TEAMFB] skipping - looks like status update', { body: body.substring(0, 30) });
    return false;
  }

  if (DEBUG) console.log('[TEAMFB] processing', { hasMedia, hasQuoted, bodyPreview: body.substring(0, 30) });

  // Buscar el ticket
  let incident = null;

  // 1. Buscar por mensaje citado
  if (hasQuoted) {
    incident = await findTicketByQuotedMessage(msg);
  }

  // 2. Si tiene media pero no citó, buscar folio en el texto
  if (!incident && hasMedia) {
    const folioInBody = parseFolioFromText(body);
    if (folioInBody && typeof incidenceDB.getIncidentByFolio === 'function') {
      try {
        incident = await incidenceDB.getIncidentByFolio(folioInBody);
      } catch {}
    }
  }

  // Si no encontramos ticket
  if (!incident) {
    // Si tiene media pero no encontró ticket, pedir que cite
    if (hasMedia) {
      await safeReply(client, msg, 
        '📷 Recibí la evidencia, pero no identifiqué el ticket.\n' +
        '*Responde al mensaje del ticket* para asociar la foto.'
      );
      return true;
    }
    
    // Si solo citó pero no hay folio válido, dejar pasar
    return false;
  }

  // Verificar que el ticket no esté cerrado
  const currentStatus = String(incident.status || '').toLowerCase();
  if (currentStatus === 'done' || currentStatus === 'closed' || currentStatus === 'canceled') {
    await safeReply(client, msg, `⚠️ El ticket *${incident.folio}* ya está cerrado.`);
    return true;
  }

  // Procesar media/evidencia
  let savedEvidence = null;
  if (hasMedia) {
    try {
      const media = await msg.downloadMedia();
      if (media?.mimetype?.startsWith('image/')) {
        savedEvidence = persistMediaToDisk(incident.id, media);
        
        // Guardar en DB
        if (savedEvidence && typeof incidenceDB.appendIncidentAttachments === 'function') {
          await incidenceDB.appendIncidentAttachments(incident.id, [savedEvidence]);
        }
      }
    } catch (e) {
      if (DEBUG) console.warn('[TEAMFB] download/save media err:', e?.message);
    }
  }

  // Registrar evento
  if (typeof incidenceDB.appendIncidentEvent === 'function') {
    await incidenceDB.appendIncidentEvent(incident.id, {
      event_type: 'team_feedback',
      wa_msg_id: msg.id?._serialized || null,
      payload: {
        source: hasMedia ? 'evidence_upload' : 'quoted_reply',
        text: body,
        author: msg.author || msg.from,
        hasEvidence: !!savedEvidence,
        evidenceId: savedEvidence?.id || null
      }
    });
  }

  // Notificar al solicitante
  await notifyRequester(client, msg, incident, { hasEvidence: !!savedEvidence });

  // Acuse en grupo
  const ack = savedEvidence 
    ? `✅ Evidencia registrada para *${incident.folio}*`
    : `✅ Nota registrada para *${incident.folio}*`;
  
  await safeReply(client, msg, ack);

  return true;
}

module.exports = { maybeHandleTeamFeedback };
// modules/router/routeGroupsUpdate.js
// ─────────────────────────────────────────────────────────────────────────────
// Procesa mensajes en GRUPOS destino para actualizar estado de tickets:
// - T-L (done/listo) → marca como completado
// - T-P (in_progress) → marca como en progreso  
// - T-C (canceled) → cancela el ticket
// + Notifica al solicitante original con mensaje reescrito por IA
// ─────────────────────────────────────────────────────────────────────────────

const { classifyGroupMessage } = require('../groups/groupUpdate');
const { loadGroupsConfig, safeSendMessage, getAreaByGroupId } = require('../groups/groupRouter');

const {
  getIncidentByFolio,
  listOpenIncidentsByArea,
  listOpenIncidentsRecentlyDispatchedToGroup,
  closeIncident,
  updateIncidentStatus,
  appendIncidentEvent,
} = require('../db/incidenceDB');

const DEBUG = (process.env.VICEBOT_DEBUG || '1') === '1';
const ENABLE_AI_REWRITE = !!process.env.OPENAI_API_KEY;
const AI_MODEL = process.env.GROUP_REWRITE_MODEL || 'gpt-4o-mini';

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
    if (DEBUG) console.warn('[GROUP-UPDATE] OpenAI init failed:', e?.message);
    return null;
  }
}

/**
 * Reescribe el mensaje del técnico de forma profesional y concisa
 */
async function rewriteUpdateMessage(originalMessage, context = {}) {
  const client = await ensureOpenAI();
  if (!client) {
    return cleanMessage(originalMessage);
  }

  const { status, folio, lugar } = context;
  const statusLabel = status === 'done' ? 'completado' : 
                      status === 'in_progress' ? 'en atención' : 'actualizado';

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
- Si está resuelto, confirma que quedó listo
- Si van en camino/trabajando, indica que están atendiendo
- Responde SOLO con el mensaje reescrito`
        },
        {
          role: 'user',
          content: `Estado: ${statusLabel}\nMensaje: "${originalMessage}"\n\nReescribe:`
        }
      ],
      temperature: 0.3,
      max_tokens: 100
    });

    const rewritten = response.choices?.[0]?.message?.content?.trim();
    return rewritten || cleanMessage(originalMessage);
  } catch (e) {
    if (DEBUG) console.warn('[GROUP-UPDATE] AI rewrite failed:', e?.message);
    return cleanMessage(originalMessage);
  }
}

function cleanMessage(text) {
  return String(text || '')
    .replace(/@[\d]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// ──────────────────────────────────────────────────────────────
// Safe reply (evita crash por session closed)
// ──────────────────────────────────────────────────────────────
async function safeReply(client, msg, text, options) {
  try {
    return await msg.reply(text, undefined, options);
  } catch (e) {
    if (DEBUG) console.warn('[GROUP-UPDATE] msg.reply failed; fallback sendMessage', e?.message || e);
    try {
      if (typeof safeSendMessage === 'function') {
        return await safeSendMessage(client, msg.from, text, options);
      }
      return await client.sendMessage(msg.from, text, options);
    } catch (e2) {
      if (DEBUG) console.warn('[GROUP-UPDATE] fallback send failed', e2?.message || e2);
      return null;
    }
  }
}

// ──────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────
function isGroupId(id = '') { return /@g\.us$/.test(String(id || '')); }

function actorKey(msg) {
  const gid = String(msg.from || '');
  const uid = String(msg.author || msg.from || '');
  return `${gid}:${uid}`;
}

function parseFoliosFromText(text = '') {
  const rx = /\b([A-Z]{2,5}-\d{3,6})\b/gi;
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
  return `${folio} — ${lugar} — "${d}"`;
}

function isYes(text = '') {
  const t = text.trim().toLowerCase();
  return /^(si|sí|s[ií]|afirmativo|ok|dale|confirmo|confirmar|correcto|yes|yep|sip)$/i.test(t);
}

function isNo(text = '') {
  const t = text.trim().toLowerCase();
  return /^(no|nel|negativo|nah|nop|nopes)$/i.test(t);
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
    const fs = require('fs');
    const path = require('path');
    const usersPath = process.env.USERS_PATH || './data/users.json';
    const fullPath = path.resolve(process.cwd(), usersPath);
    
    if (fs.existsSync(fullPath)) {
      const data = fs.readFileSync(fullPath, 'utf8');
      usersCache = JSON.parse(data);
      usersCacheTime = now;
      if (DEBUG) console.log('[GROUP-UPDATE] users.json loaded', { count: Object.keys(usersCache).length });
    }
  } catch (e) {
    if (DEBUG) console.warn('[GROUP-UPDATE] loadUsersCache err:', e?.message);
  }
  
  return usersCache || {};
}

/**
 * Busca un usuario por su ID (puede ser @c.us o @lid)
 * Intenta hacer match por los últimos 10 dígitos del número
 */
function findUserByPhone(phoneId) {
  const users = loadUsersCache();
  if (!users || !phoneId) return null;
  
  // Extraer solo los dígitos del ID
  const digits = String(phoneId).replace(/\D/g, '');
  if (digits.length < 10) return null;
  
  // Usar los últimos 10-12 dígitos para comparar
  const suffix = digits.slice(-12);
  
  for (const [userId, userData] of Object.entries(users)) {
    const userDigits = String(userId).replace(/\D/g, '');
    if (userDigits.endsWith(suffix) || suffix.endsWith(userDigits.slice(-10))) {
      return { id: userId, ...userData };
    }
  }
  
  // Intento más flexible: últimos 10 dígitos
  const shortSuffix = digits.slice(-10);
  for (const [userId, userData] of Object.entries(users)) {
    const userDigits = String(userId).replace(/\D/g, '');
    if (userDigits.slice(-10) === shortSuffix) {
      return { id: userId, ...userData };
    }
  }
  
  return null;
}

/**
 * Resuelve el nombre del autor del mensaje
 * Prioridad: msg._data > users.json > fallback
 */
async function resolveAuthorName(msg, client) {
  const authorId = msg.author || msg.from;
  let realPhoneId = null;
  let notifyName = null;  // Nombre de notificación de WhatsApp
  
  // ══════════════════════════════════════════════════════════════
  // ESTRATEGIA 0: Obtener notifyName directamente (más confiable en v1.34)
  // ══════════════════════════════════════════════════════════════
  try {
    const rawData = msg._data || msg.rawData || {};
    
    // notifyName es el nombre que el usuario tiene configurado en WhatsApp
    if (rawData.notifyName && typeof rawData.notifyName === 'string') {
      notifyName = rawData.notifyName.trim();
      if (DEBUG) console.log('[GROUP-UPDATE] found notifyName:', notifyName);
    }
    
    // También buscar en otras propiedades
    if (!notifyName && rawData.pushname) {
      notifyName = rawData.pushname.trim();
    }
    if (!notifyName && msg.pushname) {
      notifyName = msg.pushname.trim();
    }
  } catch (e) {
    // Ignorar
  }
  
  // ══════════════════════════════════════════════════════════════
  // ESTRATEGIA 1: Extraer número de msg._data (datos internos de WA)
  // ══════════════════════════════════════════════════════════════
  try {
    const rawData = msg._data || msg.rawData || {};
    
    // Buscar en diferentes lugares donde puede estar el número
    const possibleSources = [
      rawData.author,                    // Puede ser string o objeto
      rawData.from,
      rawData.sender?.id,
      rawData.sender?.user,
      rawData.participant,               // En grupos
    ];
    
    for (const source of possibleSources) {
      if (!source) continue;
      
      let phoneCandidate = null;
      
      if (typeof source === 'string') {
        // Si contiene @c.us, es un número válido
        if (source.includes('@c.us') || source.includes('@s.whatsapp.net')) {
          phoneCandidate = source.replace('@s.whatsapp.net', '@c.us');
        } else if (!source.includes('@lid')) {
          // Puede ser solo el número (no @lid)
          const digits = source.replace(/\D/g, '');
          if (digits.length >= 10 && digits.length <= 15) {
            phoneCandidate = digits + '@c.us';
          }
        }
      } else if (typeof source === 'object') {
        // Es un objeto con .user o ._serialized
        if (source.user && !String(source.user).includes('@lid')) {
          phoneCandidate = source.user + '@c.us';
        } else if (source._serialized && source._serialized.includes('@c.us')) {
          phoneCandidate = source._serialized;
        }
      }
      
      if (phoneCandidate && !phoneCandidate.includes('@lid')) {
        realPhoneId = phoneCandidate;
        if (DEBUG) console.log('[GROUP-UPDATE] found phone in msg._data', { 
          source: typeof source === 'string' ? source.substring(0, 20) : 'object',
          phone: realPhoneId 
        });
        break;
      }
    }
    
    // También revisar el id del autor directamente
    if (!realPhoneId && rawData.id) {
      const idData = rawData.id;
      if (idData.participant) {
        const participant = idData.participant;
        if (typeof participant === 'string' && participant.includes('@c.us')) {
          realPhoneId = participant;
        } else if (participant.user) {
          realPhoneId = participant.user + '@c.us';
        } else if (participant._serialized && !participant._serialized.includes('@lid')) {
          realPhoneId = participant._serialized;
        }
      }
    }
    
  } catch (e) {
    if (DEBUG) console.warn('[GROUP-UPDATE] msg._data extraction failed:', e?.message);
  }
  
  // ══════════════════════════════════════════════════════════════
  // ESTRATEGIA 2: Obtener participantes del chat y buscar por notifyName
  // ══════════════════════════════════════════════════════════════
  if (client && authorId?.includes('@lid')) {
    try {
      const chat = await msg.getChat();
      if (chat && Array.isArray(chat.participants)) {
        // Listar todos los participantes para debug
        if (DEBUG) {
          const parts = chat.participants.map(p => ({
            user: p.id?.user,
            serialized: p.id?._serialized
          }));
          console.log('[GROUP-UPDATE] group participants sample:', parts.slice(0, 3));
        }
        
        // Buscar participantes que estén en users.json
        for (const participant of chat.participants) {
          if (participant.id?.user) {
            const testPhone = participant.id.user + '@c.us';
            const userMatch = findUserByPhone(testPhone);
            
            if (userMatch) {
              const userName = userMatch.nombre || userMatch.name || '';
              
              // Comparar con notifyName para confirmar que es el autor
              if (notifyName) {
                const notifyLower = notifyName.toLowerCase();
                const userLower = userName.toLowerCase();
                const userFirstName = userLower.split(' ')[0];
                const userLastName = userLower.split(' ').slice(-1)[0];
                
                // Match si notifyName contiene nombre o apellido
                if (notifyLower.includes(userFirstName) || 
                    notifyLower.includes(userLastName) ||
                    userLower.includes(notifyLower.split(' ')[0])) {
                  if (DEBUG) console.log('[GROUP-UPDATE] matched participant to users.json via notifyName', { 
                    notifyName, 
                    userName,
                    phone: testPhone 
                  });
                  return { name: userName, cargo: userMatch.cargo, source: 'users.json_participant_match' };
                }
              }
              
              // Si no hay notifyName pero el participante está en users.json, guardarlo como candidato
              if (!realPhoneId) {
                realPhoneId = testPhone;
                if (DEBUG) console.log('[GROUP-UPDATE] potential author from participants:', testPhone);
              }
            }
          }
        }
      }
    } catch (e) {
      if (DEBUG) console.warn('[GROUP-UPDATE] getChat failed:', e?.message);
    }
  }
  
  // ══════════════════════════════════════════════════════════════
  // ESTRATEGIA 3: Buscar en users.json con el número encontrado
  // ══════════════════════════════════════════════════════════════
  if (realPhoneId) {
    const userFromCache = findUserByPhone(realPhoneId);
    if (userFromCache) {
      const name = userFromCache.nombre || userFromCache.name;
      const cargo = userFromCache.cargo;
      if (DEBUG) console.log('[GROUP-UPDATE] author from users.json', { name, cargo, phone: realPhoneId });
      return { name, cargo, source: 'users.json' };
    }
  }
  
  // ══════════════════════════════════════════════════════════════
  // ESTRATEGIA 4: Usar client.getContactById si tenemos número
  // ══════════════════════════════════════════════════════════════
  if (client && realPhoneId) {
    try {
      const contact = await client.getContactById(realPhoneId);
      if (contact) {
        const name = contact.pushname || contact.name || contact.number;
        if (name) {
          if (DEBUG) console.log('[GROUP-UPDATE] author from getContactById', { name });
          return { name, cargo: null, source: 'wa_contact' };
        }
      }
    } catch (e) {
      if (DEBUG) console.warn('[GROUP-UPDATE] getContactById failed:', e?.message);
    }
  }
  
  // ══════════════════════════════════════════════════════════════
  // ESTRATEGIA 5: Usar notifyName si lo tenemos
  // ══════════════════════════════════════════════════════════════
  if (notifyName) {
    // Intentar buscar en users.json por nombre
    const users = loadUsersCache();
    for (const [userId, userData] of Object.entries(users)) {
      const userName = userData.nombre || userData.name || '';
      // Comparar nombres (ignorando mayúsculas y acentos básicos)
      if (userName.toLowerCase().includes(notifyName.toLowerCase()) ||
          notifyName.toLowerCase().includes(userName.toLowerCase().split(' ')[0])) {
        if (DEBUG) console.log('[GROUP-UPDATE] matched notifyName to user', { notifyName, userName });
        return { name: userName, cargo: userData.cargo, source: 'notifyName_match' };
      }
    }
    
    // Usar notifyName directamente
    if (DEBUG) console.log('[GROUP-UPDATE] using notifyName as author:', notifyName);
    return { name: notifyName, cargo: null, source: 'notifyName' };
  }
  
  // ══════════════════════════════════════════════════════════════
  // FALLBACK: Usar número parcial o "Equipo"
  // ══════════════════════════════════════════════════════════════
  if (realPhoneId && !realPhoneId.includes('@lid')) {
    const num = String(realPhoneId).replace(/@.*$/, '').replace(/\D/g, '');
    if (num.length >= 10) {
      return { name: num.slice(-10), cargo: null, source: 'phone_fallback' };
    }
  }
  
  return { name: 'Equipo', cargo: null, source: 'default' };
}

/**
 * Formatea el nombre del autor para mostrar
 * Si tiene cargo, lo incluye
 */
function formatAuthorDisplay(authorInfo) {
  if (!authorInfo) return 'Técnico';
  
  const { name, cargo } = authorInfo;
  if (cargo) {
    return `${name} (${cargo})`;
  }
  return name || 'Técnico';
}

// ──────────────────────────────────────────────────────────────
// Sesiones de desambiguación/confirmación (in-memory)
// ──────────────────────────────────────────────────────────────
const SESSIONS = new Map();
const SESSION_TTL_MS = parseInt(process.env.VICEBOT_GROUP_SESSION_TTL_MS || '480000', 10); // 8 min

function setSession(key, data) {
  SESSIONS.set(key, { ...data, expiresAt: Date.now() + SESSION_TTL_MS });
}

function getSession(key) {
  const s = SESSIONS.get(key);
  if (!s) return null;
  if (Date.now() > s.expiresAt) { SESSIONS.delete(key); return null; }
  return s;
}

function clearSession(key) { SESSIONS.delete(key); }

// ──────────────────────────────────────────────────────────────
// Clasificación de intención
// ──────────────────────────────────────────────────────────────
async function classifyIntent(msg) {
  const text = (msg.body || '').trim();
  if (!isGroupId(msg.from)) return null;

  try {
    const r = await classifyGroupMessage(text);
    if (DEBUG) console.log('[GROUP-UPDATE] classify:', r);
    
    if (r && r.confidence >= 0.6 && r.intent !== 'OTRO') {
      return {
        intent: r.intent,
        confidence: r.confidence,
        status: r.intent === 'T-L' ? 'done' : 
                r.intent === 'T-P' ? 'in_progress' : 
                r.intent === 'T-C' ? 'canceled' : null
      };
    }
    return null;
  } catch (e) {
    if (DEBUG) console.warn('[GROUP-UPDATE] classify error', e?.message || e);
    return null;
  }
}

// ──────────────────────────────────────────────────────────────
// Notificar al solicitante
// ──────────────────────────────────────────────────────────────

// Cache de requester (si existe el módulo)
let getRequesterForIncident = null;
try {
  const mod = require('../state/lastGroupDispatch');
  if (typeof mod.getRequesterForIncident === 'function') {
    getRequesterForIncident = mod.getRequesterForIncident;
  }
} catch {}

function extractRequesterChatId(incident) {
  if (!incident) return null;
  
  // Buscar en múltiples campos posibles
  const candidates = [
    incident.chat_id,
    incident.chatId,
    incident.requester_chat,
    incident.origin_chat,
    incident.meta?.chat_id,
    incident.meta?.chatId,
    incident.meta?.originChatId,
  ];
  
  for (const v of candidates) {
    if (v && typeof v === 'string' && v.includes('@') && !v.includes('@g.us')) {
      return v;
    }
  }
  
  return null;
}

async function notifyRequester(client, msg, incident, newStatus) {
  // Intentar obtener el chat_id del solicitante de múltiples fuentes
  let requesterChatId = extractRequesterChatId(incident);
  
  // Fallback: buscar en el cache de dispatch
  if (!requesterChatId && getRequesterForIncident) {
    try {
      requesterChatId = getRequesterForIncident(incident.id);
    } catch {}
  }
  
  if (!requesterChatId) {
    if (DEBUG) console.log('[GROUP-UPDATE] no requester chat_id for:', incident.folio);
    return false;
  }

  try {
    const authorInfo = await resolveAuthorName(msg, client);
    const authorDisplay = formatAuthorDisplay(authorInfo);
    const originalMessage = (msg.body || '').trim();
    
    const rewrittenMessage = await rewriteUpdateMessage(originalMessage, {
      status: newStatus,
      folio: incident.folio,
      lugar: incident.lugar
    });

    const statusEmoji = newStatus === 'done' ? '✅' : 
                        newStatus === 'in_progress' ? '🔄' : 
                        newStatus === 'canceled' ? '🚫' : '📝';
    const statusLabel = newStatus === 'done' ? 'Completado' : 
                        newStatus === 'in_progress' ? 'En atención' : 
                        newStatus === 'canceled' ? 'Cancelado' : 'Actualización';

    const notification = [
      `${statusEmoji} *${incident.folio}* — ${statusLabel}`,
      ``,
      rewrittenMessage,
      ``,
      `— _${authorDisplay}_`
    ].join('\n');

    await client.sendMessage(requesterChatId, notification);
    
    if (DEBUG) console.log('[GROUP-UPDATE] notified requester', { 
      chatId: requesterChatId, 
      folio: incident.folio,
      author: authorDisplay
    });
    return true;
  } catch (e) {
    if (DEBUG) console.warn('[GROUP-UPDATE] notify requester error:', e?.message);
    return false;
  }
}

// ──────────────────────────────────────────────────────────────
// Actualizar ticket por folio explícito
// ──────────────────────────────────────────────────────────────
async function tryUpdateByFolio(client, msg, newStatus) {
  const text = (msg.body || '').trim();
  const folios = parseFoliosFromText(text);
  if (!folios.length) return null;

  const results = [];
  for (const folio of folios) {
    try {
      const inc = await getIncidentByFolio(folio);
      if (!inc) { 
        results.push({ folio, ok: false, reason: 'NOT_FOUND' }); 
        continue; 
      }
      
      const currentStatus = String(inc.status || '').toLowerCase();
      if (currentStatus === 'done' || currentStatus === 'closed' || currentStatus === 'canceled') {
        results.push({ folio, ok: false, reason: 'ALREADY_CLOSED' }); 
        continue;
      }

      // Actualizar estado
      if (newStatus === 'canceled') {
        await closeIncident(inc.id, {
          reason: 'group_cancel_by_folio',
          by: msg.author || msg.from,
          note: text,
          wa_msg_id: msg.id?._serialized || null,
        });
      } else {
        await updateIncidentStatus(inc.id, newStatus);
      }

      // Registrar evento
      await appendIncidentEvent(inc.id, {
        event_type: 'group_status_update',
        wa_msg_id: msg.id?._serialized || null,
        payload: { 
          source: 'folio_explicit', 
          newStatus,
          text,
          author: msg.author || msg.from
        }
      });

      // Notificar al solicitante
      await notifyRequester(client, msg, inc, newStatus);

      results.push({ folio, ok: true, incident: inc });
    } catch (e) {
      if (DEBUG) console.warn('[GROUP-UPDATE] by folio err', folio, e?.message || e);
      results.push({ folio, ok: false, reason: 'EXCEPTION' });
    }
  }

  // Mensaje de confirmación
  const oks = results.filter(r => r.ok).map(r => r.folio);
  const fails = results.filter(r => !r.ok).map(r => `${r.folio} (${r.reason})`);

  const statusEmoji = newStatus === 'done' ? '✅' : 
                      newStatus === 'in_progress' ? '🔄' : '🚫';
  const statusLabel = newStatus === 'done' ? 'Completado' : 
                      newStatus === 'in_progress' ? 'En progreso' : 'Cancelado';

  if (oks.length && !fails.length) {
    await safeReply(client, msg, `${statusEmoji} ${statusLabel}: ${oks.join(', ')}`);
  } else if (!oks.length && fails.length) {
    await safeReply(client, msg, `⚠️ No pude actualizar: ${fails.join(', ')}`);
  } else if (oks.length && fails.length) {
    await safeReply(client, msg, `${statusEmoji} ${statusLabel}: ${oks.join(', ')}\n⚠️ Falló: ${fails.join(', ')}`);
  }

  return { handled: true, results };
}

// ──────────────────────────────────────────────────────────────
// Buscar ticket por mensaje citado
// ──────────────────────────────────────────────────────────────
async function tryUpdateByQuotedMessage(client, msg, newStatus) {
  if (!msg.hasQuotedMsg) return null;

  try {
    const quoted = await msg.getQuotedMessage();
    const quotedBody = quoted?.body || '';
    
    const folios = parseFoliosFromText(quotedBody);
    if (!folios.length) return null;

    const folio = folios[0];
    const inc = await getIncidentByFolio(folio);
    
    if (!inc) return null;
    
    const currentStatus = String(inc.status || '').toLowerCase();
    if (currentStatus === 'done' || currentStatus === 'closed' || currentStatus === 'canceled') {
      await safeReply(client, msg, `⚠️ El ticket *${folio}* ya está cerrado.`);
      return { handled: true };
    }

    // Actualizar estado
    if (newStatus === 'canceled') {
      await closeIncident(inc.id, {
        reason: 'group_cancel_by_reply',
        by: msg.author || msg.from,
        note: msg.body,
        wa_msg_id: msg.id?._serialized || null,
      });
    } else {
      await updateIncidentStatus(inc.id, newStatus);
    }

    // Registrar evento
    await appendIncidentEvent(inc.id, {
      event_type: 'group_status_update',
      wa_msg_id: msg.id?._serialized || null,
      payload: { 
        source: 'quoted_message', 
        newStatus,
        text: msg.body,
        author: msg.author || msg.from
      }
    });

    // Notificar al solicitante
    await notifyRequester(client, msg, inc, newStatus);

    const statusEmoji = newStatus === 'done' ? '✅' : 
                        newStatus === 'in_progress' ? '🔄' : '🚫';
    const statusLabel = newStatus === 'done' ? 'Completado' : 
                        newStatus === 'in_progress' ? 'En progreso' : 'Cancelado';

    await safeReply(client, msg, `${statusEmoji} *${folio}* — ${statusLabel}`);
    return { handled: true };
  } catch (e) {
    if (DEBUG) console.warn('[GROUP-UPDATE] quoted msg error:', e?.message);
    return null;
  }
}

// ──────────────────────────────────────────────────────────────
// Buscar ticket reciente para este grupo (sin folio explícito)
// Lógica:
// - Si hay 1 ticket en últimos 10 min → usar automáticamente
// - Si hay múltiples en últimos 10 min → menú de selección
// - Si pasaron >10 min → menú de selección con todos los abiertos
// ──────────────────────────────────────────────────────────────
const AUTO_SELECT_WINDOW_MINS = parseInt(process.env.VICEBOT_GROUP_AUTO_WINDOW_MINS || '10', 10);

async function tryUpdateRecentTicket(client, msg, newStatus) {
  // 1. Buscar tickets recientes (últimos 10 min)
  let recentCandidates = [];
  try {
    recentCandidates = await listOpenIncidentsRecentlyDispatchedToGroup(msg.from, {
      windowMins: AUTO_SELECT_WINDOW_MINS,
      limit: 20
    });
  } catch (e) {
    if (DEBUG) console.warn('[GROUP-UPDATE] recent query err', e?.message || e);
  }

  // Deduplicar
  const dedup = (list) => {
    const seen = new Set();
    return (list || []).filter(x => {
      const k = x.id || x.folio;
      if (!k) return false;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  };

  recentCandidates = dedup(recentCandidates);

  // 2. Si hay exactamente 1 ticket reciente → usar automáticamente
  if (recentCandidates.length === 1) {
    const inc = recentCandidates[0];
    
    if (DEBUG) console.log('[GROUP-UPDATE] auto-select single recent ticket', { 
      folio: inc.folio, 
      windowMins: AUTO_SELECT_WINDOW_MINS 
    });

    // Para cancelación, siempre pedir confirmación
    if (newStatus === 'canceled') {
      const key = actorKey(msg);
      setSession(key, { kind: 'confirm_cancel', incident: inc, newStatus });
      await safeReply(
        client,
        msg,
        `¿Deseas *cancelar* el ticket *${inc.folio}*?\n` +
        `📍 ${inc.lugar || '—'}\n` +
        `Responde *SI* o *NO*.`
      );
      return { handled: true, awaitingConfirmation: true };
    }

    // Para done/in_progress, actualizar directamente
    return await updateTicketAndNotify(client, msg, inc, newStatus, 'auto_recent');
  }

  // 3. Si hay múltiples tickets recientes → menú
  if (recentCandidates.length > 1) {
    if (DEBUG) console.log('[GROUP-UPDATE] multiple recent tickets', { 
      count: recentCandidates.length 
    });
    return await showSelectionMenu(client, msg, recentCandidates, newStatus);
  }

  // 4. No hay tickets recientes → buscar todos los abiertos (ventana amplia)
  let allCandidates = [];
  try {
    allCandidates = await listOpenIncidentsRecentlyDispatchedToGroup(msg.from, {
      windowMins: parseInt(process.env.VICEBOT_GROUP_WINDOW_MINS || '4320', 10), // 72h
      limit: 20
    });
  } catch (e) {
    if (DEBUG) console.warn('[GROUP-UPDATE] extended query err', e?.message || e);
  }

  // Fallback: buscar por área
  if (!Array.isArray(allCandidates) || !allCandidates.length) {
    try {
      const cfg = await loadGroupsConfig();
      const area = getAreaByGroupId(msg.from, cfg);
      
      if (area) {
        const list = await listOpenIncidentsByArea(area, { limit: 10 });
        if (Array.isArray(list) && list.length) allCandidates = list;
      }
    } catch (e) {
      if (DEBUG) console.warn('[GROUP-UPDATE] listByArea err', e?.message || e);
    }
  }

  allCandidates = dedup(allCandidates);

  if (!allCandidates.length) {
    return null; // No hay tickets, ignorar
  }

  // 5. Mostrar menú de selección (pasaron >10 min o hay múltiples)
  if (DEBUG) console.log('[GROUP-UPDATE] showing menu (>10min or multiple)', { 
    count: allCandidates.length 
  });
  return await showSelectionMenu(client, msg, allCandidates, newStatus);
}

/**
 * Actualiza el ticket y notifica al solicitante
 */
async function updateTicketAndNotify(client, msg, inc, newStatus, source) {
  try {
    if (newStatus === 'canceled') {
      await closeIncident(inc.id, {
        reason: `group_cancel_${source}`,
        by: msg.author || msg.from,
        note: msg.body,
        wa_msg_id: msg.id?._serialized || null,
      });
    } else {
      await updateIncidentStatus(inc.id, newStatus);
    }

    await appendIncidentEvent(inc.id, {
      event_type: 'group_status_update',
      wa_msg_id: msg.id?._serialized || null,
      payload: { 
        source,
        newStatus,
        text: msg.body,
        author: msg.author || msg.from
      }
    });

    await notifyRequester(client, msg, inc, newStatus);

    const statusEmoji = newStatus === 'done' ? '✅' : 
                        newStatus === 'in_progress' ? '🔄' : '🚫';
    const statusLabel = newStatus === 'done' ? 'Completado' : 
                        newStatus === 'in_progress' ? 'En progreso' : 'Cancelado';

    await safeReply(client, msg, `${statusEmoji} *${inc.folio}* — ${statusLabel}`);
    return { handled: true };
  } catch (e) {
    if (DEBUG) console.warn('[GROUP-UPDATE] updateTicketAndNotify err:', e?.message);
    return null;
  }
}

/**
 * Muestra menú de selección por números
 */
async function showSelectionMenu(client, msg, candidates, newStatus) {
  const key = actorKey(msg);
  setSession(key, { kind: 'disambiguate', candidates, newStatus });

  const statusAction = newStatus === 'done' ? 'marcar como *completado*' : 
                       newStatus === 'in_progress' ? 'marcar *en progreso*' : 
                       '*cancelar*';

  // Formato: número) folio — lugar — "descripción corta"
  const lines = candidates.slice(0, 8).map((c, i) => {
    const lugar = c.lugar || '—';
    const desc = (c.descripcion || '').trim();
    const shortDesc = desc.length > 40 ? desc.slice(0, 37) + '…' : (desc || '—');
    return `*${i + 1})* ${c.folio} — ${lugar}\n     _"${shortDesc}"_`;
  });

  let footer = '\n\nResponde con el *número* (ej: 1) o *cancelar* si no quieres continuar.';
  if (candidates.length > 8) {
    footer = `\n_Mostrando 8 de ${candidates.length}_` + footer;
  }

  await safeReply(
    client,
    msg,
    `¿Cuál ticket quieres ${statusAction}?\n\n` +
    lines.join('\n\n') + 
    footer
  );
  
  return { handled: true, awaitingSelection: true };
}

// ──────────────────────────────────────────────────────────────
// Manejo de sesiones (desambiguación y confirmación)
// ──────────────────────────────────────────────────────────────
async function maybeHandleSessionResponse(client, msg) {
  const key = actorKey(msg);
  const s = getSession(key);
  if (!s) return false;

  const text = (msg.body || '').trim();

  // Confirmación de cancelación (1 ticket)
  if (s.kind === 'confirm_cancel' && s.incident) {
    if (isYes(text)) {
      clearSession(key);
      try {
        await closeIncident(s.incident.id, {
          reason: 'group_cancel_confirmed',
          by: msg.author || msg.from,
          note: text,
          wa_msg_id: msg.id?._serialized || null,
        });
        
        await appendIncidentEvent(s.incident.id, {
          event_type: 'group_cancel_ack',
          wa_msg_id: msg.id?._serialized || null,
          payload: { source: 'confirm_one_open', text }
        });
        
        await notifyRequester(client, msg, s.incident, 'canceled');
        await safeReply(client, msg, `🚫 Cancelado *${s.incident.folio}*`);
        return true;
      } catch (e) {
        if (DEBUG) console.warn('[GROUP-UPDATE] confirm cancel err', e?.message);
        await safeReply(client, msg, '⚠️ No pude cancelar. Intenta con el folio.');
        return true;
      }
    }

    if (isNo(text)) {
      clearSession(key);
      await safeReply(client, msg, 'De acuerdo, no se cancela. 👍');
      return true;
    }

    await safeReply(client, msg, 'Responde *SI* para cancelar o *NO* para dejarlo abierto.');
    return true;
  }

  // Desambiguación (múltiples tickets)
  if (s.kind === 'disambiguate' && Array.isArray(s.candidates)) {
    
    // ✅ NUEVO: Detectar si el usuario quiere cancelar/salir del flujo
    const cancelPatterns = [
      /^no$/i,
      /^cancelar?$/i,
      /^salir$/i,
      /^nada$/i,
      /^ninguno$/i,
      /^olvidalo$/i,
      /^olvídalo$/i,
      /^dejalo$/i,
      /^déjalo$/i,
      /^ya\s+no$/i,
      /^no\s+quiero/i,
      /^no\s+gracias/i,
      /^no\s+es\s+ninguno/i,
      /^ninguno\s+de\s+esos/i,
      /^me\s+equivoqu[eé]/i,
      /^error$/i,
      /^stop$/i,
      /^x$/i,
      /^0$/,
    ];
    
    if (cancelPatterns.some(rx => rx.test(text))) {
      clearSession(key);
      await safeReply(client, msg, '👍 Entendido, cancelado. Si necesitas algo más, avísame.');
      return true;
    }

    // Aceptar número o folio
    const numMatch = text.match(/^\s*(\d{1,2})\s*$/);
    const folios = parseFoliosFromText(text);
    
    let cand = null;
    
    if (numMatch) {
      const idx = parseInt(numMatch[1], 10) - 1;
      cand = s.candidates[idx];
      if (!cand) {
        await safeReply(client, msg, `Número fuera de rango. Elige del 1 al ${Math.min(s.candidates.length, 8)}, o di *cancelar* para salir.`);
        return true;
      }
    } else if (folios.length) {
      // Buscar por folio en los candidatos
      const folioUpper = folios[0].toUpperCase();
      cand = s.candidates.find(c => (c.folio || '').toUpperCase() === folioUpper);
      if (!cand) {
        await safeReply(client, msg, `No encontré *${folios[0]}* en la lista. Usa el *número* (ej: 1) o di *cancelar*.`);
        return true;
      }
    } else {
      // ✅ MEJORADO: Mensaje más amigable con opción de salir
      await safeReply(client, msg, 'Responde con el *número* del ticket (ej: 1) o di *cancelar* si no quieres continuar.');
      return true;
    }

    clearSession(key);
    return await updateTicketAndNotify(client, msg, cand, s.newStatus, 'disambiguation');
  }

  return false;
}

// ──────────────────────────────────────────────────────────────
// ENTRYPOINT principal
// ──────────────────────────────────────────────────────────────
async function maybeHandleGroupCancel(client, msg) {
  if (!isGroupId(msg.from)) return false;
  if (msg.fromMe) return false;

  // 1. Verificar si hay una sesión activa esperando respuesta
  const handledBySession = await maybeHandleSessionResponse(client, msg);
  if (handledBySession) return true;

  // 2. Clasificar intención
  const intent = await classifyIntent(msg);
  if (!intent || !intent.status) return false;

  if (DEBUG) console.log('[GROUP-UPDATE] detected intent', intent);

  // 3. Intentar por folio explícito
  const folioRes = await tryUpdateByFolio(client, msg, intent.status);
  if (folioRes?.handled) return true;

  // 4. Intentar por mensaje citado
  const quotedRes = await tryUpdateByQuotedMessage(client, msg, intent.status);
  if (quotedRes?.handled) return true;

  // 5. Buscar ticket reciente (puede iniciar desambiguación)
  const recentRes = await tryUpdateRecentTicket(client, msg, intent.status);
  if (recentRes?.handled) return true;

  // 6. No se encontró ticket
  const statusAction = intent.status === 'done' ? 'marcar como completado' : 
                       intent.status === 'in_progress' ? 'marcar en progreso' : 
                       'cancelar';
  await safeReply(client, msg, `¿Cuál ticket quieres ${statusAction}? Indica el *folio* (ej. SYS-00006)`);
  return true;
}

/**
 * Placeholder para feedback del equipo (no actualizaciones de estado)
 */
async function maybeHandleTeamFeedback(client, msg) {
  // Por ahora no hacemos nada especial con feedback general
  return false;
}

module.exports = {
  maybeHandleGroupCancel,
  maybeHandleTeamFeedback,
  maybeHandleSessionResponse,
  // Exports para testing
  rewriteUpdateMessage,
  notifyRequester,
};
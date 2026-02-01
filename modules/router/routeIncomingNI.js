/**
 * modules/router/routeIncomingNI.js
 * Versión parcheada: inyecta formatPreviewMessage y evita fallback automático al neutral
 * + FIX: lee texto en mensajes con foto (caption) además de body
 * + ✅ NEW: Guarda lugares freeform en el catálogo para futuros usos
 * + ✅ FIX: persistir origin_name (ahora: WA ID / teléfono) al crear el ticket
 */

const fs = require('fs');
const path = require('path');

const { generateContextualResponse } = require('../ai/contextReply');
const { interpretTurn } = require('../ai/dialogInterpreter');
const { deriveIncidentText } = require('../ai/incidentText');
const { recordGroupDispatch } = require('../state/lastGroupDispatch');

const { detectPlace, loadLocationCatalogIfNeeded } = require('../ai/placeExtractor');
const { detectArea } = require('../ai/areaDetector');
const { analyzeNIImage } = require('../ai/niVision');
const { resolvePlace } = require('../ai/placeResolver');

const {
  ensureReady,
  persistIncident,
  appendIncidentAttachments,
  appendDispatchedToGroupsEvent,
} = require('../db/incidenceDB');

const {
  ensureSession, resetSession, pushTurn, touch,
  setMode, setDraftField, replaceAreas, addArea, removeArea,
  isReadyForPreview, closeSession,
} = require('../state/niSession');

const {
  loadGroupsConfig,
  resolveTargetGroups,
  formatIncidentMessage,
  sendIncidentToGroups
} = require('../groups/groupRouter');

const { MessageMedia } = require('whatsapp-web.js');
const { classifyNiGuard } = require('./niGuard');

// Importar handlers de modo
const { getHandler, SUPPORTED_MODES } = require('./niHandlers');

// Importar funciones compartidas (ahora incluyendo formatPreviewMessage)
const {
  DEBUG,
  norm,
  isYes,
  isNo,
  formatPreviewMessage,
  hasRequiredDraft,
  isSessionBareForNI,
  cleanupSessionMedia,
  areaLabel,
  normalizeAreaCode,
} = require('./niHandlers/shared');

// Importar intérprete IA de edición e inyectarlo en ctx
const { interpretEditMessage } = require('./niHandlers/interpretEditMessage');

// ✅ NEW: Importar manager de lugares freeform
let addFreeformPlace = null;
try {
  ({ addFreeformPlace } = require('../places/freeformPlaceManager'));
} catch (e) {
  // Si no existe el módulo, no es crítico
  if (DEBUG) console.warn('[NI] freeformPlaceManager not available:', e?.message);
}

// CONFIG
const MEDIA_BATCH_WINDOW_MS = parseInt(process.env.VICEBOT_MEDIA_BATCH_WINDOW_MS || '8000', 10);
const ASK_PLACE_COOLDOWN_MS = parseInt(process.env.VICEBOT_ASK_PLACE_COOLDOWN_MS || '15000', 10);
const ATTACH_DIR = path.join(process.cwd(), 'data', 'attachments');
const ATTACH_BASEURL = '/attachments';

// Safe reply wrapper
let safeReply = null;
try { ({ safeReply } = require('../core/safeReply')); } catch (e) { safeReply = null; }

async function replySafe(msg, text) {
  if (!msg || !text) return false;
  try {
    if (safeReply) return await safeReply(msg, text);
    await msg.reply(text);
    return true;
  } catch (e) {
    if (DEBUG) console.warn('[NI] replySafe err', e?.message || e);
    return false;
  }
}

/**
 * FIX: WhatsApp puede mandar el texto de un mensaje con media como caption
 * y dejar msg.body vacío. Esto lo unifica.
 */
function getMsgText(msg) {
  const candidates = [
    msg?.body,
    msg?.caption,
    msg?._data?.caption,
    msg?._data?.body,
  ];
  const v = candidates.find(x => typeof x === 'string' && x.trim().length);
  return (v || '').trim();
}

/**
 * ✅ CAMBIO CLAVE:
 * En vez de persistir "nombre WhatsApp", persistimos SIEMPRE un identificador estable:
 * - WA ID (ej: 5217751801318@c.us)
 * - o número si viene en otro formato
 *
 * Esto permite resolver después contra users.json (nombre + cargo) sin depender de pushname.
 */
function canonWaId(v) {
  const s = String(v || '').trim();
  if (!s) return '';
  if (/^\d{8,16}$/.test(s)) return `${s}@c.us`;
  return s;
}

async function resolveOriginName(client, msg, chatId) {
  // 1) Preferimos el chatId del flujo (ya viene como @c.us en DMs)
  const id = canonWaId(chatId || msg?.from || '');
  if (/@c\.us$/i.test(id)) return id;

  // 2) Intentar extraer número del contacto (SIN usar nombre)
  try {
    const c = await msg.getContact();
    const num = String(c?.number || '').replace(/\D/g, '');
    if (num) return `${num}@c.us`;
  } catch (e) {
    if (DEBUG) console.warn('[NI] resolveOriginName getContact err', e?.message || e);
  }

  // 3) Por ID con client.getContactById (SIN usar nombre)
  try {
    const cid = canonWaId(chatId || msg?.from);
    if (client && cid) {
      const c = await client.getContactById(cid);
      const num = String(c?.number || '').replace(/\D/g, '');
      if (num) return `${num}@c.us`;
    }
  } catch (e) {
    // ignorar
  }

  // 4) Fallback: limpiar número de cualquier cosa
  const num = String(chatId || msg?.from || '').replace(/@.*$/, '').replace(/\D/g, '');
  return num ? `${num}@c.us` : 'unknown@c.us';
}

// ═══════════════════════════════════════════════════════════════
// UTILIDAD: Verifica si el texto parece un lugar válido
// ═══════════════════════════════════════════════════════════════
function isLikelyPlaceText(text) {
  if (!text) return false;
  const t = String(text).toLowerCase().trim();

  // Número de habitación solo (3-4 dígitos)
  if (/^\d{3,4}$/.test(t)) return true;

  // Habitación con prefijo
  if (/^(hab|habitacion|habitación|room|villa|cuarto)\s*#?\d{3,4}$/i.test(t)) return true;

  // Lugares conocidos del hotel
  const knownPlaces = [
    'lobby', 'front', 'front desk', 'recepcion', 'recepción', 'reception',
    'alberca', 'pool', 'piscina',
    'gym', 'gimnasio',
    'spa', 'salon', 'salón', 'business center', 'business',
    'restaurante', 'restaurant', 'bar', 'cocina',
    'estacionamiento', 'parking', 'valet',
    'pasillo', 'elevador', 'escalera', 'azotea', 'roof', 'rooftop',
    'jardin', 'jardín', 'terraza', 'palapa',
    'bodega', 'almacen', 'almacén', 'lavanderia', 'lavandería', 'laundry',
    'oficina', 'administracion', 'administración', 'rh', 'contabilidad',
    'playa', 'beach', 'muelle', 'pier'
  ];

  if (knownPlaces.some(place => t.includes(place))) return true;

  // Pisos/niveles
  if (/\b(piso|nivel|planta|floor)\s*\d+/i.test(t)) return true;
  if (/\b(pb|planta\s*baja|ground\s*floor)\b/i.test(t)) return true;

  if (/^en\s+(el|la)\s+\w{3,15}$/i.test(t)) return true;

  return false;
}

// ═══════════════════════════════════════════════════════════════
// UTILIDADES LOCALES
// ═══════════════════════════════════════════════════════════════

async function normalizeAndSetLugar(s, msg, placeText, opts = {}) {
  const {
    preferRoomsFirst = true,
    strictMode = true,

    // IA / freeform:
    useAI = true,
    allowFreeformAI = true,
    aiModel = process.env.VICEBOT_AI_MODEL_PLACE || undefined,

    // comportamiento:
    setNotInCatalogFlag = true, // marca s._lugarNotInCatalog si es freeform
  } = opts;

  try {
    const raw = String(placeText || '').trim();
    if (!raw) {
      return { success: false, originalInput: placeText, reason: 'empty' };
    }

    // 1) Catálogo (detectPlace)
    const result = await detectPlace(raw, { preferRoomsFirst, ...opts });

    if (result?.found || result?.canonical_label) {
      const lugar = result.canonical_label || result.label || result.found;
      setDraftField(s, 'lugar', lugar);
      if (setNotInCatalogFlag) s._lugarNotInCatalog = false;
      return { success: true, lugar, result, via: 'catalog' };
    }

    if (result?.suggestions?.length) {
      return {
        success: false,
        fuzzySuggestions: result.suggestions,
        originalInput: raw,
        reason: 'fuzzy_suggestions'
      };
    }

    const roomMatch = raw.match(/\b(\d{3,4})\b/);
    if (roomMatch) {
      const num = roomMatch[1];
      const lugar = `Habitación ${num}`;
      setDraftField(s, 'lugar', lugar);
      if (setNotInCatalogFlag) s._lugarNotInCatalog = false;
      return { success: true, lugar, via: 'room_number' };
    }

    if (useAI && allowFreeformAI) {
      try {
        const r = await resolvePlace(raw, {
          useAI: true,
          allowFreeform: true,
          aiModel
        });

        if (r?.found && r?.type === 'catalog' && r?.canonical) {
          const lugar = r.canonical;
          setDraftField(s, 'lugar', lugar);
          if (setNotInCatalogFlag) s._lugarNotInCatalog = false;
          return { success: true, lugar, result: r, via: 'ai_catalog' };
        }

        if (r?.found && r?.type === 'freeform' && r?.label) {
          const lugar = r.label;
          setDraftField(s, 'lugar', lugar);
          if (setNotInCatalogFlag) s._lugarNotInCatalog = true;
          return { success: true, lugar, result: r, via: 'ai_freeform' };
        }

        if (r?.ambiguous && Array.isArray(r.options) && r.options.length) {
          return {
            success: false,
            needsDisambiguation: true,
            zoneKey: r.zoneKey,
            candidates: r.options,
            disambiguationPrompt: r.disambiguationPrompt,
            originalInput: raw,
            reason: 'ambiguous_place'
          };
        }
      } catch (eAI) {
        if (DEBUG) console.warn('[NI] normalizeAndSetLugar resolvePlace error', eAI?.message);
      }
    }

    if (strictMode) {
      return { success: false, originalInput: raw, reason: 'not_recognized' };
    }

    const looksLikePlace = isLikelyPlaceText(raw);

    if (looksLikePlace) {
      setDraftField(s, 'lugar', raw);
      if (setNotInCatalogFlag) s._lugarNotInCatalog = true;
      return { success: true, lugar: raw, via: 'fallback_heuristic' };
    }

    return { success: false, originalInput: raw, reason: 'not_a_place' };

  } catch (e) {
    if (DEBUG) console.warn('[NI] normalizeAndSetLugar error', e?.message);
    return { success: false, originalInput: placeText, reason: 'error', error: e?.message };
  }
}

async function autoAssignArea(s) {
  if (!s.draft?.descripcion) return;
  try {
    const result = await detectArea(s.draft.descripcion);
    if (result?.area) {
      setDraftField(s, 'area_destino', result.area);
      addArea(s, result.area);
    }
  } catch (e) {
    if (DEBUG) console.warn('[NI] autoAssignArea error', e?.message);
  }
}

async function refreshIncidentDescription(s, text) {
  if (!text && !s.draft?.descripcion) return;
  try {
    const result = await deriveIncidentText({ text: text || s.draft.descripcion });
    if (result?.incident) s.draft.descripcion = result.incident;
  } catch (e) {
    if (DEBUG) console.warn('[NI] refreshIncidentDescription error', e?.message);
  }
}

function addDetail(s, detail) {
  if (!s.draft) s.draft = {};
  s.draft._details = s.draft._details || [];
  s.draft._details.push(detail);
  const currentDesc = s.draft.descripcion || '';
  const separator = currentDesc && !/[.?!]$/.test(currentDesc) ? '. ' : currentDesc ? ' ' : '';
  s.draft.descripcion = (currentDesc || '') + (separator || '') + detail;
}

async function finalizeAndDispatch({ client, msg, session, silent = false }) {
  const s = session;

  const ALLOWED = new Set(['RS', 'AMA', 'MAN', 'IT', 'SEG']);

  if (!hasRequiredDraft(s.draft)) {
    if (!silent) await replySafe(msg, '❌ Faltan datos para enviar el ticket.');
    return { success: false, error: 'missing_fields' };
  }

  const rawArea = s.draft?.area_destino || '';
  let normArea = null;
  try {
    if (typeof normalizeAreaCode === 'function') normArea = normalizeAreaCode(rawArea);
  } catch (e) {
    if (DEBUG) console.warn('[NI] normalizeAreaCode error', e?.message);
    normArea = null;
  }
  const areaToUse = (normArea || rawArea || '').toString().trim().toUpperCase();

  if (!areaToUse || !ALLOWED.has(areaToUse)) {
    if (!silent) await replySafe(msg, '❌ Área destino inválida. Usa: RS, AMA, MAN, IT o SEG.');
    if (DEBUG) console.warn('[NI] invalid area_destino', { rawArea, normArea, areaToUse });
    return { success: false, error: 'invalid_area', rawArea, normArea, areaToUse };
  }

  s.draft.area_destino = areaToUse;

  // ✅ Persistimos un ID estable (WA ID)
  let origin_name = null;
  try {
    origin_name = await resolveOriginName(client, msg, s.chatId);
  } catch (e) {
    origin_name = null;
  }

  let incident;
  try {
    incident = await persistIncident({
      descripcion: s.draft.descripcion,
      descripcion_original: s.draft.descripcion_original || s.draft.descripcion,
      lugar: s.draft.lugar,
      area_destino: s.draft.area_destino,
      areas: s.draft.areas || [s.draft.area_destino],
      reportero: msg.from,
      chat_id: s.chatId,
      requester_phone: s.chatId?.replace('@c.us', ''),
      origin_name, // ✅ ahora es WA ID / teléfono@c.us
      status: 'open',
      timestamp: Date.now(),
      created_at: new Date().toISOString(),
    });
  } catch (e) {
    if (DEBUG) console.error('[NI] persistIncident error', e);
    if (!silent) await replySafe(msg, '❌ Error al guardar el ticket. Intenta de nuevo.');
    return { success: false, error: 'persist_error', message: e?.message };
  }

  const folio = incident?.folio || `INC-${Date.now()}`;
  const incidentId = incident?.id;

  if (s.draft.lugar && s._isFreeformPlace && addFreeformPlace) {
    try {
      const result = await addFreeformPlace(s.draft.lugar, {
        area: s.draft.area_destino,
        reloadIndex: true,
      });

      if (result.added) {
        if (DEBUG) console.log('[NI] freeform place saved to catalog', {
          label: s.draft.lugar,
          type: result.record?.type,
        });
      } else if (DEBUG && result.reason !== 'already_exists') {
        console.log('[NI] freeform place not saved', { reason: result.reason });
      }
    } catch (e) {
      if (DEBUG) console.warn('[NI] freeform place save error (non-critical)', e?.message);
    }
  }

  if (incidentId && Array.isArray(s._pendingMedia) && s._pendingMedia.length > 0) {
    try {
      const attachments = s._pendingMedia.map((m, i) => ({
        filename: m.filename || `attachment_${i + 1}`,
        mimetype: m.mimetype,
        data: m.data,
      }));
      await appendIncidentAttachments(incidentId, attachments);
    } catch (e) {
      if (DEBUG) console.warn('[NI] attachments save error', e?.message);
      if (!silent) await replySafe(msg, '❌ Error al guardar adjuntos. El ticket fue creado, pero los adjuntos no se guardaron.');
      return { success: false, error: 'attachments_error', message: e?.message, folio, id: incidentId };
    }
  }

  let primaryId, ccIds;
  try {
    const cfg = await loadGroupsConfig();
    const resolved = resolveTargetGroups(s.draft, cfg) || {};
    primaryId = resolved.primaryId;
    ccIds = resolved.ccIds;
  } catch (e) {
    if (DEBUG) console.warn('[NI] load/resolve groups error', e?.message);
    if (!silent) await replySafe(msg, '⚠️ Ticket guardado, pero no pude resolver a qué grupos enviarlo.');
    return { success: false, error: 'groups_resolve_error', message: e?.message, folio, id: incidentId };
  }

  if (primaryId) {
    const message = formatIncidentMessage({
      ...s.draft,
      folio,
      id: incidentId,
      originChatId: s.chatId,
    });

    const firstMedia = s._pendingMedia?.[0] ? new MessageMedia(
      s._pendingMedia[0].mimetype,
      s._pendingMedia[0].data,
      s._pendingMedia[0].filename
    ) : null;

    try {
      await sendIncidentToGroups(client, { message, primaryId, ccIds, media: firstMedia });
      await recordGroupDispatch({ folio, primaryId, ccIds });
    } catch (e) {
      if (DEBUG) console.error('[NI] sendIncidentToGroups error', e);
      if (!silent) await replySafe(msg, '❌ Error al enviar el ticket al equipo responsable. El ticket fue creado en la base de datos.');
      try {
        if (incidentId) await appendDispatchedToGroupsEvent(incidentId, { primaryId, ccIds, error: e?.message, success: false });
      } catch (ee) {
        if (DEBUG) console.warn('[NI] appendDispatchedToGroupsEvent error', ee?.message);
      }
      return { success: false, error: 'dispatch_error', message: e?.message, folio, id: incidentId };
    }

    if (incidentId) {
      try {
        await appendDispatchedToGroupsEvent(incidentId, { primaryId, ccIds, success: true });
      } catch (e) {
        if (DEBUG) console.warn('[NI] dispatch event save error', e?.message);
      }
    }
  }

  s._lastCreatedTicket = { id: incidentId, folio, area_destino: s.draft.area_destino, createdAt: Date.now() };

  if (!silent) await replySafe(msg, `✅ *Ticket creado:* ${folio}\n\nTe avisaré cuando haya novedades.`);

  if (!silent) {
    try { resetSession(s.chatId); } catch (e) { if (DEBUG) console.warn('[NI] resetSession error', e?.message); }
  }

  return { success: true, folio, id: incidentId };
}

// FIND STRONG PLACE SIGNALS (igual que antes)
function findStrongPlaceSignals(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;

  const norm = (s) => String(s || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();

  const t = norm(raw);

  {
    const m = raw.match(/\b(?:hab(?:itaci[oó]n)?|room|villa|cuarto)\s*#?(\d{3,4})\b/i);
    if (m?.[1]) return { value: `Habitación ${m[1]}`, type: 'room', raw: m[0] };
  }

  {
    const m = raw.match(/\b(\d{3,4})\b/);
    if (m?.[1]) return { value: `Habitación ${m[1]}`, type: 'room', raw: m[0] };
  }

  const AREA_SYNONYMS = [
    { label: 'Front Desk', terms: ['front desk', 'frontdesk', 'recepcion', 'recepción', 'front'] },
    { label: 'Lobby',      terms: ['lobby', 'vestibulo', 'vestíbulo'] },
    { label: 'Spa',        terms: ['spa', 'espa'] },
    { label: 'Gimnasio',   terms: ['gym', 'gimnasio'] },
    { label: 'Alberca',    terms: ['alberca', 'pool', 'piscina'] },
    { label: 'Restaurante',terms: ['restaurante', 'restaurant'] },
    { label: 'Bar',        terms: ['bar'] },
    { label: 'Estacionamiento', terms: ['estacionamiento', 'parking'] },
    { label: 'Pasillo',    terms: ['pasillo', 'corredor'] },
    { label: 'Elevador',   terms: ['elevador', 'ascensor'] },
  ];

  const includesTerm = (hay, term) => {
    const h = ` ${hay} `;
    const x = ` ${norm(term)} `;
    return h.includes(x);
  };

  const espIsSpa =
    /\b(?:del|en|en el|en la|areas?\s+humanas?\s+del|area\s+humana\s+del)\s+esp\b/i.test(t) ||
    /\b(?:del|en|en el|en la)\s+espa\b/i.test(t);

  if (espIsSpa) {
    const m = raw.match(/\b(?:del|en|en el|en la|areas?\s+humanas?\s+del|area\s+humana\s+del)\s+(esp|espa)\b/i);
    return { value: 'Spa', type: 'area', raw: m?.[0] || raw };
  }

  for (const area of AREA_SYNONYMS) {
    for (const term of area.terms) {
      if (includesTerm(t, term)) {
        return { value: area.label, type: 'area', raw: term };
      }
    }
  }

  return null;
}

// GLOBAL YES/NO GATE
const GLOBAL_EXPECTS = new Set([
  'confirm', 'preview', 'confirm_batch', 'multiple_tickets',
  'different_problem', 'description_or_new', 'context_switch',
  'choose_area_multi', 'choose_place_from_candidates',
  'followup_decision', 'followup_place_decision',
  'edit_menu', 'edit_menu_place', 'edit_multiple_ticket',
]);

function isShortYesNoGlobal(text, s) {
  if (!text || !s) return false;
  const isYesToken = isYes(text);
  const isNoToken = isNo(text);
  const isShort = (isYesToken || isNoToken) && text.length < 15;
  if (!isShort) return false;
  const mode = s.mode;
  const expectsConfirmation = GLOBAL_EXPECTS.has(mode);
  const editingActive = Boolean(
    s._multipleEditing ||
    s._editingTarget ||
    s.mode?.startsWith('edit_') ||
    s._isEditingMultiple ||
    s._editingTicketNum !== undefined
  );
  const t = norm(text);
  if (t === 'listo' || t === 'ok') return false;
  if (isShort && !expectsConfirmation && isSessionBareForNI(s) && !editingActive) return { bare: true, isYesToken, isNoToken };
  if (isShort && expectsConfirmation && !editingActive) return { passToHandler: true };
  return false;
}

// MAIN: signature: handleTurn(client, msg, { catalogPath })
async function handleTurn(client, msg, { catalogPath } = {}) {
  if (!msg) return;

  if (msg.__niTurnHandled === true) return;
  msg.__niTurnHandled = true;

  const chatId = msg.from;
  const text = getMsgText(msg);

  try { ensureReady(); } catch (e) { if (DEBUG) console.warn('[NI] ensureReady err', e?.message || e); }
  try { await loadLocationCatalogIfNeeded(catalogPath); } catch (e) { if (DEBUG) console.warn('[NI] loadLocationCatalogIfNeeded err', e?.message || e); }

  const s = ensureSession(chatId);

  if (DEBUG) console.log('[NI] handleTurn', { chatId, text: text?.substring(0, 120), mode: s.mode, hasMedia: !!msg.hasMedia });

  if (msg.hasMedia) {
    try {
      const media = await msg.downloadMedia();
      if (media) {
        s._pendingMedia = s._pendingMedia || [];
        s._pendingMedia.push({
          mimetype: media.mimetype,
          data: media.data,
          filename: media.filename || `attachment_${Date.now()}`,
          ts: Date.now(),
          caption: text || null,
        });
        s._lastMediaAt = Date.now();
        setTimeout(() => {
          const now = Date.now();
          if (now - (s._lastMediaAt || 0) >= MEDIA_BATCH_WINDOW_MS) {
            s._mediaBatchReady = true;
            if (DEBUG) console.log('[NI] media batch ready', { chatId, count: s._pendingMedia?.length || 0 });
          }
        }, MEDIA_BATCH_WINDOW_MS + 10);
      }
    } catch (e) {
      if (DEBUG) console.warn('[NI] media download error', e?.message);
    }
  }

  if (text && !msg.hasMedia) {
    const globalYesNo = isShortYesNoGlobal(text, s);
    if (globalYesNo && globalYesNo.bare) {
      if (DEBUG) console.log('[NI] YES/NO bare response (no pending flow)');
      if (globalYesNo.isYesToken) {
        await replySafe(msg,
          '🤔 No hay nada pendiente que confirmar.\n\n' +
          'Si necesitas reportar algo, cuéntame *qué problema* hay y *dónde está*.'
        );
      } else {
        await replySafe(msg, '👋 Si necesitas reportar algo, solo dime qué problema hay y dónde.');
      }
      return;
    }
  }

  const ctx = {
    client, msg, s, text, replySafe, isYes, isNo,
    detectArea, detectPlace, findStrongPlaceSignals: findStrongPlaceSignals,
    normalizeAndSetLugar, autoAssignArea, refreshIncidentDescription, addDetail,
    analyzeNIImage,
    setMode, setDraftField, addArea, removeArea, replaceAreas, resetSession, closeSession, touch, isSessionBareForNI,
    finalizeAndDispatch,
    classifyNiGuard, generateContextualResponse,
    deriveIncidentText,
    pushTurn,
    interpretEditMessage,
    aiChat: (typeof global !== 'undefined' && global.aiChat) ? global.aiChat : null,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY || null,
    DEBUG: DEBUG,
    formatPreviewMessage,
    normalizeAreaCode,
  };

  ctx.setDraftField = ctx.setDraftField || setDraftField;
  ctx.addArea = ctx.addArea || addArea;
  ctx.removeArea = ctx.removeArea || removeArea;
  ctx.replaceAreas = ctx.replaceAreas || replaceAreas;
  ctx.resetSession = ctx.resetSession || resetSession;
  ctx.touch = ctx.touch || touch;
  ctx.pushTurn = ctx.pushTurn || pushTurn;
  ctx.finalizeAndDispatch = ctx.finalizeAndDispatch || finalizeAndDispatch;
  ctx.interpretEditMessage = ctx.interpretEditMessage || interpretEditMessage;

  if (typeof ctx.formatPreviewMessage !== 'function') {
    ctx.formatPreviewMessage = (t) => {
      try {
        return `• Descripción: ${t.descripcion || t.descripcion_original || '(vacío)'}\n` +
          `• Lugar: ${t.lugar || 'Sin dato'}\n` +
          `• Área destino: ${t.area_destino || 'Sin detectar'}`;
      } catch (e) {
        return 'Vista previa no disponible.';
      }
    };
  }

  let handler = null;
  try { handler = getHandler(s.mode); } catch (e) { if (DEBUG) console.warn('[NI] getHandler failed', e?.message || e); }

  if (!handler) {
    console.error(`[NI] No handler for mode "${s.mode}". Falling back to neutral and resetting session.`);
    try { await replySafe(msg, "⚠️ Lo siento, algo salió mal con el flujo. Reiniciemos. ¿Qué necesitas reportar?"); } catch (e) {}
    try { cleanupSessionMedia(s); } catch (e) { if (DEBUG) console.warn('[NI] cleanupSessionMedia failed', e); }
    try { resetSession(s.chatId); } catch (e) { if (DEBUG) console.warn('[NI] resetSession failed', e); }
    return;
  }

  if (DEBUG) console.log('[NI] dispatching to handler', { mode: s.mode, handler: handler?.name });

  try {
    const handled = await handler(ctx);
    if (handled) return;
  } catch (e) {
    console.error('[NI] handler error', { mode: s.mode, error: e?.message, stack: e?.stack });
    try {
      await replySafe(msg, '⚠️ Ocurrió un error al procesar tu mensaje en este modo. Intenta de nuevo o escribe *cancelar* para salir del modo edición.');
    } catch (er) { if (DEBUG) console.warn('[NI] reply on handler error failed', er?.message); }
    return;
  }

  if (s.mode !== 'neutral') {
    if (DEBUG) console.log('[NI] falling back to neutral handler');
    try {
      const neutralHandler = getHandler('neutral');
      await neutralHandler(ctx);
    } catch (e) { if (DEBUG) console.error('[NI] neutral handler error', e?.message); }
  }
}

module.exports = { handleTurn };

/**
 * modules/router/routeIncomingNI.js
 * Versión parcheada: inyecta formatPreviewMessage y evita fallback automático al neutral
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

// CONFIG
const MEDIA_BATCH_WINDOW_MS = parseInt(process.env.VICEBOT_MEDIA_BATCH_WINDOW_MS || '8000', 10);
const ASK_PLACE_COOLDOWN_MS = parseInt(process.env.VICEBOT_ASK_PLACE_COOLDOWN_MS || '15000', 10);
const ATTACH_DIR = path.join(process.cwd(), 'data', 'attachments');
const ATTACH_BASEURL = '/attachments';

// Safe reply wrapper
let safeReply = null;
try { ({ safeReply } = require('../utils/safeReply')); } catch (e) { safeReply = null; }

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
  
  // Si contiene algún lugar conocido
  if (knownPlaces.some(place => t.includes(place))) return true;
  
  // Pisos/niveles
  if (/\b(piso|nivel|planta|floor)\s*\d+/i.test(t)) return true;
  if (/\b(pb|planta\s*baja|ground\s*floor)\b/i.test(t)) return true;
  
  // Patrón "en el/la X" donde X es corto (probable lugar)
  if (/^en\s+(el|la)\s+\w{3,15}$/i.test(t)) return true;
  
  return false;
}

// ═══════════════════════════════════════════════════════════════
// UTILIDADES LOCALES
// ═══════════════════════════════════════════════════════════════

async function normalizeAndSetLugar(s, msg, placeText, opts = {}) {
  try {
    const result = await detectPlace(placeText, { preferRoomsFirst: true, ...opts });
    
    // Si encontró lugar en catálogo
    if (result?.found || result?.canonical_label) {
      const lugar = result.canonical_label || result.label || result.found;
      setDraftField(s, 'lugar', lugar);
      return { success: true, lugar, result };
    }
    
    // Si hay sugerencias fuzzy, devolverlas sin setear lugar
    if (result?.suggestions && result.suggestions.length) {
      return { success: false, fuzzySuggestions: result.suggestions, originalInput: placeText };
    }
    
    // Si tiene número de habitación (3-4 dígitos), aceptar
    const roomMatch = placeText.match(/(\d{3,4})/);
    if (roomMatch) {
      const num = roomMatch[1];
      setDraftField(s, 'lugar', `Habitación ${num}`);
      return { success: true, lugar: `Habitación ${num}` };
    }
    
    // ═══════════════════════════════════════════════════════════════
    // FIX: NO aceptar cualquier texto como lugar
    // Solo aceptar si opts.strictMode está desactivado Y parece lugar
    // ═══════════════════════════════════════════════════════════════
    
    if (opts.strictMode) {
      // En modo estricto, no aceptar texto no reconocido
      return { success: false, originalInput: placeText, reason: 'not_recognized' };
    }
    
    // Verificar si el texto parece un lugar válido antes de aceptarlo
    const looksLikePlace = isLikelyPlaceText(placeText);
    
    if (looksLikePlace) {
      setDraftField(s, 'lugar', placeText);
      return { success: true, lugar: placeText, via: 'fallback' };
    }
    
    // No parece lugar, no aceptar
    return { success: false, originalInput: placeText, reason: 'not_a_place' };
    
  } catch (e) {
    if (DEBUG) console.warn('[NI] normalizeAndSetLugar error', e?.message);
    // En error, no aceptar automáticamente
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

  // Allowed area codes (mayúsculas para normalizar)
  const ALLOWED = new Set(['RS', 'AMA', 'MAN', 'IT', 'SEG']);

  // 1) Validar campos mínimos
  if (!hasRequiredDraft(s.draft)) {
    if (!silent) await replySafe(msg, '❌ Faltan datos para enviar el ticket.');
    return { success: false, error: 'missing_fields' };
  }

  // 2) Normalizar / validar area_destino
  const rawArea = s.draft?.area_destino || '';
  let normArea = null;
  try {
    // intenta normalizeAreaCode si existe
    if (typeof normalizeAreaCode === 'function') normArea = normalizeAreaCode(rawArea);
  } catch (e) {
    if (DEBUG) console.warn('[NI] normalizeAreaCode error', e?.message);
    normArea = null;
  }
  // fallback directo y normalización a mayúsculas
  const areaToUse = (normArea || rawArea || '').toString().trim().toUpperCase();

  if (!areaToUse || !ALLOWED.has(areaToUse)) {
    if (!silent) await replySafe(msg, '❌ Área destino inválida. Usa: RS, AMA, MAN, IT o SEG.');
    if (DEBUG) console.warn('[NI] invalid area_destino', { rawArea, normArea, areaToUse });
    return { success: false, error: 'invalid_area', rawArea, normArea, areaToUse };
  }

  // aseguramos el campo en el draft con la forma esperada
  s.draft.area_destino = areaToUse;

  // 3) Intentar persistir incidente
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
      status: 'open',
      timestamp: Date.now(),
      created_at: new Date().toISOString(),
    });
  } catch (e) {
    if (DEBUG) console.error('[NI] persistIncident error', e);
    if (!silent) await replySafe(msg, '❌ Error al guardar el ticket. Intenta de nuevo.');
    // no resetSession: mantener la sesión para investigar / reintentar
    return { success: false, error: 'persist_error', message: e?.message };
  }

  const folio = incident?.folio || `INC-${Date.now()}`;
  const incidentId = incident?.id;

  // 4) Adjuntos (si hay)
  if (incidentId && Array.isArray(s._pendingMedia) && s._pendingMedia.length > 0) {
    try {
      const attachments = s._pendingMedia.map((m, i) => ({
        filename: m.filename || `attachment_${i + 1}`,
        mimetype: m.mimetype,
        data: m.data,
      }));
      await appendIncidentAttachments(incidentId, attachments);
    } catch (e) {
      // attachments fallaron: incident ya creado, pero informamos y retornamos fallo
      if (DEBUG) console.warn('[NI] attachments save error', e?.message);
      if (!silent) await replySafe(msg, '❌ Error al guardar adjuntos. El ticket fue creado, pero los adjuntos no se guardaron.');
      return { success: false, error: 'attachments_error', message: e?.message, folio, id: incidentId };
    }
  }

  // 5) Enviar a grupos (primera media)
  let primaryId, ccIds;
  try {
    const cfg = await loadGroupsConfig();
    const resolved = resolveTargetGroups(s.draft, cfg) || {};
    primaryId = resolved.primaryId;
    ccIds = resolved.ccIds;
  } catch (e) {
    if (DEBUG) console.warn('[NI] load/resolve groups error', e?.message);
    // No fatal: devolvemos ticket creado pero sin dispatch
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
      // Intentamos registrar evento fallido si es posible
      try {
        if (incidentId) await appendDispatchedToGroupsEvent(incidentId, { primaryId, ccIds, error: e?.message, success: false });
      } catch (ee) {
        if (DEBUG) console.warn('[NI] appendDispatchedToGroupsEvent error', ee?.message);
      }
      return { success: false, error: 'dispatch_error', message: e?.message, folio, id: incidentId };
    }

    // registrar evento dispatch OK
    if (incidentId) {
      try {
        await appendDispatchedToGroupsEvent(incidentId, { primaryId, ccIds, success: true });
      } catch (e) {
        if (DEBUG) console.warn('[NI] dispatch event save error', e?.message);
        // no fatal: avisamos pero no bloqueamos el éxito final
      }
    }
  }

  // 6) Éxito total: actualizar sesión y responder
  s._lastCreatedTicket = { id: incidentId, folio, area_destino: s.draft.area_destino, createdAt: Date.now() };

  if (!silent) await replySafe(msg, `✅ *Ticket creado:* ${folio}\n\nTe avisaré cuando haya novedades.`);

  // limpiar sesión solo cuando todo haya sido exitoso Y NO estamos en modo batch (silent)
  // En modo batch, el handler de múltiples tickets se encarga de limpiar al final
  if (!silent) {
    try { resetSession(s.chatId); } catch (e) { if (DEBUG) console.warn('[NI] resetSession error', e?.message); }
  }

  return { success: true, folio, id: incidentId };
}

// FIND STRONG PLACE SIGNALS (igual que antes)
function findStrongPlaceSignals(text) {
  const patterns = [
    /\b(?:hab(?:itaci[oó]n)?|room|villa|cuarto)\s*#?(\d{3,4})\b/i,
    /\b(?:en\s+(?:la\s+)?)?(\d{4})\b/,
    /\b(?:front\s*desk|lobby|alberca|pool|gym|gimnasio|spa|restaurante|bar|estacionamiento|parking|pasillo|elevador)\b/i,
  ];
  for (const rx of patterns) {
    const m = text.match(rx);
    if (m) {
      const numMatch = (m[1] || m[0]).match(/\d{3,4}/);
      if (numMatch) return { value: `Habitación ${numMatch[0]}`, type: 'room', raw: m[0] };
      return { value: m[0], type: 'area', raw: m[0] };
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
  const editingActive = Boolean(s._multipleEditing || s._editingTarget || s.mode?.startsWith('edit_') || s._isEditingMultiple || s._editingTicketNum !== undefined);
  const t = norm(text);
  if (t === 'listo' || t === 'ok') return false;
  if (isShort && !expectsConfirmation && isSessionBareForNI(s) && !editingActive) return { bare: true, isYesToken, isNoToken };
  if (isShort && expectsConfirmation && !editingActive) return { passToHandler: true };
  return false;
}

// MAIN: signature: handleTurn(client, msg, { catalogPath })
async function handleTurn(client, msg, { catalogPath } = {}) {
  if (!msg) return;

  // anti double
  if (msg.__niTurnHandled === true) return;
  msg.__niTurnHandled = true;

  const chatId = msg.from;
  const text = (msg.body || '').trim();

  try { ensureReady(); } catch (e) { if (DEBUG) console.warn('[NI] ensureReady err', e?.message || e); }
  try { await loadLocationCatalogIfNeeded(catalogPath); } catch (e) { if (DEBUG) console.warn('[NI] loadLocationCatalogIfNeeded err', e?.message || e); }

  // session
  const s = ensureSession(chatId);

  if (DEBUG) console.log('[NI] handleTurn', { chatId, text: text?.substring(0, 120), mode: s.mode, hasMedia: !!msg.hasMedia });

  // MEDIA batching
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
    } catch (e) { if (DEBUG) console.warn('[NI] media download error', e?.message); }
  }

  // GLOBAL YES/NO GATE (before dispatch)
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

  // BUILD ctx for handlers
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
    // IA edit interpreter + optional ai wrapper + key
    interpretEditMessage,
    aiChat: (typeof global !== 'undefined' && global.aiChat) ? global.aiChat : null,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY || null,
    DEBUG: DEBUG,
    // include formatPreviewMessage explicitly
    formatPreviewMessage,
    // include normalizeAreaCode
    normalizeAreaCode,
  };

  // defensive fallbacks
  ctx.setDraftField = ctx.setDraftField || setDraftField;
  ctx.addArea = ctx.addArea || addArea;
  ctx.removeArea = ctx.removeArea || removeArea;
  ctx.replaceAreas = ctx.replaceAreas || replaceAreas;
  ctx.resetSession = ctx.resetSession || resetSession;
  ctx.touch = ctx.touch || touch;
  ctx.pushTurn = ctx.pushTurn || pushTurn;
  ctx.finalizeAndDispatch = ctx.finalizeAndDispatch || finalizeAndDispatch;
  ctx.interpretEditMessage = ctx.interpretEditMessage || interpretEditMessage;

  // defensive fallback for formatPreviewMessage if not available or not a function
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

  // dispatch to handler
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
    // Cambiado: al captar un error en un handler, informamos y NO delegamos automáticamente al neutral
    console.error('[NI] handler error', { mode: s.mode, error: e?.message, stack: e?.stack });
    try {
      await replySafe(msg, '⚠️ Ocurrió un error al procesar tu mensaje en este modo. Intenta de nuevo o escribe *cancelar* para salir del modo edición.');
    } catch (er) { if (DEBUG) console.warn('[NI] reply on handler error failed', er?.message); }
    return;
  }

  // fallback to neutral handler sólo si el handler no devolvió handled=true
  if (s.mode !== 'neutral') {
    if (DEBUG) console.log('[NI] falling back to neutral handler');
    try {
      const neutralHandler = getHandler('neutral');
      await neutralHandler(ctx);
    } catch (e) { if (DEBUG) console.error('[NI] neutral handler error', e?.message); }
  }
}

module.exports = { handleTurn };
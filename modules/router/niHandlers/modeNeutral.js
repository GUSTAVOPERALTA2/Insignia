/**
 * niHandlers/modeNeutral.js
 * Handler para modo neutral/preview:
 * - Usa IA para extraer incidentes estructurados cuando hay múltiples problemas
 * - Fallback heurístico si la IA no devuelve múltiples incidentes
 * - Hereda lugar entre fragmentos
 * - Crea s._multipleTickets con borradores completos y delega la presentación
 *   del menú al handler `multiple_tickets`
 *
 * ✅ FIX 2026-01:
 *   Si llega MEDIA + TEXTO (caption/body), NO regresar temprano a handleMediaInNeutral.
 *   Priorizar el texto y solo tratar como "media-only" cuando NO hay texto.
 */

const {
  DEBUG,
  norm,
  formatPreviewMessage,
  hasRequiredDraft,
  isVagueText,
  isSessionBareForNI,
  ensureMediaBatch,
  cleanDescription,
} = require('./shared');

// ✅ Desambiguación “alberca/piscina” genérico (sin tocar placeExtractor)
function isGenericPoolLugar(lugarLabel) {
  const l = (lugarLabel || '').toLowerCase().trim();
  return l === 'alberca / piscina (genérico)'.toLowerCase();
}

function userSaidPoolGeneric(text) {
  const t = (text || '').toLowerCase();
  const saidPool = /\b(alberca|piscina|pool)\b/.test(t);
  const specified = /\b(familiar|adult|adultos|principal|main|kids|niños)\b/.test(t);
  return saidPool && !specified;
}

function buildPoolCandidates() {
  return [
    { label: 'Alberca Familiar', via: 'disambiguation', score: 100 },
    { label: 'Alberca de Adultos (Adults Pool)', via: 'disambiguation', score: 100 },
    { label: 'Alberca Principal', via: 'disambiguation', score: 100 },
  ];
}

async function askPoolDisambiguation(ctx) {
  const { s, msg, replySafe, setMode } = ctx;

  s._placeCandidates = buildPoolCandidates();
  setMode(s, 'choose_place_from_candidates');

  const list = s._placeCandidates.map((c, i) => `${i + 1}. *${c.label}*`).join('\n');

  await replySafe(
    msg,
    `🤔 ¿A cuál *alberca* te refieres?\n\n` +
      `${list}\n\n` +
      `Responde el *número* (1, 2, 3).`
  );

  return true;
}

/**
 * Heurística para dividir texto en problemas cuando la IA no ayuda.
 */
function splitMultipleProblemsHeuristic(text) {
  if (!text || typeof text !== 'string') return [];

  // -------------------------
  // 0) Helpers extra: filtrar saludos / pegar continuaciones
  // -------------------------
  const isGreetingLine = (s) => {
    const t = String(s || '').trim().toLowerCase();
    if (!t) return true;

    // "hola", "hola team", "buenos días", "equipo", etc.
    const rx = /^(hola|hey|buen(as|os)\s+(d(i|í)as|tardes|noches)|equipo|team|hola\s+team|hola\s+equipo)[\s!,.:-]*$/i;
    if (rx.test(t)) return true;

    // saludos muy cortos (sin señal de problema)
    if (t.length <= 10 && !hasProblemSignal(t)) return true;

    return false;
  };

  const isListMarkerLine = (s) => {
    const t = String(s || '').trim();
    return /^([-•*]|(\d+[\)\.]))\s+/.test(t);
  };

  const shouldTreatNewlineAsSeparator = (original) => {
    // Si hay bullets o enumeración, sí separa por líneas.
    const lines = String(original || '').split(/\n+/).map(x => x.trim()).filter(Boolean);
    if (lines.some(isListMarkerLine)) return true;

    // Si hay conectores fuertes explícitos, sí.
    if (/\b(adem[aá]s|y\s+tambi[eé]n|por\s+otro\s+lado|otra\s+cosa)\b/i.test(original)) return true;

    // Si no, NO uses \n como separador fuerte (evita "Hola\nProblema\nDetalle")
    return false;
  };

  const mergeContinuations = (arr) => {
    const out = [];
    for (const piece of arr) {
      const p = String(piece || '').trim();
      if (!p) continue;

      // eliminar saludos sueltos
      if (isGreetingLine(p)) continue;

      // si este fragmento NO trae señal clara de incidente,
      // y el anterior sí, probablemente es continuación -> pegar
      const prev = out[out.length - 1];
      if (prev && hasProblemSignal(prev) && !hasProblemSignal(p)) {
        out[out.length - 1] = `${prev} ${p}`.trim();
        continue;
      }

      // Heurística: "No se..." / "No hay..." / "No funciona..." suele ser continuación
      // si el fragmento anterior ya menciona el objeto (TV, AC, etc.)
      if (prev && /^no\s+(se|hay|funciona|sirve|prende|enciende|sale|llega)\b/i.test(p)) {
        out[out.length - 1] = `${prev} ${p}`.trim();
        continue;
      }

      out.push(p);
    }
    return out;
  };

  // -------------------------
  // 1) Proteger patrones ":" que NO deben dividir
  // -------------------------
  const protect = (s) => {
    const TIME_TOKEN = '__TIME_COLON__';
    const IPPORT_TOKEN = '__IPPORT_COLON__';

    // IP:puerto
    s = s.replace(
      /\b(\d{1,3}(?:\.\d{1,3}){3}):(\d{1,5})\b/g,
      (_m, ip, port) => `${ip}${IPPORT_TOKEN}${port}`
    );

    // Hora hh:mm
    s = s.replace(
      /\b(\d{1,2}):(\d{2})\b/g,
      (_m, hh, mm) => `${hh}${TIME_TOKEN}${mm}`
    );

    return { s, TIME_TOKEN, IPPORT_TOKEN };
  };

  const restore = (s, TIME_TOKEN, IPPORT_TOKEN) => {
    return s
      .replace(new RegExp(TIME_TOKEN, 'g'), ':')
      .replace(new RegExp(IPPORT_TOKEN, 'g'), ':');
  };

  const { s: protectedText, TIME_TOKEN, IPPORT_TOKEN } = protect(text);

  // -------------------------
  // 2) Helpers de “smart y”
  // -------------------------
  const stripCourtesy = (s) => {
    return (s || '')
      .replace(/\b(por\s+favor|pls|porfa|gracias|grax|ok|vale|de\s+favor)\b\.?$/i, '')
      .replace(/\s{2,}/g, ' ')
      .trim();
  };

  function hasProblemSignal(s) {
    const t = (s || '').toLowerCase();

    const verbish =
      /\b(no\s+funciona|no\s+sirve|no\s+prende|no\s+enciende|no\s+hay|no\s+sale|no\s+llega|se\s+rompi[oó]|se\s+descompuso|se\s+cay[oó]|se\s+ator[oó]|se\s+tap[oó]|gotea|fuga|huele|ruido|vibra|tir[aá]\s+agua|se\s+inund[aá]|error|fall[aó])\b/i;

    const request =
      /\b(solicita|solicito|necesito|necesitamos|requiero|requerimos|manden|enviar|traer|apoy(o|o\w*)|ayuda)\b/i;

    const nouns =
      /\b(limpieza|toallas?|s[aá]banas?|amenidades|basura|mantenimiento|aire\s+acondicionado|clima|agua\s+caliente|agua\s+fr[ií]a|regadera|ba[nñ]o|wc|inodoro|lavabo|drenaje|internet|wifi|tv|tel[eé]fono|llave|puerta|luz|foco|contacto|cortina|coladera|canales?)\b/i;

    return verbish.test(t) || request.test(t) || nouns.test(t);
  }

  const looksLikeListJoin = (left, right) => {
    const tL = (left || '').toLowerCase();
    const tR = (right || '').toLowerCase();

    const shortish = (s) => (s.trim().length <= 22);

    if (!hasProblemSignal(tL) && !hasProblemSignal(tR)) return true;

    const sameTopicPairs = [
      /\b(toallas?|s[aá]banas?|amenidades)\b/,
      /\b(ba[nñ]o|regadera|wc|inodoro|lavabo|drenaje|coladera)\b/,
      /\b(luz|foco|contacto)\b/,
      /\b(internet|wifi|tv|tel[eé]fono|canales?)\b/,
      /\b(puerta|llave|cerradura)\b/,
    ];

    const sharesTopic = sameTopicPairs.some((rx) => rx.test(tL) && rx.test(tR));

    if (sharesTopic && shortish(left) && shortish(right)) return true;
    if (/^(por\s+favor|gracias|ok|vale)\b/i.test(tR)) return true;

    return false;
  };

  const smartSplitByY = (chunk) => {
    const base = stripCourtesy(chunk);
    if (!base) return [];

    const pieces = base.split(/\s+y\s+/i).map(p => stripCourtesy(p)).filter(Boolean);
    if (pieces.length <= 1) return [restore(base, TIME_TOKEN, IPPORT_TOKEN)];

    const out = [];
    let acc = pieces[0];

    for (let i = 1; i < pieces.length; i++) {
      const next = pieces[i];

      const left = acc;
      const right = next;

      const leftOk = left.length >= 8 && hasProblemSignal(left);
      const rightOk = right.length >= 8 && hasProblemSignal(right);

      const shouldSplit = (leftOk && rightOk) && !looksLikeListJoin(left, right);

      if (shouldSplit) {
        out.push(restore(left, TIME_TOKEN, IPPORT_TOKEN));
        acc = right;
      } else {
        acc = `${acc} y ${right}`.trim();
      }
    }

    out.push(restore(acc, TIME_TOKEN, IPPORT_TOKEN));
    return out.map(s => s.trim()).filter(s => s.length > 0);
  };

  // -------------------------
  // 3) Separación “fuerte”
  //    ✅ IMPORTANTE: no partir por \n a menos que sea lista/conectores fuertes
  // -------------------------
  const strongSeps = [
    /\b(?:y\s+tambi[eé]n|adem[aá]s|tamb[ií]en\s+hay|y\s+adem[aá]s|y\s+otra\s+cosa|otra\s+cosa|adem[aá]s\s+de)\b/gi,
    /;\s*/g,
    /:\s*/g,          // ":" ya protegido para horas/ip:puerto
    /\s*•\s+/g,
  ];

  let parts = [protectedText];

  // separar por saltos de línea SOLO si aplica
  if (shouldTreatNewlineAsSeparator(text)) {
    parts = parts.flatMap(p => p.split(/\n+/g));
  } else {
    // si NO, convertimos \n en espacio para que "Hola\nProblema\nDetalle" sea 1 sola cosa
    parts = [protectedText.replace(/\n+/g, ' ')];
  }

  for (const sep of strongSeps) {
    parts = parts.flatMap(p => p.split(sep));
  }

  // -------------------------
  // 4) Aplicar smart "y" por cada chunk y limpiar
  // -------------------------
  const ignore = new Set(['y', 'tambien', 'hay', 'una', 'un', 'otra', 'cosa', 'ademas']);

  let out = parts
    .flatMap(p => smartSplitByY(p))
    .map(p => p.trim())
    .filter(p => {
      const clean = p.toLowerCase().replace(/[.,]/g, '').trim();
      return clean.length > 4 && !ignore.has(clean);
    })
    .map(p => p.replace(/^[y,\s. ]+/i, '').trim());

  // ✅ NUEVO: filtrar saludos y pegar continuaciones
  out = mergeContinuations(out);

  // ✅ Seguridad final: si después de limpiar quedó 0 o 1, retornar tal cual
  return out;
}

/**
 * Normaliza la respuesta multi-incidente de la IA al shape esperado por el sistema.
 * Espera: deriveIncidentText({ text, multi: true }) => { incidents: [{ description, lugar, area, original }] }
 */
function normalizeAiIncidents(aiResp, fallbackText) {
  if (!aiResp || !Array.isArray(aiResp.incidents) || aiResp.incidents.length === 0) {
    return null;
  }
  return aiResp.incidents.map((it) => {
    return {
      descripcion: (it.description || '').trim() || (fallbackText?.substring(0, 200) || ''),
      descripcion_original: it.original || it.description || fallbackText || '',
      lugar: it.lugar || it.locationLabel || null,
      area_destino: it.area || it.areaCode || null,
    };
  });
}

/**
 * Handler neutral principal
 */
async function handleNeutralMode(ctx) {
  const {
    s, msg, text, replySafe, setMode,
    detectArea, findStrongPlaceSignals, normalizeAndSetLugar,
    refreshIncidentDescription, autoAssignArea, deriveIncidentText,
  } = ctx;

  const t = (text || '').trim();
  const hasText = t.length > 0;
  const hasMedia = !!msg?.hasMedia;

  if (DEBUG) console.log('[NEUTRAL] processing', {
    hasText,
    hasMedia,
    mode: s.mode
  });

  // ✅ FIX: si hay media, primero asegura batch (adjuntos),
  // pero SOLO trata como "media-only" cuando NO hay texto.
  if (hasMedia) {
    if (typeof ensureMediaBatch === 'function') {
      try { await ensureMediaBatch(s, msg); }
      catch (e) { if (DEBUG) console.warn('[NEUTRAL] ensureMediaBatch err', e?.message); }
    }

    if (!hasText) {
      // media sin texto => pedir descripción
      return handleMediaInNeutral(ctx);
    }
    // si hay texto, seguimos al flujo normal (NO return)
  }

  if (!hasText) return false;

  // Si sesión vacía, aplicar guardes y tips
  if (isSessionBareForNI(s)) {
    if (ctx.classifyNiGuard) {
      try {
        const guardResult = await ctx.classifyNiGuard(t);
        if (guardResult?.isNotIncident) {
          if (DEBUG) console.log('[NEUTRAL] guard: not an incident', { text: t });
          const response = ctx.generateContextualResponse ? await ctx.generateContextualResponse(t) : null;
          if (response) {
            await replySafe(msg, response);
            return true;
          }
          await replySafe(msg,
            '👋 ¡Hola! Soy el bot de *incidencias* del hotel.\n\n' +
            'Si necesitas reportar algo que *no funciona* o está *dañado*, cuéntame qué pasó y dónde.\n\n' +
            '_Ejemplo: "No funciona el aire en hab 1205"_'
          );
          return true;
        }
      } catch (e) {
        if (DEBUG) console.warn('[NEUTRAL] guard error', e?.message);
      }
    }

    if (isVagueText(t)) {
      await replySafe(msg,
        '👋 Para reportar, dime:\n• *Qué* problema hay\n• *Dónde* está (ej: hab 1205)\n\n' +
        'Ejemplo: "No funciona el aire en hab 1205"'
      );
      return true;
    }
  }

  // 1) Intentar usar la IA para extraer múltiples incidentes estructurados
  let aiIncidents = null;
  try {
    if (deriveIncidentText) {
      if (DEBUG) console.log('[NEUTRAL] calling deriveIncidentText (multi: true)');
      const aiResp = await deriveIncidentText({ text: t, multi: true });
      aiIncidents = normalizeAiIncidents(aiResp, t);
      if (DEBUG) console.log('[NEUTRAL] deriveIncidentText multi result', { aiIncidents, raw: aiResp });
    }
  } catch (e) {
    if (DEBUG) console.warn('[NEUTRAL] deriveIncidentText error', e?.message);
  }

  // 2) Si la IA no entregó múltiples incidentes, fallback heurístico
  let problems = [];
  if (Array.isArray(aiIncidents) && aiIncidents.length > 0) {
    problems = aiIncidents;
  } else {
    if (DEBUG) console.log('[NEUTRAL] fallback to heuristic split');
    const parts = splitMultipleProblemsHeuristic(t);
    if (parts.length > 1) {
      const real = parts.filter(p => /no\s+sirve|no\s+funciona|necesito|apoyan|ayuda|falla|error|tv|wifi|aire|agua|baño|toallas?/i.test(p));
      if (real.length <= 1) {
        return handleNewIncident({ ...ctx, text: t });
      }
    }
    if (DEBUG) console.log('[NEUTRAL] heuristic split parts', { count: parts.length, parts });

    if (parts.length <= 1) {
      if (DEBUG) console.log('[NEUTRAL] single problem detected, calling handleNewIncident');
      return handleNewIncident({ ...ctx, text: t });
    }

    let lastKnownPlace = null;
    for (const p of parts) {
      const candidate = {
        descripcion_original: p,
        descripcion: p,
        lugar: null,
        area_destino: null,
      };

      try {
        const strong = findStrongPlaceSignals ? findStrongPlaceSignals(p) : null;
        if (strong && strong.value) {
          candidate.lugar = strong.value;
          lastKnownPlace = strong.value;
        } else if (lastKnownPlace) {
          candidate.lugar = lastKnownPlace;
        }
      } catch (e) {
        if (DEBUG) console.warn('[NEUTRAL] findStrongPlaceSignals error', e?.message);
      }

      try {
        const areaResult = detectArea ? await detectArea(p) : null;
        if (areaResult?.area) candidate.area_destino = areaResult.area;
      } catch (e) {
        if (DEBUG) console.warn('[NEUTRAL] detectArea error', e?.message);
      }

      problems.push(candidate);
    }
  }

  if (DEBUG) console.log('[NEUTRAL] final problems list', { count: problems.length });

  // --- Evitar sobreescritura: si ya existe un draft activo, preservarlo en _multipleTickets ---
  if (!Array.isArray(s._multipleTickets)) s._multipleTickets = [];

  // Si hay un draft con datos válidos y no está ya en _multipleTickets, moverlo primero.
  try {
    const hasDraftContent = s.draft && Object.keys(s.draft).length > 0 && (s.draft.descripcion || s.draft.lugar || s.draft.area_destino);
    if (hasDraftContent) {
      // Evitar duplicar si el draft ya tiene _migrated flag
      if (!s.draft._migratedToMultiple) {
        const existing = {
          descripcion_original: s.draft.descripcion_original || s.draft.descripcion || '',
          descripcion: (s.draft.descripcion && typeof cleanDescription === 'function') ? cleanDescription(s.draft.descripcion) : (s.draft.descripcion || ''),
          lugar: s.draft.lugar || null,
          area_destino: s.draft.area_destino || null,
          _ticketNum: s._multipleTickets.length + 1
        };
        s._multipleTickets.push(existing);
        // marcar para que no se vuelva a migrar
        s.draft._migratedToMultiple = true;
        if (DEBUG) console.log('[NEUTRAL] migrated existing draft into _multipleTickets', { ticketNum: existing._ticketNum });
      }
    }
  } catch (e) {
    if (DEBUG) console.warn('[NEUTRAL] error migrating existing draft', e?.message);
  }

  // Añadir los nuevos borradores derivados (no reemplazar los existentes)
  for (const raw of problems) {
    const draft = {};
    draft.descripcion_original = raw.descripcion_original || raw.descripcion || t;
    draft.descripcion = (raw.descripcion && typeof cleanDescription === 'function') ? cleanDescription(raw.descripcion) : (raw.descripcion || draft.descripcion_original);
    draft.lugar = raw.lugar || null;
    draft.area_destino = raw.area_destino || null;

    // intentar extraer lugar si no viene del raw
    if (!draft.lugar && findStrongPlaceSignals) {
      try {
        const strong = findStrongPlaceSignals(draft.descripcion_original);
        if (strong && strong.value) draft.lugar = strong.value;
      } catch (e) {
        if (DEBUG) console.warn('[NEUTRAL] findStrongPlaceSignals fallback error', e?.message);
      }
    }

    // normalizar lugar si hay helper
    if (draft.lugar && typeof normalizeAndSetLugar === 'function') {
      try {
        const normRes = await normalizeAndSetLugar(s, msg, draft.lugar, { fromMultiple: true });
        if (normRes && (normRes.lugar || normRes.label || normRes.canonical_label)) {
          draft.lugar = normRes.lugar || normRes.label || normRes.canonical_label;
        }
      } catch (e) {
        if (DEBUG) console.warn('[NEUTRAL] normalizeAndSetLugar error', e?.message);
      }
    }

    // ✅ Si en multi quedó alberca genérica, pedir aclaración (detener y preguntar)
    if (userSaidPoolGeneric(draft.descripcion_original) && isGenericPoolLugar(draft.lugar)) {
      s.draft = {
        descripcion: draft.descripcion,
        descripcion_original: draft.descripcion_original,
        lugar: null,
        area_destino: draft.area_destino || null,
        areas: draft.area_destino ? [draft.area_destino] : [],
      };
      return await askPoolDisambiguation(ctx);
    }

    // segunda pasada para área si falta
    if (!draft.area_destino && detectArea) {
      try {
        const ares = await detectArea(draft.descripcion);
        if (ares?.area) draft.area_destino = ares.area;
      } catch (e) {
        if (DEBUG) console.warn('[NEUTRAL] detectArea second pass error', e?.message);
      }
    }

    draft._ticketNum = s._multipleTickets.length + 1;
    s._multipleTickets.push(draft);
  }

  s._multipleEditing = null;

  if (DEBUG) console.log('[NEUTRAL] setting mode to multiple_tickets and delegating', { totalPending: s._multipleTickets.length });
  setMode(s, 'multiple_tickets');

  // Ejecutar el handler inmediatamente si existe
  try {
    const { getHandler } = require('./index');
    const multiHandler = getHandler ? getHandler('multiple_tickets') : null;
    if (typeof multiHandler === 'function') {
      if (DEBUG) console.log('[NEUTRAL] calling multiple_tickets handler directly');
      return await multiHandler(ctx);
    }
  } catch (e) {
    if (DEBUG) console.warn('[NEUTRAL] error calling multiple_tickets handler directly', e?.message);
  }

  return true;
}

/**
 * Mínimas funciones de manejo de media
 */
async function handleMediaInNeutral(ctx) {
  if (ctx._legacyHandleMedia) {
    return ctx._legacyHandleMedia(ctx);
  }
  const { s, msg, replySafe } = ctx;

  if (typeof ensureMediaBatch === 'function') {
    try { await ensureMediaBatch(s, msg); }
    catch (e) { if (DEBUG) console.warn('[NEUTRAL] ensureMediaBatch err', e?.message); }
  }

  await replySafe(msg, '📎 archivo recibido. Cuéntame qué problema muestra y dónde está.');
  return true;
}

/**
 * Flujo para un solo incidente
 */
async function handleNewIncident(ctx) {
  const {
    s, msg, text, replySafe, setMode, setDraftField, addArea,
    detectArea, findStrongPlaceSignals, normalizeAndSetLugar,
    refreshIncidentDescription, autoAssignArea
  } = ctx;

  const t = (text || '').trim();
  if (!t) return false;

  if (DEBUG) console.log('[NEUTRAL] processing new incident', { text: t?.substring(0, 120) });

  s.draft = s.draft || {};
  s.draft.descripcion = t;
  s.draft.descripcion_original = t;

  const strongPlace = findStrongPlaceSignals ? findStrongPlaceSignals(t) : null;
  if (strongPlace && strongPlace.value && typeof normalizeAndSetLugar === 'function') {
    try {
      const res = await normalizeAndSetLugar(s, msg, strongPlace.value, { rawText: t });
      if (res && (res.lugar || res.label || res.canonical_label)) {
        s.draft.lugar = res.lugar || res.label || res.canonical_label;
      }
    } catch (e) {
      if (DEBUG) console.warn('[NEUTRAL] normalizeAndSetLugar (new incident) error', e?.message);
    }
  } else if (strongPlace && strongPlace.value) {
    s.draft.lugar = strongPlace.value;
  }

  // ✅ Si quedó alberca/piscina genérico, pedir aclaración y NO avanzar a preview/confirm
  if (userSaidPoolGeneric(t) && isGenericPoolLugar(s.draft.lugar)) {
    s.draft.lugar = null;
    return await askPoolDisambiguation(ctx);
  }

  try {
    if (detectArea) {
      const areaResult = await detectArea(t);
      if (areaResult?.area) {
        if (typeof setDraftField === 'function') setDraftField(s, 'area_destino', areaResult.area);
        if (typeof addArea === 'function') addArea(s, areaResult.area);
      }
    }
  } catch (e) {
    if (DEBUG) console.warn('[NEUTRAL] detectArea error', e?.message);
  }

  if (!s.draft.area_destino && typeof autoAssignArea === 'function') {
    try { await autoAssignArea(s); }
    catch (e) { if (DEBUG) console.warn('[NEUTRAL] autoAssignArea err', e?.message); }
  }

  if (typeof refreshIncidentDescription === 'function') {
    try { await refreshIncidentDescription(s, t); }
    catch (e) { if (DEBUG) console.warn('[NEUTRAL] refreshIncidentDescription err', e?.message); }
  }

  const preview = formatPreviewMessage(s.draft);
  await replySafe(msg, preview);

  if (hasRequiredDraft(s.draft)) {
    setMode(s, 'confirm');
  } else if (!s.draft.lugar) {
    setMode(s, 'ask_place');
  } else if (!s.draft.area_destino) {
    setMode(s, 'choose_area_multi');
  } else {
    setMode(s, 'confirm');
  }

  return true;
}

/**
 * Export handler
 */
async function handleNeutral(ctx) {
  const { text, msg } = ctx;
  if ((text && String(text).trim()) || msg?.hasMedia) return handleNeutralMode(ctx);
  return false;
}

module.exports = { handleNeutral };

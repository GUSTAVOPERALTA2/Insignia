/**
 * niHandlers/modeNeutral.js
 * Handler para modo neutral/preview:
 * - Usa IA para extraer incidentes estructurados cuando hay múltiples problemas
 * - Fallback heurístico si la IA no devuelve múltiples incidentes
 * - Hereda lugar entre fragmentos
 * - Crea s._multipleTickets con borradores completos y delega la presentación
 *   del menú al handler `multiple_tickets`
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
    // quita coletillas típicas que NO deben crear tickets
    return (s || '')
      .replace(/\b(por\s+favor|pls|porfa|gracias|grax|ok|vale|de\s+favor)\b\.?$/i, '')
      .replace(/\s{2,}/g, ' ')
      .trim();
  };

  const hasProblemSignal = (s) => {
    const t = (s || '').toLowerCase();

    // verbos / estructuras de incidente
    const verbish =
      /\b(no\s+funciona|no\s+sirve|no\s+prende|no\s+enciende|no\s+hay|no\s+sale|no\s+llega|se\s+rompi[oó]|se\s+descompuso|se\s+cay[oó]|se\s+ator[oó]|se\s+tap[oó]|gotea|fuga|huele|ruido|vibra|tir[aá]\s+agua|se\s+inund[aá]|error|fall[aó])\b/i;

    // solicitudes explícitas
    const request =
      /\b(solicita|solicito|necesito|necesitamos|requiero|requerimos|manden|enviar|traer|apoy(o|o\w*)|ayuda)\b/i;

    // “cosas problema” (sustantivos típicos de reporte)
    const nouns =
      /\b(limpieza|toallas?|s[aá]banas?|amenidades|basura|mantenimiento|aire\s+acondicionado|clima|agua\s+caliente|agua\s+fr[ií]a|regadera|ba[nñ]o|wc|inodoro|lavabo|drenaje|internet|wifi|tv|tel[eé]fono|llave|puerta|luz|foco|contacto|cortina|coladera)\b/i;

    return verbish.test(t) || request.test(t) || nouns.test(t);
  };

  const looksLikeListJoin = (left, right) => {
    // Evitar dividir cuando es claramente una lista de sustantivos del MISMO asunto
    const tL = (left || '').toLowerCase();
    const tR = (right || '').toLowerCase();

    // si ambos son cortos y sin verbos fuertes → probablemente lista
    const shortish = (s) => (s.trim().length <= 22);

    // si ninguno trae señal de problema → no dividir
    if (!hasProblemSignal(tL) && !hasProblemSignal(tR)) return true;

    // casos típicos “X y Y” dentro del mismo reporte
    const sameTopicPairs = [
      /\b(toallas?|s[aá]banas?|amenidades)\b/,
      /\b(ba[nñ]o|regadera|wc|inodoro|lavabo|drenaje|coladera)\b/,
      /\b(luz|foco|contacto)\b/,
      /\b(internet|wifi|tv|tel[eé]fono)\b/,
      /\b(puerta|llave|cerradura)\b/,
    ];

    const sharesTopic = sameTopicPairs.some((rx) => rx.test(tL) && rx.test(tR));

    if (sharesTopic && shortish(left) && shortish(right)) return true;

    // “por favor / gracias” del lado derecho
    if (/^(por\s+favor|gracias|ok|vale)\b/i.test(tR)) return true;

    return false;
  };

  const smartSplitByY = (chunk) => {
    const base = stripCourtesy(chunk);
    if (!base) return [];

    // split tentativo
    const pieces = base.split(/\s+y\s+/i).map(p => stripCourtesy(p)).filter(Boolean);
    if (pieces.length <= 1) return [restore(base, TIME_TOKEN, IPPORT_TOKEN)];

    // reconstruir con decisión “smart”
    const out = [];
    let acc = pieces[0];

    for (let i = 1; i < pieces.length; i++) {
      const next = pieces[i];

      const left = acc;
      const right = next;

      const leftOk = left.length >= 8 && hasProblemSignal(left);
      const rightOk = right.length >= 8 && hasProblemSignal(right);

      // regla: separar si ambos lados parecen incidentes
      const shouldSplit = (leftOk && rightOk) && !looksLikeListJoin(left, right);

      if (shouldSplit) {
        out.push(restore(left, TIME_TOKEN, IPPORT_TOKEN));
        acc = right;
      } else {
        // no separar: pegamos de vuelta con " y "
        acc = `${acc} y ${right}`.trim();
      }
    }

    out.push(restore(acc, TIME_TOKEN, IPPORT_TOKEN));
    return out.map(s => s.trim()).filter(s => s.length > 0);
  };

  // -------------------------
  // 3) Separación “fuerte” primero (sin usar "y" directo)
  // -------------------------
  const strongSeps = [
    /\b(?:y\s+tambi[eé]n|adem[aá]s|tamb[ií]en\s+hay|y\s+adem[aá]s|y\s+otra\s+cosa|otra\s+cosa|adem[aá]s\s+de)\b/gi,
    /;\s*/g,
    /:\s*/g,          // ":" ya protegido para horas/ip:puerto
    /\n+/g,
    /\s*•\s+/g,
  ];

  let parts = [protectedText];
  for (const sep of strongSeps) {
    parts = parts.flatMap(p => p.split(sep));
  }

  // -------------------------
  // 4) Aplicar smart "y" por cada chunk y limpiar
  // -------------------------
  const ignore = new Set(['y', 'tambien', 'hay', 'una', 'un', 'otra', 'cosa', 'ademas']);

  return parts
    .flatMap(p => smartSplitByY(p))
    .map(p => p.trim())
    .filter(p => {
      const clean = p.toLowerCase().replace(/[.,]/g, '').trim();
      return clean.length > 4 && !ignore.has(clean);
    })
    .map(p => p.replace(/^[y,\s. ]+/i, '').trim());
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
    s, msg, text, replySafe, setMode, setDraftField, addArea,
    detectArea, findStrongPlaceSignals, normalizeAndSetLugar,
    refreshIncidentDescription, autoAssignArea, deriveIncidentText,
  } = ctx;

  if (DEBUG) console.log('[NEUTRAL] processing', {
    hasText: !!text,
    hasMedia: msg?.hasMedia,
    mode: s.mode
  });

  // Media first (delegamos a una función separada)
  if (msg?.hasMedia) {
    return handleMediaInNeutral(ctx);
  }

  if (!text) return false;

  // Si sesión vacía, aplicar guardes y tips
  if (isSessionBareForNI(s)) {
    if (ctx.classifyNiGuard) {
      try {
        const guardResult = await ctx.classifyNiGuard(text);
        if (guardResult?.isNotIncident) {
          if (DEBUG) console.log('[NEUTRAL] guard: not an incident', { text });
          const response = ctx.generateContextualResponse ? await ctx.generateContextualResponse(text) : null;
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

    if (isVagueText(text)) {
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
      const aiResp = await deriveIncidentText({ text, multi: true });
      aiIncidents = normalizeAiIncidents(aiResp, text);
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
    const parts = splitMultipleProblemsHeuristic(text);
    if (DEBUG) console.log('[NEUTRAL] heuristic split parts', { count: parts.length, parts });

    if (parts.length <= 1) {
      if (DEBUG) console.log('[NEUTRAL] single problem detected, calling handleNewIncident');
      return handleNewIncident(ctx);
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
          descripcion: cleanDescription ? cleanDescription(s.draft.descripcion || '') : (s.draft.descripcion || ''),
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
    draft.descripcion_original = raw.descripcion_original || raw.descripcion || text;
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
        // normalizeAndSetLugar puede devolver { success, lugar, label, canonical_label, ... }
        if (normRes && (normRes.lugar || normRes.label || normRes.canonical_label)) {
          draft.lugar = normRes.lugar || normRes.label || normRes.canonical_label;
        }
      } catch (e) {
        if (DEBUG) console.warn('[NEUTRAL] normalizeAndSetLugar error', e?.message);
      }
    }

    // ✅ Si en multi quedó alberca genérica, pedir aclaración (detener y preguntar)
    if (userSaidPoolGeneric(draft.descripcion_original) && isGenericPoolLugar(draft.lugar)) {
      // Guardamos lo que ya tenemos y pedimos aclaración sobre ESTE ticket
      s.draft = {
        descripcion: draft.descripcion,
        descripcion_original: draft.descripcion_original,
        lugar: null,
        area_destino: draft.area_destino || null,
        areas: draft.area_destino ? [draft.area_destino] : [],
      };
      // limpiar cola multi para evitar mezclas raras; opcional: mantenerlos si tu flujo lo requiere
      // s._multipleTickets = [];
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

  // IMPORTANTE: Para que el handler de multiple_tickets se ejecute INMEDIATAMENTE
  // después de cambiar el modo en el mismo turno, llamamos al handler directamente si existe.
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
    try { await ensureMediaBatch(s, msg); } catch (e) { if (DEBUG) console.warn('[NEUTRAL] ensureMediaBatch err', e?.message); }
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

  if (DEBUG) console.log('[NEUTRAL] processing new incident', { text: text?.substring(0, 120) });

  s.draft = s.draft || {};
  s.draft.descripcion = text;
  s.draft.descripcion_original = text;

  const strongPlace = findStrongPlaceSignals ? findStrongPlaceSignals(text) : null;
  if (strongPlace && strongPlace.value && typeof normalizeAndSetLugar === 'function') {
    try {
      // normalizeAndSetLugar puede mutar la sesión o devolver la normalización
      const res = await normalizeAndSetLugar(s, msg, strongPlace.value, { rawText: text });
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
  if (userSaidPoolGeneric(text) && isGenericPoolLugar(s.draft.lugar)) {
    s.draft.lugar = null;
    return await askPoolDisambiguation(ctx);
  }

  try {
    if (detectArea) {
      const areaResult = await detectArea(text);
      if (areaResult?.area) {
        if (typeof setDraftField === 'function') setDraftField(s, 'area_destino', areaResult.area);
        if (typeof addArea === 'function') addArea(s, areaResult.area);
      }
    }
  } catch (e) {
    if (DEBUG) console.warn('[NEUTRAL] detectArea error', e?.message);
  }

  if (!s.draft.area_destino && typeof autoAssignArea === 'function') {
    try { await autoAssignArea(s); } catch (e) { if (DEBUG) console.warn('[NEUTRAL] autoAssignArea err', e?.message); }
  }

  if (typeof refreshIncidentDescription === 'function') {
    try { await refreshIncidentDescription(s, text); } catch (e) { if (DEBUG) console.warn('[NEUTRAL] refreshIncidentDescription err', e?.message); }
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
  const { s, text, msg } = ctx;
  if (text || msg?.hasMedia) return handleNeutralMode(ctx);
  return false;
}

module.exports = { handleNeutral };

// modules/ai/dialogInterpreter.js
// Intérprete lingüístico: intención top-level y operaciones de turno (ops)
// Compatible con OpenAI Responses API (text.format + json_schema strict)

const { classifyGroupMessage } = require('../groups/groupUpdate');

const DEFAULT_MODEL = process.env.VICEBOT_AI_MODEL || 'gpt-4o-mini';
const TIMEZONE = process.env.VICEBOT_TZ || 'America/Mazatlan';
const DEBUG = (process.env.VICEBOT_DEBUG || '1') === '1';

let _OpenAI, _client;
async function client() {
  if (!_OpenAI) {
    try { _OpenAI = (await import('openai')).default; }
    catch { _OpenAI = null; }
  }
  if (!_client && _OpenAI && process.env.OPENAI_API_KEY) {
    _client = new _OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }
  return _client || null;
}

// ---------------- Utils ----------------
// OJO: ahora usamos helpers más conservadores para sí/no
const YES_RE = /^(s[ií]|si|sí|ok|okay|vale|va|de acuerdo|correcto|confirmo|enviar|listo|perfecto|dale)\b/i;
const NO_RE  = /^(no|nel|noup|negativo|cancel|cancela|mejor no|nah)\b/i;

// Frases típicas de problema que empiezan con "no ..." y NO deben contarse como "no" cortés
const PROBLEM_PREFIX_RE = /\b(no hay|no funciona|no sirve|no prende|no enciende|no jala|no carga|no sale|no llega)\b/i;

// Lista rápida de “palabras de problema” para evitar que las confundamos con sí/no cortés
const PROBLEM_CUES = [
  'no hay luz', 'no hay agua', 'no hay internet', 'no funciona', 'no sirve',
  'fuga', 'gotera', 'gotea', 'sin luz', 'sin agua', 'apagado', 'apagada',
  'averia', 'avería', 'fallo', 'falla'
];

function norm(s) {
  return (s || '')
    .toString()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9ñ\s]/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isProblemLike(text) {
  const t = norm(text || '');
  if (!t) return false;
  return PROBLEM_CUES.some(c => t.includes(norm(c)));
}

// NUEVO: versiones conservadoras de isYes / isNo
function isYes(raw) {
  const text = (raw || '').trim();
  if (!text) return false;

  const n = norm(text);
  // Si es muy largo, asumimos que no es simplemente "sí"
  if (n.length > 25) return false;
  if (isProblemLike(text)) return false;

  return YES_RE.test(text);
}

function isNo(raw) {
  const text = (raw || '').trim();
  if (!text) return false;

  const n = norm(text);
  // Si es muy largo, asumimos que no es simplemente "no"
  if (n.length > 25) return false;
  // Si parece frase de problema ("no hay luz...", "no funciona...") NO lo tratamos como "no"
  if (PROBLEM_PREFIX_RE.test(text) || isProblemLike(text)) return false;

  return NO_RE.test(text);
}

function uniq(arr) { return Array.from(new Set(arr || [])); }

// --- Saludos (ES/EN) ---
const GREET_RX = /\b(hola+|buenos? d[ií]as|buenas? tardes|buenas? noches|buen d[ií]a|hola buenas|saludos|qué tal|que tal|hey|hi+|hello+|good (morning|afternoon|evening))\b/i;

function looksGreeting(text) {
  const t = (text || '').trim();
  if (!t) return false;
  if (GREET_RX.test(t)) return true;
  if (/[👋🙋🤚✋]/.test(t)) return true;
  return false;
}

function isGreetingOnly(text) {
  const raw = (text || '').trim();
  if (!raw) return false;
  if (!looksGreeting(raw)) return false;

  let s = ' ' + norm(raw) + ' ';
  const phrases = [
    'hola', 'hola hola', 'hola buenas',
    'buenos dias', 'buen dia', 'buenas tardes', 'buenas noches',
    'saludos', 'que tal', 'qué tal', 'hey', 'hi', 'hello',
    'good morning', 'good afternoon', 'good evening',
    'hi there', 'hello there', 'hey there',
    'como estas', 'cómo estás', 'how are you', 'que onda', 'qué onda', 'todo bien'
  ];
  for (const p of phrases) {
    const rx = new RegExp(`\\b${p.replace(/\s+/g,'\\s+')}\\b`, 'gi');
    s = s.replace(rx, ' ');
  }
  s = s.replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim();
  return s.length === 0;
}

// ===== NUEVO: helpers de contexto Grupo y mapeo de intenciones ==========
function isGroupDestinationContext(ctx = {}) {
  // Marca cualquiera de estas flags según como llenes tu contexto
  return !!(
    ctx.isGroupDestination ||
    (ctx.chatType === 'group' && (ctx.groupIsDestination || ctx.isDestGroup))
  );
}

const MAP_GROUP_TO_TOP = {
  'T-L': 'L-I', // terminar ↦ completar/cerrar
  'T-C': 'C-I', // cancelar ↦ cancelar
  'T-P': 'OTRO',
  'OTRO': 'OTRO'
};
// ========================================================================

// -------------- Schemas (Strict) --------------
function topLevelSchema() {
  return {
    name: 'Vicebot_Dialog_Top_v1',
    strict: true,
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        intent: { type: 'string', enum: ['N-I','C-I','B-I-D','B-I-E','L-I','SALUDO','OTRO'] },
        confidence: { type: 'number', minimum: 0, maximum: 1 },
        rationale: { type: ['string','null'] },
        hints: {
          type: 'object',
          additionalProperties: false,
          properties: {
            maybeNI:   { type: 'boolean' },
            placeText: { type: ['string','null'] },
            areaText:  { type: ['string','null'] }
          },
          required: ['maybeNI','placeText','areaText']
        }
      },
      required: ['intent','confidence','rationale','hints']
    }
  };
}

function turnOpsSchema() {
  return {
    name: 'Vicebot_Dialog_Turn_v5',
    strict: true,
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        ops: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              op:    { type: 'string', enum: [
                'confirm','cancel','show_preview',
                'set_field',
                'replace_areas',
                'add_area',
                'remove_area',
                'append_detail'
              ]},
              field:  { type: ['string','null'] },
              value:  { type: ['string','null'] },
              values: {
                type: ['array','null'],
                items: { type: 'string', enum: ['it','man','ama','rs','seg'] }
              },
            },
            required: ['op','field','value','values']
          }
        },
        hints: {
          type: 'object',
          additionalProperties: false,
          properties: {
            placeText: { type: ['string','null'] },
            areaText:  { type: ['string','null'] },
            politeYes: { type: 'boolean' },
            politeNo:  { type: 'boolean' }
          },
          required: ['placeText','areaText','politeYes','politeNo']
        },
        analysis: { type: ['string','null'] },
        meta: {
          type: 'object',
          additionalProperties: false,
          properties: {
            is_new_incident_candidate: { type: 'boolean' },
            is_place_correction_only:  { type: 'boolean' }
          },
          required: ['is_new_incident_candidate','is_place_correction_only']
        }
      },
      required: ['ops','hints','analysis','meta']
    }
  };
}

// ---------------- Prompts ----------------
function buildTopLevelMessages({ text, context }) {
  const system =
`Eres el *intérprete top-level* de Vicebot (hotel).
Clasifica la intención del mensaje y da pistas suaves. NO normalizas catálogos.
TZ: ${TIMEZONE}.

INTENCIONES:
- N-I: reporte nuevo o solicitud a áreas operativas (IT, Mantenimiento, HSKP, Room Service, Seguridad).
- C-I: cancelar incidencia.
- B-I-D/E: buscar incidencia (detalle/estado).
- L-I: completar/cerrar.
- SALUDO: mensaje que es *solo* un saludo (ES/EN) sin otra petición.
- OTRO: charla o no operativo.

REGLA:
- Si hay saludo *y* contenido de incidencia, prioriza N-I (no SALUDO).

HINTS:
- placeText: fragmento libre de ubicación si aparece (“hab 1311”, “en front”, “casero”).
- areaText: fragmento libre de “para IT/Mantenimiento/HSKP/RS/Seguridad”.
- maybeNI: TRUE si suena a incidencia.

Responde SOLO JSON válido según el schema.`;

  return [
    { role:'system', content: system },
    { role:'user', content: JSON.stringify({ text, context }) }
  ];
}

function buildTurnMessages({ text, focus, draft }) {
  const system =
`Eres el *intérprete de turnos* de Vicebot.
Devuelves *ops* para modificar el borrador y *hints* para el router.
NO usas catálogos; solo lenguaje natural.

FOCUS:
- ask_place: el bot pide el lugar. Evita tomar “sí” como envío. Detecta correcciones de lugar.
- ask_area: el bot pide el área. Acepta “es para IT/man/ama/rs/seg”.
- preview/confirm: “sí” confirma, “no” cancela.
- confirm_area_suggestion: el bot sugirió un área destino y espera “sí/no” o que el usuario diga otra área.
- neutral: órdenes genéricas y cambios.

OPERACIONES:
- confirm / cancel / show_preview → field=null, value=null, values=null
- set_field {field,value}        → p.ej. field:'lugar', value:'Casero'
- replace_areas {values:[…]}     → reemplaza totalmente áreas (values=['it','man'])
- add_area {value:'it'}          → agrega una
- remove_area {value:'seg'}      → quita una
- append_detail {value:'…'}      → agrega un detalle sustancial (sintesis breve) a la descripcion.

LUGAR:
- Detecta parafraseos: “en ___”, “es en ___”, “era en ___”, “ahora en ___”, “perdón, en ___”,
  “cámbialo a ___”, “cambiar lugar a ___”, “cambia el lugar a ___”, “cambia el lugar por ___”.
  → op: set_field field:'lugar' value:'<texto breve>'
- Si usuario escribe solo un número de 4 dígitos (habitación) con focus=ask_place → set_field lugar a ese número.

ÁREA:
- “es/va/para/pon/pásalo a IT/HSKP/Mantenimiento/Room Service/Seguridad” → replace_areas con la lista normalizada.
- “solo IT” → replace_areas ['it']
- “también HSKP” → add_area 'ama'
- “quita Seguridad” → remove_area 'seg'
- Si hay alias confusos, deja texto en hints.areaText.

CONFIRMACIÓN:
- Solo si focus=preview|confirm. Evita confundir “sí, cambia a…” con confirm: si hay cambio + “sí”, prioriza el cambio.
- Si el usuario aporta información nueva (p.ej. “es la batería, favor de cambiarla”,
  “hay fuga de agua”, “no enciende el display”), emite append_detail en lugar de confirm.

META (muy importante):
Devuelve también un objeto "meta" con dos banderas:

- is_new_incident_candidate (boolean):
  TRUE si, considerando el borrador actual (draft.lugar, draft.descripcion),
  el mensaje parece un *nuevo incidente* independiente (otro problema o el mismo tipo de problema en otro lugar,
  redactado como reporte completo).

  Ejemplos para TRUE:
  - draft.lugar = "Habitación 1201", draft.descripcion = "no hay luz"
    text = "revisen la cafetera de villa 14" → es OTRO problema → TRUE
  - draft.lugar = "Habitación 1515"
    text = "ayuda no sirve la impresora de 2101" → problema distinto + otro lugar → TRUE

- is_place_correction_only (boolean):
  TRUE si el mensaje principalmente *corrige el lugar* del mismo ticket, sin cambiar la naturaleza del problema.
  Debe sonar a corrección o aclaración, NO a un incidente nuevo.

  Ejemplos para TRUE:
  - text = "perdón, era en 1203"
  - text = "no es en 1201, es en 1301"
  - text = "me equivoqué, es la villa 14, no la 12"

REGLAS:
- Nunca pongas ambos en TRUE a la vez.
- Si no aplica ninguno, usa FALSE en ambos.
- Si tienes duda entre los dos, prioriza marcar is_place_correction_only=TRUE (y el otro FALSE).

Para decidir META, considera también:
- draft.lugar (string o null)
- draft.descripcion (texto del ticket actual, si existe).

Incluye un breve *analysis* explicando qué entendiste del turno.
Responde SOLO JSON válido según el schema.`;

  const user = {
    text,
    focus, // 'ask_place' | 'ask_area' | 'preview' | 'confirm' | 'neutral' | 'confirm_area_suggestion'
    draft: {
      hasPlace: !!draft?.lugar,
      hasArea:  !!draft?.area_destino,
      lugar: draft?.lugar || null,
      descripcion: draft?.descripcion || null
    }
  };

  return [
    { role:'system', content: system },
    { role:'user', content: JSON.stringify(user) }
  ];
}

// -------------- API pública --------------

// ===== Ruta especial para GRUPOS destino ================================
// Si viene de un grupo destino, NO activamos N-I; usamos el clasificador
// y devolvemos una intención del set top-level (mapeada).
async function interpretTopLevel({ text, context = {}, draft = null }) {
  const t0 = Date.now();

  // 1) Ruta grupos destino
  if (isGroupDestinationContext(context)) {
    try {
      if (!classifyGroupMessage) throw new Error('groupUpdate/classifyGroupMessage no disponible');
      const r = await classifyGroupMessage(text || '');

      const mapped = MAP_GROUP_TO_TOP[r.intent] || 'OTRO';
      const out = {
        intent: mapped,
        confidence: Math.max(0.6, Number(r.confidence) || 0.5),
        rationale: `group:${r.intent} via ${r.source || 'heuristic'}`,
        hints: { maybeNI:false, placeText:null, areaText:null },
        _group: r // info de depuración
      };
      out._latency_ms = Date.now() - t0;
      out._model = 'groupUpdates';
      if (DEBUG) console.log('[INTENT GROUP]', out);
      return out;
    } catch (e) {
      // Fallback: nunca N-I en grupos; usa OTRO
      const out = {
        intent: 'OTRO',
        confidence: 0.5,
        rationale: `group-fallback: ${e?.message || e}`,
        hints: { maybeNI:false, placeText:null, areaText:null }
      };
      out._latency_ms = Date.now() - t0;
      out._model = 'groupUpdates';
      if (DEBUG) console.warn('[INTENT GROUP] err', e?.message || e);
      return out;
    }
  }

  // 2) Ruta normal (DMs / no-destino)
  const fallback = fastTopLevelHeuristic(text);
  try {
    const c = await client();
    if (!c) throw new Error('OpenAI client not available');

    const schema = topLevelSchema();
    const resp = await c.responses.create({
      model: DEFAULT_MODEL,
      input: buildTopLevelMessages({ text, context }),
      temperature: 0.2,
      max_output_tokens: 300,
      text: {
        format: {
          type: 'json_schema',
          name: schema.name,
          schema: schema.schema,
          strict: schema.strict
        }
      }
    });

    const data = resp.output_text ? JSON.parse(resp.output_text) : null;
    const out = data || fallback;
    out._latency_ms = Date.now() - t0;
    out._model = DEFAULT_MODEL;
    if (!out.hints) out.hints = { maybeNI:false, placeText:null, areaText:null };
    if (DEBUG) console.log('[INTENT AI] out', out);
    return out;
  } catch (e) {
    fallback.rationale = `fallback: ${e?.message || e}`;
    fallback._latency_ms = Date.now() - t0;
    fallback._model = DEFAULT_MODEL;
    if (DEBUG) console.warn('[INTENT AI] err', e?.message || e);
    return fallback;
  }
}
// ========================================================================

async function interpretTurn({ text, focus = 'neutral', draft = {} }) {
  const t0 = Date.now();
  const local = fastTurnHeuristic({ text, focus, draft });
  try {
    const c = await client();
    if (!c) throw new Error('OpenAI client not available');

    const schema = turnOpsSchema();
    const resp = await c.responses.create({
      model: DEFAULT_MODEL,
      input: buildTurnMessages({ text, focus, draft }),
      temperature: 0.2,
      max_output_tokens: 450,
      text: {
        format: {
          type: 'json_schema',
          name: schema.name,
          schema: schema.schema,
          strict: schema.strict
        }
      }
    });

    const ai = resp.output_text ? JSON.parse(resp.output_text) : null;
    const merged = mergeOps(local, ai);

    // Normalizar meta por seguridad
    if (!merged.meta) {
      merged.meta = {
        is_new_incident_candidate: false,
        is_place_correction_only: false
      };
    } else {
      merged.meta.is_new_incident_candidate = !!merged.meta.is_new_incident_candidate;
      merged.meta.is_place_correction_only = !!merged.meta.is_place_correction_only;
      if (merged.meta.is_new_incident_candidate && merged.meta.is_place_correction_only) {
        // Priorizamos tratarlo como corrección de lugar
        merged.meta.is_new_incident_candidate = false;
      }
    }

    merged._latency_ms = Date.now() - t0;
    merged._model = DEFAULT_MODEL;
    if (DEBUG) console.log('[TURN AI] merged', merged);
    return merged;
  } catch (e) {
    local.notes = `fallback: ${e?.message || e}`;
    if (!local.meta) {
      local.meta = {
        is_new_incident_candidate: false,
        is_place_correction_only: false
      };
    }
    local._latency_ms = Date.now() - t0;
    local._model = DEFAULT_MODEL;
    if (DEBUG) console.warn('[TURN AI] err', e?.message || e);
    return local;
  }
}

// -------------- Heurísticas locales --------------
function fastTopLevelHeuristic(text) {
  const raw = (text || '').trim();
  const N = norm(raw);

  // Heurística N-I
  const niWords = [
    'no hay','falla','fallo','averia','avería','no funciona','no sirve','no prende','no enciende','apagado','apagada',
    'daño','daños','rompio','rompió','se rompio','se rompió','gotea','gotera','fuga','sin luz','sin agua',
    'impresora','printer','internet','red','wifi','router','modem','módem',
    'tv','tele','television','televisión','pc','laptop','computadora','telefono','teléfono','extension','extensión',
    'limpieza','aseo','toalla','toallas','sabanas','sábanas','amenities','amenitys','retirar basura'
  ];
  const isNI = niWords.some(w => N.includes(norm(w)));
  const room4 = /\b\d{4}\b/.test(raw);
  const hasAreaAlias = /\b(it|sistemas?|mantenimiento|mant|manto|maintenance|hskp|ama|housek(?:ee)?ping|room ?service|rs|seguridad|seg)\b/i.test(raw);

  const greeting = looksGreeting(raw);
  const greetingOnly = isGreetingOnly(raw);

  let intent = 'OTRO';
  if (isNI || room4 || hasAreaAlias) {
    intent = 'N-I';
  } else if (greetingOnly) {
    intent = 'SALUDO';
  } else if (greeting) {
    intent = 'OTRO';
  }

  let placeText = null;
  const mRoom = raw.match(/\b\d{4}\b/);
  if (mRoom) placeText = mRoom[0];
  else if (/\b(hab|habitaci[oó]n|front|casero|cielomar|residencias?)\b/i.test(raw)) placeText = raw;

  const areaText = hasAreaAlias ? raw : null;

  return {
    intent,
    confidence: intent === 'OTRO' ? (greetingOnly ? 0.8 : 0.4) : 0.7,
    rationale: null,
    hints: { maybeNI: intent === 'N-I', placeText, areaText }
  };
}

function isSubstantiveDetail(raw) {
  const t = norm(raw || '');
  if (!t) return false;

  if (/^(si|sí|ok|okay|vale|va|de acuerdo|listo|perfecto|correcto|entendido|enterado)\b/.test(t)) return false;
  if (/^(no|nel|noup|nah|negativo)\b/.test(t)) return false;
  if (t.length < 10) return false;

  const cues = [
    'no funciona','no sirve','no prende','no enciende','falla','fallo','averia','avería',
    'bateria','batería','foco','lampara','lámpara','cambiar','reponer','sustituir',
    'fuga','gotea','goteo','filtra','rot','quebra','rajad','agriet',
    'apagado','encendido','ruido','vibra','golpeteo','huele','olor',
    'oxido','óxido','mancha','moho','humedad',
    'display','pantalla','cargador','tomacorriente','enchufe','contacto','breaker','disyuntor'
  ];

  return cues.some(c => t.includes(norm(c)));
}
function safeLugarValue(raw) {
  if (!raw) return null;
  let s = String(raw).trim();

  // descartar cosas claramente corruptas
  if (/[{}]/.test(s)) return null;

  // permitir letras, números, espacios, puntos, comas, guiones, paréntesis y acentos
  if (!/^[\w\sáéíóúÁÉÍÓÚñÑ0-9.,\-()]+$/.test(s)) return null;

  if (s.length > 80) s = s.slice(0, 80);
  return s || null;
}

function fastTurnHeuristic({ text, focus, draft }) {
  const raw = (text || '').trim();
  const ops = [];
  const hints = { placeText: null, areaText: null, politeYes: false, politeNo: false };

  const localMeta = {
    is_new_incident_candidate: false,
    is_place_correction_only: false
  };

  // 1) Sí / No cortés → hints + ops según el foco
  if (isYes(raw)) {
    hints.politeYes = true;
    // IMPORTANTE: ahora también considera confirm_area_suggestion
    if (focus === 'preview' || focus === 'confirm' || focus === 'confirm_area_suggestion') {
      ops.push({ op: 'confirm', field: null, value: null, values: null });
    }
  } else if (isNo(raw)) {
    hints.politeNo = true;
    // OJO: en confirm_area_suggestion NO auto-cancelamos,
    // solo en preview/confirm "clásicos"
    if (focus === 'preview' || focus === 'confirm') {
      ops.push({ op: 'cancel', field: null, value: null, values: null });
    }
  }

  // 2) ask_place: número de 4 dígitos
  if (focus === 'ask_place') {
    const rm = raw.match(/\b\d{4}\b/);
    if (rm) {
      const val = safeLugarValue(rm[0]);
      if (val) {
        ops.push({ op: 'set_field', field: 'lugar', value: val, values: null });
        hints.placeText = val;
      }
    }
  }

  // 3) neutral: heurística lugar+detalle (ej. "3401 televisión congelada")
  if (focus === 'neutral') {
    const roomMatch = raw.match(/\b(\d{4})\b/);
    if (roomMatch) {
      const room = roomMatch[1];
      const place = safeLugarValue(room);
      if (place) {
        const idx = roomMatch.index != null ? roomMatch.index : raw.indexOf(room);
        const before = raw.slice(0, idx).trim();
        const after = raw.slice(idx + room.length).trim();

        let detailCandidate = null;
        // Preferimos texto después del número; si no hay, usamos lo de antes
        if (after.length > 3) detailCandidate = after;
        else if (before.length > 3) detailCandidate = before;

        if (detailCandidate) {
          const detail = cleanTail(detailCandidate);
          if (detail && detail.length >= 4) {
            ops.push({ op: 'set_field', field: 'lugar', value: place, values: null });
            ops.push({ op: 'append_detail', field: null, value: detail, values: null });
            hints.placeText = place;
            // Atajo: ya tenemos estructura clara, no seguimos generando más ops
            return {
              ops: dedupeOps(ops),
              hints,
              analysis: null,
              meta: {
                is_new_incident_candidate: false,
                is_place_correction_only: false
              }
            };
          }
        }
      }
    }
  }

  // 4) Cambios de lugar explícitos ("cambia el lugar a ___", "en ___", etc.)
  const placeCmd1 = /(cambia(?:r)?|corrige|ajusta|modifica|mueve|pasa).{0,20}\b(lugar|ubicaci[oó]n)\b.*?\b(?:a|por)\s+(.+)$/i;
  const m1 = raw.match(placeCmd1);
  if (m1 && m1[3]) {
    const val = safeLugarValue(cleanTail(m1[3]));
    if (val) {
      ops.push({ op: 'set_field', field: 'lugar', value: val, values: null });
      hints.placeText = val;
    }
  } else {
    const placeCmd2 = /\b(?:en|es en|era en|ahora en|perd[oó]n[, ]? ?en)\s+(.+)$/i;
    const m2 = raw.match(placeCmd2);
    if (m2 && m2[1]) {
      const val = safeLugarValue(cleanTail(m2[1]));
      if (val) {
        ops.push({ op: 'set_field', field: 'lugar', value: val, values: null });
        hints.placeText = val;
      }
    }
  }

  // 5) Manejo de áreas (para IT / Mantenimiento / HSKP / RS / Seguridad)
  if (/\b(para|es para|va para|solo|s[oó]lo|tamb[ií]en|quita)\b/i.test(raw)) {
    const rawAreas = extractAreasRaw(raw);

    if (/^\s*(?:solo|s[oó]lo)\b/i.test(raw)) {
      if (rawAreas.length) ops.push({ op: 'replace_areas', field: null, value: null, values: rawAreas });
    } else if (/\btamb[ií]en\b/i.test(raw)) {
      for (const a of rawAreas) ops.push({ op: 'add_area', field: null, value: a, values: null });
    } else if (/\bquita\b/i.test(raw)) {
      for (const a of rawAreas) ops.push({ op: 'remove_area', field: null, value: a, values: null });
    } else if (/\b(para|es para|va para)\b/i.test(raw)) {
      if (rawAreas.length) ops.push({ op: 'replace_areas', field: null, value: null, values: rawAreas });
    }

    const hint = raw.match(/\b(it|sistemas|mantenimiento|mant|manto|maintenance|hskp|ama|housek(?:ee)?ping|room ?service|rs|seguridad|seg)\b/i);
    if (hint) hints.areaText = hint[0];
  }

  // 6) ¿Es un detalle sustancial sin otros cambios estructurales?
  const alreadyHasStructuralChange =
    ops.some(o =>
      (o.op === 'set_field' && o.field === 'lugar') ||
      o.op === 'replace_areas' ||
      o.op === 'add_area' ||
      o.op === 'remove_area'
    );

  if (!isYes(raw) && !isNo(raw) && !alreadyHasStructuralChange && isSubstantiveDetail(raw)) {
    const detail = cleanTail(raw);
    if (detail) {
      ops.push({ op: 'append_detail', field: null, value: detail, values: null });
    }
  }

  // 7) Pedir preview explícito
  if (/preview|resumen|ver resumen|mostrar resumen/i.test(raw)) {
    ops.push({ op: 'show_preview', field: null, value: null, values: null });
  }

  // 8) META local: nuevo incidente vs corrección de lugar
  const hasDraft = !!(draft && (draft.lugar || draft.descripcion));
  if (hasDraft) {
    const draftLugar = draft.lugar || '';
    const draftRoomMatch = draftLugar.match(/\b(\d{4})\b/);
    const draftRoom = draftRoomMatch ? draftRoomMatch[1] : null;
    const msgRoomMatch = raw.match(/\b(\d{4})\b/);
    const msgRoom = msgRoomMatch ? msgRoomMatch[1] : null;

    const correctionCue = /(perd[oó]n|me equivoque|me equivoqué|no es en|era en|es en|ahora en|cambia(?:r)? el lugar|cambiar(?: el)? lugar)/i;

    // Heurística: corrección de lugar del mismo ticket
    if (
      draftRoom && msgRoom && draftRoom !== msgRoom &&
      correctionCue.test(raw) &&
      !isProblemLike(raw) &&
      raw.length <= 80
    ) {
      localMeta.is_place_correction_only = true;
      localMeta.is_new_incident_candidate = false;
    }

    // Heurística: nuevo incidente independiente
    const hasRoomOrLugar =
      !!msgRoom ||
      /\bhabitaci[oó]n\b|\bvilla\b|\bhab\b/i.test(raw);

    if (
      !localMeta.is_place_correction_only &&
      !localMeta.is_new_incident_candidate &&
      isProblemLike(raw) &&
      hasRoomOrLugar
    ) {
      // si hay ambas habitaciones y son distintas, lo marcamos fuerte como nuevo
      if (!draftRoom || !msgRoom || draftRoom !== msgRoom) {
        localMeta.is_new_incident_candidate = true;
      }
    }
  }

  return {
    ops: dedupeOps(ops),
    hints,
    analysis: null,
    meta: localMeta
  };
}

function cleanTail(s) {
  return String(s)
    .replace(/^(el|la|los|las|al|del|de la|de el)\s+/i,'')
    .replace(/\s*(porfa|por favor|gracias)\s*$/i,'')
    .replace(/[“”"']+/g,'')
    .trim();
}

function extractAreasRaw(t) {
  const s = norm(t);
  const out = [];
  const tests = [
    /\bit\b|\bsistemas?\b|\binformatic/i,
    /\bmantenimiento\b|\bmant\b|\bmanto\b|\bmaintenance\b/i,
    /\bhskp\b|\bama\b|\bhousek(?:ee)?ping\b/i,
    /\broom ?service\b|\brs\b|\bird\b/i,
    /\bseguridad\b|\bseg\b|\bvigil/i
  ];
  const labels = ['it','man','ama','rs','seg'];
  tests.forEach((rx, i) => { if (rx.test(s)) out.push(labels[i]); });
  return uniq(out);
}

function dedupeOps(ops) {
  const out = [];
  const seen = new Set();
  for (const op of ops || []) {
    const key = JSON.stringify(op);
    if (!seen.has(key)) { seen.add(key); out.push(op); }
  }
  return out;
}

// NUEVO: mergeOps ahora evita detalles duplicados y fusiona meta
function mergeOps(local, ai) {
  const base = {
    ops: [],
    hints: { placeText:null, areaText:null, politeYes:false, politeNo:false },
    analysis: null,
    meta: {
      is_new_incident_candidate: false,
      is_place_correction_only: false
    }
  };
  const L = local || base;
  const A = ai || base;

  const combined = [...(A.ops || []), ...(L.ops || [])];
  const ops = [];
  const seen = new Set();
  let hasDetail = false;

  for (const op of combined) {
    // Solo permitimos un append_detail (prioriza el primero, normalmente el de la IA)
    if (op.op === 'append_detail') {
      if (hasDetail) continue;
      hasDetail = true;
    }
    const key = JSON.stringify(op);
    if (seen.has(key)) continue;
    seen.add(key);
    ops.push(op);
  }

  const hints = {
    placeText: A?.hints?.placeText ?? L?.hints?.placeText ?? null,
    areaText:  A?.hints?.areaText  ?? L?.hints?.areaText  ?? null,
    politeYes: !!(A?.hints?.politeYes || L?.hints?.politeYes),
    politeNo:  !!(A?.hints?.politeNo  || L?.hints?.politeNo)
  };
  const analysis = A?.analysis ?? L?.analysis ?? null;

  // Fusionar meta: prioriza IA pero respeta fallback local
  const meta = {
    is_new_incident_candidate: !!(
      A?.meta?.is_new_incident_candidate ||
      L?.meta?.is_new_incident_candidate
    ),
    is_place_correction_only: !!(
      A?.meta?.is_place_correction_only ||
      L?.meta?.is_place_correction_only
    )
  };

  // Nunca ambos true: priorizamos corrección de lugar
  if (meta.is_new_incident_candidate && meta.is_place_correction_only) {
    meta.is_new_incident_candidate = false;
  }

  return { ops, hints, analysis, meta };
}

module.exports = {
  interpretTopLevel,
  interpretTurn,
  // (opcional) exporta helpers si te sirven en otro lado:
  _isGroupDestinationContext: isGroupDestinationContext,
  _mapGroupToTop: MAP_GROUP_TO_TOP
};

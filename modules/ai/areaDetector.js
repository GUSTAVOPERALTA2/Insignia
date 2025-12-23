// modules/ai/areaDetector.js
// Detección de ÁREA destino: it | man | ama | rs | seg
// - Alias & sinónimos (tolerante a faltas)
// - Puntuación por alias/hints + sinergias
// - Fuzzy (trigramas)
// - IA asistida (opcional) vía Responses API + Structured Outputs

const DEFAULT_MODEL = process.env.VICEBOT_AI_AREA_MODEL || 'gpt-4o-mini';
const USE_AI = String(process.env.VICEBOT_AI_AREA_USE_AI || '1') === '1';
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
function norm(s) {
  return (s || '')
    .toString()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9ñ\s]/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function uniq(arr) { return Array.from(new Set(arr || [])); }

// trigram similarity (0..1)
function trigramSim(a, b) {
  const A = norm(a);
  const B = norm(b);
  if (!A || !B) return 0;
  const grams = s => {
    const arr = [];
    const x = `  ${s} `;
    for (let i = 0; i < x.length - 2; i++) arr.push(x.slice(i, i + 3));
    return new Set(arr);
  };
  const s1 = grams(A), s2 = grams(B);
  let inter = 0;
  for (const t of s1) if (s2.has(t)) inter++;
  return inter / Math.max(s1.size, s2.size);
}

// ---------------- Área: alias y palabras indicio ----------------
const AREA = {
  it: {
    aliases: [
      'it','ti','sistema','sistemas','informática','informatica','soporte',
      'tecnologia','tecnología','tech','sistemas it','sistemas/it'
    ],
    hints: [
      'computadora','pc','laptop','equipo','teclado','mouse',
      'impresora','print','printer','toner','tóner',
      'internet','red','wifi','wi fi','modem','módem','router',
      'correo','email','cuenta','usuario','acceso',
      'tv','tele','television','televisión','proyector',
      'software','app','aplicacion','aplicación',
      // telefonía
      'telefono','teléfono','extension','extensión','linea','línea','conmutador','auricular'
    ]
  },
  man: {
    aliases: [
      'mantenimiento','manto','mant','maintenance','ingenieria','ingeniería','ing','ingenieria/manto'
    ],
    hints: [
      'fuga','gotera','gotea','tuberia','tubería','plomeria','plomería','llave de paso','cañeria','cañería','cisterna',
      'foco','lampara','lámpara','luz','apagador','contacto','break','corta',
      'puerta','bisagra','chapa','chapas','cerradura','candado',
      'pintura','pared','mueble','herreria','herrería','carpinteria','carpintería',
      'ac','a/c','aire','clima','termostato'
    ]
  },
  ama: {
    aliases: [
      'hskp','ama','ama de llaves','housekeeping','housekeping','housekeepin','ama-de-llaves'
    ],
    hints: [
      'limpieza','aseo','sucio','sucia','limpio','limpia',
      'toalla','toallas','sabanas','sábanas','blancos',
      'amenities','amenitys','shampoo','jabón','jabon',
      'cama','hacer la cama','quitar basura','papel','rollo'
    ]
  },
  rs: {
    aliases: [
      'room service','rs','ird','servicio a cuarto','servicio al cuarto','servicio de cuarto',
      'alimentos y bebidas','ayb','a&b','a y b'
    ],
    hints: [
      'desayuno','comida','cena','bebida','hielos','menú','menu',
      'orden','pedido','tomar orden','plato','postre'
    ]
  },
  seg: {
    aliases: [
      'seguridad','seg','guardia','vigilancia','vigilante','proteccion','protección'
    ],
    hints: [
      'incendio','fuego','alarma','robo','perdida','pérdida','extravio','extravío',
      'accidente','emergencia','cctv','camara','cámara','camara de seguridad',
      'acceso','intruso','pelea','disturbio'
    ]
  }
};

const AREA_ALIAS_N = Object.fromEntries(
  Object.entries(AREA).map(([code, obj]) => [
    code,
    {
      aliasesN: obj.aliases.map(norm),
      hintsN: obj.hints.map(norm)
    }
  ])
);

// ---------------- Normalizador directo ----------------
function normalizeAreaInput(text) {
  const t = norm(text);
  if (!t) return null;

  for (const [code, obj] of Object.entries(AREA_ALIAS_N)) {
    if (obj.aliasesN.includes(t)) return code;
    for (const al of obj.aliasesN) {
      if (t === al) return code;
      if (t.includes(` ${al} `) || t.startsWith(`${al} `) || t.endsWith(` ${al}`)) {
        return code;
      }
    }
  }

  // similitud hacia nombres canónicos
  const names = { it:'it sistemas', man:'mantenimiento', ama:'ama de llaves', rs:'room service', seg:'seguridad' };
  let best = { code:null, score:0 };
  for (const [code, name] of Object.entries(names)) {
    const s = trigramSim(t, name);
    if (s > best.score) best = { code, score: s };
  }
  if (best.score >= 0.82) return best.code;
  return null;
}

// ---------------- Scoring local ----------------
function scoreAreas(text) {
  const raw = text || '';
  const N = ` ${norm(raw)} `;

  const scores = { it:0, man:0, ama:0, rs:0, seg:0 };
  const reasons = { it:[], man:[], ama:[], rs:[], seg:[] };

  // alias y alias~ (fuzzy)
  for (const [code, obj] of Object.entries(AREA_ALIAS_N)) {
    for (const al of obj.aliasesN) {
      if (!al) continue;
      if (N.includes(` ${al} `) || N.startsWith(`${al} `) || N.endsWith(` ${al}`) || N === al) {
        scores[code] += 1.0;
        reasons[code].push(`alias:${al}`);
      } else {
        const s = trigramSim(N, ` ${al} `);
        if (s >= 0.88) {
          scores[code] += 0.6;
          reasons[code].push(`alias~:${al}:${s.toFixed(2)}`);
        }
      }
    }
  }

  // pistas (hints) y hints~ (fuzzy)
  for (const [code, obj] of Object.entries(AREA_ALIAS_N)) {
    for (const hint of obj.hintsN) {
      if (!hint) continue;
      if (N.includes(` ${hint} `)) {
        scores[code] += 0.35;
        reasons[code].push(`hint:${hint}`);
      } else {
        const s = trigramSim(N, ` ${hint} `);
        if (s >= 0.90) {
          scores[code] += 0.2;
          reasons[code].push(`hint~:${hint}:${s.toFixed(2)}`);
        }
      }
    }
  }

  // Sinergia: problema genérico + dispositivo IT
  const ISSUE_WORDS = [
    'no funciona','no sirve','no prende','no enciende',
    'fallo','falla','averia','avería','descompuesto','dañado',
    'sin señal','sin linea','sin línea'
  ];
  const IT_DEVICES = [
    'telefono','teléfono','extension','extensión','linea','línea','conmutador','auricular',
    'impresora','router','modem','módem','wifi','tv','television','proyector','pc','laptop','computadora'
  ];
  const hasIssue = ISSUE_WORDS.some(w => N.includes(` ${norm(w)} `));
  const hasITdev = IT_DEVICES.some(w => N.includes(` ${norm(w)} `));
  if (hasIssue && hasITdev) {
    scores.it += 0.7;
    reasons.it.push('synergy:issue+it_device');
  }

  // ranking
  const rank = Object.keys(scores)
    .map(code => ({ code, score: Number(scores[code].toFixed(4)), reasons: reasons[code] }))
    .sort((a, b) => b.score - a.score);

  return { scores, rank };
}

// ---------------- IA asistida (opcional) ----------------
function areaSchema() {
  return {
    name: 'Vicebot_Area_v1',
    strict: true,
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        primary_area: { type: ['string','null'], enum: ['it','man','ama','rs','seg', null] },
        areas_list:   { type: 'array', items: { type: 'string', enum: ['it','man','ama','rs','seg'] } },
        confidence:   { type: 'number', minimum: 0, maximum: 1 },
        rationale:    { type: ['string','null'] }
      },
      // IMPORTANTE: incluir todas las keys en required
      required: ['primary_area','areas_list','confidence','rationale']
    }
  };
}

function areaMessages(text) {
  return [
    { role: 'system', content:
`Eres un clasificador de *área operativa* para un hotel.
ÁREAS: it, man, ama, rs, seg.
- it: TI / sistemas / soporte tecnológico (incluye telefonía y conmutador)
- man: mantenimiento (plomería, eléctrica, carpintería, AC)
- ama: ama de llaves / housekeeping / limpieza / blancos
- rs: room service / IRD / servicio a cuarto / A&B
- seg: seguridad / vigilancia / emergencias

Lee el mensaje y elige el área *más probable* (primary_area) y, si aplica, lista áreas posibles (areas_list).
No inventes. Si tienes dudas fuertes, deja primary_area = null.
Responde SOLO JSON válido según el schema.` },
    { role: 'user', content: JSON.stringify({ text }) }
  ];
}

async function aiArea(text) {
  if (!USE_AI) return null;
  const c = await client();
  if (!c) return null;

  try {
    const sch = areaSchema();
    const res = await c.responses.create({
      model: DEFAULT_MODEL,
      input: areaMessages(text),
      temperature: 0.2,
      max_output_tokens: 300,
      text: {
        format: {
          type: 'json_schema',
          name: sch.name,
          schema: sch.schema,
          strict: sch.strict
        }
      }
    });
    const out = res.output_text ? JSON.parse(res.output_text) : null;
    if (DEBUG) console.log('[AREA AI] out', out);
    return out;
  } catch (e) {
    if (DEBUG) console.log('[AREA AI] err', e?.message || e);
    return null;
  }
}

// ---------------- API principal ----------------
/**
 * Detecta el área destino para un texto.
 * Devuelve { area, confidence, rationale?, areas? }.
 */
async function detectArea(text) {
  const raw = text || '';

  // 1) Normalizador directo si el usuario dijo el área explícitamente
  const direct = normalizeAreaInput(raw);
  if (direct) {
    if (DEBUG) console.log('[AREA] normalize hit', direct);
    return { area: direct, confidence: 0.9, rationale: 'normalize' };
  }

  // 2) Scoring local por alias/hints/fuzzy + sinergias
  const sc = scoreAreas(raw);
  const [top, second] = sc.rank;
  if (top && top.score >= 1.0 && (!second || top.score - second.score >= 0.25)) {
    if (DEBUG) console.log('[AREA] local.top', top, 'second:', second);
    return {
      area: top.code,
      confidence: Math.min(0.95, 0.7 + Math.min(top.score, 1.5) / 3),
      rationale: 'local_score',
      areas: sc.rank.slice(0, 3)
    };
  }

  // 3) IA asistida si lo local no es concluyente
  const ai = await aiArea(raw);
  if (ai && (ai.primary_area || (ai.areas_list && ai.areas_list.length))) {
    return {
      area: ai.primary_area || null,
      confidence: Math.max(ai.confidence || 0.65, 0.65),
      rationale: 'ai',
      areas: (ai.areas_list || []).map(code => ({ code, score: null }))
    };
  }

  // 4) Fallback indeciso
  if (DEBUG) console.log('[AREA] undecided', sc.rank.slice(0, 3));
  return {
    area: null,
    confidence: 0,
    rationale: 'undecided',
    areas: sc.rank.slice(0, 3)
  };
}

module.exports = {
  normalizeAreaInput,
  detectArea,
  scoreAreas,
};

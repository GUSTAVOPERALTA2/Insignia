// /groups/groupUpdates.js
// Clasificador híbrido para mensajes en GRUPOS destino.
// Devuelve: { intent: 'T-L'|'T-P'|'T-C'|'OTRO', confidence: 0..1, source: 'heuristic'|'llm'|'hybrid', details }

const ENABLE_LLM = !!process.env.OPENAI_API_KEY;

// ----- 0) Normalización ligera -------------------
function norm(text = '') {
  return String(text || '')
    .replace(/\s+/g, ' ')
    .trim();
}

// ----- 1) Heurísticas en español (rápidas) -------------------
const negations = [
  // niegan cancelar/cerrar ahora
  /\b(no\s+(lo\s+)?cancelen?|no\s+cancelar|no\s+se\s+cierra|no\s+cerrar)\b/i,
  /\b(a[uú]n\s+no|todav[ií]a\s+no|por\s+ahora\s+no)\b/i,
  /\b(no\s+lo\s+cierren|no\s+cerrarlo|no\s+quiero\s+cancelar)\b/i,
];

const rx = {
  // Terminada (T-L)
  done: [
    /\b(ya\s+)?qued(ó|o)\b/i,
    /\b(resuelto|solucionad[oa]|arreglad[oa]|corregid[oa]|restaurad[oa]|list[oa])\b/i,
    /\b(terminad[oa]|finalizad[oa]|cerrad[oa])\b/i,
    /\b(ya\s+est[aá])\b/i,
    /\b(qued[oó]\s+list[oa])\b/i,
  ],
  // En progreso (T-P)
  progress: [
    /\b(en\s+progres[oa])\b/i,
    /\b(trabaj(and|)o|atendiend[oa]|revisand[oa]|diagnosticand[oa])\b/i,
    /\b(voy|vamos)\s+(en|de)\s+camino\b/i,
    /\b(lo|la|se)\s+(ve[o]|checo|reviso|atiendo|estoy\s+viendo)\b/i,
    /\b(asignad[oa]|programad[oa]|pendiente|daremos\s+seguimiento)\b/i,
    /\b(en\s+sitio|on\s+site)\b/i
  ],
  // Cancelada (T-C)
  canceled: [
    // formas de "cancelar"
    /\b(cancel(ar|ada|ado|aci[oó]n|emos|en|o))\b/i,
    /\b(se\s+cancela|queda\s+cancelad[oa])\b/i,
    // "cerrar ticket" / "cerrarlo" (sin acción)
    /\b(cerrar\s+(el\s+)?ticket|cerrarlo|cerrar\s+sin\s+(acci[oó]n|atenci[oó]n))\b/i,
    // no procede / ya no / no requerido
    /\b(no\s+procede|ya\s+no|no\s+es\s+necesario|no\s+requerido)\b/i,
    // duplicado / error
    /\b(duplicad[oa]|por\s+duplicado|repetid[oa])\b/i,
    /\b(por\s+error|equivocaci[oó]n|error\s+de\s+captura|fue\s+error)\b/i,
    // descartar / retirar
    /\b(descartar|se\s+descarta|se\s+retira\s+la\s+solicitud)\b/i,
    // cliente desistió
    /\b(cliente\s+ya\s+no\s+quiere|ya\s+no\s+se\s+requiere)\b/i,
  ]
};

// Cortocircuitos de alta confianza (mensajes súper cortos y decisivos)
const strongShortTC = [
  /^\s*cancelar\s*\.?$/i,
  /^\s*se\s+cancela\s*\.?$/i,
  /^\s*cancelado\s*\.?$/i,
  /^\s*cancelen\s*\.?$/i,
  /^\s*cerrar(?:lo)?\s*\.?$/i,
];

function scoreHeuristic(text = '') {
  const t = norm(text);
  if (!t) return { intent: 'OTRO', confidence: 0.0, raw: {} };

  // cortocircuito T-C
  if (strongShortTC.some(r => r.test(t))) {
    return { intent: 'T-C', confidence: 0.95, raw: { shortTC: true } };
  }

  const s = { done: 0, progress: 0, canceled: 0, neg: 0 };
  for (const n of negations) if (n.test(t)) s.neg++;

  for (const r of rx.done)     if (r.test(t)) s.done++;
  for (const r of rx.progress) if (r.test(t)) s.progress++;
  for (const r of rx.canceled) if (r.test(t)) s.canceled++;

  if (s.neg > 0 && s.canceled > 0) {
    // "no cancelar", "aún no se cierra", etc.
    return { intent: 'OTRO', confidence: 0.2, raw: s };
  }

  // Priorizaciones simples
  if (s.canceled > 0 && s.done === 0 && s.progress === 0) {
    return { intent: 'T-C', confidence: Math.min(1, 0.75 + 0.1 * s.canceled), raw: s };
  }
  if (s.done > 0 && s.progress === 0 && s.canceled === 0) {
    return { intent: 'T-L', confidence: Math.min(1, 0.7 + 0.1 * s.done), raw: s };
  }
  if (s.progress > 0 && s.done === 0 && s.canceled === 0) {
    return { intent: 'T-P', confidence: Math.min(1, 0.65 + 0.1 * s.progress), raw: s };
  }

  // Empates o mezclas → baja confianza
  const tallies = { ...s };
  delete tallies.neg;
  const top = Object.entries(tallies).sort((a,b)=>b[1]-a[1])[0] || ['canceled',0];
  const winner = top[0], hits = top[1];
  const map = { canceled:'T-C', done:'T-L', progress:'T-P' };
  const intent = hits > 0 ? map[winner] : 'OTRO';
  const conf = hits > 0 ? 0.55 : 0.0;
  return { intent, confidence: conf, raw: s };
}

// ----- 2) LLM (OpenAI) como refuerzo/fallback ----------------
let openai = null;
async function ensureOpenAI() {
  if (!ENABLE_LLM) return null;
  if (openai) return openai;
  const OpenAI = (await import('openai')).default;
  openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return openai;
}
const LLM_MODEL = process.env.GROUPS_CLASSIFIER_MODEL || 'gpt-4o-mini';

function llmSchema() {
  return {
    name: 'GroupCancelClassifier_v1',
    strict: true,
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        intent: { type: 'string', enum: ['T-L','T-P','T-C','OTRO'] },
        confidence: { type: 'number', minimum: 0, maximum: 1 },
        reason: { type: ['string','null'] }
      },
      required: ['intent','confidence','reason']
    }
  };
}

async function llmClassify(text) {
  const client = await ensureOpenAI();
  if (!client) return null;

  const system = `
Eres un clasificador de mensajes breves en español provenientes de grupos de trabajo.
Opciones:
- T-C: cancelar/cerrar sin acción/no procede/duplicado/por error/descartar.
- T-L: tarea terminada/resuelta/finalizada/cerrada (hecho).
- T-P: en progreso/atendiendo/revisando/en camino (trabajándose).
- OTRO: no aplica, dudas, negaciones ("no cancelar", "aún no", etc.).
Responde SOLO JSON según schema.
  `.trim();

  const schema = llmSchema();
  const resp = await client.responses.create({
    model: LLM_MODEL,
    input: [
      { role: 'system', content: system },
      { role: 'user', content: `Texto: """${norm(text)}"""` }
    ],
    temperature: 0.0,
    max_output_tokens: 120,
    text: { format: { type: 'json_schema', name: schema.name, schema: schema.schema, strict: schema.strict } }
  });

  try {
    const parsed = resp.output_text ? JSON.parse(resp.output_text) : null;
    if (!parsed) return null;
    const intent = ['T-L','T-P','T-C','OTRO'].includes(parsed.intent) ? parsed.intent : 'OTRO';
    const confidence = Math.max(0, Math.min(1, Number(parsed.confidence) || 0.5));
    return { intent, confidence, reason: parsed.reason || '' };
  } catch {
    return null;
  }
}

// ----- 3) Híbrido: heurística + LLM --------------------------
/**
 * @param {string} text
 * @param {{forceLLM?:boolean}} opts
 */
async function classifyGroupMessage(text, opts = {}) {
  const h = scoreHeuristic(text);

  // si la heurística ya es clara, evitamos costo
  if (!opts.forceLLM && h.intent !== 'OTRO' && h.confidence >= 0.75) {
    return { intent: h.intent, confidence: h.confidence, source: 'heuristic', details: h.raw };
  }

  const llm = await llmClassify(text);
  if (llm) {
    if (h.intent === 'OTRO') {
      return { intent: llm.intent, confidence: llm.confidence, source: 'llm', details: { heuristic: h, llm } };
    }
    if (llm.intent === h.intent) {
      const conf = Math.min(1, (h.confidence + llm.confidence) / 2 + 0.05); // leve boost
      return { intent: llm.intent, confidence: conf, source: 'hybrid', details: { heuristic: h, llm } };
    }
    // conflictos: privilegia el que tenga mayor confianza (sesgo leve al LLM)
    const llmAdj = llm.confidence + 0.05;
    if (llmAdj >= h.confidence) {
      return { intent: llm.intent, confidence: Math.min(1, llmAdj), source: 'llm', details: { heuristic: h, llm } };
    }
    return { intent: h.intent, confidence: h.confidence, source: 'heuristic', details: { heuristic: h, llm } };
  }

  return { intent: h.intent, confidence: h.confidence || 0.5, source: 'heuristic', details: h.raw };
}

module.exports = { classifyGroupMessage };

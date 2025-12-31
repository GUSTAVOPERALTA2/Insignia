// /groups/groupUpdates.js
// Clasificador híbrido para mensajes en GRUPOS destino.
// Devuelve: { intent: 'T-L'|'T-P'|'T-C'|'OTRO', confidence: 0..1, source: 'heuristic'|'llm'|'hybrid', details }

const ENABLE_LLM = !!process.env.OPENAI_API_KEY;

// ----- 0) Normalización -------------------
function norm(text = '') {
  return String(text || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // Quitar acentos
    .replace(/\s+/g, ' ')
    .trim();
}

// ✅ NUEVO: Patrones que indican CONSULTA (no actualización de estado)
// NOTA: "completar" sin más contexto es ACCIÓN, no consulta
const queryPatterns = [
  // "tareas/tickets + estado" = consulta
  /\b(tareas?|tickets?)\s+(pendientes?|abiertos?|completad[ao]s?|cerrad[ao]s?|cancelad[ao]s?)\b/i,
  // "estado + de + área/fecha" = consulta  
  /\b(pendientes?|abiertos?|completad[ao]s?|cerrad[ao]s?)\s+(de\s+)?(hoy|ayer|man|it|ama|seg)/i,
  // Verbos de consulta + tareas
  /\b(muestr[ae]|ver|mostrar|listar|consultar|buscar)\s+(las?\s+)?(tareas?|tickets?)/i,
  // "mis/nuestras tareas" = consulta
  /\b(mis|nuestras?)\s+(tareas?|tickets?)/i,
  // Preguntas
  /\b(cuantos?|cuántos?|cuales|cuáles)\s+(tickets?|tareas?)/i,
  /\b(que|qué)\s+(hay|tenemos)\s+(de|pendiente)/i,
  // Solo "tareas" o "tickets" sin acción = consulta
  /^tareas?\s*$/i,
  /^tickets?\s*$/i,
  // "detalle FOLIO" = consulta
  /\bdetalle\s+[A-Z]{2,}-\d+/i,
];

// Patrones que parecen consulta pero son ACCIÓN
const actionPatterns = [
  /^\s*completar?\s*$/i,           // "completar" solo = acción
  /^\s*completar\s+\d+/i,          // "completar 1" = acción
  /^\s*completar\s+tarea/i,        // "completar tarea" = acción
  /^\s*terminar?\s*$/i,            // "terminar" = acción
  /^\s*terminar\s+\d+/i,           // "terminar 1" = acción
  /^\s*cerrar\s+\d+/i,             // "cerrar 1" = acción
  /^\s*marcar\s+(como\s+)?/i,      // "marcar como listo" = acción
];

function isQueryMessage(text) {
  const t = norm(text);
  
  // Primero verificar si es una acción explícita
  if (actionPatterns.some(rx => rx.test(t))) {
    return false;
  }
  
  return queryPatterns.some(rx => rx.test(t));
}

// ----- 1) Heurísticas en español (rápidas) -------------------
const negations = [
  // niegan cancelar/cerrar ahora - SOLO si es explícito "no cancelar/no cancelen"
  /\b(no\s+(lo\s+)?cancelen?|no\s+cancelar|no\s+se\s+cierra|no\s+cerrar)\b/i,
  /\b(no\s+lo\s+cierren|no\s+cerrarlo|no\s+quiero\s+cancelar)\b/i,
  // "aún no" / "todavía no" solo niegan si van antes de acción
  /\b(a[uú]n\s+no\s+cancel|todav[ií]a\s+no\s+cancel)\b/i,
];

const rx = {
  // Terminada (T-L) - AMPLIADO con "completar" y "queda funcionando"
  done: [
    /\b(ya\s+)?quedo\b/i,
    /\b(resuelto|solucionad[oa]|arreglad[oa]|corregid[oa]|restaurad[oa]|list[oa])\b/i,
    /\b(terminad[oa]|finalizad[oa]|cerrad[oa])\b/i,
    /\b(ya\s+esta)\b/i,
    /\b(quedo\s+list[oa])\b/i,
    /\bhecho\b/i,
    /\bcompletar?\b/i,
    /\bcompletad[oa]\b/i,
    /\bterminar?\b/i,
    /\bfinalizar?\b/i,
    /\bcerrar?\b/i,
    /\bmarcar\s+(como\s+)?(list[oa]|complet|terminad|hecho)/i,
    // ✅ NUEVO: Variantes de "queda funcionando/listo/resuelto"
    /\bqueda\s+(funcionando|bien|ok|listo|resuelto|arreglado|solucionado)\b/i,
    /\bya\s+(funciona|sirve|quedo|esta\s+listo)\b/i,
    /\b(ya\s+)?(se\s+)?reviso\b/i,  // "ya se revisó"
    /\b(ya\s+)?(se\s+)?arreglo\b/i, // "ya se arregló"
    /\b(ya\s+)?(se\s+)?soluciono\b/i, // "ya se solucionó"
    /\b(ya\s+)?(se\s+)?resolvio\b/i, // "ya se resolvió"
    /\b(ya\s+)?(se\s+)?completo\b/i, // "ya se completó"
  ],
  // En progreso (T-P) - AMPLIADO
  progress: [
    /\b(en\s+progres[oa])\b/i,
    /\b(trabaj(and|)o|atendiend[oa]|revisand[oa]|diagnosticand[oa])\b/i,
    // Variantes de "voy/vamos"
    /\b(voy|vamos)\s+(en|de)\s+camino\b/i,
    /\b(voy|vamos)\s+(para\s+)?(all[aá]|ah[ií])\b/i,
    /\b(voy|vamos)\s+a\s+(revisar|ver|checar|atender)\b/i,
    /\bya\s+(voy|vamos)\b/i,
    /\b(ah[ií]\s+)?(voy|vamos)\b/i,
    // "me acerco", "nos acercamos"
    /\b(me|nos)\s+acerc(o|amos)\b/i,
    // "en un momento", "ahorita"
    /\ben\s+un\s+momento\b/i,
    /\b(ahorita|ahora)\s+(voy|vamos|lo\s+veo|lo\s+reviso)\b/i,
    // Otros
    /\b(lo|la|se)\s+(ve[o]|checo|reviso|atiendo|estoy\s+viendo)\b/i,
    /\b(asignad[oa]|programad[oa]|pendiente|daremos\s+seguimiento)\b/i,
    /\b(en\s+sitio|on\s+site)\b/i,
    /\b(enterado|enterados|entendido)\b/i,
    /\ben\s+camino\b/i,
    /\bvoy\b/i,
    /\bvamos\b/i,
  ],
  // Cancelada (T-C) - AMPLIADO
  canceled: [
    /\b(cancel(ar|ada|ado|aci[oó]n|emos|en|a|o))\b/i,
    /\b(se\s+cancela|queda\s+cancelad[oa])\b/i,
    /\b(cerrar\s+(el\s+)?ticket|cerrarlo|cerrar\s+sin\s+(acci[oó]n|atenci[oó]n))\b/i,
    /\b(no\s+procede|no\s+es\s+necesario|no\s+requerido)\b/i,
    /\b(duplicad[oa]|por\s+duplicado|repetid[oa])\b/i,
    /\b(por\s+error|equivocaci[oó]n|error\s+de\s+captura|fue\s+error)\b/i,
    /\b(descartar|se\s+descarta|se\s+retira\s+la\s+solicitud)\b/i,
    /\b(cliente\s+ya\s+no\s+quiere|ya\s+no\s+se\s+requiere)\b/i,
    /\b(no\s+(es|era)\s+(m[ií]o|nuestro|de\s+nosotros))\b/i,  // "no es mío"
    /\b(no\s+corresponde|no\s+aplica|no\s+va)\b/i,
    /\b(error\s+de\s+[aá]rea|[aá]rea\s+incorrecta)\b/i,
  ]
};

// Cortocircuitos de alta confianza (mensajes súper cortos y decisivos)
const strongShortTL = [
  /^\s*list[oa]\s*\.?$/i,
  /^\s*hecho\s*\.?$/i,
  /^\s*ya\s+qued[oó]\s*\.?$/i,
  /^\s*resuelto\s*\.?$/i,
  /^\s*arreglad[oa]\s*\.?$/i,
  /^\s*completar?\s*\.?$/i,       // ✅ NUEVO
  /^\s*completad[oa]\s*\.?$/i,    // ✅ NUEVO
  /^\s*terminar?\s*\.?$/i,        // ✅ NUEVO
  /^\s*terminad[oa]\s*\.?$/i,     // ✅ NUEVO
  /^\s*finalizar?\s*\.?$/i,       // ✅ NUEVO
  /^\s*completar\s+\d+\s*$/i,     // ✅ NUEVO: "completar 1"
  /^\s*terminar\s+\d+\s*$/i,      // ✅ NUEVO: "terminar 1"
  /^\s*cerrar\s+\d+\s*$/i,        // ✅ NUEVO: "cerrar 1"
];

const strongShortTP = [
  /^\s*voy\s*\.?$/i,
  /^\s*vamos\s*\.?$/i,
  /^\s*(ya\s+)?voy\s*\.?$/i,
  /^\s*enterado\s*\.?$/i,
  /^\s*ok\s*\.?$/i,
  /^\s*en\s+camino\s*\.?$/i,
  /^\s*me\s+acerco\s*\.?$/i,
];

const strongShortTC = [
  /^\s*cancelar\s*\.?$/i,
  /^\s*se\s+cancela\s*\.?$/i,
  /^\s*cancelado\s*\.?$/i,
  /^\s*cancelen\s*\.?$/i,
  /^\s*cerrar(?:lo)?\s*\.?$/i,
];

// Mensajes que empiezan con "cancela" son muy probablemente cancelaciones
const strongStartTC = [
  /^\s*cancela[,.\s]/i,           // "Cancela, esto no es mío"
  /^\s*cancel[ae]n?\s/i,          // "Cancelen esto"
  /^\s*se\s+cancela\s/i,          // "Se cancela porque..."
  /^\s*hay\s+que\s+cancelar/i,    // "Hay que cancelar"
  /^\s*favor\s+de\s+cancelar/i,   // "Favor de cancelar"
  /^\s*por\s+favor\s+cancel/i,    // "Por favor cancela"
];

function scoreHeuristic(text = '') {
  const t = norm(text);
  if (!t) return { intent: 'OTRO', confidence: 0.0, raw: {} };

  // ✅ NUEVO: Si parece consulta, no es actualización de estado
  if (isQueryMessage(t)) {
    return { intent: 'OTRO', confidence: 0.95, raw: { isQuery: true } };
  }

  // cortocircuito T-L (listo/hecho)
  if (strongShortTL.some(r => r.test(t))) {
    return { intent: 'T-L', confidence: 0.95, raw: { shortTL: true } };
  }

  // cortocircuito T-P (voy/vamos)
  if (strongShortTP.some(r => r.test(t))) {
    return { intent: 'T-P', confidence: 0.90, raw: { shortTP: true } };
  }

  // cortocircuito T-C (cancelar corto)
  if (strongShortTC.some(r => r.test(t))) {
    return { intent: 'T-C', confidence: 0.95, raw: { shortTC: true } };
  }

  // cortocircuito T-C (empieza con "cancela...")
  if (strongStartTC.some(r => r.test(t))) {
    return { intent: 'T-C', confidence: 0.90, raw: { startTC: true } };
  }

  const s = { done: 0, progress: 0, canceled: 0, neg: 0 };
  for (const n of negations) if (n.test(t)) s.neg++;

  for (const r of rx.done)     if (r.test(t)) s.done++;
  for (const r of rx.progress) if (r.test(t)) s.progress++;
  for (const r of rx.canceled) if (r.test(t)) s.canceled++;

  // Solo aplicar negación si es explícita "no cancelar/no cancelen"
  if (s.neg > 0 && s.canceled > 0) {
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
- T-L: tarea terminada/resuelta/finalizada/cerrada/hecho/listo/ya quedó.
- T-P: en progreso/atendiendo/revisando/en camino/voy/vamos/me acerco/enterado.
- OTRO: consultas (ej: "tareas pendientes", "tickets completados", "mis tareas"), dudas, negaciones ("no cancelar", "aún no", etc.), o cualquier mensaje que NO sea una actualización de estado.

IMPORTANTE: Si el mensaje parece una CONSULTA o PREGUNTA sobre tickets/tareas (ej: "tareas completadas de hoy", "tickets pendientes", "muestrame tareas"), responde OTRO.
Solo clasifica como T-L/T-P/T-C si el usuario está ACTUALIZANDO el estado de un ticket, no consultando.
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

  // ✅ NUEVO: Si la heurística detectó una consulta, retornar directamente sin LLM
  if (h.raw?.isQuery) {
    return { intent: 'OTRO', confidence: h.confidence, source: 'heuristic', details: { heuristic: h, isQuery: true } };
  }

  // si la heurística ya es clara, evitamos costo LLM
  if (!opts.forceLLM && h.intent !== 'OTRO' && h.confidence >= 0.75) {
    return { intent: h.intent, confidence: h.confidence, source: 'heuristic', details: h.raw };
  }

  const llm = await llmClassify(text);
  if (llm) {
    if (h.intent === 'OTRO') {
      return { intent: llm.intent, confidence: llm.confidence, source: 'llm', details: { heuristic: h, llm } };
    }
    if (llm.intent === h.intent) {
      const conf = Math.min(1, (h.confidence + llm.confidence) / 2 + 0.05);
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

module.exports = { classifyGroupMessage, isQueryMessage };
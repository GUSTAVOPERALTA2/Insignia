// modules/ai/issueDetector.js
// Detección de PROBLEMA (issue) con IA + pregunta de retroalimentación con tono juguetón.

const DEFAULT_ISSUE_MODEL = process.env.VICEBOT_AI_ISSUE_MODEL || 'gpt-4o';
const DEFAULT_COPY_MODEL  = process.env.VICEBOT_AI_COPY_MODEL  || 'gpt-4o-mini';

let _OpenAI, _client;
async function client() {
  if (!_OpenAI) _OpenAI = (await import('openai')).default;
  if (!_client) _client = new _OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return _client;
}

function issueSchema() {
  return {
    name: 'Vicebot_Issue_v1',
    strict: true,
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        found:        { type: 'boolean' },
        titulo:       { type: ['string','null'] },
        interpretacion:{ type: ['string','null'] },
        // Sugerencias de área (opcional): it/man/ama/rs/seg
        area_hints:   { type: 'array', items: { type: 'string', enum: ['it','man','ama','rs','seg'] } },
        urgency:      { type: ['string','null'], enum: ['alta','media','baja', null] },
        confidence:   { type: 'number', minimum: 0, maximum: 1 },
        // Si no hay claridad, IA puede sugerir pedir más datos:
        ask_more:     { type: 'boolean' },
        notes:        { type: ['string','null'] }
      },
      required: ['found','confidence']
    }
  };
}

function buildIssueMessages({ text, context = {} }) {
  const system = {
    role: 'system',
    content:
`Eres un analista de incidencias de hotel (Vicebot).
Tarea: detectar el PROBLEMA descrito por el usuario.
Devuelve JSON con:
- found (bool), titulo (breve), interpretacion (1–2 líneas), area_hints (it/man/ama/rs/seg) si aplica,
- urgency (alta|media|baja) si se infiere,
- confidence (0..1),
- ask_more (true si necesitas más info específica).
Si no es una incidencia clara, found=false pero intenta dar una interpretacion tentativa.`
  };

  const shots = [
    { role:'user', content: JSON.stringify({ text:'La TV no enciende', context:{ lang:'es' } }) },
    { role:'assistant', content: JSON.stringify({ found:true, titulo:'Televisión no enciende', interpretacion:'El televisor no prende al intentar encenderlo.', area_hints:['it','man'], urgency:'media', confidence:0.86, ask_more:false, notes:null }) },

    { role:'user', content: JSON.stringify({ text:'Hay una gotera cerca de la cama', context:{ lang:'es' } }) },
    { role:'assistant', content: JSON.stringify({ found:true, titulo:'Gotera en habitación', interpretacion:'Se observa filtración de agua en zona cercana a la cama.', area_hints:['man'], urgency:'media', confidence:0.84, ask_more:false, notes:null }) },

    { role:'user', content: JSON.stringify({ text:'me ayudan con algo raro en el baño', context:{ lang:'es' } }) },
    { role:'assistant', content: JSON.stringify({ found:false, titulo:null, interpretacion:'Posible falla en baño, falta detalle.', area_hints:['man'], urgency:null, confidence:0.45, ask_more:true, notes:'Pedir si es fuga, drenaje tapado, no hay agua, etc.' }) }
  ];

  return [system, ...shots, { role:'user', content: JSON.stringify({ text, context }) }];
}

/**
 * Detecta el problema descrito en `text`.
 * @returns {Promise<{found:boolean, titulo?:string|null, interpretacion?:string|null, area_hints?:string[], urgency?:string|null, confidence:number, ask_more?:boolean, notes?:string|null}>}
 */
async function detectIssue(text, context = {}) {
  const started = Date.now();
  try {
    const c = await client();
    const resp = await c.responses.create({
      model: DEFAULT_ISSUE_MODEL,
      input: buildIssueMessages({ text, context }),
      temperature: 0.2,
      max_output_tokens: 400,
      text: { format: { type: 'json_schema', json_schema: issueSchema() } }
    });

    const out = resp.output_text ? JSON.parse(resp.output_text) : {};
    out._model = DEFAULT_ISSUE_MODEL;
    out._latency_ms = Date.now() - started;

    console.log('[ISSUE] detect', out);
    return out;
  } catch (err) {
    const fallback = {
      found: false,
      titulo: null,
      interpretacion: null,
      area_hints: [],
      urgency: null,
      confidence: 0,
      ask_more: true,
      notes: `ai_error: ${err?.message || String(err)}`,
      _model: DEFAULT_ISSUE_MODEL,
      _latency_ms: Date.now() - started,
    };
    console.warn('[ISSUE] error', fallback.notes);
    return fallback;
  }
}

/**
 * Pregunta de aclaración (juguetona) cuando no se detecta bien el problema.
 * Devuelve texto listo para enviar.
 */
async function askIssueClarification({ text, hints = [] }) {
  try {
    const c = await client();

    const system = {
      role: 'system',
      content:
`Eres Vicebot (asistente de WhatsApp, tono amable y juguetón).
El usuario reportó una incidencia, pero no quedó claro el problema.
Escribe una respuesta breve (máx 4 líneas), con 1 emoji como mucho, pidiendo CLARIDAD:
- Ofrece 3–5 opciones típicas (ejemplo para puerta: "no cierra", "rota", "hace ruido", "no abre", "se descuadra").
- Si tienes hints (p. ej. área), adáptate al contexto, pero NO inventes.
- Evita tecnicismos o regaños.`
    };

    const user = {
      role: 'user',
      content: JSON.stringify({
        texto_usuario: text,
        hints
      })
    };

    const resp = await c.responses.create({
      model: DEFAULT_COPY_MODEL,
      input: [system, user],
      temperature: 0.5,
      max_output_tokens: 160
    });

    const out = (resp.output_text || '').trim();
    if (out) {
      console.log('[ISSUE] ask_more.copy', { model: DEFAULT_COPY_MODEL, chars: out.length });
      return out;
    }
  } catch (err) {
    console.warn('[ISSUE] ask_more.fallback', err?.message || err);
  }

  // Fallback local
  return (
    '¿Me cuentas un poco más? ¿Qué está fallando exactamente? ' +
    'Por ejemplo: *no enciende*, *fuga de agua*, *no cierra*, *ruido extraño*. 🙂'
  );
}

module.exports = {
  detectIssue,
  askIssueClarification,
};

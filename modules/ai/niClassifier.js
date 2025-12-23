// modules/ai/niClassifier.js
// Clasificador SOLO N-I — OpenAI Responses + Structured Outputs (text.format)
// v4: si el texto suena a trabajo de IT/MAN/AMA/RS/SEG, clasifica N-I aunque falten campos.

const DEFAULT_MODEL = process.env.VICEBOT_AI_MODEL || 'gpt-4o';
const TIMEZONE = process.env.VICEBOT_TZ || 'America/Mazatlan';

let _OpenAI, _client;
async function client() {
  if (!_OpenAI) _OpenAI = (await import('openai')).default;
  if (!_client) _client = new _OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return _client;
}

/** JSON Schema */
function schemaNI() {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      intencion:      { type: 'string', enum: ['N-I', 'OTRO'] },
      descripcion:    { type: 'string' },
      interpretacion: { type: 'string' },
      lugar:          { type: ['string','null'] },
      area_destino:   { type: ['string','null'], enum: ['it','man','ama','rs','seg','desconocida', null] },
      areas_sugeridas:{ type: 'array', items: { type: 'string', enum: ['it','man','ama','rs','seg'] }, maxItems: 3 },
      confidence:     { type: 'number', minimum: 0, maximum: 1 },
      actions:        { type: 'array', items: { type: 'string', enum: ['create_incident','route_to_area','ask_clarification'] } },
      notes:          { type: ['string','null'] }
    },
    required: ['intencion','descripcion','interpretacion','lugar','area_destino','areas_sugeridas','confidence','actions','notes']
  };
}

/** Prompt */
function buildMessages({ text, context }) {
  const system = {
    role: 'system',
    content:
`Eres un clasificador de *Nueva Incidencia (N-I)* para un hotel.

Definición de "incidencia": cualquier solicitud de revisión, arreglo o soporte para las áreas
[IT = it, Mantenimiento = man, Housekeeping = ama, Room Service = rs, Seguridad = seg].
Ejemplos de señales: "revisen", "arreglen", "no funciona", "no hay", "fuga", "gotera", "apagado",
"cerradura", "aire/clima", "wifi/internet", "impresora", "olores", "limpieza", "pedido RS", "seguridad", etc.

Reglas de decisión:
- Si el texto suena a un problema/trabajo para IT/MAN/AMA/RS/SEG → **N-I**, aunque falte el lugar.
  En ese caso deja "lugar:null" y "area_destino:'desconocida'" (o la que infieras) y sugiere "areas_sugeridas".
- Si es un saludo, charla o texto ajeno a incidencias → **OTRO**.

Siempre devuelve:
- \`interpretacion\` breve en español.
- \`areas_sugeridas\` (1–2) cuando apliquen.
- Si no estás seguro del área → usa \`desconocida\` en \`area_destino\`.

Zona horaria: ${TIMEZONE}.
Responde SOLO JSON válido que cumpla el schema.`
  };

  const fewShot = [
    // N-I sin lugar
    { role:'user', content: JSON.stringify({ text:'Ayuda, necesito que revisen una gotera por favor', context:{ chatType:'dm' } }) },
    { role:'assistant', content: JSON.stringify({
        intencion:'N-I',
        descripcion:'Ayuda, necesito que revisen una gotera por favor',
        interpretacion:'Solicitud para revisar una gotera (posible filtración)',
        lugar:null,
        area_destino:'desconocida',
        areas_sugeridas:['man'],
        confidence:0.82,
        actions:['ask_clarification'],
        notes:null
    })},
    // N-I clásico con lugar
    { role:'user', content: JSON.stringify({ text:'No hay luz en el pasillo del 2do piso', context:{ chatType:'grupo' } }) },
    { role:'assistant', content: JSON.stringify({
        intencion:'N-I',
        descripcion:'No hay luz en el pasillo del 2do piso',
        interpretacion:'Falla eléctrica en pasillo del piso 2',
        lugar:'Pasillo 2do piso',
        area_destino:'man',
        areas_sugeridas:['man'],
        confidence:0.9,
        actions:['create_incident','route_to_area'],
        notes:null
    })},
    // OTRO genuino
    { role:'user', content: JSON.stringify({ text:'Hola buenos días', context:{ chatType:'dm' } }) },
    { role:'assistant', content: JSON.stringify({
        intencion:'OTRO',
        descripcion:'Hola buenos días',
        interpretacion:'Saludo',
        lugar:null,
        area_destino:'desconocida',
        areas_sugeridas:[],
        confidence:0.99,
        actions:['ask_clarification'],
        notes:null
    })},
  ];

  return [system, ...fewShot, { role:'user', content: JSON.stringify({ text, context }) }];
}

async function classifyNI({ text, context = {} }) {
  const start = Date.now();
  try {
    if (typeof text === 'string' && text.trim().startsWith('/')) {
      return {
        intencion: 'OTRO',
        descripcion: text,
        interpretacion: 'Comando o texto no relacionado con incidencias',
        lugar: null,
        area_destino: 'desconocida',
        areas_sugeridas: [],
        confidence: 1.0,
        actions: ['ask_clarification'],
        notes: null,
        _latency_ms: 0,
        _model: 'local-fastpath',
      };
    }

    const c = await client();
    const resp = await c.responses.create({
      model: DEFAULT_MODEL,
      input: buildMessages({ text, context }),
      max_output_tokens: 500,
      text: {
        format: {
          type: 'json_schema',
          name: 'Vicebot_NI_v4',
          schema: schemaNI(),
          strict: true,
        },
      },
    });

    const jsonText = (typeof resp.output_text === 'string' && resp.output_text.trim())
      ? resp.output_text : tryExtractText(resp);
    const parsed = jsonText ? JSON.parse(jsonText) : {};
    parsed._latency_ms = Date.now() - start;
    parsed._model = DEFAULT_MODEL;
    return parsed;
  } catch (err) {
    return {
      intencion: 'OTRO',
      descripcion: String(text || ''),
      interpretacion: 'Mensaje no reconocido; posible solicitud general de ayuda',
      lugar: null,
      area_destino: 'desconocida',
      areas_sugeridas: [],
      confidence: 0,
      actions: ['ask_clarification'],
      notes: `IA fallback: ${err?.message || err}`,
      _latency_ms: Date.now() - start,
      _model: DEFAULT_MODEL,
    };
  }
}

function tryExtractText(resp) {
  try {
    const out = resp?.output ?? resp?.response ?? resp;
    const firstText = Array.isArray(out)
      ? out.map(seg => seg?.content?.map(c => c?.text).filter(Boolean).join('')).filter(Boolean).join('\n')
      : out?.output_text || out?.text || null;
    return firstText || null;
  } catch { return null; }
}

module.exports = { classifyNI, DEFAULT_MODEL, TIMEZONE };

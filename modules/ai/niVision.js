// modules/ai/niVision.js
// Análisis visual para N-I (vision + structured outputs)

const DEFAULT_VISION_MODEL = process.env.VICEBOT_VISION_MODEL || 'gpt-4o-mini';
let _OpenAI, _client;

async function client() {
  if (!_OpenAI) _OpenAI = (await import('openai')).default;
  if (!_client) _client = new _OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return _client;
}

/** Convierte {mimetype, data(base64)} a data URL */
function toDataUrl(media) {
  const mime = media?.mimetype || 'image/jpeg';
  const b64  = media?.data || '';
  return `data:${mime};base64,${b64}`;
}

/** Esquema para Structured Outputs (vision) */
function visionSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    // Sólo lo indispensable obligatorio; el resto opcional
    required: ['interpretacion', 'confidence'],
    properties: {
      interpretacion: { type: 'string' },
      confidence: { type: 'number', minimum: 0, maximum: 1 },
      tags: { type: 'array', items: { type: 'string' } },
      safety: { type: 'array', items: { type: 'string' } },
      area_hints: {
        type: 'array',
        items: { type: 'string', enum: ['it','man','ama','rs','seg'] }
      },
      rationale: { type: 'string' }
    }
  };
}

/**
 * Analiza una imagen opcionalmente sesgada con contexto textual.
 * @param {{mimetype:string, data:string(base64), size?:number}} media
 * @param {{text?:string}} ctx
 * @returns {Promise<{interpretacion:string|null, confidence:number, tags:string[], safety:string[], area_hints:string[], rationale:string|null, _latency_ms:number, _model:string}>}
 */
async function analyzeNIImage(media, ctx = {}) {
  const started = Date.now();
  try {
    if (!media?.data) {
      return {
        interpretacion: null,
        confidence: 0,
        tags: [],
        safety: [],
        area_hints: [],
        rationale: 'no_media',
        _latency_ms: 0,
        _model: DEFAULT_VISION_MODEL
      };
    }

    const c = await client();

    const userText = [
      'Analiza SOLO la imagen para ayudar a entender un posible problema de hotel (IT, Mantenimiento, HSKP, Room Service, Seguridad).',
      'Devuelve una interpretación breve y neutral. No inventes lugar ni área: si no es evidente, manténlo genérico.',
      ctx?.text ? `Contexto del texto del huésped/técnico: "${ctx.text}" (solo para afinar la interpretación).` : null,
    ].filter(Boolean).join('\n');

    const dataUrl = toDataUrl(media);

    const resp = await c.responses.create({
      model: DEFAULT_VISION_MODEL,
      input: [
        {
          role: 'user',
          content: [
            { type: 'input_text', text: userText },
            { type: 'input_image', image_url: dataUrl }
          ]
        }
      ],
      text: {
        format: {
          type: 'json_schema',
          name: 'Vicebot_NI_Vision_v5', // ← requerido por la API
          schema: visionSchema(),       // ← y aquí va el schema
          strict: false                 // ← relaja validación (evita 400 si falta algún campo opcional)
        }
      },
      temperature: 0.2,
      max_output_tokens: 300
    });

    // Extrae JSON ya validado
    const jsonText = resp.output_text || null;
    const out = jsonText ? JSON.parse(jsonText) : {};

    return {
      interpretacion: out.interpretacion ?? null,
      confidence: typeof out.confidence === 'number' ? out.confidence : 0,
      tags: Array.isArray(out.tags) ? out.tags : [],
      safety: Array.isArray(out.safety) ? out.safety : [],
      area_hints: Array.isArray(out.area_hints) ? out.area_hints : [],
      rationale: out.rationale ?? null,
      _latency_ms: Date.now() - started,
      _model: DEFAULT_VISION_MODEL
    };

  } catch (err) {
    return {
      interpretacion: null,
      confidence: 0,
      tags: [],
      safety: [],
      area_hints: [],
      rationale: `vision_fallback: ${err?.message || String(err)}`,
      _latency_ms: Date.now() - started,
      _model: DEFAULT_VISION_MODEL
    };
  }
}

module.exports = { analyzeNIImage, DEFAULT_VISION_MODEL };

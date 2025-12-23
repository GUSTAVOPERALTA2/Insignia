// modules/ai/niUnknownClassifier.js
// Clasificador IA para mensajes "unknown" en DMs,
// que ayuda a decidir si el texto se parece a una N-I (incidencia)
// o a cualquier otro tipo de mensaje.
//
// Este módulo es opcional: si no hay OPENAI_API_KEY o falla el cliente,
// simplemente devuelve una clasificación neutra.
//
// Se integra con coreMessageRouter, que ya combina:
//  - Heurística local (looksIncidentLikeHeuristic)
//  - Este clasificador IA (si está disponible)
//
// Firma esperada por coreMessageRouter:
//   classifyIncidentLike({ text, flags }) → {
//     is_incident_like: boolean,
//     confidence: number (0–1),
//     reason?: string
//   }

const DEBUG = (process.env.VICEBOT_DEBUG || '1') === '1';

let openai = null;
try {
  const OpenAI = require('openai');
  openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
  });
} catch (e) {
  if (DEBUG) {
    console.warn(
      '[NI-UNKNOWN-AI] No se pudo inicializar OpenAI client:',
      e?.message || e
    );
  }
}

// Modelo configurable (por si quieres usar otro más adelante)
const MODEL =
  process.env.VICEBOT_NI_UNKNOWN_MODEL ||
  process.env.VICEBOT_INTENT_MODEL ||
  'gpt-4.1-mini';

// Umbral mínimo sugerido para confiar en la IA (coreMessageRouter
// de todos modos vuelve a evaluar con MIN_INCIDENT_LIKE_CONF)
const MIN_AI_CONF = parseFloat(
  process.env.VICEBOT_NI_UNKNOWN_AI_MIN_CONF || '0.55'
);

/**
 * Normaliza string a algo consistente (minúsculas, sin espacios raros).
 */
function normalize(text = '') {
  return String(text || '')
    .trim()
    .replace(/\s+/g, ' ');
}

/**
 * Llama a la IA para decidir si un mensaje "unknown" se parece a una nueva incidencia.
 *
 * @param {{ text: string, flags?: object }} opts
 * @returns {Promise<{ is_incident_like: boolean, confidence: number, reason: string }>}
 */
async function classifyIncidentLike(opts) {
  const text = normalize(opts?.text || '');
  const flags = opts?.flags || {};

  // Caso trivial: texto vacío
  if (!text) {
    return {
      is_incident_like: false,
      confidence: 0,
      reason: 'empty_text',
    };
  }

  // Si no tenemos cliente IA, devolvemos neutro; la heurística del core hará el resto.
  if (!openai || !process.env.OPENAI_API_KEY) {
    if (DEBUG) {
      console.warn(
        '[NI-UNKNOWN-AI] Sin OPENAI_API_KEY; se omite clasificación IA para unknown.'
      );
    }
    return {
      is_incident_like: false,
      confidence: 0,
      reason: 'no_openai_client',
    };
  }

  // Construimos un prompt MUY enfocado al dominio hotel / operación,
  // para que sea barato y consistente.
  const systemPrompt = `
Eres un clasificador muy estricto de mensajes de WhatsApp dentro de un hotel o resort.

Tu única tarea es decidir si el mensaje del usuario en un chat directo (DM)
se parece a un NUEVO REPORTE DE INCIDENCIA / PROBLEMA OPERATIVO
(o a una ampliación directa de un problema operativo),
o si parece otra cosa (saludo, smalltalk, duda general, chisme, etc.).

"Incidencia" significa cosas como:
- Problemas con equipo (AC, TV, control, cable, luz, cortinas, agua, fugas, etc.).
- Problemas en habitaciones, villas, áreas del hotel.
- Pedidos claros de soporte (mantenimiento, sistemas, limpieza, etc.).
Suelen mencionar número de habitación o villa, o un lugar concreto, y un problema.

NO cuentes como incidencia:
- Saludos ("hola", "buen día").
- Preguntas genéricas ("cómo estás", "como vamos").
- Comentarios sociales o chistes.
- Preguntas sobre el estado de un ticket ya abierto sin describir problema nuevo.

Debes responder SIEMPRE en JSON con esta forma EXACTA:
{
  "is_incident_like": true | false,
  "confidence": 0.0-1.0,
  "reason": "explicación breve en español"
}
`;

  const userPrompt = {
    text,
    context_flags: {
      // Le pasamos algunas señales para que las use si quiere
      hasFolioInBody: !!flags.hasFolioInBody,
      hasQuotedFolio: !!flags.hasQuotedFolio,
      isGreeting: !!flags.isGreeting,
      isCommand: !!flags.isCommand,
      isHelpLike: !!flags.isHelpLike,
      isIncidentLikeFlag: !!flags.isIncidentLike, // por si en el futuro le mandas algo
      chatId: flags.chatId || null,
    },
    instrucciones: [
      'Si el mensaje describe directamente un problema con algo físico/servicio → is_incident_like = true.',
      'Si el mensaje solo pregunta cómo va algo, sin detallar problema → is_incident_like = false.',
      'La confianza debe ser un número entre 0 y 1.',
      'No agregues texto fuera del JSON.',
    ],
  };

  try {
    const resp = await openai.chat.completions.create({
      model: MODEL,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: systemPrompt },
        {
          role: 'user',
          content: JSON.stringify(userPrompt, null, 2),
        },
      ],
      max_tokens: 150,
      temperature: 0.2,
    });

    const raw = resp?.choices?.[0]?.message?.content || '{}';
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      if (DEBUG) {
        console.warn('[NI-UNKNOWN-AI] respuesta no JSON, raw:', raw);
      }
      return {
        is_incident_like: false,
        confidence: 0,
        reason: 'invalid_json_from_model',
      };
    }

    let is_incident_like = !!parsed.is_incident_like;
    let confidence = Number(parsed.confidence || 0);
    const reason =
      typeof parsed.reason === 'string'
        ? parsed.reason
        : 'sin_reason_explicito';

    // Normalizamos rango
    if (!Number.isFinite(confidence)) confidence = 0;
    if (confidence < 0) confidence = 0;
    if (confidence > 1) confidence = 1;

    // Opcional: si la IA dice true pero la confianza es muy baja, lo dejamos en false
    if (is_incident_like && confidence < MIN_AI_CONF) {
      if (DEBUG) {
        console.log(
          '[NI-UNKNOWN-AI] is_incident_like=true pero por debajo de MIN_AI_CONF, se suaviza:',
          { confidence, MIN_AI_CONF }
        );
      }
      is_incident_like = false;
    }

    if (DEBUG) {
      console.log('[NI-UNKNOWN-AI] final', {
        is_incident_like,
        confidence,
        reason,
      });
    }

    return {
      is_incident_like,
      confidence,
      reason,
    };
  } catch (e) {
    console.error('[NI-UNKNOWN-AI] error en llamada IA:', e?.message || e);
    return {
      is_incident_like: false,
      confidence: 0,
      reason: 'openai_error',
    };
  }
}

module.exports = {
  classifyIncidentLike,
};

// modules/ai/coreFeedbackClassifier.js
// Clasificador central para feedback de EQUIPO y SOLICITANTE sobre tickets.
// Usa la API de OpenAI para determinar intención, tono y si cambia el estado.

const OpenAI = require('openai');

const DEBUG = (process.env.VICEBOT_DEBUG || '1') === '1';
const FEEDBACK_MODEL =
  process.env.VICEBOT_FEEDBACK_MODEL ||
  'gpt-4o-mini'; // cámbialo a lo que estés usando: gpt-4o, gpt-4.1, etc.

let _client = null;
function getClient() {
  if (_client) return _client;
  _client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return _client;
}

/**
 * Normaliza historial a texto legible para el prompt.
 * history: array de strings o de objetos { by: 'team|requester', text: '...' }
 */
function formatHistoryForPrompt(history) {
  if (!history || !Array.isArray(history) || !history.length) {
    return '(sin historial relevante)';
  }

  const lines = history
    .map((h) => {
      if (!h) return null;
      if (typeof h === 'string') return `- ${h}`;
      const by = h.by || h.role || 'desconocido';
      const txt = (h.text || h.msg || '').trim();
      if (!txt) return null;
      return `- [${by}] ${txt}`;
    })
    .filter(Boolean);

  return lines.length ? lines.join('\n') : '(sin historial relevante)';
}

/**
 * Prompt de sistema.
 */
function buildSystemPrompt() {
  return `
Eres un clasificador experto de mensajes de seguimiento de tickets de soporte en un hotel.

Tu tarea es analizar UN SOLO mensaje y devolver un JSON ESTRICTO que describa:
- Si el mensaje es relevante para el ticket.
- Si proviene del EQUIPO (grupo de mantenimiento/IT/HSKP) o del SOLICITANTE (huésped o staff que reportó).
- Si el mensaje implica un CAMBIO DE ESTADO del ticket (por ejemplo: "ya quedó", "cancelen el reporte", "seguimos trabajando", etc.).
- El tono general del mensaje (positivo/neutral/negativo).
- En el caso del solicitante, si está satisfecho, todavía tiene el problema, quiere cancelar, etc.
- Un resumen normalizado corto del mensaje.

NO asumas cosas que no estén en el texto. Si hay ambigüedad, escoge las opciones más neutrales.

Responde SIEMPRE con un JSON VÁLIDO, sin texto adicional.
`.trim();
}

/**
 * Prompt de usuario con contexto, historial y mensaje.
 */
function buildUserPrompt({ text, roleHint, ticket, history }) {
  const safeText = String(text || '').trim();
  const role = roleHint === 'team' ? 'team' : 'requester';

  const t = ticket || {};
  const folio = t.folio || '';
  const descripcion = (t.descripcion || t.description || '').trim();
  const lugar = (t.lugar || t.place || '').trim();
  const status = (t.status || t.status_actual || '').trim();
  const historyText = formatHistoryForPrompt(history);

  return `
[CONTEXT]
- role_hint: "${role}"
- language: "es"
- ticket:
  - folio: "${folio}"
  - descripcion: "${descripcion}"
  - lugar: "${lugar}"
  - status_actual: "${status}"

[HISTORY]
Aquí hay un breve historial relevante del ticket (si existe). Puede estar vacío.

${historyText}

[INPUT]
Ahora analiza SOLO este mensaje:

"${safeText}"

Tu trabajo es CLASIFICAR este mensaje y devolver un JSON con este formato:

{
  "is_relevant": boolean,
  "role": "team" | "requester",
  "kind": "feedback" | "smalltalk" | "noise",
  "status_intent": "none" | "in_progress" | "done_claim" | "cancel_request" | "reopen_request",
  "requester_side": "unknown" | "happy" | "neutral" | "still_broken" | "wants_cancel" | "complaining",
  "polarity": "positive" | "neutral" | "negative",
  "normalized_note": string,
  "rationale": string,
  "confidence": number
}

Reglas importantes:

1. Usa el campo "role_hint" como pista:
   - Si role_hint = "team", normalmente "role" debe ser "team".
   - Si role_hint = "requester", normalmente "role" debe ser "requester".
   Solo cambia si hay evidencia muy fuerte en el mensaje de que es otro rol (caso raro).

2. Campo "is_relevant":
   - true: el mensaje habla del ticket, su avance, la solución, un problema nuevo relacionado o una queja sobre el mismo asunto.
   - false: saludos sueltos, chistes, spam, cosas que no parecen relacionadas al ticket.

3. Campo "kind":
   - "feedback": cualquier mensaje que agregue información o comentario sobre el ticket (avance, problemas, dudas, quejas, etc.).
   - "smalltalk": saludos o cortesías sin contenido operativo ("gracias", "buen día", "ok", etc.), pero que siguen relacionados.
   - "noise": mensajes claramente irrelevantes para el ticket.

4. Campo "status_intent":
   - "none": no cambia el estado del ticket.
   - "in_progress": el equipo indica que está trabajando o que va a trabajar ("vamos para allá", "lo revisamos en un momento").
   - "done_claim": el equipo afirma que el problema quedó resuelto ("ya quedó", "se solucionó", "cambiamos el foco y funciona bien").
   - "cancel_request": alguien pide explícitamente cancelar el reporte ("ya no vengan", "cancelen el ticket", "ya no se necesita").
   - "reopen_request": típico del solicitante, cuando indica que la falla persiste o regresó DESPUÉS de un intento de solución
       ("sigue sin servir", "volvió a fallar", "otra vez lo mismo").

5. Campo "requester_side" (SOLO tiene sentido cuando "role" = "requester"):
   - "happy": el solicitante expresa que ya quedó bien o está satisfecho.
   - "neutral": mensaje neutro, no deja claro si está feliz o molesto, ni si sigue la falla.
   - "still_broken": el solicitante indica que el problema sigue, regresó o nunca se resolvió.
   - "wants_cancel": el solicitante pide que cancelen el ticket o que ya no atiendan.
   - "complaining": el solicitante se queja del servicio, del tiempo de respuesta, etc.
   - "unknown": cualquier otro caso o si el rol es "team".

6. Campo "polarity":
   - "positive": agradecimientos, satisfacción, tono claramente positivo.
   - "neutral": información factual sin carga emocional clara.
   - "negative": quejas, frustración, enojo, insatisfacción.

7. Campo "normalized_note":
   - Es un resumen corto, en tercera persona, claro y sin emojis.
   - Debe estar en español.

8. Campo "rationale":
   - Explica brevemente por qué escogiste esos valores, en una o dos frases.

9. Campo "confidence":
   - Número entre 0 y 1.

Recuerda: responde SOLO con el JSON, sin texto adicional.
`.trim();
}

/**
 * Fallback seguro si el modelo falla o devuelve algo raro.
 */
function buildFallbackResult({ text, roleHint }) {
  const note = (text || '').trim();
  return {
    is_relevant: true,
    role: roleHint === 'team' ? 'team' : 'requester',
    kind: 'feedback',
    status_intent: 'none',
    requester_side: roleHint === 'requester' ? 'neutral' : 'unknown',
    polarity: 'neutral',
    normalized_note: note.slice(0, 200) || 'Mensaje de seguimiento sin clasificar.',
    rationale: 'Resultado por defecto debido a error o respuesta inválida del modelo.',
    confidence: 0.4,
  };
}

/**
 * Llama a OpenAI y devuelve el objeto clasificado.
 *
 * @param {Object} params
 * @param {string} params.text              - Mensaje a clasificar.
 * @param {('team'|'requester')} params.roleHint
 * @param {Object} [params.ticket]          - Contexto del ticket: { folio, descripcion, lugar, status }
 * @param {Array}  [params.history]         - Historial breve, opcional.
 * @param {string} [params.model]           - Override de modelo.
 */
async function classifyFeedbackMessage({
  text,
  roleHint,
  ticket = {},
  history = [],
  model,
}) {
  const client = getClient();
  const systemPrompt = buildSystemPrompt();
  const userPrompt = buildUserPrompt({ text, roleHint, ticket, history });

  try {
    const completion = await client.chat.completions.create({
      model: model || FEEDBACK_MODEL,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      temperature: 0.1,
    });

    const raw = completion?.choices?.[0]?.message?.content || '{}';
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      if (DEBUG) console.warn('[FB-CLASS] JSON parse error:', e.message, 'raw=', raw);
      return buildFallbackResult({ text, roleHint });
    }

    const base = buildFallbackResult({ text, roleHint });

    const result = {
      is_relevant:
        typeof parsed.is_relevant === 'boolean' ? parsed.is_relevant : base.is_relevant,
      role:
        parsed.role === 'team' || parsed.role === 'requester'
          ? parsed.role
          : base.role,
      kind: ['feedback', 'smalltalk', 'noise'].includes(parsed.kind)
        ? parsed.kind
        : base.kind,
      status_intent: [
        'none',
        'in_progress',
        'done_claim',
        'cancel_request',
        'reopen_request',
      ].includes(parsed.status_intent)
        ? parsed.status_intent
        : base.status_intent,
      requester_side: [
        'unknown',
        'happy',
        'neutral',
        'still_broken',
        'wants_cancel',
        'complaining',
      ].includes(parsed.requester_side)
        ? parsed.requester_side
        : base.requester_side,
      polarity: ['positive', 'neutral', 'negative'].includes(parsed.polarity)
        ? parsed.polarity
        : base.polarity,
      normalized_note:
        typeof parsed.normalized_note === 'string' && parsed.normalized_note.trim()
          ? parsed.normalized_note.trim()
          : base.normalized_note,
      rationale:
        typeof parsed.rationale === 'string' && parsed.rationale.trim()
          ? parsed.rationale.trim()
          : base.rationale,
      confidence:
        typeof parsed.confidence === 'number'
          ? Math.max(0, Math.min(1, parsed.confidence))
          : base.confidence,
    };

    if (DEBUG) console.log('[FB-CLASS] out', result);
    return result;
  } catch (err) {
    if (DEBUG) console.warn('[FB-CLASS] API error:', err.message || err);
    return buildFallbackResult({ text, roleHint });
  }
}

module.exports = {
  classifyFeedbackMessage,
};

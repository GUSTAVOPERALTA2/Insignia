/**
 * niHandlers/interpretEditMessage.js
 *
 * Interpretador de mensajes de edición usando ChatGPT (OpenAI u otro wrapper).
 * Se reforzó el system prompt para que la IA:
 *  - Extraiga acciones de edición de forma asertiva (actuar antes que preguntar).
 *  - Mapee sinónimos de áreas a códigos internos (si se le proveen).
 *  - Detecte referencias a otro ticket ("el 2", "segundo", "el otro").
 *
 * Firma:
 *   interpretEditMessage(ctx = {}, text = '', options = {})
 * options puede incluir:
 *   - currentTicket: objeto (opcional)
 *   - allTickets: array (opcional)
 *   - mode: 'single'|'multiple' (opcional)
 *   - allowedAreas: { code: "Label", ... } (opcional)  // ayuda para la IA a devolver códigos
 *
 * Output (schema):
 * {
 *   actions: [{ field: "descripcion"|"lugar"|"area_destino", op: "replace"|"append"|"prepend"|"clear", value: "texto nuevo" }],
 *   ticketIndex?: 0,
 *   confidence: 0.0,
 *   needsClarification: false,
 *   clarify: ""
 * }
 */

const DEFAULT_TIMEOUT = 15000;
const DEFAULT_MAX_TOKENS = 400;
const DEFAULT_TEMPERATURE = 0.12;
const DEFAULT_CONF_THRESHOLD = 0.7;

const CONFIDENCE_THRESHOLD = Number(process.env.NI_EDIT_CONF_THRESHOLD) || DEFAULT_CONF_THRESHOLD;
const MODEL = process.env.VICEBOT_AI_MODEL || process.env.VICEBOT_CONTEXT_REPLY_MODEL || 'gpt-4o';

const { OpenAI } = (() => {
  try { return require('openai'); } catch (e) { return {}; }
})();

async function callOpenAIChatDirect({ apiKey, messages, model = MODEL, temperature = DEFAULT_TEMPERATURE, max_tokens = DEFAULT_MAX_TOKENS }) {
  if (!OpenAI) throw new Error('openai library not available');
  const client = new OpenAI({ apiKey });
  const resp = await client.chat.completions.create({
    model,
    messages,
    max_tokens,
    temperature,
  });
  const content = resp?.choices?.[0]?.message?.content ?? resp?.choices?.[0]?.message ?? null;
  return content;
}

function buildSystemPrompt() {
  return `Eres un extractor de ACCIONES DE EDICIÓN para tickets en español. DEVUELVE SOLO JSON válido exactamente con este schema (nada más):

{
  "actions": [
    { "field": "descripcion" | "lugar" | "area_destino", "op": "replace" | "append" | "prepend" | "clear", "value": "texto nuevo" }
  ],
  "ticketIndex": 0,            // opcional, índice si se refiere a otro ticket en un batch (0-based)
  "confidence": 0.0,           // número entre 0 y 1
  "needsClarification": false,
  "clarify": ""                // si needsClarification=true, pregunta breve en español
}

Reglas IMPORTANTES:
- Devuelve únicamente el JSON (sin código, sin explicaciones, sin backticks).
- Sé asertivo: si el usuario escribe un cambio claro (p.ej. "ponlo para mantenimiento", "es la 3101", "cambié a it"), interpreta y EMITE la acción correspondiente sin preguntar.
- Solo pide clarificación (needsClarification=true) si realmente NO puedes determinar el campo objetivo o el valor con un umbral de confianza razonable.
- Para 'lugar', puedes devolver valores directos como "3101" o "Habitación 3101"; el sistema hará normalización posterior.
- Detecta referencias a otros tickets en modo múltiple:
  - "el 2", "el segundo", "el otro" -> ticketIndex: 1 (usa 0-based).
  - Si no hay referencia, no incluyas ticketIndex.
- Si el usuario usa sinónimos de áreas (ej. "AyB", "restaurante", "cocina", "limpieza", "camarista", "fuga"), intenta devolver el código del área si el cliente pasa un map de allowedAreas; si no, devuelve el texto en value y confidence baja.
- Usa ops según intención:
  - replace = sustituir por completo
  - append = añadir al final
  - prepend = añadir al inicio
  - clear = borrar campo
- Mantén respuestas consistentes y temperatura baja.

Ejemplos (entrada -> salida esperada):
- "cambiar a mantenimiento" -> { "actions":[{"field":"area_destino","op":"replace","value":"man"}], "confidence":0.98, "needsClarification": false }
- "en la 3101, por favor" -> { "actions":[{"field":"lugar","op":"replace","value":"3101"}], "confidence":0.95, "needsClarification": false }
- "agrega que hay fuga y huele a gas" -> { "actions":[{"field":"descripcion","op":"append","value":"Fuga, olor a gas"}], "confidence":0.9, "needsClarification": false }
- "¿te refieres al segundo?" -> { "actions":[], "confidence":0.3, "needsClarification": true, "clarify":"¿Quieres que cambie al ticket 2?" }

Si te pasan un objeto 'allowedAreas' en el contexto, úsalo para mapear nombres a códigos internos.`;
}

/**
 * interpretEditMessage(ctx, text, options)
 */
async function interpretEditMessage(ctx = {}, text = '', options = {}) {
  if (!text || !text.trim()) return null;

  const systemPrompt = buildSystemPrompt();

  // If options provide currentTicket/allTickets, include a compact summary to help the model decide.
  let contextSummary = '';
  if (options.currentTicket) {
    const ct = options.currentTicket;
    const shortDesc = (ct.descripcion || ct.descripcion_original || '').slice(0, 140).replace(/\n/g, ' ');
    contextSummary += `Ticket actual: descripcion="${shortDesc}", lugar="${ct.lugar || ''}", area="${ct.area_destino || ''}".\n`;
  }
  if (Array.isArray(options.allTickets) && options.allTickets.length > 0) {
    contextSummary += `Hay ${options.allTickets.length} tickets en batch. Puedes referirte a ellos por número (1..${options.allTickets.length}).\n`;
  }
  if (options.mode === 'multiple') {
    contextSummary += 'Modo: multiple tickets (si el usuario dice "el 2", asume ticketIndex:1 si es claro).\n';
  }
  if (options.allowedAreas) {
    const mapEntries = Object.entries(options.allowedAreas).slice(0, 20).map(([k, v]) => `${k}=${v}`).join(', ');
    contextSummary += `Map de areas (ejemplo): ${mapEntries}\n`;
  }

  const userPrompt = `Analiza el mensaje de edición en español: """${text.replace(/\"/g, '\\"')}""".
Contexto adicional:
${contextSummary}
Devuelve SOLO JSON con el esquema pedido.`;

  let raw = null;

  try {
    if (typeof ctx.aiChat === 'function') {
      if (ctx.DEBUG) console.log('[EDIT-INT] using ctx.aiChat wrapper');
      raw = await ctx.aiChat({
        system: systemPrompt,
        user: userPrompt,
        temperature: DEFAULT_TEMPERATURE,
        max_tokens: DEFAULT_MAX_TOKENS,
      });
      if (typeof raw === 'object' && raw?.content) raw = raw.content;
      if (typeof raw === 'object' && raw?.message) raw = raw.message;
      if (Array.isArray(raw) && raw.length) raw = raw[0];
    } else {
      const apiKey = ctx.OPENAI_API_KEY || process.env.OPENAI_API_KEY;
      if (!apiKey) {
        if (ctx.DEBUG) console.warn('[EDIT-INT] OPENAI_API_KEY missing');
        throw new Error('OPENAI_API_KEY not configured');
      }
      const messages = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ];
      raw = await callOpenAIChatDirect({ apiKey, messages, model: MODEL, temperature: DEFAULT_TEMPERATURE, max_tokens: DEFAULT_MAX_TOKENS });
    }

    if (!raw || typeof raw !== 'string') {
      if (ctx.DEBUG) console.warn('[EDIT-INT] no text response from AI', raw);
      return null;
    }

    // Extract the first JSON object in the response
    const firstBrace = raw.indexOf('{');
    const lastBrace = raw.lastIndexOf('}');
    if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) {
      if (ctx.DEBUG) console.warn('[EDIT-INT] no JSON found in AI response:', raw);
      return null;
    }
    const jsonText = raw.substring(firstBrace, lastBrace + 1);

    let parsed;
    try {
      parsed = JSON.parse(jsonText);
    } catch (parseErr) {
      if (ctx.DEBUG) {
        console.warn('[EDIT-INT] JSON parse error', parseErr.message);
        console.warn('[EDIT-INT] jsonText:', jsonText);
      }
      return null;
    }

    // Normalize parsed object
    if (!Array.isArray(parsed.actions)) parsed.actions = [];
    parsed.confidence = typeof parsed.confidence === 'number' ? parsed.confidence : 1.0;
    parsed.needsClarification = !!parsed.needsClarification;
    parsed.clarify = parsed.clarify || '';

    // If low confidence, mark needsClarification
    if (parsed.confidence < CONFIDENCE_THRESHOLD && !parsed.needsClarification) {
      parsed.needsClarification = true;
      parsed.clarify = parsed.clarify || 'No estoy seguro de qué quieres cambiar exactamente. ¿Puedes aclararlo?';
    }

    if (ctx.DEBUG) console.log('[EDIT-INT] parsed intent', { actions: parsed.actions.length, confidence: parsed.confidence, needsClarify: parsed.needsClarification });

    return parsed;
  } catch (err) {
    if (ctx.DEBUG) console.error('[interpretEditMessage] error', err?.message || err);
    return null;
  }
}

module.exports = { interpretEditMessage };
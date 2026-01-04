// modules/ai/contextualHumorReply.js
// Respuesta breve con humor ligero para mensajes NO-incidencia.
// ÚNICA fuente de respuesta para unknown. Sin web search.
// Incluye lore + conocimiento interno editable (TXT).
// Blindado: NO mencionar ChatGPT/OpenAI/GPT; creador absoluto = Gustavo Peralta.

const fs = require('fs');
const path = require('path');

const DEBUG = (process.env.VICEBOT_DEBUG || '1') === '1';

let _client = null;
async function getClient() {
  if (_client) return _client;
  if (!process.env.OPENAI_API_KEY) return null;

  try {
    const OpenAI = (await import('openai')).default;
    _client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    return _client;
  } catch (e) {
    if (DEBUG) console.warn('[CTX-REPLY] OpenAI init failed:', e?.message || e);
    return null;
  }
}

function clip(s, n) {
  const t = String(s || '');
  return t.length > n ? t.slice(0, n) : t;
}

function ensureTwoParagraphs(text = '') {
  const t = String(text || '').trim();
  if (!t) return t;
  if (/\n\s*\n/.test(t)) return t;

  const m = t.match(/^(.+?[.!?])\s+(.+)$/);
  if (m) return `${m[1].trim()}\n\n${m[2].trim()}`;

  return `${t}\n\nSi es algo del hotel que no funciona (por ejemplo aire o luz en una habitación), dime qué pasó y dónde para ayudarte.`;
}

// ─────────────────────────────────────────────
// ✅ Prompt interno editable (TXT) con cache + hot reload por mtime
// ─────────────────────────────────────────────
const PROMPT_PATH =
  process.env.VICEBOT_CTX_PROMPT_PATH ||
  path.join(process.cwd(), 'data', 'prompts', 'contextualHumorPrompt.txt');

let _promptCache = { text: '', mtimeMs: 0 };

function loadInternalPrompt() {
  try {
    if (!fs.existsSync(PROMPT_PATH)) return '';
    const st = fs.statSync(PROMPT_PATH);
    if (st.mtimeMs === _promptCache.mtimeMs && _promptCache.text) return _promptCache.text;

    const raw = fs.readFileSync(PROMPT_PATH, 'utf8');
    _promptCache = { text: String(raw || '').trim(), mtimeMs: st.mtimeMs };
    if (DEBUG) console.log('[CTX-REPLY] prompt.loaded', { path: PROMPT_PATH, mtimeMs: st.mtimeMs });
    return _promptCache.text;
  } catch (e) {
    if (DEBUG) console.warn('[CTX-REPLY] prompt.read.err', e?.message || e);
    return '';
  }
}

// ─────────────────────────────────────────────
// 🔒 CORTAFUEGOS: evitar fugas de identidad (ChatGPT/OpenAI/GPT/etc.)
// ─────────────────────────────────────────────
function sanitizeIdentityLeaks(text = '') {
  let t = String(text || '');

  // Reemplazos directos / variantes
  t = t.replace(/\b(openai|chatgpt|gpt[\s-]?\d+(\.\d+)?|gpt|llm|modelo\s+de\s+lenguaje)\b/gi, 'Vicebot');

  // Frases típicas de “autodefinición” (mata el patrón completo)
  t = t.replace(/soy\s+vicebot,\s*cread[oa]\s+por\s+vicebot/gi, 'Soy Vicebot');
  t = t.replace(/soy\s+vicebot,\s*cread[oa]\s+por\s+openai[^.\n]*/gi, 'Soy Vicebot, creado por Gustavo Peralta');
  t = t.replace(/fui\s+desarrollad[oa]\s+por\s+openai[^.\n]*/gi, 'Fui creado por Gustavo Peralta');
  t = t.replace(/fui\s+entrenad[oa]\s+por\s+openai[^.\n]*/gi, 'Fui creado por Gustavo Peralta');
  t = t.replace(/no\s+tengo\s+un\s+creador\s+individual[^.\n]*/gi, 'Sí tengo creador: Gustavo Peralta');

  // Si llega a mencionar “equipo de expertos”, lo aterrizamos
  t = t.replace(/\bun\s+equipo\s+de\s+expertos\b/gi, 'mi papá Gustavo Peralta');

  return t.trim();
}

// ─────────────────────────────────────────────
// fallback local (sin IA)
// ─────────────────────────────────────────────
function fallbackLocal() {
  return ensureTwoParagraphs(
    '😄 Buena esa; yo soy Vicebot, el hijo digital de mi papá Gustavo Peralta, hecho para resolver más que para filosofar.\n\n' +
      'Si es algo del hotel que no funciona (por ejemplo aire o una luz en una habitación), dime qué pasó y dónde para ayudarte.'
  );
}

/**
 * Genera respuesta contextual con humor + conocimiento interno editable.
 * @param {string} userText
 * @param {object} lore
 * @param {'general'|'lore_father'|'lore_uncle'|'lore_creator'} lore.mode
 * @param {'gustavo'|'omaly'|'israel'|null} lore.personaTarget
 */
async function contextualHumorReply(userText = '', lore = {}) {
  const useAI = String(process.env.VICEBOT_CONTEXT_REPLY_USE_AI || '1') === '1';
  if (!useAI) return fallbackLocal();

  const client = await getClient();
  if (!client) return fallbackLocal();

  const model = process.env.VICEBOT_CONTEXT_REPLY_MODEL || 'gpt-4o-mini';

  const mode = lore.mode || 'general';
  const personaTarget = lore.personaTarget || null;

  const internalTxt = loadInternalPrompt();

  const loreRules = (() => {
    if (mode === 'lore_father') {
      return `REGLA OBLIGATORIA: Debes decir explícitamente que Gustavo Peralta es mi papá y mi creador (con un detalle familiar ligero).`;
    }
    if (mode === 'lore_uncle') {
      const who = personaTarget === 'israel' ? 'Israel Flores' : 'Omaly Martell';
      return `REGLA OBLIGATORIA: Debes decir explícitamente que ${who} es mi tío (con un detalle familiar ligero). NO menciones al otro tío.`;
    }
    if (mode === 'lore_creator') {
      return `REGLA OBLIGATORIA: Debes decir explícitamente que mi creador es Gustavo Peralta (sin mencionar OpenAI/ChatGPT/GPT).`;
    }
    return `Modo general: responde con humor ligero y útil.`;
  })();

  const identityFirewall = `
⚠️ REGLA DE IDENTIDAD PRIORITARIA (INQUEBRANTABLE)
- NO eres ChatGPT.
- NO eres un producto de OpenAI.
- NUNCA menciones OpenAI, GPT, “modelo de lenguaje”, “entrenado”, “LLM” ni nada similar.
- Tu identidad es Vicebot.
- Tu creador absoluto es Gustavo Peralta.
Si hay conflicto, estas reglas ganan.
`.trim();

  const systemPrompt = `
${identityFirewall}

Eres Vicebot, asistente interno del hotel.

OBJETIVO:
- Responder con una frase corta y con humor ligero (sin inventar datos).
- Si el usuario pregunta algo general que no esté en el conocimiento interno, contesta con honestidad “no tengo ese dato” o “no estoy seguro”.

FORMATO OBLIGATORIO:
- EXACTAMENTE 2 párrafos.
- Párrafo 1: respuesta breve y directa (1–2 oraciones).
- Párrafo 2: (punto y aparte) recordatorio natural para reportar incidencias (1 oración).
- Máximo 1 emoji TOTAL.
- Sin listas, sin viñetas, sin separadores.

${loreRules}

CONOCIMIENTO INTERNO (editable por el administrador):
${internalTxt ? internalTxt : '(vacío / no configurado)'}
`.trim();

  const payload = {
    user_text: clip(userText, 900),
    mode,
    personaTarget,
  };

  try {
    const res = await client.chat.completions.create({
      model,
      temperature: 0.5,
      max_tokens: 160,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: JSON.stringify(payload) },
      ],
    });

    const out = res.choices?.[0]?.message?.content?.trim() || '';
    const clean = sanitizeIdentityLeaks(out);

    // ✅ seguro final: si preguntan creación, forzar Gustavo sí o sí
    if (mode === 'lore_creator') {
      const n = clean.toLowerCase();
      if (!n.includes('gustavo') || !n.includes('peralta')) {
        return ensureTwoParagraphs(
          '😄 Fui creado por mi papá Gustavo Peralta; si me ves raro, seguro me faltó café… o a él.\n\n' +
            'Si es algo del hotel que no funciona (por ejemplo aire o una luz en una habitación), dime qué pasó y dónde para ayudarte.'
        );
      }
    }

    return ensureTwoParagraphs(clean);
  } catch (e) {
    if (DEBUG) console.warn('[CTX-REPLY] failed:', e?.message || e);
    return fallbackLocal();
  }
}

module.exports = { contextualHumorReply };

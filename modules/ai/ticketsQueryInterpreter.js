// modules/ai/ticketsQueryInterpreter.js
// ═══════════════════════════════════════════════════════════════════════════
// Intérprete de consultas de tickets usando IA
// La IA determina la intención del usuario de forma flexible
// ═══════════════════════════════════════════════════════════════════════════

const OpenAI = require('openai');

const DEBUG = (process.env.VICEBOT_DEBUG || '1') === '1';

const client = process.env.OPENAI_API_KEY
  ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  : null;

// ──────────────────────────────────────────────────────────────
// Aliases de área → código canónico
// ──────────────────────────────────────────────────────────────

const AREA_ALIASES = {
  // HSKP / Ama de llaves
  hskp: 'ama',
  housekeeping: 'ama',
  limpieza: 'ama',
  ama: 'ama',
  'ama de llaves': 'ama',
  camaristas: 'ama',

  // IT / Sistemas
  it: 'it',
  sistemas: 'it',
  informatica: 'it',
  informática: 'it',
  soporte: 'it',
  computo: 'it',
  cómputo: 'it',
  ti: 'it',
  tecnologia: 'it',
  tecnología: 'it',

  // Mantenimiento
  mantenimiento: 'man',
  man: 'man',
  mant: 'man',
  mtto: 'man',
  ingenieria: 'man',
  ingeniería: 'man',
  electrico: 'man',
  eléctrico: 'man',
  electromecanico: 'man',

  // Room Service
  rs: 'rs',
  'room service': 'rs',
  'servicio a cuartos': 'rs',
  sac: 'rs',
  alimentos: 'rs',

  // Seguridad
  seg: 'seg',
  seguridad: 'seg',
  security: 'seg',
  vigilancia: 'seg',

  // Experiencias / Connect
  exp: 'exp',
  experiencias: 'exp',
  connect: 'exp',
  'guest experience': 'exp',
  concierge: 'exp',
  recepcion: 'exp',
  recepción: 'exp',
};

function normalizeArea(area) {
  if (!area) return null;
  const a = String(area).toLowerCase().trim();
  return AREA_ALIASES[a] || a;
}

function safeJsonParse(s) {
  try {
    // Limpiar posibles backticks de markdown
    const clean = s.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    return JSON.parse(clean);
  } catch {
    return null;
  }
}

// ──────────────────────────────────────────────────────────────
// Prompt para la IA
// ──────────────────────────────────────────────────────────────

function buildPrompt({ text, context = {} }) {
  const userArea = context.userTeam || context.userArea || null;
  const userName = context.userName || null;
  
  return `
Eres un clasificador de intenciones para un sistema de tickets de hotel. Tu tarea es determinar si el mensaje del usuario es una CONSULTA DE TICKETS (quiere ver/listar tickets existentes) o NO.

## CONTEXTO DEL USUARIO
${userArea ? `- Área asignada: ${userArea}` : '- Sin área asignada'}
${userName ? `- Nombre: ${userName}` : ''}

## CLASIFICACIÓN

### ES CONSULTA DE TICKETS (is_tickets_query: true):
- "pendientes" / "completadas" / "canceladas" → Quiere ver tickets con ese status
- "mis pendientes" / "mis tareas" → Quiere ver SUS tickets
- "pendientes de IT" / "tareas de mantenimiento" → Tickets de un área específica
- "pendientes de hoy" / "completadas de ayer" → Tickets con filtro de fecha
- "qué hay pendiente" / "qué tenemos" → Consulta general
- "buscar [tema]" (en contexto de tickets) → Búsqueda en tickets
- Cualquier variante que implique VER/CONSULTAR/LISTAR tickets existentes
- **PAGINACIÓN**: "página 2", "página 3", "más", "siguiente", "ver más" → Es navegación de resultados, marcar is_pagination=true

### NO ES CONSULTA DE TICKETS (is_tickets_query: false):
- REPORTES DE PROBLEMAS: "no funciona X", "hay fuga", "se descompuso", "urge en 1205"
- CONTEXTO CONVERSACIONAL: "quedo pendiente", "gracias", "ok", "me avisan"
- PREGUNTAS DE HUÉSPED: "el huésped busca su cartera", "ayuda con un cliente"
- SALUDOS: "hola", "buenos días"
- PREGUNTAS GENERALES: "dónde está el gym", "cómo llego a"

## EXTRACCIÓN DE DATOS (solo si is_tickets_query: true)

### status (string | null):
- "open" → pendientes, abiertos, activos, sin resolver, por hacer
- "done" → completados, cerrados, terminados, resueltos, listos
- "canceled" → cancelados, anulados
- null → no especifica status (mostrar todos)

### areas (array | null):
- Normalizar a códigos: "it", "man", "ama", "seg", "rs", "exp"
- Puede ser múltiples: ["it", "man"]
- null → no especifica área

### date_filter (string | null):
- "today" → hoy
- "yesterday" → ayer  
- "this_week" → esta semana
- "last_week" → semana pasada
- "this_month" → este mes
- null → sin filtro de fecha

### search_text (string | null):
- Texto a buscar dentro de tickets (lugar, descripción)
- Solo si el usuario quiere BUSCAR algo específico

### scope (string):
- "mine" → Solo tickets del usuario (creados por él O asignados a su área)
- "area" → Tickets de un área específica (usar con areas)
- "all" → Todos los tickets (cuando dice "todos", "global")

### priority_own_area (boolean):
- true → Si dice "mis pendientes" sin área, priorizar su área asignada
- false → No aplica priorización especial

## RESPUESTA
Responde SOLO con JSON válido:
{
  "is_tickets_query": boolean,
  "is_pagination": boolean,
  "page": number | null,
  "confidence": number (0-1),
  "status": "open" | "done" | "canceled" | null,
  "areas": ["it", "man", ...] | null,
  "date_filter": "today" | "yesterday" | "this_week" | "last_week" | "this_month" | null,
  "search_text": string | null,
  "scope": "mine" | "area" | "all",
  "priority_own_area": boolean,
  "rationale": string (explicación breve)
}

## MENSAJE DEL USUARIO:
"""${text}"""
`.trim();
}

// ──────────────────────────────────────────────────────────────
// Función principal de interpretación
// ──────────────────────────────────────────────────────────────

async function interpretTicketsQuery({ text, context = {} }) {
  if (!client) {
    if (DEBUG) console.warn('[TICKETS-AI] OpenAI client not available');
    return null;
  }

  const prompt = buildPrompt({ text, context });

  try {
    const res = await client.chat.completions.create({
      model: process.env.VICEBOT_TICKETS_AI_MODEL || 'gpt-4o-mini',
      temperature: 0.1,
      max_tokens: 500,
      messages: [{ role: 'user', content: prompt }],
    });

    const raw = res?.choices?.[0]?.message?.content || '';
    
    if (DEBUG) {
      console.log('[TICKETS-AI] raw response:', raw.substring(0, 200));
    }
    
    const parsed = safeJsonParse(raw);
    
    if (!parsed) {
      if (DEBUG) console.warn('[TICKETS-AI] Failed to parse response');
      return null;
    }

    // Normalizar áreas
    if (parsed.areas && Array.isArray(parsed.areas)) {
      parsed.areas = parsed.areas.map(normalizeArea).filter(Boolean);
      if (parsed.areas.length === 0) parsed.areas = null;
    }

    // Agregar contexto del usuario al resultado
    parsed._context = {
      userArea: context.userTeam || context.userArea || null,
      userName: context.userName || null,
    };

    if (DEBUG) {
      console.log('[TICKETS-AI] interpreted:', {
        isQuery: parsed.is_tickets_query,
        status: parsed.status,
        areas: parsed.areas,
        scope: parsed.scope,
        confidence: parsed.confidence,
      });
    }

    return parsed;
    
  } catch (e) {
    if (DEBUG) console.error('[TICKETS-AI] Error:', e?.message || e);
    return null;
  }
}

// ──────────────────────────────────────────────────────────────
// Función de fallback (cuando no hay IA disponible)
// ──────────────────────────────────────────────────────────────

function interpretTicketsQueryFallback(text) {
  const t = String(text || '').toLowerCase().trim();
  
  // Patrones muy básicos como fallback
  const isQuery = /\b(tickets?|tareas?|pendientes?|completad[ao]s?|cancelad[ao]s?|mis\s+\w+)\b/.test(t) &&
                  !/\b(no\s+funciona|hay\s+fuga|urge|se\s+descompuso|quedo\s+pendiente)\b/.test(t);
  
  if (!isQuery) {
    return { is_tickets_query: false, confidence: 0.5, rationale: 'fallback_no_match' };
  }
  
  // Detectar status básico
  let status = null;
  if (/\b(pendientes?|abiertos?|activos?)\b/.test(t)) status = 'open';
  else if (/\b(completad[ao]s?|cerrad[ao]s?|terminad[ao]s?|resuelt[ao]s?)\b/.test(t)) status = 'done';
  else if (/\b(cancelad[ao]s?|anulad[ao]s?)\b/.test(t)) status = 'canceled';
  
  // Detectar área básica
  let areas = null;
  if (/\b(it|sistemas|tecnolog[ií]a)\b/.test(t)) areas = ['it'];
  else if (/\b(mantenimiento|mtto|man)\b/.test(t)) areas = ['man'];
  else if (/\b(ama|hskp|limpieza|housekeeping)\b/.test(t)) areas = ['ama'];
  else if (/\b(seguridad|seg)\b/.test(t)) areas = ['seg'];
  else if (/\b(room\s*service|rs|alimentos)\b/.test(t)) areas = ['rs'];
  
  // Detectar scope
  let scope = 'mine';
  if (/\b(todos?|todas?|global)\b/.test(t)) scope = 'all';
  else if (areas) scope = 'area';
  
  return {
    is_tickets_query: true,
    confidence: 0.6,
    status,
    areas,
    date_filter: null,
    search_text: null,
    scope,
    priority_own_area: /\bmis?\b/.test(t),
    rationale: 'fallback_pattern_match',
  };
}

// ──────────────────────────────────────────────────────────────
// API pública
// ──────────────────────────────────────────────────────────────

async function interpret(text, context = {}) {
  // Intentar con IA primero
  const aiResult = await interpretTicketsQuery({ text, context });
  
  if (aiResult) {
    return aiResult;
  }
  
  // Fallback si no hay IA
  if (DEBUG) console.log('[TICKETS-AI] Using fallback interpreter');
  return interpretTicketsQueryFallback(text);
}

module.exports = {
  interpretTicketsQuery,
  interpretTicketsQueryFallback,
  interpret,
  normalizeArea,
  AREA_ALIASES,
};
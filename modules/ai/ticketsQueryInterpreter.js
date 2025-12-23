// modules/ia/ticketsQueryInterpreter.js
const OpenAI = require('openai');

const client = process.env.OPENAI_API_KEY
  ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  : null;

// Aliases de área → canon (ajusta a tus códigos reales)
const AREA_ALIASES = {
  // HSKP
  hskp: 'ama',
  housekeeping: 'ama',
  limpieza: 'ama',
  ama: 'ama',
  'ama de llaves': 'ama',
  camaristas: 'ama',

  // IT
  it: 'it',
  sistemas: 'it',
  informatica: 'it',
  soporte: 'it',
  computo: 'it',
  ti: 'it',

  // Mantenimiento
  mantenimiento: 'man',
  man: 'man',
  maint: 'man',
  ingenieria: 'man',
  electrico: 'man',
  electromecanico: 'man',

  // Room Service
  rs: 'rs',
  'room service': 'rs',
  'servicio a cuartos': 'rs',
  sac: 'rs',

  // Seguridad
  seg: 'seg',
  seguridad: 'seg',
  security: 'seg',

  // Experiencias / Connect
  exp: 'exp',
  experiencias: 'exp',
  connect: 'exp',
  'guest experience': 'exp',
};

function normalizeArea(area) {
  if (!area) return null;
  const a = String(area).toLowerCase().trim();
  return AREA_ALIASES[a] || a;
}

function safeJsonParse(s) {
  try { return JSON.parse(s); } catch { return null; }
}

function buildPrompt({ text }) {
  return `
Eres un analizador de lenguaje natural para un bot de tickets. Tu tarea es decidir si el mensaje del usuario es una consulta de tickets y, si lo es, producir argumentos para el comando /tickets.

Reglas IMPORTANTES:
1) SOLO marca is_tickets_query=true si el usuario claramente pide ver/consultar/buscar tickets, tareas, pendientes, reportes, incidencias.
2) "Tono de búsqueda" cuenta como consulta de tickets SOLO cuando busca una SITUACIÓN/INCIDENCIA, por ejemplo:
   - "busca gotera"
   - "busca problemas de internet"
   - "busca problemas de aire acondicionado"
   - "hay tareas de casero?"
   En estos casos, usa place con el tema a buscar (ej: "gotera", "internet", "aire acondicionado", "casero").
3) NO es consulta de tickets cuando es búsqueda genérica de ayuda o de objetos sin relación a incidencias, por ejemplo:
   - "ayuda estoy buscando ayuda"
   - "ayúdenme buscando el control"
   - "busco a Juan"
   => is_tickets_query=false
4) status:
   - Si el usuario dice "pendientes", "abiertos", "en curso", "en proceso" => status debe ser "open"
   - Si dice "cerrados", "completados", "resueltos", "terminados" => status debe ser "closed"
   - Si dice "cancelados" => status "canceled"
   - Si no se menciona status, pon null.
5) mine:
   - Por defecto true (el usuario quiere ver sus tickets)
   - Si el usuario pide explícitamente "de IT", "de mantenimiento", "del área X", etc., y se entiende que quiere filtrar por área, pon mine=false y area=<área>
   - Si pide "todos", "global", "de todas las áreas" => mine=false y area=null
6) area:
   - Normaliza a: ama, it, man, rs, seg, exp (si aplica)
7) confidence: 0 a 1.

Devuelve SOLO JSON válido con esta forma exacta:
{
  "is_tickets_query": true|false,
  "confidence": 0.0,
  "area": "it" | "ama" | "man" | "rs" | "seg" | "exp" | null,
  "status": "open" | "closed" | "canceled" | null,
  "place": string|null,
  "mine": true|false,
  "rationale": string
}

Mensaje del usuario:
"""${text}"""
`.trim();
}

async function interpretTicketsQuery({ text, context = {} }) {
  if (!client) return null;

  const prompt = buildPrompt({ text });

  const res = await client.chat.completions.create({
    model: process.env.VICEBOT_TICKETS_AI_MODEL || 'gpt-4o-mini',
    temperature: 0.1,
    messages: [{ role: 'user', content: prompt }],
  });

  const raw = res?.choices?.[0]?.message?.content || '';
  const parsed = safeJsonParse(raw);
  if (!parsed) return null;

  if (parsed.area) parsed.area = normalizeArea(parsed.area);

  return parsed;
}

module.exports = { interpretTicketsQuery };

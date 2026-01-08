// modules/ai/reportQueryInterpreter.js
// ═══════════════════════════════════════════════════════════════════════════
// Intérprete de solicitudes de reportes usando IA
// Determina si el usuario quiere generar un reporte Excel
// ═══════════════════════════════════════════════════════════════════════════

const OpenAI = require('openai');

const DEBUG = (process.env.VICEBOT_DEBUG || '1') === '1';

const client = process.env.OPENAI_API_KEY
  ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  : null;

// ──────────────────────────────────────────────────────────────
// Utilidades
// ──────────────────────────────────────────────────────────────

function safeJsonParse(s) {
  try {
    const clean = s.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    return JSON.parse(clean);
  } catch {
    return null;
  }
}

function getTodayDate() {
  const now = new Date();
  return now.toISOString().split('T')[0]; // YYYY-MM-DD
}

function getYesterdayDate() {
  const now = new Date();
  now.setDate(now.getDate() - 1);
  return now.toISOString().split('T')[0];
}

// ──────────────────────────────────────────────────────────────
// Prompt para la IA
// ──────────────────────────────────────────────────────────────

function buildPrompt({ text }) {
  const today = getTodayDate();
  const yesterday = getYesterdayDate();
  
  return `
Eres un clasificador que determina si el usuario quiere GENERAR UN REPORTE/EXPORTAR datos de incidencias.

## FECHA ACTUAL
Hoy es: ${today}
Ayer fue: ${yesterday}

## ES SOLICITUD DE REPORTE (is_report_request: true):
- "generar reporte" / "genera reporte" / "generame un reporte"
- "exportar" / "exportar incidencias" / "exportar tickets"
- "reporte de IT" / "reporte de mantenimiento"
- "reporte de hoy" / "reporte de ayer" / "reporte de la semana"
- "dame el excel" / "quiero el excel de tickets"
- "exportar pendientes" / "reporte de completados"
- "descarga de incidencias"
- Cualquier variante que implique EXPORTAR/GENERAR/DESCARGAR un archivo de datos

## NO ES SOLICITUD DE REPORTE (is_report_request: false):
- Consultas simples: "pendientes", "mis tickets", "tickets de IT"
- Reportes de problemas: "reportar que no funciona el aire"
- Preguntas: "cuántos tickets hay"
- Saludos, conversación general

## EXTRACCIÓN DE FILTROS (solo si is_report_request: true)

### areas (array | null):
- Normalizar a códigos: "it", "man", "ama", "seg", "rs", "exp"
- Puede ser múltiples: ["it", "man"]
- null → todas las áreas

### statuses (array | null):
- "open" → pendientes, abiertos
- "in_progress" → en proceso
- "done" → completados, cerrados, finalizados
- "canceled" → cancelados
- null → todos los estados

### start_date (string | null):
- Formato YYYY-MM-DD
- "hoy" → ${today}
- "ayer" → ${yesterday}
- "esta semana" → calcular inicio de semana
- "este mes" → calcular inicio de mes

### end_date (string | null):
- Formato YYYY-MM-DD
- Por defecto igual a start_date si solo se menciona un día

## RESPUESTA
Responde SOLO con JSON válido:
{
  "is_report_request": boolean,
  "confidence": number (0-1),
  "areas": ["it", "man", ...] | null,
  "statuses": ["open", "done", ...] | null,
  "start_date": "YYYY-MM-DD" | null,
  "end_date": "YYYY-MM-DD" | null,
  "rationale": string (explicación breve)
}

## MENSAJE DEL USUARIO:
"""${text}"""
`.trim();
}

// ──────────────────────────────────────────────────────────────
// Función principal
// ──────────────────────────────────────────────────────────────

async function interpretReportQuery({ text, context = {} }) {
  if (!client) {
    if (DEBUG) console.warn('[REPORT-AI] OpenAI client not available');
    return null;
  }

  const prompt = buildPrompt({ text });

  try {
    const res = await client.chat.completions.create({
      model: process.env.VICEBOT_TICKETS_AI_MODEL || 'gpt-4o-mini',
      temperature: 0.1,
      max_tokens: 400,
      messages: [{ role: 'user', content: prompt }],
    });

    const raw = res?.choices?.[0]?.message?.content || '';
    
    if (DEBUG) {
      console.log('[REPORT-AI] raw response:', raw.substring(0, 200));
    }
    
    const parsed = safeJsonParse(raw);
    
    if (!parsed) {
      if (DEBUG) console.warn('[REPORT-AI] Failed to parse response');
      return null;
    }

    if (DEBUG) {
      console.log('[REPORT-AI] interpreted:', {
        isReport: parsed.is_report_request,
        areas: parsed.areas,
        statuses: parsed.statuses,
        startDate: parsed.start_date,
        endDate: parsed.end_date,
        confidence: parsed.confidence,
      });
    }

    return parsed;
    
  } catch (e) {
    if (DEBUG) console.error('[REPORT-AI] Error:', e?.message || e);
    return null;
  }
}

// ──────────────────────────────────────────────────────────────
// Fallback sin IA
// ──────────────────────────────────────────────────────────────

function interpretReportQueryFallback(text) {
  const t = String(text || '').toLowerCase().trim();
  
  // Patrones de solicitud de reporte
  const reportPatterns = [
    /\b(generar?|genera|generame)\s+(un\s+)?reporte/,
    /\b(exportar?|exporta|exportame)\b/,
    /\breporte\s+(de|del|para)\b/,
    /\b(dame|quiero|necesito)\s+(el\s+)?(excel|reporte|exportar)/,
    /\bdescargar?\s+(incidencias|tickets|reporte)/,
    /\bexcel\s+(de\s+)?(tickets|incidencias)/,
  ];
  
  const isReport = reportPatterns.some(p => p.test(t));
  
  if (!isReport) {
    return { is_report_request: false, confidence: 0.5, rationale: 'fallback_no_match' };
  }
  
  // Detectar áreas
  let areas = null;
  if (/\b(it|sistemas|tecnolog[ií]a)\b/.test(t)) areas = ['it'];
  else if (/\b(mantenimiento|mtto|man)\b/.test(t)) areas = ['man'];
  else if (/\b(ama|hskp|limpieza|housekeeping)\b/.test(t)) areas = ['ama'];
  else if (/\b(seguridad|seg)\b/.test(t)) areas = ['seg'];
  else if (/\b(room\s*service|rs|alimentos)\b/.test(t)) areas = ['rs'];
  
  // Detectar estados
  let statuses = null;
  if (/\b(pendientes?|abiertos?)\b/.test(t)) statuses = ['open', 'in_progress'];
  else if (/\b(completad[ao]s?|cerrad[ao]s?|finalizad[ao]s?)\b/.test(t)) statuses = ['done'];
  else if (/\b(cancelad[ao]s?)\b/.test(t)) statuses = ['canceled'];
  
  // Detectar fechas
  let start_date = null;
  let end_date = null;
  
  if (/\bhoy\b/.test(t)) {
    start_date = getTodayDate();
    end_date = getTodayDate();
  } else if (/\bayer\b/.test(t)) {
    start_date = getYesterdayDate();
    end_date = getYesterdayDate();
  }
  
  return {
    is_report_request: true,
    confidence: 0.7,
    areas,
    statuses,
    start_date,
    end_date,
    rationale: 'fallback_pattern_match',
  };
}

// ──────────────────────────────────────────────────────────────
// API pública
// ──────────────────────────────────────────────────────────────

async function interpret(text, context = {}) {
  // Intentar con IA primero
  const aiResult = await interpretReportQuery({ text, context });
  
  if (aiResult) {
    return aiResult;
  }
  
  // Fallback si no hay IA
  if (DEBUG) console.log('[REPORT-AI] Using fallback interpreter');
  return interpretReportQueryFallback(text);
}

module.exports = {
  interpretReportQuery,
  interpretReportQueryFallback,
  interpret,
};
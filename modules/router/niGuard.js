// modules/router/niGuard.js
// Pequeño guard para filtrar saludos / smalltalk / “no es reporte”
// antes de disparar el flujo de Nueva Incidencia (N-I).

const DEBUG = (process.env.VICEBOT_DEBUG || '1') === '1';

// Normaliza texto (acentos, mayúsculas/minúsculas, espacios)
function norm(s = '') {
  return String(s)
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

// Listas básicas de saludos / frases de “no es incidencia”
const GREETING_PATTERNS = [
  'hola',
  'buen dia',
  'buenos dias',
  'buenas tardes',
  'buenas noches',
  'que tal',
  'que onda',
  'buen dia a todos',
  'buen dia equipo',
  // NEW: smalltalk social muy común
  'como estas',
  'como te va',
  'como andas',
  'qué tal',
  'qué onda'
];

const NON_INCIDENT_PATTERNS = [
  'solo te saludo',
  'solo los saludo',
  'solo saludando',
  'no es reporte',
  'no es incidencia',
  'no es una incidencia',
  'no estoy reportando',
  'no quiero reportar nada',
  'no hay problema',
];

// NEW: pistas muy simples de incidencia (segunda línea de defensa)
const INCIDENT_HINTS = [
  'no sirve',
  'no funciona',
  'no enciende',
  'no prende',
  'fuga',
  'gotea',
  'se descompuso',
  'se desconfiguro',
  'se desconfiguró',
  'tirando agua',
  'apagado',
  'fallando',
  'esta fallando',
  'está fallando'
];

function looksIncidentLike(tNorm = '') {
  if (!tNorm) return false;
  if (INCIDENT_HINTS.some(h => tNorm.includes(h))) return true;
  if (/no\s+(sirve|funciona|enciende|hay)\b/.test(tNorm)) return true;
  return false;
}

// Detecta si el texto es básicamente un saludo “puro”
function isPlainGreeting(tNorm) {
  if (!tNorm) return false;

  const words = tNorm.split(' ');
  // Muy corto y de solo 1–4 palabras tipo “hola”, “buen dia”, “como te va”, etc.
  if (words.length <= 4) {
    for (const pat of GREETING_PATTERNS) {
      if (
        tNorm === pat ||
        tNorm.startsWith(pat + ' ') ||
        tNorm.endsWith(' ' + pat)
      ) {
        return true;
      }
    }
  }

  // Emoji de saludo + texto muy cortito
  if (/[👋🤝]/.test(tNorm) && words.length <= 4) return true;

  return false;
}

// Detecta frases explícitas de “no es incidencia / reporte”
function hasExplicitNonIncident(tNorm) {
  if (!tNorm) return false;
  for (const pat of NON_INCIDENT_PATTERNS) {
    if (tNorm.includes(pat)) return true;
  }

  // Variantes simples
  if (tNorm.includes('solo te estoy saludando') ||
      tNorm.includes('te estoy saludando') ||
      tNorm.includes('nada mas saludando') ||
      tNorm.includes('nada más saludando')) {
    return true;
  }

  return false;
}

// Usa el analysis del interpretTurn para ver si él ya lo etiquetó como saludo/smalltalk
function looksLikeSmalltalkFromAI(aiAnalysis = '') {
  const a = norm(aiAnalysis);
  if (!a) return false;

  // Frases que ya hemos visto en tus logs + casos genéricos
  if (
    a.includes('solo esta saludando') ||
    a.includes('solo está saludando') ||
    a.includes('solo ha saludado') ||
    a.includes('esta saludando') ||
    a.includes('está saludando') ||
    a.includes('saludo') && a.includes('no hay accion requerida') ||
    a.includes('saludo') && a.includes('no hay acción requerida') ||
    a.includes('no hay cambios necesarios en el borrador') ||
    a.includes('no hay cambios ni informacion adicional para procesar') ||
    a.includes('no hay cambios ni información adicional para procesar') ||
    a.includes('no hay cambios ni informacion adicional') ||
    a.includes('no hay cambios ni información adicional') ||
    a.includes('pregunta general sobre la identidad del bot') ||
    a.includes('pregunta general sobre la identidad del bot') ||
    a.includes('pregunta por el nombre del bot') ||
    a.includes('pregunta por el nombre del bot') ||
    a.includes('pregunta por el nombre del bot, no hay cambios') ||
    a.includes('pregunta general') && a.includes('sin relacion con el flujo actual') ||
    a.includes('pregunta general') && a.includes('sin relación con el flujo actual') ||
    a.includes('smalltalk')
  ) {
    return true;
  }

  return false;
}

/**
 * Clasifica si debemos *bypassear* el flujo N-I.
 *
 * @param {string} text        - Texto crudo del usuario.
 * @param {Object} [opts]
 * @param {string} [opts.aiAnalysis] - Campo analysis devuelto por interpretTurn (opcional).
 *
 * @returns {{
 *   shouldBypassNI: boolean,
 *   reason: 'greeting' | 'explicit_non_incident' | 'ai_smalltalk' | null,
 *   isGreeting: boolean,
 *   aiSmalltalk: boolean
 * }}
 */
function classifyNiGuard(text, { aiAnalysis } = {}) {
  const tNorm = norm(text);
  const isGreetingFlag = isPlainGreeting(tNorm);
  const nonIncidentFlag = hasExplicitNonIncident(tNorm);
  const aiSmalltalkFlag = looksLikeSmalltalkFromAI(aiAnalysis);
  const incidentLikeFlag = looksIncidentLike(tNorm);

  let shouldBypassNI = false;
  let reason = null;

  if (nonIncidentFlag) {
    // El usuario dice explícitamente "no es reporte"
    shouldBypassNI = true;
    reason = 'explicit_non_incident';
  } else if (isGreetingFlag && !incidentLikeFlag) {
    // Saludo puro / social y sin pistas de falla → fuera de N-I
    shouldBypassNI = true;
    reason = 'greeting';
  } else if (aiSmalltalkFlag && !incidentLikeFlag) {
    // Tercer nivel: la IA ya dijo que es saludo / pregunta general sin cambios
    shouldBypassNI = true;
    reason = 'ai_smalltalk';
  }

  if (DEBUG) {
    console.log('[NI-GUARD] classify', {
      text,
      aiAnalysis,
      tNorm,
      isGreetingFlag,
      nonIncidentFlag,
      aiSmalltalkFlag,
      incidentLikeFlag,
      shouldBypassNI,
      reason,
    });
  }

  return {
    shouldBypassNI,
    reason,
    isGreeting: isGreetingFlag,
    aiSmalltalk: aiSmalltalkFlag,
  };
}

module.exports = {
  classifyNiGuard,
};

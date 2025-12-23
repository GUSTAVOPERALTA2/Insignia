// modules/ai/coreDialogRouter.js
// Core de ruteo para DMs: decide si un mensaje es
// - nueva incidencia
// - feedback del solicitante ligado a un ticket
// - saludo / ruido
//
// NO hace queries a DB. Solo usa:
//   - interpretTopLevel (intención global)
//   - classifyNI (si pinta a N-I)
//   - classifyFeedbackMessage (si hay ticket candidato)
//
// La idea es que index.js (o el router de DMs) haga algo como:
//
//   const decision = await decideDmRoute({ text: msg.body, context, candidateIncident });
//   switch (decision.route) {
//     case 'new_incident':     // -> routeIncomingNI
//     case 'requester_feedback': // -> routeRequesterReply
//     ...
//   }

const { interpretTopLevel } = require('./dialogInterpreter');
const { classifyNI } = require('./niClassifier');
const { classifyFeedbackMessage } = require('./coreFeedbackClassifier');

const DEBUG = (process.env.VICEBOT_DEBUG || '1') === '1';
const MIN_TOP_CONF = parseFloat(process.env.VICEBOT_CORE_TOP_CONF || '0.55');
const MIN_FB_CONF  = parseFloat(process.env.VICEBOT_CORE_FB_CONF  || '0.50');

/**
 * Normaliza texto simple (para comparar lugares, etc.)
 */
function norm(str = '') {
  return String(str || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Compara lugares de forma tolerante: misma habitación, alias, etc.
 * Por ahora sencillo: igualdad exacta o mismo número de 3-4 dígitos.
 */
function isSamePlace(a, b) {
  const na = norm(a);
  const nb = norm(b);
  if (!na || !nb) return false;
  if (na === nb) return true;

  const roomA = na.match(/\b\d{3,4}\b/);
  const roomB = nb.match(/\b\d{3,4}\b/);
  if (roomA && roomB && roomA[0] === roomB[0]) return true;

  return false;
}

/**
 * Decide si el mensaje suena a saludo/chit-chat muy corto.
 */
function looksLikeTinySmalltalk(top) {
  if (!top) return false;
  if (top.intent === 'SALUDO') return true;
  if (top.intent === 'OTRO' && top.hints && !top.hints.maybeNI) {
    // Podríamos ser más finos luego; de momento, si el modelo lo ve OTRO y
    // sin maybeNI, lo tratamos como ruido/charla.
    return true;
  }
  return false;
}

/**
 * Decide ruta para un DM.
 *
 * @param {Object} params
 * @param {string} params.text - Mensaje de WhatsApp
 * @param {Object} [params.context] - Contexto ligero (chatType, etc.)
 * @param {Object|null} [params.candidateIncident] - Ticket abierto candidato
 *        { id, folio, lugar, status, descripcion, interpretacion }
 * @param {Array} [params.history] - Historial relevante (opcional, por ahora no lo usamos mucho)
 */
async function decideDmRoute({ text, context = {}, candidateIncident = null, history = [] }) {
  const rawText = (text || '').trim();
  const t0 = Date.now();

  // 1) Top-level (ya tienes esto muy afinado)
  const top = await interpretTopLevel({ text: rawText, context });

  // 1.1) Si claramente es SALUDO/OTRO sin maybeNI y sin ticket candidato -> smalltalk/other
  if (!candidateIncident && looksLikeTinySmalltalk(top) && top.confidence >= MIN_TOP_CONF) {
    const out = {
      route: top.intent === 'SALUDO' ? 'smalltalk' : 'other',
      top,
      ni: null,
      fb: null,
      reason: 'top-level indica saludo/charla y no hay ticket candidato'
    };
    out._latency_ms = Date.now() - t0;
    if (DEBUG) console.log('[CORE-DM] decision', out);
    return out;
  }

  // 2) Si el top-level dice N-I (o maybeNI fuerte) → correr clasificador NI
  let ni = null;
  const looksLikeNI = top.intent === 'N-I' || (top.hints && top.hints.maybeNI);

  if (looksLikeNI) {
    ni = await classifyNI({ text: rawText, context });

    const niIsNI = ni && ni.intencion === 'N-I' && ni.confidence >= 0.5;

    // Caso simple: NO hay incident candidate → claramente nueva incidencia
    if (!candidateIncident && niIsNI) {
      const out = {
        route: 'new_incident',
        top,
        ni,
        fb: null,
        reason: 'mensaje clasificado como N-I y no hay ticket candidato'
      };
      out._latency_ms = Date.now() - t0;
      if (DEBUG) console.log('[CORE-DM] decision', out);
      return out;
    }

    // Hay candidateIncident → probamos si encaja como feedback o como N-I independiente
    if (candidateIncident && niIsNI) {
      const placeFromNi   = ni.lugar || top.hints?.placeText || null;
      const placeFromInc  = candidateIncident.lugar || null;
      const samePlace     = placeFromNi && placeFromInc && isSamePlace(placeFromNi, placeFromInc);

      // 2.1) Además corremos clasificador de feedback lado solicitante,
      //      usando el contexto del ticket candidato.
      const fb = await classifyFeedbackMessage({
        text: rawText,
        roleHint: 'requester',
        ticket: {
          folio: candidateIncident.folio || null,
          descripcion: candidateIncident.descripcion || candidateIncident.interpretacion || '',
          lugar: candidateIncident.lugar || '',
          status: candidateIncident.status || ''
        },
        history
      });

      // Heurística de decisión:
      // - Si fb.status_intent === 'reopen_request' → lo tratamos como feedback,
      //   aunque ni lo vea como N-I (es "sigue fallando").
      // - Si fb.kind === 'feedback' y fb.is_relevant y samePlace → feedback.
      // - Si place difiere FUERTE → nueva incidencia.
      const fbOk = fb && fb.is_relevant && fb.confidence >= MIN_FB_CONF;

      if (fbOk && (fb.status_intent === 'reopen_request' || (samePlace && fb.kind === 'feedback'))) {
        const out = {
          route: 'requester_feedback',
          top,
          ni,
          fb,
          reason: samePlace
            ? 'texto parece N-I pero clasificador lo ve como feedback del mismo lugar'
            : 'solicitante indica que el problema sigue; se trata como reopen/feedback'
        };
        out._latency_ms = Date.now() - t0;
        if (DEBUG) console.log('[CORE-DM] decision', out);
        return out;
      }

      // Si el lugar NO coincide o el feedback se ve débil/ruidoso → preferimos nueva incidencia
      if (!samePlace || !fbOk) {
        const out = {
          route: 'new_incident',
          top,
          ni,
          fb: fb || null,
          reason: !samePlace
            ? 'clasificado como N-I y lugar distinto al ticket candidato'
            : 'clasificado como N-I y feedback poco confiable; preferimos nueva incidencia'
        };
        out._latency_ms = Date.now() - t0;
        if (DEBUG) console.log('[CORE-DM] decision', out);
        return out;
      }
    }
  }

  // 3) Si no parece NI pero SÍ tenemos ticket candidato → probar puro feedback
  if (candidateIncident) {
    const fb = await classifyFeedbackMessage({
      text: rawText,
      roleHint: 'requester',
      ticket: {
        folio: candidateIncident.folio || null,
        descripcion: candidateIncident.descripcion || candidateIncident.interpretacion || '',
        lugar: candidateIncident.lugar || '',
        status: candidateIncident.status || ''
      },
      history
    });

    const fbOk = fb && fb.is_relevant && fb.confidence >= MIN_FB_CONF;

    if (fbOk && fb.kind !== 'noise') {
      const out = {
        route: 'requester_feedback',
        top,
        ni,
        fb,
        reason: 'no parece N-I pero hay ticket candidato y el clasificador lo ve como feedback'
      };
      out._latency_ms = Date.now() - t0;
      if (DEBUG) console.log('[CORE-DM] decision', out);
      return out;
    }
  }

  // 4) Fallback: si ni lo ve como N-I pero con baja confianza → lo tratamos como OTRO
  const out = {
    route: looksLikeTinySmalltalk(top) ? 'smalltalk' : 'other',
    top,
    ni,
    fb: null,
    reason: 'no hubo señal clara de N-I ni feedback relevante'
  };
  out._latency_ms = Date.now() - t0;
  if (DEBUG) console.log('[CORE-DM] decision', out);
  return out;
}

module.exports = {
  decideDmRoute,
  _isSamePlace: isSamePlace
};

// modules/router/niHandlers/modeChoosePlaceFromCandidates.js
// Handler dedicado para resolver selección de lugar cuando detectPlace devolvió candidates fuzzy.
// - Acepta número (1..N)
// - Acepta "cancelar/ninguno/no" para volver a pedir lugar
// - Si el usuario escribe texto (no número), lo tratamos como reintento: limpiamos candidates y volvemos a ask_place
// - Reusa handlePlaceCompleted (modo multi-ticket / single) desde modePlaceSelection.js si está disponible

const { norm, DEBUG, formatPreviewMessage: sharedFormatPreview } = require('./shared');

// Reusar helper de finalización de lugar (multi-ticket y flujo normal)
let handlePlaceCompleted = null;
try {
  ({ handlePlaceCompleted } = require('./modePlaceSelection'));
} catch (e) {
  handlePlaceCompleted = null;
}

function clearPlaceCandidateState(s) {
  s._placeCandidates = [];
  s._placeCandidateInput = null;
}

function getCandidates(s) {
  return Array.isArray(s?._placeCandidates) ? s._placeCandidates : [];
}

function resolveCandidateLabel(candidate) {
  if (!candidate) return '';
  return candidate.label || candidate.value || String(candidate);
}

function buildOptionsList(candidates, limit = 5) {
  const top = candidates.slice(0, limit);
  return top
    .map((c, i) => {
      const label = resolveCandidateLabel(c);
      const score = (c && (c.score ?? c.similarity)) ? ` _(${c.score ?? c.similarity}% similar)_` : '';
      return `${i + 1}. *${label}*${score}`;
    })
    .join('\n');
}

async function handleChoosePlaceFromCandidates(ctx) {
  const {
    s, msg, text, replySafe,
    setMode, setDraftField,
    autoAssignArea, refreshIncidentDescription,
    formatPreviewMessage,
  } = ctx;

  const tRaw = (text || '').trim();
  const t = norm(tRaw);

  const candidates = getCandidates(s);

  if (DEBUG) {
    console.log('[CHOOSE_PLACE_FROM_CANDIDATES] in', {
      tRaw,
      candidates: candidates.length,
      mode: s?.mode
    });
  }

  // Si no hay candidatos, volver a pedir lugar
  if (!candidates.length) {
    setMode(s, 'ask_place');
    await replySafe(msg, '⚠️ Ya no tengo opciones para elegir. Escribe el lugar otra vez, por favor.');
    return true;
  }

  // Cancelar / Ninguno
  if (/^(cancelar|ninguno|no)$/i.test(t)) {
    clearPlaceCandidateState(s);
    setMode(s, 'ask_place');
    await replySafe(
      msg,
      '📍 Ok. Escribe el lugar manualmente (ej: "hab 1205", "lobby", "elevador torre principal").'
    );
    return true;
  }

  // Selección por número (1..N)
  if (/^\d+$/.test(tRaw)) {
    const n = parseInt(tRaw, 10);
    if (n >= 1 && n <= candidates.length) {
      const chosen = candidates[n - 1];
      const chosenLabel = resolveCandidateLabel(chosen);

      setDraftField(s, 'lugar', chosenLabel);

      // limpiar estado temporal
      clearPlaceCandidateState(s);

      // completar lo demás si aplica
      if (typeof autoAssignArea === 'function') await autoAssignArea(s);

      if (typeof refreshIncidentDescription === 'function') {
        // respeta tu firma (s, text)
        await refreshIncidentDescription(s, s.draft?.descripcion);
      }

      // Si existe el helper (múltiples tickets), úsalo para respetar ese flujo
      if (typeof handlePlaceCompleted === 'function') {
        return await handlePlaceCompleted(ctx, chosenLabel);
      }

      // Fallback simple a confirm
      const previewFn = (typeof formatPreviewMessage === 'function')
        ? formatPreviewMessage
        : (typeof sharedFormatPreview === 'function' ? sharedFormatPreview : null);

      const preview = previewFn
        ? previewFn(s.draft)
        : `• Lugar: ${s.draft?.lugar || 'Sin dato'}`;

      await replySafe(msg, `✅ Lugar seleccionado: *${chosenLabel}*\n\n${preview}`);
      setMode(s, 'confirm');
      return true;
    }

    // Número fuera de rango: re-mostrar opciones (no reset)
    const list = buildOptionsList(candidates, 5);
    await replySafe(
      msg,
      `❓ Ese número no está en la lista.\n\n` +
      `Elige una opción:\n${list}\n\n` +
      `Responde el *número* o escribe *cancelar* para escribir el lugar manualmente.`
    );
    return true;
  }

  // Si escribió texto (no número): lo tratamos como reintento de lugar
  // (limpiamos candidates para que el siguiente paso pase por detectPlace en ask_place)
  clearPlaceCandidateState(s);
  setMode(s, 'ask_place');

  await replySafe(
    msg,
    'Ok—escribe el lugar otra vez con más detalle.\n' +
    'Ej: "cocina nido", "elevador torre principal lado A", "hab 1205".'
  );
  return true;
}

module.exports = {
  handleChoosePlaceFromCandidates,
};

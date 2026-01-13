/**
 * niHandlers/modePlaceSelection.js
 * Handlers para selección de lugar:
 * - ask_place: solicitar lugar al usuario
 * - choose_place_from_candidates: elegir entre candidatos fuzzy
 */

const {
  DEBUG,
  norm,
  formatPreviewMessage,
} = require('./shared');



/**
 * Detecta si el mensaje parece una corrección/edición en vez de un lugar
 * Ejemplos: "perdón es la impresora", "no, es el aire", "quise decir...", "me equivoqué"
 */
function looksLikeCorrection(text) {
  const t = norm(text);
  
  const correctionPatterns = [
    /^(perd[oó]n|disculpa|sorry|ups|oops)/i,
    /^(no,?\s+)?(es|era|ser[ií]a)\s+(el|la|una?|los|las)\s+/i,  // "es la impresora", "no, es el aire"
    /^(quise|quer[ií]a)\s+decir/i,
    /^me\s+equivoqu[eé]/i,
    /^(en\s+realidad|realmente|actually)/i,
    /^(cambia|cambiar|corregir|corrijo)\s+(la\s+)?(descripci[oó]n|desc)/i,
    /^(el|la)\s+problema\s+(es|era)/i,
  ];
  
  return correctionPatterns.some(rx => rx.test(t));
}

/**
 * Detecta si el mensaje parece describir un problema (no un lugar)
 * Ejemplos: "no funciona X", "está roto", "falla el Y", "no hay luz"
 */
function looksLikeProblemDescription(text) {
  const t = norm(text);
  
  const problemPatterns = [
    /\b(no\s+)?(funciona|sirve|enciende|prende|jala|trabaja)\b/i,
    /\b(est[aá]|esta)\s+(roto|rota|da[ñn]ado|da[ñn]ada|descompuest[oa]|fallando)\b/i,
    /\b(falla|fall[oó]|se\s+(cay[oó]|rompi[oó]|descompuso))\b/i,
    /\b(necesita|requiere|ocupa)\s+(reparaci[oó]n|arreglo|revisi[oó]n|cambio)\b/i,
    /\b(hay|tiene|present[ao])\s+(una?\s+)?(fuga|goteo|problema|falla)\b/i,
    /\bes\s+(el|la|una?)\s+(impresora|tv|television|aire|clima|wifi|internet|luz|foco|puerta|regadera|lavabo|wc|inodoro|minisplit)\b/i,
    // "no hay X" - falta de servicio/recurso
    /\bno\s+hay\s+(luz|agua|se[ñn]al|internet|wifi|gas|electricidad|corriente|presion|caliente)\b/i,
    /\b(sin|falta)\s+(luz|agua|se[ñn]al|internet|wifi|gas|electricidad|corriente|presion)\b/i,
    // Solicitudes de ayuda/acción
    /\b(me\s+)?ayuda[ns]?\s+(a|con)\b/i,
    /\bayuda\b.*\b(no\s+hay|no\s+funciona|falla|roto)\b/i,  // "ayuda no hay luz"
    /\b(pueden|podrian|podría[ns]?)\s+(revisar|arreglar|cambiar|traer|quitar|poner)\b/i,
    /\b(necesito|ocupo|requiero)\s+(que|ayuda)\b/i,
    /\b(revisar|arreglar|cambiar|reparar|limpiar)\s+(el|la|los|las|una?)?\s*\w+/i,
    /\b(quitar|poner|instalar|desinstalar)\s+(el|la|los|las)?\s*\w+/i,
    /\b(traer|llevar|cambiar)\s+(una?|el|la|los|las)?\s*(toalla|sabana|almohada|control|amenidad)/i,
  ];
  
  return problemPatterns.some(rx => rx.test(t));
}

/**
 * Detecta si el texto contiene un lugar (número de hab o lugar nombrado)
 */
function hasPlaceInText(text) {
  const t = norm(text);
  
  // Número de habitación (3-4 dígitos)
  if (/\b\d{3,4}\b/.test(text)) return true;
  
  // Patrones de lugar con preposición
  // "en el/la/los X", "en X"
  const placePrepositionPatterns = [
    /\ben\s+(el\s+)?sal[oó]n\s+\w+/i,
    /\ben\s+(la\s+)?(cocina|alberca|piscina|gym|gimnasio|lobby|recepci[oó]n|terraza|playa|jard[ií]n)/i,
    /\ben\s+(el\s+)?(restaurante|bar|estacionamiento|parking|elevador|pasillo|ba[nñ]o)/i,
    /\ben\s+(la\s+)?habitaci[oó]n/i,
    /\ben\s+\w+flores\b/i,  // Nombres como "Miraflores"
    /\ben\s+(el\s+)?(nido|roof|rooftop|spa|business)/i,
  ];
  
  if (placePrepositionPatterns.some(rx => rx.test(t))) return true;
  
  // Lugares conocidos al final del texto
  const knownPlacesAtEnd = [
    /\b(lobby|recepci[oó]n|alberca|pool|gym|gimnasio|spa|terraza|playa|jard[ií]n|cocina|restaurante|bar|nido|roof)\s*$/i,
    /\bsal[oó]n\s+\w+\s*$/i,
    /\bmiraflores\s*$/i,
  ];
  
  if (knownPlacesAtEnd.some(rx => rx.test(t))) return true;
  
  return false;
}

/**
 * Extrae el lugar de un texto si lo tiene
 */
function extractPlaceFromText(text) {
  // Número de habitación
  const roomMatch = text.match(/\b(\d{3,4})\b/);
  if (roomMatch) return `Habitación ${roomMatch[1]}`;
  
  // Salón + nombre
  const salonMatch = text.match(/sal[oó]n\s+(\w+)/i);
  if (salonMatch) return `Salón ${salonMatch[1]}`;
  
  // "en el/la X" al final
  const enMatch = text.match(/en\s+(?:el\s+|la\s+)?(\w+(?:\s+\w+)?)\s*$/i);
  if (enMatch) return enMatch[1];
  
  // Lugares conocidos
  const knownMatch = text.match(/\b(lobby|recepci[oó]n|alberca|pool|gym|gimnasio|spa|terraza|playa|jard[ií]n|cocina|restaurante|bar|nido|roof|miraflores)\b/i);
  if (knownMatch) return knownMatch[1];
  
  return null;
}

/**
 * Detecta si el mensaje parece un nuevo incidente completo (descripción + lugar)
 * mientras estamos en modo ask_place
 */
function looksLikeNewIncidentWithPlace(text, currentDraft) {
  const t = norm(text);
  
  // Debe tener algún tipo de lugar (número o nombre)
  const hasPlace = hasPlaceInText(text);
  if (!hasPlace) return false;
  
  // Debe tener suficiente texto para ser una descripción (>10 chars)
  const textLength = text.trim().length;
  if (textLength < 15) return false;
  
  // Verificar que el tema sea diferente al draft actual
  if (currentDraft?.descripcion) {
    const currentKeywords = extractKeywords(currentDraft.descripcion);
    const newKeywords = extractKeywords(text);
    
    // Si no comparten keywords significativos, es probable que sea nuevo
    const overlap = currentKeywords.filter(k => newKeywords.includes(k));
    
    if (DEBUG) console.log('[DETECT] keyword analysis', {
      currentKeywords, newKeywords, overlap
    });
    
    if (overlap.length === 0 && newKeywords.length >= 2) {
      return true;
    }
  }
  
  // Patrones que indican un problema nuevo (no una respuesta de lugar)
  const problemIndicators = [
    /\b(no\s+)?(hay|funciona|sirve|enciende|jala|prende)\b/i,
    /\b(falla|fuga|goteo|roto|rota|da[ñn]ado)\b/i,
    /\b(ayuda[rn]?|revisar|arreglar|cambiar|traer|quitar|poner|limpiar|reparar)\b/i,
    /\b(necesito|ocupo|requiero|urge)\b/i,
    /\b(est[aá])\s+(roto|rota|descompuest|fallando|goteando)\b/i,
  ];
  
  const hasProblemIndicator = problemIndicators.some(rx => rx.test(t));
  
  // Si tiene indicador de problema Y el tema es diferente → es nuevo
  if (hasProblemIndicator) {
    // Verificar que no sea sobre el mismo tema
    if (currentDraft?.descripcion) {
      const currentKeywords = extractKeywords(currentDraft.descripcion);
      const newKeywords = extractKeywords(text);
      const overlap = currentKeywords.filter(k => newKeywords.includes(k));
      
      // Si tienen overlap significativo, podría ser una corrección
      if (overlap.length >= 2) return false;
    }
    return true;
  }
  
  return false;
}

/**
 * Extrae palabras clave significativas de un texto
 */
function extractKeywords(text) {
  if (!text) return [];
  const t = norm(text);
  
  // Palabras a ignorar
  const stopWords = new Set([
    'el', 'la', 'los', 'las', 'un', 'una', 'unos', 'unas',
    'de', 'del', 'en', 'a', 'al', 'por', 'para', 'con', 'sin',
    'que', 'se', 'no', 'si', 'es', 'esta', 'estan', 'hay',
    'me', 'te', 'le', 'nos', 'les', 'lo', 'mi', 'tu', 'su',
    'muy', 'mas', 'pero', 'como', 'ya', 'solo', 'tambien',
    'hab', 'habitacion', 'room', 'cuarto'
  ]);
  
  return t
    .split(/\s+/)
    .filter(w => w.length > 3 && !stopWords.has(w) && !/^\d+$/.test(w));
}

/**
 * Detecta si el texto tiene estructura de lugar válido
 */
function looksLikeValidPlace(text) {
  const t = norm(text);
  
  // Número de habitación (3-4 dígitos)
  if (/^\d{3,4}$/.test(t)) return true;
  if (/^(hab|habitacion|room|villa|cuarto)\s*#?\d{3,4}$/i.test(t)) return true;
  
  // Lugares conocidos del hotel
  const knownPlaces = [
    'lobby', 'front', 'front desk', 'recepcion', 'reception',
    'alberca', 'pool', 'piscina',
    'gym', 'gimnasio',
    'spa', 'salon', 'business center',
    'restaurante', 'restaurant', 'bar', 'cocina',
    'estacionamiento', 'parking', 'valet',
    'pasillo', 'elevador', 'escalera', 'azotea', 'roof',
    'jardin', 'terraza', 'palapa',
    'bodega', 'almacen', 'lavanderia', 'laundry',
    'oficina', 'administracion', 'rh', 'contabilidad',
    'playa', 'beach', 'muelle', 'pier'
  ];
  
  // Si contiene algún lugar conocido
  if (knownPlaces.some(place => t.includes(place))) return true;
  
  // Patrones de ubicación
  if (/^(en\s+)?(el|la|los|las)\s+\w+$/i.test(t) && t.length < 25) {
    // "en el lobby", "la alberca" - pero solo si es corto
    return true;
  }
  
  // Pisos/niveles
  if (/\b(piso|nivel|planta|floor)\s*\d+/i.test(t)) return true;
  if (/\b(pb|planta\s*baja|ground\s*floor)\b/i.test(t)) return true;
  
  return false;
}

/**
 * Extrae la corrección de descripción del mensaje
 * "perdón es la impresora" → "la impresora"
 * "no, es el aire" → "el aire"
 */
function extractCorrectedDescription(text) {
  const t = text.trim();
  
  // Patrones para extraer la parte relevante
  const extractPatterns = [
    /^(?:perd[oó]n|disculpa|sorry|ups|oops)[,.]?\s*(?:es|era)?\s*(.+)$/i,
    /^(?:no,?\s+)?(?:es|era|ser[ií]a)\s+(.+)$/i,
    /^(?:quise|quer[ií]a)\s+decir\s+(.+)$/i,
    /^(?:me\s+equivoqu[eé])[,.]?\s*(?:es|era)?\s*(.+)$/i,
    /^(?:en\s+realidad|realmente)[,.]?\s*(?:es|era)?\s*(.+)$/i,
  ];
  
  for (const rx of extractPatterns) {
    const m = t.match(rx);
    if (m && m[1]) {
      return m[1].trim();
    }
  }
  
  return t;
}

/**
 * Handler para modo ask_place
 */
async function handleAskPlace(ctx) {
  const {
    s, msg, text, replySafe, setMode, setDraftField,
    normalizeAndSetLugar, autoAssignArea, detectPlace,
    refreshIncidentDescription, detectArea, addArea,
    findStrongPlaceSignals, areaLabel
  } = ctx;

  if (DEBUG) console.log('[ASK_PLACE] handling', { response: text });

  const t = norm(text);

  // Cancelar
  if (/^cancelar?$/i.test(t)) {
    setMode(s, 'confirm');
    const preview = formatPreviewMessage(s.draft);
    await replySafe(msg, '↩️ Cancelado.\n\n' + preview);
    return true;
  }

  // ═══════════════════════════════════════════════════════════════
  // ANÁLISIS DEL MENSAJE
  // ═══════════════════════════════════════════════════════════════
  
  const isCorrection = looksLikeCorrection(text);
  const isProblemDesc = looksLikeProblemDescription(text);
  const isValidPlace = looksLikeValidPlace(text);
  
  // Pre-check: si tiene indicadores de problema, verificar si también tiene lugar
  let isNewIncidentWithPlace = looksLikeNewIncidentWithPlace(text, s.draft);
  
  // Si no se detectó como nuevo incidente pero PARECE un problema diferente,
  // verificar si detectPlace encuentra un lugar
  if (!isNewIncidentWithPlace && isProblemDesc && text.length > 15) {
    // Verificar si el tema es diferente al draft actual
    const currentKeywords = extractKeywords(s.draft?.descripcion || '');
    const newKeywords = extractKeywords(text);
    const overlap = currentKeywords.filter(k => newKeywords.includes(k));
    
    // Si no hay overlap (temas diferentes) Y tiene al menos 1 keyword
    // O si tiene indicadores claros de problema nuevo
    const hasClearProblemIndicator = /\bno\s+hay\b|\bfalla\b|\broto\b|\bfuga\b/i.test(text);
    
    if ((overlap.length === 0 && newKeywords.length >= 1) || (overlap.length === 0 && hasClearProblemIndicator)) {
      // Es un tema diferente, verificar si tiene lugar con detectPlace
      try {
        const placeCheck = await detectPlace(text, { preferRoomsFirst: true });
        if (placeCheck?.found || placeCheck?.canonical_label) {
          isNewIncidentWithPlace = true;
          if (DEBUG) console.log('[ASK_PLACE] detected new incident via detectPlace', {
            place: placeCheck.canonical_label || placeCheck.label,
            reason: hasClearProblemIndicator ? 'clear_problem_indicator' : 'different_keywords'
          });
        }
      } catch (e) {
        if (DEBUG) console.warn('[ASK_PLACE] detectPlace pre-check error', e?.message);
      }
    }
  }
  
  if (DEBUG) console.log('[ASK_PLACE] analysis', { 
    isCorrection, isProblemDesc, isValidPlace, isNewIncidentWithPlace, text 
  });

  // ═══════════════════════════════════════════════════════════════
  // CASO 1: Nuevo incidente completo (diferente al actual)
  // "Me ayudan a quitar los vidrios para revisar la tv en 4405"
  // ═══════════════════════════════════════════════════════════════
  
  if (isNewIncidentWithPlace) {
    if (DEBUG) console.log('[ASK_PLACE] detected new incident with place');
    
    // Extraer lugar del nuevo mensaje (ahora soporta lugares nombrados)
    const placeSignal = findStrongPlaceSignals ? findStrongPlaceSignals(text) : null;
    let newPlace = placeSignal?.value || extractPlaceFromText(text);
    
    // Si no encontró lugar con extractPlaceFromText, intentar con detectPlace
    if (!newPlace) {
      try {
        const placeResult = await detectPlace(text, { preferRoomsFirst: true });
        if (placeResult?.found || placeResult?.canonical_label) {
          newPlace = placeResult.canonical_label || placeResult.label || placeResult.found;
        }
      } catch (e) {
        if (DEBUG) console.warn('[ASK_PLACE] detectPlace for new incident error', e?.message);
      }
    }
    
    // Detectar área del nuevo mensaje
    let newArea = null;
    try {
      const areaResult = await detectArea(text);
      newArea = areaResult?.area;
    } catch (e) {
      if (DEBUG) console.warn('[ASK_PLACE] detectArea error', e?.message);
    }
    
    // Guardar el ticket actual (incompleto) y el nuevo
    const currentTicket = {
      descripcion: s.draft.descripcion,
      descripcion_original: s.draft.descripcion_original || s.draft.descripcion,
      lugar: null, // No tiene lugar aún
      area_destino: s.draft.area_destino,
      areas: s.draft.areas || (s.draft.area_destino ? [s.draft.area_destino] : []),
      _ticketNum: 1,
      _needsPlace: true, // Marcar que necesita lugar
      // Asociar adjuntos pendientes a este ticket (el que vino con la imagen)
      _pendingMedia: s._pendingMedia || [],
    };
    
    // Limpiar _pendingMedia de la sesión ya que ahora están en el ticket
    s._pendingMedia = [];
    
    const newTicket = {
      descripcion: text.replace(/\b\d{3,4}\b/g, '').trim(), // Quitar número de hab
      descripcion_original: text,
      lugar: newPlace,
      area_destino: newArea || s.draft.area_destino,
      areas: newArea ? [newArea] : (s.draft.area_destino ? [s.draft.area_destino] : []),
      _ticketNum: 2,
      // El nuevo ticket NO tiene adjuntos (vino solo como texto)
      _pendingMedia: [],
    };
    
    // Limpiar descripción del nuevo ticket
    if (refreshIncidentDescription) {
      try {
        const cleaned = await ctx.deriveIncidentText?.({ text: newTicket.descripcion });
        if (cleaned?.incident) {
          newTicket.descripcion = cleaned.incident;
        }
      } catch (e) {
        if (DEBUG) console.warn('[ASK_PLACE] clean description error', e?.message);
      }
    }
    
    // Guardar en sesión para decisión
    s._conflictCurrentTicket = currentTicket;
    s._conflictNewTicket = newTicket;
    
    // Mostrar menú de decisión
    const currentDesc = (currentTicket.descripcion || '').substring(0, 50);
    const newDesc = (newTicket.descripcion || '').substring(0, 50);
    const currentAreaLabel = typeof areaLabel === 'function' ? areaLabel(currentTicket.area_destino) : currentTicket.area_destino;
    const newAreaLabel = typeof areaLabel === 'function' ? areaLabel(newTicket.area_destino) : newTicket.area_destino;
    
    await replySafe(msg,
      '🤔 *Detecté un problema diferente.*\n\n' +
      `📋 *Ticket actual (sin lugar):*\n` +
      `   _"${currentDesc}..."_\n` +
      `   📍 ❓ Falta lugar | 🏷️ ${currentAreaLabel}\n\n` +
      `🆕 *Nuevo problema:*\n` +
      `   _"${newDesc}..."_\n` +
      `   📍 ${newPlace || '—'} | 🏷️ ${newAreaLabel}\n\n` +
      '¿Qué quieres hacer?\n' +
      '• *1* — Crear *ambos* tickets (te pediré el lugar del primero)\n' +
      '• *2* — *Reemplazar* el actual por el nuevo\n' +
      '• *3* — *Descartar* el nuevo y seguir con el actual\n' +
      '• *cancelar* — Descartar todo'
    );
    
    setMode(s, 'ask_place_conflict');
    return true;
  }

  // ═══════════════════════════════════════════════════════════════
  // CASO 2: Corrección de descripción (no es un lugar)
  // ═══════════════════════════════════════════════════════════════
  
  if ((isCorrection || isProblemDesc) && !isValidPlace) {
    const newDescription = extractCorrectedDescription(text);
    
    if (DEBUG) console.log('[ASK_PLACE] detected correction', { newDescription });
    
    s.draft.descripcion = newDescription;
    s.draft.descripcion_original = newDescription;
    
    if (detectArea) {
      try {
        const areaResult = await detectArea(newDescription);
        if (areaResult?.area) {
          setDraftField(s, 'area_destino', areaResult.area);
          if (addArea) addArea(s, areaResult.area);
        }
      } catch (e) {
        if (DEBUG) console.warn('[ASK_PLACE] detectArea error', e?.message);
      }
    }
    
    if (refreshIncidentDescription) {
      await refreshIncidentDescription(s, newDescription);
    }
    
    const preview = formatPreviewMessage(s.draft);
    await replySafe(msg,
      '✅ Descripción actualizada.\n\n' +
      preview + '\n\n' +
      '📍 Ahora indícame el *lugar* (ej: "hab 1205", "lobby", "front desk").'
    );
    
    return true;
  }

  // ═══════════════════════════════════════════════════════════════
  // CASO 3: Flujo normal - intentar detectar lugar
  // ═══════════════════════════════════════════════════════════════

  let placeResult = null;
  try {
    placeResult = await detectPlace(text, { preferRoomsFirst: true });
    if (DEBUG) console.log('[ASK_PLACE] detectPlace result', { 
      found: placeResult?.found,
      canonical: placeResult?.canonical_label,
      suggestions: placeResult?.suggestions?.length || 0
    });
  } catch (e) {
    if (DEBUG) console.warn('[ASK_PLACE] detectPlace error', e?.message);
  }

  // Si encontró lugar válido en catálogo
  if (placeResult?.found || placeResult?.canonical_label) {
    const lugar = placeResult.canonical_label || placeResult.label || placeResult.found;
    setDraftField(s, 'lugar', lugar);
    
    if (!s.draft.area_destino && autoAssignArea) {
      await autoAssignArea(s);
    }

    // ═══════════════════════════════════════════════════════════════
    // VERIFICAR SI ESTAMOS COMPLETANDO MÚLTIPLES TICKETS
    // ═══════════════════════════════════════════════════════════════
    return await handlePlaceCompleted(ctx, lugar);
  }

  // Si hay sugerencias fuzzy
  if (placeResult?.suggestions && placeResult.suggestions.length > 0) {
    const suggestions = placeResult.suggestions.slice(0, 3);
    const suggestionList = suggestions.map((sug, i) =>
      `${i + 1}. *${sug.label}* _(${sug.similarity}% similar)_`
    ).join('\n');

    await replySafe(msg,
      `🤔 No encontré exactamente "*${text}*".\n\n` +
      `¿Quisiste decir?\n${suggestionList}\n\n` +
      `Responde el *número* (1, 2, 3) o escribe otro lugar.`
    );

    s._placeCandidates = suggestions.map(sug => ({
      label: sug.label,
      via: 'fuzzy',
      score: sug.similarity
    }));
    setMode(s, 'choose_place_from_candidates');
    return true;
  }

  // ═══════════════════════════════════════════════════════════════
  // CASO 4: No encontró en catálogo - verificar si parece lugar
  // ═══════════════════════════════════════════════════════════════
  
  if (isValidPlace) {
    const result = await normalizeAndSetLugar(s, msg, text, { rawText: text, strictMode: true });
    
    if (result?.success && s.draft.lugar) {
      if (!s.draft.area_destino && autoAssignArea) {
        await autoAssignArea(s);
      }

      return await handlePlaceCompleted(ctx, s.draft.lugar);
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // CASO 5: No parece lugar - mostrar ayuda
  // ═══════════════════════════════════════════════════════════════
  
  await replySafe(msg,
    '❓ No reconocí eso como un lugar.\n\n' +
    'Por favor indica *dónde* está el problema:\n' +
    '• Habitación: "hab 1205" o solo "1205"\n' +
    '• Área común: "lobby", "alberca", "gym"\n' +
    '• Otro: "restaurante", "estacionamiento"\n\n' +
    '_Si quieres corregir la descripción, escribe "editar" o "cambiar descripción"._'
  );
  return true;
}

/**
 * Helper: Maneja cuando se completa un lugar
 * Si hay múltiples tickets pendientes, actualiza el array y muestra menú
 * También verifica si falta área destino
 */
async function handlePlaceCompleted(ctx, lugar) {
  const { s, msg, replySafe, setMode, areaLabel, autoAssignArea } = ctx;
  
  // Verificar si estamos completando uno de múltiples tickets
  if (s._completingMultipleTicket !== undefined && Array.isArray(s._multipleTickets)) {
    const idx = s._completingMultipleTicket;
    
    if (DEBUG) console.log('[ASK_PLACE] completing multiple ticket', { idx, lugar });
    
    // Actualizar el ticket en el array
    if (s._multipleTickets[idx]) {
      s._multipleTickets[idx].lugar = lugar;
      s._multipleTickets[idx]._needsPlace = false;
      
      // ═══════════════════════════════════════════════════════════════
      // VERIFICAR SI FALTA ÁREA DESTINO
      // ═══════════════════════════════════════════════════════════════
      if (!s._multipleTickets[idx].area_destino) {
        // Marcar que necesita área
        s._multipleTickets[idx]._needsArea = true;
        s._completingMultipleTicketArea = idx;
        
        // Limpiar flag de lugar
        s._completingMultipleTicket = undefined;
        
        const ticket = s._multipleTickets[idx];
        const desc = (ticket.descripcion || '').substring(0, 50);
        
        await replySafe(msg,
          `✅ Lugar registrado: *${lugar}*\n\n` +
          `📋 Ticket ${idx + 1}: _"${desc}..."_\n\n` +
          `🏷️ Falta el *área destino*. ¿A qué área va?\n\n` +
          '• *MAN* — Mantenimiento\n' +
          '• *AMA* — Ama de llaves\n' +
          '• *RS* — Room Service\n' +
          '• *IT* — Sistemas\n' +
          '• *SEG* — Seguridad'
        );
        
        setMode(s, 'ask_area_multiple');
        return true;
      }
    }
    
    // Limpiar flag
    s._completingMultipleTicket = undefined;
    
    // Verificar si hay tickets sin datos completos
    const ticketsNeedingData = s._multipleTickets.filter(t => 
      !t.lugar || !t.area_destino
    );
    
    if (ticketsNeedingData.length > 0) {
      // Hay tickets incompletos, buscar el primero que necesite algo
      const incompleteIdx = s._multipleTickets.findIndex(t => !t.lugar || !t.area_destino);
      const incompleteTicket = s._multipleTickets[incompleteIdx];
      
      if (!incompleteTicket.lugar) {
        s._completingMultipleTicket = incompleteIdx;
        s.draft = { ...incompleteTicket };
        
        await replySafe(msg,
          `✅ Ticket ${idx + 1} actualizado.\n\n` +
          `📍 Ahora necesito el *lugar* del ticket ${incompleteIdx + 1}:\n` +
          `   _"${(incompleteTicket.descripcion || '').substring(0, 50)}..."_`
        );
        
        setMode(s, 'ask_place');
        return true;
      }
      
      if (!incompleteTicket.area_destino) {
        s._completingMultipleTicketArea = incompleteIdx;
        
        await replySafe(msg,
          `✅ Ticket ${idx + 1} actualizado.\n\n` +
          `🏷️ Falta el *área* del ticket ${incompleteIdx + 1}:\n` +
          `   _"${(incompleteTicket.descripcion || '').substring(0, 50)}..."_\n\n` +
          '• *MAN* — Mantenimiento\n' +
          '• *AMA* — Ama de llaves\n' +
          '• *RS* — Room Service\n' +
          '• *IT* — Sistemas\n' +
          '• *SEG* — Seguridad'
        );
        
        setMode(s, 'ask_area_multiple');
        return true;
      }
    }
    
    // Todos los tickets están completos, mostrar resumen
    return await showMultipleTicketsSummary(ctx, `✅ Lugar registrado para ticket ${idx + 1}.`);
  }
  
  // ═══════════════════════════════════════════════════════════════
  // Flujo normal: ticket único
  // ═══════════════════════════════════════════════════════════════
  
  // Verificar si falta área destino
  if (!s.draft.area_destino) {
    // Intentar auto-asignar primero
    if (autoAssignArea) {
      await autoAssignArea(s);
    }
    
    // Si sigue sin área, preguntar
    if (!s.draft.area_destino) {
      const preview = formatPreviewMessage(s.draft);
      await replySafe(msg,
        '✅ Lugar registrado.\n\n' +
        preview + '\n\n' +
        '🏷️ Falta el *área destino*. ¿A cuál va?\n\n' +
        '• *MAN* — Mantenimiento\n' +
        '• *AMA* — Ama de llaves\n' +
        '• *RS* — Room Service\n' +
        '• *IT* — Sistemas\n' +
        '• *SEG* — Seguridad'
      );
      
      setMode(s, 'choose_area_single');
      return true;
    }
  }
  
  // Todo completo, ir a confirmación
  setMode(s, 'confirm');
  const preview = formatPreviewMessage(s.draft);
  await replySafe(msg, 
    '✅ Lugar registrado:\n\n' + 
    preview + '\n\n' +
    '_Responde *sí* para enviar o *editar* para modificar._'
  );
  return true;
}

/**
 * Helper: Muestra resumen de múltiples tickets
 */
async function showMultipleTicketsSummary(ctx, headerMsg = '') {
  const { s, msg, replySafe, setMode, areaLabel } = ctx;
  
  let summary = headerMsg ? headerMsg + '\n\n' : '';
  summary += `📋 *${s._multipleTickets.length} tickets listos:*\n\n`;
  
  let allComplete = true;
  
  s._multipleTickets.forEach((ticket, i) => {
    const desc = (ticket.descripcion || '').substring(0, 50);
    const suffix = (ticket.descripcion || '').length > 50 ? '...' : '';
    const areaLbl = typeof areaLabel === 'function' ? areaLabel(ticket.area_destino) : (ticket.area_destino || '❓');
    const lugarLbl = ticket.lugar || '❓ Falta';
    const hasMedia = ticket._pendingMedia && ticket._pendingMedia.length > 0;
    
    if (!ticket.lugar || !ticket.area_destino) {
      allComplete = false;
    }
    
    summary += `*${i + 1}.* ${desc}${suffix}\n`;
    summary += `   📍 ${lugarLbl} | 🏷️ ${areaLbl}`;
    if (hasMedia) {
      summary += ` | 📎 ${ticket._pendingMedia.length}`;
    }
    summary += '\n\n';
  });
  
  summary += '¿Qué deseas hacer?\n';
  if (allComplete) {
    summary += '• *enviar* — Enviar todos los tickets\n';
  } else {
    summary += '• ⚠️ _Hay tickets incompletos, completa los datos antes de enviar_\n';
  }
  summary += '• *editar N* — Editar ticket N\n';
  summary += '• *eliminar N* — Eliminar ticket N\n';
  summary += '• *cancelar* — Descartar todos';
  
  await replySafe(msg, summary);
  setMode(s, 'multiple_tickets');
  return true;
}

/**
 * Handler para modo ask_place_conflict
 * Cuando se detecta un nuevo incidente mientras estamos pidiendo lugar
 */
async function handleAskPlaceConflict(ctx) {
  const {
    s, msg, text, replySafe, setMode, setDraftField,
    resetSession, detectPlace, refreshIncidentDescription, areaLabel
  } = ctx;

  const t = norm(text);

  if (DEBUG) console.log('[ASK_PLACE_CONFLICT] handling', { response: text });

  const currentTicket = s._conflictCurrentTicket;
  const newTicket = s._conflictNewTicket;

  if (!currentTicket || !newTicket) {
    // Estado inválido, volver a ask_place
    setMode(s, 'ask_place');
    await replySafe(msg, '⚠️ Error interno. Por favor indica el lugar del problema.');
    return true;
  }

  // Opción 1: Crear ambos tickets
  if (/^1\b/.test(t) || /^ambos\b/i.test(t) || /^los\s*dos\b/i.test(t)) {
    // Guardar ambos tickets para envío múltiple
    s._multipleTickets = [currentTicket, newTicket];
    
    // Limpiar estado de conflicto
    s._conflictCurrentTicket = null;
    s._conflictNewTicket = null;
    
    // El primer ticket necesita lugar, así que lo ponemos en el draft
    s.draft = { ...currentTicket };
    
    await replySafe(msg,
      '✅ Se crearán *2 tickets*.\n\n' +
      '📍 Primero necesito el *lugar* del ticket 1:\n' +
      `   _"${(currentTicket.descripcion || '').substring(0, 50)}..."_\n\n` +
      'Escribe el lugar (ej: "hab 1205", "lobby"):'
    );
    
    // Guardar flag para saber que estamos completando ticket 1 de múltiples
    s._completingMultipleTicket = 0;
    setMode(s, 'ask_place');
    return true;
  }

  // Opción 2: Reemplazar por el nuevo
  if (/^2\b/.test(t) || /^reemplaz[ao]r?\b/i.test(t) || /^nuevo\b/i.test(t)) {
    // Usar el nuevo ticket como draft
    s.draft = {
      descripcion: newTicket.descripcion,
      descripcion_original: newTicket.descripcion_original,
      lugar: newTicket.lugar,
      area_destino: newTicket.area_destino,
      areas: newTicket.areas,
    };
    
    // Limpiar estado de conflicto
    s._conflictCurrentTicket = null;
    s._conflictNewTicket = null;
    
    const preview = formatPreviewMessage(s.draft);
    await replySafe(msg, '✅ Ticket reemplazado:\n\n' + preview);
    setMode(s, 'confirm');
    return true;
  }

  // Opción 3: Descartar el nuevo
  if (/^3\b/.test(t) || /^descartar?\b/i.test(t) || /^actual\b/i.test(t) || /^continuar?\b/i.test(t)) {
    // Mantener el ticket actual
    s.draft = {
      descripcion: currentTicket.descripcion,
      descripcion_original: currentTicket.descripcion_original,
      lugar: currentTicket.lugar,
      area_destino: currentTicket.area_destino,
      areas: currentTicket.areas,
    };
    
    // Limpiar estado de conflicto
    s._conflictCurrentTicket = null;
    s._conflictNewTicket = null;
    
    const preview = formatPreviewMessage(s.draft);
    await replySafe(msg,
      '✅ Nuevo mensaje descartado. Continuamos con:\n\n' +
      preview + '\n\n' +
      '📍 Indícame el *lugar* del problema:'
    );
    setMode(s, 'ask_place');
    return true;
  }

  // Cancelar todo
  if (/^cancelar?\b/i.test(t) || /^no\b/i.test(t)) {
    s._conflictCurrentTicket = null;
    s._conflictNewTicket = null;
    resetSession(s.chatId);
    await replySafe(msg, '❌ Tickets cancelados. Si necesitas reportar algo, cuéntame.');
    return true;
  }

  // No entendí - mostrar opciones de nuevo
  const currentAreaLabel = typeof areaLabel === 'function' ? areaLabel(currentTicket.area_destino) : currentTicket.area_destino;
  const newAreaLabel = typeof areaLabel === 'function' ? areaLabel(newTicket.area_destino) : newTicket.area_destino;
  
  await replySafe(msg,
    '🤔 No entendí. Responde con:\n\n' +
    '• *1* — Crear ambos tickets\n' +
    '• *2* — Reemplazar por el nuevo\n' +
    '• *3* — Descartar el nuevo\n' +
    '• *cancelar* — Descartar todo'
  );
  return true;
}

/**
 * Extrae códigos de área de un texto (igual que dialogInterpreter)
 */
function extractAreasFromText(text) {
  const t = norm(text);
  const out = [];
  const tests = [
    /\bit\b|\bsistemas?\b|\binformatic/i,
    /\bman\b|\bmantenimiento\b|\bmant\b|\bmanto\b|\bmaintenance\b/i,
    /\bhskp\b|\bama\b|\bhousek(?:ee)?ping\b|\bama de llaves\b/i,
    /\broom ?service\b|\brs\b|\bird\b|\balimentos\b|\bayb\b|\ba y b\b/i,
    /\bseguridad\b|\bseg\b|\bvigil/i
  ];
  const labels = ['IT', 'MAN', 'AMA', 'RS', 'SEG'];
  tests.forEach((rx, i) => { if (rx.test(t)) out.push(labels[i]); });
  return out;
}

/**
 * Handler para modo ask_area_multiple
 * Cuando falta área en uno de los múltiples tickets
 */
async function handleAskAreaMultiple(ctx) {
  const { s, msg, text, replySafe, setMode, areaLabel, normalizeAreaCode } = ctx;
  
  const t = norm(text);
  
  if (DEBUG) console.log('[ASK_AREA_MULTIPLE] handling', { response: text });
  
  const idx = s._completingMultipleTicketArea;
  
  if (idx === undefined || !Array.isArray(s._multipleTickets) || !s._multipleTickets[idx]) {
    setMode(s, 'multiple_tickets');
    await replySafe(msg, '⚠️ Error interno. Mostrando resumen de tickets.');
    return await showMultipleTicketsSummary(ctx);
  }
  
  // Cancelar
  if (/^cancelar$/i.test(t)) {
    s._completingMultipleTicketArea = undefined;
    return await showMultipleTicketsSummary(ctx, '↩️ Cancelado.');
  }
  
  // Extraer áreas del texto (usa la misma lógica que dialogInterpreter)
  const VALID_AREAS = new Set(['RS', 'AMA', 'MAN', 'IT', 'SEG']);
  const extractedAreas = extractAreasFromText(text);
  
  let area = null;
  
  // Si encontró área(s) en el texto
  if (extractedAreas.length > 0) {
    area = extractedAreas[0]; // Tomar la primera
  }
  
  // Fallback: intentar con normalizeAreaCode si existe
  if (!area && typeof normalizeAreaCode === 'function') {
    const normalized = normalizeAreaCode(text);
    if (normalized && VALID_AREAS.has(normalized.toUpperCase())) {
      area = normalized.toUpperCase();
    }
  }
  
  if (DEBUG) console.log('[ASK_AREA_MULTIPLE] extraction', { text, extractedAreas, area });
  
  // Verificar si es válida
  if (area && VALID_AREAS.has(area)) {
    s._multipleTickets[idx].area_destino = area;
    s._multipleTickets[idx].areas = [area];
    s._multipleTickets[idx]._needsArea = false;
    s._completingMultipleTicketArea = undefined;
    
    // Verificar si hay más tickets incompletos
    const nextIncomplete = s._multipleTickets.findIndex((t, i) => 
      i !== idx && (!t.lugar || !t.area_destino)
    );
    
    if (nextIncomplete >= 0) {
      const ticket = s._multipleTickets[nextIncomplete];
      
      if (!ticket.lugar) {
        s._completingMultipleTicket = nextIncomplete;
        s.draft = { ...ticket };
        
        await replySafe(msg,
          `✅ Área asignada: *${typeof areaLabel === 'function' ? areaLabel(area) : area}*\n\n` +
          `📍 Ahora necesito el *lugar* del ticket ${nextIncomplete + 1}:\n` +
          `   _"${(ticket.descripcion || '').substring(0, 50)}..."_`
        );
        
        setMode(s, 'ask_place');
        return true;
      }
      
      if (!ticket.area_destino) {
        s._completingMultipleTicketArea = nextIncomplete;
        
        await replySafe(msg,
          `✅ Área asignada: *${typeof areaLabel === 'function' ? areaLabel(area) : area}*\n\n` +
          `🏷️ Falta el *área* del ticket ${nextIncomplete + 1}:\n` +
          `   _"${(ticket.descripcion || '').substring(0, 50)}..."_\n\n` +
          '• *MAN* — Mantenimiento\n' +
          '• *AMA* — Ama de llaves\n' +
          '• *RS* — Room Service\n' +
          '• *IT* — Sistemas\n' +
          '• *SEG* — Seguridad'
        );
        
        return true; // Mantener en ask_area_multiple
      }
    }
    
    // Todos completos, mostrar resumen
    const areaLbl = typeof areaLabel === 'function' ? areaLabel(area) : area;
    return await showMultipleTicketsSummary(ctx, `✅ Área asignada: *${areaLbl}*`);
  }
  
  // Área no válida
  await replySafe(msg,
    '❓ No reconocí esa área.\n\n' +
    'Indica el área destino:\n' +
    '• *MAN* — Mantenimiento\n' +
    '• *AMA* — Ama de llaves\n' +
    '• *RS* — Room Service\n' +
    '• *IT* — Sistemas\n' +
    '• *SEG* — Seguridad'
  );
  return true;
}

/**
 * Handler para modo choose_area_single
 * Cuando falta área en un ticket único
 */
async function handleChooseAreaSingle(ctx) {
  const { s, msg, text, replySafe, setMode, setDraftField, areaLabel, normalizeAreaCode } = ctx;
  
  const t = norm(text);
  
  if (DEBUG) console.log('[CHOOSE_AREA_SINGLE] handling', { response: text });
  
  // Cancelar
  if (/^cancelar$/i.test(t)) {
    setMode(s, 'confirm');
    const preview = formatPreviewMessage(s.draft);
    await replySafe(msg, '↩️ Cancelado.\n\n' + preview);
    return true;
  }
  
  // Extraer áreas del texto
  const VALID_AREAS = new Set(['RS', 'AMA', 'MAN', 'IT', 'SEG']);
  const extractedAreas = extractAreasFromText(text);
  
  let area = null;
  
  if (extractedAreas.length > 0) {
    area = extractedAreas[0];
  }
  
  // Fallback con normalizeAreaCode
  if (!area && typeof normalizeAreaCode === 'function') {
    const normalized = normalizeAreaCode(text);
    if (normalized && VALID_AREAS.has(normalized.toUpperCase())) {
      area = normalized.toUpperCase();
    }
  }
  
  if (DEBUG) console.log('[CHOOSE_AREA_SINGLE] extraction', { text, extractedAreas, area });
  
  if (area && VALID_AREAS.has(area)) {
    setDraftField(s, 'area_destino', area);
    if (!s.draft.areas) s.draft.areas = [];
    if (!s.draft.areas.includes(area)) s.draft.areas.push(area);
    
    setMode(s, 'confirm');
    const preview = formatPreviewMessage(s.draft);
    const areaLbl = typeof areaLabel === 'function' ? areaLabel(area) : area;
    await replySafe(msg, 
      `✅ Área asignada: *${areaLbl}*\n\n` + 
      preview + '\n\n' +
      '_Responde *sí* para enviar o *editar* para modificar._'
    );
    return true;
  }
  
  await replySafe(msg,
    '❓ No reconocí esa área.\n\n' +
    'Indica el área destino:\n' +
    '• *MAN* — Mantenimiento\n' +
    '• *AMA* — Ama de llaves\n' +
    '• *RS* — Room Service\n' +
    '• *IT* — Sistemas\n' +
    '• *SEG* — Seguridad'
  );
  return true;
}

/**
 * Handler principal para selección de lugar y área
 */
async function handlePlaceSelection(ctx) {
  const { s, text } = ctx;

  if (!text) return false;

  switch (s.mode) {
    case 'ask_place':
      return handleAskPlace(ctx);
    case 'ask_place_conflict':
      return handleAskPlaceConflict(ctx);
    case 'ask_area_multiple':
      return handleAskAreaMultiple(ctx);
    case 'choose_area_single':
      return handleChooseAreaSingle(ctx);
    default:
      return false;
  }
}

module.exports = { handlePlaceSelection, handlePlaceCompleted };
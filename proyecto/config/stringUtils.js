// config/stringUtils.js

/**
 * normalizeText:
 * Normaliza el texto eliminando diacríticos, espacios extras y convirtiéndolo a minúsculas.
 * Por ejemplo, "Telé" se convierte en "tele".
 *
 * @param {string} text - El texto a normalizar.
 * @returns {string} - El texto normalizado.
 */
function normalizeText(text) {
  return text.normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim().toLowerCase();
}

/**
 * levenshteinDistance:
 * Calcula la distancia de Levenshtein entre dos cadenas, es decir, el número mínimo de
 * operaciones (inserciones, eliminaciones o sustituciones) requeridas para transformar la cadena a en la cadena b.
 *
 * @param {string} a - La primera cadena.
 * @param {string} b - La segunda cadena.
 * @returns {number} - La distancia de Levenshtein entre ambas cadenas.
 */
function levenshteinDistance(a, b) {
  const m = a.length;
  const n = b.length;
  const dp = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));

  for (let i = 0; i <= m; i++) {
    dp[i][0] = i;
  }
  for (let j = 0; j <= n; j++) {
    dp[0][j] = j;
  }
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (a[i - 1] === b[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1];
      } else {
        dp[i][j] = Math.min(
          dp[i - 1][j] + 1,      // Eliminación
          dp[i][j - 1] + 1,      // Inserción
          dp[i - 1][j - 1] + 1   // Sustitución
        );
      }
    }
  }
  return dp[m][n];
}

/**
 * similarity:
 * Calcula el porcentaje de similitud entre dos cadenas usando la distancia de Levenshtein.
 * Se normalizan ambas cadenas antes de la comparación.
 *
 * @param {string} a - La primera cadena.
 * @param {string} b - La segunda cadena.
 * @returns {number} - Un valor entre 0 y 1 donde 1 indica que las cadenas son idénticas.
 */
function similarity(a, b) {
  const normA = normalizeText(a);
  const normB = normalizeText(b);
  const distance = levenshteinDistance(normA, normB);
  const maxLen = Math.max(normA.length, normB.length);
  return maxLen === 0 ? 1 : 1 - (distance / maxLen);
}

/**
 * getAdaptiveThreshold:
 * Ajusta el umbral de similitud en función de la longitud de las cadenas a comparar.
 * - Para palabras muy cortas (máximo 3 caracteres), se exige una coincidencia casi exacta.
 * - Para longitudes intermedias (4 a 6 caracteres), se requiere un 0.7 de similitud.
 * - Para palabras más largas, se usa un umbral de 0.5.
 *
 * @param {string} a - La primera cadena (ya normalizada o sin normalizar).
 * @param {string} b - La segunda cadena.
 * @returns {number} - El umbral de similitud dinámico.
 */
function getAdaptiveThreshold(a, b) {
  const maxLen = Math.max(a.length, b.length);
  if (maxLen <= 3) {
    return 0.9; // Para palabras muy cortas, se exige casi exactitud
  } else if (maxLen <= 6) {
    return 0.8;
  } else {
    return 0.8;
  }
}

/**
 * adaptiveSimilarityCheck:
 * Función de conveniencia que calcula la similitud entre dos cadenas y determina si ésta supera
 * el umbral adaptable.
 *
 * @param {string} a - La primera cadena.
 * @param {string} b - La segunda cadena.
 * @returns {boolean} - true si la similitud es mayor o igual al umbral adaptativo, false en caso contrario.
 */
function adaptiveSimilarityCheck(a, b) {
  const sim = similarity(a, b);
  const threshold = getAdaptiveThreshold(a, b);
  return sim >= threshold;
}

module.exports = {
  normalizeText,
  levenshteinDistance,
  similarity,
  getAdaptiveThreshold,
  adaptiveSimilarityCheck
};
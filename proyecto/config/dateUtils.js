// config/dateUtils.js
const moment = require('moment-timezone');

/**
 * formatDate - Formatea una fecha usando moment-timezone en la zona "America/Hermosillo".
 * El formato utilizado es "DD/MM/YYYY HH:mm:ss".
 *
 * @param {string|Date} date - Fecha a formatear.
 * @returns {string} - Fecha formateada.
 */
function formatDate(date) {
  if (!date) return '';
  return moment(date).tz("America/Hermosillo").format("DD/MM/YYYY HH:mm:ss");
}

module.exports = { formatDate };

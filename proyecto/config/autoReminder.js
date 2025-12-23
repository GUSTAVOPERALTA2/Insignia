const moment = require('moment-timezone');
const config = require('./config');
const incidenceDB = require('../modules/incidenceManager/incidenceDB');
const { formatDate } = require('./dateUtils');  // Importamos el formateador central

/**
 * calcularTiempoSinRespuesta - Calcula el tiempo transcurrido entre la fecha de creación y el momento actual.
 * @param {string} fechaCreacion - Fecha en formato ISO.
 * @returns {string} - Tiempo formateado en días, horas y minutos.
 */
function calcularTiempoSinRespuesta(fechaCreacion) {
  const ahora = moment();
  const inicio = moment(fechaCreacion);
  const duracion = moment.duration(ahora.diff(inicio));
  const dias = Math.floor(duracion.asDays());
  const horas = duracion.hours();
  const minutos = duracion.minutes();
  return `${dias} día(s), ${horas} hora(s), ${minutos} minuto(s)`;
}

/**
 * checkPendingIncidences - Revisa las incidencias pendientes y envía recordatorios individuales.
 * Se ejecuta solo en horario laboral (entre 8 y 21, hora de "America/Hermosillo").
 * Si una incidencia involucra múltiples categorías, se enviará el recordatorio únicamente a los equipos
 * que aún no han confirmado.
 *
 * @param {Object} client - Cliente de WhatsApp.
 * @param {boolean} initialRun - Si true, el umbral es 0h; si false, es 1h.
 */
function checkPendingIncidences(client, initialRun = false) {
  const now = moment().tz("America/Hermosillo");
  const currentHour = now.hour();
  if (currentHour < 6 || currentHour >= 23) {
    console.log(`Fuera del horario laboral (hora actual: ${currentHour}). No se enviará recordatorio.`);
    return;
  }
  
  // Umbral de tiempo: 0h si initialRun, o 1h en caso contrario.
  const threshold = initialRun ? now.toISOString() : now.clone().subtract(1, 'hour').toISOString();
  console.log(`Chequeando incidencias pendientes (umbral ${initialRun ? '0h' : '1h'}): ${threshold}`);

  const db = incidenceDB.getDB();
  if (!db) {
    console.error("La base de datos no está inicializada.");
    return;
  }
  const sql = "SELECT * FROM incidencias WHERE estado NOT IN ('completada','cancelada') AND fechaCreacion < ?";
  db.all(sql, [threshold], (err, rows) => {
    if (err) {
      console.error("Error en recordatorio automático:", err.message);
      return;
    }
    if (!rows || rows.length === 0) {
      console.log(`No se encontraron incidencias pendientes (umbral ${initialRun ? '0h' : '1h'}).`);
      return;
    }
    rows.forEach(row => {
      // Se parsea el campo confirmaciones para saber qué equipos ya han confirmado (si existe)
      let confirmaciones = {};
      if (row.confirmaciones) {
        try {
          confirmaciones = JSON.parse(row.confirmaciones);
        } catch (err) {
          console.error("Error al parsear confirmaciones:", err);
        }
      }
      
      // Dividir la cadena de categorías y enviar recordatorio únicamente a los equipos faltantes.
      const categorias = row.categoria.split(',').map(c => c.trim().toLowerCase());
      categorias.forEach(categoria => {
        const groupId = config.destinoGrupos[categoria];
        if (!groupId) {
          console.warn(`No hay grupo asignado para la categoría: ${categoria}`);
          return;
        }
        // Si ya hay confirmación para esa categoría, no se envía recordatorio
        if (confirmaciones[categoria]) {
          console.log(`La incidencia ${row.id} ya tiene confirmación para la categoría ${categoria}. No se enviará recordatorio a este equipo.`);
          return;
        }
        
        const tiempoSinRespuesta = calcularTiempoSinRespuesta(row.fechaCreacion);
        const fechaFormateada = formatDate(row.fechaCreacion);
        const msg = `\n` +
                    `*RECORDATORIO: TAREA INCOMPLETA*\n\n` +
                    `▪️▪️▪️▪️▪️▪️▪️▪️▪️▪️▪️▪️\n\n` +
                    `${row.descripcion}\n\n` +
                    `▪️▪️▪️▪️▪️▪️▪️▪️▪️▪️▪️▪️\n\n` +
                    `📅 *Creación:* ${fechaFormateada}\n` +
                    `⌛ *Tiempo sin respuesta:* ${tiempoSinRespuesta}\n\n` +
                    `🤖 *Si la tarea ya se completo. Marca "Listo" por favor.* \n\n` +
                    `ID: ${row.id}`;
        console.log(`Enviando recordatorio para incidencia ${row.id} a grupo ${groupId} (categoría ${categoria})`);
        client.getChatById(groupId)
          .then(chat => {
            chat.sendMessage(msg);
            console.log(`Recordatorio enviado para incidencia ${row.id} a grupo ${groupId}.`);
          })
          .catch(e => console.error(`Error al enviar recordatorio para incidencia ${row.id}:`, e));
      });
    });
  });
}

/**
 * startReminder - Inicia la verificación inmediata y periódica (cada 1 hora) de incidencias pendientes.
 *
 * @param {Object} client - Cliente de WhatsApp.
 */
function startReminder(client) {
  // Ejecución inmediata con umbral 0h.
  checkPendingIncidences(client, true);
  // Ejecución periódica cada 1 hora con umbral 1h.
  setInterval(() => {
    checkPendingIncidences(client, false);
  }, 3600000);
}

module.exports = { startReminder };

//nuevo
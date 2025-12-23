// vicebot/modules/incidenceManager/feedbackNotifier.js
const config = require('../../config/config');

/**
 * sendFeedbackRequestToGroups - Envía una notificación de solicitud de retroalimentación
 * a cada grupo correspondiente a la(s) categoría(s) de la incidencia.
 *
 * @param {Object} client - El cliente de WhatsApp.
 * @param {Object} incidence - El objeto incidencia obtenido de la BD.
 */
async function sendFeedbackRequestToGroups(client, incidence) {
  // Suponemos que incidence.categoria es una cadena separada por comas.
  const categorias = incidence.categoria.split(',').map(c => c.trim().toLowerCase());
  for (let categoria of categorias) {
    const groupId = config.destinoGrupos[categoria];
    if (!groupId) {
      console.warn(`No se encontró grupo asignado para la categoría: ${categoria}`);
      continue;
    }
    const msg = `Se solicita retroalimentación para la tarea:\n` +
                `${incidence.descripcion}\n` +
                `ID: ${incidence.id}\n` +
                `Categoría: ${incidence.categoria}\n\n` +
                `Por favor, envíen su retroalimentación personal.`;
    try {
      const chat = await client.getChatById(groupId);
      await chat.sendMessage(msg);
      console.log(`Notificación de retroalimentación enviada al grupo ${groupId} para la categoría ${categoria}`);
    } catch (err) {
      console.error(`Error al enviar retroalimentación a grupo ${groupId}:`, err);
    }
  }
}

module.exports = { sendFeedbackRequestToGroups };

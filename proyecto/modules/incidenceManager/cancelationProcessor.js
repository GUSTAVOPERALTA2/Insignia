// cancelationProcessor.js

const incidenceDB = require('./incidenceDB');
const { getUser } = require('../../config/userManager');
const { normalizeText, adaptiveSimilarityCheck } = require('../../config/stringUtils');

/**
 * processCancelationNewMethod - Procesa una solicitud de cancelación mediante la cita de un mensaje.
 *
 * Se adapta para que la comparación se haga de forma parcial utilizando fuzzy matching.
 */
async function processCancelationNewMethod(client, message) {
  const chat = await message.getChat();
  // Normalizamos el cuerpo del mensaje
  const text = normalizeText(message.body);
  
  // Obtenemos las palabras y frases de cancelación definidas en keywords.json
  const cancelacionData = client.keywordsData.cancelacion;
  if (!cancelacionData) {
    return false;
  }
  
  // Recorremos las palabras de cancelación y comprobamos si el mensaje tiene similitud parcial
  let validCancel = false;
  for (let word of cancelacionData.palabras) {
    if (adaptiveSimilarityCheck(text, normalizeText(word))) {
      console.log(`Cancelación detectada: "${text}" coincide parcialmente con "${word}"`);
      validCancel = true;
      break;
    }
  }
  
  // Si no se encontró en palabras, comprobamos las frases
  if (!validCancel) {
    for (let phrase of cancelacionData.frases) {
      const normalizedPhrase = normalizeText(phrase);
      if (text.includes(normalizedPhrase)) {
        console.log(`Cancelación detectada: "${text}" incluye la frase "${phrase}"`);
        validCancel = true;
        break;
      }
    }
  }
  
  if (message.hasQuotedMsg && validCancel) {
    const quotedMessage = await message.getQuotedMessage();
    let incidenceLookupMethod = null;
    let incidenceLookupId = null;
    
    if (quotedMessage.body.toLowerCase().startsWith("*detalles de la incidencia")) {
      const match = quotedMessage.body.match(/ID:\s*(\d+)/i);
      if (match) {
        incidenceLookupMethod = 'byId';
        incidenceLookupId = match[1];
      } else {
        chat.sendMessage("No se pudo extraer el ID de la incidencia del mensaje de detalles.");
        return true;
      }
    } else {
      incidenceLookupMethod = 'byOriginalMsgId';
      incidenceLookupId = quotedMessage.id._serialized;
    }
    
    try {
      let incidence;
      if (incidenceLookupMethod === 'byId') {
        incidence = await new Promise((resolve, reject) => {
          incidenceDB.getIncidenciaById(incidenceLookupId, (err, row) => {
            if (err) reject(err);
            else resolve(row);
          });
        });
      } else if (incidenceLookupMethod === 'byOriginalMsgId') {
        incidence = await incidenceDB.buscarIncidenciaPorOriginalMsgIdAsync(incidenceLookupId);
      }
      
      if (!incidence) {
        chat.sendMessage("No se encontró la incidencia asociada a ese mensaje.");
        return true;
      }
      
      const senderId = message.author ? message.author : message.from;
      const currentUser = getUser(senderId);
      if (incidence.reportadoPor !== senderId && (!currentUser || currentUser.rol !== 'admin')) {
        chat.sendMessage("No tienes permisos para cancelar esta incidencia.");
        return true;
      }
      
      if (incidence.estado !== "pendiente") {
        chat.sendMessage("La incidencia no se puede cancelar porque no está en estado pendiente.");
        return true;
      }
      
      return new Promise((resolve) => {
        incidenceDB.cancelarIncidencia(incidence.id, (err) => {
          if (err) {
            chat.sendMessage("Error al cancelar la incidencia.");
          } else {
            chat.sendMessage(`La incidencia con ID ${incidence.id} ha sido cancelada.`);
          }
          resolve(true);
        });
      });
    } catch (error) {
      chat.sendMessage("Error al buscar la incidencia.");
      return true;
    }
  }
  
  return false;
}

module.exports = { processCancelationNewMethod };
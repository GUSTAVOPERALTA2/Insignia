const config = require('../../config/config');
const { processNewIncidence } = require('./newIncidence');
const { handleFeedbackRequestFromOrigin, processTeamFeedbackResponse } = require('./feedbackProcessor');
const { processConfirmation } = require('./confirmationProcessor');
// Importamos las funciones de stringUtils, incluyendo la nueva función adaptativa
const { normalizeText, similarity, adaptiveSimilarityCheck } = require('../../config/stringUtils');

async function handleIncidence(client, message) {
  const chat = await message.getChat();
  const chatId = chat.id._serialized;

  // Grupo principal de incidencias
  if (chatId === config.groupPruebaId) {
    if (message.hasQuotedMsg) {
      const quotedMessage = await message.getQuotedMessage();
      // Normalizamos el mensaje citado eliminando asteriscos y diacríticos
      const normalizedQuoted = normalizeText(quotedMessage.body.replace(/\*/g, ''));
      console.log(`Mensaje citado normalizado: "${normalizedQuoted}"`);

      // Procesamos ciertos patrones de confirmación
      if (normalizedQuoted.startsWith("recordatorio: tarea incompleta")) {
        console.log("Recordatorio detectado, redirigiendo a processConfirmation.");
        await processConfirmation(client, message);
        return;
      }
      if (normalizedQuoted.startsWith("nueva tarea recibida")) {
        console.log("Nueva tarea detectada, redirigiendo a processConfirmation.");
        await processConfirmation(client, message);
        return;
      }

      // Para solicitudes de retroalimentación se normaliza el mensaje principal
      const normalizedText = normalizeText(message.body);
      console.log(`Mensaje principal normalizado para retro: "${normalizedText}"`);
      const retroPhrases = client.keywordsData.retro?.frases || [];
      const retroWords = client.keywordsData.retro?.palabras || [];
      let foundIndicator = false;

      // Se evalúan las frases de retroalimentación
      for (let phrase of retroPhrases) {
        const normalizedPhrase = normalizeText(phrase);
        const includesPhrase = normalizedText.includes(normalizedPhrase);
        console.log(`Verificando frase retro: "${phrase}" (normalizada: "${normalizedPhrase}") → incluida: ${includesPhrase}`);
        if (includesPhrase) {
          foundIndicator = true;
          console.log(`Coincidencia detectada con la frase retro: "${phrase}"`);
          break;
        }
      }

      // Si no se encuentra con frases, se procede palabra por palabra
      if (!foundIndicator) {
        const responseWords = normalizedText.split(/\s+/);
        for (let keyword of retroWords) {
          const normalizedKeyword = normalizeText(keyword);
          for (let word of responseWords) {
            const sim = similarity(word, normalizedKeyword);
            console.log(`Comparando retro palabra: "${word}" vs "${normalizedKeyword}" → Similitud: ${sim}`);
            // Se utiliza la función adaptativa, que aplica un umbral según la longitud
            if (adaptiveSimilarityCheck(word, normalizedKeyword)) {
              foundIndicator = true;
              console.log(`Retro palabra detectada: "${word}" coincide con "${normalizedKeyword}" (similitud adaptativa)`);
              break;
            }
          }
          if (foundIndicator) break;
        }
      }

      if (foundIndicator) {
        console.log("Indicadores de retro detectados, procesando solicitud de feedback.");
        await handleFeedbackRequestFromOrigin(client, message);
        return;
      } else {
        await chat.sendMessage("🤖❌ *La forma de contestación no es válida para registrar una incidencia. Por favor, envía tu incidencia sin citar un mensaje.*");
        return;
      }
    }

    // Si no hay mensaje citado, se procesa como una incidencia nueva.
    await processNewIncidence(client, message);

  // Procesa mensajes provenientes de grupos destino (IT, Mantenimiento, Ama de Llaves)
  } else if ([config.groupBotDestinoId, config.groupMantenimientoId, config.groupAmaId].includes(chatId)) {
    await processTeamFeedbackResponse(client, message);
  } else {
    console.log("Mensaje de grupo no gestionado. Se omite.");
  }
}

module.exports = { handleIncidence };
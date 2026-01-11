// modules/ai/contextReply.js
const OpenAI = require('openai');

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

/**
 * generateContextualResponse(userMessage)
 * Devuelve una respuesta breve cuando el mensaje NO es un reporte.
 * Si hay error o no hay respuesta, devuelve null.
 */
async function generateContextualResponse(userMessage) {
  if (!userMessage) return null;

  const systemPrompt = `Eres un asistente amable que responde brevemente a mensajes que NO son reportes de incidencias en un hotel.
Responde con un mensaje breve y amigable, recordando para qué sirve el chat.

Formato de respuesta:
[Tu respuesta breve]

---
🔧 *Este chat es para reportar incidencias del hotel* (algo no funciona, está dañado, etc.)
_Ejemplo: "No funciona el aire en hab 1205"_`;

  try {
    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      max_tokens: 150,
      temperature: 0.7,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage },
      ],
    });

    return response.choices?.[0]?.message?.content?.trim() || null;
  } catch (error) {
    console.warn('[contextReply] OpenAI error:', error?.message || error);
    return null;
  }
}

module.exports = { generateContextualResponse };
// modules/core/safeReply.js
// Reply "seguro" para evitar crashear cuando Puppeteer/WA cierra sesión a media ejecución.

function isSessionClosedError(e) {
  const m = String(e?.message || e || '');
  return (
    m.includes('Session closed') ||
    m.includes('Protocol error') ||
    m.includes('Target closed') ||
    m.includes('Execution context was destroyed') ||
    m.includes('Cannot find context') ||
    m.includes('Most likely the page has been closed')
  );
}

async function safeReply(msg, text) {
  if (!msg) return false;
  try {
    await msg.reply(text);
    return true;
  } catch (e) {
    if (isSessionClosedError(e)) {
      console.warn('[SAFE-REPLY] skip: session/page closed');
      return false;
    }
    throw e;
  }
}

module.exports = {
  safeReply,
  isSessionClosedError
};

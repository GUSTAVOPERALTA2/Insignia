// modules/core/safeReply.js

function isSessionClosedError(e) {
  const m = String(e?.message || e || '');
  return (
    m.includes('Session closed') ||
    m.includes('Protocol error') ||
    m.includes('Target closed') ||
    m.includes('Execution context was destroyed')
  );
}

async function safeReply(msg, text) {
  if (!msg || !text) return false;
  
  try {
    await msg.reply(text);
    return true;
  } catch (e) {
    if (isSessionClosedError(e)) {
      console.warn('[SAFE-REPLY] skip: session closed');
      return false;
    }
    throw e;
  }
}

module.exports = { safeReply, isSessionClosedError };
// modules/utils/safeReply.js

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
  if (!msg || !text) {
    console.warn('[SAFE-REPLY] missing msg or text');
    return false;
  }
  
  try {
    console.log('[SAFE-REPLY] attempting reply:', {
      chatId: msg.from,
      textLength: text.length
    });
    
    await msg.reply(text);
    
    console.log('[SAFE-REPLY] SUCCESS');
    return true;
  } catch (e) {
    console.error('[SAFE-REPLY] ERROR:', e?.message || e);
    
    if (isSessionClosedError(e)) {
      console.warn('[SAFE-REPLY] session closed, skipping');
      return false;
    }
    throw e;
  }
}

module.exports = { safeReply, isSessionClosedError };
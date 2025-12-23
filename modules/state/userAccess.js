// modules/state/userAccess.js
// Define permisos efectivos según canal (DM vs grupo)

const { getContext } = require('./userDirectory');

function isGroup(chatId) {
  return typeof chatId === 'string' && chatId.endsWith('@g.us');
}

function getEffectiveAccess(msg) {
  const chatId = msg.from;
  const ctx = getContext(msg.author || chatId); 
  // msg.author solo existe en grupos; en DM es null

  if (isGroup(chatId)) {
    return {
      ...ctx,
      effectiveRole: 'user',
      isAdmin: false,
      channel: 'group',
    };
  }

  // DM
  return {
    ...ctx,
    effectiveRole: ctx.isAdmin ? 'admin' : 'user',
    isAdmin: ctx.isAdmin,
    channel: 'dm',
  };
}

module.exports = {
  getEffectiveAccess,
};

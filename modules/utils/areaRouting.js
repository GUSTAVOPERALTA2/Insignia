// modules/utils/areaRouting.js
// Mapea áreas a grupos de WhatsApp (usar .env)
function areaToGroupId(area) {
  const env = process.env || {};
  const map = {
    it:  env.GROUP_IT_ID  || null,
    man: env.GROUP_MAN_ID || null,
    ama: env.GROUP_AMA_ID || null,
    rs:  env.GROUP_RS_ID  || null,
    seg: env.GROUP_SEG_ID || null,
  };
  return map[area] || null;
}
module.exports = { areaToGroupId };

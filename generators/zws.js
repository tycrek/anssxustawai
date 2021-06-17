const { randomBytes } = require('crypto');
const zeroWidthChars = ['\u200B', '\u200C', '\u200D', '\u2060'];
module.exports = ({ length }) => [...randomBytes(length)].map(byte => zeroWidthChars[Number(byte) % zeroWidthChars.length]).join('').slice(1) + zeroWidthChars[0];

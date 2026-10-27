'use strict';

// Try a bounded set of image scales in the same OCR child. A match must already
// have passed strict MRZ checks; no recognized text leaves this process.
async function scanWidths(recognize) {
 for (const width of [1000, 1800]) {
  if (await recognize(width) === true) return true;
 }
 return false;
}

module.exports = { scanWidths };

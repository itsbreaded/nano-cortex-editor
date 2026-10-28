// Capture metadata text, cleaned the same way wherever it is shown or sent: the editor page loads this as a script
// (window.NanoText) and the main process requires it for the Cortex Cloud bundle metadata.
(function (root) {
  // A Cortex Cloud product ID (the capture's page is cloud.neuraldsp.com/cloud/neural-capture/view/<id>).
  const CLOUD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const asText = (text) => (text === undefined || text === null ? '' : String(text));

  // Some captures on the pedal carry their Cortex Cloud product ID as the whole description (seen 2026-10-24 on
  // "Darkglass MT900V2 1"). Returns that ID in lowercase, or null when the description is anything else.
  function captureCloudId(text) {
    const t = asText(text).trim();
    return CLOUD_ID.test(t) ? t.toLowerCase() : null;
  }

  // What is stored and sent: empty, blank and the text "null" (any case) all mean "no description". (The "null" seen
  // in the Info panel on a real pedal, 2026-10-23, came from the panel itself; this keeps a "null" from the pedal or
  // from Cortex Cloud metadata out as well.) A Cloud ID is kept: it is part of the capture's record.
  function storedDescription(text) {
    const s = asText(text);
    const t = s.trim();
    return t === '' || t.toLowerCase() === 'null' ? '' : s;
  }

  // What is shown and searched: as stored, except that a bare Cloud ID is no description either (capture Info offers
  // "Open in Cortex Cloud" for it instead).
  function captureDescription(text) {
    const s = storedDescription(text);
    return captureCloudId(s) ? '' : s;
  }

  const NanoText = Object.freeze({ captureDescription, captureCloudId, storedDescription });
  if (typeof module !== 'undefined' && module.exports) module.exports = NanoText;
  else root.NanoText = NanoText;
})(typeof window !== 'undefined' ? window : globalThis);

const SPECK_MARKER_SOURCE = String.raw`<speck:[a-z]{1,16}\/>`;
const SPECK_MARKER_RE = new RegExp(SPECK_MARKER_SOURCE, "g");
const SPECK_SENTINEL_RUN_RE = /[-]+/g;

const SPECK_PAGE_STRIP_RE = new RegExp(` ?${SPECK_MARKER_SOURCE}(?= |$)`, "g");
const SPECK_SENTINEL_BASE = 0xe100;

function protectSpeckMarkers(text) {
  if (typeof text !== "string" || !text.includes("<speck:")) return text;
  return text.replace(SPECK_MARKER_RE, (marker) => {
    let out = "";
    for (let i = 0; i < marker.length; i++) {
      out += String.fromCharCode(SPECK_SENTINEL_BASE + marker.charCodeAt(i));
    }
    return out;
  });
}

function restoreSpeckMarkers(text) {
  if (typeof text !== "string" || !/[-]/.test(text)) return text;
  return text.replace(SPECK_SENTINEL_RUN_RE, (run) => {
    let out = "";
    for (let i = 0; i < run.length; i++) {
      out += String.fromCharCode(run.charCodeAt(i) - SPECK_SENTINEL_BASE);
    }
    return out;
  });
}

function stripSpeckMarkers(text) {
  if (typeof text !== "string" || !text.includes("<speck:")) return text;
  return text.replace(SPECK_PAGE_STRIP_RE, "").replace(SPECK_MARKER_RE, "");
}

function speckFeelings(text) {
  if (typeof text !== "string" || !text.includes("<speck:")) return [];
  return Array.from(text.matchAll(SPECK_MARKER_RE), (m) => m[0].slice(7, -2));
}

module.exports = { protectSpeckMarkers, restoreSpeckMarkers, stripSpeckMarkers, speckFeelings };

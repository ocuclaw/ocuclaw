const LIVEUI_V2_CAPABILITY = "liveuiV2";

const LIVEUI_VOCAB_CAPABILITY_PREFIX = "liveuiVocab:";

const LIVEUI_SURFACE_TYPE = "liveui_surface";

function isLiveUiPresetFrame(frame         )          {
  if (!frame || typeof frame !== "object") return false;
  const { type, spec } = frame                                      ;
  if (type !== LIVEUI_SURFACE_TYPE || !spec || typeof spec !== "object") return false;
  const preset = (spec                        ).preset;
  return !!preset && typeof preset === "object" && !Array.isArray(preset);
}

function parseLiveUiClientCapabilities(capabilities         )                           {
  const list = Array.isArray(capabilities) ? capabilities.filter((c) => typeof c === "string") : [];
  let vocab                = null;
  for (const entry of list            ) {
    if (!entry.startsWith(LIVEUI_VOCAB_CAPABILITY_PREFIX)) continue;
    const text = entry.slice(LIVEUI_VOCAB_CAPABILITY_PREFIX.length);
    if (!/^[0-9]{1,6}$/.test(text)) continue;
    const n = Number(text);
    if (vocab === null || n > vocab) vocab = n;
  }
  const flagged = (list            ).includes(LIVEUI_V2_CAPABILITY);
  return { v2: flagged && vocab !== null && vocab >= 1, vocab };
}

function liveUiClientForm(
  frame                                ,
  capabilities         ,
)                                 {
  if (!frame || typeof frame !== "object" || frame.type !== LIVEUI_SURFACE_TYPE) return null;
  const forms = (frame.liveuiForms && typeof frame.liveuiForms === "object"
    ? frame.liveuiForms
    : { fallback: null })                      ;
  const caps = parseLiveUiClientCapabilities(capabilities);
  if (caps.v2 && caps.vocab !== null) {
    const { liveuiForms: _forms, ...wire } = frame;
    const minVocab = Number.isInteger(forms.minVocab) ? (forms.minVocab          ) : null;
    if (minVocab === null || caps.vocab >= minVocab) {
      const spec = wire.spec                                          ;
      if (!spec || typeof spec !== "object" || !Number.isInteger(spec.vocab) || caps.vocab >= (spec.vocab          )) {
        return wire;
      }
      const older = forms.byVocab && typeof forms.byVocab === "object" ? forms.byVocab[String(caps.vocab)] : undefined;
      if (older && typeof older === "object") return { ...wire, spec: older };
    }

  }
  return forms.fallback && typeof forms.fallback === "object" ? { ...forms.fallback } : null;
}

module.exports = { LIVEUI_V2_CAPABILITY, LIVEUI_VOCAB_CAPABILITY_PREFIX, LIVEUI_SURFACE_TYPE, isLiveUiPresetFrame, parseLiveUiClientCapabilities, liveUiClientForm };

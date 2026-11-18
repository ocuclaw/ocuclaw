const RECOMMENDED_SUFFIX = /\s*\(recommended\)\s*$/i;

function displayOptionLabel(label        )         {
  const shown = label.replace(RECOMMENDED_SUFFIX, "");
  return shown || label;
}

module.exports = { displayOptionLabel };

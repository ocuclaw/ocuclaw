const { LIVEUI_CONTAINERS, LIVEUI_FRAMES, LIVEUI_GRID, LIVEUI_SIZE_CLASSES } = require("./frames.cjs");
const { LIVEUI_BUDGETS, LIVEUI_FMT_STYLES, LIVEUI_OPERATORS, LIVEUI_ROOTS } = require("./operators.cjs");
const { LIVEUI_BEHAVIOURS } = require("./behaviours.cjs");
const { LIVEUI_PRESETS } = require("./presets.cjs");
const { LIVEUI_DECISION } = require("./decision.cjs");
const { LIVEUI_RECORDS } = require("./records.cjs");
const { TEXT_COMPONENT } = require("./components/text.cjs");
const { PAGES_COMPONENT } = require("./components/pages.cjs");
const { LIST_COMPONENT } = require("./components/list.cjs");
const { CHECKLIST_COMPONENT } = require("./components/checklist.cjs");
const { GRAPHIC_COMPONENT } = require("./components/graphic.cjs");
const { IMAGE_COMPONENT } = require("./components/image.cjs");
const { STEPPER_COMPONENT } = require("./components/stepper.cjs");
const { TIMER_COMPONENT } = require("./components/timer.cjs");
const { FACTS_COMPONENT } = require("./components/facts.cjs");
const { TABS_COMPONENT } = require("./components/tabs.cjs");
const { TABLE_COMPONENT } = require("./components/table.cjs");
const { DRAW_COMPONENT } = require("./components/draw.cjs");

const LIVEUI_VOCAB = 3;

const LIVEUI_REGISTRY_SCHEMA = "liveui/registry@1";

const LIVEUI_COMPONENTS                    = [
  TEXT_COMPONENT,
  PAGES_COMPONENT,
  LIST_COMPONENT,
  CHECKLIST_COMPONENT,
  GRAPHIC_COMPONENT,
  IMAGE_COMPONENT,
  STEPPER_COMPONENT,
  TIMER_COMPONENT,
  FACTS_COMPONENT,
  TABS_COMPONENT,
  TABLE_COMPONENT,

  DRAW_COMPONENT,
];

const LIVEUI_REGISTRY                 = {
  vocab: LIVEUI_VOCAB,
  grid: LIVEUI_GRID,
  sizeClasses: LIVEUI_SIZE_CLASSES,
  containers: LIVEUI_CONTAINERS,
  frames: LIVEUI_FRAMES,
  roots: LIVEUI_ROOTS,
  operators: LIVEUI_OPERATORS,
  fmtStyles: LIVEUI_FMT_STYLES,
  behaviours: LIVEUI_BEHAVIOURS,
  budgets: LIVEUI_BUDGETS,
  records: LIVEUI_RECORDS,
  components: LIVEUI_COMPONENTS,
  presets: LIVEUI_PRESETS,
  decision: LIVEUI_DECISION,
};

const LIVEUI_FRAME_CARD_MAX_BYTES = 100;

function liveUiFrameCard(frame             )         {
  const parts = frame.regions.map((region) => {
    if (region.role === "plate") return `${region.name} (image)`;
    const role = region.role === "driver" ? "drives" : "follows";
    return `${region.name} (${role}, ${region.sizeClass})`;
  });
  return `frame ${frame.name}: ${parts.join(", ")}`;
}

const NAME_RE = /^[a-z][a-z0-9_-]*$/;
const PROP_TYPES = ["text", "number", "bool", "enum", "pairs", "list", "duration"];
const TAKES = ["literal", "formula", "text_or_formula", "name"];
const VALUE_TYPES = ["number", "text", "bool", "null", "any"];

const PARAM_TYPES = [...VALUE_TYPES, "list"];
const OVERFLOWS                   = ["cut", "trim", "reject"];
const ROW_TYPES_BY_ROLE                                       = {
  rows: ["item", "check", "stepper"],
  pages: ["page"],
  display: [null],
};
const HEAD_KINDS = ["tabs", "sort"];
const LAYERS = ["dim", "bright", "cursor", "live"];
const CONSENTS = ["explicit_turn_only", "local_commit_only", "none"];
const STATE_TYPES = ["number", "text", "bool", "null", "any", "timer", "row_ref", "page_index"];
const BODY_FORMS = ["text", "rows", "pairs", "pages", "slots"];
const PROP_RULE_OPS = ["lt", "le", "gt", "ge", "ne"];
const DRIVER_SIZE_CLASSES = ["wide", "column"];
const CONTAINER_NAMES = ["title", "marker", "rule", "cursor", "dim", "bright", "live", "input"];
const ROOT_NAMES = ["state", "data", "sel", "prev", "ref"];
const CHAT_SHAPE_IDS = ["conversation", "long_prose", "question_back"];

function utf8Bytes(text        )         {
  return new TextEncoder().encode(text).length;
}

function isPositiveInt(value         )          {
  return Number.isInteger(value) && (value          ) > 0;
}

function duplicates(names          )           {
  const seen = new Set        ();
  const dupes = new Set        ();
  for (const name of names) {
    if (seen.has(name)) dupes.add(name);
    seen.add(name);
  }
  return [...dupes];
}

function checkSince(errors          , where        , since         , vocab        )       {
  if (!Number.isInteger(since) || (since          ) < 1 || (since          ) > vocab) {
    errors.push(`${where}: since must be an integer from 1 to vocab ${vocab}`);
  }
}

function checkProp(errors          , where        , prop            , codes                                        )       {
  const at = `${where} prop ${prop.name}`;
  if (!NAME_RE.test(prop.name)) errors.push(`${at}: bad name`);
  if (!PROP_TYPES.includes(prop.type)) errors.push(`${at}: unknown type ${prop.type}`);
  if (!TAKES.includes(prop.takes)) errors.push(`${at}: unknown takes ${prop.takes}`);
  if (typeof prop.teach !== "string" || !prop.teach) errors.push(`${at}: teach is empty`);
  if ((prop.takes === "formula" || prop.takes === "text_or_formula") && !VALUE_TYPES.includes(prop.resultType          )) {
    errors.push(`${at}: a formula prop needs a resultType`);
  }
  if (prop.type === "enum" && (!Array.isArray(prop.values) || prop.values.length === 0)) {
    errors.push(`${at}: an enum needs values`);
  }
  if (prop.type === "enum" && prop.default !== undefined && !(prop.values || []).includes(String(prop.default))) {
    errors.push(`${at}: default is not one of its values`);
  }
  for (const key of ["maxChars", "labelMaxChars", "minItems", "maxItems"]         ) {
    if (prop[key] !== undefined && !isPositiveInt(prop[key])) errors.push(`${at}: ${key} must be a positive integer`);
  }
  if (prop.overflow !== undefined && !OVERFLOWS.includes(prop.overflow)) errors.push(`${at}: unknown overflow`);
  if ((prop.maxChars !== undefined || prop.maxItems !== undefined) && prop.overflow === undefined && prop.takes === "literal" && prop.type !== "list") {
    errors.push(`${at}: a limit needs an overflow (C3)`);
  }
  if (prop.itemsName !== undefined && (prop.itemsName !== "cols" || prop.type !== "list")) errors.push(`${at}: only a list prop names cols (TB6)`);
  if (prop.required && prop.default !== undefined && !codes.repair.includes(`${prop.name}_repaired`)) {
    errors.push(`${at}: a required prop with a default needs a ${prop.name}_repaired code`);
  }
}

function checkComponent(errors          , reg                , component                 , exampleIds             )       {
  const at = `component ${component.name}`;
  const { codes } = reg.records;
  if (!NAME_RE.test(component.name)) errors.push(`${at}: bad name`);
  checkSince(errors, at, component.since, reg.vocab);
  for (const key of ["teach", "noun", "placeholder", "loading", "fallback"]         ) {
    if (typeof component[key] !== "string" || !component[key]) errors.push(`${at}: ${key} is empty`);
  }
  if (!CONSENTS.includes(component.consent)) errors.push(`${at}: unknown consent ${component.consent}`);

  const reserved = new Set        ();
  for (const kind of reg.records.kinds) {
    if (kind.kind === "component") for (const prop of kind.props) reserved.add(prop.name);
  }
  for (const prop of reg.records.driver) reserved.add(prop.name);
  const propNames = component.props.map((prop) => prop.name);
  for (const dupe of duplicates(propNames)) errors.push(`${at}: duplicate prop ${dupe}`);
  for (const prop of component.props) {
    if (reserved.has(prop.name)) errors.push(`${at}: prop ${prop.name} clashes with a record attribute`);
    checkProp(errors, at, prop, codes);
  }
  for (const rule of component.propRules) {
    if (!PROP_RULE_OPS.includes(rule.op)) errors.push(`${at}: prop rule op ${rule.op} is not a comparison`);
    if (!propNames.includes(rule.left) || !propNames.includes(rule.right)) {
      errors.push(`${at}: prop rule ${rule.left} ${rule.op} ${rule.right} names an unknown prop`);
    }
    if (![...codes.repair, ...codes.reject].includes(rule.code)) errors.push(`${at}: prop rule code ${rule.code} is not a record code`);
  }

  const bodyProp = component.body ? component.body.prop : null;
  if (component.body) {
    const body = component.body;
    if (!BODY_FORMS.includes(body.form)) errors.push(`${at}: unknown body form ${body.form}`);
    if (!NAME_RE.test(body.prop)) errors.push(`${at}: body prop has a bad name`);
    if (reserved.has(body.prop)) errors.push(`${at}: body prop ${body.prop} clashes with a record attribute`);
    if (body.overflow !== undefined && !OVERFLOWS.includes(body.overflow)) errors.push(`${at}: unknown body overflow`);
    if (body.itemOverflow !== undefined && !OVERFLOWS.includes(body.itemOverflow)) errors.push(`${at}: unknown body itemOverflow`);
    if (body.maxItems !== undefined && body.overflow === undefined) errors.push(`${at}: body maxItems needs an overflow (C3)`);
    if (body.itemMaxChars !== undefined && body.itemOverflow === undefined) errors.push(`${at}: body itemMaxChars needs an itemOverflow (C3)`);
    if (body.form === "rows" && !component.rows) errors.push(`${at}: a rows body needs a rows entry`);
  }
  if (component.rows) {
    const rows = component.rows;
    if (!isPositiveInt(rows.maxRows) || rows.maxRows > 20) errors.push(`${at}: maxRows must be 1-20 (V1 maxItems)`);
    if (!isPositiveInt(rows.cellMaxChars)) errors.push(`${at}: cellMaxChars must be a positive integer`);
    if (rows.hiddenCellMaxChars !== undefined && (!isPositiveInt(rows.hiddenCellMaxChars) || rows.hiddenCellMaxChars < rows.cellMaxChars)) {
      errors.push(`${at}: hiddenCellMaxChars must be an integer no less than cellMaxChars`);
    }
    if (!OVERFLOWS.includes(rows.overflow) || !OVERFLOWS.includes(rows.cellOverflow)) errors.push(`${at}: unknown rows overflow`);
    if (!propNames.includes("cols")) errors.push(`${at}: a row component needs a cols prop (G6)`);
    const cells = [rows.labelCell, rows.rightCell, ...(rows.tabCell === undefined ? [] : [rows.tabCell])];
    if (!cells.every((cell) => Number.isInteger(cell) && cell >= 0) || new Set(cells).size !== cells.length) {
      errors.push(`${at}: labelCell, rightCell and tabCell must be distinct cell indexes`);
    }
    if ((rows.tabCell === undefined) !== (rows.maxTabs === undefined)) errors.push(`${at}: tabCell and maxTabs come together (TB1)`);
    if (rows.maxTabs !== undefined && (!isPositiveInt(rows.maxTabs) || rows.maxTabs < 2)) errors.push(`${at}: maxTabs must be 2 or more`);
  }

  for (const dupe of duplicates(component.state.map((entry) => entry.name))) errors.push(`${at}: duplicate state ${dupe}`);
  for (const entry of component.state) {
    if (!STATE_TYPES.includes(entry.type)) errors.push(`${at}: state ${entry.name} has unknown type ${entry.type}`);
    if (entry.class !== "local" && entry.class !== "context") errors.push(`${at}: state ${entry.name} has unknown class`);
  }
  const stateNames = component.state.map((entry) => entry.name);
  const behaviourNames = reg.behaviours.map((behaviour) => behaviour.name);
  for (const use of component.behaviours) {
    if (!behaviourNames.includes(use.name)) errors.push(`${at}: unknown behaviour ${use.name}`);
    if (!stateNames.includes(use.on) && !propNames.includes(use.on)) errors.push(`${at}: behaviour ${use.name} acts on unknown ${use.on}`);
  }

  const drives = component.drives;
  const rowTypes = ROW_TYPES_BY_ROLE[drives.role];
  if (!rowTypes) errors.push(`${at}: unknown drive role ${drives.role}`);
  else if (!rowTypes.includes(drives.rowType)) errors.push(`${at}: drive role ${drives.role} cannot have row type ${drives.rowType}`);
  if (drives.drivesAlone && drives.role !== "pages") errors.push(`${at}: only pages drives alone (I3)`);
  if (drives.role === "pages" && (drives.takesActions || !drives.drivesAlone)) errors.push(`${at}: pages drives alone and takes no actions (I3)`);
  if (drives.head !== undefined) {
    if (!HEAD_KINDS.includes(drives.head)) errors.push(`${at}: unknown head ${drives.head}`);
    if (drives.rowType !== "item") errors.push(`${at}: a Head Row leads item rows (TB2)`);
    if (drives.head === "tabs" && component.rows?.tabCell === undefined) errors.push(`${at}: a tabs head needs a tabCell (TB1)`);
  }
  if (drives.head !== "tabs" && component.rows?.tabCell !== undefined) errors.push(`${at}: a tabCell needs a tabs head (TB1)`);

  const sizeClasses = new Map(reg.sizeClasses.map((sizeClass) => [sizeClass.name, sizeClass]));
  if (component.fits.length === 0) errors.push(`${at}: fits is empty`);
  for (const dupe of duplicates(component.fits.map((fit) => fit.sizeClass))) errors.push(`${at}: duplicate fit ${dupe}`);
  for (const fit of component.fits) {
    const sizeClass = sizeClasses.get(fit.sizeClass);
    if (!sizeClass) {
      errors.push(`${at}: fits unknown size class ${fit.sizeClass}`);
      continue;
    }
    if (fit.linesMin > fit.linesMax || fit.linesMax > Math.max(sizeClass.linesMax, 0) || fit.linesMin < 0) {
      errors.push(`${at}: fit ${fit.sizeClass} lines ${fit.linesMin}-${fit.linesMax} fall outside the class`);
    }
  }
  const fitsPlate = component.fits.some((fit) => fit.sizeClass === "plate");
  if (fitsPlate !== component.cost.image) errors.push(`${at}: a plate component takes the image container, and only it does (C5)`);
  if (fitsPlate && component.fits.length !== 1) errors.push(`${at}: a plate component fits only the plate`);
  const fitsDriver = component.fits.some((fit) => DRIVER_SIZE_CLASSES.includes(fit.sizeClass));
  if (drives.role !== "display" && !fitsDriver) errors.push(`${at}: a driving component must fit a driver size class`);
  if (drives.takesActions && !fitsDriver) errors.push(`${at}: takes actions but never sits in a driver`);
  if (!Number.isInteger(component.cost.lineBytesMax) || component.cost.lineBytesMax < 0 || component.cost.lineBytesMax > reg.budgets.containerBytes) {
    errors.push(`${at}: lineBytesMax must be 0-${reg.budgets.containerBytes}`);
  }
  for (const layer of component.cost.layers) if (!LAYERS.includes(layer)) errors.push(`${at}: unknown layer ${layer}`);
  if (!component.cost.image && component.cost.layers.length === 0) errors.push(`${at}: a text component writes at least one layer`);
  if (drives.role === "rows" && !component.cost.layers.includes("cursor")) errors.push(`${at}: a row component writes the cursor layer`);
  if (component.mergeRecords !== undefined && !isPositiveInt(component.mergeRecords)) errors.push(`${at}: mergeRecords must be a positive integer`);

  for (const match of component.fallback.matchAll(/\{([^}]*)\}/g)) {
    const name = match[1];
    if (!propNames.includes(name) && name !== bodyProp) errors.push(`${at}: fallback names unknown prop {${name}}`);
  }

  const frames = new Set(reg.frames.map((frame) => frame.name));
  let valid = 0;
  let invalid = 0;
  let taught = 0;
  for (const example of component.examples) {
    const where = `${at} example ${example.id}`;
    if (!example.id.startsWith(`${component.name}.`)) errors.push(`${where}: id must start with "${component.name}."`);
    if (exampleIds.has(example.id)) errors.push(`${where}: duplicate example id`);
    exampleIds.add(example.id);
    if (!frames.has(example.frame)) errors.push(`${where}: unknown frame ${example.frame}`);
    if (!example.records.startsWith(`<${reg.records.tag} frame="${example.frame}"`)) {
      errors.push(`${where}: records must open with its frame record`);
    }
    if (!example.records.includes(`c="${component.name}"`)) errors.push(`${where}: records never use the component`);
    if ([...example.records].length > reg.budgets.recordChars) errors.push(`${where}: records over ${reg.budgets.recordChars} characters`);
    const expect = example.expect                           ;
    if (expect.valid === true) valid += 1;
    else if (Array.isArray(expect.repair)) {
      invalid += 1;
      if (expect.repair.length === 0) errors.push(`${where}: repair lists no code`);
      for (const code of expect.repair) if (!codes.repair.includes(code          )) errors.push(`${where}: unknown repair code ${code}`);
    } else if (typeof expect.reject === "string") {
      invalid += 1;
      if (!codes.reject.includes(expect.reject)) errors.push(`${where}: unknown reject code ${expect.reject}`);
    } else errors.push(`${where}: expect must be valid, repair or reject`);
    if (example.teach) {
      taught += 1;
      if (expect.valid !== true) errors.push(`${where}: only a valid example is taught`);
    }
  }
  if (valid < 1 || valid > 3) errors.push(`${at}: needs 1-3 valid examples (C4)`);
  if (invalid < 1 || invalid > 3) errors.push(`${at}: needs 1-3 repaired or rejected examples (C4)`);
  if (taught !== 1) errors.push(`${at}: marks exactly one example for teaching`);

  const anchors = component.codeAnchors;
  if (!anchors || !Array.isArray(anchors.tests) || (anchors.renderer !== null && typeof anchors.renderer.file !== "string")) {
    errors.push(`${at}: codeAnchors must hold renderer (or null) and tests`);
  }
}

function checkFrame(errors          , reg                , frame             )       {
  const at = `frame ${frame.name}`;
  const { grid } = reg;
  if (!NAME_RE.test(frame.name)) errors.push(`${at}: bad name`);
  checkSince(errors, at, frame.since, reg.vocab);
  if (!frame.teach) errors.push(`${at}: teach is empty`);
  if (!frame.choose || !frame.choose.what) errors.push(`${at}: choose.what is empty (J1, J13)`);
  if (!Array.isArray(frame.codeAnchors)) errors.push(`${at}: codeAnchors must be a list`);
  if (frame.regions.length === 0) errors.push(`${at}: no Regions`);
  for (const dupe of duplicates(frame.regions.map((region) => region.name))) errors.push(`${at}: duplicate Region ${dupe}`);
  const drivers = frame.regions.filter((region) => region.role === "driver");
  if (drivers.length > 1) errors.push(`${at}: more than one driver`);
  if (drivers.length === 1 && frame.regions[0].role !== "driver") errors.push(`${at}: the driver must be the first Region (F8)`);
  const sizeClasses = new Map(reg.sizeClasses.map((sizeClass) => [sizeClass.name, sizeClass]));
  for (const region of frame.regions) {
    const where = `${at} Region ${region.name}`;
    const sizeClass = sizeClasses.get(region.sizeClass);
    if (!sizeClass) {
      errors.push(`${where}: unknown size class ${region.sizeClass}`);
      continue;
    }
    if ((region.role === "plate") !== (region.sizeClass === "plate")) errors.push(`${where}: only a plate Region is plate-sized`);
    if (region.role === "driver" && !DRIVER_SIZE_CLASSES.includes(region.sizeClass)) errors.push(`${where}: a driver is wide or column`);
    if (region.role === "plate") {
      const box = region.image;
      if (!box || region.text) {
        errors.push(`${where}: a plate Region has an image box and no text box`);
        continue;
      }
      if (box.w > sizeClass.widthPx || box.h > 144 || box.x < 0 || box.y < 0 || box.x + box.w > grid.canvasWidth || box.y + box.h > grid.canvasHeight) {
        errors.push(`${where}: image box falls outside the canvas or the 288x144 plate`);
      }
      continue;
    }
    const box = region.text;
    if (!box || region.image) {
      errors.push(`${where}: a text Region has a text box and no image box`);
      continue;
    }
    if (box.x0 < grid.bodyX0 || box.x1 > grid.bodyX1 || box.x0 >= box.x1) errors.push(`${where}: x falls outside the body`);
    if (box.lineFirst < grid.bodyLineFirst || box.lineLast > grid.bodyLineLast || box.lineFirst > box.lineLast) {
      errors.push(`${where}: lines fall outside the body`);
    }
    const lines = box.lineLast - box.lineFirst + 1;
    if (lines < sizeClass.linesMin || lines > sizeClass.linesMax) {
      errors.push(`${where}: ${lines} lines do not fit size class ${region.sizeClass} (${sizeClass.linesMin}-${sizeClass.linesMax})`);
    }
  }
  const card = liveUiFrameCard(frame);
  if (utf8Bytes(card) > LIVEUI_FRAME_CARD_MAX_BYTES) errors.push(`${at}: card is over ${LIVEUI_FRAME_CARD_MAX_BYTES} bytes (J12)`);
}

function validateLiveUiRegistry(reg                 = LIVEUI_REGISTRY)                                    {
  const errors           = [];
  if (!isPositiveInt(reg.vocab)) errors.push("vocab must be a positive integer");

  for (const dupe of duplicates(reg.sizeClasses.map((sizeClass) => sizeClass.name))) errors.push(`duplicate size class ${dupe}`);
  const containerNames = reg.containers.map((container) => container.name);
  if (containerNames.join(",") !== CONTAINER_NAMES.join(",")) errors.push(`containers must be the eight of F4, in order: ${CONTAINER_NAMES.join(", ")}`);
  const captures = reg.containers.filter((container) => container.eventCapture);
  if (captures.length !== 1) errors.push("exactly one container captures events (F5)");

  for (const capture of captures) {
    if (capture.box.h < reg.grid.lineHeight) errors.push(`${capture.name}: the capture container is shorter than one line (F5)`);
  }

  for (const dupe of duplicates(reg.frames.map((frame) => frame.name))) errors.push(`duplicate frame ${dupe}`);
  for (const frame of reg.frames) checkFrame(errors, reg, frame);

  const rootNames = reg.roots.map((root) => root.name);
  if ([...rootNames].sort().join(",") !== [...ROOT_NAMES].sort().join(",")) errors.push(`roots must be R3's five: ${ROOT_NAMES.join(", ")}`);

  for (const dupe of duplicates(reg.operators.map((operator) => operator.name))) errors.push(`duplicate operator ${dupe}`);
  for (const dupe of duplicates(reg.operators.filter((operator) => operator.infix).map((operator) => operator.infix          ))) {
    errors.push(`duplicate infix ${dupe}`);
  }
  for (const operator of reg.operators) {
    const at = `operator ${operator.name}`;
    checkSince(errors, at, operator.since, reg.vocab);
    if (rootNames.includes(operator.name         )) errors.push(`${at}: clashes with a root (C14)`);
    for (const type of [...operator.params, ...(operator.rest ? [operator.rest] : [])]) {
      if (!PARAM_TYPES.includes(type)) errors.push(`${at}: unknown type ${type}`);
    }
    if (operator.params.indexOf("list") > 0) errors.push(`${at}: a list is only the first argument`);
    if ((operator.params[0] === "list") !== (operator.group === "aggregate")) errors.push(`${at}: an aggregate takes a list first`);
    if (!Number.isInteger(operator.minArgs) || operator.minArgs < 1 || operator.minArgs > operator.params.length) {
      errors.push(`${at}: minArgs must be 1 to the number of params`);
    }
    if (operator.rest === null && operator.maxArgs !== operator.params.length) errors.push(`${at}: with no rest, maxArgs is the number of params`);
    if (operator.rest !== null && operator.maxArgs !== null && operator.maxArgs <= operator.params.length) {
      errors.push(`${at}: maxArgs leaves no room for rest`);
    }
    if (operator.result === "same" ? !operator.resultFrom || operator.resultFrom.length === 0 : !VALUE_TYPES.includes(operator.result)) {
      errors.push(`${at}: result must be a type, or same with resultFrom`);
    }
    if (!isPositiveInt(operator.cost)) errors.push(`${at}: cost must be a positive integer`);
    if (!operator.teach) errors.push(`${at}: teach is empty`);
  }
  for (const dupe of duplicates(reg.fmtStyles.map((style) => style.name))) errors.push(`duplicate fmt style ${dupe}`);
  if (!reg.operators.some((operator) => operator.name === "fmt") && reg.fmtStyles.length > 0) errors.push("fmt styles need the fmt operator");

  for (const dupe of duplicates(reg.behaviours.map((behaviour) => behaviour.name))) errors.push(`duplicate behaviour ${dupe}`);
  for (const behaviour of reg.behaviours) {
    checkSince(errors, `behaviour ${behaviour.name}`, behaviour.since, reg.vocab);
    for (const param of behaviour.params) {
      if (!VALUE_TYPES.includes(param.type) || !TAKES.includes(param.takes)) errors.push(`behaviour ${behaviour.name} param ${param.name}: bad type or takes`);
    }
  }

  for (const [key, value] of Object.entries(reg.budgets)) if (!isPositiveInt(value)) errors.push(`budget ${key} must be a positive integer`);

  const kinds = reg.records.kinds.map((kind) => kind.kind);
  if (kinds.join(",") !== "frame,let,component") errors.push("record kinds must be frame, let and component (G3)");
  for (const kind of reg.records.kinds) for (const prop of kind.props) checkProp(errors, `record ${kind.kind}`, prop, reg.records.codes);
  for (const prop of reg.records.driver) checkProp(errors, "record driver", prop, reg.records.codes);
  for (const dupe of duplicates([...reg.records.codes.repair, ...reg.records.codes.reject])) errors.push(`duplicate record code ${dupe}`);

  for (const dupe of duplicates(reg.components.map((component) => component.name))) errors.push(`duplicate component ${dupe}`);
  const exampleIds = new Set        ();
  for (const component of reg.components) checkComponent(errors, reg, component, exampleIds);

  const componentNames = reg.components.map((component) => component.name);
  const frameNames = reg.frames.map((frame) => frame.name);
  for (const dupe of duplicates(reg.presets.map((preset) => preset.name))) errors.push(`duplicate Preset ${dupe}`);
  for (const preset of reg.presets) {
    const at = `Preset ${preset.name}`;
    checkSince(errors, at, preset.since, reg.vocab);
    for (const name of preset.components) if (!componentNames.includes(name)) errors.push(`${at}: unknown component ${name}`);
    if (!frameNames.includes(preset.hostFrame)) errors.push(`${at}: unknown host frame ${preset.hostFrame}`);
    const plain = preset.v1Templates.length === 0;
    if (plain && (!preset.choose || !preset.choose.what)) errors.push(`${at}: a plain Preset carries its kind's choose (J13)`);
    if (!plain && preset.choose !== null) errors.push(`${at}: a template Preset carries no choose (J13)`);
  }
  for (const dupe of duplicates(reg.presets.filter((preset) => preset.v1Templates.length === 0).map((preset) => preset.v1Kind))) {
    errors.push(`two plain Presets answer to ${dupe}`);
  }

  const decision = reg.decision;
  const triggers = [...decision.triggers, decision.namedDestination];
  for (const dupe of duplicates(triggers.map((trigger) => trigger.id))) errors.push(`duplicate trigger ${dupe}`);
  for (const trigger of triggers) {
    if (!trigger.wording || !trigger.label) errors.push(`trigger ${trigger.id}: wording and label are needed`);
    if (trigger.label.split(/\s+/).length > 8) errors.push(`trigger ${trigger.id}: label over eight words (J14)`);
    if (trigger.firstRound !== null && !isPositiveInt(trigger.firstRound)) errors.push(`trigger ${trigger.id}: firstRound must be a round number or null`);
  }
  if (decision.chatShapes.map((shape) => shape.id).join(",") !== CHAT_SHAPE_IDS.join(",")) {
    errors.push(`chat shapes must be ${CHAT_SHAPE_IDS.join(", ")}`);
  }
  for (const shape of decision.chatShapes) if (shape.label.split(/\s+/).length > 8) errors.push(`chat shape ${shape.id}: label over eight words`);
  if (!isPositiveInt(decision.round)) errors.push("decision round must be a round number (J15)");
  for (const entry of [...triggers, ...decision.chatShapes]) {
    if (entry.firstRound !== null && entry.firstRound > decision.round) {
      errors.push(`${entry.id}: firstRound ${entry.firstRound} is after the current round ${decision.round}`);
    }
  }
  if (!decision.model || decision.model.endsWith("-latest")) errors.push("decision model must be a pinned Jev version (J16)");
  if (Object.keys(decision.floors).join(",") !== "render,chat,kind,slot") errors.push("decision floors are render, chat, kind and slot, in that order");
  for (const [name, floor] of Object.entries(decision.floors)) {
    if (!(typeof floor === "number" && floor > 0 && floor <= 1)) errors.push(`decision floor ${name} must be in (0, 1]`);
  }

  for (const [frame, floor] of Object.entries(decision.frameTrust || {})) {
    if (!frameNames.includes(frame)) errors.push(`trusted frame ${frame} is not a frame (J3)`);
    if (!(typeof floor === "number" && floor > 0 && floor <= 1)) errors.push(`trusted frame ${frame}: floor must be in (0, 1]`);
  }

  if (decision.round >= 6 && !(decision.questions.frame && decision.questions.frame.type === "choice")) {
    errors.push("decision round 6 and later ask the frame question (J1)");
  }
  if (decision.lines.v2Framed && !decision.lines.v2Framed.includes("<card>")) {
    errors.push("decided line v2Framed must carry <card> (J12)");
  }
  const plainKinds = reg.presets.filter((preset) => preset.v1Templates.length === 0).map((preset) => preset.v1Kind);
  const reasonKinds = Object.keys(decision.lines.kindReason);
  for (const kind of plainKinds) if (!reasonKinds.includes(kind)) errors.push(`decided line: no kind reason for plain Preset kind ${kind}`);
  for (const kind of reasonKinds) if (!plainKinds.includes(kind)) errors.push(`decided line: kind reason for ${kind}, which no plain Preset answers to`);
  for (const [name, line] of Object.entries(decision.lines)) {
    if (typeof line === "string" && !line) errors.push(`decided line ${name} is empty`);
  }

  return { ok: errors.length === 0, errors };
}

function buildLiveUiRegistryArtifact(reg                 = LIVEUI_REGISTRY)                          {
  return {
    schema: LIVEUI_REGISTRY_SCHEMA,
    vocab: reg.vocab,
    grid: reg.grid,
    sizeClasses: reg.sizeClasses,
    containers: reg.containers,
    frames: reg.frames.map((frame) => ({
      name: frame.name,
      since: frame.since,
      teach: frame.teach,
      regions: frame.regions,
      choose: frame.choose,
      card: liveUiFrameCard(frame),
      codeAnchors: frame.codeAnchors,
    })),
    roots: reg.roots,
    operators: reg.operators,
    fmtStyles: reg.fmtStyles,
    behaviours: reg.behaviours,
    budgets: reg.budgets,
    records: reg.records,
    components: reg.components,
    presets: reg.presets,
    decision: reg.decision,
  };
}

module.exports = { LIVEUI_VOCAB, LIVEUI_REGISTRY_SCHEMA, LIVEUI_COMPONENTS, LIVEUI_REGISTRY, LIVEUI_FRAME_CARD_MAX_BYTES, liveUiFrameCard, validateLiveUiRegistry, buildLiveUiRegistryArtifact };

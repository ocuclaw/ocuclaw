const LIVEUI_BEHAVIOURS                    = [
  {
    name: "step",
    since: 1,
    writes: "number",
    params: [
      { name: "by", type: "number", takes: "formula", required: false, default: 1 },
      { name: "min", type: "number", takes: "formula", required: true },
      { name: "max", type: "number", takes: "formula", required: true },
      { name: "wrap", type: "bool", takes: "literal", required: false, default: false },
    ],
    teach: "moves a number by `by` between `min` and `max`; clamps at the ends, or wraps if asked",
  },
  {
    name: "toggle",
    since: 1,
    writes: "bool",
    params: [],
    teach: "flips a mark",
  },
  {
    name: "select",
    since: 1,
    writes: "select",
    params: [{ name: "options", type: "text", takes: "literal", required: true }],
    teach: "moves to the next or previous entry of a closed list of at most 20",
  },
  {
    name: "expand",
    since: 1,
    writes: "view",
    params: [],
    teach: "shows or hides a component's detail; view state, like focus",
  },
  {
    name: "countdown",
    since: 1,
    writes: "timer",
    params: [
      { name: "for", type: "number", takes: "literal", required: false },
      { name: "until", type: "number", takes: "formula", required: false },
    ],
    teach: "counts down for a duration, or until a data time; at zero it shows 0:00 and wakes nobody",
  },
  {
    name: "elapsed",
    since: 1,
    writes: "timer",
    params: [{ name: "since", type: "number", takes: "formula", required: false }],
    teach: "counts up from its start, or since a data time",
  },

  {
    name: "sort",
    since: 3,
    writes: "view",
    params: [{ name: "by", type: "text", takes: "literal", required: true }],
    teach: "orders a table's rows by one column, low to high, or high to low after a -; view state, like focus",
  },

  {
    name: "keep",
    since: 3,
    writes: "value",
    params: [{ name: "on", type: "any", takes: "formula", required: true }],
    teach: "a let with on keeps a value: it starts at be, and each named action's tap sets it to that action's formula",
  },
  {
    name: "append",
    since: 3,
    writes: "rows",
    params: [
      { name: "on", type: "text", takes: "name", required: true },
      { name: "row", type: "any", takes: "formula", required: true },
    ],
    teach: "a list with on and row adds that row, one formula per col, on each tap of the named action, up to its 20 rows",
  },
];

module.exports = { LIVEUI_BEHAVIOURS };

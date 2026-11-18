const LIVEUI_PRESETS                 = [
  {
    name: "list",
    since: 1,
    v1Kind: "list_surface",
    v1Templates: [],
    components: ["list"],
    hostFrame: "full",
    choose: {
      what: "A short set of named things: they pick one by its name, and the name alone is enough — including when more about the one they pick sits behind it and they open it AFTER choosing. Also the right shape when the assistant proposes a set of named things and the wearer is approving the set.",
      not_for: "Rows they have to weigh against each other, where the reason has to be visible before they can decide",
      examples: [
        "start me at the three categories and let me open whichever looks right",
        "which services has the Greggs, Keele or Sandbach?",
        "group my photo folders by month, but check with me first",
      ],
    },
    teach: "V1 list_surface",
  },
  {
    name: "checklist",
    since: 1,
    v1Kind: "checklist_surface",
    v1Templates: [],
    components: ["checklist"],
    hostFrame: "full",
    choose: {
      what: "Items THEY tick off as they go, in any order they like, where the list is theirs and the point is what is left.",
      not_for:
        "A procedure the assistant walks them through one step at a time, waiting between steps. That is a document they page through, not a list they own.",
      examples: ["the leaving-the-house routine", "what's left to pack"],
    },
    teach: "V1 checklist_surface",
  },
  {
    name: "list_with_details",
    since: 1,
    v1Kind: "list_with_details_surface",
    v1Templates: [],
    components: ["list", "text"],
    hostFrame: "stack",
    choose: {
      what: "A set of rows where each row's reason, trade-off or outcome has to be visible BEFORE they choose, because the labels alone would not let them decide. Also the right shape for the shape of a day or an hour, and for an account of several separate things, where each line is a thing and the detail is how it goes.",
      not_for:
        "A set of named things they browse and open one at a time; a brief read straight through in order; a single verdict about one thing",
      examples: [
        "what did I actually get through today",
        "what's the shape of today",
        "what am I doing in the next hour, and when do I move",
      ],
    },
    teach: "V1 list_with_details_surface: a list with a text reading sel.detail",
  },
  {
    name: "text",
    since: 1,
    v1Kind: "text_surface",
    v1Templates: [],
    components: ["text"],
    hostFrame: "full",
    choose: {
      what: "One thing they read or glance at: a value, a verdict, a short note, one named label, a countdown that ticks on its own. Nothing to pick. A single verdict about one journey or one activity belongs here however many facts fed into it.",
      not_for:
        "A set of options they choose between; an account of several separate things that each deserve their own line; the shape of their day or their next hour, where every entry is its own row",
      examples: [
        "is it worth taking the bike in this morning",
        "how's the surf looking",
        "just the bird and its name, nothing else",
        "twenty-five minutes head-down, starting now",
      ],
    },
    teach: "V1 text_surface",
  },
  {
    name: "paged_text",
    since: 1,
    v1Kind: "paged_text_surface",
    v1Templates: [],
    components: ["pages"],
    hostFrame: "full",
    choose: {
      what: "One longer thing they move through screen by screen with nothing to choose: a briefing they absorb before something starts, a summary read straight through in order, or a procedure where only the current step is on screen.",
      not_for: "Short answers, picks, the shape of a day, or a single value that keeps ticking on its own",
      examples: [
        "ten minutes till the board call — what do I actually need to know",
        "talk me through bleeding the radiator, one step at a time",
        "give me the gist a bit at a time",
      ],
    },
    teach: "V1 paged_text_surface",
  },
  {
    name: "image_caption",
    since: 1,
    v1Kind: "text_surface",
    v1Templates: ["image_caption"],
    components: ["image", "text"],
    hostFrame: "plate",
    choose: null,
    teach: "V1 text_surface with the image_caption template: a picture with a caption",
  },
  {
    name: "graphic",
    since: 1,
    v1Kind: "text_surface",
    v1Templates: ["graphic", "graphic_v2"],
    components: ["graphic", "text"],
    hostFrame: "plate",
    choose: null,
    teach: "V1 text_surface with the graphic or graphic_v2 template: a Graphic with a caption",
  },
  {
    name: "duration_picker",
    since: 1,
    v1Kind: "list_surface",
    v1Templates: ["duration_picker"],
    components: [],
    hostFrame: "plate",
    choose: null,
    teach: "V1 list_surface with the duration_picker template: V1's wheel plate stays (P2)",
  },
];

module.exports = { LIVEUI_PRESETS };

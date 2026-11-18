const LIVEUI_DECISION                 = {

  round: 6,

  model: "jev-1.13.0",

  floors: { render: 0.8, chat: 0.5, kind: 0.6, slot: 0.7 },

  frameTrust: { split: 0.5, plate: 0.85, "rail-plate": 0.5, stack: 0.9 },
  lines: {

    kindReason: {
      text_surface: "one block they read",
      list_surface: "they pick and the label is the answer",
      list_with_details_surface: "they pick and each row needs its own reason",
      checklist_surface: "they mark a routine as they go",
      paged_text_surface: "they page through one document",
    },
    unkindedReason: "this is worth holding on the glass",
    renderTail: "Do not deliberate whether to render or which kind; author the content now and call render_glasses_ui once.",
    renderTailUnkinded: "Do not deliberate whether to render; author the content now and call render_glasses_ui once.",
    chat: "This turn is answered in chat. Do not call render_glasses_ui.",
    skipGuide:
      "Author it from render_glasses_ui's own description and skip the glasses-ui skill unless it must update live or uses an image or graphic template.",
    scope: "Applies to this message only; any earlier surface_decision is void.",

    v2Framed: "This turn renders a composed surface in <card>.",
    v2Unframed: "This turn renders a composed surface; pick its frame from the frame list.",
    v2Tail: "Do not deliberate whether to render; write the frame record first, then the other records.",

    v2OpenSurface:
      "This turn renders on the glasses: patch the open surface by id, or write a frame record first to start a new one.",

    v2Chat: "This turn is answered in chat. Write no UI records.",
  },
  renderShape: {
    id: "render_surface",
    lead: "Put it on the glasses. Any ONE of these is enough:",
    not_for: "Idle curiosity or banter with nothing to act on",
    examples: [
      "quick, 180 fan or 200?",
      "which of these three should I take",
      "is it worth surfing Lyall Bay this afternoon",
      "am I ahead or behind on the target",
      "nudge me to take the tablets at eight tonight",
      "talk me through bleeding the radiator, one step at a time",
      "what did I actually get through today",
      "just the bird and its name, nothing else",
      "just your gut, one word — the 7:40 or the 9:15 for my sister's flight",
      "rename it to something sensible, but check with me first",
    ],
  },

  triggers: [
    {
      id: "pick_from_set",
      wording: "they will pick from a set",
      label: "they pick from a set",
      examples: ["which of these three should I take", "quick, 180 fan or 200?"],
      firstRound: 2,
    },
    {
      id: "glance_value",
      wording: "they will glance at a value or a verdict and act on it",
      label: "a value or verdict to act on",
      examples: [
        "is it worth surfing Lyall Bay this afternoon",
        "just your gut, one word — the 7:40 or the 9:15 for my sister's flight",
      ],
      firstRound: 2,
    },
    {
      id: "watch_change",
      wording: "they will watch something change on its own",
      label: "something that changes on its own",
      examples: ["twenty-five minutes head-down, starting now"],
      firstRound: 2,
    },
    {
      id: "needs_visual",
      wording: "they need a visual (a chart, an image, a named thing beside its picture)",
      label: "something visual",
      examples: ["just the bird and its name, nothing else"],
      firstRound: 2,
    },
    {
      id: "procedure_step",
      wording: "they asked to be taken through a procedure, with only the current step kept on screen",
      label: "a procedure, one step on screen",
      examples: ["talk me through bleeding the radiator, one step at a time"],
      firstRound: 5,
    },
    {
      id: "later_time",
      wording: "they asked to be shown something at a later time or event",
      label: "something shown at a later time",
      examples: ["nudge me to take the tablets at eight tonight"],
      firstRound: 2,
    },
    {
      id: "account_of_events",
      wording: "they asked for an account of what happened",
      label: "an account of what happened",
      examples: ["what did I actually get through today"],
      firstRound: 2,
    },
    {
      id: "numbers_vs_target",
      wording: "they asked how their own numbers sit against a target",
      label: "their own numbers against a target",
      examples: ["am I ahead or behind on the target"],
      firstRound: 4,
    },
    {
      id: "propose_to_approve",
      wording: "they asked the assistant to propose something for them to approve",
      label: "a proposal for them to approve",
      examples: ["rename it to something sensible, but check with me first"],
      firstRound: 2,
    },
  ],
  chatShapes: [
    {
      id: "conversation",
      label: "a spoken reply is the whole answer",
      what: "A spoken reply is the whole answer: idle curiosity, banter, an opinion, a fact they hear once and do not need to hold. This includes a yes-or-no verdict on a question with two sides to it, heard once, with no named options to pick between and nothing to keep.",
      not_for:
        "A reading of the wearer's own numbers, work or day; a one-word pick between named options they want kept on screen; something they will act on at a later moment (a reminder, a nudge, a time to leave); an account of what they did; a name they need to recall; a reading they will look at more than once",
      examples: [
        "why do cats knead?",
        "what's the difference between a mutex and a semaphore?",
        "is two grand a fair price for a 2012 Golf, yes or no?",
      ],
      firstRound: 5,
    },
    {
      id: "long_prose",
      label: "the long version, listened to",
      what: "They explicitly asked for the long version or the full story AND said they would rather listen than look.",
      not_for:
        "A procedure where only the current step is on screen. Even when they say 'talk me through it', each step has to stay put on screen until they move on, so that is a surface.",
      examples: ["talk me through how a heat pump works, I'm just listening"],
      firstRound: 2,
    },
    {
      id: "question_back",
      label: "a fact only the wearer holds",
      what: "The assistant cannot produce any useful answer until the wearer supplies a fact that ONLY the wearer holds.",
      not_for:
        "A request the assistant can answer with a reasonable default. This includes a request where the wearer asked to be checked with before it is applied: the proposal IS the answer, and it is shown to them for approval.",
      examples: ["send it to the usual address"],
      firstRound: 2,
    },
  ],

  namedDestination: {
    id: "named_destination",
    wording:
      "they named where the answer goes, in chat or on the glasses; that wins over every trigger, and a bare \"show me\" or \"put it up\" names no destination",
    label: "a named destination wins",
    examples: [
      "just tell me in chat",
      "no need to render this one",
      "put this on the glasses",
      "on the display, not in chat",
    ],
    firstRound: null,
  },
  questions: {
    reply_shape: {
      type: "choice",
      instructions: {
        question:
          "The wearer of smart glasses (small heads-up display, about five short lines) said this to their assistant. What should the assistant do with its answer?",
        focus: "Judge by what the wearer will DO with the answer, not by how much content there is.",
        inspect: "wearer_said",
      },
    },
    kind: {
      type: "choice",
      instructions: {
        question:
          "If this were put on the glasses, which surface fits? Decide by what the wearer does with it, never by how much content it holds.",
        inspect: "wearer_said",
      },
    },

    frame: {
      type: "choice",
      instructions: {
        question:
          "If this were put on the glasses as one screen, which layout fits it? Decide by what the wearer does with it, never by how much content it holds.",
        inspect: "wearer_said",
      },
    },
    graphic_slot: {
      type: "choice",
      instructions: {
        question:
          "If a small chart were drawn for this, which one element fits the shape of the reading? Pick none when words, a pick, or a live-ticking number is the right answer.",
        inspect: "wearer_said",
      },
    },
    wants_recurring: {
      type: "noul",
      instructions: {
        question:
          "Does the wearer want this to happen again on a schedule or keep updating, rather than once right now?",
        inspect: "wearer_said",
      },
    },
    template_vs_task: {
      type: "choice",
      instructions: {
        question:
          "Is this one thing the assistant answers now and is then finished with, or something the wearer asked to have run again later on its own?",
        focus:
          "Judge what the wearer asked for, not how useful a standing task would be. Saving something they asked for once is a cost they did not agree to.",
        inspect: "wearer_said",
      },
    },
  },
  graphicSlots: {
    metric: "one number that matters, possibly with which way it moved",
    sparkline: "a trend over time, the shape of recent values",
    bars: "a few values side by side with one that matters",
    heatstrip: "a per-hour pattern across the day",
    progress: "share of a goal as a bar",
    ring: "share of a goal as a ring",
    bullet: "a value against its target",
    gauge: "a value on a known scale with min and max",
    keyvalue: "a few labelled facts",
    status: "a plain current state with an icon",
    none: "no chart fits: the answer is words, a pick, or a value that keeps ticking live",
  },
  taskQuestions: {
    wants_recurring: {
      true: {
        what: "Asks for it every morning, daily, whenever it changes, keep watching",
        examples: ["I'd like it every morning", "keep an eye on it"],
      },
      false: { what: "A one-off question answered now" },
    },
    template_vs_task: {
      template: {
        what: "Answered once, now. When the wearer looks away it is finished, even if the answer keeps ticking while they are watching it.",
        not_for: "A standing arrangement the wearer asked to keep running after this moment",
        examples: [
          "which of these three should I take",
          "how's the surf looking right now",
          "what did I get through today",
        ],
      },
      task: {
        what: "The wearer asked for it to run again later by itself: on a schedule, at a named time, or whenever some condition changes.",
        not_for: "A single question they want answered this once",
        examples: [
          "I'd like it every morning",
          "nudge me at eight tonight",
          "tell me if the build goes red while I'm cooking",
        ],
      },
    },
  },
};

module.exports = { LIVEUI_DECISION };

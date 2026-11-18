function deepFreeze   (value   )    {
  if (value && typeof value === "object") {
    for (const child of Object.values(value                           )) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

const ROUND_5 =  {
  "reply_shape": {
    "type": "choice",
    "instructions": {
      "question": "The wearer of smart glasses (small heads-up display, about five short lines) said this to their assistant. What should the assistant do with its answer?",
      "focus": "Judge by what the wearer will DO with the answer, not by how much content there is.",
      "inspect": "wearer_said"
    },
    "criteria": {
      "render_surface": {
        "what": "Put it on the glasses. Any ONE of these is enough: they will pick from a set; they will glance at a value or a verdict and act on it; they will watch something change on its own; they need a visual (a chart, an image, a named thing beside its picture); they asked to be taken through a procedure, with only the current step kept on screen; they asked to be shown something at a later time or event; they asked for an account of what happened; they asked how their own numbers sit against a target; or they asked the assistant to propose something for them to approve.",
        "not_for": "Idle curiosity or banter with nothing to act on",
        "examples": [
          "quick, 180 fan or 200?",
          "which of these three should I take",
          "is it worth surfing Lyall Bay this afternoon",
          "am I ahead or behind on the target",
          "nudge me to take the tablets at eight tonight",
          "talk me through bleeding the radiator, one step at a time",
          "what did I actually get through today",
          "just the bird and its name, nothing else",
          "just your gut, one word — the 7:40 or the 9:15 for my sister's flight",
          "rename it to something sensible, but check with me first"
        ]
      },
      "conversation": {
        "what": "A spoken reply is the whole answer: idle curiosity, banter, an opinion, a fact they hear once and do not need to hold. This includes a yes-or-no verdict on a question with two sides to it, heard once, with no named options to pick between and nothing to keep.",
        "not_for": "A reading of the wearer's own numbers, work or day; a one-word pick between named options they want kept on screen; something they will act on at a later moment (a reminder, a nudge, a time to leave); an account of what they did; a name they need to recall; a reading they will look at more than once",
        "examples": [
          "why do cats knead?",
          "what's the difference between a mutex and a semaphore?",
          "is two grand a fair price for a 2012 Golf, yes or no?"
        ]
      },
      "long_prose": {
        "what": "They explicitly asked for the long version or the full story AND said they would rather listen than look.",
        "not_for": "A procedure where only the current step is on screen. Even when they say 'talk me through it', each step has to stay put on screen until they move on, so that is a surface.",
        "examples": [
          "talk me through how a heat pump works, I'm just listening"
        ]
      },
      "question_back": {
        "what": "The assistant cannot produce any useful answer until the wearer supplies a fact that ONLY the wearer holds.",
        "not_for": "A request the assistant can answer with a reasonable default. This includes a request where the wearer asked to be checked with before it is applied: the proposal IS the answer, and it is shown to them for approval.",
        "examples": [
          "send it to the usual address"
        ]
      }
    }
  },
  "kind": {
    "type": "choice",
    "instructions": {
      "question": "If this were put on the glasses, which surface fits? Decide by what the wearer does with it, never by how much content it holds.",
      "inspect": "wearer_said"
    },
    "criteria": {
      "list_surface": {
        "what": "A short set of named things: they pick one by its name, and the name alone is enough — including when more about the one they pick sits behind it and they open it AFTER choosing. Also the right shape when the assistant proposes a set of named things and the wearer is approving the set.",
        "not_for": "Rows they have to weigh against each other, where the reason has to be visible before they can decide",
        "examples": [
          "start me at the three categories and let me open whichever looks right",
          "which services has the Greggs, Keele or Sandbach?",
          "group my photo folders by month, but check with me first"
        ]
      },
      "checklist_surface": {
        "what": "Items THEY tick off as they go, in any order they like, where the list is theirs and the point is what is left.",
        "not_for": "A procedure the assistant walks them through one step at a time, waiting between steps. That is a document they page through, not a list they own.",
        "examples": [
          "the leaving-the-house routine",
          "what's left to pack"
        ]
      },
      "list_with_details_surface": {
        "what": "A set of rows where each row's reason, trade-off or outcome has to be visible BEFORE they choose, because the labels alone would not let them decide. Also the right shape for the shape of a day or an hour, and for an account of several separate things, where each line is a thing and the detail is how it goes.",
        "not_for": "A set of named things they browse and open one at a time; a brief read straight through in order; a single verdict about one thing",
        "examples": [
          "what did I actually get through today",
          "what's the shape of today",
          "what am I doing in the next hour, and when do I move"
        ]
      },
      "text_surface": {
        "what": "One thing they read or glance at: a value, a verdict, a short note, one named label, a countdown that ticks on its own. Nothing to pick. A single verdict about one journey or one activity belongs here however many facts fed into it.",
        "not_for": "A set of options they choose between; an account of several separate things that each deserve their own line; the shape of their day or their next hour, where every entry is its own row",
        "examples": [
          "is it worth taking the bike in this morning",
          "how's the surf looking",
          "just the bird and its name, nothing else",
          "twenty-five minutes head-down, starting now"
        ]
      },
      "paged_text_surface": {
        "what": "One longer thing they move through screen by screen with nothing to choose: a briefing they absorb before something starts, a summary read straight through in order, or a procedure where only the current step is on screen.",
        "not_for": "Short answers, picks, the shape of a day, or a single value that keeps ticking on its own",
        "examples": [
          "ten minutes till the board call — what do I actually need to know",
          "talk me through bleeding the radiator, one step at a time",
          "give me the gist a bit at a time"
        ]
      }
    }
  },
  "graphic_slot": {
    "type": "choice",
    "instructions": {
      "question": "If a small chart were drawn for this, which one element fits the shape of the reading? Pick none when words, a pick, or a live-ticking number is the right answer.",
      "inspect": "wearer_said"
    },
    "criteria": {
      "metric": "one number that matters, possibly with which way it moved",
      "sparkline": "a trend over time, the shape of recent values",
      "bars": "a few values side by side with one that matters",
      "heatstrip": "a per-hour pattern across the day",
      "progress": "share of a goal as a bar",
      "ring": "share of a goal as a ring",
      "bullet": "a value against its target",
      "gauge": "a value on a known scale with min and max",
      "keyvalue": "a few labelled facts",
      "status": "a plain current state with an icon",
      "none": "no chart fits: the answer is words, a pick, or a value that keeps ticking live"
    }
  },
  "wants_recurring": {
    "type": "noul",
    "instructions": {
      "question": "Does the wearer want this to happen again on a schedule or keep updating, rather than once right now?",
      "inspect": "wearer_said"
    },
    "criteria": {
      "true": {
        "what": "Asks for it every morning, daily, whenever it changes, keep watching",
        "examples": [
          "I'd like it every morning",
          "keep an eye on it"
        ]
      },
      "false": {
        "what": "A one-off question answered now"
      }
    }
  },
  "template_vs_task": {
    "type": "choice",
    "instructions": {
      "question": "Is this one thing the assistant answers now and is then finished with, or something the wearer asked to have run again later on its own?",
      "focus": "Judge what the wearer asked for, not how useful a standing task would be. Saving something they asked for once is a cost they did not agree to.",
      "inspect": "wearer_said"
    },
    "criteria": {
      "template": {
        "what": "Answered once, now. When the wearer looks away it is finished, even if the answer keeps ticking while they are watching it.",
        "not_for": "A standing arrangement the wearer asked to keep running after this moment",
        "examples": [
          "which of these three should I take",
          "how's the surf looking right now",
          "what did I get through today"
        ]
      },
      "task": {
        "what": "The wearer asked for it to run again later by itself: on a schedule, at a named time, or whenever some condition changes.",
        "not_for": "A single question they want answered this once",
        "examples": [
          "I'd like it every morning",
          "nudge me at eight tonight",
          "tell me if the build goes red while I'm cooking"
        ]
      }
    }
  }
} ;

const JEV_ROUND_5_QUESTIONS = deepFreeze(ROUND_5);

module.exports = { JEV_ROUND_5_QUESTIONS };

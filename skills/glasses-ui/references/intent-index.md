# Intent index — every registry row, one line each

GENERATED from [`template-registry.json`](template-registry.json) by
`tools/glasses-ui-skill/build-intent-index.js`; a drift test regenerates it
byte-for-byte. Do not hand-edit.

These rows are **citable defaults**, not a menu. **No matching row is not a
refusal**: if the glass earns its place, render it. Wire kinds and moves are
the vocabulary; occasions are open.

Columns: id · what the wearer is doing · kind/move · the rule that bites.
Budgets and field sets stay in the registry JSON — look a row up before you
author it; never quote a budget from memory.

## Renderable today

```
image_caption@1          show one small greyscale image with a…    text/replace    one paint; re-render to change it
graphic@1                show a reading by its shape               text/replace    slot by shape: one number metric, trend sparkline, goal progress|ring, vs target bullet, per-hour heatstrip, facts keyvalue, state status
choose_one@1             pick exactly one option out of a short…   list/replace    expiry parks, it never picks
compare_options@1        weigh several options against each other… details/replace opening a detail is local, not an answer
mapped_list@1            replace a label-only list from a…         list/replace    display-only; silence is never consent
mapped_detail_list@1     replace a detail list from a changing…    details/replace opening a detail is local, not an answer
live_metric_card@1       keep one number in front of the wearer…   text/replace    a tick is a repaint, never a claim
drilldown_parent_child@1 a list whose rows open a deeper surface…  list/PUSH       never replace at depth>=2
drilldown_parent_child@2 read full release notes from a short…     list/replace    display-only; silence is never consent
quick_check@1            a casual agent ask — "you okay with X?"…  list/replace    a tap is an answer, never an authorization
ambient_status@1         a background fact the wearer glances at…  text/replace    expiring is normal, not a failure
deadline_with_safe_default@1 something happens at a stated time…       text/replace    expiry applies only a reversible default
progress_monitor@1       show a long job advancing while the…      text/PATCH      owes a 2nd render
error_repair@1           a recipe failed; the agent fixes it and…  text/PATCH      owes a 2nd render
paged_briefing@1         hand the wearer a short document they…    paged/replace   paging is local; it proves nothing
compare_and_choose@1     turn messy search results into a few…     details/replace opening a detail is local, not an answer
guided_procedure@1       carry the next step of a hands-busy…      paged/replace   paging is local; it proves nothing
walking_brief@1          distil a desk full of sources into the…   paged/replace   paging is local; it proves nothing
next_hour_plan@1         compose calendar, route, and priority…    details/replace opening a detail is local, not an answer
message_triage@1         reduce a noisy inbox to the tiny set…     details/replace opening a detail is local, not an answer
checklist_routine@1      work a short physical checklist with…     checklist/PATCH owes a 2nd render
bring_it_back@1          resume a useful surface from earlier      text/replace    re-render meaning, never a replayed action
morning_agenda@1         the day, once, at the start of it         details/replace a routine that ran is not a routine that landed
next_meeting@1           what is next, and when to move            text/replace    a routine that ran is not a routine that landed
weather_commute@1        weather and the journey, before stepping… text/replace    a glance card, not a persistent HUD
focus_timer@1            a focus block, visible while it runs      text/replace    a glance card, not a persistent HUD
reminder_card@1          a scheduled nudge for a medication or a…  text/replace    a glance card, not a persistent HUD
end_of_day_recap@1       what happened today, once, at the end of… details/replace a glance card, not a persistent HUD
watchlist_status@1       where the things you are waiting on have… details/replace a glance card, not a persistent HUD
attention_check@1        answer the question 'does anything need…  details/replace the empty answer is a real render
```

## Registered, not renderable today — sending one is an error, not a stretch

```
collect_votes@1          collect several taps over time instead…   list/PATCH      a tally is not an instruction to act
progress_watch@2         watch something that takes a while and…   text/PATCH      owes a 2nd render
safe_deadline@1          a deadline with a default that cannot…    text/replace    display-only; silence is never consent
threshold_watch@1        watch a machine and only interrupt the…   details/replace a crossed line raises an intent, never an action
scheduled_agent_prompt@1 run a wearer-authored prompt on a…        text/replace    a routine that ran is not a routine that landed
```

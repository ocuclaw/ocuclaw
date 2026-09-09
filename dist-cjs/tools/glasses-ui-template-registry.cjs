const TEMPLATE_REGISTRY_SCHEMA_ID = "glasses-ui/template-registry@1";

const TEMPLATE_REGISTRY_VERSION = 1;

const WIRE_KIND_ENUM = [
  "text_surface",
  "list_surface",
  "list_with_details_surface",
  "checklist_surface",
  "paged_text_surface",
];

const WIRE_TEMPLATE_FIELD_ENUM = ["image_caption"];

const TEMPLATE_STATUSES = ["shipped", "specified", "sketch"];
const TEMPLATE_LANES = ["registry_entry_only", "kinds_licensed"];
const TEMPLATE_DISPOSITIONS = ["active", "held"];
const WIRE_KIND_STATUSES = ["existing", "proposed"];
const SURFACE_MOVES = ["replace", "patch", "push", "none"];

const CONSENT_POLICIES = [

  "read_only_display",

  "explicit_turn_only",

  "local_commit_only",

  "deadline_with_safe_default",

  "stale_guarded_reconfirm",
];

const SEED_GROUPS = [
  "shipped_code",
  "master_plan_t_table",
  "named_versioned_corpus",
  "experience_prototype_moment",
  "control_center_glance_card",
];

const entries = [

  {
    name: "image_caption",
    version: 1,
    status: "shipped",
    lane: "registry_entry_only",
    disposition: "active",
    renderableToday: true,
    dependencies: [],
    wireKind: { status: "existing", name: "text_surface" },
    wireTemplateField: "image_caption",
    intent:
      "Show one small greyscale image with a single caption line under it — a welcome card, a rasterized glyph, a one-off picture.",
    summary:
      "The only template that exists in shipped code (PR #1242). One centered image above the body, which is the caption and also the whole fallback on 2.0.0 clients that cannot paint the image. One-shot: it is an image transfer, not a live surface.",
    fieldSet: {
      closed: true,
      fields: [
        { name: "kind", type: "string", requirement: "required", limit: 'const "text_surface"', note: "" },
        { name: "template", type: "string", requirement: "required", limit: 'const "image_caption"', note: "the wire template field" },
        { name: "body", type: "string", requirement: "required", limit: "1-64 chars", note: "the caption AND the 2.0.0 fallback text" },
        { name: "title", type: "string", requirement: "forbidden", limit: "", note: "rejected with image_caption_title_unsupported — one caption line only" },
        { name: "refresh", type: "object", requirement: "forbidden", limit: "", note: "rejected with image_caption_refresh_unsupported — re-render explicitly" },
        { name: "imageAsset", type: "string", requirement: "optional", limit: 'enum ["hermes_welcome"]', note: "exactly one of imageAsset OR the three inline image fields" },
        { name: "imageBase64", type: "string", requirement: "optional", limit: "<=73728 chars, decodes to <=41472 bytes, must be PNG", note: "IHDR dimensions must equal imageWidth/imageHeight" },
        { name: "imageWidth", type: "integer", requirement: "optional", limit: "20-288", note: "required with imageBase64" },
        { name: "imageHeight", type: "integer", requirement: "optional", limit: "20-144", note: "required with imageBase64" },
      ],
    },
    layoutBudgets: {
      measured: true,
      source: "live validation code (see codeAnchors)",
      budgets: {
        captionMaxChars: 64,
        imageMinWidthPx: 20,
        imageMaxWidthPx: 288,
        imageMinHeightPx: 20,
        imageMaxHeightPx: 144,
        imageMaxDecodedBytes: 41472,
        imageMaxBase64Chars: 73728,
        imageFormat: "PNG (IHDR-checked)",
      },
    },
    lifecycle: {
      move: "replace",
      timeoutMs: null,
      staleAfterMs: null,
      refresh: null,
      outcomePolicy:
        "One-shot paint. No refresh, no cron, no tap semantics beyond the surface's normal back/dismiss. Re-render explicitly to change the image.",
    },
    consent: {
      actuatesOnExpiry: false,
      actuatesOnTick: false,
      requiresStaleAfterMs: false,
      policy: "read_only_display",
      assertion:
        "Display-only. The surface has no expiry-actuated and no tick-actuated consequence. Silence is never consent.",
    },
    example: {
      synthetic: true,
      renderableToday: true,
      note: "Built-in asset variant. The inline variant is identical but supplies imageBase64 + imageWidth + imageHeight instead of imageAsset.",
      spec: {
        kind: "text_surface",
        template: "image_caption",
        body: "Welcome back",
        imageAsset: "hermes_welcome",
      },
    },
    provenance: {
      seedGroup: "shipped_code",
      sources: [
        { doc: "extensions/ocuclaw/src/tools/glasses-ui-descriptors.ts", anchor: "validateImageCaptionTemplate" },
        { doc: "extensions/ocuclaw/src/tools/glasses-ui-tool.ts", anchor: "glassesUiParametersSchema.properties.template" },
        { doc: "docs/superpowers/plans/2026-08-18-liveui-reset-charting-brief.md", anchor: "grill lock 3 — #1242 regularized as the first registry entry, not excepted" },
      ],
    },
    codeAnchors: [
      "extensions/ocuclaw/src/tools/glasses-ui-limits.ts — GLASSES_UI_LIMITS.imageCaptionMax / imageWidthMin / imageWidthMax / imageHeightMin / imageHeightMax / imagePayloadMax / imagePayloadBase64Max",
      "extensions/ocuclaw/src/tools/glasses-ui-descriptors.ts — validateImageCaptionTemplate, GLASSES_UI_IMAGE_ASSETS",
    ],
    relatedTo: [],
    openQuestions: [],
  },

  {
    name: "choose_one",
    version: 1,
    status: "specified",
    lane: "registry_entry_only",
    disposition: "active",
    renderableToday: true,
    dependencies: [],
    wireKind: { status: "existing", name: "list_surface" },
    wireTemplateField: null,
    intent: "The wearer must pick exactly one option out of a short shortlist.",
    summary:
      "The canonical pick-one surface. Rows are the options; selecting one is the whole point of the surface and is the explicit turn. The named version `choose_one@1` in the research corpus and the prototype is this same template, pinned. RECONCILED 2026-08-19 (#542): DISTINCT from `compare_options@1` and its prototype name `compare_and_choose@1`, and the distinction is structural — those carry a detail body per row on `list_with_details_surface`, this one is label-only on `list_surface`. Because of that it is explicitly NOT subject to the 6-visible-row fold or the 30-char label budget (#1417).",
    fieldSet: {
      closed: true,
      fields: [
        { name: "kind", type: "string", requirement: "required", limit: 'const "list_surface"', note: "" },
        { name: "title", type: "string", requirement: "optional", limit: "<=64 chars; keep roots <=20 for breadcrumb budget", note: "" },
        { name: "items", type: "string[]", requirement: "required", limit: "1-20 items, <=64 chars each", note: "native SDK list — do NOT cap at 6 rows or 30 chars; that is list_with_details only (#1417)" },
        { name: "timeoutMs", type: "integer", requirement: "optional", limit: "~300000", note: "" },
      ],
    },
    layoutBudgets: {
      measured: false,
      source: "master plan Part 2 house style, AMENDED 2026-08-19 (#1417); SDK native list caps from GLASSES_UI_LIMITS",
      budgets: { maxItems: 20, itemMaxChars: 64, titleMaxChars: 64, recommendedTitleMaxChars: 20 },
    },
    lifecycle: {
      move: "replace",
      timeoutMs: 300000,
      staleAfterMs: null,
      refresh: null,
      outcomePolicy:
        "selected -> act on the choice; back -> re-render the prior surface; expired -> park the intent, never choose for the wearer.",
    },
    consent: {
      actuatesOnExpiry: false,
      actuatesOnTick: false,
      requiresStaleAfterMs: false,
      policy: "explicit_turn_only",
      assertion:
        "Only an explicit selection is an answer. Expiry parks; it never picks a default option. Silence is never consent.",
    },
    example: {
      synthetic: true,
      renderableToday: true,
      note: "Synthetic hotels, invented for this registry.",
      spec: {
        kind: "list_surface",
        title: "Hotels > pick one",
        items: ["Harbour House - quiet", "Arcade Hotel - best access", "Northbank - low price", "Foundry Rooms - closest"],
      },
    },
    provenance: {
      seedGroup: "master_plan_t_table",
      sources: [
        { doc: "docs/superpowers/plans/2026-07-04-liveui-master-plan.md", anchor: "Part 2 §A template table, row T1" },
        { doc: "docs/design/liveui-research/MCP-APPS-LIVEUI-PATTERN-RESEARCH.md", anchor: "§User-facing delta 3 — `choose_one@1` named and versioned" },
        { doc: "docs/design/liveui-research/liveui-experience-prototype.html", anchor: "dash-gateway / gate-stack — `choose_one@1`, 4 bounded rows, 20m stale guard" },
      ],
    },
    codeAnchors: [],
    relatedTo: ["compare_options@1", "compare_and_choose@1"],
    openQuestions: [
      "The prototype's gateway card states a '20m stale guard' for choose_one@1 while the plan's T1 row leaves staleAfterMs blank. Recorded as found on both sides; not reconciled here.",
    ],
  },
  {
    name: "compare_options",
    version: 1,
    status: "specified",
    lane: "registry_entry_only",
    disposition: "active",
    renderableToday: true,
    dependencies: [],
    wireKind: { status: "existing", name: "list_with_details_surface" },
    wireTemplateField: null,
    intent: "The wearer wants to weigh several options against each other before choosing.",
    summary:
      "Rows plus a short detail body per row. Opening a detail is local browsing and never reaches the agent; only the selection does. This is the one kind whose fake-list renderer really is capped at 6 visible rows and 30-char labels. RECONCILED 2026-08-19 (#542): this is the CANONICAL compare template. `compare_and_choose@1` is the experience prototype's name for it. The line against `choose_one@1` is the wire kind and it is a real distinction, not a naming one: detail bodies to compare before picking ⇒ this entry; a label-only shortlist ⇒ `choose_one@1` on `list_surface`, where the 6-row fold and 30-char label budget do NOT apply.",
    fieldSet: {
      closed: true,
      fields: [
        { name: "kind", type: "string", requirement: "required", limit: 'const "list_with_details_surface"', note: "" },
        { name: "title", type: "string", requirement: "optional", limit: "<=64 chars", note: "" },
        { name: "items", type: "{label, body?}[]", requirement: "required", limit: "1-20 items; label <=64 chars (keep <=30 to survive the fake-list renderer); body <=200 chars; bodies sum <=6144 chars", note: "the parallel-array shape (items:[string] + details:[string]) is accepted and coerced server-side" },
      ],
    },
    layoutBudgets: {
      measured: true,
      source: "GLASSES_UI_LIMITS + the fake-list renderer's 6-visible-row fold (master plan house style, AMENDED 2026-08-19 #1417 — applies to this kind ONLY)",
      budgets: {
        maxItems: 20,
        visibleRowsBeforeFold: 6,
        labelMaxChars: 64,
        recommendedLabelMaxChars: 30,
        detailBodyMaxChars: 200,
        totalDetailPayloadMaxChars: 6144,
      },
    },
    lifecycle: {
      move: "replace",
      timeoutMs: { min: 300000, max: 600000 },
      staleAfterMs: null,
      refresh: null,
      outcomePolicy: "selected -> act; teach local-scroll browsing so the wearer reads details without burning turns.",
    },
    consent: {
      actuatesOnExpiry: false,
      actuatesOnTick: false,
      requiresStaleAfterMs: false,
      policy: "explicit_turn_only",
      assertion:
        "Scrolling and opening a detail are local movement, not answers. Only a selection is intent. Expiry parks. Silence is never consent.",
    },
    example: {
      synthetic: true,
      renderableToday: true,
      note: "Synthetic train times and prices.",
      spec: {
        kind: "list_with_details_surface",
        title: "Trains > compare",
        items: [
          { label: "08:42 direct", body: "68 GBP. No changes. Arrives 10:14." },
          { label: "09:05 one change", body: "41 GBP. Change at Midford, 9 min. Arrives 10:52." },
          { label: "09:18 direct", body: "75 GBP. No changes. Arrives 10:44." },
        ],
      },
    },
    provenance: {
      seedGroup: "master_plan_t_table",
      sources: [{ doc: "docs/superpowers/plans/2026-07-04-liveui-master-plan.md", anchor: "Part 2 §A template table, row T2" }],
    },
    codeAnchors: ["extensions/ocuclaw/src/tools/glasses-ui-limits.ts — maxItems / itemMax / detailBodyMax / totalDetailPayloadMax"],
    relatedTo: ["choose_one@1", "compare_and_choose@1"],
    openQuestions: [],
  },
  {
    name: "mapped_list",
    version: 1,
    status: "shipped",
    lane: "registry_entry_only",
    disposition: "active",
    renderableToday: true,
    dependencies: [],
    wireKind: { status: "existing", name: "list_surface" },
    wireTemplateField: null,
    intent: "Replace a label-only list from a changing recipe-output array.",
    summary:
      "B6 variable-array mapping on the existing list_surface. One itemsFromPath ending in [] is mapped through one label template. Source order is preserved; the result is clamped to 20 rows and 6144 UTF-8 bytes. There is no implicit pagination or load-more turn.",
    fieldSet: {
      closed: true,
      fields: [
        { name: "kind", type: "string", requirement: "required", limit: 'const "list_surface"', note: "no new wire kind" },
        { name: "items", type: "string[]", requirement: "required", limit: "1-20 seed rows", note: "last good rows remain on mapping failure" },
        { name: "refresh.targets.itemsFromPath", type: "string", requirement: "required", limit: "bounded path ending in []", note: "source order preserved" },
        { name: "refresh.targets.itemTemplate.label", type: "string", requirement: "required", limit: "<=4096 template chars; emitted label <=64 chars", note: "paths are relative to one source element" },
        { name: "refresh.targets.itemTemplate.body", type: "string", requirement: "forbidden", limit: "use mapped_detail_list@1", note: "list_surface is label-only" },
      ],
    },
    layoutBudgets: {
      measured: false,
      source: "GLASSES_UI_LIMITS + B6 UTF-8 payload contract",
      budgets: { maxItems: 20, itemMaxChars: 64, maxUtf8Bytes: 6144 },
    },
    lifecycle: {
      move: "replace",
      timeoutMs: null,
      staleAfterMs: null,
      refresh: { replacement: "deterministic", pagination: "unsupported" },
      outcomePolicy: "A refresh replaces the whole bounded row set. A selection remains the explicit wearer turn.",
    },
    consent: {
      actuatesOnExpiry: false,
      actuatesOnTick: false,
      requiresStaleAfterMs: false,
      policy: "explicit_turn_only",
      assertion: "Ticks only repaint data. Only an explicit selection is an answer. Silence is never consent.",
    },
    example: {
      synthetic: true,
      renderableToday: true,
      note: "Synthetic queue rows over a placeholder public data host.",
      spec: {
        kind: "list_surface",
        title: "Queue",
        items: ["Loading"],
        refresh: {
          recipe: { kind: "http", url: "https://api.example.com/queue" },
          intervalMs: 30000,
          targets: { itemsFromPath: "$.results[]", itemTemplate: { label: "{{name}}" } },
        },
      },
    },
    provenance: {
      seedGroup: "master_plan_t_table",
      sources: [
        { doc: "docs/superpowers/plans/2026-07-04-liveui-master-plan.md", anchor: "Part 2 B6 variable-list array mapping" },
        { doc: "docs/design/liveui-research/contract/GATE-F3-KINDS-LICENSE.md", anchor: "B6 is recipe behavior on existing list kinds" },
      ],
    },
    codeAnchors: [
      "extensions/ocuclaw/src/tools/glasses-ui-array-mapping.ts — validateItemsFromPath / mapArrayItems",
      "extensions/ocuclaw/src/tools/glasses-ui-cron.ts — substituteIntoTargets",
    ],
    relatedTo: ["mapped_detail_list@1", "choose_one@1"],
    openQuestions: [],
  },
  {
    name: "mapped_detail_list",
    version: 1,
    status: "shipped",
    lane: "registry_entry_only",
    disposition: "active",
    renderableToday: true,
    dependencies: [],
    wireKind: { status: "existing", name: "list_with_details_surface" },
    wireTemplateField: null,
    intent: "Replace a detail list from a changing recipe-output array.",
    summary:
      "B6 variable-array mapping on the existing list_with_details_surface. One itemsFromPath ending in [] is mapped through one closed {label, body?} template. Source order is preserved; the result is clamped to 20 rows and 6144 UTF-8 bytes. There is no implicit pagination or load-more turn.",
    fieldSet: {
      closed: true,
      fields: [
        { name: "kind", type: "string", requirement: "required", limit: 'const "list_with_details_surface"', note: "no new wire kind" },
        { name: "items", type: "{label, body?}[]", requirement: "required", limit: "1-20 seed rows", note: "last good rows remain on mapping failure" },
        { name: "refresh.targets.itemsFromPath", type: "string", requirement: "required", limit: "bounded path ending in []", note: "source order preserved" },
        { name: "refresh.targets.itemTemplate.label", type: "string", requirement: "required", limit: "emitted label <=64 chars", note: "paths are relative to one source element" },
        { name: "refresh.targets.itemTemplate.body", type: "string", requirement: "optional", limit: "emitted body <=200 chars", note: "all emitted rows together <=6144 UTF-8 bytes" },
      ],
    },
    layoutBudgets: {
      measured: false,
      source: "GLASSES_UI_LIMITS + B6 UTF-8 payload contract",
      budgets: { maxItems: 20, labelMaxChars: 64, detailBodyMaxChars: 200, maxUtf8Bytes: 6144 },
    },
    lifecycle: {
      move: "replace",
      timeoutMs: null,
      staleAfterMs: null,
      refresh: { replacement: "deterministic", pagination: "unsupported" },
      outcomePolicy: "A refresh replaces the whole bounded row set. Detail browsing stays local; selection is the explicit turn.",
    },
    consent: {
      actuatesOnExpiry: false,
      actuatesOnTick: false,
      requiresStaleAfterMs: false,
      policy: "explicit_turn_only",
      assertion: "Ticks only repaint data. Detail browsing is local and only selection is an answer. Silence is never consent.",
    },
    example: {
      synthetic: true,
      renderableToday: true,
      note: "Synthetic build rows over a placeholder public data host.",
      spec: {
        kind: "list_with_details_surface",
        title: "Builds",
        items: [{ label: "Loading", body: "Waiting for the first refresh" }],
        refresh: {
          recipe: { kind: "http", url: "https://api.example.com/builds" },
          intervalMs: 30000,
          targets: {
            itemsFromPath: "$.results[]",
            itemTemplate: { label: "{{name}}", body: "{{status}}" },
          },
        },
      },
    },
    provenance: {
      seedGroup: "master_plan_t_table",
      sources: [
        { doc: "docs/superpowers/plans/2026-07-04-liveui-master-plan.md", anchor: "Part 2 B6 variable-list array mapping" },
        { doc: "docs/design/liveui-research/contract/GATE-F3-KINDS-LICENSE.md", anchor: "B6 is recipe behavior on existing list kinds" },
      ],
    },
    codeAnchors: [
      "extensions/ocuclaw/src/tools/glasses-ui-array-mapping.ts — validateItemsFromPath / mapArrayItems",
      "extensions/ocuclaw/src/tools/glasses-ui-cron.ts — substituteIntoTargets",
    ],
    relatedTo: ["mapped_list@1", "compare_options@1"],
    openQuestions: [],
  },
  {
    name: "live_metric_card",
    version: 1,
    status: "specified",
    lane: "registry_entry_only",
    disposition: "active",
    renderableToday: true,
    dependencies: [],
    wireKind: { status: "existing", name: "text_surface" },
    wireTemplateField: null,
    intent: "Keep one number in front of the wearer while it changes, with the agent idle.",
    summary:
      "A deterministic recipe ticks the body; zero tokens per tick. Numbers lead the line ('47% CPU', not 'CPU is at 47%'). Fire-and-forget: no timeout, terminal via the recipe's maxDuration.",
    fieldSet: {
      closed: true,
      fields: [
        { name: "kind", type: "string", requirement: "required", limit: 'const "text_surface"', note: "" },
        { name: "title", type: "string", requirement: "optional", limit: "<=64 chars", note: "" },
        { name: "body", type: "string", requirement: "required", limit: "<=1000 chars", note: "numbers first" },
        { name: "refresh", type: "object", requirement: "required", limit: "system-stats or http tier; 2000-30000 ms", note: "onFailure keep_last" },
      ],
    },
    layoutBudgets: {
      measured: false,
      source: "master plan Part 2 §A row T3 + GLASSES_UI_LIMITS.bodyMax",
      budgets: { bodyMaxChars: 1000, recommendedRefreshIntervalMs: { min: 2000, max: 30000 } },
    },
    lifecycle: {
      move: "replace",
      timeoutMs: null,
      staleAfterMs: null,
      refresh: { tier: "system-stats|http", intervalMs: { min: 2000, max: 30000 }, onFailure: "keep_last" },
      outcomePolicy: "Terminal via the recipe's maxDuration; exits on user chat. Fire-and-forget — omit timeoutMs.",
    },
    consent: {
      actuatesOnExpiry: false,
      actuatesOnTick: false,
      requiresStaleAfterMs: false,
      policy: "read_only_display",
      assertion:
        "Display-only. A tick is a repaint, never an action and never a completion claim. Never show a green check merely because the schedule fired. Silence is never consent.",
    },
    example: {
      synthetic: true,
      renderableToday: true,
      note: "Synthetic host metrics via the local system-stats tier.",
      spec: {
        kind: "text_surface",
        title: "Build box",
        body: "{{cpuPercent}}% CPU / {{memPercent}}% mem",
        refresh: { kind: "system-stats", intervalMs: 5000, onFailure: "keep_last", targets: { body: "{{cpuPercent}}% CPU / {{memPercent}}% mem" } },
      },
    },
    provenance: {
      seedGroup: "master_plan_t_table",
      sources: [{ doc: "docs/superpowers/plans/2026-07-04-liveui-master-plan.md", anchor: "Part 2 §A template table, row T3" }],
    },
    codeAnchors: ["extensions/ocuclaw/src/tools/glasses-ui-limits.ts — bodyMax"],
    relatedTo: ["ambient_status@1", "threshold_watch@1", "progress_watch@2"],
    openQuestions: [],
  },
  {
    name: "drilldown_parent_child",
    version: 1,
    status: "specified",
    lane: "registry_entry_only",
    disposition: "active",
    renderableToday: true,
    dependencies: [],
    wireKind: { status: "existing", name: "list_surface" },
    wireTemplateField: null,
    intent: "A list whose rows open a deeper surface the wearer can back out of.",
    summary:
      "Parent list pushes a text or list child. Back restores the parent and resumes its cron. The hard rule: NEVER `replace` at depth >= 2 — replacing under a pushed child destroys the back stack the wearer is relying on.",
    fieldSet: {
      closed: true,
      fields: [
        { name: "kind", type: "string", requirement: "required", limit: 'const "list_surface" (parent)', note: "child may be text_surface or list_surface" },
        { name: "title", type: "string", requirement: "optional", limit: "<=64 chars", note: "" },
        { name: "items", type: "string[]", requirement: "required", limit: "1-20 items, <=64 chars each", note: "" },
        { name: "update", type: "string", requirement: "required", limit: 'const "push" for the child render', note: "never \"replace\" at depth >= 2" },
      ],
    },
    layoutBudgets: {
      measured: false,
      source: "master plan Part 2 §A row T4",
      budgets: { maxItems: 20, itemMaxChars: 64, maxSafeDepthForReplace: 1 },
    },
    lifecycle: {
      move: "push",
      timeoutMs: 300000,
      staleAfterMs: null,
      refresh: { tier: "child may own its own recipe", intervalMs: null, onFailure: "keep_last" },
      outcomePolicy: "back -> parent auto-restores and its cron resumes; NEVER replace at depth >= 2.",
    },
    consent: {
      actuatesOnExpiry: false,
      actuatesOnTick: false,
      requiresStaleAfterMs: false,
      policy: "explicit_turn_only",
      assertion:
        "Navigation is local movement. Only an explicit selection at any depth is intent. Expiry parks the deepest intent, never resolves it. Silence is never consent.",
    },
    example: {
      synthetic: true,
      renderableToday: true,
      note: "Synthetic service list; the child render is a separate call with update:\"push\".",
      spec: {
        kind: "list_surface",
        title: "Services",
        items: ["api-gateway", "billing-worker", "notify-relay"],
      },
    },
    provenance: {
      seedGroup: "master_plan_t_table",
      sources: [{ doc: "docs/superpowers/plans/2026-07-04-liveui-master-plan.md", anchor: "Part 2 §A template table, row T4" }],
    },
    codeAnchors: [],
    relatedTo: [],
    openQuestions: [],
  },
  {
    name: "drilldown_parent_child",
    version: 2,
    status: "specified",
    lane: "registry_entry_only",
    disposition: "active",
    renderableToday: true,
    dependencies: [],
    wireKind: { status: "existing", name: "list_surface" },
    wireTemplateField: null,
    intent: "Read full release notes from a short list of rows, opening known details locally and returning with Back.",
    summary: "One parent render carries ready text children; tapping a row pushes its child locally without an agent round trip. Use for reading known details on short lists, not selection questions or details needing fresh data or a tool call. Use @1 for an agent-pushed child.",
    fieldSet: {
      closed: true,
      fields: [
        { name: "kind", type: "string", requirement: "required", limit: 'const "list_surface"', note: "parent" },
        { name: "title", type: "string", requirement: "optional", limit: "<=64 chars", note: "must fit one line" },
        { name: "items", type: "string[]", requirement: "required", limit: "1-8 rows recommended", note: "leave room for the automatic child cue" },
        { name: "children", type: "array", requirement: "required", limit: "parallel to items; null | text_surface | paged_text_surface; <=3 pages per child; <=8192 total child payload chars", note: "null rows retain selection behavior; children cannot refresh or contain lists" },
        { name: "update", type: "string", requirement: "optional", limit: "replace | patch | push", note: "parent move follows current stack; first render replace, same parent patch; local child opening needs no second render" },
      ],
    },
    layoutBudgets: {
      measured: false,
      source: "Preloaded Child Surface limits and teaching policy (#2535)",
      budgets: { recommendedMaxRows: 8, maxChildPages: 3, totalChildPayloadMax: 8192 },
    },
    lifecycle: {
      move: "replace",
      timeoutMs: 300000,
      staleAfterMs: null,
      refresh: { tier: "none", intervalMs: null, onFailure: "keep_last" },
      outcomePolicy: "Tap opens locally; Back restores the parent without an agent turn. Opening is not selection or consent.",
    },
    consent: {
      actuatesOnExpiry: false,
      actuatesOnTick: false,
      requiresStaleAfterMs: false,
      policy: "explicit_turn_only",
      assertion: "Reading a child is navigation, never an answer or authorization. Silence is never consent.",
    },
    example: {
      synthetic: true,
      renderableToday: true,
      note: "Known release notes shipped once; the client owns tap and Back.",
      spec: {
        kind: "list_surface",
        title: "Release notes",
        items: ["Faster opening", "Clearer navigation"],
        children: [
          { kind: "text_surface", title: "Faster opening", body: "Ready details open as soon as you tap the row." },
          { kind: "paged_text_surface", title: "Clearer navigation", pages: ["A cue marks rows with ready details.", "Back returns to the list so you can keep reading."] },
        ],
      },
    },
    provenance: { seedGroup: "master_plan_t_table", sources: [{ doc: "https://github.com/OcuClawhub/evenclaw/issues/2535", anchor: "Scope: teaching, registry, eval" }] },
    codeAnchors: ["extensions/ocuclaw/src/tools/glasses-ui-descriptors.ts — GLASSES_UI_CHILDREN_SCHEMA"],
    relatedTo: ["drilldown_parent_child@1"],
    openQuestions: [],
  },
  {
    name: "quick_check",
    version: 1,
    status: "specified",
    lane: "registry_entry_only",
    disposition: "active",
    renderableToday: true,
    dependencies: [],
    wireKind: { status: "existing", name: "list_surface" },
    wireTemplateField: null,
    intent:
      "A casual agent ask — \"you okay with X?\" — where nothing consequential fires on either answer. The tap is the wearer's ANSWER, never an authorization.",
    summary:
      "T5's shape, re-scoped by the owner ruling of 2026-08-19 (#1415): the staleness guard survives, the decision surface does not. The card asks one light question and hands the wearer's reply back to the agent as a single conversational turn. Nothing destructive, chargeable, irreversible, or security-sensitive may hang on that reply — agent-host confirmation and permission prompts are separate things that never route through LiveUI (#1417 B5 lock, unchanged). The guard is the whole point of the row: an answer to a question the wearer read ten minutes ago is not an answer to the question being asked now, so a stale tap re-asks.",
    fieldSet: {
      closed: true,
      fields: [
        { name: "kind", type: "string", requirement: "required", limit: 'const "list_surface"', note: "" },
        { name: "title", type: "string", requirement: "optional", limit: "<=64 chars", note: "the question itself, stated plainly" },
        { name: "items", type: "string[]", requirement: "required", limit: "2-4 answer rows, <=64 chars each", note: "answers only — a row that reads as authorizing an action belongs on a different surface entirely" },
        { name: "staleAfterMs", type: "integer", requirement: "required", limit: "~120000", note: "the guard is the whole point of the row; a stale tap re-asks" },
      ],
    },
    layoutBudgets: {
      measured: false,
      source: "master plan Part 2 §A row T5, re-scoped by the 2026-08-19 owner ruling on #1415",
      budgets: { maxItems: 20, itemMaxChars: 64 },
    },
    lifecycle: {
      move: "replace",
      timeoutMs: { min: 120000, max: 300000 },
      staleAfterMs: 120000,
      refresh: null,
      outcomePolicy:
        "A tap is the wearer's answer and returns to the agent as one conversational turn. stale:true -> re-ask, NEVER resolve. Expiry resolves nothing: the question parks unanswered and the agent may raise it again in chat.",
    },
    consent: {
      actuatesOnExpiry: false,
      actuatesOnTick: false,
      requiresStaleAfterMs: true,
      policy: "stale_guarded_reconfirm",
      assertion:
        "A tap is an ANSWER, never an authorization. A stale tap re-asks and never executes. Expiry decides nothing — it parks the question, and silence is never consent. Consequential, destructive, chargeable, irreversible, and security-sensitive decisions never live on this surface: agent-host confirmation and permission prompts stay out of LiveUI forever (#1417 B5 lock, upheld by the 2026-08-19 owner ruling).",
    },
    example: {
      synthetic: true,
      renderableToday: true,
      note: "Synthetic. Renaming an invented playlist changes nothing outside the wearer's own library and is trivially undone — which is the ceiling of what this template may ask about.",
      spec: {
        kind: "list_surface",
        title: "Rename the playlist to 'Focus Mix'?",
        items: ["Yes", "No", "Tell me more"],
        staleAfterMs: 120000,
      },
    },
    provenance: {
      seedGroup: "master_plan_t_table",
      sources: [
        { doc: "docs/superpowers/plans/2026-07-04-liveui-master-plan.md", anchor: "Part 2 §A template table, row T5" },
        { doc: "docs/superpowers/plans/2026-07-04-liveui-master-plan.md", anchor: "Part 2 §B5 — SUPERSEDED 2026-08-19 (#1417), B5 is OUT unconditionally" },
        {
          doc: "https://github.com/ocuclawhub/evenclaw/issues/1415",
          anchor:
            "Owner ruling (Matty, 2026-08-19) — T5 and the approval taxonomy; re-scoped approval_with_stale_guard@1 → quick_check@1",
        },
      ],
    },
    codeAnchors: [],
    relatedTo: ["deadline_with_safe_default@1", "safe_deadline@1"],
    openQuestions: [],
  },
  {
    name: "ambient_status",
    version: 1,
    status: "specified",
    lane: "registry_entry_only",
    disposition: "active",
    renderableToday: true,
    dependencies: [],
    wireKind: { status: "existing", name: "text_surface" },
    wireTemplateField: null,
    intent: "A background fact the wearer glances at now and then; being absent for it is normal.",
    summary:
      "Short timeout on purpose — parking is the expected outcome, not a failure. A slow recipe keeps the body current; a tap wakes the agent for exactly one turn. Ends the turn cheaply.",
    fieldSet: {
      closed: true,
      fields: [
        { name: "kind", type: "string", requirement: "required", limit: 'const "text_surface"', note: "" },
        { name: "title", type: "string", requirement: "optional", limit: "<=64 chars", note: "" },
        { name: "body", type: "string", requirement: "required", limit: "<=1000 chars", note: "" },
        { name: "refresh", type: "object", requirement: "optional", limit: "slow recipe", note: "onFailure keep_last" },
        { name: "timeoutMs", type: "integer", requirement: "optional", limit: "~60000", note: "short; park expected" },
      ],
    },
    layoutBudgets: {
      measured: false,
      source: "master plan Part 2 §A row T6",
      budgets: { bodyMaxChars: 1000 },
    },
    lifecycle: {
      move: "replace",
      timeoutMs: 60000,
      staleAfterMs: null,
      refresh: { tier: "http|system-stats (slow)", intervalMs: null, onFailure: "keep_last" },
      outcomePolicy: "expired = normal, not a failure; taps wake exactly one turn; end the turn cheaply.",
    },
    consent: {
      actuatesOnExpiry: false,
      actuatesOnTick: false,
      requiresStaleAfterMs: false,
      policy: "read_only_display",
      assertion:
        "Display-only, and expiry here is the DESIGNED outcome — which makes it doubly true that expiry decides nothing. Silence is never consent.",
    },
    example: {
      synthetic: true,
      renderableToday: true,
      note: "Synthetic office sensor reading.",
      spec: { kind: "text_surface", title: "Study", body: "21.4 C / 43% humidity", timeoutMs: 60000 },
    },
    provenance: {
      seedGroup: "master_plan_t_table",
      sources: [{ doc: "docs/superpowers/plans/2026-07-04-liveui-master-plan.md", anchor: "Part 2 §A template table, row T6" }],
    },
    codeAnchors: ["extensions/ocuclaw/src/tools/glasses-ui-limits.ts — bodyMax"],
    relatedTo: ["live_metric_card@1", "weather_commute@1"],
    openQuestions: [],
  },
  {
    name: "deadline_with_safe_default",
    version: 1,
    status: "specified",
    lane: "registry_entry_only",
    disposition: "active",
    renderableToday: true,
    dependencies: [],
    wireKind: { status: "existing", name: "text_surface" },
    wireTemplateField: null,
    intent: "Something happens at a stated time unless the wearer says otherwise — and the default must be safe.",
    summary:
      "T7, and the single most consent-sensitive template in the registry. The copy states BOTH the deadline and what happens by default. Expiry may apply that default ONLY when it is reversible and non-actuating. A consequential default is not allowed: it cancels, or it demands explicit re-confirmation. No fake countdown chrome — the HUD does not tick a timer at the wearer to create urgency. RECONCILED 2026-08-19 (#542): this is the CANONICAL name. `safe_deadline@1` is the research corpus's shorter spelling of this same template — same wire kind, same consent policy, same intent, and the corpus attaches no field set that could differ — so teaching names this entry and cites `safe_deadline@1` only as an alias.",
    fieldSet: {
      closed: true,
      fields: [
        { name: "kind", type: "string", requirement: "required", limit: 'const "text_surface"', note: "" },
        { name: "title", type: "string", requirement: "optional", limit: "<=64 chars", note: "" },
        { name: "body", type: "string", requirement: "required", limit: "<=1000 chars", note: "MUST state the deadline AND the default in words" },
        { name: "timeoutMs", type: "integer", requirement: "required", limit: "= the deadline, <=600000", note: "the timeout IS the deadline; they may not disagree" },
      ],
    },
    layoutBudgets: {
      measured: false,
      source: "master plan Part 2 §A row T7",
      budgets: { bodyMaxChars: 1000, maxDeadlineMs: 600000 },
    },
    lifecycle: {
      move: "replace",
      timeoutMs: { min: 1000, max: 600000 },
      staleAfterMs: null,
      refresh: null,
      outcomePolicy:
        "Copy states deadline + default. Expiry applies the default ONLY if it is reversible and non-actuating; a consequential action on expiry is cancelled or requires explicit re-confirmation. NO fake countdown chrome.",
    },
    consent: {
      actuatesOnExpiry: false,
      actuatesOnTick: false,
      requiresStaleAfterMs: false,
      policy: "deadline_with_safe_default",
      assertion:
        "Expiry NEVER actuates. The only thing a closed window may do is fall back to a state that is reversible and has no external effect — which is not an action, it is the absence of one. Anything consequential cancels or re-confirms. Silence is never consent.",
      lintHint:
        "An entry or spec claiming this policy while its stated default has an external, irreversible, or chargeable effect is an error-grade finding, not a warning.",
    },
    example: {
      synthetic: true,
      renderableToday: true,
      note: "Synthetic. The default here is 'stay muted', which changes nothing outside the glasses and is trivially reversible.",
      spec: {
        kind: "text_surface",
        title: "Focus block",
        body: "Focus mode ends at 15:00. If you do nothing, notifications stay muted until then. Tap to unmute now.",
        timeoutMs: 600000,
      },
    },
    provenance: {
      seedGroup: "master_plan_t_table",
      sources: [
        { doc: "docs/superpowers/plans/2026-07-04-liveui-master-plan.md", anchor: "Part 2 §A template table, row T7" },
        { doc: "issue #1423", anchor: "ticket instruction — T7 is `deadline_with_safe_default`; actuatesOnExpiry false unless a ruling says otherwise" },
      ],
    },
    codeAnchors: ["extensions/ocuclaw/src/tools/glasses-ui-limits.ts — bodyMax"],
    relatedTo: ["safe_deadline@1", "quick_check@1"],
    openQuestions: [],
  },
  {
    name: "progress_monitor",
    version: 1,
    status: "specified",
    lane: "registry_entry_only",
    disposition: "active",
    renderableToday: true,
    dependencies: [],
    wireKind: { status: "existing", name: "text_surface" },
    wireTemplateField: null,
    intent: "Show a long job advancing while the agent works, without the wearer opening chat.",
    summary:
      "The cheapest big win in the plan: during a long multi-tool turn the agent calls render with update:'patch' between its own steps. Zero recipes, zero config. Ends with a final patch plus a one-line close in chat. RECONCILED 2026-08-19 (#542) and RULED 2026-08-19 (#1415, applied by #1455): this is the taught and the only renderable progress template. The owner ruled the sharpened question NO — a progress template may never start an agent turn without a wearer gesture — so `progress_watch@2` is an ALIAS of this entry (the corpus spelling), no longer a rival: render this template, cite that name only as the spelling.",
    fieldSet: {
      closed: true,
      fields: [
        { name: "kind", type: "string", requirement: "required", limit: 'const "text_surface"', note: "" },
        { name: "title", type: "string", requirement: "optional", limit: "<=64 chars", note: "" },
        { name: "body", type: "string", requirement: "required", limit: "<=1000 chars", note: "one line per phase, current phase last" },
        { name: "update", type: "string", requirement: "required", limit: 'const "patch" after the first render', note: "" },
        { name: "refresh", type: "object", requirement: "optional", limit: "recipe OR agent self-patch, not both", note: "" },
      ],
    },
    layoutBudgets: {
      measured: false,
      source: "master plan Part 2 §A row T8 + §C1",
      budgets: { bodyMaxChars: 1000 },
    },
    lifecycle: {
      move: "patch",
      timeoutMs: null,
      staleAfterMs: null,
      refresh: { tier: "optional recipe, or agent self-patch per step", intervalMs: null, onFailure: "keep_last" },
      outcomePolicy: "done -> one final patch + a one-line close in chat. Timeout is per phase, not global.",
    },
    consent: {
      actuatesOnExpiry: false,
      actuatesOnTick: false,
      requiresStaleAfterMs: false,
      policy: "read_only_display",
      assertion:
        "Display-only progress. A patch is a repaint and proves nothing about the wearer having seen it — the delivery ladder tops out at 'attempted' here. Never render a completion check the underlying job has not actually reported. Silence is never consent.",
    },
    example: {
      synthetic: true,
      renderableToday: true,
      note: "Synthetic deploy phases.",
      spec: { kind: "text_surface", title: "Deploy", body: "Cloned OK\nBuilt OK\nTests 12/40..." },
    },
    provenance: {
      seedGroup: "master_plan_t_table",
      sources: [
        { doc: "docs/superpowers/plans/2026-07-04-liveui-master-plan.md", anchor: "Part 2 §A template table, row T8" },
        { doc: "docs/superpowers/plans/2026-07-04-liveui-master-plan.md", anchor: "Part 2 §C1 — agent-patched progress, available NOW" },
      ],
    },
    codeAnchors: ["extensions/ocuclaw/src/tools/glasses-ui-limits.ts — bodyMax"],
    relatedTo: ["progress_watch@2", "threshold_watch@1"],
    openQuestions: [],
  },
  {
    name: "error_repair",
    version: 1,
    status: "specified",
    lane: "registry_entry_only",
    disposition: "active",
    renderableToday: true,
    dependencies: [],
    wireKind: { status: "existing", name: "text_surface" },
    wireTemplateField: null,
    intent: "A recipe failed; the agent fixes it and retries once without dumping a stack trace on the wearer's face.",
    summary:
      "Not really a layout — a repair discipline expressed as a template. Read failureReason, correct the spec, patch, retry exactly ONCE. The wearer never sees the raw error; show_error already prefixes its own warning glyph.",
    fieldSet: {
      closed: true,
      fields: [
        { name: "kind", type: "string", requirement: "optional", limit: "any shipping kind — it patches whatever surface failed", note: "" },
        { name: "body", type: "string", requirement: "optional", limit: "<=1000 chars", note: "wearer-facing plain language only" },
        { name: "update", type: "string", requirement: "required", limit: 'const "patch"', note: "" },
      ],
    },
    layoutBudgets: { measured: false, source: "master plan Part 2 §A row T9", budgets: { bodyMaxChars: 1000, maxRetries: 1 } },
    lifecycle: {
      move: "patch",
      timeoutMs: null,
      staleAfterMs: null,
      refresh: null,
      outcomePolicy: "recipe_failed -> read failureReason, fix, ONE retry; never show a raw error to the wearer.",
    },
    consent: {
      actuatesOnExpiry: false,
      actuatesOnTick: false,
      requiresStaleAfterMs: false,
      policy: "read_only_display",
      assertion:
        "Display-only. A retry repaints; it never re-fires a wearer's action. Silence is never consent.",
    },
    example: {
      synthetic: true,
      renderableToday: true,
      note: "Synthetic recovery copy after a fictional feed timed out.",
      spec: { kind: "text_surface", title: "Build box", body: "Feed unavailable - retrying once" },
    },
    provenance: {
      seedGroup: "master_plan_t_table",
      sources: [{ doc: "docs/superpowers/plans/2026-07-04-liveui-master-plan.md", anchor: "Part 2 §A template table, row T9" }],
    },
    codeAnchors: [],
    relatedTo: [],
    openQuestions: [
      "T9 has no layout of its own — it is an outcome policy wearing a template's clothes. Flagged for the coordinator: keep as a registry entry, or move to SKILL.md teaching?",
    ],
  },
  {
    name: "collect_votes",
    version: 1,
    status: "specified",
    lane: "registry_entry_only",
    disposition: "active",
    renderableToday: false,
    dependencies: ["WP9 — `queueMode: \"log\"` is not exposed on the tool at HEAD"],
    wireKind: { status: "existing", name: "list_surface" },
    wireTemplateField: null,
    intent: "Collect several taps over time instead of resolving on the first one.",
    summary:
      "A list in log queue mode: each tap is appended rather than closing the surface, and the agent tallies on delivery. Rides an existing wire kind, so it is registry-entry-only — but it needs WP9 to expose queueMode before it can render.",
    fieldSet: {
      closed: true,
      fields: [
        { name: "kind", type: "string", requirement: "required", limit: 'const "list_surface"', note: "" },
        { name: "title", type: "string", requirement: "optional", limit: "<=64 chars", note: "" },
        { name: "items", type: "string[]", requirement: "required", limit: "1-20 items, <=64 chars each", note: "" },
        { name: "queueMode", type: "string", requirement: "required", limit: 'const "log"', note: "NOT exposed at HEAD — WP9" },
      ],
    },
    layoutBudgets: {
      measured: false,
      source: "master plan Part 2 §A row T10",
      budgets: { maxItems: 20, itemMaxChars: 64, maxQueuedEvents: 32 },
    },
    lifecycle: {
      move: "patch",
      timeoutMs: 60000,
      staleAfterMs: null,
      refresh: null,
      outcomePolicy: "log-mode delivery -> tally. Chain at most 2 windows of 60000 ms. Teach the 32-event cap.",
    },
    consent: {
      actuatesOnExpiry: false,
      actuatesOnTick: false,
      requiresStaleAfterMs: false,
      policy: "local_commit_only",
      assertion:
        "Each tap is one recorded vote and nothing more; the tally is not an instruction to act. A window closing tallies what was actually tapped and invents no abstentions. Silence is never consent.",
    },
    example: {
      synthetic: true,
      renderableToday: false,
      note: "Illustrative — queueMode is not on the wire at HEAD.",
      spec: { kind: "list_surface", title: "Lunch vote", items: ["Burrito", "Ramen", "Salad"], queueMode: "log" },
    },
    provenance: {
      seedGroup: "master_plan_t_table",
      sources: [
        { doc: "docs/superpowers/plans/2026-07-04-liveui-master-plan.md", anchor: "Part 2 §A template table, row T10" },
        { doc: "docs/superpowers/plans/2026-07-04-liveui-master-plan.md", anchor: "Part 1 WP9 — expose queueMode:'log'" },
      ],
    },
    codeAnchors: [],
    relatedTo: ["checklist_routine@1"],
    openQuestions: [],
  },

  {
    name: "paged_briefing",
    version: 1,
    status: "shipped",
    lane: "registry_entry_only",
    disposition: "active",
    renderableToday: true,
    dependencies: [],
    wireKind: { status: "existing", name: "paged_text_surface" },
    wireTemplateField: null,
    intent: "Hand the wearer a short document they can page through on the HUD.",
    summary:
      "Named and versioned in the corpus as `paged_briefing@1`: a complete bounded document, local paging, an explicit current-page tap, and safe expiry. `walking_brief@1` is the prototype use-case name for the same shipping shape. #550 made the shared paged_text_surface contract renderable on both hosts.",
    fieldSet: {
      closed: true,
      fields: [
        { name: "kind", type: "string", requirement: "required", limit: 'const "paged_text_surface"', note: "" },
        { name: "title", type: "string", requirement: "optional", limit: "<=64 chars", note: "page dots ride the title band ('2/5')" },
        { name: "pages", type: "string[]", requirement: "required", limit: "1-10 pages, <=600 chars each", note: "" },
      ],
    },
    layoutBudgets: {
      measured: true,
      source: "paged_text_surface descriptor and DynamicUiScreen full-page renderer",
      budgets: { maxPages: 10, pageMaxChars: 600, localUpgradeCountPerFlip: 1 },
    },
    lifecycle: {
      move: "replace",
      timeoutMs: null,
      staleAfterMs: null,
      refresh: null,
      outcomePolicy: "Paging is local and costs nothing. An explicit Continue is the turn. Expiry is safe: the briefing simply stops being available.",
    },
    consent: {
      actuatesOnExpiry: false,
      actuatesOnTick: false,
      requiresStaleAfterMs: false,
      policy: "explicit_turn_only",
      assertion:
        "Turning a page is not reading and is not agreement. Reaching the last page proves only that the last page was displayed. Expiry does nothing. Silence is never consent.",
    },
    example: {
      synthetic: true,
      renderableToday: true,
      note: "Synthetic findings on the shipping paged-text kind.",
      spec: {
        kind: "paged_text_surface",
        title: "Research brief",
        pages: [
          "Adoption is not parity. Ten hosts advertise the extension; capabilities still vary per host.",
          "Cost is front-loaded. The expensive decisions are contract shapes, not renderers.",
          "The scarce resource is attention, not pixels.",
        ],
      },
    },
    provenance: {
      seedGroup: "named_versioned_corpus",
      sources: [
        { doc: "docs/design/liveui-research/MCP-APPS-LIVEUI-PATTERN-RESEARCH.md", anchor: "§User-facing delta 3 — named `paged_briefing@1`" },
        { doc: "docs/design/liveui-research/liveui-experience-prototype.html", anchor: "dash-studio / control-studio — 'paged_briefing@1: three pages, local paging, explicit Continue, safe expiry'" },
        { doc: "docs/superpowers/plans/2026-07-04-liveui-master-plan.md", anchor: "Part 2 §B1 — paged_text_surface, the kind it would ride" },
      ],
    },
    codeAnchors: [
      "extensions/ocuclaw/src/tools/glasses-ui-descriptors.ts — pagedTextSurfaceDescriptor",
      "composeApp/src/webMain/kotlin/com/akelu/ocuclaw/glasses/screens/DynamicUiKindDescriptor.kt — PagedTextSurfaceDescriptor",
      "composeApp/src/webMain/kotlin/com/akelu/ocuclaw/glasses/screens/DynamicUiScreen.kt — renderPagedText / movePage",
    ],
    relatedTo: ["walking_brief@1", "guided_procedure@1"],
    openQuestions: [],
  },
  {
    name: "progress_watch",
    version: 2,
    status: "sketch",
    lane: "registry_entry_only",
    disposition: "active",
    renderableToday: false,
    dependencies: [],
    wireKind: { status: "existing", name: "text_surface" },
    wireTemplateField: null,
    intent: "Watch something that takes a while and only speak up when it matters.",
    summary:
      "Recorded from the corpus EXACTLY as found: a name and the version `@2`. No `@1` of this template exists anywhere in the corpus, and no field set, budget, or outcome policy is given for it. Registered as a sketch so the identity is reserved and the gap is visible; nothing about its shape is invented here. RULED 2026-08-19 (#1415, applied by #1455): NO — a progress template may never start an agent turn without a wearer gesture; wake origins stay [\"gesture\"]; the display may keep updating, completion parks on the display until a wearer tap. That is the sharpened question's NO arm: with autonomy off the table there is nothing left to distinguish this from `progress_monitor@1` but the corpus spelling — reconciled as an ALIAS of `progress_monitor@1` (T8), NOT a minted `progress_monitor@2`: the corpus supplies no field set that could disagree with T8's, and a ruling supplies a posture, not a shape. The entry is kept (never deleted) so the corpus name still resolves, and it stays non-renderable on purpose: render `progress_monitor@1`, cite this name only as the corpus spelling. If a cross-turn progress template is ever actually specified, it mints `progress_monitor@2` through its own ticket.",
    fieldSet: {
      closed: false,
      fieldSetOpenReason: "UNSPECIFIED IN SOURCE. The corpus names the template and its version and stops there.",
      fields: [
        { name: "kind", type: "string", requirement: "required", limit: 'const "text_surface" (inferred from the nearest specified sibling, progress_monitor@1)', note: "inference, flagged — not stated in source" },
      ],
    },
    layoutBudgets: { measured: false, source: "none — unspecified in source", budgets: {} },
    lifecycle: {
      move: "patch",
      timeoutMs: null,
      staleAfterMs: null,
      refresh: null,
      outcomePolicy: "UNSPECIFIED IN SOURCE. RULED floor (2026-08-19, #1415): the display may keep updating; completion parks on the display until a wearer tap — never a self-started turn.",
    },
    consent: {
      actuatesOnExpiry: false,
      actuatesOnTick: false,
      requiresStaleAfterMs: false,
      policy: "read_only_display",
      assertion:
        "Display-only by ruling, no longer only by conservatism: the 2026-08-19 owner ruling (#1415) says a progress template may never start an agent turn without a wearer gesture — wake origins stay [\"gesture\"]; the display may keep updating, completion parks on the display until a wearer tap. Silence is never consent.",
    },
    example: {
      synthetic: true,
      renderableToday: false,
      note: "Illustrative placeholder. The source specifies no example; this is the minimum shape that would validate, not a claim about the template.",
      spec: { kind: "text_surface", title: "Watching", body: "No specification exists for this template yet." },
    },
    provenance: {
      seedGroup: "named_versioned_corpus",
      sources: [
        { doc: "docs/design/liveui-research/MCP-APPS-LIVEUI-PATTERN-RESEARCH.md", anchor: "§User-facing delta 3 — named `progress_watch@2`" },
        { doc: "docs/design/liveui-research/sitrep/sitrep.md", anchor: "four named versioned templates" },
        {
          doc: "https://github.com/ocuclawhub/evenclaw/issues/1415",
          anchor:
            "Owner ruling (Matty, 2026-08-19) — NO gesture-free turn start; wake origins stay [\"gesture\"]; progress_watch@2 reconciled as an alias of progress_monitor@1 (#1455)",
        },
      ],
    },
    codeAnchors: [],
    relatedTo: ["progress_monitor@1", "live_metric_card@1", "threshold_watch@1"],
    openQuestions: [],
  },
  {
    name: "safe_deadline",
    version: 1,
    status: "sketch",
    lane: "registry_entry_only",
    disposition: "active",
    renderableToday: false,
    dependencies: [],
    wireKind: { status: "existing", name: "text_surface" },
    wireTemplateField: null,
    intent: "A deadline with a default that cannot hurt anyone.",
    summary:
      "Named and versioned in the corpus as `safe_deadline@1` with no field set, budget, or policy attached. RECONCILED 2026-08-19 (#542) as an ALIAS of `deadline_with_safe_default@1` (T7), not a distinct template: same wire kind (`text_surface`), same consent policy (`deadline_with_safe_default`), same one-sentence intent, and no field set exists on this side that could disagree with T7's — there is nothing left to distinguish but the spelling. The entry is kept (never deleted) so the corpus name still resolves, and it stays non-renderable on purpose: render T7, cite this name only as the corpus spelling.",
    fieldSet: {
      closed: false,
      fieldSetOpenReason: "UNSPECIFIED IN SOURCE — only the name and version are given.",
      fields: [
        { name: "kind", type: "string", requirement: "required", limit: 'const "text_surface" (inferred from T7)', note: "inference, flagged — not stated in source" },
        { name: "body", type: "string", requirement: "required", limit: "<=1000 chars; must state deadline + default (inherited from T7)", note: "" },
      ],
    },
    layoutBudgets: { measured: false, source: "none — unspecified in source", budgets: {} },
    lifecycle: {
      move: "replace",
      timeoutMs: null,
      staleAfterMs: null,
      refresh: null,
      outcomePolicy: "UNSPECIFIED IN SOURCE. T7's policy is the assumed floor: expiry may apply only a reversible, non-actuating default.",
    },
    consent: {
      actuatesOnExpiry: false,
      actuatesOnTick: false,
      requiresStaleAfterMs: false,
      policy: "deadline_with_safe_default",
      assertion:
        "Expiry NEVER actuates, on this entry as on T7. An unspecified deadline template inherits the strictest reading of the ruling, not the most permissive. Silence is never consent.",
    },
    example: {
      synthetic: true,
      renderableToday: false,
      note: "Illustrative placeholder; the source specifies no example.",
      spec: { kind: "text_surface", title: "Reminder", body: "Nothing happens automatically. Tap to act." },
    },
    provenance: {
      seedGroup: "named_versioned_corpus",
      sources: [
        { doc: "docs/design/liveui-research/MCP-APPS-LIVEUI-PATTERN-RESEARCH.md", anchor: "§User-facing delta 3 — named `safe_deadline@1`" },
        { doc: "docs/design/liveui-research/sitrep/sitrep.md", anchor: "four named versioned templates" },
      ],
    },
    codeAnchors: [],
    relatedTo: ["deadline_with_safe_default@1"],
    openQuestions: [],
  },

  {
    name: "compare_and_choose",
    version: 1,
    status: "sketch",
    lane: "registry_entry_only",
    disposition: "active",
    renderableToday: true,
    dependencies: [],
    wireKind: { status: "existing", name: "list_with_details_surface" },
    wireTemplateField: null,
    intent: "Turn messy search results into a few stable rows the wearer can actually decide from.",
    summary:
      "Prototype moment 1 (Comparison / choice). Details stay local; asking about one row is the explicit turn. Registered as a sketch because the prototype is a concept mockup, not a specification — it declares the interaction posture and the row shape and nothing more. RECONCILED 2026-08-19 (#542) as the prototype's name for `compare_options@1` (T2): same wire kind (`list_with_details_surface`), same consent policy, same 'details are local, the ask is the turn' posture, and the mockup's 3 rows are an instance of T2's 1-20. It is NOT the same template as `choose_one@1` — that one rides `list_surface` with label-only rows and no detail bodies. The entry is kept so the prototype's name resolves; `compare_options@1` is the name teaching uses.",
    fieldSet: {
      closed: false,
      fieldSetOpenReason: "The prototype is an annotated mockup. The field set below is the shape its mockup implies on an existing kind, not a specified contract.",
      fields: [
        { name: "kind", type: "string", requirement: "required", limit: 'const "list_with_details_surface"', note: "" },
        { name: "title", type: "string", requirement: "optional", limit: "<=64 chars", note: "" },
        { name: "items", type: "{label, body?}[]", requirement: "required", limit: "3 rows in the mockup; kind allows 1-20", note: "" },
      ],
    },
    layoutBudgets: {
      measured: false,
      source: "prototype mockup (3 rows shown) + GLASSES_UI_LIMITS for the kind it rides",
      budgets: { rowsShownInMockup: 3, maxItems: 20, labelMaxChars: 64, detailBodyMaxChars: 200 },
    },
    lifecycle: {
      move: "replace",
      timeoutMs: null,
      staleAfterMs: null,
      refresh: null,
      outcomePolicy: "local detail; ask/choose is the turn.",
    },
    consent: {
      actuatesOnExpiry: false,
      actuatesOnTick: false,
      requiresStaleAfterMs: false,
      policy: "explicit_turn_only",
      assertion: "Scrolling and opening a detail are local. Only ask/choose is intent. Silence is never consent.",
    },
    example: {
      synthetic: true,
      renderableToday: true,
      note: "The prototype's own synthetic train data.",
      spec: {
        kind: "list_with_details_surface",
        title: "Trains > compare",
        items: [
          { label: "08:42 direct", body: "68 GBP" },
          { label: "09:05 one change", body: "41 GBP" },
          { label: "09:18 direct", body: "75 GBP" },
        ],
      },
    },
    provenance: {
      seedGroup: "experience_prototype_moment",
      sources: [{ doc: "docs/design/liveui-research/liveui-experience-prototype.html", anchor: "moment 1 — 'Comparison · choice / Pick between real options'" }],
    },
    codeAnchors: [],
    relatedTo: ["choose_one@1", "compare_options@1"],
    openQuestions: [],
  },
  {
    name: "threshold_watch",
    version: 1,
    status: "sketch",
    lane: "registry_entry_only",
    disposition: "active",
    renderableToday: false,
    dependencies: [
      "the `threshold` wake origin — wake origins are the closed enum [\"gesture\"] at HEAD; schedule/threshold/system are reserved (master plan §C3)",
    ],
    wireKind: { status: "existing", name: "list_with_details_surface" },
    wireTemplateField: null,
    intent: "Watch a machine and only interrupt the wearer when a declared line is crossed.",
    summary:
      "Prototype moment 2 (Live watch / threshold). Routine ticks never consume turns; only the declared threshold asks for attention. Not renderable today because the threshold wake origin does not exist — the surface half rides existing kinds, the wake half does not exist.",
    fieldSet: {
      closed: false,
      fieldSetOpenReason: "The threshold declaration has no wire representation at HEAD, so its field set cannot be closed.",
      fields: [
        { name: "kind", type: "string", requirement: "required", limit: 'const "list_with_details_surface"', note: "" },
        { name: "items", type: "{label, body?}[]", requirement: "required", limit: "1-20 rows", note: "one row per watched metric" },
        { name: "refresh", type: "object", requirement: "required", limit: "bounded recipe", note: "" },
        { name: "threshold", type: "object", requirement: "required", limit: "NO WIRE REPRESENTATION AT HEAD", note: "reserved wake origin — §C3" },
      ],
    },
    layoutBudgets: { measured: false, source: "prototype mockup (3 rows) + the kind's live limits", budgets: { rowsShownInMockup: 3, maxItems: 20 } },
    lifecycle: {
      move: "replace",
      timeoutMs: null,
      staleAfterMs: null,
      refresh: { tier: "http|system-stats", intervalMs: null, onFailure: "keep_last" },
      outcomePolicy: "Ticks update locally and cost no turns. A crossed threshold creates an INTENT for the agent; it does not itself act.",
    },
    consent: {
      actuatesOnExpiry: false,
      actuatesOnTick: false,
      requiresStaleAfterMs: false,
      policy: "read_only_display",
      assertion:
        "A tick is a repaint. A crossed threshold raises an intent for the agent to consider; it is never an action taken on the wearer's behalf, and the wearer not reacting to it is not agreement to anything. Silence is never consent.",
      lintHint: "A threshold that directly triggers an external effect rather than an agent turn is an error-grade finding.",
    },
    example: {
      synthetic: true,
      renderableToday: false,
      note: "The prototype's own synthetic build-box figures. Illustrative — no threshold field exists on the wire.",
      spec: {
        kind: "list_with_details_surface",
        title: "Build box > live",
        items: [
          { label: "tests", body: "814 / 1200" },
          { label: "memory", body: "72%" },
        ],
      },
    },
    provenance: {
      seedGroup: "experience_prototype_moment",
      sources: [
        { doc: "docs/design/liveui-research/liveui-experience-prototype.html", anchor: "moment 2 — 'Live watch · threshold / Keep watch without keeping chat open'" },
        { doc: "docs/superpowers/plans/2026-07-04-liveui-master-plan.md", anchor: "Part 2 §C3 — threshold wake, reserved origin" },
      ],
    },
    codeAnchors: ["extensions/ocuclaw/src/tools/glasses-ui-wake.ts — wake origins closed enum [\"gesture\"]"],
    relatedTo: ["live_metric_card@1", "progress_watch@2"],
    openQuestions: [],
  },
  {
    name: "guided_procedure",
    version: 1,
    status: "sketch",
    lane: "registry_entry_only",
    disposition: "active",
    renderableToday: true,
    dependencies: [],
    wireKind: { status: "existing", name: "paged_text_surface" },
    wireTemplateField: null,
    intent: "Carry the next step of a hands-busy procedure in front of the wearer.",
    summary:
      "Prototype moment 3 (Guided work / stepper). Page movement is local; 'ask why' or 'this did not happen' returns the exact step to the agent as context plus intent. Differs from paged_briefing in that the active step is meaningful state, not just a scroll position.",
    fieldSet: {
      closed: true,
      fields: [
        { name: "kind", type: "string", requirement: "required", limit: 'const "paged_text_surface"', note: "" },
        { name: "title", type: "string", requirement: "optional", limit: "<=64 chars", note: "carries the '2 / 5' step counter in the mockup" },
        { name: "pages", type: "string[]", requirement: "required", limit: "1-10 pages, <=600 chars each; one page per step", note: "" },
      ],
    },
    layoutBudgets: { measured: false, source: "prototype mockup (5 steps) + §B1 proposal", budgets: { stepsShownInMockup: 5, maxPages: 10, pageMaxChars: 600 } },
    lifecycle: {
      move: "replace",
      timeoutMs: null,
      staleAfterMs: null,
      refresh: null,
      outcomePolicy: "back/next are local; the active step may travel as short-lived UI context; 'ask why' is the turn.",
    },
    consent: {
      actuatesOnExpiry: false,
      actuatesOnTick: false,
      requiresStaleAfterMs: false,
      policy: "explicit_turn_only",
      assertion:
        "Advancing a step proves the step was displayed, never that it was performed. The surface must not report a procedure as completed on the strength of the wearer paging to the end. Silence is never consent.",
    },
    example: {
      synthetic: true,
      renderableToday: true,
      note: "The prototype's own synthetic router-reset copy on the shipping paged-text kind.",
      spec: {
        kind: "paged_text_surface",
        title: "Router reset",
        pages: [
          "Unplug the router. Wait 10 seconds.",
          "Hold RESET for 5 seconds. Release when the status light pulses slowly.",
          "Reconnect power and wait for a steady light.",
        ],
      },
    },
    provenance: {
      seedGroup: "experience_prototype_moment",
      sources: [{ doc: "docs/design/liveui-research/liveui-experience-prototype.html", anchor: "moment 3 — 'Guided work · stepper / Carry the next step in front of you'" }],
    },
    codeAnchors: [],
    relatedTo: ["paged_briefing@1"],
    openQuestions: [],
  },
  {
    name: "walking_brief",
    version: 1,
    status: "sketch",
    lane: "registry_entry_only",
    disposition: "active",
    renderableToday: true,
    dependencies: [],
    wireKind: { status: "existing", name: "paged_text_surface" },
    wireTemplateField: null,
    intent: "Distil a desk full of sources into the few findings the wearer needs before a meeting.",
    summary:
      "Prototype moment 4 (Research / distillation). The rich material stays in the companion; G2 gets a short native briefing, never a screenshot. RECONCILED 2026-08-19 (#542) as the same template as `paged_briefing@1`, told through a use case: identical proposed kind, identical consent policy, identical interaction posture, and no field, budget, or outcome on this side contradicts that one. The entry is kept so the prototype's name still resolves; `paged_briefing@1` is the name teaching uses.",
    fieldSet: {
      closed: true,
      fields: [
        { name: "kind", type: "string", requirement: "required", limit: 'const "paged_text_surface"', note: "" },
        { name: "pages", type: "string[]", requirement: "required", limit: "1-10 pages, <=600 chars each; 3 pages in the mockup", note: "" },
      ],
    },
    layoutBudgets: { measured: false, source: "prototype mockup (1 / 3 pages)", budgets: { pagesShownInMockup: 3 } },
    lifecycle: {
      move: "replace",
      timeoutMs: null,
      staleAfterMs: null,
      refresh: null,
      outcomePolicy: "page locally; 'ask about this finding' is the turn.",
    },
    consent: {
      actuatesOnExpiry: false,
      actuatesOnTick: false,
      requiresStaleAfterMs: false,
      policy: "explicit_turn_only",
      assertion: "Paging is not reading. Nothing here acts on the wearer's behalf. Silence is never consent.",
    },
    example: {
      synthetic: true,
      renderableToday: true,
      note: "The prototype's own synthetic research copy on the shipping paged-text kind.",
      spec: {
        kind: "paged_text_surface",
        title: "Research brief",
        pages: [
          "Adoption is not parity. Ten hosts advertise the extension; capabilities still vary by host.",
          "Cost sits in contract shapes, not renderers.",
          "Attention is the scarce resource.",
        ],
      },
    },
    provenance: {
      seedGroup: "experience_prototype_moment",
      sources: [{ doc: "docs/design/liveui-research/liveui-experience-prototype.html", anchor: "moment 4 — 'Research · distillation / Turn a desk full of sources into a walking brief'" }],
    },
    codeAnchors: [],
    relatedTo: ["paged_briefing@1", "guided_procedure@1"],
    openQuestions: [],
  },
  {
    name: "next_hour_plan",
    version: 1,
    status: "sketch",
    lane: "registry_entry_only",
    disposition: "active",
    renderableToday: true,
    dependencies: [],
    wireKind: { status: "existing", name: "list_with_details_surface" },
    wireTemplateField: null,
    intent: "Compose calendar, route, and priority into what the next hour actually looks like.",
    summary:
      "Prototype moment 5 (Daily plan / glance). Opening a travel detail is local; changing the plan is explicit. The first row is the one with a clock on it — 'leave in 12 min' — and it leads.",
    fieldSet: {
      closed: false,
      fieldSetOpenReason: "Concept mockup, not a specification.",
      fields: [
        { name: "kind", type: "string", requirement: "required", limit: 'const "list_with_details_surface"', note: "" },
        { name: "title", type: "string", requirement: "optional", limit: "<=64 chars", note: "" },
        { name: "items", type: "{label, body?}[]", requirement: "required", limit: "3 rows in the mockup", note: "" },
      ],
    },
    layoutBudgets: { measured: false, source: "prototype mockup (3 rows)", budgets: { rowsShownInMockup: 3, maxItems: 20 } },
    lifecycle: {
      move: "replace",
      timeoutMs: null,
      staleAfterMs: null,
      refresh: null,
      outcomePolicy: "open detail is local; changing the plan is the turn.",
    },
    consent: {
      actuatesOnExpiry: false,
      actuatesOnTick: false,
      requiresStaleAfterMs: false,
      policy: "explicit_turn_only",
      assertion:
        "The plan is shown, not enacted. Nothing is rescheduled, cancelled, or confirmed because a window closed. Silence is never consent.",
    },
    example: {
      synthetic: true,
      renderableToday: true,
      note: "The prototype's own synthetic schedule.",
      spec: {
        kind: "list_with_details_surface",
        title: "Next 60 minutes",
        items: [
          { label: "10:30 leave", body: "12 min walk" },
          { label: "10:45 design review", body: "Room 3" },
          { label: "11:20 call Alex", body: "10 min" },
        ],
      },
    },
    provenance: {
      seedGroup: "experience_prototype_moment",
      sources: [{ doc: "docs/design/liveui-research/liveui-experience-prototype.html", anchor: "moment 5 — 'Daily plan · glance / See what matters in the next hour'" }],
    },
    codeAnchors: [],
    relatedTo: ["morning_agenda@1", "next_meeting@1"],
    openQuestions: [],
  },
  {
    name: "message_triage",
    version: 1,
    status: "sketch",
    lane: "registry_entry_only",
    disposition: "active",
    renderableToday: true,
    dependencies: [],
    wireKind: { status: "existing", name: "list_with_details_surface" },
    wireTemplateField: null,
    intent: "Reduce a noisy inbox to the tiny set that actually needs the wearer.",
    summary:
      "Prototype moment 6 (Messages / triage). Reading a bounded summary is local; composing or delegating a reply starts a turn. The row body is a one-word reason, not the message.",
    fieldSet: {
      closed: false,
      fieldSetOpenReason: "Concept mockup, not a specification.",
      fields: [
        { name: "kind", type: "string", requirement: "required", limit: 'const "list_with_details_surface"', note: "" },
        { name: "title", type: "string", requirement: "optional", limit: "<=64 chars", note: "carries the count in the mockup ('Needs you > 3')" },
        { name: "items", type: "{label, body?}[]", requirement: "required", limit: "3 rows in the mockup", note: "body is the REASON, never the message text" },
      ],
    },
    layoutBudgets: { measured: false, source: "prototype mockup (3 rows)", budgets: { rowsShownInMockup: 3, maxItems: 20, detailBodyMaxChars: 200 } },
    lifecycle: {
      move: "replace",
      timeoutMs: null,
      staleAfterMs: null,
      refresh: null,
      outcomePolicy: "summary is local; reply/delegate is the turn.",
    },
    consent: {
      actuatesOnExpiry: false,
      actuatesOnTick: false,
      requiresStaleAfterMs: false,
      policy: "explicit_turn_only",
      assertion:
        "Nothing is marked read, replied to, archived, or dismissed because the surface expired or the wearer scrolled past it. Silence is never consent.",
      lintHint: "A message-triage surface whose expiry or timeout is wired to any mailbox mutation is an error-grade finding.",
    },
    example: {
      synthetic: true,
      renderableToday: true,
      note: "The prototype's own synthetic sender names.",
      spec: {
        kind: "list_with_details_surface",
        title: "Needs you > 3",
        items: [
          { label: "Maya", body: "decision" },
          { label: "Build bot", body: "failed" },
          { label: "Sam", body: "question" },
        ],
      },
    },
    provenance: {
      seedGroup: "experience_prototype_moment",
      sources: [{ doc: "docs/design/liveui-research/liveui-experience-prototype.html", anchor: "moment 6 — 'Messages · triage / Resolve the small queue without pulling out a phone'" }],
    },
    codeAnchors: [],
    relatedTo: ["attention_check@1"],
    openQuestions: [],
  },
  {
    name: "checklist_routine",
    version: 1,
    status: "shipped",
    lane: "registry_entry_only",
    disposition: "active",
    renderableToday: true,
    dependencies: [],
    wireKind: { status: "existing", name: "checklist_surface" },
    wireTemplateField: null,
    intent: "Work a short physical checklist with hands full and the phone in a bag.",
    summary:
      "Prototype moment 7 (Checklist / routine). Taps only change an on-device mark with zero round-trips and zero tokens. Double-tap closes with the full state; voice add/question requests are normal wearer turns. A check mark records a local mark, never proof that physical work happened.",
    fieldSet: {
      closed: true,
      fields: [
        { name: "kind", type: "string", requirement: "required", limit: 'const "checklist_surface"', note: "" },
        { name: "title", type: "string", requirement: "optional", limit: "<=64 chars", note: "" },
        { name: "items", type: "{label, checked?}[]", requirement: "required", limit: "1-20 items; label <=64 chars; checked boolean defaults false", note: "taps mutate checked only on the client" },
        { name: "queueMode", type: "string", requirement: "required", limit: 'const "log"', note: "the one close outcome carries the complete item state" },
      ],
    },
    layoutBudgets: { measured: true, source: "DynamicUiScreen checklist fake-list renderer", budgets: { visibleRowsBeforeFold: 6, maxItems: 20, labelMaxChars: 64, recommendedLabelMaxChars: 26, maxQueuedEvents: 32 } },
    lifecycle: {
      move: "patch",
      timeoutMs: null,
      staleAfterMs: null,
      refresh: null,
      outcomePolicy: "Tap toggles a local mark and emits no outcome. Double-tap closes with result back/dismissed plus every {label, checked} row; that one outcome is delivered through log mode. Voice add/question requests are separate wearer turns.",
    },
    consent: {
      actuatesOnExpiry: false,
      actuatesOnTick: false,
      requiresStaleAfterMs: false,
      policy: "local_commit_only",
      assertion:
        "Toggles are non-actuating marks on a list. An unticked box is not a refusal and an expired checklist is not a completed one. Silence is never consent.",
    },
    example: {
      synthetic: true,
      renderableToday: true,
      note: "Synthetic packing list. A checked row is only a local mark, not a claim that the physical task happened.",
      spec: {
        kind: "checklist_surface",
        title: "Demo kit",
        items: [
          { label: "G2 + case", checked: true },
          { label: "ring", checked: true },
          { label: "USB-C cable", checked: false },
          { label: "backup phone", checked: false },
        ],
        queueMode: "log",
      },
    },
    provenance: {
      seedGroup: "experience_prototype_moment",
      sources: [
        { doc: "docs/design/liveui-research/liveui-experience-prototype.html", anchor: "moment 7 — 'Checklist · routine / Keep hands and phone free'" },
        { doc: "docs/superpowers/plans/2026-07-04-liveui-master-plan.md", anchor: "Part 2 §B2 — checklist_surface" },
      ],
    },
    codeAnchors: [
      "extensions/ocuclaw/src/tools/glasses-ui-descriptors.ts — checklistSurfaceDescriptor",
      "composeApp/src/webMain/kotlin/com/akelu/ocuclaw/glasses/screens/DynamicUiKindDescriptor.kt — ChecklistSurfaceDescriptor",
      "composeApp/src/webMain/kotlin/com/akelu/ocuclaw/glasses/screens/DynamicUiScreen.kt — renderChecklist / toggleChecklistItem",
      "composeApp/src/webMain/kotlin/com/akelu/ocuclaw/connection/RelayProtocolSerializer.kt — serializeChecklistOutcome",
    ],
    relatedTo: ["collect_votes@1"],
    openQuestions: [],
  },
  {
    name: "bring_it_back",
    version: 1,
    status: "sketch",
    lane: "registry_entry_only",
    disposition: "active",
    renderableToday: true,
    dependencies: [],
    wireKind: { status: "existing", name: "text_surface" },
    wireTemplateField: null,
    intent: "Resume a useful surface from earlier — safely, with current facts.",
    summary:
      "Prototype moment 8 (Recovery / semantic memory). 'Bring It Back' re-uses safe semantic intent, checks staleness, fetches current facts, and renders AGAIN. It never restores pixels and never repeats a past decision. Arguably a lifecycle behaviour rather than a template shape — flagged.",
    fieldSet: {
      closed: false,
      fieldSetOpenReason: "This is a recall behaviour; the surface it produces takes whatever shape the fresh render needs.",
      fields: [
        { name: "kind", type: "string", requirement: "required", limit: "any shipping kind", note: "whatever the fresh render calls for" },
        { name: "staleAfterMs", type: "integer", requirement: "optional", limit: "re-armed on the fresh render", note: "stale rules are re-applied, not inherited as satisfied" },
      ],
    },
    layoutBudgets: { measured: false, source: "prototype mockup", budgets: {} },
    lifecycle: {
      move: "replace",
      timeoutMs: null,
      staleAfterMs: null,
      refresh: null,
      outcomePolicy: "Fresh semantic render from stored state with staleAfterMs re-confirm rules re-applied. Never a replay of serialized pixels and never a re-fired action.",
    },
    consent: {
      actuatesOnExpiry: false,
      actuatesOnTick: false,
      requiresStaleAfterMs: false,
      policy: "stale_guarded_reconfirm",
      assertion:
        "Recall re-renders meaning, never actions. No approval, purchase, send, or side effect from the original surface is repeated by bringing it back — the wearer's old tap is not fresh consent for a new moment. Silence is never consent.",
      lintHint: "Any recall path that re-emits the original outcome rather than re-rendering is an error-grade finding.",
    },
    example: {
      synthetic: true,
      renderableToday: true,
      note: "The prototype's own synthetic route copy.",
      spec: { kind: "text_surface", title: "Route refreshed", body: "Leave in 6 minutes. Train delayed 8 min. Use platform 4." },
    },
    provenance: {
      seedGroup: "experience_prototype_moment",
      sources: [
        { doc: "docs/design/liveui-research/liveui-experience-prototype.html", anchor: "moment 8 — 'Recovery · semantic memory / Resume a useful moment safely'" },
        { doc: "docs/design/liveui-research/MCP-APPS-INDEPENDENT-REVIEW-swift-bengio.md", anchor: "incorporation 10 — restoration is always semantic" },
      ],
    },
    codeAnchors: [],
    relatedTo: [],
    openQuestions: ["Is this a template at all, or a lifecycle behaviour that should leave the registry? Coordinator call."],
  },

  {
    name: "morning_agenda",
    version: 1,
    status: "sketch",
    lane: "registry_entry_only",
    disposition: "active",
    renderableToday: true,
    dependencies: [],
    wireKind: { status: "existing", name: "list_with_details_surface" },
    wireTemplateField: null,
    intent: "The day, once, at the start of it.",
    summary: "Routine glance card. Source is a one-line bullet in the control-center research; everything beyond the name and the routine framing is unspecified.",
    fieldSet: {
      closed: false,
      fieldSetOpenReason: "One-line bullet in source. Field set inferred from the kind it would ride.",
      fields: [
        { name: "kind", type: "string", requirement: "required", limit: 'const "list_with_details_surface"', note: "" },
        { name: "items", type: "{label, body?}[]", requirement: "required", limit: "1-20 rows", note: "" },
      ],
    },
    layoutBudgets: { measured: false, source: "none — one-line bullet", budgets: { maxItems: 20 } },
    lifecycle: { move: "replace", timeoutMs: null, staleAfterMs: null, refresh: null, outcomePolicy: "Bounded glance card, not a persistent HUD. Offline or disconnected delivery degrades honestly." },
    consent: {
      actuatesOnExpiry: false,
      actuatesOnTick: false,
      requiresStaleAfterMs: false,
      policy: "read_only_display",
      assertion: "Scheduled and display-only. A schedule firing is not consent and is not proof the wearer saw anything — never show a completion check merely because the routine ran. Silence is never consent.",
    },
    example: {
      synthetic: true,
      renderableToday: true,
      note: "Synthetic agenda.",
      spec: { kind: "list_with_details_surface", title: "Today", items: [{ label: "09:30 standup", body: "15 min" }, { label: "13:00 dentist", body: "across town" }] },
    },
    provenance: {
      seedGroup: "control_center_glance_card",
      sources: [{ doc: "docs/design/liveui-research/CONTROL-CENTER-RESEARCH.md", anchor: "§7 Routines and glance cards — 'morning agenda'" }],
    },
    codeAnchors: [],
    relatedTo: ["next_hour_plan@1"],
    openQuestions: [],
  },
  {
    name: "next_meeting",
    version: 1,
    status: "sketch",
    lane: "registry_entry_only",
    disposition: "active",
    renderableToday: true,
    dependencies: [],
    wireKind: { status: "existing", name: "text_surface" },
    wireTemplateField: null,
    intent: "What is next, and when to move.",
    summary: "Routine glance card. One-line bullet in source; nothing further is specified.",
    fieldSet: {
      closed: false,
      fieldSetOpenReason: "One-line bullet in source.",
      fields: [
        { name: "kind", type: "string", requirement: "required", limit: 'const "text_surface"', note: "" },
        { name: "body", type: "string", requirement: "required", limit: "<=1000 chars", note: "numbers first" },
      ],
    },
    layoutBudgets: { measured: false, source: "none — one-line bullet", budgets: { bodyMaxChars: 1000 } },
    lifecycle: { move: "replace", timeoutMs: null, staleAfterMs: null, refresh: null, outcomePolicy: "Bounded glance card. Degrades honestly when the glasses are absent." },
    consent: {
      actuatesOnExpiry: false,
      actuatesOnTick: false,
      requiresStaleAfterMs: false,
      policy: "read_only_display",
      assertion: "Scheduled and display-only. A schedule firing is not consent and never a completion claim. Silence is never consent.",
    },
    example: { synthetic: true, renderableToday: true, note: "Synthetic meeting.", spec: { kind: "text_surface", title: "Next", body: "13:00 design review, Room 3. Leave in 12 min." } },
    provenance: {
      seedGroup: "control_center_glance_card",
      sources: [{ doc: "docs/design/liveui-research/CONTROL-CENTER-RESEARCH.md", anchor: "§7 Routines and glance cards — 'next meeting'" }],
    },
    codeAnchors: [],
    relatedTo: ["morning_agenda@1", "next_hour_plan@1"],
    openQuestions: [],
  },
  {
    name: "weather_commute",
    version: 1,
    status: "sketch",
    lane: "registry_entry_only",
    disposition: "active",
    renderableToday: true,
    dependencies: [],
    wireKind: { status: "existing", name: "text_surface" },
    wireTemplateField: null,
    intent: "Weather and the journey, before stepping outside.",
    summary: "Routine glance card. The only glance card with a verified live data source available: the open_meteo_current@1 http recipe in the sibling field-sets artifact.",
    fieldSet: {
      closed: false,
      fieldSetOpenReason: "One-line bullet in source; the recipe side is specified in http-recipe-field-sets.json but the card layout is not.",
      fields: [
        { name: "kind", type: "string", requirement: "required", limit: 'const "text_surface"', note: "" },
        { name: "body", type: "string", requirement: "required", limit: "<=1000 chars", note: "" },
        { name: "refresh", type: "object", requirement: "optional", limit: "http tier; open_meteo_current@1 recommends 900000 ms", note: "see references/http-recipe-field-sets.json" },
      ],
    },
    layoutBudgets: { measured: false, source: "none — one-line bullet", budgets: { bodyMaxChars: 1000 } },
    lifecycle: {
      move: "replace",
      timeoutMs: null,
      staleAfterMs: null,
      refresh: { tier: "http", intervalMs: 900000, onFailure: "keep_last" },
      outcomePolicy: "Bounded glance card; ambient, expiry expected.",
    },
    consent: {
      actuatesOnExpiry: false,
      actuatesOnTick: false,
      requiresStaleAfterMs: false,
      policy: "read_only_display",
      assertion: "Display-only, exactly as the matching http recipe declares. No expiry- or tick-actuated consequence. Silence is never consent.",
    },
    example: {
      synthetic: true,
      renderableToday: true,
      note: "Synthetic reading; the template paths match open_meteo_current@1's known field set.",
      spec: {
        kind: "text_surface",
        title: "Out now",
        body: "{{temperature_2m}} C, wind {{wind_speed_10m}} km/h",
        refresh: { kind: "http", intervalMs: 900000, onFailure: "keep_last", targets: { body: "{{temperature_2m}} C, wind {{wind_speed_10m}} km/h" } },
      },
    },
    provenance: {
      seedGroup: "control_center_glance_card",
      sources: [
        { doc: "docs/design/liveui-research/CONTROL-CENTER-RESEARCH.md", anchor: "§7 Routines and glance cards — 'weather/commute'" },
        { doc: "extensions/ocuclaw/skills/glasses-ui/references/http-recipe-field-sets.json", anchor: "recipe open_meteo_current@1" },
      ],
    },
    codeAnchors: [],
    relatedTo: ["ambient_status@1"],
    openQuestions: [],
  },
  {
    name: "focus_timer",
    version: 1,
    status: "sketch",
    lane: "registry_entry_only",
    disposition: "active",
    renderableToday: true,
    dependencies: [],
    wireKind: { status: "existing", name: "text_surface" },
    wireTemplateField: null,
    intent: "A focus block, visible while it runs.",
    summary: "Routine glance card. Overlaps T7's territory the moment it acquires an end-of-block behaviour, which is why its consent posture is pinned to display-only here.",
    fieldSet: {
      closed: false,
      fieldSetOpenReason: "One-line bullet in source.",
      fields: [
        { name: "kind", type: "string", requirement: "required", limit: 'const "text_surface"', note: "" },
        { name: "body", type: "string", requirement: "required", limit: "<=1000 chars", note: "no fake countdown chrome (T7 house rule)" },
      ],
    },
    layoutBudgets: { measured: false, source: "none — one-line bullet", budgets: { bodyMaxChars: 1000 } },
    lifecycle: { move: "replace", timeoutMs: null, staleAfterMs: null, refresh: null, outcomePolicy: "Bounded glance card. If it ever gains an end-of-block action it becomes a deadline_with_safe_default surface and inherits T7's rules." },
    consent: {
      actuatesOnExpiry: false,
      actuatesOnTick: false,
      requiresStaleAfterMs: false,
      policy: "read_only_display",
      assertion: "The timer displays; it does not act. When the block ends nothing is muted, unmuted, started, or logged on the strength of the window closing. Silence is never consent.",
      lintHint: "A focus_timer surface wired to any end-of-block effect must be re-registered under deadline_with_safe_default@1 and satisfy T7's reversible-default rule.",
    },
    example: { synthetic: true, renderableToday: true, note: "Synthetic.", spec: { kind: "text_surface", title: "Focus", body: "24 min left. Notifications muted." } },
    provenance: {
      seedGroup: "control_center_glance_card",
      sources: [{ doc: "docs/design/liveui-research/CONTROL-CENTER-RESEARCH.md", anchor: "§7 Routines and glance cards — 'focus timer'" }],
    },
    codeAnchors: [],
    relatedTo: ["deadline_with_safe_default@1"],
    openQuestions: [],
  },
  {
    name: "reminder_card",
    version: 1,
    status: "sketch",
    lane: "registry_entry_only",
    disposition: "active",
    renderableToday: true,
    dependencies: [],
    wireKind: { status: "existing", name: "text_surface" },
    wireTemplateField: null,
    intent: "A scheduled nudge for a medication or a task.",
    summary:
      "Routine glance card ('medication/task reminder'). The most safety-sensitive glance card in the set: it is display-only and MUST NOT record adherence, dose, or completion on the strength of the card having been shown or having expired.",
    fieldSet: {
      closed: false,
      fieldSetOpenReason: "One-line bullet in source.",
      fields: [
        { name: "kind", type: "string", requirement: "required", limit: 'const "text_surface"', note: "" },
        { name: "body", type: "string", requirement: "required", limit: "<=1000 chars", note: "" },
      ],
    },
    layoutBudgets: { measured: false, source: "none — one-line bullet", budgets: { bodyMaxChars: 1000 } },
    lifecycle: { move: "replace", timeoutMs: null, staleAfterMs: null, refresh: null, outcomePolicy: "Bounded glance card; the wearer acts in the world, not on the surface." },
    consent: {
      actuatesOnExpiry: false,
      actuatesOnTick: false,
      requiresStaleAfterMs: false,
      policy: "read_only_display",
      assertion:
        "Display-only. Expiry does not mark a dose taken, a task done, or a reminder acknowledged, and the absence of a tap is not evidence of anything at all. Silence is never consent.",
      lintHint: "A reminder surface whose expiry writes an adherence, dose, or completion record is an error-grade finding.",
    },
    example: { synthetic: true, renderableToday: true, note: "Synthetic reminder.", spec: { kind: "text_surface", title: "Reminder", body: "Water the plants before you leave." } },
    provenance: {
      seedGroup: "control_center_glance_card",
      sources: [{ doc: "docs/design/liveui-research/CONTROL-CENTER-RESEARCH.md", anchor: "§7 Routines and glance cards — 'medication/task reminder'" }],
    },
    codeAnchors: [],
    relatedTo: [],
    openQuestions: [],
  },
  {
    name: "end_of_day_recap",
    version: 1,
    status: "sketch",
    lane: "registry_entry_only",
    disposition: "active",
    renderableToday: true,
    dependencies: [],
    wireKind: { status: "existing", name: "list_with_details_surface" },
    wireTemplateField: null,
    intent: "What happened today, once, at the end of it.",
    summary: "Routine glance card. One-line bullet in source.",
    fieldSet: {
      closed: false,
      fieldSetOpenReason: "One-line bullet in source.",
      fields: [
        { name: "kind", type: "string", requirement: "required", limit: 'const "list_with_details_surface"', note: "" },
        { name: "items", type: "{label, body?}[]", requirement: "required", limit: "1-20 rows", note: "" },
      ],
    },
    layoutBudgets: { measured: false, source: "none — one-line bullet", budgets: { maxItems: 20 } },
    lifecycle: { move: "replace", timeoutMs: null, staleAfterMs: null, refresh: null, outcomePolicy: "Bounded glance card." },
    consent: {
      actuatesOnExpiry: false,
      actuatesOnTick: false,
      requiresStaleAfterMs: false,
      policy: "read_only_display",
      assertion: "Scheduled and display-only. A recap that fired is not a recap that was read. Silence is never consent.",
    },
    example: {
      synthetic: true,
      renderableToday: true,
      note: "Synthetic recap.",
      spec: { kind: "list_with_details_surface", title: "Today", items: [{ label: "3 builds", body: "all green" }, { label: "2 parked taps", body: "collected" }] },
    },
    provenance: {
      seedGroup: "control_center_glance_card",
      sources: [{ doc: "docs/design/liveui-research/CONTROL-CENTER-RESEARCH.md", anchor: "§7 Routines and glance cards — 'end-of-day recap'" }],
    },
    codeAnchors: [],
    relatedTo: ["morning_agenda@1"],
    openQuestions: [],
  },
  {
    name: "watchlist_status",
    version: 1,
    status: "sketch",
    lane: "registry_entry_only",
    disposition: "active",
    renderableToday: true,
    dependencies: [],
    wireKind: { status: "existing", name: "list_with_details_surface" },
    wireTemplateField: null,
    intent: "Where the things you are waiting on have got to.",
    summary: "Routine glance card ('package/watch-list status'). One-line bullet in source; a bounded http recipe is the obvious data path.",
    fieldSet: {
      closed: false,
      fieldSetOpenReason: "One-line bullet in source.",
      fields: [
        { name: "kind", type: "string", requirement: "required", limit: 'const "list_with_details_surface"', note: "" },
        { name: "items", type: "{label, body?}[]", requirement: "required", limit: "1-20 rows", note: "" },
        { name: "refresh", type: "object", requirement: "optional", limit: "http tier", note: "" },
      ],
    },
    layoutBudgets: { measured: false, source: "none — one-line bullet", budgets: { maxItems: 20 } },
    lifecycle: { move: "replace", timeoutMs: null, staleAfterMs: null, refresh: { tier: "http", intervalMs: null, onFailure: "keep_last" }, outcomePolicy: "Bounded glance card." },
    consent: {
      actuatesOnExpiry: false,
      actuatesOnTick: false,
      requiresStaleAfterMs: false,
      policy: "read_only_display",
      assertion: "Display-only. A tick repaints a status; it never confirms a delivery, accepts a parcel, or closes a watch. Silence is never consent.",
    },
    example: {
      synthetic: true,
      renderableToday: true,
      note: "Synthetic parcels.",
      spec: { kind: "list_with_details_surface", title: "Watching", items: [{ label: "Parcel A1", body: "out for delivery" }, { label: "Parcel B7", body: "in transit" }] },
    },
    provenance: {
      seedGroup: "control_center_glance_card",
      sources: [{ doc: "docs/design/liveui-research/CONTROL-CENTER-RESEARCH.md", anchor: "§7 Routines and glance cards — 'package/watch-list status'" }],
    },
    codeAnchors: [],
    relatedTo: ["threshold_watch@1"],
    openQuestions: [],
  },
  {
    name: "attention_check",
    version: 1,
    status: "sketch",
    lane: "registry_entry_only",
    disposition: "active",
    renderableToday: true,
    dependencies: [],
    wireKind: { status: "existing", name: "list_with_details_surface" },
    wireTemplateField: null,
    intent: "Answer the question 'does anything need me right now?' honestly, including when the answer is no.",
    summary:
      "Routine glance card ('anything needs my attention?'). Its hardest requirement is the empty case: the card must be able to say 'nothing' without inventing filler, and must not round an unconfirmed delivery up to a handled one.",
    fieldSet: {
      closed: false,
      fieldSetOpenReason: "One-line bullet in source.",
      fields: [
        { name: "kind", type: "string", requirement: "required", limit: 'const "list_with_details_surface"', note: "text_surface is the right kind for the empty case" },
        { name: "items", type: "{label, body?}[]", requirement: "required", limit: "1-20 rows", note: "" },
      ],
    },
    layoutBudgets: { measured: false, source: "none — one-line bullet", budgets: { maxItems: 20 } },
    lifecycle: { move: "replace", timeoutMs: null, staleAfterMs: null, refresh: null, outcomePolicy: "Bounded glance card. The empty answer is a valid and expected render." },
    consent: {
      actuatesOnExpiry: false,
      actuatesOnTick: false,
      requiresStaleAfterMs: false,
      policy: "read_only_display",
      assertion:
        "Display-only. Nothing is dismissed, snoozed, or marked handled because this card expired. An item not shown is not an item resolved. Silence is never consent.",
    },
    example: {
      synthetic: true,
      renderableToday: true,
      note: "Synthetic.",
      spec: { kind: "list_with_details_surface", title: "Needs you", items: [{ label: "Build bot", body: "failed" }, { label: "Maya", body: "decision" }] },
    },
    provenance: {
      seedGroup: "control_center_glance_card",
      sources: [{ doc: "docs/design/liveui-research/CONTROL-CENTER-RESEARCH.md", anchor: "§7 Routines and glance cards — 'anything needs my attention?'" }],
    },
    codeAnchors: [],
    relatedTo: ["message_triage@1"],
    openQuestions: [],
  },
  {
    name: "scheduled_agent_prompt",
    version: 1,
    status: "sketch",
    lane: "registry_entry_only",
    disposition: "active",
    renderableToday: false,
    dependencies: [
      "the `schedule` wake origin — wake origins are the closed enum [\"gesture\"] at HEAD; schedule is reserved (master plan §C3 / §E)",
      "an Attention Contract budget the wearer can read (independent review, incorporation 9)",
    ],
    wireKind: { status: "existing", name: "text_surface" },
    wireTemplateField: null,
    intent: "Run a wearer-authored prompt on a schedule and show the answer as a card.",
    summary:
      "Routine glance card ('custom scheduled agent prompt'). The only glance card that would consume model tokens per tick, and the only one that needs a wake origin that does not exist. Registered, not renderable.",
    fieldSet: {
      closed: false,
      fieldSetOpenReason: "One-line bullet in source; the scheduling half has no wire representation at HEAD.",
      fields: [
        { name: "kind", type: "string", requirement: "required", limit: 'const "text_surface"', note: "" },
        { name: "body", type: "string", requirement: "required", limit: "<=1000 chars", note: "" },
        { name: "refresh", type: "object", requirement: "optional", limit: "llm-api tier — the expensive one; pauses first under presence gating", note: "" },
      ],
    },
    layoutBudgets: { measured: false, source: "none — one-line bullet", budgets: { bodyMaxChars: 1000 } },
    lifecycle: {
      move: "replace",
      timeoutMs: null,
      staleAfterMs: null,
      refresh: { tier: "llm-api", intervalMs: null, onFailure: "keep_last" },
      outcomePolicy: "Bounded glance card. Under presence-aware refresh gating the llm-api tier pauses first, so a card in the case burns nothing.",
    },
    consent: {
      actuatesOnExpiry: false,
      actuatesOnTick: false,
      requiresStaleAfterMs: false,
      policy: "read_only_display",
      assertion:
        "Display-only. A schedule firing is not the wearer asking, and a scheduled render must never become a scheduled ACTION — presence-resume never speaks, and a routine that ran is not a routine that was seen. Silence is never consent.",
      lintHint: "A scheduled llm-api surface that takes any action beyond painting is an error-grade finding.",
    },
    example: { synthetic: true, renderableToday: false, note: "Illustrative — the schedule wake origin does not exist.", spec: { kind: "text_surface", title: "Digest", body: "3 items changed since yesterday." } },
    provenance: {
      seedGroup: "control_center_glance_card",
      sources: [
        { doc: "docs/design/liveui-research/CONTROL-CENTER-RESEARCH.md", anchor: "§7 Routines and glance cards — 'custom scheduled agent prompt'" },
        { doc: "docs/design/liveui-research/MCP-APPS-INDEPENDENT-REVIEW-swift-bengio.md", anchor: "incorporation 6 — presence-aware refresh gating, llm-api tier pauses first" },
      ],
    },
    codeAnchors: ["extensions/ocuclaw/src/tools/glasses-ui-wake.ts — wake origins closed enum [\"gesture\"]"],
    relatedTo: [],
    openQuestions: [],
  },
];

const GLASSES_UI_TEMPLATE_REGISTRY = { entries };

function templateId(entry) {
  return `${entry.name}@${entry.version}`;
}

function listTemplateEntries() {
  return entries;
}

function listTemplateIds() {
  return entries.map(templateId);
}

function getTemplateEntry(id) {
  return entries.find((entry) => templateId(entry) === id);
}

function isRegisteredTemplateName(name) {
  return entries.some((entry) => entry.name === name);
}

function isWireKind(kind) {
  return WIRE_KIND_ENUM.includes(kind);
}

function templatesForKind(kind) {
  return entries.filter((entry) => entry.wireKind.name === kind).map(templateId);
}

function entriesBySeedGroup() {
  const counts = Object.create(null);
  for (const group of SEED_GROUPS) counts[group] = 0;
  for (const entry of entries) counts[entry.provenance.seedGroup] += 1;
  return counts;
}

function entriesByStatus() {
  const counts = Object.create(null);
  for (const status of TEMPLATE_STATUSES) counts[status] = 0;
  for (const entry of entries) counts[entry.status] += 1;
  return counts;
}

function isPlainObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isTimeout(value) {
  if (value === null || Number.isInteger(value)) return true;
  return isPlainObject(value) && Number.isInteger(value.min) && Number.isInteger(value.max) && value.min <= value.max;
}

function validateTemplateEntry(entry) {
  const errors = [];
  const at = isPlainObject(entry) && entry.name ? `${entry.name}@${entry.version}` : "<entry>";
  const fail = (message) => errors.push(`${at}: ${message}`);

  if (!isPlainObject(entry)) return { ok: false, errors: ["entry must be an object"] };

  if (typeof entry.name !== "string" || !/^[a-z][a-z0-9_]*$/.test(entry.name)) {
    fail("name must be lower_snake_case");
  }
  if (!Number.isInteger(entry.version) || entry.version < 1) fail("version must be an integer >= 1");
  if (!TEMPLATE_STATUSES.includes(entry.status)) fail(`status must be one of ${TEMPLATE_STATUSES.join(", ")}`);
  if (!TEMPLATE_LANES.includes(entry.lane)) fail(`lane must be one of ${TEMPLATE_LANES.join(", ")}`);
  if (!TEMPLATE_DISPOSITIONS.includes(entry.disposition)) fail("disposition must be active or held");
  if (entry.disposition === "held" && typeof entry.heldReason !== "string") {
    fail("a held entry must carry heldReason naming the specific blocker");
  }
  if (typeof entry.intent !== "string" || entry.intent.length === 0) fail("intent is required");
  if (typeof entry.summary !== "string" || entry.summary.length === 0) fail("summary is required");

  if (!isPlainObject(entry.wireKind)) {
    fail("wireKind is required");
  } else {
    if (!WIRE_KIND_STATUSES.includes(entry.wireKind.status)) fail("wireKind.status must be existing or proposed");
    if (typeof entry.wireKind.name !== "string") fail("wireKind.name is required");
    if (entry.wireKind.status === "existing") {
      if (!WIRE_KIND_ENUM.includes(entry.wireKind.name)) {
        fail(`wireKind.name "${entry.wireKind.name}" is not one of the shipping wire kinds`);
      }
      if (entry.lane !== "registry_entry_only") {
        fail("a template on an existing kind belongs to the registry_entry_only lane");
      }
      if (entry.wireKind.license !== undefined) fail("an existing kind must not carry a kinds license");
    } else {
      if (WIRE_KIND_ENUM.includes(entry.wireKind.name)) {
        fail(`wireKind.name "${entry.wireKind.name}" already exists; status should be "existing"`);
      }
      if (entry.lane !== "kinds_licensed") fail("a proposed wire kind belongs to the kinds_licensed lane");
      if (!isPlainObject(entry.wireKind.license) || entry.wireKind.license.gate !== "F3") {
        fail("a proposed wire kind must name its gate: license.gate === \"F3\"");
      } else if (entry.wireKind.license.granted !== false) {
        fail("no kinds license is granted; license.granted must be false");
      }
    }
  }
  if (entry.wireTemplateField !== null && !WIRE_TEMPLATE_FIELD_ENUM.includes(entry.wireTemplateField)) {
    fail("wireTemplateField must be null or a value of the live `template` enum");
  }

  if (typeof entry.renderableToday !== "boolean") fail("renderableToday is required");
  if (!Array.isArray(entry.dependencies)) fail("dependencies must be an array (empty when there are none)");
  if (entry.renderableToday === true) {
    if (entry.wireKind && entry.wireKind.status !== "existing") fail("renderableToday requires an existing wire kind");
    if (Array.isArray(entry.dependencies) && entry.dependencies.length > 0) {
      fail("renderableToday requires zero dependencies");
    }
    if (entry.disposition !== "active") fail("a held entry is never renderableToday");
  }

  if (!isPlainObject(entry.fieldSet)) {
    fail("fieldSet is required");
  } else {
    if (typeof entry.fieldSet.closed !== "boolean") fail("fieldSet.closed is required");
    if (entry.fieldSet.closed === false && typeof entry.fieldSet.fieldSetOpenReason !== "string") {
      fail("an open field set must say why (fieldSetOpenReason) — same rule as http-recipe-field-sets.json");
    }
    if (!Array.isArray(entry.fieldSet.fields) || entry.fieldSet.fields.length === 0) {
      fail("fieldSet.fields must be a non-empty array");
    } else {
      for (const field of entry.fieldSet.fields) {
        if (!isPlainObject(field) || typeof field.name !== "string") {
          fail("each field needs a name");
          continue;
        }
        if (!["required", "optional", "forbidden"].includes(field.requirement)) {
          fail(`field ${field.name}: requirement must be required/optional/forbidden`);
        }
        if (typeof field.type !== "string") fail(`field ${field.name}: type is required`);
      }
    }
  }

  if (!isPlainObject(entry.layoutBudgets)) {
    fail("layoutBudgets is required (use measured:false + an empty budgets object when unknown)");
  } else {
    if (typeof entry.layoutBudgets.measured !== "boolean") fail("layoutBudgets.measured is required");
    if (typeof entry.layoutBudgets.source !== "string") fail("layoutBudgets.source is required");
    if (!isPlainObject(entry.layoutBudgets.budgets)) fail("layoutBudgets.budgets must be an object");
    if (entry.layoutBudgets.measured === true && Object.keys(entry.layoutBudgets.budgets).length === 0) {
      fail("layoutBudgets.measured claims a measurement but carries no budgets");
    }
  }

  if (!isPlainObject(entry.lifecycle)) {
    fail("lifecycle is required");
  } else {
    if (!SURFACE_MOVES.includes(entry.lifecycle.move)) fail(`lifecycle.move must be one of ${SURFACE_MOVES.join(", ")}`);
    if (!isTimeout(entry.lifecycle.timeoutMs)) fail("lifecycle.timeoutMs must be null, an integer, or {min,max}");
    if (!isTimeout(entry.lifecycle.staleAfterMs)) fail("lifecycle.staleAfterMs must be null, an integer, or {min,max}");
    if (entry.lifecycle.refresh !== null && !isPlainObject(entry.lifecycle.refresh)) {
      fail("lifecycle.refresh must be null or an object");
    }
    if (typeof entry.lifecycle.outcomePolicy !== "string" || entry.lifecycle.outcomePolicy.length === 0) {
      fail("lifecycle.outcomePolicy is required");
    }
  }

  if (!isPlainObject(entry.consent)) {
    fail("consent is REQUIRED and must be structured, never prose");
  } else {
    const consent = entry.consent;
    if (typeof consent.actuatesOnExpiry !== "boolean") fail("consent.actuatesOnExpiry is required");
    if (typeof consent.actuatesOnTick !== "boolean") fail("consent.actuatesOnTick is required");
    if (typeof consent.requiresStaleAfterMs !== "boolean") fail("consent.requiresStaleAfterMs is required");
    if (!CONSENT_POLICIES.includes(consent.policy)) fail(`consent.policy must be one of ${CONSENT_POLICIES.join(", ")}`);
    if (typeof consent.assertion !== "string" || consent.assertion.length === 0) fail("consent.assertion is required");

    if (consent.actuatesOnExpiry === true && typeof consent.expiryRulingRef !== "string") {
      fail("consent.actuatesOnExpiry may only be true with an explicit expiryRulingRef — silence is never consent");
    }
    if (consent.actuatesOnTick === true && typeof consent.tickRulingRef !== "string") {
      fail("consent.actuatesOnTick may only be true with an explicit tickRulingRef — a timer firing is not consent");
    }
    if (consent.requiresStaleAfterMs === true && entry.lifecycle && entry.lifecycle.staleAfterMs === null) {
      fail("consent.requiresStaleAfterMs is true but lifecycle.staleAfterMs is null");
    }
  }

  if (!isPlainObject(entry.example)) {
    fail("example is required");
  } else {
    if (entry.example.synthetic !== true) {
      fail("example.synthetic must be true — registry examples carry SYNTHETIC content only");
    }
    if (typeof entry.example.renderableToday !== "boolean") fail("example.renderableToday is required");
    if (entry.example.renderableToday !== entry.renderableToday) {
      fail("example.renderableToday must agree with the entry's renderableToday");
    }
    if (!isPlainObject(entry.example.spec)) {
      fail("example.spec is required");
    } else if (entry.example.renderableToday === true) {
      if (!WIRE_KIND_ENUM.includes(entry.example.spec.kind)) {
        fail("a renderable example must use one of the shipping wire kinds");
      }
      if (entry.wireKind && entry.example.spec.kind !== entry.wireKind.name) {
        fail("example.spec.kind must match wireKind.name");
      }
    }
  }

  if (!isPlainObject(entry.provenance)) {
    fail("provenance is required");
  } else {
    if (!SEED_GROUPS.includes(entry.provenance.seedGroup)) {
      fail(`provenance.seedGroup must be one of ${SEED_GROUPS.join(", ")}`);
    }
    if (!Array.isArray(entry.provenance.sources) || entry.provenance.sources.length === 0) {
      fail("provenance.sources must name at least one document — nothing in this registry is unsourced");
    } else {
      for (const source of entry.provenance.sources) {
        if (!isPlainObject(source) || typeof source.doc !== "string" || typeof source.anchor !== "string") {
          fail("each provenance source needs {doc, anchor}");
        }
      }
    }
  }

  if (!Array.isArray(entry.codeAnchors)) fail("codeAnchors must be an array");
  if (!Array.isArray(entry.relatedTo)) fail("relatedTo must be an array");
  if (!Array.isArray(entry.openQuestions)) fail("openQuestions must be an array");
  if (entry.status === "shipped" && entry.codeAnchors.length === 0) {
    fail("a shipped entry must name the code that ships it");
  }

  return { ok: errors.length === 0, errors };
}

function validateTemplateRegistry(list = entries) {
  const errors = [];
  const seen = new Set();
  for (const entry of list) {
    const result = validateTemplateEntry(entry);
    errors.push(...result.errors);
    const id = isPlainObject(entry) ? templateId(entry) : "<entry>";
    if (seen.has(id)) errors.push(`${id}: duplicate template id`);
    seen.add(id);
  }

  for (const entry of list) {
    if (!isPlainObject(entry) || !Array.isArray(entry.relatedTo)) continue;
    for (const related of entry.relatedTo) {
      if (!seen.has(related)) errors.push(`${templateId(entry)}: relatedTo "${related}" does not resolve to a registry entry`);
    }
  }
  return { ok: errors.length === 0, errors };
}

function buildTemplateRegistryArtifact() {
  return {
    schema: TEMPLATE_REGISTRY_SCHEMA_ID,
    schemaVersion: TEMPLATE_REGISTRY_VERSION,
    purpose:
      "Versioned LiveUI template registry (S1-1, #1423). Language-neutral: no JS, no imports — parse and use. " +
      "Generated from extensions/ocuclaw/src/tools/glasses-ui-template-registry.ts; edit the source, never this file.",
    generatedFrom: "extensions/ocuclaw/src/tools/glasses-ui-template-registry.ts",
    generatedBy: "extensions/ocuclaw/scripts/generate-template-registry.mjs",
    companionArtifacts: ["./http-recipe-field-sets.json", "./http-recipe-cookbook.md"],
    consumers: {
      skillTeaching: "reads name, version, intent, wireKind, fieldSet, layoutBudgets, example, consent.assertion",
      planLint: "reads id, wireKind, fieldSet.closed, fieldSet.fields[].requirement, lane, disposition (#544)",
      evalCorpus: "reads example.spec, lifecycle.outcomePolicy, consent (#548)",
      thirdHost: "conforms to this file without running JavaScript",
    },
    lanes: {
      registry_entry_only:
        "Template rides a shipping wire kind. Adding it is a registry entry plus tests — no engine change, no license.",
      kinds_licensed:
        "Template needs a wire kind that does not exist. HARD-GATED behind Gate F3's kinds license. Registrable, never renderable until granted.",
    },
    wireKindEnum: WIRE_KIND_ENUM,
    wireTemplateFieldEnum: WIRE_TEMPLATE_FIELD_ENUM,
    vocabulary: {
      status: TEMPLATE_STATUSES,
      lane: TEMPLATE_LANES,
      disposition: TEMPLATE_DISPOSITIONS,
      wireKindStatus: WIRE_KIND_STATUSES,
      move: SURFACE_MOVES,
      consentPolicy: CONSENT_POLICIES,
      seedGroup: SEED_GROUPS,
    },
    consentRules: {
      required: "Every entry carries a structured `consent` object. Prose is not a consent policy.",
      shapeSharedWith: "./http-recipe-field-sets.json (consent.actuatesOnExpiry / actuatesOnTick / requiresStaleAfterMs / policy / assertion)",
      actuatesOnExpiry:
        "false on every entry. It may only be true alongside an explicit expiryRulingRef. A window closing is not an answer — silence is never consent.",
      actuatesOnTick:
        "false on every entry. It may only be true alongside an explicit tickRulingRef. A timer firing is not consent, and a schedule that fired is never a completion claim.",
    },
    exampleContentPolicy:
      "SYNTHETIC ONLY. Every worked example is invented content — no real name, route, credential, host, or message ever appears here.",
    counts: {
      total: entries.length,
      byStatus: entriesByStatus(),
      bySeedGroup: entriesBySeedGroup(),
      byLane: {
        registry_entry_only: entries.filter((entry) => entry.lane === "registry_entry_only").length,
        kinds_licensed: entries.filter((entry) => entry.lane === "kinds_licensed").length,
      },
      renderableToday: entries.filter((entry) => entry.renderableToday).length,
      held: entries.filter((entry) => entry.disposition === "held").length,
    },
    entries: entries.map((entry) => ({ id: templateId(entry), ...entry })),
  };
}

module.exports = { TEMPLATE_REGISTRY_SCHEMA_ID, TEMPLATE_REGISTRY_VERSION, WIRE_KIND_ENUM, WIRE_TEMPLATE_FIELD_ENUM, TEMPLATE_STATUSES, TEMPLATE_LANES, TEMPLATE_DISPOSITIONS, WIRE_KIND_STATUSES, SURFACE_MOVES, CONSENT_POLICIES, SEED_GROUPS, GLASSES_UI_TEMPLATE_REGISTRY, templateId, listTemplateEntries, listTemplateIds, getTemplateEntry, isRegisteredTemplateName, isWireKind, templatesForKind, entriesBySeedGroup, entriesByStatus, validateTemplateEntry, validateTemplateRegistry, buildTemplateRegistryArtifact };

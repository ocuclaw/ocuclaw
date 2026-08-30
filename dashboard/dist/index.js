(function () {
  "use strict";

  var SDK = window.__HERMES_PLUGIN_SDK__;
  var registry = window.__HERMES_PLUGINS__;
  if (!SDK || !registry || !SDK.React || !SDK.fetchJSON) return;

  var React = SDK.React;
  var e = React.createElement;

  function text(value, fallback) {
    if (value === null || value === undefined || value === "") return fallback || "unknown";
    return String(value);
  }

  function stateClass(state) {
    if (state === "healthy" || state === "configured" || state === "proven") return "oc-state-good";
    if (state === "unhealthy" || state === "invalid" || state === "unsupported") return "oc-state-bad";
    return "oc-state-unknown";
  }

  function StatePill(props) {
    return e("span", { className: "oc-state " + stateClass(props.value) }, text(props.value));
  }

  function Section(props) {
    return e(
      "section",
      { className: "oc-section " + (props.className || "") },
      e("div", { className: "oc-section-head" }, e("h2", null, props.title), props.kicker ? e("span", null, props.kicker) : null),
      props.children
    );
  }

  function CopyAction(props) {
    var action = props.action;
    var copyState = React.useState("idle");
    var copyStatus = copyState[0];
    var setCopyStatus = copyState[1];

    function copy() {
      function done() {
        setCopyStatus("copied");
        window.setTimeout(function () { setCopyStatus("idle"); }, 1800);
      }
      function failed() {
        setCopyStatus("failed");
      }
      function fallback() {
        var area = document.createElement("textarea");
        var copied = false;
        area.value = action.command;
        area.setAttribute("readonly", "readonly");
        area.style.position = "fixed";
        area.style.opacity = "0";
        document.body.appendChild(area);
        area.select();
        try {
          copied = document.execCommand("copy") === true;
        } catch (error) {
          copied = false;
        }
        document.body.removeChild(area);
        if (copied) done();
        else failed();
      }
      if (navigator.clipboard && navigator.clipboard.writeText) {
        try {
          navigator.clipboard.writeText(action.command).then(done, fallback);
          return;
        } catch (error) {
          fallback();
          return;
        }
      }
      fallback();
    }

    return e(
      "div",
      { className: "oc-action" },
      e("div", null, e("div", { className: "oc-kicker" }, "ONE SAFE NEXT ACTION"), e("h3", null, action.label)),
      e("code", null, action.command),
      action.teardown ? e("div", { className: "oc-teardown" }, e("strong", null, "Paired narrow teardown"), e("code", null, action.teardown)) : null,
      e("p", null, action.note),
      e("button", { type: "button", onClick: copy }, copyStatus === "copied" ? "Copied" : copyStatus === "failed" ? "Copy failed - select command" : "Copy only")
    );
  }

  function CausalPath(props) {
    return e(
      "ol",
      { className: "oc-path", "aria-label": "Connection path" },
      props.legs.map(function (leg, index) {
        var reason = leg.unknownBecause ? "Downstream truth withheld because " + leg.unknownBecause + " is not healthy." : null;
        return e(
          "li",
          { key: leg.key, className: "oc-leg" },
          e("div", { className: "oc-leg-number" }, String(index + 1)),
          e("div", null, e("strong", null, leg.label), reason ? e("small", null, reason) : null),
          e(StatePill, { value: leg.state })
        );
      })
    );
  }

  function TruthCard(props) {
    return e(
      "article",
      { className: "oc-truth" },
      e("div", { className: "oc-kicker" }, props.kicker),
      e("h3", null, props.title),
      e(StatePill, { value: props.state }),
      e("p", null, props.body)
    );
  }

  function Provenance(props) {
    var values = props.values || {};
    var rows = [
      ["Hermes release", values.hermesRelease],
      ["Hermes package", values.hermesPackageVersion],
      ["Certified source", values.certifiedSource],
      ["Running source", values.hermesSource],
      ["OcuClaw", values.ocuclawVersion],
      ["Setup guide", values.setupGuideVersion],
      ["Snapshot contract", values.snapshotContractVersion],
      ["Profile fingerprint", values.profileFingerprint]
    ];
    return e(
      "dl",
      { className: "oc-provenance" },
      rows.map(function (row) {
        return e(React.Fragment, { key: row[0] }, e("dt", null, row[0]), e("dd", null, text(row[1])));
      })
    );
  }

  function Loading() {
    return e("div", { className: "oc-shell" }, e("div", { className: "oc-loading" }, "Reading the passive recovery receipt…"));
  }

  function Failure(props) {
    return e(
      "div",
      { className: "oc-shell" },
      e("div", { className: "oc-readonly" }, "READ-ONLY"),
      e("h1", null, "OcuClaw guided recovery"),
      e("div", { className: "oc-error" }, "The receipt could not be read. No check or repair was started. ", text(props.message))
    );
  }

  function RecoveryPage() {
    var dataState = React.useState(null);
    var data = dataState[0];
    var setData = dataState[1];
    var errorState = React.useState(null);
    var error = errorState[0];
    var setError = errorState[1];

    React.useEffect(function () {
      var live = true;
      SDK.fetchJSON("/api/plugins/ocuclaw/snapshot", { method: "GET" }).then(
        function (payload) { if (live) setData(payload); },
        function (reason) { if (live) setError(reason && reason.message ? reason.message : String(reason)); }
      );
      return function () { live = false; };
    }, []);

    if (error) return e(Failure, { message: error });
    if (!data) return e(Loading, null);

    var header = data.header || {};
    var primary = data.primary || {};
    var truths = data.truths || {};
    var setup = truths.setup || {};
    var health = truths.currentHealth || {};
    var proof = truths.firstRunProof || {};
    var receiptGate = data.platformReceiptGate || {};
    var pairing = data.pairing || {};
    var checkpoints = data.checkpoints || {};
    var support = data.support || {};

    return e(
      "main",
      { className: "oc-shell" },
      e(
        "header",
        { className: "oc-header" },
        e("div", null, e("div", { className: "oc-kicker" }, header.purpose), e("h1", null, "OcuClaw guided recovery")),
        e("div", { className: "oc-readonly" }, "READ-ONLY"),
        e(
          "div",
          { className: "oc-meta" },
          e("span", null, "Target profile: ", e("strong", null, text(header.profileName))),
          e("span", null, "Observed: ", e("strong", null, text(header.observedAt))),
          e("span", null, "Evidence: ", e("strong", null, text(header.evidenceMode))),
          e("span", null, "Platform receipt: ", e("strong", null, text(receiptGate.status)))
        )
      ),
      e(Section, { title: "Outcome", className: "oc-outcome" }, e("p", null, data.outcome)),
      e(Section, { title: "Where the path stands", kicker: "CAUSAL, NOT INFERRED" }, e(CausalPath, { legs: data.causalPath || [] })),
      e(
        Section,
        { title: "Primary explanation", kicker: text(primary.evidenceFreshness).toUpperCase() + " EVIDENCE" },
        e("div", { className: "oc-primary" }, e("div", null, e("h3", null, text(primary.summary)), e("p", null, text(primary.consequence))), e("div", { className: "oc-age" }, primary.evidenceAgeSeconds === null ? "Age unknown" : text(primary.evidenceAgeSeconds) + "s old"))
      ),
      data.safeAction ? e(CopyAction, { action: data.safeAction }) : e("div", { className: "oc-no-action" }, "No safe copy-only action is offered for the evidence currently available."),
      e(
        "div",
        { className: "oc-wide-grid" },
        e(
          Section,
          { title: "Three independent truths" },
          e("div", { className: "oc-truths" },
            e(TruthCard, { kicker: "DURABLE", title: "Hermes Setup State", state: setup.state, body: "Installation and configuration truth. A connectivity outage does not undo setup." }),
            e(TruthCard, { kicker: "RIGHT NOW", title: "Current Connection Health", state: health.state, body: "Point-in-time health across four causal legs. Unknown is never dressed up as disconnected." }),
            e(TruthCard, { kicker: "HISTORICAL", title: "Hermes First-Run Proof", state: proof.state, body: proof.state === "proven" ? "A phone-origin turn worked on G2 before. Later outages never erase this." : "No durable G2 completion proof can be claimed for this profile." })
          )
        ),
        e(
          Section,
          { title: "Recovery checkpoints" },
          e("div", { className: "oc-checkpoint" }, e("strong", null, text(checkpoints.next)), e("code", null, checkpoints.doctorCommand), e("p", null, checkpoints.note)),
          data.verifiedPhoneAddress ? e("div", { className: "oc-address" }, e("strong", null, "Verified private phone address"), e("code", null, data.verifiedPhoneAddress)) : e("p", null, "Private WSS address withheld until configuration, bounded reachability, and application readiness are all verified.")
        )
      ),
      e(
        Section,
        { title: "Pairing handoff" },
        e("p", null, "Pairing starts only in ", e("code", null, pairing.command), ". This page never starts it."),
        e("ul", null, e("li", null, pairing.qr), e("li", null, pairing.manual))
      ),
      e(
        "details",
        { className: "oc-details" },
        e("summary", null, "Evidence and provenance"),
        e(Provenance, { values: data.provenance }),
        e("p", null, "The profile is identified by fingerprint; no raw profile path is rendered.")
      ),
      e(
        Section,
        { title: "Support" },
        e("ol", { className: "oc-support" }, e("li", null, "Start with ", e("code", null, support.first), "."), e("li", null, support.connected), e("li", null, support.offline), e("li", null, support.sharing))
      )
    );
  }

  registry.register("ocuclaw", RecoveryPage);
})();

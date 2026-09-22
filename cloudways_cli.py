"""`hermes ocuclaw cloudways <verb>` — argparse namespace in, exit status out.

Thin by design: every decision lives in :mod:`cloudways`; this file renders
the report (text for the agent's terminal, `--json` for the Setup Assistant's
typed reads) and maps the report to an exit status. Exit 0 = the verb did what
it says; 1 = it could not; 2 = refused (foreign supervisor, missing --yes);
130 = the user pressed Ctrl-C (`setup`, and `enroll`/`retry`'s observation).
"""
from __future__ import annotations

import argparse
import json
import sys
from typing import Any, Dict, List, Mapping, Optional

from . import cloudways

EXIT_OK = 0
EXIT_PROBLEM = 1
EXIT_REFUSED = 2


def _emit(report: Mapping[str, Any], lines: List[str], *, json_output: bool) -> None:
    if json_output:
        sys.stdout.write(json.dumps(report, indent=2, sort_keys=True) + "\n")
    else:
        sys.stdout.write("\n".join(lines) + "\n")


def _yes_no(value: Any) -> str:
    return "yes" if value else "no"


def render_detect(report: Mapping[str, Any]) -> List[str]:
    lines = [f"Cloudways detection — {report.get('verdict')}", f"  hostname  {report.get('hostname')}"]
    for name, hit in sorted((report.get("signals") or {}).items()):
        lines.append(f"  {'✓' if hit else '·'} {name}")
    if report.get("verdict") == cloudways.DETECT_LIKELY:
        lines.append("  Not decisive: ask the user whether this is a Cloudways Managed AI Agents host.")
    return lines


def render_status(report: Mapping[str, Any]) -> List[str]:
    daemon = report.get("daemon") or {}
    job = report.get("job")
    route = report.get("route") or {}
    legacy = report.get("legacy") or {}
    receipt = report.get("receipt")
    lines = [
        f"Cloudways Tailscale — daemon {daemon.get('state')}",
    ]
    if daemon.get("detail"):
        lines.append(f"  {daemon['detail']}")
    if daemon.get("node_name"):
        lines.append(
            f"  node      {daemon.get('node_name')}  ({daemon.get('dns_name') or '?'})  online={_yes_no(daemon.get('online'))}"
        )
    if daemon.get("key_expiry"):
        lines.append(f"  key expiry {daemon['key_expiry']}  (disable expiry for this node in the admin console)")
    lines.append(f"  receipt   {'present' if receipt else 'absent'}  {report.get('layout', {}).get('receipt', '')}")
    lines.append(f"  script    {'present' if (report.get('script') or {}).get('present') else 'absent'}")
    if job is None:
        lines.append("  cron job  absent  (run: hermes ocuclaw cloudways install)")
    else:
        lines.append(
            f"  cron job  {job.get('id')}  schedule={job.get('schedule')}  enabled={_yes_no(job.get('enabled'))}"
            f"  spec={'ok' if job.get('matches') else 'DRIFTED'}"
        )
    lines.append(f"  serve route {route.get('classification')}" + (f"  ({route.get('reason')})" if route.get("reason") else ""))
    if daemon.get("auth_url"):
        lines.append("  authorization needed — open this link on a device signed in to the tailnet, then approve the node:")
        lines.append(f"    {daemon['auth_url']}")
    elif report.get("authorizationPending"):
        # Not the bare marker: on a running, authorized node that marker is
        # stale, and telling the user to retry sends them in circles.
        lines.append("  authorization needed — run: hermes ocuclaw cloudways retry")
    elif report.get("needsAuthorizationMarker"):
        # Running node, leftover marker: say so plainly rather than sending the
        # operator to re-authorize a node that is already authorized.
        lines.append("  stale authorization marker (node is running); the next enable or install pass clears it")
    if legacy.get("legacySupervisorPresent") or legacy.get("disabledTailscaleHooks"):
        lines.append(
            f"  legacy    supervisor dir {'present' if legacy.get('legacySupervisorPresent') else 'absent'}"
            f", disabled hooks {legacy.get('disabledTailscaleHooks') or []}  (inactive, left alone)"
        )
    if legacy.get("foreignDaemonProcesses"):
        lines.append("  WARNING  another tailscaled/supervisor is running:")
        lines.extend(f"    {item}" for item in legacy["foreignDaemonProcesses"])
    return lines


def render_install(report: Mapping[str, Any]) -> List[str]:
    lines = [f"Cloudways install — {'ok' if report.get('ok') else 'FAILED'}"]
    if report.get("error"):
        lines.append(f"  error     {report['error']}")
    if report.get("binaries"):
        lines.append(f"  binaries  {report['binaries']}  ({report.get('version')})")
    if report.get("receipt"):
        lines.append(f"  receipt   {report['receipt']}")
    if report.get("script"):
        lines.append(f"  script    {report['script']}  {report.get('path')}")
    job = report.get("job") or {}
    if job:
        lines.append(f"  cron job  {job.get('action')}  id={job.get('jobId')}")
    fired = report.get("fired") or {}
    if fired:
        # `unreported` is the honest answer for a background dispatch or a
        # next-tick run, not a failure; `status` is what observes the daemon.
        lines.append(
            f"  fired     {_yes_no(fired.get('fired'))}  (run verdict: "
            f"{fired.get('verdict', 'unreported')}; `status` reports the daemon's real state)"
        )
    if report.get("ok"):
        lines.append("  next: hermes ocuclaw cloudways status --wait 45, then enroll")
    return lines


def render_enroll(report: Mapping[str, Any]) -> List[str]:
    lines = [f"Cloudways enroll — {report.get('state')}"]
    if report.get("authUrl"):
        lines.append("  Open this link on any device signed in to the tailnet, then approve the node:")
        lines.append(f"    {report['authUrl']}")
        if report.get("qr"):
            lines.append(report["qr"])
        lines.append("  Then: hermes ocuclaw cloudways status --wait 45")
    elif report.get("state") == cloudways.STATE_RUNNING:
        lines.append(f"  node {report.get('nodeName')} ({report.get('dnsName')}) is authorized and running")
        lines.append("  Next: hermes ocuclaw doctor  (it proposes the Serve route command)")
    if report.get("error"):
        lines.append(f"  error     {report['error']}")
    return lines


#: The banner word for a verb that did nothing because it was never confirmed.
#: "FAILED" is for something that went wrong; being asked to confirm is not.
CONFIRMATION_NEEDED = "confirmation needed"


def render_generic(
    title: str, report: Mapping[str, Any], *, verdict: Optional[str] = None
) -> List[str]:
    lines = [f"{title} — {verdict or ('ok' if report.get('ok') else 'FAILED')}"]
    for key, value in sorted(report.items()):
        if key == "ok":
            continue
        lines.append(f"  {key:<12} {value}")
    return lines


def render_rollback(
    report: Mapping[str, Any], *, verdict: Optional[str] = None
) -> List[str]:
    """Generic report, plus plain lines for anything rollback deliberately left."""
    kept = ("receiptKept", "binariesKept", "identityPurgeSkipped")
    lines = render_generic(
        "Cloudways rollback",
        {key: value for key, value in report.items() if key not in kept},
        verdict=verdict,
    )
    provisioner = report.get("receiptKept")
    if provisioner:
        lines.append(
            f"  Kept the shared Tailscale CLI receipt: {provisioner} provisioned it, not this plugin."
        )
        if report.get("binariesKept"):
            lines.append("  Kept the tailscale binaries it names too, so that install keeps working.")
        if report.get("identityPurgeSkipped"):
            lines.append(
                "  Kept the Tailscale identity in ~/.tailscale: another install still uses it, "
                "so --purge-identity was not applied."
            )
    return lines


def run_cloudways(args: argparse.Namespace) -> int:
    verb = getattr(args, "cloudways_verb", None)
    json_output = bool(getattr(args, "json_output", False))
    layout = cloudways.Layout.resolve()
    if verb == "setup":
        # The ladder (#3101). Imported here so the eight thin verbs never drag
        # it in. With --json the progress goes to stderr and stdout carries the
        # final summary alone, so a machine reads one document.
        from . import cloudways_setup

        try:
            options = cloudways_setup.SetupOptions.from_namespace(args)
            result = cloudways_setup.run_setup(
                options,
                layout=layout,
                output=sys.stderr if options.json_output else sys.stdout,
            )
            if options.json_output:
                sys.stdout.write(json.dumps(result.as_dict(), indent=2, sort_keys=True) + "\n")
        except KeyboardInterrupt:
            # The ladder catches its own Ctrl-C, says so in its own line and
            # journals it, so this covers only what is outside it: reading the
            # options and writing the summary. Without it, a Ctrl-C in those
            # two windows is a traceback again (#3146).
            sys.stderr.write(f"{cloudways_setup.INTERRUPT_MESSAGE}\n")
            return cloudways_setup.SETUP_EXIT_INTERRUPTED
        return result.exit_code
    if verb == "detect":
        report = cloudways.detect().as_dict()
        _emit(report, render_detect(report), json_output=json_output)
        return EXIT_OK
    if verb == "install":
        report = cloudways.install(layout, force_download=bool(getattr(args, "force_download", False)))
        _emit(report, render_install(report), json_output=json_output)
        if report.get("ok"):
            return EXIT_OK
        return EXIT_REFUSED if "never run two supervisors" in str(report.get("error", "")) else EXIT_PROBLEM
    if verb in ("enroll", "retry"):
        try:
            report = cloudways.enroll(
                layout,
                hostname=getattr(args, "hostname", None),
                qr=bool(getattr(args, "qr", False)),
                progress=lambda message: print(message, file=sys.stderr, flush=True),
            )
        except KeyboardInterrupt:
            # One Ctrl-C exit code for the whole group, from the ladder that
            # spells it out. Imported here, in the path a user reaches once in
            # a blue moon, so the thin verbs still never drag the ladder in.
            from . import cloudways_setup

            report = {"ok": False, "state": "cancelled", "pending": True,
                      "error": "Observation cancelled. Run hermes ocuclaw cloudways retry to recover the existing enrollment."}
            _emit(report, render_enroll(report), json_output=json_output)
            return cloudways_setup.SETUP_EXIT_INTERRUPTED
        _emit(report, render_enroll(report), json_output=json_output)
        return EXIT_OK if report.get("ok") else EXIT_PROBLEM
    if verb == "status":
        report = cloudways.status(layout, wait_s=float(getattr(args, "wait", 0.0) or 0.0))
        _emit(report, render_status(report), json_output=json_output)
        return EXIT_OK
    if verb == "enable":
        report = cloudways.enable(layout)
        _emit(report, render_generic("Cloudways enable", report), json_output=json_output)
        if report.get("ok"):
            return EXIT_OK
        return EXIT_REFUSED if "never run two supervisors" in str(report.get("error", "")) else EXIT_PROBLEM
    if verb == "disable":
        report = cloudways.disable(layout)
        _emit(report, render_generic("Cloudways disable", report), json_output=json_output)
        return EXIT_OK if report.get("ok") else EXIT_PROBLEM
    if verb == "rollback":
        if not bool(getattr(args, "assume_yes", False)):
            report: Dict[str, Any] = {
                "ok": False,
                "error": (
                    "rollback removes the watchdog, daemon, script and the binaries and "
                    "receipt this plugin provisioned; re-run with --yes"
                ),
            }
            # Nothing was tried, so nothing failed: the banner says what is
            # actually missing, which is the user's confirmation.
            _emit(
                report,
                render_rollback(report, verdict=CONFIRMATION_NEEDED),
                json_output=json_output,
            )
            return EXIT_REFUSED
        report = cloudways.rollback(layout, purge_identity=bool(getattr(args, "purge_identity", False)))
        _emit(report, render_rollback(report), json_output=json_output)
        return EXIT_OK if report.get("ok") else EXIT_PROBLEM
    sys.stderr.write("hermes ocuclaw cloudways: unknown verb\n")
    return EXIT_REFUSED


__all__ = ["run_cloudways"]

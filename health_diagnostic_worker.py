"""Child-process-only native diagnostic renderer. Never imports in the gateway.

Native doctor may run connectivity probes and a rolled-back SQLite write probe.
fix=False and ack=None forbid repairs/acknowledgements. Native raw output is
discarded by the parent; this file emits only fixed categories and identifiers.
"""
import json
import os
from pathlib import Path
import re
import select
import signal
import sys
from types import SimpleNamespace

SECTIONS = {
    "Security Advisories": ("advisories", "Review native security advisories with the host administrator."),
    "MCP Server Security": ("mcp", "Review configured MCP packages and their native advisories."),
    "Python Environment": ("python", "Check the Hermes interpreter and environment on the host."),
    "SSL / CA Certificates": ("certificates", "Check host certificate configuration."),
    "Required Packages": ("packages", "Review missing package dependencies on the host."),
    "Configuration Files": ("configuration", "Review the selected profile configuration on the host."),
    "Config Structure": ("configuration", "Review the selected profile configuration on the host."),
    "Auth Providers": ("authentication", "Review provider authentication in the selected profile."),
    "Directory Structure": ("storage", "Check selected profile storage permissions and database health."),
    "Command Installation": ("command", "Check the native Hermes CLI installation."),
    "External Tools": ("tools", "Review required external tool availability."),
    "API Connectivity": ("connectivity", "Check configured provider credentials and connectivity."),
    "Tool Availability": ("tools", "Review tool availability for the selected profile."),
    "Skills Hub": ("skills", "Review the native Skills Hub configuration."),
    "Memory Provider": ("memory", "Review the configured native memory provider."),
    "Profiles": ("profiles", "Review native profile configuration on the host."),
    "s6 Supervision": ("supervision", "Review native service supervision on the host."),
    "Gateway Service": ("service", "Review native gateway service status on the host."),
    "Provider Retirement": ("provider", "Review retired provider models configured in this profile."),
    "Plugin Compatibility": ("plugins", "Update plugins that import native paths scheduled for removal."),
}

# Hermes 2026.9 split doctor into ``doctor_*`` siblings and dropped the section
# title from most checks (they run under ``title=None`` and inherit whichever
# section came before), so titles alone no longer separate the categories: five
# would vanish and profiles would report itself as memory. The check function
# survives that split, so it, not the title, keys the category.
CHECKS = {
    "_check_security_advisories": "Security Advisories",
    "_check_mcp_security": "MCP Server Security",
    "_check_python_environment": "Python Environment",
    "_check_certificates": "SSL / CA Certificates",
    "_check_required_packages": "Required Packages",
    "_check_env_file": "Configuration Files",
    "_check_config_file": "Config Structure",
    "_check_config_drift": "Config Structure",
    "_check_xai_retirement": "Provider Retirement",
    "_check_plugin_compat": "Plugin Compatibility",
    "_check_auth_providers": "Auth Providers",
    "_check_directory_structure": "Directory Structure",
    "_check_state_db": "Directory Structure",
    "_check_gateway_supervision": "s6 Supervision",
    "_check_command_installation": "Command Installation",
    "_check_git_and_rg": "External Tools",
    "_check_terminal_backend": "External Tools",
    "_check_node_and_browser": "External Tools",
    "_check_npm_audit": "External Tools",
    "_check_api_connectivity": "API Connectivity",
    "_check_tool_availability": "Tool Availability",
    "_check_skills_hub": "Skills Hub",
    "_check_memory_provider": "Memory Provider",
    "_check_profiles": "Profiles",
}


def capture_doctor(doctor, section, check):
    """Route native doctor rows into ``section``/``check`` on either module layout.

    Before 2026.9 the primitives were defined in ``hermes_cli.doctor`` and
    patching that module was enough. 2026.9 moved them to
    ``hermes_cli.doctor_report``; every ``doctor_*`` sibling from-imports them,
    so each module holds its own binding and all of them must be rebound. The
    names left behind in ``doctor`` there are dead plugin-compat stubs that no
    internal check calls, so patching only ``doctor`` captures nothing at all
    and the diagnostic reports zero checks instead of failing.
    """
    marks = {"check_ok": check("ok"), "check_warn": check("warning"),
             "check_fail": check("error"), "check_info": check("info")}
    # Read, never import: doctor pulls its siblings in at module scope, so on
    # 2026.9 they are already loaded, and on the certified baseline the module
    # does not exist at all. Importing it would widen the bundle's declared
    # platform surface with a name half the supported range cannot resolve.
    report = sys.modules.get("hermes_cli.doctor_report")
    targets = [doctor] if report is None else [module for name, module in list(sys.modules.items())
                                               if name.startswith("hermes_cli.doctor") and module is not None]
    for module in targets:
        for name, mark in marks.items():
            if hasattr(module, name):
                setattr(module, name, mark)
        if hasattr(module, "_section"):
            module._section = section
    if report is not None:
        # ``warn_on_error``'s ``report=check_warn`` default was bound at
        # definition, so best-effort failures print through the original and go
        # uncounted unless the default itself is replaced.
        guard = getattr(getattr(report, "warn_on_error", None), "__wrapped__", None)
        if guard is not None and guard.__defaults__:
            guard.__defaults__ = guard.__defaults__[:-1] + (marks["check_warn"],)
    checks = getattr(doctor, "DOCTOR_CHECKS", None)
    if checks:
        def titled(entry):
            title = CHECKS.get(getattr(entry, "__name__", ""))
            if title is None:
                return entry
            def run_check(*args, **kwargs):
                section(title)
                return entry(*args, **kwargs)
            return run_check
        doctor.DOCTOR_CHECKS = tuple((title, titled(entry)) for title, entry in checks)


def run(kind, output):
    data = {"state": "running", "phase": "starting", "checks": 0, "findings": [], "coverage": "unknown"}
    def emit():
        temporary = output.with_suffix(".tmp")
        with os.fdopen(os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, 0o600), "w") as file:
            json.dump(data, file)
        os.replace(temporary, output)
    emit()
    try:
        if kind == "doctor":
            import hermes_cli.doctor as doctor
            category = ["native_check", "Review this native diagnostic category on the host."]
            counts = {}
            def section(title):
                category[:] = SECTIONS.get(title, ("native_check", "Review native diagnostics on the host."))
                data["phase"] = category[0]
                emit()
            def check(status):
                def capture(*args, **kwargs):
                    data["checks"] += 1
                    key = (category[0], status)
                    if key not in counts and len(data["findings"]) < 64:
                        counts[key] = {"code": category[0], "severity": status, "count": 0,
                                       "nextStep": category[1] if status != "ok" else "No action for the checks reported in this category."}
                        data["findings"].append(counts[key])
                    if key in counts:
                        counts[key]["count"] += 1
                    emit()
                return capture
            capture_doctor(doctor, section, check)
            doctor.run_doctor(SimpleNamespace(fix=False, ack=None))
            data.update(state="completed" if data["checks"] else "partial", coverage="native_reported_checks")
        else:
            import hermes_cli.security_audit as native
            details_complete = [True]
            def post(call, url, payload):
                result = call(url, payload)
                rows = result.get("results") if isinstance(result, dict) else None
                if not isinstance(rows, list) or len(rows) != len(payload["queries"]):
                    raise RuntimeError("Incomplete native OSV result")
                for row in rows:
                    if not isinstance(row, dict) or not isinstance(row.get("vulns", []), list):
                        raise RuntimeError("Malformed native OSV result")
                    if any(not isinstance(item, dict) or not isinstance(item.get("id"), str) or not item["id"] for item in row.get("vulns", [])):
                        raise RuntimeError("Malformed native OSV finding")
                return result
            def get(call, url):
                try:
                    record = call(url)
                    if not isinstance(record, dict) or not record.get("id"):
                        raise RuntimeError("Missing native advisory")
                    return record
                except Exception:
                    details_complete[0] = False
                    raise
            # 2026.9 merged the two OSV helpers into one that POSTs when handed a
            # payload and GETs otherwise. The old pair is simply gone there, so
            # reading it raises before the audit starts and the whole security
            # result reports native_failed.
            single = getattr(native, "_http_json", None)
            if single is not None:
                native._http_json = lambda url, payload=None: (
                    get(single, url) if payload is None else post(single, url, payload))
            else:
                native_post, native_get = native._http_post_json, native._http_get_json
                native._http_post_json = lambda url, payload: post(native_post, url, payload)
                native._http_get_json = lambda url: get(native_get, url)
            data["phase"] = "component_discovery"
            emit()
            components = native._discover_components(hermes_home=Path(os.environ["HERMES_HOME"]))
            data.update(checks=len(components), phase="advisory_lookup")
            emit()
            findings = native.run_audit(components=components)
            for finding in findings[:64]:
                identifier = finding.vuln.osv_id
                if not re.fullmatch(r"[A-Za-z0-9_-]{1,100}", identifier):
                    identifier = "redacted-advisory"
                # Package names/sources may come from local custom configuration;
                # send only the public advisory ID, severity and a fixed action.
                severity = finding.vuln.severity.lower()
                data["findings"].append({"code": identifier,
                    "severity": severity if severity in {"critical", "high", "medium", "low"} else "unknown",
                    "count": 1, "nextStep": "Review this advisory and affected installed dependencies with the host administrator."})
            # Native discovery skips unpinned dependencies and some unreadable
            # metadata. An empty result is never comprehensive security clearance.
            data.update(state="partial", coverage="discovered_pinned_components" if details_complete[0] else "advisory_details_incomplete",
                        truncated=len(findings) > 64)
        data["phase"] = "finished"
    except PermissionError:
        data.update(state="permission_denied", phase="finished")
    except BaseException:
        data.update(state="native_failed", phase="finished")
    emit()


def watchdog(seconds):
    """Independent deadline survives gateway death and includes descendants.

The watchdog is in the worker's new process group. The pipe closes when the
worker exits, so even native descendants left behind after success are killed.
The write descriptor is CLOEXEC and never inherited by native exec commands.
"""
    read_fd, write_fd = os.pipe()
    process_group = os.getpgrp()
    if os.fork() == 0:
        os.close(write_fd)
        select.select([read_fd], [], [], seconds)
        try:
            os.killpg(process_group, signal.SIGKILL)
        finally:
            os._exit(0)
    os.close(read_fd)
    return write_fd


if __name__ == "__main__":
    descriptor = watchdog(float(sys.argv[3]))
    run(sys.argv[1], Path(sys.argv[2]))
    # Exit atomically, closing the watchdog pipe only after native result write.
    os._exit(0)

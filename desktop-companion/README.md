# Local OcuClaw visibility for Hermes Desktop

This installs the desktop half of **the same `ocuclaw/ocuclaw` Runtime Bundle**
on the computer running Hermes Desktop. It reuses Desktop's saved Cloudways SSH
connection. It does not install a local agent, change the Cloudways backend,
pair glasses, or copy any generated plugin from Cloudways.

The delivery prerequisite is **Python 3.9 or newer**, standard library only.
Hermes Desktop does not guarantee a usable Python command. Install Python
separately if needed; no Hermes CLI or local Hermes gateway is required. Run the
commands in a local terminal, not inside the Cloudways SSH session.

## Prepare the candidate (maintainers)

From the repository checkout:

```sh
python3 tools/hermes-desktop-companion/companion.py build --output /absolute/output/companion.json
python3 tools/hermes-desktop-companion/test_companion.py
```

The output directory must already exist. `build` reads only the inert desktop
template and Runtime Bundle manifest. The JSON carries the bundle version,
identity, SHA-256 and renderer source with empty presenter/theme slots. Artifact
format 2 stores `sourceLines` as an indented JSON array, preserving each source
line and its newline for review and the unchanged bundle scanner. Installation
joins those strings exactly before verifying the SHA-256 and writing the plugin;
it does not decode an opaque archive or execute the JSON. Its
SHA-256 detects accidental corruption; it is not a signature or a substitute for
trusted distribution. Distribute `companion.py` and `companion.json` together
through the existing bundle channel when release is authorized. Do not publish
an independent companion package or channel. This change does not publish either
file or introduce an independently loadable entry in the Runtime Bundle.

For lab handoff, rebuild the JSON from the candidate checkout and copy that JSON
alongside the matching `companion.py`. Older candidate artifacts using `source`
instead of `sourceLines` are rejected; rebuild them rather than converting a
generated plugin from a running backend. Scan the candidate directory with the
normal plugin guard before installing:

```sh
bash extensions/ocuclaw-hermes/scripts/plugin-guard-gate.sh /absolute/output
```

## Install or update (on the Desktop computer)

After saving/testing the Cloudways SSH connection in Hermes Desktop, the optional
**Show OcuClaw in Hermes Desktop** step uses the two files from the matching
Runtime Bundle. Skipping this step does not affect chat. You can return later.

Close Desktop before updating its plugin files. Pass the **app-level Hermes
home**, usually `.hermes` in your user directory, not a profile directory.
Use the actual absolute directory when your home has a custom location.
If this computer also has an older local OcuClaw Runtime Bundle, update that
bundle first through its existing update flow. Older backends regenerate their
presenter when Desktop starts and would replace the companion. Installation
refuses until every discovered local OcuClaw backend supports preserving the
companion; it does not update or restart a local agent automatically.

macOS/Linux, from the directory containing the two files:

```sh
python3 companion.py install --home "$HOME/.hermes" --artifact companion.json
python3 companion.py status --home "$HOME/.hermes"
```

Windows PowerShell (with the Python launcher installed):

```powershell
py -3 companion.py install --home "$env:USERPROFILE\.hermes" --artifact companion.json
py -3 companion.py status --home "$env:USERPROFILE\.hermes"
```

Reopen Desktop. In **Desktop Plugins**, enable OcuClaw if desired, then select
your saved Cloudways connection/profile. The companion occupies the existing
OcuClaw title-bar position. Installation never modifies Desktop's plugin registry
or overrides an explicit disabled choice. Remote pairing and private credential
forms are not enabled by this step. Existing phone/glasses pairing stays intact.

Repeat the same install command with the next matching bundle to update.
`status` reports the installed version and actual renderer SHA-256. Existing
local presenter authority and theme choice are retained only from an already
owned local plugin; their values are never printed. The resulting installed hash
can therefore differ from the secret-free artifact hash. Unresolved template
placeholders become empty strings, never authority.

## Remove

```sh
python3 companion.py remove --home "$HOME/.hermes"
```

On Windows use `py -3` and `$env:USERPROFILE` as above. Reopen Desktop afterward.
Removal deletes only the marked local `desktop-plugins/ocuclaw/plugin.js` and an
empty containing directory. It preserves siblings, Desktop preferences, saved
SSH connections, pairing records and the remote Runtime Bundle. Removal and
installation can be repeated safely. If a local backend also generates this
presenter, it can recreate it; use Desktop's disabled preference to keep that
backend-managed contribution hidden.

## Safe refusals and interrupted updates

- `unsafe_path`: use an absolute home path without `..`. The home is resolved
  once, so linked ancestors, a linked home and a linked `desktop-plugins` root
  are followed exactly as Hermes Desktop follows them; every receipt prints the
  resolved `path` so a followed link stays visible. Only a linked
  `desktop-plugins/ocuclaw` folder — which Desktop's directory-only enumeration
  never loads — and a linked `plugin.js` are refused, and the message names the
  exact link. Replace that link with a real folder or file yourself; this tool
  does not replace a linked target automatically.
- `foreign_plugin` / `presenter_invalid`: unrecognized local content is kept.
  Inspect the existing installation before deciding its disposition.
- `duplicate_runtime`: another OcuClaw runtime exists in a profile, old package,
  or renamed folder. Reconcile it through Desktop before retrying; this tool
  does not delete another runtime to make itself win.
- `package_managed`: Desktop owns a materialized agent-package copy. Update or
  remove it through that owning package/Desktop path.
- `local_backend_update_required`: update the local OcuClaw Runtime Bundle
  before installing the companion. An older backend would overwrite it when
  Desktop starts. For an already-paired 2.0.6 installation, use its existing
  local update flow and its gateway restart to reconcile the presenter, then
  fully quit and reopen Hermes Desktop on the local connection and confirm OcuClaw still
  works before retrying. Updated backend files do not prove the running Desktop
  reloaded its presenter. Updating Cloudways does not update that local
  bundle. Existing local files and pairing are preserved; no automatic update
  runs. Selecting Cloudways in Desktop does not change phone/glasses pairing.
- `artifact_invalid`: obtain the matching intact artifact from the bundle.
- `downgrade_refused`: use the current or a higher Runtime Bundle version.
- `operation_failed`: check Python, input files and filesystem permissions.

Updates fsync a private temporary file beside the target and atomically replace
the one loadable entry. A process interrupted before replacement leaves the old
entry intact; retry installation. An interrupted write may leave a hidden
`.ocuclaw-*.tmp` file, which Desktop does not load. No multi-file registry or
credential transaction is required. Do not run two installers concurrently or
update while a backend is regenerating this same plugin.

## Compatibility and evidence limits

The installer targets Hermes's supported app-level
`<Hermes home>/desktop-plugins/ocuclaw/plugin.js` slot. Upstream source inspected
for this change makes this the sole discovery root and migrates older profile
and package copies. The installer conservatively refuses those duplicates rather
than relying on migration order. Desktop must provide selected-connection state
and scoped plugin REST calls; unsupported routing is read-only/unavailable, not
assumed local. The matching remote OcuClaw Runtime Bundle must expose its existing
status routes. Installer success does not establish backend/API compatibility.

The subprocess tests prove delivery on the test host, not native Desktop support
on every OS. Record the exact Desktop/backend versions and results for native
Mac, Windows and supported Linux sessions separately. A container run cannot
replace Mac/Windows launcher, reopen, SSH reconnect and loader evidence. Public
support claims and release delivery remain gated by those results and the parent
Cloudways guidance review checkpoint.

// OCUCLAW-OWNED-DESKTOP-PAIRING-PLUGIN v1
// Direct-human Hermes Desktop presenter. Pairing authority stays in the
// plugin-scoped Python backend; this renderer receives public ceremony data.

import * as sdk from '@hermes/plugin-sdk'
import {
  Button,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  GlyphSpinner,
  THEMES_AREA,
  TITLEBAR_AREAS,
} from '@hermes/plugin-sdk'
import { useEffect, useRef, useState } from 'react'
import { jsx, jsxs } from 'react/jsx-runtime'

// Claim cadence. The fast rate is reserved for the window where a checkpoint
// is actually expected — setup is running in a chat — so an idle host that may
// sit here for days is not polling a side-effecting route four times a second.
const CLAIM_INTERVAL_MS = 750
const CLAIM_IDLE_INTERVAL_MS = 2500
const STATE_INTERVAL_MS = 650
// The gateway's platform id for OcuClaw — the key the gateway writes into
// gateway_state.json's `platforms` map, which is what tells this card the
// restart actually loaded the plugin.
const PLATFORM_ID = 'ocuclaw'
const CARD_PROBE_INTERVAL_MS = 1500
const CARD_IDLE_INTERVAL_MS = 10000
const CARD_PROBE_TIMEOUT_MS = 2000
// A gateway restart is a backend respawn, not a socket reconnect. Past this
// the card stops narrating progress and offers the retry rather than spinning
// forever on a restart that failed somewhere the renderer cannot see.
const RESTART_PATIENCE_MS = 90000
// A completed pairing retires the card for good. Hold the green confirmation
// on screen for a beat first: the retirement flag is written immediately, so
// the hold can never resurrect the card on a later launch.
const CARD_PAIRED_HOLD_MS = 6000
const CARD_RETIRED_KEY = 'setup-card-retired'
const CARD_ANNOUNCED_KEY = 'setup-card-announced'
// The setup skill's slash name, dispatched to the gateway by the card's own
// button. The operator is never asked to type it.
const SETUP_COMMAND = 'ocuclaw-setup'
const SETUP_RUN_KEY = 'setup-run'
// A dispatched setup that nobody finished is not a permanent card state — a
// stale record would offer "Open setup chat" for a conversation the operator
// abandoned days ago.
const SETUP_RUN_STALE_MS = 6 * 60 * 60 * 1000
const PRESENTER_CAPABILITY = '__OCUCLAW_DESKTOP_PRESENTER_CAPABILITY__'
const QR_QUIET_ZONE_MODULES = 4
const QR_WATERMARK_FALLBACK = '#667085'
const QR_WATERMARK_MAX_OPACITY = 0.18

// OcuClaw look for Hermes Desktop. Always contributed, so it lists in
// Settings > Appearance next to the built-ins; applied only when the operator
// said yes in /ocuclaw-setup. The gateway renders that answer into the slot
// below (a UTC stamp, or empty) each time it reconciles this file, and
// Hermes Desktop hot-reloads the file on change, so a yes lands without a
// restart. requestTheme() exists from Hermes 0.20.6; older hosts still list
// the theme and the setup receipt tells the operator to pick it by hand.
const THEME_NAME = 'ocuclaw'
const THEME_REQUEST = '__OCUCLAW_DESKTOP_THEME_REQUEST__'
const THEME_REQUEST_APPLIED_KEY = 'theme-request-applied'
const EMOJI_FALLBACK = ', "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol", "Noto Color Emoji", emoji'
const OCUCLAW_THEME_COLORS = Object.freeze({
  background: '#0b0d0a',
  foreground: '#f0f5ea',
  card: '#050f05',
  cardForeground: '#f0f5ea',
  muted: '#141a14',
  mutedForeground: '#898d86',
  popover: '#121f0f',
  popoverForeground: '#f0f5ea',
  primary: '#4dd58a',
  primaryForeground: '#06140c',
  secondary: '#132519',
  secondaryForeground: '#cfe8d4',
  accent: '#101b13',
  accentForeground: '#cfe8d4',
  border: '#222420',
  input: '#353733',
  ring: '#4dd58a',
  midground: '#4dd58a',
  midgroundForeground: '#06140c',
  composerRing: '#4dd58a',
  destructive: '#ff8798',
  destructiveForeground: '#1a0e12',
  sidebarBackground: '#090b08',
  sidebarBorder: '#222420',
  userBubble: '#10230b',
  userBubbleBorder: '#173121',
})
const OCUCLAW_TERMINAL = Object.freeze({
  foreground: '#cfe8d4',
  cursor: '#4dd58a',
  selectionBackground: '#4dd58a47',
  black: '#12160f',
  red: '#ff8798',
  green: '#4dd58a',
  yellow: '#ffb454',
  blue: '#7ad3ff',
  magenta: '#b79bff',
  cyan: '#6fe3c6',
  white: '#cfe8d4',
  brightBlack: '#4a5348',
  brightRed: '#ffb0bd',
  brightGreen: '#8bf0b6',
  brightYellow: '#ffd08a',
  brightBlue: '#a9e4ff',
  brightMagenta: '#d3c1ff',
  brightCyan: '#9df0da',
  brightWhite: '#f0f5ea',
})
// Dark-only on purpose (ocuclaw.com has no light mode): darkColors is the same
// palette, so Hermes' Light/Dark switch keeps the deck instead of synthesising
// a white app from it.
const OCUCLAW_THEME = Object.freeze({
  name: THEME_NAME,
  label: 'OcuClaw',
  description: 'Observation-deck black with the Even G2 lens green. Dark in both modes.',
  colors: OCUCLAW_THEME_COLORS,
  darkColors: OCUCLAW_THEME_COLORS,
  typography: {
    fontSans: "'Inter', 'Segoe WPC', 'Segoe UI', -apple-system, BlinkMacSystemFont, 'SF Pro Text', 'SF Pro Display', system-ui, sans-serif" + EMOJI_FALLBACK,
    fontMono: "'JetBrains Mono', Menlo, Monaco, 'SF Mono', 'Courier Prime', monospace" + EMOJI_FALLBACK,
    fontUrl: 'https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500&display=swap',
  },
  terminal: OCUCLAW_TERMINAL,
  darkTerminal: OCUCLAW_TERMINAL,
})

// Hermes resolves the persisted skin name ONCE, when its ThemeProvider mounts,
// and disk plugins register after that — so a stored pick of this theme reads
// as unknown at boot, paints the default skin, and is never re-resolved even
// though the stored preference still says 'ocuclaw' (verified on 0.20.0).
// These are Hermes' own per-profile appearance keys (themes/context.tsx:
// SKIN_KEY / PROFILE_SKINS_KEY / LAST_PROFILE_KEY); the plugin only READS them.
const STORED_SKIN_KEY = 'hermes-desktop-theme-v2'
const STORED_PROFILE_SKINS_KEY = 'hermes-desktop-profile-themes-v1'
const STORED_ACTIVE_PROFILE_KEY = 'hermes-desktop-active-profile-v1'
const storedSkinIsOurs = () => {
  try {
    const profile = (window.localStorage.getItem(STORED_ACTIVE_PROFILE_KEY) ?? '').trim() || 'default'
    let name = null
    if (profile !== 'default') {
      const record = JSON.parse(window.localStorage.getItem(STORED_PROFILE_SKINS_KEY) || '{}')
      if (record && typeof record === 'object' && typeof record[profile] === 'string') name = record[profile]
    }
    if (name === null) name = window.localStorage.getItem(STORED_SKIN_KEY)
    return name === THEME_NAME
  } catch {
    return false
  }
}

// Re-assert a stored pick of this theme now that it resolves. Idempotent: the
// host's setTheme persists the same name it already holds.
const restoreStoredPick = () => {
  if (typeof sdk.requestTheme !== 'function' || !storedSkinIsOurs()) return false
  return sdk.requestTheme(THEME_NAME) === true
}

const applyThemeRequest = ctx => {
  if (!THEME_REQUEST || typeof sdk.requestTheme !== 'function') return false
  let applied = ''
  try { applied = String(ctx.storage.get(THEME_REQUEST_APPLIED_KEY, '') ?? '') } catch {}
  // Each yes carries a fresh stamp; one stamp applies once, so a later manual
  // theme pick is never overridden by a plugin reload or a gateway restart.
  if (applied === THEME_REQUEST) return false
  if (!sdk.requestTheme(THEME_NAME)) return false
  try { ctx.storage.set(THEME_REQUEST_APPLIED_KEY, THEME_REQUEST) } catch {}
  return true
}

// The card and the presenter are two independent registry contributions, and
// every signal below has to reach both: the card narrates what the presenter
// is doing, and the presenter is summoned by a checkpoint the card also shows.
// A module-local store is the whole mechanism — a shared React context cannot
// span two registry slots — and it doubles as memory across the remounts
// Hermes Desktop performs while its own host state refreshes.
const makeStore = initial => {
  let value = initial
  const listeners = new Set()
  const set = update => {
    value = typeof update === 'function' ? update(value) : update
    listeners.forEach(listener => {
      try { listener(value) } catch {}
    })
  }
  return {
    get: () => value,
    set,
    use: () => {
      const [snapshot, setSnapshot] = useState(value)
      useEffect(() => {
        listeners.add(setSnapshot)
        setSnapshot(value)
        return () => { listeners.delete(setSnapshot) }
      }, [])
      return snapshot
    },
  }
}

// The live ceremony, its window's visibility, and the setup run that leads to
// both. `presenterStore` is now only ever true WITH a ceremony: the presenter
// no longer opens on a click and then waits, so there is no window telling the
// operator to keep it open (#1989 item 2).
const ceremonyStore = makeStore(null)
const presenterStore = makeStore(false)
const viewStore = makeStore('qr')
const IDLE_SETUP_RUN = Object.freeze({ status: 'idle' })
const setupRunStore = makeStore(IDLE_SETUP_RUN)

let setupRunCtx = null

const rememberSetupRun = run => {
  setupRunStore.set(run)
  if (!setupRunCtx) return
  try {
    setupRunCtx.storage.set(SETUP_RUN_KEY, run.status === 'running' ? { v: 1, ...run } : null)
  } catch {}
}

const hydrateSetupRun = ctx => {
  setupRunCtx = ctx
  let stored = null
  try { stored = ctx.storage.get(SETUP_RUN_KEY, null) } catch {}
  if (!stored || typeof stored !== 'object' || stored.v !== 1) return
  if (stored.status !== 'running' || typeof stored.sessionId !== 'string' || !stored.sessionId) return
  if (typeof stored.at !== 'number' || Date.now() - stored.at > SETUP_RUN_STALE_MS) return
  setupRunStore.set({
    status: 'running',
    sessionId: stored.sessionId,
    storedSessionId: typeof stored.storedSessionId === 'string' ? stored.storedSessionId : '',
    at: stored.at,
  })
}

// The gateway resolves a skill slash command to the body the model actually
// reads; `type` is 'skill' for a skill command and 'send' for the quick/bundle
// shapes that share the directive.
const skillMessage = result => {
  if (!result || typeof result !== 'object') return ''
  if (result.type !== 'skill' && result.type !== 'send') return ''
  return typeof result.message === 'string' ? result.message.trim() : ''
}

// Exactly the two-step Hermes Desktop performs for a skill command typed into
// the composer: `slash.exec` resolves it, `command.dispatch` is the documented
// fallback when the slash worker refuses the route. Submitting the literal
// "/ocuclaw-setup" as prompt text is NOT equivalent — the gateway re-expands a
// slash invocation only on a rewind replay (methods_prompt gates that on
// `has_truncation`), so the model would receive the bare literal string and no
// skill at all.
const resolveSetupInvocation = async sessionId => {
  let message = ''
  try {
    message = skillMessage(await sdk.host.request('slash.exec', { session_id: sessionId, command: SETUP_COMMAND }))
  } catch {}
  if (!message) {
    message = skillMessage(await sdk.host.request('command.dispatch', { session_id: sessionId, name: SETUP_COMMAND, arg: '' }))
  }
  if (!message) throw new Error(`the gateway did not resolve /${SETUP_COMMAND}`)
  return message
}

// "Pair your glasses" — the whole hand-off (#1989 item 3). The card mints the
// chat, hands the operator to it, and dispatches the setup skill into it. The
// operator types nothing and reads no instructions.
const dispatchSetup = async () => {
  setupRunStore.set({ status: 'dispatching' })
  try {
    const created = await sdk.host.request('session.create', { cols: 96, source: 'desktop' })
    const sessionId = String((created && created.session_id) || '')
    if (!sessionId) throw new Error('session.create returned no runtime session')
    const storedSessionId = String((created && created.stored_session_id) || '') || sessionId
    const message = await resolveSetupInvocation(sessionId)
    await sdk.host.request('prompt.submit', { session_id: sessionId, text: message })
    rememberSetupRun({ status: 'running', sessionId, storedSessionId, at: Date.now() })
    // Hand off AFTER the submit, not before. Proved on a throwaway 0.20.6
    // Desktop: opening a just-minted session that still holds no message is a
    // no-op — the card flipped to "Setup running…" while the operator sat on
    // the empty home screen. Once the turn exists the same call lands on the
    // chat, transcript and all.
    openSetupChat()
  } catch (error) {
    rememberSetupRun({ status: 'failed' })
    try { sdk.host.notifyError(error, `/${SETUP_COMMAND} could not be started in a chat.`) } catch {}
  }
}

const openSetupChat = () => {
  const run = setupRunStore.get()
  const target = run.storedSessionId || run.sessionId
  if (!target || typeof sdk.host.openSession !== 'function') return
  try { void Promise.resolve(sdk.host.openSession(target, { intent: 'in-place' })).catch(() => undefined) } catch {}
}

// ── The pairing watch ────────────────────────────────────────────────────
// One module-local poller, owned by the presenter contribution, which is now
// always mounted (see the register() note). It claims the setup tool's pairing
// checkpoint and summons the window at the exact moment the QR exists — the
// operator is never asked to hold anything open waiting for it.
let watchApi = null
let watchTimer = null
let watchMounted = 0

const scheduleWatch = delay => {
  window.clearTimeout(watchTimer)
  if (!watchMounted) return
  watchTimer = window.setTimeout(() => void watchTick(), delay)
}

const claimDelay = () => (setupRunStore.get().status === 'running' ? CLAIM_INTERVAL_MS : CLAIM_IDLE_INTERVAL_MS)

const watchTick = async () => {
  if (!watchMounted || !watchApi) return
  const current = ceremonyStore.get()

  if (!current) {
    let claimed = null
    try {
      claimed = await watchApi('/pairing/claim', { method: 'POST', body: { presenterCapability: PRESENTER_CAPABILITY }, timeoutMs: 2500 })
    } catch {}
    if (!watchMounted) return
    if (claimed && claimed.active) {
      const adopted = adoptClaim(claimed)
      if (adopted) {
        ceremonyStore.set(adopted)
        // The one place the window is summoned: the checkpoint is live.
        presenterStore.set(true)
        scheduleWatch(STATE_INTERVAL_MS)
        return
      }
    }
    scheduleWatch(claimDelay())
    return
  }

  // A delivered terminal outcome has nothing left to poll; clearing the
  // ceremony restarts the claim loop.
  if (current.phase === 'outcome' && current.callbackDelivered !== false) return

  try {
    const next = await watchApi(`/pairing/${encodeURIComponent(current.sessionId)}`, {
      method: 'POST',
      body: { op: 'state', presenterCapability: PRESENTER_CAPABILITY },
      timeoutMs: 5000,
    })
    if (!watchMounted) return
    mergeCeremony(next)
  } catch {
    if (!watchMounted) return
    ceremonyStore.set(live => (live ? { ...live, message: 'The local pairing controller could not be reached; retrying…' } : live))
  }
  scheduleWatch(STATE_INTERVAL_MS)
}

const adoptClaim = claimed => {
  if (claimed.phase === 'outcome' || claimed.phase === 'words' || claimed.phase === 'deciding') return claimed
  const parsed = splitBootstrap(claimed.bootstrapBlock)
  if (!parsed) return null
  viewStore.set('qr')
  return { ...claimed, ...parsed, phase: 'qr' }
}

// Merge a state reply into the live ceremony, re-summoning the window on the
// two phases the operator MUST see: the four-word confirmation they have to
// approve, and the outcome that ends the ceremony.
const mergeCeremony = next => {
  ceremonyStore.set(live => {
    if (!live) return live
    const merged = { ...live, ...next }
    if (merged.phase !== live.phase && (merged.phase === 'words' || merged.phase === 'outcome')) presenterStore.set(true)
    return merged
  })
}

const clearCeremony = () => {
  ceremonyStore.set(null)
  presenterStore.set(false)
  scheduleWatch(0)
}

const usePairingWatch = api => {
  useEffect(() => {
    watchApi = api
    watchMounted += 1
    scheduleWatch(0)
    return () => {
      watchMounted -= 1
      if (!watchMounted) window.clearTimeout(watchTimer)
    }
  }, [api])
}

// Normalized from the visible alpha bounds of the supplied 1024px OcuClaw
// mark, removing the transparent canvas offset. Each bit is one square logo
// pixel and expands to an exact 2x2 QR-module cell.
const OCUCLAW_PIXEL_LOGO = Object.freeze([
  '00000000111100000000',
  '00000001111100000000',
  '00011111101100000000',
  '00011110001100000000',
  '01100000011100000000',
  '01100000011100000000',
  '01100000111001111000',
  '01100000111001111000',
  '11100000111001111100',
  '11000000011111000110',
  '11000000111111000110',
  '11000000111011000110',
  '11000000011111000111',
  '11000000111111000011',
  '11000000111111000011',
  '11000000111111000111',
  '11000000001100000110',
  '11000000001100000110',
  '11000000000000000110',
  '11000000000000111100',
  '11000000000000111100',
  '11100000000000111100',
  '01110000000001111100',
  '01110000000001111100',
  '00111111000011111000',
  '00111111100011000000',
  '00000001100011000000',
])

const clean = value => [...String(value ?? '')]
  .map(character => {
    const code = character.codePointAt(0) ?? 0
    return code < 32 || (code >= 127 && code <= 159) ? ' ' : character
  })
  .join('')
  .slice(0, 240)

const splitBootstrap = block => {
  const lines = String(block ?? '').split('\n')
  const scanIndex = lines.indexOf('  Scan this code with the Even app:')
  const manualIndex = lines.indexOf('  Or pair manually — in the Even app, choose "Enter manually":')
  const addressLine = lines.find(line => line.startsWith('    Address:'))
  const codeLine = lines.find(line => line.startsWith('    Pairing code:'))
  const qrLines = scanIndex >= 0 && manualIndex > scanIndex ? lines.slice(scanIndex + 2, manualIndex - 1) : []
  const width = Math.max(0, ...qrLines.map(line => [...line].length))
  if (qrLines.length < 10 || width < 10 || qrLines.some(line => [...line].length !== width) || !addressLine || !codeLine) return null
  return { qrLines, addressLine: clean(addressLine.trim()), codeLine: clean(codeLine.trim()) }
}

const paintPixelLogoWatermark = (context, cols, rows, scale) => {
  const logoModuleScale = 2
  const logoWidth = OCUCLAW_PIXEL_LOGO[0].length * logoModuleScale
  const logoHeight = OCUCLAW_PIXEL_LOGO.length * logoModuleScale
  const logoLeft = Math.floor((cols - logoWidth) / 2)
  const logoTop = Math.floor((rows - logoHeight) / 2)
  if (
    logoLeft < QR_QUIET_ZONE_MODULES ||
    logoTop < QR_QUIET_ZONE_MODULES ||
    cols - logoLeft - logoWidth < QR_QUIET_ZONE_MODULES ||
    rows - logoTop - logoHeight < QR_QUIET_ZONE_MODULES
  ) return false

  const themeAccent = getComputedStyle(context.canvas)
    .getPropertyValue('--ui-accent')
    .trim()
  context.save()
  context.globalAlpha = QR_WATERMARK_MAX_OPACITY
  context.fillStyle = QR_WATERMARK_FALLBACK
  if (themeAccent) context.fillStyle = themeAccent
  // A pure-white accent would erase the mark, so retain the neutral fallback.
  if (context.fillStyle === '#ffffff' || context.fillStyle === 'rgb(255, 255, 255)') {
    context.fillStyle = QR_WATERMARK_FALLBACK
  }
  OCUCLAW_PIXEL_LOGO.forEach((row, y) => {
    ;[...row].forEach((cell, x) => {
      if (cell !== '1') return
      context.fillRect(
        (logoLeft + x * logoModuleScale) * scale,
        (logoTop + y * logoModuleScale) * scale,
        logoModuleScale * scale,
        logoModuleScale * scale,
      )
    })
  })
  context.restore()
  return true
}

function QrCanvas({ lines }) {
  const canvasRef = useRef(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !Array.isArray(lines) || lines.length === 0) return
    const rows = lines.length * 2
    const cols = Math.max(...lines.map(line => [...line].length))
    const scale = Math.max(3, Math.min(7, Math.floor(420 / Math.max(cols, rows))))
    canvas.width = cols * scale
    canvas.height = rows * scale
    const context = canvas.getContext('2d')
    if (!context) return
    context.imageSmoothingEnabled = false
    context.fillStyle = '#ffffff'
    context.fillRect(0, 0, canvas.width, canvas.height)
    paintPixelLogoWatermark(context, cols, rows, scale)
    context.fillStyle = '#000000'
    lines.forEach((line, y) => {
      ;[...line].forEach((cell, x) => {
        if (cell === '█' || cell === '▀') context.fillRect(x * scale, y * 2 * scale, scale, scale)
        if (cell === '█' || cell === '▄') context.fillRect(x * scale, (y * 2 + 1) * scale, scale, scale)
      })
    })
  }, [lines])

  return jsx('div', {
    style: { display: 'flex', justifyContent: 'center', overflow: 'auto', padding: 12, background: '#ffffff', borderRadius: 8 },
    children: jsx('canvas', { ref: canvasRef, role: 'img', 'aria-label': 'OcuClaw phone pairing QR code', style: { maxWidth: '100%', height: 'auto' } }),
  })
}

function PairingDialog({ api }) {
  usePairingWatch(api)
  const opened = presenterStore.use()
  const ceremony = ceremonyStore.use()
  const view = viewStore.use()
  const busy = ceremony?.phase === 'deciding'

  const command = async op => {
    const sessionId = ceremony?.sessionId
    if (!sessionId) return
    const deciding = op === 'approve'
      ? 'Approving and waiting for the phone…'
      : op === 'cancel' ? 'Stopping this pairing…' : 'Refusing this phone…'
    ceremonyStore.set(current => current ? { ...current, phase: 'deciding', message: deciding } : current)
    try {
      const next = await api(`/pairing/${encodeURIComponent(sessionId)}`, { method: 'POST', body: { op, presenterCapability: PRESENTER_CAPABILITY }, timeoutMs: 5000 })
      mergeCeremony(next)
    } catch {
      ceremonyStore.set(current => current ? { ...current, phase: 'outcome', outcomeState: 'failed', message: 'The local pairing controller could not be reached.' } : current)
    }
    scheduleWatch(STATE_INTERVAL_MS)
  }

  // Hiding is not stopping. A live exchange is a 120-second clock the operator
  // cannot restart by reopening a window, so the window never takes the
  // ceremony down with it — only "Stop pairing" does. The card carries a
  // "Show QR" action back (#1989 item 1).
  const hide = () => presenterStore.set(false)

  let body
  let title = 'Pair OcuClaw phone'
  if (ceremony?.phase === 'qr') {
    body = view === 'manual'
      ? jsxs('div', { style: { display: 'grid', gap: 10 }, children: [
          jsx('p', { children: 'In the OcuClaw phone app, choose Enter manually:' }),
          jsx('code', { style: { overflowWrap: 'anywhere' }, children: ceremony.addressLine }),
          jsx('code', { children: ceremony.codeLine }),
          jsx('p', { style: { color: 'var(--ui-text-tertiary)' }, children: 'This is the same one-time encrypted exchange. The screen advances automatically.' }),
        ] })
      : jsxs('div', { style: { display: 'grid', gap: 10 }, children: [
          jsx(QrCanvas, { lines: ceremony.qrLines }),
          jsx('p', { style: { textAlign: 'center' }, children: 'Scan this QR in the OcuClaw phone app. The screen advances automatically.' }),
        ] })
  } else if (ceremony?.phase === 'words') {
    body = jsxs('div', { style: { display: 'grid', gap: 14 }, children: [
      jsx('p', { children: `Phone: ${clean(ceremony.phoneLabel) || 'unknown device'}` }),
      jsx('div', { style: { padding: 16, textAlign: 'center', fontSize: 20, fontWeight: 650, letterSpacing: '0.04em', background: 'var(--ui-bg-tertiary)', borderRadius: 8 }, children: clean(ceremony.phrase) }),
      jsx('p', { children: 'Approve only if all four words match in order on the phone.' }),
    ] })
  } else if (ceremony?.phase === 'deciding') {
    body = jsxs('div', { style: { display: 'flex', alignItems: 'center', gap: 10 }, children: [jsx(GlyphSpinner, {}), jsx('span', { children: ceremony.message })] })
  } else if (ceremony?.phase === 'outcome') {
    title = ceremony.outcomeState === 'completed' ? 'Phone paired' : 'Pairing stopped'
    body = jsx('p', { children: ceremony.message || (ceremony.outcomeState === 'completed' ? 'The phone connected back and the managed gateway confirmed it.' : 'Nothing was approved. You can retry this setup checkpoint.') })
  }

  // No idle state exists any more. The window has exactly one reason to be on
  // screen — a live ceremony — so it can never be the thing that tells the
  // operator to keep it open (#1989 item 2).
  const open = Boolean(ceremony) && opened
  return jsx(Dialog, {
    open,
    // A terminal outcome is done with; anything else is only hidden.
    onOpenChange: next => { if (!next) (ceremony.phase === 'outcome' ? clearCeremony : hide)() },
    children: open ? jsxs(DialogContent, {
      showCloseButton: ceremony.phase === 'qr' || ceremony.phase === 'outcome',
      fitContent: true,
      style: { width: 'min(92vw, 560px)' },
      // #1989 item 1. Radix's DismissableLayer closes a Dialog on any
      // pointer-down or focus landing outside it, so clicking back into the
      // chat — or letting the OS move focus — took the pairing window down
      // while its own copy asked the operator to keep it open. Both are
      // prevented: this window is dismissed by its own controls or not at all.
      onPointerDownOutside: event => event.preventDefault(),
      onFocusOutside: event => event.preventDefault(),
      onInteractOutside: event => event.preventDefault(),
      onEscapeKeyDown: event => { if (busy || ceremony.phase === 'words') event.preventDefault() },
      children: [
        jsx(DialogHeader, { children: jsx(DialogTitle, { children: title }) }),
        body,
        ceremony.phase === 'qr' ? jsxs(DialogFooter, { children: [
          jsx(Button, { variant: 'outline', onClick: () => void command('cancel'), children: 'Stop pairing' }),
          jsx(Button, { variant: 'outline', onClick: hide, children: 'Hide' }),
          jsx(Button, { variant: 'secondary', onClick: () => viewStore.set(current => current === 'qr' ? 'manual' : 'qr'), children: view === 'qr' ? 'Enter manually' : 'Show QR' }),
        ] }) : null,
        ceremony.phase === 'words' ? jsxs(DialogFooter, { children: [
          jsx(Button, { variant: 'outline', onClick: () => void command('deny'), children: 'No — refuse this phone' }),
          jsx(Button, { onClick: () => void command('approve'), children: 'Yes — all four words match' }),
        ] }) : null,
        ceremony.phase === 'outcome' ? jsx(DialogFooter, { children: jsx(Button, { onClick: clearCeremony, children: 'Done' }) }) : null,
      ],
    }) : null,
  })
}

const readFlag = (ctx, key) => {
  try { return ctx.storage.get(key, false) === true } catch { return false }
}

const writeFlag = (ctx, key) => {
  try { ctx.storage.set(key, true) } catch {}
}

// The card's own dot. The titlebar has no room for prose, so the colour is
// doing the "down vs up" work and the label says which is which.
const Dot = ({ color }) => jsx('span', {
  'aria-hidden': 'true',
  style: { width: 7, height: 7, borderRadius: '50%', background: color, flex: '0 0 auto' },
})

// Post-install card. Rides `titleBar.right` — the only always-mounted
// arbitrary-React chrome slot. The status bar was the obvious home and is the
// wrong one: it ships OFF by default and is unmounted while off, so the users
// who most need this card are exactly the ones who would never see it.
// Is the agent mid-turn in the setup chat? The atom is subscribed by hand
// rather than through the SDK's `useValue` so an older host that never grew
// `state.busyBySession` degrades to "not busy" instead of throwing in a hook.
const useSessionBusy = sessionId => {
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    setBusy(false)
    const atom = sdk.host && sdk.host.state && sdk.host.state.busyBySession
    if (!sessionId || !atom || typeof atom.subscribe !== 'function') return undefined
    let unsubscribe = null
    try {
      unsubscribe = atom.subscribe(value => setBusy(Boolean(value && value[sessionId])))
    } catch {
      return undefined
    }
    return () => { try { unsubscribe() } catch {} }
  }, [sessionId])
  return busy
}

function SetupCard({ ctx, api }) {
  const [retired, setRetired] = useState(() => readFlag(ctx, CARD_RETIRED_KEY))
  const [phase, setPhase] = useState('unknown')
  const restartedAtRef = useRef(0)
  const setupRun = setupRunStore.use()
  const ceremony = ceremonyStore.use()
  const presenterOpen = presenterStore.use()
  const agentBusy = useSessionBusy(setupRun.status === 'running' ? setupRun.sessionId : '')

  useEffect(() => {
    if (retired) return undefined
    let disposed = false
    let timer = null

    const probe = async () => {
      // Two different questions, two different owners.
      //
      // "Did the gateway load OcuClaw?" is gateway-owned, and the ONLY honest
      // source is the gateway's own runtime status: it writes
      // gateway_state.json, which the host surfaces as `gateway_platforms`.
      // This deliberately does NOT ask the platform package's own dashboard
      // router: that router is mounted by the WEB SERVER at ITS startup and
      // gated per-request only by plugins.enabled, so it is not a fact about
      // the gateway at all. Proved live on 0.20.6 — with the gateway process
      // stopped, GET /api/plugins/ocuclaw/setup-card answered 200 while the
      // same host reported gateway_running:false, gateway_state:"stopped".
      // An earlier draft of this card trusted that reply and would have told
      // the user "OcuClaw ready" with no gateway running at all. Worse, the
      // reverse also held: a gateway restart never remounts that router, so a
      // card waiting on it would have hung on the failure copy forever.
      let running = false
      let loaded = false
      try {
        const status = await sdk.host.status()
        const platforms = (status && status.gateway_platforms) || null
        running = Boolean(status && status.gateway_running)
        // PRESENCE, not `state === 'connected'`. Before any glasses are paired
        // the relay link is legitimately down — the throwaway 0.20.6 gateway
        // reported ocuclaw as "retrying" the moment it loaded the plugin — and
        // demanding a healthy link would strand the card on the very screen
        // whose whole job is to get the user TO pairing.
        loaded = Boolean(platforms && Object.prototype.hasOwnProperty.call(platforms, PLATFORM_ID))
      } catch {}
      if (disposed) return

      if (running && loaded) {
        restartedAtRef.current = 0
        // Only now is the receipt worth asking for, and the router is the only
        // thing that has it. Unreachable or malformed => treat as NOT paired:
        // the card staying up is the safe direction, a false retirement is not.
        let paired = false
        try {
          const payload = await api('/setup-card', { method: 'GET', timeoutMs: CARD_PROBE_TIMEOUT_MS })
          if (payload && payload.contract === 'ocuclaw.desktop-setup-card') paired = payload.paired === true
        } catch {}
        if (disposed) return

        if (paired) {
          // Written NOW, not when the hold expires: the flag is what keeps a
          // paired host from ever flashing this card again, and the hold is
          // only the green confirmation the operator earned (#1989 item 4).
          writeFlag(ctx, CARD_RETIRED_KEY)
          rememberSetupRun(IDLE_SETUP_RUN)
          setPhase('paired')
          timer = window.setTimeout(() => { if (!disposed) setRetired(true) }, CARD_PAIRED_HOLD_MS)
          return
        }
        setPhase('ready')
        // Nothing left to detect but a human walking through the ceremony, so
        // stop polling at restart speed — the card is installed-state chrome,
        // not a progress bar, and it may sit here for days.
        timer = window.setTimeout(() => void probe(), CARD_IDLE_INTERVAL_MS)
        return
      } else if (!restartedAtRef.current) {
        if (!readFlag(ctx, CARD_ANNOUNCED_KEY)) {
          writeFlag(ctx, CARD_ANNOUNCED_KEY)
          // In-app channel on purpose: an OS notification is suppressed while
          // Hermes is focused, and the user has just clicked through the
          // install modal, so Hermes is exactly what they are looking at.
          try {
            sdk.host.notify({
              kind: 'info',
              title: 'OcuClaw installed',
              message: 'Restart the gateway to finish setting up OcuClaw.',
            })
          } catch {}
        }
        setPhase('needs-restart')
      } else {
        setPhase(Date.now() - restartedAtRef.current < RESTART_PATIENCE_MS ? 'restarting' : 'stalled')
      }
      timer = window.setTimeout(() => void probe(), CARD_PROBE_INTERVAL_MS)
    }

    void probe()
    return () => { disposed = true; window.clearTimeout(timer) }
  }, [api, ctx, retired])

  if (retired || phase === 'unknown') return null

  const restart = () => {
    restartedAtRef.current = Date.now()
    setPhase('restarting')
    // Upstream annotates runGatewayRestart "Self-contained and never rejects":
    // it catches and toasts, and its own poll gives up after 18 x 1200ms
    // (~21.6s) returning normally whether or not the gateway came back. So its
    // resolution is evidence of nothing. The probe above owns the up/down
    // claim; this is only the trigger — which is also why RESTART_PATIENCE_MS
    // sits well past that ~21.6s window: the host giving up polling is not the
    // same event as the gateway failing to return.
    try { void Promise.resolve(sdk.host.restartGateway()).catch(() => undefined) } catch {}
  }

  let dot = 'var(--ui-text-tertiary)'
  let label = 'OcuClaw installed'
  let action = null

  if (phase === 'needs-restart') {
    dot = '#ffb454'
    action = jsx(Button, { size: 'xs', onClick: restart, children: 'Restart gateway' })
  } else if (phase === 'restarting') {
    label = 'Restarting gateway…'
    action = jsx(GlyphSpinner, {})
  } else if (phase === 'stalled') {
    dot = '#ff8798'
    label = 'Gateway did not come back'
    action = jsx(Button, { size: 'xs', variant: 'outline', onClick: restart, children: 'Try again' })
  } else if (phase === 'paired') {
    dot = '#4dd58a'
    label = 'Glasses paired'
  } else if (phase === 'ready') {
    // #1989 item 4: one live ladder, read off the same checkpoint the
    // presenter watches. Ordered by how far the journey has actually got, so
    // the most advanced true statement wins.
    dot = '#4dd58a'
    if (ceremony && ceremony.phase !== 'outcome') {
      label = ceremony.phase === 'words' ? 'Confirm the four words' : 'Waiting for the phone to scan'
      action = presenterOpen
        ? jsx(GlyphSpinner, {})
        : jsx(Button, { size: 'xs', onClick: () => presenterStore.set(true), children: 'Show QR' })
    } else if (setupRun.status === 'dispatching') {
      label = 'Starting setup…'
      action = jsx(GlyphSpinner, {})
    } else if (setupRun.status === 'running') {
      // The card never claims a step it cannot see. Busy vs idle in the setup
      // chat is the honest resolution the host actually exposes.
      label = agentBusy ? 'Setup running…' : 'Waiting for setup…'
      action = jsx(Button, { size: 'xs', variant: 'outline', onClick: openSetupChat, children: 'Open setup chat' })
    } else if (setupRun.status === 'failed') {
      dot = '#ffb454'
      label = 'Setup did not start'
      action = jsx(Button, { size: 'xs', variant: 'outline', onClick: () => void dispatchSetup(), children: 'Try again' })
    } else {
      label = 'OcuClaw ready'
      action = jsx(Button, { size: 'xs', onClick: () => void dispatchSetup(), children: 'Pair your glasses' })
    }
  }

  return jsxs('div', {
    role: 'status',
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 8,
      padding: '2px 8px',
      marginRight: 6,
      borderRadius: 4,
      border: '1px solid var(--ui-border, rgba(127,127,127,0.3))',
      background: 'var(--ui-bg-tertiary)',
      fontSize: 11,
      whiteSpace: 'nowrap',
      WebkitAppRegion: 'no-drag',
    },
    children: [
      jsx(Dot, { color: dot }),
      jsx('span', { children: label }),
      action,
    ],
  })
}

export default {
  id: 'ocuclaw',
  name: 'OcuClaw',
  register(ctx) {
    const api = (path, options) => ctx.rest(path, options)
    hydrateSetupRun(ctx)
    // The presenter used to ride `statusBar.right`, and that was a latent
    // dead end: upstream unmounts the whole status bar — not just hides it —
    // while it is toggled off (contrib/controller.tsx: `{statusbarVisible &&
    // <WiredPane part="statusbar" />}`), and it ships off. On such a host the
    // presenter never mounted, so the pairing claim never ran and the card's
    // button had nothing to open. Since #1989 the presenter must poll on its
    // own and summon itself, so it moves to the same always-mounted titlebar
    // slot as the card. It renders no inline chrome — a portalled Dialog and
    // nothing else — so it costs the titlebar no width.
    ctx.register({
      id: 'pairing-presenter',
      area: TITLEBAR_AREAS.right,
      order: 39,
      render: () => jsx(PairingDialog, { api }),
    })
    ctx.register({
      id: 'setup-card',
      area: TITLEBAR_AREAS.right,
      order: 40,
      render: () => jsx(SetupCard, { ctx, api }),
    })
    ctx.register({ id: 'theme', area: THEMES_AREA, data: OCUCLAW_THEME })
    restoreStoredPick()
    applyThemeRequest(ctx)
  },
}

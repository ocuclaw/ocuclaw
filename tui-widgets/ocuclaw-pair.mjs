// OCUCLAW-OWNED-TUI-PAIRING-WIDGET v1
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { readFileSync } from 'node:fs'

// Preloaded inertly by OcuClaw. It opens only while the setup tool owns the
// fixed loopback activation endpoint. It never contains or transmits the Relay
// Credential; the activation server proxies credentialed relay control.

const ACTIVATION_URL = 'http://127.0.0.1:47802/_ocuclaw/tui-pairing/v1'
const ACTIVATION_OWNER_HEADER = 'x-ocuclaw-tui-owner-pid'
const ACTIVATION_SURFACE_HEADER = 'x-ocuclaw-pairing-surface'
const ACTIVATION_CONTROL_HEADER = 'x-ocuclaw-tui-control-capability'
const ACTIVATION_CHALLENGE_HEADER = 'x-ocuclaw-tui-activation-challenge'
const ACTIVATION_SERVER_CHALLENGE_HEADER = 'x-ocuclaw-tui-server-challenge'
const ACTIVATION_CLAIM_PROOF_HEADER = 'x-ocuclaw-tui-claim-proof'
const PRESENTER_CAPABILITY_URL = new URL('../state/ocuclaw.tui-pairing-capability.json', import.meta.url)
const AUTO_ACTIVATION = '__ocuclaw_auto_activation__'
const QR_QUIET_ZONE_MODULES = 4
const QR_WATERMARK_BOTTOM_GUARD_ROWS = 1
const QR_WATERMARK_FALLBACK = '#d9dde1'
const QR_WATERMARK_OPACITY = 0.30
const TERMINAL_PAIRING_STATES = new Set(['completed', 'failed', 'cancelled', 'refused'])

// Normalized from the visible alpha bounds of the supplied 1024px OcuClaw
// mark (the artwork itself sits off-centre in that source canvas). Each bit is
// one square logo pixel. The terminal expands it to two columns by one row,
// which is a square 2x2 QR-module cell on a typical 2:1 terminal cell grid.
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
// The terminal needs one additional white row below the mark because one
// glyph spans two QR-module rows. Collapse a duplicated interior logo row
// here while preserving the shared canonical pixel source used by Desktop.
const TUI_PIXEL_LOGO = Object.freeze(OCUCLAW_PIXEL_LOGO.filter((_, index) => index !== 23))

let config = null
let controlSecret = ''
let pollTimer = null
let decisionStarted = false
let sizeCancellationStarted = false
let cancelRequested = false
let activationProbeRunning = false
let pairingActive = false

const clean = value => String(value ?? '').replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').slice(0, 240)
const requiredColumns = block => Math.max(0, ...String(block).split('\n').map(line => [...line].length))
// Dialog adds two border rows, two vertical-padding rows, two title rows,
// two hint rows, plus the blank and two instruction rows below the QR.
const requiredRows = block => String(block).split('\n').length + 11
const blendWithWhite = (value, opacity = QR_WATERMARK_OPACITY) => {
  const source = String(value ?? '').trim()
  const short = /^#([0-9a-f]{3})$/i.exec(source)
  const full = /^#([0-9a-f]{6})$/i.exec(source)
  const hex = full?.[1] || (short ? [...short[1]].map(digit => digit + digit).join('') : '')
  if (!hex) return QR_WATERMARK_FALLBACK
  const channels = [0, 2, 4].map(offset => Number.parseInt(hex.slice(offset, offset + 2), 16))
  const blended = channels.map(channel => Math.round(255 + (channel - 255) * opacity))
  if (blended.every(channel => channel === 255)) return QR_WATERMARK_FALLBACK
  return `#${blended.map(channel => channel.toString(16).padStart(2, '0')).join('')}`
}
const pixelLogoCell = (x, y, cols, rows) => {
  const logoWidth = TUI_PIXEL_LOGO[0].length * 2
  const logoHeight = TUI_PIXEL_LOGO.length
  const logoLeft = Math.floor((cols - logoWidth) / 2)
  const logoTop = Math.floor((rows - logoHeight) / 2)
  const rightQuietModules = cols - logoLeft - logoWidth
  const bottomQuietModules = (rows - logoTop - logoHeight) * 2
  if (
    logoLeft < QR_QUIET_ZONE_MODULES ||
    logoTop * 2 < QR_QUIET_ZONE_MODULES ||
    rightQuietModules < QR_QUIET_ZONE_MODULES ||
    bottomQuietModules < QR_QUIET_ZONE_MODULES + QR_WATERMARK_BOTTOM_GUARD_ROWS * 2
  ) return false
  const logoX = Math.floor((x - logoLeft) / 2)
  const logoY = y - logoTop
  return logoY >= 0 && logoY < logoHeight && logoX >= 0 && logoX < TUI_PIXEL_LOGO[logoY].length
    ? TUI_PIXEL_LOGO[logoY][logoX] === '1'
    : false
}
const qrWatermarkRuns = (block, watermarkColor) => {
  const lines = String(block).split('\n')
  const cols = requiredColumns(block)
  return lines.map((line, y) => {
    const runs = []
    ;[...line].forEach((cell, x) => {
      // A terminal glyph carries two QR rows. Only an all-white pair can show
      // the pale mark; black and half-black QR glyphs remain canonical.
      const backgroundColor = cell === ' ' && pixelLogoCell(x, y, cols, lines.length)
        ? watermarkColor
        : '#ffffff'
      const previous = runs[runs.length - 1]
      if (previous?.backgroundColor === backgroundColor) previous.text += cell
      else runs.push({ text: cell, backgroundColor })
    })
    return runs
  })
}
const splitBootstrap = block => {
  const lines = String(block).split('\n')
  const scanIndex = lines.indexOf('  Scan this code with the Even app:')
  const manualIndex = lines.indexOf('  Or pair manually — in the Even app, choose "Enter manually":')
  const addressLine = lines.find(line => line.startsWith('    Address:'))
  const codeLine = lines.find(line => line.startsWith('    Pairing code:'))
  const qrLines = scanIndex >= 0 && manualIndex > scanIndex ? lines.slice(scanIndex + 2, manualIndex - 1) : []
  const qrWidth = requiredColumns(qrLines.join('\n'))
  if (qrLines.length < 10 || qrWidth < 10 || qrLines.some(line => [...line].length !== qrWidth) || !addressLine || !codeLine) return null
  return {
    qrBlock: qrLines.join('\n'),
    addressLine: clean(addressLine.trim()),
    codeLine: clean(codeLine.trim()),
  }
}
const terminalCode = body => {
  const raw = clean(body?.failure?.reason).toLowerCase().replace(/[^a-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '')
  return raw.slice(0, 80) || (body?.state === 'completed' ? 'paired' : 'pairing_failed')
}

const validActivation = value => {
  if (!value || value.v !== 1 || !Number.isFinite(value.expiresAtMs) || value.expiresAtMs <= Date.now()) return false
  for (const key of ['address', 'controlUrl', 'controlToken', 'callbackUrl', 'callbackToken', 'runId']) {
    if (typeof value[key] !== 'string' || value[key].length < 1 || value[key].length > 2048) return false
  }
  return value.controlUrl.startsWith('http://127.0.0.1:') && value.callbackUrl.startsWith(`${ACTIVATION_URL}/result/`)
}
const activationProof = (value, challenge, credential) => createHmac('sha256', credential).update(JSON.stringify([
  challenge,
  value.v,
  value.surface,
  value.address,
  value.controlUrl,
  value.controlToken,
  value.callbackUrl,
  value.callbackToken,
  value.runId,
  value.expiresAtMs,
])).digest()
const authenticActivation = (value, challenge, credential) => {
  if (!credential || typeof value?.activationMac !== 'string' || !/^[0-9a-f]{64}$/i.test(value.activationMac)) return false
  const expected = activationProof(value, challenge, credential)
  const received = Buffer.from(value.activationMac, 'hex')
  return received.length === expected.length && timingSafeEqual(received, expected)
}
const claimProof = (serverChallenge, clientChallenge, ownerPid, credential) => createHmac('sha256', credential).update(JSON.stringify([
  'claim', serverChallenge, clientChallenge, ownerPid, 'tui',
])).digest('hex')
const presenterToken = () => {
  try {
    const parsed = JSON.parse(readFileSync(PRESENTER_CAPABILITY_URL, 'utf8'))
    return parsed?.v === 1 && typeof parsed.token === 'string' && /^[A-Za-z0-9_-]{43}$/.test(parsed.token)
      ? parsed.token
      : ''
  } catch {
    return ''
  }
}

export default function register(sdk) {
  const { Dialog, Overlay, Text, defineWidgetApp, h } = sdk
  let app

  const setState = patch => sdk.updateWidget(app, state => ({ ...state, ...patch }))

  const control = async op => {
    const current = config
    if (!current || Date.now() >= current.expiresAtMs) throw new Error('pairing_activation_expired')
    const headers = {
      'content-type': 'application/json',
      [ACTIVATION_CONTROL_HEADER]: current.controlToken,
    }
    if (controlSecret) headers['x-ocuclaw-pair-control-secret'] = controlSecret
    const body = op === 'create'
      // The widget paints the QR as black on white below, independently of
      // the surrounding TUI theme. Ask the canonical renderer for the matching
      // light-terminal polarity so spaces stay white and block glyphs stay black.
      ? { v: 1, op, address: current.address, lightTerminal: true }
      : { v: 1, op }
    const response = await fetch(current.controlUrl, { method: 'POST', headers, body: JSON.stringify(body) })
    let parsed = {}
    try { parsed = await response.json() } catch {}
    return { status: response.status, body: parsed }
  }

  const outcome = body => {
    clearTimeout(pollTimer)
    controlSecret = ''
    const state = clean(body?.state) || 'failed'
    const code = terminalCode(body)
    const ok = state === 'completed'
    setState({
      phase: 'outcome',
      outcomeState: ok ? 'completed' : (state === 'failed' ? 'failed' : 'cancelled'),
      code,
      title: ok ? 'Phone paired' : 'Pairing stopped',
      message: ok
        ? 'The phone connected back and the managed gateway confirmed it.'
        : clean(body?.failure?.message) || 'Nothing was approved. You can retry this setup checkpoint.',
    })
  }

  const fail = (code, message) => outcome({ state: 'failed', failure: { reason: code, message } })

  const schedulePoll = () => {
    clearTimeout(pollTimer)
    pollTimer = setTimeout(() => void poll(), 650)
  }

  const poll = async () => {
    try {
      const { status, body } = await control('state')
      if (status !== 200) return fail('state_refused', `The relay refused the pairing status check (${status}).`)
      if (TERMINAL_PAIRING_STATES.has(body.state)) return outcome(body)
      if (body.prompt?.safetyPhraseText) {
        const phoneLabel = clean(body.prompt.phoneLabel) || 'unknown device'
        const phrase = clean(body.prompt.safetyPhraseText)
        sdk.updateWidget(app, state => ({
          ...state,
          phase: 'words',
          phoneLabel,
          phrase,
          // Polling must not fight the human's keyboard choice. Preserve the
          // selection only for the exact prompt already on screen; a changed
          // phone or safety phrase always returns to the fail-closed default.
          selection: state.phase === 'words' && state.phoneLabel === phoneLabel && state.phrase === phrase
            ? state.selection
            : 'no',
        }))
      }
      schedulePoll()
    } catch {
      fail('relay_unreachable', 'The local OcuClaw relay could not be reached.')
    }
  }

  const decide = async op => {
    if (decisionStarted) return
    decisionStarted = true
    setState({ phase: 'deciding', message: op === 'approve' ? 'Approving and waiting for the phone…' : 'Refusing this phone…' })
    try {
      const { status, body } = await control(op)
      if (status !== 200) return fail('decision_refused', `The relay refused the local decision (${status}).`)
      if (TERMINAL_PAIRING_STATES.has(body.state)) return outcome(body)
      schedulePoll()
    } catch {
      fail('decision_unreachable', 'The local decision could not reach the relay.')
    }
  }

  const start = async () => {
    try {
      const { status, body } = await control('create')
      if (status !== 200) return fail(clean(body?.reason) || 'create_refused', clean(body?.message) || `The relay refused pairing (${status}).`)
      const bootstrap = splitBootstrap(body.bootstrapBlock)
      if (!body.controlSecret || !bootstrap) return fail('invalid_create_response', 'The relay returned an unusable pairing request.')
      controlSecret = String(body.controlSecret)
      if (cancelRequested) return void decide('cancel')
      setState({
        phase: 'qr',
        view: 'qr',
        qrBlock: bootstrap.qrBlock,
        addressLine: bootstrap.addressLine,
        codeLine: bootstrap.codeLine,
        blockColumns: requiredColumns(bootstrap.qrBlock),
        blockRows: requiredRows(bootstrap.qrBlock),
      })
      schedulePoll()
    } catch {
      fail('relay_unreachable', 'The local OcuClaw relay could not be reached.')
    }
  }

  const cancelForSize = () => {
    if (sizeCancellationStarted) return
    sizeCancellationStarted = true
    void decide('cancel')
  }

  const requestCancel = () => {
    cancelRequested = true
    setState({ phase: 'deciding', message: 'Cancelling pairing…' })
    if (controlSecret) void decide('cancel')
  }

  const notify = async (current, state) => {
    if (!current) return
    const payload = JSON.stringify({ v: 1, runId: current.runId, state: state.outcomeState, code: state.code })
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const response = await fetch(current.callbackUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-ocuclaw-pairing-callback': current.callbackToken },
          body: payload,
        })
        if (response.ok) return
      } catch {}
      await new Promise(resolve => setTimeout(resolve, 100))
    }
  }

  const resetPairingSession = () => {
    clearTimeout(pollTimer)
    pollTimer = null
    pairingActive = false
    config = null
    controlSecret = ''
    decisionStarted = false
    sizeCancellationStarted = false
    cancelRequested = false
  }

  const closeOutcome = state => {
    const current = config
    resetPairingSession()
    void notify(current, state)
    return null
  }

  const PairingView = ({ cols, rows, state, t }) => {
    const tooNarrow = state.phase === 'qr' && state.blockColumns > Math.max(0, cols - 12)
    const tooShort = state.phase === 'qr' && state.blockRows > rows
    const tooSmall = tooNarrow || tooShort
    sdk.React.useEffect(() => {
      if (tooSmall) cancelForSize()
    }, [tooSmall])

    let title = state.title || 'Pair OcuClaw phone'
    let hint = 'Esc/q cancels'
    let width = Math.min(76, Math.max(48, cols - 6))
    let lines = []

    if (state.phase === 'idle') {
      title = 'OcuClaw pairing'
      hint = 'Enter/Esc closes'
      lines = ['Pairing opens automatically from the host-owned /ocuclaw-setup flow.']
    } else if (tooSmall) {
      title = 'Widen this Hermes window'
      lines = [
        `Pairing needs at least ${state.blockColumns + 12} columns × ${state.blockRows} rows.`,
        `This window is ${cols} columns × ${rows} rows.`,
        'The exchange is being cancelled safely. Enlarge the window and continue setup.',
      ]
    } else if (state.phase === 'loading') {
      lines = ['Opening a one-time encrypted pairing exchange…']
    } else if (state.phase === 'qr') {
      // Dialog/Text reserve four inner cells beyond the visible border. Give
      // every canonical QR row that exact space so Ink never soft-wraps it.
      width = Math.min(cols - 4, Math.max(68, state.blockColumns + 8))
      if (state.view === 'manual') {
        hint = 'm shows QR · Esc/q cancels'
        lines = [
          'In the OcuClaw phone app, choose Enter manually:',
          '',
          state.addressLine,
          state.codeLine,
          '',
          'This is the same one-time encrypted exchange.',
          'The screen advances automatically when the phone connects.',
        ]
      } else {
        hint = 'm shows Manual · Esc/q cancels'
        lines = [state.qrBlock, '', 'Scan this QR in the OcuClaw phone app.', 'The screen advances automatically when the phone connects.']
      }
    } else if (state.phase === 'words') {
      hint = '↑/↓ choose · Enter confirms · Esc/q refuses'
      lines = [
        `Phone: ${state.phoneLabel}`,
        '',
        `    ${state.phrase}`,
        '',
        'Approve only if all four words match in order on the phone.',
        '',
        `${state.selection === 'yes' ? '›' : ' '} Yes — all four words match`,
        `${state.selection === 'no' ? '›' : ' '} No — refuse this phone`,
      ]
    } else if (state.phase === 'deciding') {
      lines = [state.message]
    } else if (state.phase === 'outcome') {
      hint = 'Enter continues setup'
      lines = [state.message, '', 'Press Enter to return to the setup assistant.']
    }

    return h(Overlay, { backdrop: true, zone: 'center' },
      h(Dialog, { title, hint, width }, ...lines.map((line, index) => {
        const isQrBlock = state.phase === 'qr' && state.view !== 'manual' && index === 0
        if (isQrBlock) {
          const children = []
          const rows = qrWatermarkRuns(line, blendWithWhite(t.color.accent))
          rows.forEach((runs, rowIndex) => {
            runs.forEach((run, runIndex) => children.push(h(Text, {
              key: `${rowIndex}:${runIndex}`,
              color: '#000000',
              backgroundColor: run.backgroundColor,
            }, run.text)))
            if (rowIndex < rows.length - 1) children.push('\n')
          })
          return h(Text, {
            key: index,
            color: '#000000',
            backgroundColor: '#ffffff',
          }, ...children)
        }
        return h(Text, {
          key: index,
          color: state.phase === 'outcome' ? (state.outcomeState === 'completed' ? t.color.ok : t.color.error) : undefined,
        }, line || ' ')
      })))
  }

  // Keep the presenter out of Hermes' public slash-command catalog while it
  // is inert. Hermes derives `/` completions from the widget registry, but
  // openWidget accepts the app object directly. Certified Hermes 0.20 exposes
  // no public unregister operation to user widgets, so register only when the
  // ceremony activates; the registry is discarded when this TUI process exits.
  // A direct slash invocation is refused by init() below.
  app = {
    id: 'ocuclaw-pair',
    help: 'internal OcuClaw setup pairing presenter',
    mode: 'modal',
    init: rawArgs => rawArgs === AUTO_ACTIVATION ? { phase: 'loading', selection: 'no' } : null,
    reduce(state, { ch, key }) {
      const cancelKey = key.escape || ch === 'q' || sdk.isCtrl(key, ch, 'c')
      if (state.phase === 'idle') return key.return || cancelKey ? null : state
      if (state.phase === 'outcome') return key.return || cancelKey ? closeOutcome(state) : state
      if (state.phase === 'words') {
        if (cancelKey) {
          void decide('deny')
          return { ...state, phase: 'deciding', message: 'Refusing this phone…' }
        }
        if (key.upArrow || key.downArrow || key.leftArrow || key.rightArrow || key.tab || ch === 'y' || ch === 'n') {
          const selection = ch === 'y' ? 'yes' : ch === 'n' ? 'no' : state.selection === 'yes' ? 'no' : 'yes'
          return { ...state, selection }
        }
        if (key.return) {
          void decide(state.selection === 'yes' ? 'approve' : 'deny')
          return { ...state, phase: 'deciding', message: state.selection === 'yes' ? 'Approving and waiting for the phone…' : 'Refusing this phone…' }
        }
        return state
      }
      if (state.phase === 'qr' && ch === 'm') {
        return { ...state, view: state.view === 'manual' ? 'qr' : 'manual' }
      }
      if (cancelKey && (state.phase === 'loading' || state.phase === 'qr')) {
        requestCancel()
        return { ...state, phase: 'deciding', message: 'Cancelling pairing…' }
      }
      return state
    },
    render: ({ cols, rows, state, t }) => h(PairingView, { cols, rows, state, t }),
  }

  const tryActivate = async () => {
    if (activationProbeRunning) return
    if (pairingActive) {
      // A completed/failed panel normally clears this latch when the human
      // presses Enter. If its owning setup tool timed out first, however, the
      // callback is gone and that key may never arrive. Once the activation's
      // own deadline has passed, discard only the expired in-memory attempt so
      // the next setup invocation can open a fresh panel in this same TUI.
      if (config && Date.now() < config.expiresAtMs) return
      resetPairingSession()
    }
    activationProbeRunning = true
    try {
      const ownerPid = String(process.pid)
      const challengeResponse = await fetch(ACTIVATION_URL, {
        method: 'GET',
        cache: 'no-store',
        headers: {
          [ACTIVATION_OWNER_HEADER]: ownerPid,
          [ACTIVATION_SURFACE_HEADER]: 'tui',
        },
      })
      if (challengeResponse.status !== 401) return
      const challengeBody = await challengeResponse.json()
      const serverChallenge = String(challengeBody?.serverChallenge || '')
      if (!/^[A-Za-z0-9_-]{43}$/.test(serverChallenge)) return
      const credential = presenterToken()
      if (!credential) return
      const challenge = randomBytes(32).toString('base64url')
      const response = await fetch(ACTIVATION_URL, {
        method: 'GET',
        cache: 'no-store',
        headers: {
          [ACTIVATION_OWNER_HEADER]: ownerPid,
          [ACTIVATION_SURFACE_HEADER]: 'tui',
          [ACTIVATION_CHALLENGE_HEADER]: challenge,
          [ACTIVATION_SERVER_CHALLENGE_HEADER]: serverChallenge,
          [ACTIVATION_CLAIM_PROOF_HEADER]: claimProof(serverChallenge, challenge, ownerPid, credential),
        },
      })
      if (response.status !== 200) return
      const candidate = await response.json()
      if (!validActivation(candidate) || !authenticActivation(candidate, challenge, credential)) return
      config = candidate
      controlSecret = ''
      decisionStarted = false
      sizeCancellationStarted = false
      cancelRequested = false
      pairingActive = true
      defineWidgetApp(app)
      sdk.openWidget(app, app.init(AUTO_ACTIVATION))
      void start()
    } catch {
      // Inert is the normal state. The activation endpoint exists only while
      // the setup tool is blocked waiting for this direct-human ceremony.
    } finally {
      activationProbeRunning = false
    }
  }

  const activationTimer = setInterval(() => void tryActivate(), 750)
  activationTimer.unref?.()
  void tryActivate()
}

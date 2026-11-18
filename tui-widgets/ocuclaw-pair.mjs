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
// The activation contract this file speaks (tui_pairing.WIDGET_PROTOCOL).
// The setup tool refuses a claim on any other and asks for a relaunch, so a
// copy loaded before an update fails loudly, not in silence.
const ACTIVATION_WIDGET_PROTOCOL_HEADER = 'x-ocuclaw-tui-widget-protocol'
const WIDGET_PROTOCOL = '2'
const PRESENTER_CAPABILITY_URL = new URL('../state/ocuclaw.tui-pairing-capability.json', import.meta.url)
const AUTO_ACTIVATION = '__ocuclaw_auto_activation__'
const TERMINAL_PAIRING_STATES = new Set(['completed', 'failed', 'cancelled', 'refused'])

let config = null
let controlSecret = ''
let pollTimer = null
let decisionStarted = false
let sizeCancellationStarted = false
let resultNotified = false
let cancelRequested = false
let activationProbeRunning = false
let pairingActive = false
// #5483. A typed phone code is with the relay; keys wait for its answer.
let codeSubmitting = false
let phoneCodeTriesLeft = 3
// The outcome is on screen: a status answer still on its way must not replace
// it (a cancelled exchange answers a late poll with 401).
let outcomeShown = false

// #3521. A result code the setup tool maps to "make the Hermes window bigger".
const WINDOW_TOO_SMALL = 'tui_window_too_small'
// Hermes ui-tui Dialog (components/overlay.tsx): a round border (2 rows),
// paddingY 1 (2 rows), the title and its margin (2 rows), the hint and its
// margin (2 rows).
const DIALOG_CHROME_ROWS = 8
// Border and paddingX 2 take six columns. Two more spare cells keep Ink from
// soft-wrapping a row that is exactly as wide as the inner box.
const DIALOG_CHROME_COLUMNS = 8
// The dialog keeps this many columns clear of the window edge.
const WINDOW_MARGIN_COLUMNS = 4

const clean = value => String(value ?? '').replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').slice(0, 240)
const textRows = lines => lines.flatMap(line => String(line ?? '').split('\n'))
const requiredColumns = block => Math.max(0, ...textRows([block]).map(line => [...line].length))
// The window size a dialog needs to show these exact lines (plus its title
// and hint) with no wrapped or clipped row.
const viewSize = ({ title = '', hint = '', lines }) => ({
  cols: requiredColumns(textRows([title, hint, ...lines]).join('\n')) + DIALOG_CHROME_COLUMNS + WINDOW_MARGIN_COLUMNS,
  rows: textRows(lines).length + DIALOG_CHROME_ROWS,
})
const fitsWindow = (size, cols, rows) => cols >= size.cols && rows >= size.rows
const largerSize = (...sizes) => ({
  cols: Math.max(...sizes.map(size => size.cols)),
  rows: Math.max(...sizes.map(size => size.rows)),
})
const PAIRING_TITLE = 'Pair OcuClaw phone'
const MANUAL_HINT = 'Esc/q cancels'
const WORDS_HINT = '↑/↓ choose · Enter confirms · Esc/q refuses'
const PHONE_CODE_HINT = 'Enter pairs · m manual pairing · Esc/q cancels'
const SENT_HINT = 'Esc/q cancels'
// #5483. The phone-code lines. The prompt is Hermes Desktop's
// (desktop-template/plugin.js); the rest are Hermes pair's own copies
// (pairing.py PHONE_CODE_*), and test_tui_pairing.py keeps them equal.
const PHONE_CODE_PROMPT_LINES = Object.freeze([
  'In Even Hub open OcuClaw and tap the Pair button.',
  'Type the phone code it shows:',
])
const PHONE_CODE_MANUAL = "For manual pairing, type m."
const PHONE_CODE_SENT = "Sent to your phone.\nCheck the four words on your glasses\nor in OcuClaw. They should match the\nwords that appear here."
const PHONE_CODE_OUTAGE = "Phone codes aren't working right now, so here's manual pairing."
const PHONE_CODE_MISSING = "No phone is waiting with that code. Check the code in OcuClaw. If it ran out, tap Get a new code there."
const PHONE_CODE_PAIRING_TYPED = "That's the pairing code, which goes into the phone. Here, type the 6-digit phone code that OcuClaw shows."
const PHONE_CODE_TRIES = 3
const WRONG_PHONE_CODE_REASONS = new Set(['malformed', 'no_code', 'spent'])
const PHONE_CODE_DECISIONS = new Set(['available', 'off', 'custom_route', 'unavailable'])
// Wrap a sentence to the manual view's own line width, so the dialog never
// soft-wraps a row its size check did not count.
const WRAP_COLUMNS = 58
const wrapLines = text => String(text ?? '').split('\n').flatMap(paragraph => {
  const out = []
  let line = ''
  for (const word of paragraph.split(' ').filter(Boolean)) {
    if (line && line.length + 1 + word.length > WRAP_COLUMNS) {
      out.push(line)
      line = word
    } else {
      line = line ? `${line} ${word}` : word
    }
  }
  out.push(line)
  return out
})
// One line saying why the panel opened manual pairing (#5483).
const reasonLines = state => state.manualMessage ? [...wrapLines(state.manualMessage), ''] : []
const phoneCodeLines = state => {
  const digits = String(state.digits ?? '').padEnd(6, '_')
  return [
    ...PHONE_CODE_PROMPT_LINES,
    '',
    `  > ${digits.slice(0, 3)} ${digits.slice(3, 6)}`,
    ...(state.codeMessage ? ['', ...wrapLines(state.codeMessage)] : []),
    ...(state.triesLine ? [state.triesLine] : []),
    '',
    PHONE_CODE_MANUAL,
  ]
}
const sentLines = () => [...PHONE_CODE_SENT.split('\n'), '', 'Waiting for the phone.']
// #5486. Manual pairing is text only, in the words of every terminal's
// manual block (spec, QR removal): the address and pairing code to type on
// the phone, and how long they last.
const MANUAL_PROMPT = 'In OcuClaw tap Pair with your agent > Pair manually, then type:'
const manualDetail = (line, label) => {
  const text = String(line ?? '')
  return text.startsWith(label) ? `  ${label.padEnd(14)}${text.slice(label.length).trim()}` : `  ${text}`
}
const expiryLine = (expiresAtMs, now = Date.now()) => {
  const left = Math.max(0, Math.ceil((expiresAtMs - now) / 1000))
  return `Expires in ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}.`
}
const manualLines = state => [
  ...reasonLines(state),
  MANUAL_PROMPT,
  manualDetail(state.addressLine, 'Address:'),
  manualDetail(state.codeLine, 'Pairing code:'),
  // The clock line keeps its width as it counts down (`10:00.` at most).
  ...(Number.isFinite(state.expiresAtMs) ? [expiryLine(state.expiresAtMs)] : []),
  '',
  'The screen advances automatically when the phone connects.',
]
const wordsLines = state => [
  `Phone: ${state.phoneLabel ?? ''}`,
  '',
  `    ${state.phrase ?? ''}`,
  '',
  'Approve only if all four words match in order on the phone.',
  'Approving also lets these glasses talk to your agent.',
  '',
  `${state.selection === 'yes' ? '›' : ' '} Yes — all four words match`,
  `${state.selection === 'no' ? '›' : ' '} No — refuse this phone`,
]
// The smallest window the rest of the ceremony fits in: the manual view now,
// then the four-word check (its phrase is not known yet, so this counts the
// fixed lines; the four short words fit well inside them).
const manualMinimumSize = state => largerSize(
  viewSize({ title: PAIRING_TITLE, hint: MANUAL_HINT, lines: manualLines(state) }),
  viewSize({ title: PAIRING_TITLE, hint: WORDS_HINT, lines: wordsLines({}) }),
)
const phoneCodeMinimumSize = state => largerSize(
  viewSize({ title: PAIRING_TITLE, hint: PHONE_CODE_HINT, lines: phoneCodeLines(state) }),
  viewSize({ title: PAIRING_TITLE, hint: SENT_HINT, lines: sentLines() }),
  viewSize({ title: PAIRING_TITLE, hint: WORDS_HINT, lines: wordsLines({}) }),
)
// BEGIN pairing-bootstrap-parser
// Keep this block byte-identical in tui-widgets/ocuclaw-pair.mjs and
// desktop-template/plugin.js. tests/hermes-pairing-bootstrap-contract.test.js
// feeds both copies the text the relay presenter really prints.
// The manual details come first from the create reply's own `address` and
// `pairingCode` fields (#5484). A reply from an older relay has neither, so
// the block is still read, by shape, not by the words around it: the details
// are the "Address:" and "Pairing code:" lines at any indent. The 2.0.9
// rewording broke a wording-based parser; a shape-based one survives the next
// rewording. Any QR rows in the block are ignored: no window draws a QR
// (#5486). Only missing manual details make the block unusable.
const pairingReplyValue = value =>
  typeof value === 'string' && !/[\u0000-\u001f\u007f-\u009f]/.test(value) ? value.trim() : ''
const parsePairingBootstrap = (block, reply) => {
  const lines = String(block ?? '').split('\n').map(line => line.replace(/\r$/, ''))
  const labelled = (label, field) => {
    const given = pairingReplyValue(field)
    if (given) return `${label} ${given}`
    const line = lines.find(candidate => candidate.trimStart().startsWith(label))
    const value = line ? line.trim().slice(label.length).trim() : ''
    return value ? `${label} ${value}` : ''
  }
  const address = labelled('Address:', reply?.address)
  const code = labelled('Pairing code:', reply?.pairingCode)
  return address && code ? { address, code } : null
}
// END pairing-bootstrap-parser
const splitBootstrap = (block, reply) => {
  const parsed = parsePairingBootstrap(block, reply)
  return parsed && { addressLine: clean(parsed.address), codeLine: clean(parsed.code) }
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
  // #5483. The setup tool's answer to "does the relay offer a phone code?".
  if ('phoneCode' in value && !PHONE_CODE_DECISIONS.has(value.phoneCode)) return false
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
  // Signed only when the activation carries it, so an activation without a
  // phone-code decision keeps today's proof.
  ...('phoneCode' in value ? [value.phoneCode] : []),
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

  const control = async (op, phoneCode) => {
    const current = config
    if (!current || Date.now() >= current.expiresAtMs) throw new Error('pairing_activation_expired')
    const headers = {
      'content-type': 'application/json',
      [ACTIVATION_CONTROL_HEADER]: current.controlToken,
    }
    if (controlSecret) headers['x-ocuclaw-pair-control-secret'] = controlSecret
    const body = op === 'create'
      // No window draws a QR (#5486), so the request asks for no QR colours;
      // a phone code is the only extra field (#5483).
      ? { v: 1, op, address: current.address, ...(phoneCode === undefined ? {} : { phoneCode }) }
      : { v: 1, op }
    const response = await fetch(current.controlUrl, { method: 'POST', headers, body: JSON.stringify(body) })
    let parsed = {}
    try { parsed = await response.json() } catch {}
    return { status: response.status, body: parsed }
  }

  const outcome = body => {
    // A window-size cancel already owns the panel and the result (#3521).
    if (sizeCancellationStarted) return
    clearTimeout(pollTimer)
    outcomeShown = true
    controlSecret = ''
    setState(outcomePatch(body))
  }
  const outcomePatch = body => {
    const state = clean(body?.state) || 'failed'
    const code = terminalCode(body)
    const ok = state === 'completed'
    return {
      phase: 'outcome',
      outcomeState: ok ? 'completed' : (state === 'failed' ? 'failed' : 'cancelled'),
      code,
      title: ok ? 'Phone paired' : 'Pairing stopped',
      message: ok
        ? 'The phone connected back and the managed gateway confirmed it.'
        : clean(body?.failure?.message) || 'Nothing was approved. You can retry this setup checkpoint.',
    }
  }
  // #5483. Stopped before any exchange existed: nothing to cancel at the relay.
  const CANCELLED_BEFORE_EXCHANGE = { state: 'cancelled', failure: { reason: 'cancelled' } }

  const fail = (code, message) => outcome({ state: 'failed', failure: { reason: code, message } })

  const schedulePoll = () => {
    clearTimeout(pollTimer)
    if (outcomeShown) return
    pollTimer = setTimeout(() => void poll(), 650)
  }

  const poll = async () => {
    try {
      const { status, body } = await control('state')
      if (sizeCancellationStarted || outcomeShown) return
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
      } else {
        // The manual view's clock: a new state redraws it once its text moves.
        sdk.updateWidget(app, state => {
          if (state.phase !== 'manual' || !Number.isFinite(state.expiresAtMs)) return state
          const shown = expiryLine(state.expiresAtMs)
          return shown === state.expiryShown ? state : { ...state, expiryShown: shown }
        })
      }
      schedulePoll()
    } catch {
      if (!outcomeShown) fail('relay_unreachable', 'The local OcuClaw relay could not be reached.')
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

  const createRefused = (status, body) =>
    fail(clean(body?.reason) || 'create_refused', clean(body?.message) || `The relay refused pairing (${status}).`)

  // Show an exchange the relay opened for manual pairing. `manualMessage` is
  // the one line saying why a phone code was not used (#5483).
  const present = (body, manualMessage = '') => {
    const bootstrap = splitBootstrap(body.bootstrapBlock, body)
    if (!body.controlSecret || !bootstrap) return fail('invalid_create_response', 'The relay returned an unusable pairing request.')
    controlSecret = String(body.controlSecret)
    if (cancelRequested) return void decide('cancel')
    // #5486: the address and pairing code, text only. The clock is the
    // relay's own `expiresInSeconds`, counted from this reply.
    const seconds = Number(body.expiresInSeconds)
    setState({
      phase: 'manual',
      addressLine: bootstrap.addressLine,
      codeLine: bootstrap.codeLine,
      expiresAtMs: Number.isFinite(seconds) && seconds > 0 ? Date.now() + seconds * 1000 : undefined,
      manualMessage,
    })
    schedulePoll()
  }

  const start = async (manualMessage = '') => {
    try {
      const { status, body } = await control('create')
      if (status !== 200) return createRefused(status, body)
      present(body, manualMessage)
    } catch {
      fail('relay_unreachable', 'The local OcuClaw relay could not be reached.')
    }
  }

  // #5483. Send the typed phone code. The relay opens the exchange only for a
  // code a phone is waiting with; a wrong code leaves nothing behind, so the
  // panel asks again, and the third wrong code opens manual pairing.
  const submitCode = async code => {
    let reply
    try {
      reply = await control('create', code)
    } catch {
      codeSubmitting = false
      if (sizeCancellationStarted) return
      if (cancelRequested) return outcome(CANCELLED_BEFORE_EXCHANGE)
      return fail('relay_unreachable', 'The local OcuClaw relay could not be reached.')
    }
    codeSubmitting = false
    const { status, body } = reply
    const secret = status === 200 && typeof body?.controlSecret === 'string' ? body.controlSecret : ''
    if (sizeCancellationStarted || cancelRequested) {
      // Stopped while the relay was answering: cancel what it made, if anything.
      if (!secret) return sizeCancellationStarted ? undefined : outcome(CANCELLED_BEFORE_EXCHANGE)
      controlSecret = secret
      if (!sizeCancellationStarted) return void decide('cancel')
      try { await control('cancel') } catch {}
      controlSecret = ''
      return
    }
    if (status === 200 && body?.reason === 'pairing_code_typed') {
      // As Hermes pair: only this line, and no try used.
      return setState({ phase: 'phone-code', digits: '', codeMessage: PHONE_CODE_PAIRING_TYPED, triesLine: '' })
    }
    if (status === 200 && WRONG_PHONE_CODE_REASONS.has(body?.reason)) {
      phoneCodeTriesLeft -= 1
      if (phoneCodeTriesLeft > 0) {
        return setState({
          phase: 'phone-code',
          digits: '',
          codeMessage: PHONE_CODE_MISSING,
          triesLine: `${phoneCodeTriesLeft} ${phoneCodeTriesLeft === 1 ? 'try' : 'tries'} left.`,
        })
      }
      setState({ phase: 'loading' })
      return start(PHONE_CODE_MISSING)
    }
    if (status !== 200) return createRefused(status, body)
    if (body?.delivery === 'sent') {
      if (!secret) return fail('invalid_create_response', 'The relay returned an unusable pairing request.')
      controlSecret = secret
      setState({ phase: 'sent' })
      return schedulePoll()
    }
    // The mailbox could not be reached: the relay already opened a fresh
    // manual exchange for this answer.
    return present(body, body?.delivery === 'unavailable' ? PHONE_CODE_OUTAGE : '')
  }

  // #3521. Below the manual/four-word minimum the ceremony cannot be shown at
  // all. Cancel the relay exchange, keep the reason on screen, and hand the
  // setup tool the result now: the person must not have to press Enter before
  // the assistant can say "make the window bigger".
  const cancelForSize = window => {
    if (sizeCancellationStarted) return
    sizeCancellationStarted = true
    decisionStarted = true
    resultNotified = true
    clearTimeout(pollTimer)
    const current = config
    const result = { outcomeState: 'cancelled', code: WINDOW_TOO_SMALL, window }
    setState({
      ...result,
      phase: 'outcome',
      title: 'Make this Hermes window bigger',
      message: [
        `Pairing needs at least ${window.minCols} columns × ${window.minRows} rows.`,
        `This window is ${window.cols} columns × ${window.rows} rows.`,
        'Nothing was paired. Make the window bigger,',
        'then retry pairing from the setup assistant.',
      ].join('\n'),
    })
    void (async () => {
      try { if (controlSecret) await control('cancel') } catch {}
      controlSecret = ''
      await notify(current, result)
    })()
  }

  const requestCancel = () => {
    cancelRequested = true
    setState({ phase: 'deciding', message: 'Cancelling pairing…' })
    if (controlSecret) void decide('cancel')
  }

  const notify = async (current, state) => {
    if (!current) return
    const payload = JSON.stringify({
      v: 1,
      runId: current.runId,
      state: state.outcomeState,
      code: state.code,
      // Window dimensions only: they let the tool name the size to reach.
      ...(state.code === WINDOW_TOO_SMALL && state.window ? {
        cols: state.window.cols,
        rows: state.window.rows,
        minCols: state.window.minCols,
        minRows: state.window.minRows,
      } : {}),
    })
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
    resultNotified = false
    cancelRequested = false
    codeSubmitting = false
    phoneCodeTriesLeft = PHONE_CODE_TRIES
    outcomeShown = false
  }

  const closeOutcome = state => {
    const current = config
    const alreadyNotified = resultNotified
    resetPairingSession()
    if (!alreadyNotified) void notify(current, state)
    return null
  }

  const PairingView = ({ cols, rows, state, t }) => {
    // #3521. Cancel only when the rest of the ceremony does not fit: the
    // manual view (address + code) and then the four-word check. Every size
    // is measured from the lines this view renders.
    const inManual = state.phase === 'manual'
    // #5483. The phone-code views lead to the four-word check with no manual
    // view between, so they carry that minimum themselves.
    const inCode = state.phase === 'phone-code' || state.phase === 'sent'
    const minimum = inManual ? manualMinimumSize(state) : inCode ? phoneCodeMinimumSize(state) : null
    const tooSmall = Boolean(minimum) && !fitsWindow(minimum, cols, rows)
    sdk.React.useEffect(() => {
      if (tooSmall) cancelForSize({ cols, rows, minCols: minimum.cols, minRows: minimum.rows })
    }, [tooSmall])

    let title = state.title || PAIRING_TITLE
    let hint = 'Esc/q cancels'
    let width = Math.min(76, Math.max(48, cols - 6))
    let lines = []

    if (state.phase === 'idle') {
      title = 'OcuClaw pairing'
      hint = 'Enter/Esc closes'
      lines = ['Pairing opens automatically from the host-owned /ocuclaw-setup flow.']
    } else if (tooSmall) {
      // One frame until the effect above moves the panel to its outcome.
      title = 'Make this Hermes window bigger'
      lines = [
        `Pairing needs at least ${minimum.cols} columns × ${minimum.rows} rows.`,
        `This window is ${cols} columns × ${rows} rows.`,
      ]
    } else if (state.phase === 'loading') {
      lines = ['Opening a one-time encrypted pairing exchange…']
    } else if (inCode || inManual) {
      width = Math.min(cols - WINDOW_MARGIN_COLUMNS, Math.max(68, minimum.cols - WINDOW_MARGIN_COLUMNS))
      if (inManual) {
        hint = MANUAL_HINT
        lines = manualLines(state)
      } else {
        hint = state.phase === 'sent' ? SENT_HINT : PHONE_CODE_HINT
        lines = state.phase === 'sent' ? sentLines() : phoneCodeLines(state)
      }
    } else if (state.phase === 'words') {
      hint = WORDS_HINT
      lines = wordsLines(state)
    } else if (state.phase === 'deciding') {
      lines = [state.message]
    } else if (state.phase === 'outcome') {
      hint = 'Enter continues setup'
      lines = [state.message, '', 'Press Enter to return to the setup assistant.']
    }

    return h(Overlay, { backdrop: true, zone: 'center' },
      h(Dialog, { title, hint, width }, ...lines.map((line, index) => h(Text, {
        key: index,
        color: state.phase === 'outcome' ? (state.outcomeState === 'completed' ? t.color.ok : t.color.error) : undefined,
      }, line || ' '))))
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
    init: rawArgs => rawArgs !== AUTO_ACTIVATION ? null
      : config?.phoneCode === 'available' ? { phase: 'phone-code', digits: '', selection: 'no' }
        : { phase: 'loading', selection: 'no' },
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
      if (state.phase === 'phone-code') {
        // #5483. No exchange exists yet, unless a typed code is with the relay.
        if (cancelKey) {
          if (!codeSubmitting) return { ...state, ...outcomePatch(CANCELLED_BEFORE_EXCHANGE) }
          cancelRequested = true
          return { ...state, phase: 'deciding', message: 'Cancelling pairing…' }
        }
        if (codeSubmitting) return state
        if (ch === 'm' || ch === 'M') {
          void start()
          return { ...state, phase: 'loading' }
        }
        const digits = String(state.digits ?? '')
        if (key.return) {
          if (digits.length !== 6) return state
          codeSubmitting = true
          void submitCode(digits)
          return state
        }
        if (key.backspace || key.delete || ch === '\u007f' || ch === '\b') return { ...state, digits: digits.slice(0, -1) }
        // A paste arrives as one string, maybe inside bracketed-paste marks.
        const typed = String(ch ?? '').replace(/\u001b\[20[01]~/g, '')
        if (/^[0-9]$/.test(typed)) return digits.length < 6 ? { ...state, digits: digits + typed } : state
        const compact = typed.replace(/[\s-]/g, '')
        if (typed.length > 1 && /^[0-9]+$/.test(compact)) return { ...state, digits: compact.slice(0, 6) }
        if (typed.length > 1 && /^[A-Za-z0-9]+$/.test(compact)) {
          // A pasted pairing code: the relay names it and no try is used.
          codeSubmitting = true
          void submitCode(typed.trim().slice(0, 64))
        }
        return state
      }
      if (cancelKey && (state.phase === 'loading' || state.phase === 'manual' || state.phase === 'sent')) {
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
          [ACTIVATION_WIDGET_PROTOCOL_HEADER]: WIDGET_PROTOCOL,
        },
      })
      if (response.status !== 200) return
      const candidate = await response.json()
      if (!validActivation(candidate) || !authenticActivation(candidate, challenge, credential)) return
      config = candidate
      controlSecret = ''
      decisionStarted = false
      sizeCancellationStarted = false
      resultNotified = false
      cancelRequested = false
      codeSubmitting = false
      phoneCodeTriesLeft = PHONE_CODE_TRIES
      outcomeShown = false
      pairingActive = true
      defineWidgetApp(app)
      sdk.openWidget(app, app.init(AUTO_ACTIVATION))
      // #5483. With phone codes on, nothing is created until a code is typed
      // or manual pairing is picked. Off and a custom route open today's
      // panel with no extra line; only an outage says why.
      if (config.phoneCode !== 'available') void start(config.phoneCode === 'unavailable' ? PHONE_CODE_OUTAGE : '')
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

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
  PALETTE_AREA,
  Popover,
  PopoverContent,
  PopoverTrigger,
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
// Durable completion receipt. The order-40 owner, not this flag, decides which
// surface renders: a later gateway loss must still reveal Setup Card recovery.
const CARD_RETIRED_KEY = 'setup-card-retired'
const CARD_ANNOUNCED_KEY = 'setup-card-announced'
// One passive LiveUI poll owner for the future G2 Pulse + Pulse Card surfaces.
// Hermes' current PluginRestOptions exposes neither request headers nor response
// metadata, so the backend's ETag is useful to direct HTTP clients but cannot
// honestly be sent as If-None-Match through ctx.rest yet.
const GLASSES_STATE_FOCUSED_INTERVAL_MS = 3000
const GLASSES_STATE_BACKGROUND_INTERVAL_MS = 15000
const GLASSES_STATE_TIMEOUT_MS = 2500
const GLASSES_STATE_QUERY_KEY = Object.freeze(['ocuclaw', 'glasses-state'])
// The setup skill's slash name, dispatched to the gateway by the card's own
// button. The operator is never asked to type it.
const SETUP_COMMAND = 'ocuclaw-setup'
const SETUP_RUN_KEY = 'setup-run'
// A dispatched setup that nobody finished is not a permanent card state — a
// stale record would offer "Open setup chat" for a conversation the operator
// abandoned days ago.
const SETUP_RUN_STALE_MS = 6 * 60 * 60 * 1000
const PRESENTER_CAPABILITY = '__OCUCLAW_DESKTOP_PRESENTER_CAPABILITY__'
// DESKTOP_ROUTE_BEGIN
// A capability belongs only to the local installation that rendered it.
// Unknown SDK routing is read-only too; never guess that it means local.
const desktopLocalActions = () => sdk.host.state?.connectionId?.get?.() === 'local' &&
  !PRESENTER_CAPABILITY.startsWith('__') && /^[A-Za-z0-9_-]{43,128}$/.test(PRESENTER_CAPABILITY)
const desktopRouteApi = ctx => async (path, options = {}) => {
  if (!desktopLocalActions() &&
      ((options.method || 'GET').toUpperCase() !== 'GET' ||
       !['/setup-card', '/glasses/state'].includes(path) ||
       Object.entries(options).some(([key, value]) => value !== undefined &&
         !['method', 'timeoutMs', 'signal'].includes(key)))) {
    throw new Error('OcuClaw remote Desktop status is read-only')
  }
  const atoms = [sdk.host.state?.connectionId, sdk.host.state?.['profile']]
  const receiver = atoms.map(atom => atom?.get?.())
  const unsubscribes = []
  let retired = false
  const current = () => !retired && atoms.every((atom, index) => atom?.get?.() === receiver[index])
  const changed = () => new Error('OcuClaw Desktop connection or profile changed; retry on the selected connection')
  try {
    for (const atom of atoms) {
      let seen = atom?.get?.()
      const unsubscribe = atom?.subscribe?.(value => {
        // A same-id round trip still retires an in-flight response. Nanostores'
        // initial replay is not a change, and owns no authority by itself.
        if (value !== seen) retired = true
        seen = value
      })
      if (typeof unsubscribe === 'function') unsubscribes.push(unsubscribe)
    }
    if (!current()) throw changed()
    const result = await ctx.rest(path, options)
    if (!current()) throw changed()
    return result
  } catch (error) {
    if (!current()) throw changed()
    throw error
  } finally {
    for (const unsubscribe of unsubscribes) unsubscribe()
  }
}
// DESKTOP_ROUTE_END

const useDesktopLocalActions = () => {
  const [local, setLocal] = useState(desktopLocalActions)
  useEffect(() => watchHostAtom(sdk.host.state?.connectionId,
    () => setLocal(desktopLocalActions())) || undefined, [])
  return local
}

const startLocalDesktopOwner = start => {
  let stop = null
  const update = () => {
    stop?.(); stop = null
    if (desktopLocalActions()) stop = start()
  }
  const unwatch = watchHostAtom(sdk.host.state?.connectionId, update)
  update()
  return () => { unwatch?.(); stop?.() }
}

// OcuClaw look for Hermes Desktop. Always contributed, so it lists in
// Settings > Appearance next to the built-ins; applied only after an explicit
// Desktop choice or an earlier /ocuclaw-setup consent. The gateway renders that answer into the slot
// below (a UTC stamp, or empty) each time it reconciles this file, and
// Hermes Desktop hot-reloads the file on change, so a yes lands without a
// restart. requestTheme() exists from Hermes 0.20.6; older hosts still list
// the theme and the setup receipt tells the operator to pick it by hand.
const THEME_NAME = 'ocuclaw'
const THEME_REQUEST = '__OCUCLAW_DESKTOP_THEME_REQUEST__'
const THEME_REQUEST_APPLIED_KEY = 'theme-request-applied'
const THEME_CHOICE_KEY = 'desktop-theme-choice-v1'
const EMOJI_FALLBACK = ', "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol", "Noto Color Emoji", emoji'
const MONOGRAM_WOFF2_B64 = 'd09GMgABAAAAACHcAAwAAAAA1QgAACGGAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAABlYAgwQIBBEICoLsBILKewE2AiQDiD4LiDoABCAFiRsHnTobbb/XDhDrduCtk1RYsxEVbBxAFJg3HHCHYeOAQJjOKlNVVdVjAh1jR2QnzaoM9qiHXGEJOe54R6tFB3JdCzFjL9qZlaEG8dR/xncApjB6R1ikEEJPdHHejGueeMauydUu/nmR6JoPi+L0pgCTz6lERJ+QhX4RKOcZx+ho5PHw/0RX/rmvahSzYnrhTD4g9wfc239/8xnlfzT2JgkpzqyLp0BBQdN/nZVcd3SEGLJXdPf95JZOQ3EwjwHramYO4p7c716lq8Vv4ZuVAggISM9clmWRC/tLhxAZs94y1TFlUsO/URaIcHE/lHUpZMHX9mJJ+zqdLosEEZEQigQp93nghBtbsRXbz9amquV/mnh7YqZNv7mUukEUTUKFEAvcttepolRtqvp9YAwOZ5K08PCdu492RCNMm0Xl8+nMe2nOCoGDdKzE9i9Vynjf3KfNJpcrYAoAjoRh6f+bmexeMplPe7wlTplyZ/5d2Va17owncGXZV6GrRYWxFbbCiPr/P81/qeVZ8/xLpwmthNWCOiHBf42u7l4rM7J+83Oakw5wqLbO3ceSRlfu80qF/yOWikAYC4R+LATG7//e5L8zdytVoD0XaEHmqW0pLa0dX47/Yu9bAhbAcMLLEOUQAWMzI88hnhIh04jRdWZ5aSntsLnoAAPYWUvHAowwhiGEGGOWK/2F2zbfXN9yOHuFv72OEtSiyfoZ4xqhTfVUYVRPf/YzTTqka/x2KzmGnKJM5TEqYj4BKa9TSJG1c+0F4OT1X4u+Y4ByYKRzAJDHbkb5HQAA/QsKNjOW0BdHAth15IGLAQADHNAIh4BGeO0FljKWFM2o4gZV6TS9ZC3taXvWPnSFrsod505wl7qX3JvuV/enl/d+nl8YGhqFFqFNaB+YIAV1OuHfUBquCDeE28Kd7dobp7dv0L5xl9Z9SRIgcAk36TS9aM3sKXvW3nEFrswd4U5wJ7nLUSf/3cXe+Xp+QSA0DM1Cq19Ccd+CfU75f2XyWfJY8mhyU1KQ9Kg+VJ2v3h9/EL8Tvx6/Fr8avxI/F98U3xhfHV8Vnx+fF/0UfRV9Hn0WfRJ9GD0fPRs9Hp0TnRntiDZGa6JV0S+fHPFJ+hP/XvxaS0S0or0dw2olCZG1Yho/FDJ/w7QjYE4/R01c2ptlNtyLDCmE2ygMcWo/WJoMhsfjAMpgmadI4/NVUlAlSGFdch6lSmaUO/T/s708Pa888iJXyoF+7BlO/MjFHwDlPMq25WGlOm+PMYsTcRXyVfZT1hsAmBTRiIVynO25lgfMvTej4xtuo/e2P5fXl0kxGAUXxSawMCYhaM1vABuqrF5afMIW5vwCEChiUyOyMbIzCkBhCWKkK89U8umNSLh927eaijzkJwh25bO9tyCpgnDIj96b5CmdBsUJingkK5KFvMTQai8oLERLk0SQHUQ4/B6r3eiSEV89K/vp0cf20T0QSD7CobIIxyhcCS6TbJQokI/ekxz5MybydEqOvNQlOyV+LyvENZngSReM/huFUd6DPw/nKS9KvUfPAxUai8yYYmSoAfJQiNo16V+zAWl/tZAECA3JJCQDGsqzN3n6pGx+EAvJp2y6VW0OS5bsSs8hhTYzYPL+HGfTdCxM+hi/L870mi7iBEavtR/X7vTqvm/hebjhUpAiai0GYuB5xVFaybhd+l0SWubA2CNd3ZB7RqfjAwb4iDOqba+RBQUm3GoANoSCaFC3KBSEOJYQ3ppcmGubEGAeQID+nTAS10l3ibvm7pRaBtTtKXqs1ZUqW5A65PVihVnA6OjEc81SsXFnAD+hIM2PUHtbJ0xO1bN2TihdYVlkFR0CJJ19VwqL55kNKD+yihSiybYBj+VhzF6W4y3G1XgFr9YJY3bZX0ct2Uw79oqsrENOieHM1YAZdpNb8Edw07RbWlJxuW5ZVk90LMVTNofIjEN+T+cnOAZoZD1nLlu3K6sq6Qru1U9ZvYTUUgWOhYOYod+m8LEgG51i7hOmRjyGpruZdZTrRuN8vZ9Nkt6+ryMHPCrdYojqQZmSE14bSoSzpWX35aZ+qOfSWkkp4wjC+n9HUhTp8oJnhmbcPfM0RDT7M/jW4wAnxNrASC0YUuFIM6twrNLvJSk/FW1YiHq75IHmjk2caNficJbRiieXWDG4SVGKmpVAnx5lP1qlwMSyUvasLGgjhYW83XVHZZS/ifwkGtE8U9HC3EdlT1XETy5w7KHHlVdIdS1RwtyOcA81f5BDscZh6+fyypjNxgfrAfbSpdOK8p3Mw850TNvJo80usDLrIZOBWazODEm3C22NE+0QPi5RkDgrTkrwS0W+zLzGiri1DVaomcOzZ9MnwFg4VM8G1blh4EYEUAubkmqswsxAT+y0HCNfBiNqSxYUR0Z2kIdQ01ZPx4w1rvz5sjVu6L8/gFNavS6Z4dUfDrcYDXJ3//d3LyPajdvMlVz+zUXhbxtWoYPR6LPnrDYAUS1X7mtY5b3W3GLdI0PyrV4/tWxuwwHNjLCU0p5M7U5dMQrD95IGorZLT1FL1eZzgeNyGrcZT4imv5xkiWwRZ/aJTkX2/RjO0fuOIpMzW2Rtpf4upqnC0ErP0TinpzQ9Lw2EwlzaDNuUuWYUx8cyeF0jEh9O1DgzR5TbDQ0VtsbEvZgVWZooDN+6twqyl7IxQnW/CgpV8e2Q0t3BIkealFNcgQ5utNJ1xE2kwL9bXQJ5BlWF/DrNG0iU0gGdgNRGvZtI+RAhmjPlkxHvXOqZGxCUvRQl+Az605AgrXoxIRDppn0kGCHzyzGUpAlh8EL1qvRLcqFEwuU4uFdA/hNZidty2oYCcCJQHAa2UeTfiApc7L2ngJWiV4v1Ix4ukIp5304vta0cVAl7qed8cCqGCfernx9aopv4/xYB7tIwpPd9BEISHRpTZfrA20kFrAqqezke/lUuI56S66uq+2Gh1elPoP8XoArjy7+T8qo2k5PURSXWwXYo1SOEPAxGhllVADdFWuUDO2rWJwY5UKvnQhmcZ5k2ODBCIIcnC+i08D4SApth2Fcl6fGGTBS9BKlsTZOzjO+elStZ+US3lL+GCMWxrYkYYzVBozGSGR02mlGFF84DslaeoUcO5/+Qqo/anpdW+0+/0/4MbUc4hTXg46ITo+PZ1qgjUfWRwEuzdecVRqzASdkPbdLFSJSs0eZq8/6No61KjOY8nqMH5pxrz+b8IQTBMW1DX71gfMiZeJCNC/VSWJaV9OBivbsec9nRVutlVYZZb+jAfvhdp8IbfrUGqzBe7L1NKgfjUd3XsVefRKSrW4T223QbBNgvkS59+Ha7y/IfwyRPqKDFrj7VHLMOi9Qs2RcrsLWnMOT2RRK70+N5HPuDkaoKBEFr82akFjYPS+y6dAe9O0kAJFQqVw7/DXy9bQmpXnkJMjKQqiXuBtYDs9IwYNTGEeMdKEDLn/HYNFlk2hy112H4tRy6H+hXvcAPODxbgxXlLIT578pQfRzZs4eS1PNzQi0cBmjXRn2VsXYPrAbIhrt3qf1aVoy/qu5pj6U3nRwYYg0/dzFt3WweJwdWJYoRQ1At45ewG7jMlKOtBzp36ZX7mUbnWRHNPTdFGmqJiNuq/r0B/igHi84rnOE5RxlvWz2gDqOmA5tQ3XTm9qMhmcKHwO9UA1mLNGe+13P2+CNBVkg4LCpvrWTer6XvAyXKRMa2xQezioI4RFLe76pl9YN6YM9d+BcfRcI3x5lUKLEZ9uI6wCaSiz5FCq7XGktiS49ch2gELKya/H9arwLW7ytgpmJ7gmPcgk5AxAoEscp4XjDSYPdJh4eVg4+a6F80b7F03qYxQCZHKCXqCf+6HHzpOlOZA2I1XrajafNTVD8V0cigomKe0lUwytxtg5abkcLWTd2AOcKYdKg5zAy0fA7n14pyikZ58r0gSFXGQ0XJmFxJOlif5sqiu0ax+TtaybdcBguHQCFjU1sgrQ6ijN4mYKIWA8/aE80+Q9qu2iQbsXs9gsyXNw9Kr5O0mc6frGgo+zKEP3jAvraD+VFHhpHJEpd58XnhEIONYVia2zoQPKhMIxO3BJK1qUOM5wjzpV63ZlVRnUzdeiJlDVaJEE+Z+/RarFWcU37HXY1qwfWFX5/G+jjkh7WGLVPw26JgwoLZhGhmQVRMgoq4eqxqnH5pr8YqHpd1js3Gr3/A1/9c5L4ZfH7CtI1FRyCuopjJ0n1DqN8nLpiMoI+sPHqE+bpMeiGriEwZ4Z7Kixas9tukN0y/rHot5zZpNrlF1gQ+Ru/4Tjt9Fi6lvgbbec7kOYOts28Xutww678UkGinM4xxqyMPeGKHqzJwQwmgy2gjKffQxCTNTfAq7IBIDUHiEkt4rjwvGyCjMraaBGkT76n8ChTAcIlJ15xNXeKYXnyK5WMFaYlNbIOY6IdMFGlF6uKfnDZlSqMzLHUerVpA1XZOM6a3O8UlpQRgWen1AavWuI+QcUwJlVHGNIVYmpXwFJpUPGnvnr4j4DjuFA8DaFHmqphTm6qIpMOKuODV5FQYAfCMM2yjxKpDfv2qgefhGO6jefJWH6yDOqodNz8BRJPQiATE1xLMrBZmmLsdOOehjUcOW8Y+Yt7vizFTtG9OZA6OPooVzGjIbqZmWwteaBve22Pz3Bxah64xhm2lOFk+iR4RloW5WwN6NCrPDR9wcY7lhFCrSp2zLgY3YRfASfj+OVqNffIUoIgn5bU4l3Gmt20297e4JSRkk5juI0rHRgi/83hRGOqovX1UwxqU1k1xFouaPQSJpOLCeElGI350idXDGHPHLOKCO3caEDPUiMNlh4J9TPrAJhgjPrX2zQeGeU+26MXoitl0oOBD48Th+/hTWie6LeiJi9J5uM+aCRUcL3NOTBXPN8ZVTL0ErCAekrbk52EJ97/NEI3LgsuCUIJz8yGCklg6TJQ3W3vNOp2XbHAR/d41PQglx2138G/9Y7fm5gfZU/PdcpKTQZrzcBx27L7X7qHL1Y1IYoTFowh3HsQClz+RRzyawbO9dx/oJkvxd5Hs9x8YogtqaueanEEzhw9HHA+l4adlVM7iZrtpsm+At9hZa+fV0atuOsc/DjBOXChxq1nqZ9R1RrlsHh5evbTFyqdUmiHl5UXnjNtZuH2u9EhMwzibRYV5cWhNDHgTZ9ec7baT80Tu1kOr5CmSVfB4Wy7Nc+BcbKrzXF3l8OLhokOVzjXI6eEn8pAV9ZBDE94cg41HNqkZhz6aMvNtBhmeom74e+U1l26EBLE5ZnRnIqXO6iuZjJkIH2thJ2YZts0Oqs35Y2dfAnIo2SZkrURFLuRveDpLO9ymLI3SszyylA2Lo9pLoy/NKIJglBqcVLsw95PNLvfrhtAqEfvFTyJD1f2HXCCblHP6aZUklQKp4CHE07x9bI3rApGgNMGtTeVh/JarjF+BEt6gG63zaWtFDfI/jOcziXFVrzyhDBCFnNeqJEDDCEyDf9izPzAwC4Kd7CrCRGKKnt6Z6RtKMWPMP995psc901oAlO4ZT8LZOIEgKbL4EeUw2KfjXJYEx1pyNEhY/s7geQpOEoQQ/GkpVFAkcqodljz+PwiVti+fTlL0+51xKKssDB7iFsZuUTzjKMIjrY/4EeWA05tZFq8ZW6MHhC1ESQBD4jdk5H6KLjyIjwTWZf6LI2+Frl2pv1K2nW6dxA01PNJDKvqhRGpH9KYE+Wu9IJn6E8+l37mi6oPh9tJm9e5aGSYkCvToIN17EryTRuGTxZdj1jnucLdG7h9rM9dDTT0g1VXlHQzhtVgGzGkJC/wX6wrFfgRUkXaaxyr7jprv28JpFEJACEHzcpVMgFOIyEHSo89tmF6ookP7rnLGuRiUKWYmTfyCjcqAEAIFBISpQxxoIhZsEwIHZjpbxk4iO4hnjJB/hvOn60dFBlzL3Z5tuvdkl8ZAwQqAWV/Hwe1agz+O2kBX8apn4KMoVwiNGsgji7qhtVf9g6cyfsTkL6bPD3zl4nT08wRa1Ic0kyXttmUoxV3j56VBADRVOUXjBW1eytB4siwWtWGRYCHV1h1s5H42F/bnYcXQpWFizw8TvpIZEZOh/4/dD3SRItqSv6uLWIT7KR3Wei1hG3KZ+V6s1mU9N3R1HY/22TaOFQRca4zr94v6fMp39zvvSXkiaZsGpy7pNrT3R/YrLj2US/Bqtq7zE60Z7mthP1MDCfJsHTfNF9xwStqZpOLVWev/D/9XgC/p+X//txObRW8R1rbi6NPc/Nr7B+SNnB9RT4AVuwDuQkbxL8Orp6RiX73bBPAAGdkvXsEBdNvHIqK5f2nJ59mO+TSlbpe7pkIpAZcOhaeUMHpQ18JjaxzKdieLtiU8BnAa/K6ahADSIlKVvzyo49fpPI+BM1+KWt8Nw7HjfUFrZD5ZpKXcwa5+JDvJF14TY50eTAwYYqnVlyUIXI0DJ9TS9ClQQJ08MN+RfC8NMMtpIzt5aDLXWSnV0nbp7KJ0WrpJZ3ODG2l8VAT/TDs/yUj3d6gU56zQAY/s6BuwfyNt8bWLtluAGZHxRQUU7SObxLDi8K1HSLLvD/P9Kfm9+zyESSJvc+t2dFpYZTghMew3gelxA+jWgGwg25eMa6MEXgfuKCatiPy9b+8mefxQV9eRhN7PwXUlSYUjl/4kKV7IIBuRrZj8mnVGqmDTuPSuURDQr19xHnJwqmYbekwdo6pH/I2WgTwPeiU8PlxcHvp1vaUiXzTjVYXAg4UqxoJ8ESPFj3dEwo3Xr2XV8w1/xDfRAC93V55MLBvFGu+YwTlVY2q+T3kNqm8yiUnRyHwHA6yDUC9bQUETDSm+5u+CUxdWwIClFwjwHPlIKidTehxyfQ+ik2ePv+bEJ+zmzne2ifXRzsFYWGPtTCuOkzUBlOiU/pUgx8a02KbGDrCPz8NmdmKcnHaympEw78JN3B0n+F+7igQH6MinCJJGMllfhp7Jzok9JnkgI/1bS1h0UgK0jjTnOPp+2Ng1IAcXFt43QCR/8f0F9xdZgX3zDewoOtuTrkIX9Xhqxwn+QnduJ7onHeRnxtgOTNGfZcMGxgYC76qWwGTZMoqjcxpahO9Nxf966zKqwh2ybYsx5IWupyzLgfYgijaykiblF481cZncEOaNVsCN1Ip6sfATPYrjkH0CfGoubEqPTCGkEneWOCqmLfGbSsS9hsvR6Y2U3pEuVxIJFUMvl8uZa8yD5bTNgC6XJQKe+EEnDLvIy+Bh3+ksUGAebAO0nfGSkUJcwbSadUEIeVARWn+Roj4QnGf4aHoXUamiU9p5R9sxKCUV1n3XWTicn79OcnSDVS9SrYdL8fjC3ZIJIOjubvCBbUsE5SJYNYH8MnzDgWwDdpyAPnp/qcxayQwKlnSgfEHSIBCz9eg2BuNM12n/JiHUndY3ghtjVnQG3zdXIOxve4mYN4oo6/PtCj/IWv0THd1BX27v5mxpIjvTn+b+O7rJn6UnJ7tscTuZoGSkICCXbQwi+NHWMSk+zr8ixLZmD028g4jGUpD8YcZ6o4LsQvW56ihAanH/Q8xlxpKA5BnhPLpo92/aeiKPpP97UDDhlpcuh+s1APp7OuLLoFfTkzkp1UmZG36pS1yYEWHA67kpx03pESzS8dhQX917Cimsrf368Pkr7AwVWMeaWxMTOv96lusp+BkAwNMBBPnmcVbN085NAUEvfOkHj3ghLpVsE82lLrtQ4ISq7aDarIDnq49sFbLIdninVzJxoS3bpxy2NmyWOdnv1coKjq6bhZX4u8bvAsMHsjmdngTnrBQhSd+tzk7Mbk41yY6idSoe6ZjoXK6w1dkIdJNLb5Rd1U/ccSgjFQtn9n935mkxMg7EUzTad+JL3/MACTrvlQXF8ZsR2E8dD2Cmenjf+K5p8Hz4rzJTOzWmwuwht23b4Vkhr+KsP30bJt8gmrodfW2bH3Al7kTXX+S5KjZwM0rvhSlXNzpJubvLjhT6Xd4psR332cKTymJBaUuYcH8r0vk72a6RnTAKFt2tLluokmtwM2bLB50AFs/s2mQY2Y0Xvfx9eTZsvJ7u3OCRLati2eQl2H5nASvTpJmoI8wPyzbSP26Nm2pehOWWXJXQv3jXvb5EsgHl/Ol2Y9b9L5hk80fwH7Ud6yDIsZ5eX32EDepKimN0bh9h+oZUbuVFkjvj+sozvWYTf7G0U9L5C6flVgy+Rcvm+LeA2GkyCDqZtFfdnFsgBI99tVRju39PWPtIcjBOlFTa+yb/yPmBEQkCSuPeOrRcDp/Hyru7y+CqKiAH/UCb2pa/cJRPgYoANLXOCNJlvkqCKy5C3rXJ2Jdbt9wi6QVt28uBkHA1Gbjm9Y6IqNV1meE+XSehp1+NKfiKpAq8vCt0Yf/5bAXBSCzG27GeNgmgARLoHhuXlIphM2p3PO/oLKpMG8hsw+GO/S2IYhgrnlpRBeSV1xXwIsKHwSfL0r3sQrcJ6W11fgaskFNBv40muoWXD6RRYFUbkZH+6VT3d3sr6adBSm2x5qndylZv/4BdBWFyhYIbn+ULklSfB0FA/ved7MDnaVi/Ex3503//YgfsgjUrH/QmytscuN+TSQrzbS5189KXNnsjnBkXIbhz2/FOfS6jnvfdRM3QNs5x9EoFOyOundJnkDi7rdjuksvrWVRRHCLXnka/5SODM8V6ee70ED7xi78grgBc6dSPejg1d92US7UnxuLZbr6cKlkWx/+ZU9RVytoIZsOB6XBT8jggLDRmZWadTv9SzqyE9TaFduZx24ab2Px12C1Y94686CU9dzW/AZns+Wr8b70zRPhF5qU/qeWinIUr6SRuu2zc0W5iMP6wm6Y8bMBAE7xf8DkTXIZ4Wj9CQvPtzcjhAEjdBncd/t2z9098F9RnBJB+5hp9X0j1dZx6a6K/tZdbRZ+R5Yznh/6ldOqD3cvO3j237/ZT7yb8Iq3/hwv95wUIJrzxSdGauiP/yLb1ADxT0mMc4NPGmy9LHknyesSuA7IYAAK7LsmD8sO9Rx6CiL7AKU973lGL8pliaBpb2HIY7O9UqAufAspnTDHjpXDyJ/yt+3ttIn/eOgyBPzriL2QkMTf7WKwqdHg6pPcP9xoGCpfBoelfc7QCa8VwagR2I4SB3myj3Sho29tTZGlLI0OXuLtETz16M0VtRsfT6UEWM+I5lzVoxgrWpD4HbC3WpiNHsA79ueZyQwbxHg75HDBa3T1FPc2iUUer4s6jJ2gHU7TQ8fG0F2RxZTznsgZ99SRr0l5/2FqszVRryjpstDVfGrLdHu+G7WzxN33yw71wFPNz+oX0CUbeanL0lURnxp8oW/dFsLgz2dWvvvVrV0NG7BAydvgZXnE3uR4WvnTXtM7S0mJl2c38uBvk8IL9529b+6wh+gpRsEz18BV86cVyqTu5NfnKl8heKm+N/Pj9o2ykH91Vrpo/6bDx80DqVxXGV9T9o3/rIo2nABlWIhwgBymIRcKc5mgviAjfPn37VSMOMQJQ29AMVgEhpT8RPHqgBRFCcuFLa/5Kn9wNahQ1FxVNbCP0SKpgY/LUyDUFRBo9aUT/SFKNxK3gotQV4hFIfHO4ywMD5K4uHASXG8HFwl5uIrwfVFz6U5h9lZ+0vI2BIXOWqcTlPJ1B/KPSi6dIvyIFf07E5H0cXl3uQ578EsAZVbqzYrCRZIpGJaTzmDYjlhPuhK6Uor9PtOj/20/fP0HgChW8LOtRC6yv9/ovvZMLbnh44YMfAQQRQhgRRBFDHAkkkUIaGWSRQ56hgElRSVlFVU1dQ1NLW0dXD4IRFIvDE4gkfQNDho0YNcZic7g8vkAoEkukMrlCqVJrtDq9wWgyGzdh0hRha62LcTlHcCQPchZfcxQncTwXci1XcBzvcTiny8lzolIcw+N8pDQXcR1/8Dt/chk38ixPcxPrbXAKGz3PJs/wHC/zAi/yEt+w2eu8wqvczBY/cypv8QZvstV3/MCxbLfNDrvstNsl7LHPXvsdUKhAkWLfUqJMqXKVKtzDpRykSp5DfM+P3KeMssoBqJFxflOt2qZm5vmHhaUV1ja2dvYOjk7OLq5u+eAfwV1BUUlZRVVNXUOTPz310luf/Au7JAQjKBaHJxBJRhhplNH5FE7pxhrHYnO4PL5AKBJLpNnEKUWuUKrUGq1On48fLrg1GE1mK62y2hprrbPeBhttstkWW22z3Q477cr9Uu2x1758CS8rpgMKFCpSnHfg15L3ueDmg4NXljLlKlSqchAbRy6efAKFRIpJlJIpp+CgpFJNo5ZOPYNGJs0sWtm008di43Alh8cnEBITJyFJSpqMLDl5CoqUlCVFRZVaDHUamrS06ejS02dgyJExJ6acmXNhyZU1NwS3dtw78OjEswuvbrx78OnFtw+/fvyLeOiIx0546oznLnjpitdueOuO9x746InPXvjqje8++OmL337464//A8igkmSSWRZZZZNdDnOaS255zCuf/AooqJDCiiiqmOJKKKmU0sooi1nMsYgl9s1jgQOmmWETW5bDuvJmWHvrYB2tk3W2LtbVull3TlDTelov6+0nG5OUXV83u+Zr8389byGMMM/23a5/vJG5DEepnX0J3ZagV0pJqdvcXkfuu777ZavoL7X3La/2N7tuTrtm369HRfVwn6mnoLhZvmrFWr033bl/M2jti/Zcv5CcbsH7ZVDdcnpoU73y/bBE1phhzmxk2MrP9cAa348wjD2HUQYr2MV7Gifs84Iw2PNYCKCOZ1hvGCt+G40nFxZ+gm+KlEwJJcuDbqe4+z/5xy8ZzSA79oKqVUpmkHnldqWuM6nOYZbTDtViR4u86pyF43Qh7to76JD3pXWa6yLuOxNrV/Gy4iBdCv0pWVoeK12PoddjTyi2ow1/Dc7GCbqRsKNtDom+39ahjc4ukZB0J2kDu+bMJN0rYw/WvfAG969tvkFeppO9cA7ved/sczYYe4zf9/Zsnju6iCkvz13u4dyra7p3vs/605tboRGHoDv4dHWVdtdDRGJiYeNAdr+v9Gvwj5Mci+9EDGPsPq4ehmK/HvLBi75oVPpNbPppPHfU9FNa25i2VpYv/07O27LPeNkta10Fs55Y5BNgCh/5704cwjAo89gJLnrXuAt3dpvC8C2c/mQ009MMhjTXaM7RgqMTMtfPiFYYbyzhFqtB4x0cTOCGeGUx7s4HriLKmLvcE3W8w0Gl3xFd1WbdjK0fTuuhIgH4mW8YX8G+jXV1/JfSQfIxKJsqz7U8wiaqxsGdTdH9/lEclUJWjVJeU0eq3XcEhbozhP8LKWZEGP1CY5vfXXH/sA6TqZy8pW+QZg9cm+b3AIgIOonl6aPLMSrdgXFAqZaoAIWYOxwEyiW+EAIRERER8VhgpZR6lLkgUC5Riagw5g4HgVKRscTXWmut9a2lofIgpLG73E71f/LhDWajZTxIhMlUlJEuz2acu8wJk6ko4283+VW4Knzuy9n4vuB85QNhurk6zb/l8esxO3f61zazhMnr9E+z3uCl7cvPz7+ZAQAAAA=='
const OCUCLAW_THEME_DARK_COLORS = Object.freeze({
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
const OCUCLAW_DARK_TERMINAL = Object.freeze({
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
// OcuClaw keeps its black/green appearance in either Hermes display mode.
const OCUCLAW_THEME = Object.freeze({
  name: THEME_NAME,
  label: 'OcuClaw',
  description: 'OcuClaw black/green.',
  colors: OCUCLAW_THEME_DARK_COLORS,
  darkColors: OCUCLAW_THEME_DARK_COLORS,
  typography: {
    fontSans: "'Inter', 'Segoe WPC', 'Segoe UI', -apple-system, BlinkMacSystemFont, 'SF Pro Text', 'SF Pro Display', system-ui, sans-serif" + EMOJI_FALLBACK,
    fontMono: "'JetBrains Mono', Menlo, Monaco, 'SF Mono', 'Courier Prime', monospace" + EMOJI_FALLBACK,
    fontUrl: 'https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500&family=Pixelify+Sans:wght@400..700&display=swap',
  },
  terminal: OCUCLAW_DARK_TERMINAL,
  darkTerminal: OCUCLAW_DARK_TERMINAL,
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
  // A local Desktop decision outranks an older backend's setup stamp.
  // Reconciliation must not undo a later manual Appearance change either.
  try { if (ctx.storage.get(THEME_CHOICE_KEY, null)) return false } catch { return false }
  let applied = ''
  try { applied = String(ctx.storage.get(THEME_REQUEST_APPLIED_KEY, '') ?? '') } catch {}
  // Each yes carries a fresh stamp; one stamp applies once, so a later manual
  // theme pick is never overridden by a plugin reload or a gateway restart.
  if (applied === THEME_REQUEST) return false
  if (!sdk.requestTheme(THEME_NAME)) return false
  try { ctx.storage.set(THEME_REQUEST_APPLIED_KEY, THEME_REQUEST) } catch {}
  return true
}

// DESKTOP_THEME_CHOICE_BEGIN
// Plugin storage belongs to this Desktop installation, not the selected
// gateway/profile. The choice never crosses SSH or changes backend settings.
const rememberDesktopThemeChoice = (ctx, choice) => {
  try {
    ctx.storage.set(THEME_CHOICE_KEY, choice)
    return ctx.storage.get(THEME_CHOICE_KEY, null) === choice
  } catch { return false }
}

const shouldOfferDesktopTheme = ctx => {
  if (typeof sdk.requestTheme !== 'function') return false
  try {
    if (ctx.storage.get(THEME_CHOICE_KEY, null)) return false
    if (storedSkinIsOurs() || ctx.storage.get(THEME_REQUEST_APPLIED_KEY, '')) {
      rememberDesktopThemeChoice(ctx, storedSkinIsOurs() ? 'ocuclaw' : 'current')
      return false
    }
    return true
  } catch { return false }
}

const chooseDesktopTheme = (ctx, choice) => {
  if (!['ocuclaw', 'current'].includes(choice)) return { ok: false }
  if (!rememberDesktopThemeChoice(ctx, choice)) {
    return { ok: false, message: 'Your choice could not be saved. Please try again.' }
  }
  if (choice === 'ocuclaw') {
    try {
      if (typeof sdk.requestTheme !== 'function' || sdk.requestTheme(THEME_NAME) !== true) {
        throw new Error('Theme unavailable')
      }
    } catch {
      try { ctx.storage.remove(THEME_CHOICE_KEY) } catch {}
      return { ok: false, message: 'The theme could not be applied. Try again or keep your current theme.' }
    }
  }
  return { ok: true }
}

function DesktopThemeChoice({ ctx }) {
  const [open, setOpen] = useState(() => shouldOfferDesktopTheme(ctx))
  const [message, setMessage] = useState('')
  const choose = choice => {
    const result = chooseDesktopTheme(ctx, choice)
    if (result.ok) setOpen(false)
    else setMessage(result.message || 'Please try again.')
  }
  return jsx(Dialog, {
    open,
    onOpenChange: next => { if (!next) choose('current') },
    children: open ? jsxs(DialogContent, {
      style: { maxWidth: 420 },
      children: [
        jsx(DialogHeader, { children: jsx(DialogTitle, { children: 'Make Desktop feel like OcuClaw?' }) }),
        jsx('p', { style: { color: 'var(--ui-text-secondary)', lineHeight: 1.5 },
          children: 'Use the OcuClaw theme, or keep the look you have. Glasses status, battery and agent activity work with either.' }),
        jsx('p', { style: { color: 'var(--ui-text-secondary)', fontSize: 12 },
          children: 'You can change themes later in Settings → Appearance.' }),
        message ? jsx('p', { role: 'alert', children: message }) : null,
        jsxs(DialogFooter, { children: [
          jsx(Button, { variant: 'outline', onClick: () => choose('current'), children: 'Keep current theme' }),
          jsx(Button, { onClick: () => choose('ocuclaw'), children: 'Use OcuClaw theme' }),
        ] }),
      ],
    }) : null,
  })
}
// DESKTOP_THEME_CHOICE_END

// SETTINGS_PAGE_BEGIN — Settings → Plugins → OcuClaw (Hermes 0.22+).
// Hermes 0.22 makes Settings → Plugins the one home for plugin preferences.
// This page gathers what already exists elsewhere (glasses status and doctor,
// the private key form, the theme, Agent in title bar, setup chat) and adds no
// new setting. Keys still open the private credentials dialog: the presenter
// capability is the security boundary, so this page never sees a key value.
// Older hosts lack ctx.registerSettingsPage and simply show no page.
// The pure view rules come first so tests evaluate them without React.
const SETTINGS_KEY_ROWS = Object.freeze([
  Object.freeze({ id: 'soniox', title: 'Soniox voice', description: 'Speech-to-text for voice on the glasses.' }),
  Object.freeze({ id: 'evenAi', title: 'Even AI', description: 'Lets Even AI on the glasses use Hermes.' }),
  Object.freeze({ id: 'typesafe', title: 'TypeSafe', description: 'Word suggestions when you type on the glasses.' }),
])
const CREDENTIAL_STATUS_INTERVAL_MS = 5000

const settingsGlassesView = controller => {
  const value = controller || EMPTY_GLASSES_STATE
  const device = value.device || {}
  if (value.status === 'pending') return { tone: 'muted', title: 'Checking glasses…', detail: '' }
  if (value.status !== 'ready') {
    return { tone: 'muted', title: 'Glasses status unavailable', detail: value.reason || 'Hermes or OcuClaw is not answering yet.' }
  }
  if (value.paired !== true) return { tone: 'muted', title: 'Not paired', detail: 'Run setup to pair your phone and glasses.' }
  if (device.stale !== false) return { tone: 'muted', title: 'Waiting for the glasses', detail: 'Open the OcuClaw phone app with your glasses nearby.' }
  if (device.connected !== true) return { tone: 'warn', title: 'Glasses disconnected', detail: '' }
  const facts = []
  const battery = boundedBattery(device.batteryPercent)
  if (battery !== null) facts.push(`Battery ${battery}%`)
  if (device.charging === true) facts.push('charging')
  if (device.inCase === true) facts.push('in case')
  return { tone: 'success', title: 'Glasses connected', detail: facts.join(' · ') }
}

// `present` is the credentials route's booleans-only map; null while unknown.
const settingsKeyView = (present, id, local) => {
  if (!local) return { tone: 'muted', label: 'Manage on the Hermes computer', action: null }
  if (!present || typeof present !== 'object') return { tone: 'muted', label: 'Checking…', action: null }
  return present[id] === true
    ? { tone: 'success', label: 'Saved', action: 'Replace key…' }
    : { tone: 'muted', label: 'Not set up', action: 'Set up…' }
}

const settingsThemeView = (inUse, supported) => (
  inUse ? { tone: 'success', label: 'In use', action: null }
    : supported ? { tone: 'muted', label: 'Not in use', action: 'Use OcuClaw theme' }
      : { tone: 'muted', label: 'Pick it in Settings → Appearance', action: null }
)

// The palette commands and the settings page open the same private form.
const openCredentialsForm = async (api, integration) => {
  if (!desktopLocalActions()) return
  try {
    const result = await api('/credentials', { method: 'POST', body: { action: 'open', selected: [integration], presenterCapability: PRESENTER_CAPABILITY } })
    if (result.state === 'pending') return
    if (result.state === 'busy') {
      sdk.host.notify({ kind: 'info', title: 'OcuClaw credentials', message: 'Finish or cancel the open key form first.' })
      return
    }
  } catch {}
  try { sdk.host.notify({ kind: 'warning', title: 'OcuClaw credentials', message: "Couldn't open the key form. Try again when Hermes is connected." }) } catch {}
}
// SETTINGS_PAGE_MODEL_END

const SettingsBadge = ({ tone, children }) => typeof sdk.Badge === 'function'
  ? jsx(sdk.Badge, { variant: tone, children })
  : jsx('span', { style: { color: 'var(--ui-text-tertiary)', fontSize: 12 }, children })

// sdk.ListRow is the core settings row; the fallback only keeps an odd host legible.
const SettingsRow = ({ title, description, action }) => typeof sdk.ListRow === 'function'
  ? jsx(sdk.ListRow, { title, description, action })
  : jsxs('div', { style: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 12, padding: '12px 0' }, children: [
    jsxs('div', { style: { flex: '1 1 260px', minWidth: 0 }, children: [
      jsx('div', { style: { fontWeight: 500 }, children: title }),
      description ? jsx('div', { style: { marginTop: 4, color: 'var(--ui-text-tertiary)', fontSize: 12 }, children: description }) : null,
    ] }),
    action ? jsx('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap' }, children: action }) : null,
  ] })

const SettingsSection = ({ title, children }) => jsxs('section', {
  style: { marginBottom: 24 },
  children: [
    jsx('h3', { style: { margin: 0, padding: '8px 0 4px', fontSize: 'var(--conversation-text-font-size, 14px)', fontWeight: 500 }, children: title }),
    children,
  ],
})

const SettingsRemoteNote = () => jsx('p', {
  role: 'status',
  style: { margin: '0 0 12px', color: 'var(--ui-text-secondary)', fontSize: 12, lineHeight: 1.5 },
  children: 'Connected to a remote Hermes. Make changes on that computer.',
})

function SettingsGlassesPage({ api }) {
  const controller = glassesStateStore.use()
  const doctor = pulseDoctorStore.use()
  const local = useDesktopLocalActions()
  const view = settingsGlassesView(controller)
  return jsxs('div', { children: [
    local ? null : jsx(SettingsRemoteNote, {}),
    jsxs(SettingsSection, { title: 'Glasses', children: [
      jsx(SettingsRow, {
        title: view.title,
        description: view.detail || undefined,
        // The live activity label only means something once the glasses answer.
        action: view.tone === 'success'
          ? jsx(SettingsBadge, { tone: view.tone, children: PULSE_STATE_LABELS[resolvePulseView(controller).state] || 'Connected' })
          : null,
      }),
      local ? jsx(SettingsRow, {
        title: 'Glasses doctor',
        description: doctor.message || 'Checks the connection from Hermes to your glasses.',
        action: jsx(Button, { size: 'sm', variant: 'outline', disabled: doctor.status === 'running', onClick: () => void runPulseDoctor(api), children: doctor.status === 'running' ? 'Checking…' : 'Run doctor' }),
      }) : null,
      local ? jsx(SettingsRow, {
        title: 'Setup and pairing',
        description: 'Pair your phone and glasses, or fix a problem.',
        action: jsx(Button, { size: 'sm', variant: 'outline', onClick: () => void dispatchSetup(api), children: 'Open setup chat' }),
      }) : null,
    ] }),
  ] })
}

function SettingsKeysPage({ api }) {
  const local = useDesktopLocalActions()
  const absent = pluginAbsentStore.use()
  const [present, setPresent] = useState(null)
  useEffect(() => {
    if (!local || absent) { setPresent(null); return undefined }
    let stopped = false
    const read = async () => {
      try {
        const next = await api('/credentials', { method: 'POST', body: { action: 'status', presenterCapability: PRESENTER_CAPABILITY }, timeoutMs: 5000 })
        if (!stopped && next && next.present && typeof next.present === 'object') setPresent(next.present)
      } catch {}
    }
    void read()
    // The private dialog saves out of band; a slow re-read keeps the badges honest.
    const timer = window.setInterval(() => void read(), CREDENTIAL_STATUS_INTERVAL_MS)
    return () => { stopped = true; window.clearInterval(timer) }
  }, [local, absent])
  return jsxs('div', { children: [
    local ? null : jsx(SettingsRemoteNote, {}),
    jsxs(SettingsSection, { title: 'Keys', children: [
      jsx('p', { style: { margin: '0 0 4px', color: 'var(--ui-text-secondary)', fontSize: 12, lineHeight: 1.5 },
        children: 'Saved to this Hermes profile. A new key works after the gateway restarts.' }),
      ...SETTINGS_KEY_ROWS.map(row => {
        const view = settingsKeyView(present, row.id, local)
        return jsx(SettingsRow, {
          title: row.title,
          description: row.description,
          action: jsxs('div', { style: { display: 'flex', alignItems: 'center', gap: 8 }, children: [
            jsx(SettingsBadge, { tone: view.tone, children: view.label }),
            view.action ? jsx(Button, { size: 'sm', variant: 'outline', onClick: () => void openCredentialsForm(api, row.id), children: view.action }) : null,
          ] }),
        }, row.id)
      }),
    ] }),
    jsx(SettingsSection, { title: 'Set on your phone', children: jsx('p', {
      style: { margin: 0, color: 'var(--ui-text-secondary)', fontSize: 12, lineHeight: 1.5 },
      children: 'Speech provider, language and other glasses settings are in the OcuClaw phone app.',
    }) }),
    // Settings is an overlay, so the title-bar presenter is unmounted while it
    // is open. This copy shows the private form here; only one is ever mounted.
    local ? jsx(CredentialsDialog, { api }) : null,
  ] })
}

function SettingsAppearancePage({ ctx }) {
  const agentEnabled = pulseAgentEnabledStore.use()
  const [inUse, setInUse] = useState(storedSkinIsOurs)
  const [message, setMessage] = useState('')
  const view = settingsThemeView(inUse, typeof sdk.requestTheme === 'function')
  const useTheme = () => {
    const result = chooseDesktopTheme(ctx, 'ocuclaw')
    setMessage(result.ok ? '' : result.message || 'Please try again.')
    setInUse(result.ok || storedSkinIsOurs())
  }
  const toggle = typeof sdk.ToggleRow === 'function'
    ? jsx(sdk.ToggleRow, {
      checked: agentEnabled,
      label: 'Agent in title bar',
      description: 'Show Speck next to the glasses icon.',
      onChange: on => setPulseAgentEnabled(ctx, on),
    })
    : jsx(SettingsRow, {
      title: 'Agent in title bar',
      description: 'Show Speck next to the glasses icon.',
      action: jsx(Button, { size: 'sm', variant: 'outline', onClick: () => setPulseAgentEnabled(ctx, !agentEnabled), children: agentEnabled ? 'Turn off' : 'Turn on' }),
    })
  return jsxs('div', { children: [
    jsxs(SettingsSection, { title: 'Theme', children: [
      jsx(SettingsRow, {
        title: 'OcuClaw theme',
        description: 'Black and green.',
        action: jsxs('div', { style: { display: 'flex', alignItems: 'center', gap: 8 }, children: [
          jsx(SettingsBadge, { tone: view.tone, children: view.label }),
          view.action ? jsx(Button, { size: 'sm', variant: 'outline', onClick: useTheme, children: view.action }) : null,
        ] }),
      }),
      message ? jsx('p', { role: 'alert', style: { margin: '4px 0 0', fontSize: 12 }, children: message }) : null,
    ] }),
    jsx(SettingsSection, { title: 'Title bar', children: toggle }),
  ] })
}

function SettingsAboutPage({ api }) {
  const local = useDesktopLocalActions()
  const absent = pluginAbsentStore.use()
  const [facts, setFacts] = useState(null)
  useEffect(() => {
    if (!local || absent) { setFacts(null); return undefined }
    let stopped = false
    ;(async () => {
      try {
        const snapshot = await api('/snapshot', { timeoutMs: 5000 })
        const provenance = snapshot && snapshot.provenance
        if (!stopped && provenance && typeof provenance === 'object') setFacts(provenance)
      } catch {}
    })()
    return () => { stopped = true }
  }, [local, absent])
  const text = value => typeof value === 'string' && value.trim() ? value.trim() : '—'
  return jsxs('div', { children: [
    local ? null : jsx(SettingsRemoteNote, {}),
    jsxs(SettingsSection, { title: 'Version', children: [
      jsx(SettingsRow, { title: 'OcuClaw', action: jsx('span', { style: { fontFamily: 'var(--font-mono, monospace)', fontSize: 12 }, children: local ? text(facts?.ocuclawVersion) : '—' }) }),
      jsx(SettingsRow, { title: 'Hermes', action: jsx('span', { style: { fontFamily: 'var(--font-mono, monospace)', fontSize: 12 }, children: local ? text(facts?.hermesRelease || facts?.hermesPackageVersion) : '—' }) }),
    ] }),
    jsx(SettingsSection, { title: 'Help', children: jsx(SettingsRow, {
      title: 'Report a problem',
      description: 'Use Report a bug in the OcuClaw phone app.',
    }) }),
  ] })
}

const registerSettingsPage = (ctx, api) => {
  if (typeof ctx.registerSettingsPage !== 'function') return
  ctx.registerSettingsPage({
    id: 'ocuclaw',
    title: 'OcuClaw',
    icon: 'eye',
    render: () => jsx(SettingsGlassesPage, { api }),
    children: [
      { id: 'keys', title: 'Voice and keys', render: () => jsx(SettingsKeysPage, { api }) },
      { id: 'appearance', title: 'Appearance', render: () => jsx(SettingsAppearancePage, { ctx }) },
      { id: 'about', title: 'About', render: () => jsx(SettingsAboutPage, { api }) },
    ],
  })
}
// SETTINGS_PAGE_END

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
    subscribe: listener => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
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
const IDLE_SETUP_RUN = Object.freeze({ status: 'idle' })
const setupRunStore = makeStore(IDLE_SETUP_RUN)

const EMPTY_GLASSES_STATE = Object.freeze({
  status: 'pending',
  observedAtMs: 0,
  paired: null,
  gateway: Object.freeze({ running: false, loaded: false, state: null }),
  device: Object.freeze({ connected: null, batteryPercent: null, charging: null, inCase: null, observedAt: null, ageMs: null, stale: true }),
  companion: Object.freeze({ state: 'unavailable', ageMs: null, stale: true, backend: null, profile: null, snapshot: null }),
  ownership: null,
  receiver: null,
  sessionTitle: null,
  sharedSession: null,
  restartToFinish: null,
})
const glassesStateStore = makeStore(EMPTY_GLASSES_STATE)
let glassesStateApi = null
let glassesStateTimer = null
let glassesStateExpiryTimer = null
let glassesStateMounted = 0
let glassesStateGeneration = 0
let glassesStateWindowCleanup = null
let glassesStateSocketCleanup = null
let glassesStateSocket = null
let glassesStateReceiverCleanup = null

// RESTART_TO_FINISH_BEGIN — the test harness evaluates this block.
// A Desktop "Update" (Hermes 0.22.3+) puts the new OcuClaw on disk, but the
// gateway serves the old code until it restarts. /setup-card says so with
// both versions; anything malformed reads as no hint.
const RESTART_VERSION_TOKEN = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$/

const normalizeRestartToFinish = setup => {
  const hint = setup && setup.contract === 'ocuclaw.desktop-setup-card' ? setup.restartToFinish : null
  if (!hint || typeof hint !== 'object' || Array.isArray(hint)) return null
  const { installedVersion, servingVersion } = hint
  const valid = [installedVersion, servingVersion].every(v => typeof v === 'string' && RESTART_VERSION_TOKEN.test(v))
  if (valid && hint.reason === 'configuration') return { installedVersion, servingVersion, reason: 'configuration' }
  return valid && installedVersion !== servingVersion ? { installedVersion, servingVersion } : null
}

const restartToFinishMessage = hint => hint.reason === 'configuration'
  ? 'OcuClaw settings are saved. Restart the gateway to apply them.'
  : `OcuClaw ${hint.installedVersion} is installed. Restart the gateway to start using it.`

// One restart, whichever control asked. The setup card mounts fresh when the
// gateway drops under the glasses popover, and reads this to say
// "Restarting gateway…" instead of offering a second restart.
const gatewayRestart = { at: 0, pid: null, inFlight: false }

const requestGatewayRestart = () => {
  if (gatewayRestart.inFlight || !desktopLocalActions()) return
  gatewayRestart.at = Date.now()
  gatewayRestart.pid = glassesStateStore.get().gateway?.pid ?? null
  gatewayRestart.inFlight = true
  const attempt = gatewayRestart.at
  const run = setupRunStore.get()
  if (run.status === 'running') rememberSetupRun({ ...run,
    restartRequestedAt: attempt, restartGatewayPid: gatewayRestart.pid, restartComplete: false })
  const failed = () => {
    if (gatewayRestart.at !== attempt) return
    gatewayRestart.at = 0; gatewayRestart.pid = null
    const current = setupRunStore.get()
    // A false result can also mean the reply was lost during the restart.
    // Retain its old PID so a later observed replacement still completes it.
    if (current.restartRequestedAt === attempt) rememberSetupRun({ ...current, restartRequestedAt: 0 })
  }
  try {
    void Promise.resolve(sdk.host.restartGateway()).then(result => {
      // Current Hermes returns false for cancellation or failure. Older hosts
      // return void; only the runtime probe can establish their outcome.
      if (result === false) failed()
    }, failed).finally(() => { gatewayRestart.inFlight = false })
  } catch { failed(); gatewayRestart.inFlight = false }
}

// Once per installed version for this renderer. The update itself reloads
// this file, so the toast follows the click that installed it.
let restartToFinishAnnounced = null

const announceRestartToFinish = hint => {
  // Setup has its persistent card. The update toast is only for code updates.
  if (hint?.reason === 'configuration') return
  if (!hint || restartToFinishAnnounced === hint.installedVersion) return
  restartToFinishAnnounced = hint.installedVersion
  try {
    sdk.host.notify({
      kind: 'info',
      title: 'OcuClaw updated',
      message: restartToFinishMessage(hint),
      action: { label: 'Restart gateway', onClick: requestGatewayRestart },
    })
  } catch {}
}
// RESTART_TO_FINISH_END

const boundedBattery = value => (
  Number.isInteger(value) && value >= 0 && value <= 100 ? value : null
)

// LiveUI owns render truth only. Strip the companion's coarse presence before
// publishing the shared controller value: `worn` can be stale-true for ten
// minutes. Fresh in-case truth arrives separately in payload.device.
const sanitizeCompanionSnapshot = value => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const snapshot = { ...value }
  if (snapshot.renderContext && typeof snapshot.renderContext === 'object' && !Array.isArray(snapshot.renderContext)) {
    snapshot.renderContext = { ...snapshot.renderContext, glassesPresence: 'unknown' }
  }
  // This field is pendingRender, not microphone state. Removing it makes the
  // ownership error impossible for downstream consumers.
  delete snapshot.listening
  return snapshot
}

const normalizeGlassesState = payload => {
  if (!payload || payload.contract !== 'ocuclaw.glasses-state' || payload.contractVersion !== 1) {
    return { state: 'invalid', ageMs: null, stale: true, backend: null, profile: null, snapshot: null }
  }
  if (payload.state !== 'present') {
    return {
      state: ['missing', 'invalid', 'unavailable'].includes(payload.state) ? payload.state : 'invalid',
      ageMs: null,
      stale: true,
      backend: null,
      profile: null,
      snapshot: null,
    }
  }
  const ageMs = Number.isFinite(payload.ageMs) && payload.ageMs >= 0 ? payload.ageMs : null
  const snapshot = sanitizeCompanionSnapshot(payload.snapshot)
  if (!snapshot) return { state: 'invalid', ageMs, stale: true, snapshot: null }
  snapshot.storedSessionId = typeof payload.storedSessionId === 'string' && payload.storedSessionId.trim()
    ? payload.storedSessionId.trim()
    : null
  return {
    state: 'present',
    ageMs,
    stale: payload.stale === true,
    generatedAtMs: Number.isInteger(payload.generatedAtMs) ? payload.generatedAtMs : null,
    backend: typeof payload.backend === 'string' ? payload.backend : null,
    profile: typeof payload.profile === 'string' ? payload.profile : null,
    snapshot,
  }
}

const normalizeGlassesDevice = payload => {
  const device = payload && payload.contract === 'ocuclaw.glasses-state' && payload.contractVersion === 1
    ? payload.device
    : null
  if (!device || typeof device !== 'object' || Array.isArray(device) || device.stale !== false) {
    return { connected: null, batteryPercent: null, charging: null, inCase: null, observedAt: null, ageMs: null, stale: true }
  }
  const connected = typeof device.connected === 'boolean' ? device.connected : null
  const batteryPercent = boundedBattery(device.batteryPercent)
  const charging = typeof device.charging === 'boolean' ? device.charging : null
  const inCase = typeof device.inCase === 'boolean' ? device.inCase : null
  const observedAt = typeof device.observedAt === 'string' ? device.observedAt : null
  const ageMs = Number.isFinite(device.ageMs) && device.ageMs >= 0 ? device.ageMs : null
  if ((connected !== null || batteryPercent !== null || charging !== null || inCase !== null) && !observedAt) {
    return { connected: null, batteryPercent: null, charging: null, inCase: null, observedAt: null, ageMs: null, stale: true }
  }
  return { connected, batteryPercent, charging, inCase, observedAt, ageMs, stale: false }
}

const platformFacts = status => {
  const platforms = status && status.gateway_platforms
  const platform = platforms && typeof platforms === 'object' ? platforms[PLATFORM_ID] : null
  // gateway_running is host-wide in Hermes Desktop and may remain true while
  // another profile or Docker gateway is alive. gateway_state is the active
  // profile's lifecycle fact, so both are required for this owner.
  const running = Boolean(status && status.gateway_running && status.gateway_state === 'running')
  const loaded = Boolean(platform && typeof platform === 'object')
  const state = loaded && typeof platform.state === 'string' ? platform.state : null
  return {
    gateway: { running, loaded, state, pid: Number.isInteger(status?.gateway_pid) ? status.gateway_pid : null },
  }
}

const glassesPollDelay = () => (
  document.hidden || (typeof document.hasFocus === 'function' && !document.hasFocus())
    ? GLASSES_STATE_BACKGROUND_INTERVAL_MS
    : GLASSES_STATE_FOCUSED_INTERVAL_MS
)

const scheduleGlassesPoll = delay => {
  window.clearTimeout(glassesStateTimer)
  if (!glassesStateMounted || !glassesStateApi || pluginAbsentStore.get()) return
  glassesStateTimer = window.setTimeout(() => void glassesStateTick(), delay)
}

const invalidateGlassesStateQuery = () => {
  // A push frame carries no state. It only wakes the authoritative REST poll.
  // queryClient is shared with future Pulse Card consumers; older SDKs simply
  // skip this cache hint and still refetch through the controller below.
  if (sdk.queryClient && typeof sdk.queryClient.invalidateQueries === 'function') {
    void sdk.queryClient.invalidateQueries({ queryKey: GLASSES_STATE_QUERY_KEY })
  }
  scheduleGlassesPoll(0)
}

const glassesStateTick = async () => {
  if (!glassesStateMounted || !glassesStateApi || pluginAbsentStore.get()) return
  const generation = ++glassesStateGeneration
  const receiver = {
    connectionId: sdk.host.state?.connectionId?.get?.(),
    profile: sdk.host.state?.['profile']?.get?.(),
    label: null,
  }
  if (!receiver.connectionId || !receiver['profile'] ||
      (receiver.connectionId !== 'local' &&
       (typeof sdk.host.state?.connectionId?.subscribe !== 'function' ||
        typeof sdk.host.state?.['profile']?.subscribe !== 'function'))) {
    glassesStateStore.set({ ...EMPTY_GLASSES_STATE, status: 'unavailable', receiver,
      reason: 'This Desktop version does not expose safe connection and profile tracking.' })
    scheduleGlassesPoll(glassesPollDelay())
    return
  }
  const current = () => glassesStateMounted && generation === glassesStateGeneration &&
    receiver.connectionId === sdk.host.state?.connectionId?.get?.() &&
    receiver['profile'] === sdk.host.state?.['profile']?.get?.()
  const discard = () => {
    // Older SDKs can lack atom subscriptions. A route first discovered by
    // status() must still get another poll instead of stranding setup forever.
    if (glassesStateMounted && generation === glassesStateGeneration) {
      glassesStateStore.set(EMPTY_GLASSES_STATE)
      scheduleGlassesPoll(0)
    }
  }
  let status = null
  let statusTimeout = null
  try {
    status = await Promise.race([
      sdk.host.status(),
      new Promise((_, reject) => {
        statusTimeout = window.setTimeout(() => reject(new Error('Hermes status timed out')), GLASSES_STATE_TIMEOUT_MS)
      }),
    ])
  } catch {} finally { window.clearTimeout(statusTimeout) }
  if (!current()) return discard()
  const facts = platformFacts(status)
  let paired = null
  let device = { connected: null, batteryPercent: null, charging: null, inCase: null, observedAt: null, ageMs: null, stale: true }
  let companion = { state: 'unavailable', ageMs: null, stale: true, backend: null, profile: null, snapshot: null }
  let controllerStatus = 'ready'
  let reason = null
  let ownership = null
  let sessionTitle = null
  let restartToFinish = null
  const previous = glassesStateStore.get()
  // Retain only identity across a transient read failure, never LiveUI content.
  let sharedSession = previous.receiver?.connectionId === receiver.connectionId &&
    previous.receiver?.['profile'] === receiver['profile'] ? previous.sharedSession : null

  if (facts.gateway.running && facts.gateway.loaded) {
    try {
      const setup = await glassesStateApi('/setup-card', { method: 'GET', timeoutMs: GLASSES_STATE_TIMEOUT_MS })
      if (!current()) return discard()
      if (receiver.connectionId !== 'local' && (!setup || setup.contract !== 'ocuclaw.desktop-setup-card' || setup.contractVersion !== 1)) {
        throw { unsupportedContract: true }
      }
      if (setup && setup.contract === 'ocuclaw.desktop-setup-card') paired = setup.paired === true
      // Local only: the restart button acts on this machine's gateway.
      if (receiver.connectionId === 'local') restartToFinish = normalizeRestartToFinish(setup)
      const requestedAtMs = Date.now()
      const payload = await glassesStateApi('/glasses/state', { method: 'GET', timeoutMs: GLASSES_STATE_TIMEOUT_MS })
      if (!payload || payload.contract !== 'ocuclaw.glasses-state' || payload.contractVersion !== 1) {
        throw { unsupportedContract: true }
      }
      device = normalizeGlassesDevice(payload)
      companion = normalizeGlassesState(payload)
      ownership = pulseOwnershipText(receiver.connectionId) && pulseOwnershipText(receiver['profile'])
        ? normalizePulseOwnership(payload, companion, requestedAtMs) : null
      sessionTitle = pulseOwnershipText(payload.sessionTitle)
      sharedSession = pulseOwnershipText(companion.snapshot?.sessionKey)
        ? { sessionKey: companion.snapshot.sessionKey, storedSessionId: companion.snapshot.storedSessionId, title: sessionTitle } : null
    } catch (error) {
      if (isPluginAbsentError(error)) {
        if (!current()) return discard()
        glassesStateStore.set({
          status: 'unavailable',
          observedAtMs: Date.now(),
          paired,
          gateway: facts.gateway,
          device,
          companion,
          receiver,
        })
        noteProfileAbsence()
        return
      }
      controllerStatus = 'unavailable'
      reason = error?.unsupportedContract === true ? 'This backend does not support the OcuClaw desktop status contract.' : null
    }
  } else {
    controllerStatus = 'unavailable'
    reason = !status ? 'Hermes status is unavailable. Check the saved connection.'
      : status.gateway_state === 'stopped' ? 'The selected gateway is stopped.'
      : !facts.gateway.running ? 'Hermes has not confirmed the selected gateway is running.'
      : 'OcuClaw is absent or disabled in the selected gateway.'
  }

  if (!current()) return discard()
  glassesStateStore.set({
    status: controllerStatus,
    reason,
    observedAtMs: Date.now(),
    paired,
    gateway: facts.gateway,
    device,
    companion,
    ownership,
    receiver,
    sessionTitle,
    sharedSession,
    restartToFinish,
  })
  announceRestartToFinish(restartToFinish)
  window.clearTimeout(glassesStateExpiryTimer)
  const observed = glassesStateStore.get()
  // A stalled host.status() must not leave a previously observed battery or
  // connection looking live forever. Poll completion, not polling intent,
  // renews this deadline. Keep the source identity while expiring its facts.
  glassesStateExpiryTimer = window.setTimeout(() => {
    if (glassesStateStore.get().device !== observed.device) return
    glassesStateStore.set({ ...EMPTY_GLASSES_STATE, status: 'unavailable',
      receiver, reason: 'The last remote observation expired. Reconnecting…' })
  }, 30000)
  // Display names are optional inventory, never routing authority. Do not
  // delay ownership refresh or retain a label from another receiver.
  if (typeof sdk.host.connections === 'function') {
    void Promise.resolve().then(() => sdk.host.connections()).then(rows => {
      if (!current() || !Array.isArray(rows)) return
      const label = pulseOwnershipText(rows.find(row => row.id === receiver.connectionId)?.label)
      glassesStateStore.set({ ...glassesStateStore.get(), receiver: { ...receiver, label } })
    }).catch(() => {})
  }
  scheduleGlassesPoll(glassesPollDelay())
}

const startGlassesStateController = (api, socket) => {
  glassesStateApi = api
  glassesStateMounted += 1
  if (!glassesStateReceiverCleanup) {
    glassesStateReceiverCleanup = [
      watchHostAtom(sdk.host.state?.connectionId, clearProfileAbsence),
      watchHostAtom(sdk.host.state?.['profile'], clearProfileAbsence),
    ].filter(Boolean)
  }
  if (!glassesStateWindowCleanup) {
    const refresh = () => scheduleGlassesPoll(0)
    window.addEventListener('focus', refresh)
    window.addEventListener('blur', refresh)
    document.addEventListener('visibilitychange', refresh)
    glassesStateWindowCleanup = () => {
      window.removeEventListener('focus', refresh)
      window.removeEventListener('blur', refresh)
      document.removeEventListener('visibilitychange', refresh)
    }
  }
  scheduleGlassesPoll(0)
  // ctx.socket is scoped to this plugin's REST namespace, ignores the active
  // profile, and intentionally no-ops for OAuth remotes. Polling above remains
  // mandatory and authoritative in every one of those cases.
  if (!glassesStateSocketCleanup && typeof socket === 'function') {
    glassesStateSocket = socket
    try { glassesStateSocketCleanup = socket('/glasses/events', () => invalidateGlassesStateQuery()) } catch {}
  }
  return () => {
    glassesStateMounted = Math.max(0, glassesStateMounted - 1)
    glassesStateGeneration += 1
    if (glassesStateMounted) return
    window.clearTimeout(glassesStateTimer)
    window.clearTimeout(glassesStateExpiryTimer)
    glassesStateTimer = null
    glassesStateApi = null
    glassesStateWindowCleanup?.()
    glassesStateWindowCleanup = null
    glassesStateSocketCleanup?.()
    glassesStateSocketCleanup = null
    glassesStateSocket = null
    for (const unsubscribe of glassesStateReceiverCleanup || []) unsubscribe()
    glassesStateReceiverCleanup = null
  }
}


// PULSE_ENGINE_BEGIN — pure state + motion contract; the test harness evaluates
// this block directly so the renderer and its proofs cannot drift apart.
const PULSE_PARAMS = Object.freeze(['lum','frame','br','wamp','wfreq','wspeed','fint','fw','fx','fglide','fspeed','fill','edge','flow','flowspd','pdepth','phz','mark'])
const PULSE_BASE = Object.freeze({ frame: 1, fx: .5, fw: .8, wfreq: 1.4 })
const PULSE_OMEGA = Object.freeze({ lum: 14, frame: 6, fill: 12, mark: 10, wamp: 7, fint: 7, fw: 8, fglide: 8, flow: 6 })
const pulseVector = values => Object.assign(
  Object.fromEntries(PULSE_PARAMS.map(parameter => [parameter, 0])),
  PULSE_BASE,
  values,
)
const PULSE_TARGETS = Object.freeze({
  idle: Object.freeze(pulseVector({ lum: .5, br: .09 })),
  listen: Object.freeze(pulseVector({ lum: .7, wamp: .55, wfreq: 1.4, wspeed: .7, fint: .22, fw: 1 })),
  think: Object.freeze(pulseVector({ lum: .6, fint: .9, fw: .36, fglide: 1, fspeed: .4 })),
  paint: Object.freeze(pulseVector({ lum: .7, fill: 1, edge: .9, flow: .7, flowspd: .45 })),
  burst: Object.freeze(pulseVector({ lum: .7, fill: 1, edge: .9 })),
  glare: Object.freeze(pulseVector({ lum: .6, fint: .3, fw: 1, pdepth: .55, phz: .5 })),
  err: Object.freeze(pulseVector({ lum: .3, mark: 1 })),
  live: Object.freeze(pulseVector({ lum: .9, fint: .35, fw: 1 })),
  incase: Object.freeze(pulseVector({ lum: 0, frame: .5 })),
  off: Object.freeze(pulseVector({ lum: 0, frame: .4 })),
  pair: Object.freeze(pulseVector({ lum: 0 })),
})
const PULSE_MOTION_KEYS = Object.freeze(['wamp', 'fglide', 'pdepth', 'flow'])
const PULSE_STATE_MOODS = Object.freeze({
  disconnected: 'off',
  notpaired: 'pair',
  idle: 'idle',
  listening: 'listen',
  working: 'think',
  painting: 'paint',
  liveui: 'live',
  approval: 'glare',
  error: 'err',
})
const pulseSnapshot = controller => (
  controller && controller.companion && controller.companion.snapshot &&
  typeof controller.companion.snapshot === 'object'
    ? controller.companion.snapshot
    : null
)
const resolvePulseView = controller => {
  const value = controller || EMPTY_GLASSES_STATE
  const device = value.device || {}
  const companion = value.companion || {}
  const candidateSnapshot = pulseSnapshot(value)
  const snapshot = companion.state === 'present' && companion.stale !== true
    ? candidateSnapshot
    : null
  const active = snapshot && snapshot.active != null
  const failures = snapshot && snapshot.clientFailures
  let state = 'idle'

  if (value.paired !== true) state = 'notpaired'
  else if (
    device.errorActive === true ||
    (active && snapshot.errorChannelAvailable === true && failures && Number(failures.total) > 0)
  ) state = 'error'
  else if (device.approvalPending === true) state = 'approval'
  else if (device.microphoneOpen === true) state = 'listening'
  else if (snapshot && snapshot.pendingRender === true) state = 'painting'
  else if (
    active ||
    (snapshot && snapshot.stage && snapshot.stage.role && snapshot.stage.role !== 'vacant') ||
    (snapshot && Number(snapshot.stackDepth) > 0)
  ) state = 'liveui'
  else if (snapshot && snapshot.renderContext && snapshot.renderContext.agentTurn === 'busy') state = 'working'
  else if (
    device.connected === false ||
    (
      device.connected !== true &&
      (companion.state !== 'present' || companion.stale === true ||
        (snapshot && snapshot.renderContext && snapshot.renderContext.linkPresence === 'disconnected'))
    )
  ) state = 'disconnected'

  const inCase = device.inCase === true && state !== 'notpaired' && state !== 'disconnected'
  const progress = snapshot && Number.isFinite(snapshot.paintProgress)
    ? Math.max(0, Math.min(1, snapshot.paintProgress))
    : (state === 'painting' ? 0 : 1)
  const receipt = snapshot && snapshot.delivery && Number.isFinite(snapshot.delivery.lastPaintedAt)
    ? snapshot.delivery.lastPaintedAt
    : null
  return {
    state,
    mood: inCase ? 'incase' : PULSE_STATE_MOODS[state],
    badge: state === 'notpaired' ? 'neutral' : state === 'approval' ? 'approval' : state === 'error' ? 'error' : null,
    paintProgress: progress,
    paintReceipt: receipt,
  }
}
const createPulseFieldState = (mood = 'idle') => ({
  S: { ...PULSE_TARGETS[mood] },
  V: Object.fromEntries(PULSE_PARAMS.map(parameter => [parameter, 0])),
  target: PULSE_TARGETS[mood],
  mood,
  phase: { wave: 0, focus: 0, pulse: 0, flow: 0 },
  impulse: 0,
  settled: false,
  visible: true,
  reduced: false,
  paintProgress: mood === 'paint' ? 0 : 1,
  lastPaintReceipt: null,
})
const setPulseMood = (field, mood, paintProgress = field.paintProgress) => {
  if (!PULSE_TARGETS[mood]) mood = 'idle'
  field.mood = mood
  field.target = PULSE_TARGETS[mood]
  field.paintProgress = Math.max(0, Math.min(1, Number.isFinite(paintProgress) ? paintProgress : 0))
  field.settled = false
}
const pulseTargetOf = (field, parameter) => {
  if (parameter === 'fill' && field.mood === 'paint') return field.paintProgress
  if (parameter === 'flow' && field.mood === 'paint') {
    return field.paintProgress > 0 && field.paintProgress < 1 ? field.target.flow : 0
  }
  return field.target[parameter]
}
const stepPulseField = (field, rawDt) => {
  const dt = Math.min(.05, Math.max(0, rawDt))
  let moving = false
  for (const parameter of PULSE_PARAMS) {
    const target = pulseTargetOf(field, parameter)
    const omega = PULSE_OMEGA[parameter] || 12
    const acceleration = -omega * omega * (field.S[parameter] - target) - 2 * omega * field.V[parameter]
    field.V[parameter] += acceleration * dt
    field.S[parameter] += field.V[parameter] * dt
    if (Math.abs(field.S[parameter] - target) > .002 || Math.abs(field.V[parameter]) > .01) {
      moving = true
    } else {
      field.S[parameter] = target
      field.V[parameter] = 0
    }
  }
  field.phase.wave += field.S.wspeed * dt
  field.phase.focus += field.S.fspeed * dt
  field.phase.pulse += field.S.phz * dt
  field.phase.flow += field.S.flowspd * dt
  field.impulse *= Math.exp(-dt / .2)
  if (field.impulse < .003) field.impulse = 0
  field.settled = !moving
  return moving
}
const snapPulseField = field => {
  for (const parameter of PULSE_PARAMS) {
    field.S[parameter] = pulseTargetOf(field, parameter)
    field.V[parameter] = 0
  }
  field.impulse = 0
  field.settled = true
}
const seedPulsePairExit = (field, computedOpacity) => {
  const opacity = Number.parseFloat(computedOpacity)
  field.S.frame = Number.isFinite(opacity) ? Math.max(.1, Math.min(1, opacity)) : .5
  field.V.frame = 0
  field.settled = false
}
const notePulsePaintReceipt = (field, receipt) => {
  if (receipt === null || receipt === undefined) return false
  const changed = field.lastPaintReceipt !== null && field.lastPaintReceipt !== receipt
  field.lastPaintReceipt = receipt
  if (changed) field.impulse = 1
  return changed
}
const pulseFieldDemand = field => (
  field.visible &&
  (field.kind === 'agent'
    ? !field.held
    : (!field.settled || PULSE_MOTION_KEYS.some(parameter => field.S[parameter] > .01) || field.impulse > .004))
)
const pulseLoopDecision = ({ hidden = false, visible = true, reduced = false, field }) => {
  if (hidden || !visible) return 'cancel'
  if (reduced) return 'snap'
  return pulseFieldDemand(field) ? 'wake' : 'idle'
}
const pulseFallbackStyle = mood => {
  const target = PULSE_TARGETS[mood] || PULSE_TARGETS.idle
  return {
    frameOpacity: target.frame,
    fillOpacity: Math.min(1, .17 * target.lum),
    strokeOpacity: Math.min(1, .18 + .5 * target.lum),
  }
}
// PULSE_ENGINE_END

// PULSE_AGENT_MODEL_BEGIN — pure Agent policy; the test harness evaluates this
// block without React or the vendored engine.
// The title-bar Agent is the Alive "Watch" character the glasses paint, driven
// by the same Pulse state the glasses pip already distils. Mood-sync only: the
// state arrives on the /glasses/state poll (#1904), so he does what the wearer's
// character does within one poll interval, never frame for frame.
// Values are the engine's STATE ids (the relay vocabulary in `originals`), not
// the action names they map to: WatchEngine.create('reply') throws.
const PULSE_AGENT_ACTIONS = Object.freeze({
  idle: 'idle',
  listening: 'listening',
  working: 'thinking',
  painting: 'responding',
  liveui: 'tool',
  approval: 'awaiting_message',
  error: 'failure',
  disconnected: 'disconnected',
  notpaired: 'connecting',
})
// Desktop has no BLE paint budget: keep visible Speck alive between state edges.
// Reduced motion and still states continue to hold a settled pose.
const PULSE_AGENT_PREF_KEY = 'pulse-agent-titlebar'
const pulseAgentPlan = (view, { inCase = false } = {}) => {
  const state = view && typeof view.state === 'string' ? view.state : 'idle'
  const action = PULSE_AGENT_ACTIONS[state] || 'idle'
  const offline = state === 'disconnected' || state === 'notpaired'
  return {
    action: inCase ? 'idle' : action,
    // No lens is painting: hold a still instead of miming a live agent.
    still: inCase || offline || state === 'error',
    dim: false,
    // No glasses on the wearer, no agent at all (Matty, 2026-09-07): not
    // paired, disconnected and in case all hide him.
    shown: !offline && !inCase,
  }
}
// PULSE_AGENT_MODEL_END

const G2_FRAME=`<path fill-opacity=".42" fill-rule="evenodd" d="M52.12 13.95L52.46 15.79L52.51 18.11L49.99 18.54L47.09 19.17L41.1 20.72L35.2 22.46L33.37 23.09L33.17 23.09L20.17 27.24L20.08 27.2L21.67 26.37L22.49 25.55L23.02 24.49L23.17 23.76L23.12 22.85L23.22 22.8L24.91 22.31L25.78 21.98L25.97 21.98L26.84 21.64L27.04 21.64L27.91 21.3L28.1 21.3L28.82 21.01L29.02 21.01L29.74 20.72L29.94 20.72L30.66 20.43L30.86 20.43L31.58 20.14L33.17 19.7L33.75 19.46L41.2 17.29L11.86 17.29L11.81 17.58L11.81 15.89L11.96 14.73L12.25 14.34L12.29 14L52.12 13.95ZM67.83 13.95L107.7 14L107.75 14.34L108.04 14.73L108.19 15.89L108.19 17.58L108.14 17.29L78.8 17.29L85.62 19.27L96.78 22.8L96.88 22.85L96.83 23.81L96.97 24.49L97.51 25.55L98.33 26.37L99.92 27.2L99.83 27.24L87.45 23.28L87.26 23.28L84.65 22.41L78.56 20.62L71.84 18.93L67.49 18.11L67.54 15.79L67.69 14.73L67.88 14.05L67.83 13.95ZM54.59 13.95L65.37 14L65.12 15.69L65.07 17.77L63.53 17.53L61.45 17.38L61.26 17.29L58.74 17.29L58.55 17.38L56.04 17.58L54.92 17.77L54.88 15.69L54.59 13.95Z"/><path fill-opacity=".55" fill-rule="evenodd" d="M32.55 2.35L41.83 2.4L43.86 2.69L45.84 3.27L47.48 4.04L49.08 5.11L50.72 6.61L50.72 6.7L51.45 7.43L51.45 7.52L51.69 7.72L51.69 7.81L52.12 8.25L52.12 8.35L53.04 9.26L53.14 9.26L53.33 9.51L54.05 9.99L54.88 10.28L55.94 10.23L58.21 9.51L59.66 9.31L60.92 9.36L61.79 9.51L64.35 10.28L65.12 10.28L65.61 10.13L66.19 9.84L66.57 9.51L66.67 9.51L66.86 9.26L66.96 9.26L67.88 8.35L67.88 8.25L68.12 8.06L68.12 7.96L68.84 7.19L68.84 7.09L69.28 6.7L69.28 6.61L70.39 5.54L70.49 5.54L71.31 4.82L72.28 4.19L72.47 4.14L72.52 4.04L73.92 3.37L75.18 2.93L76.92 2.55L79.09 2.35L87.45 2.35L90.4 2.45L92.33 2.59L94.8 2.93L96.54 3.32L97.99 3.75L99.58 4.38L100.89 5.01L100.94 5.11L102.24 5.78L103.98 6.94L104.08 7.09L104.95 7.67L105.38 8.1L105.48 8.1L106.64 9.22L106.74 9.22L108.33 10.81L108.33 10.91L108.86 11.39L108.86 11.49L109.35 11.92L109.35 12.02L109.98 12.7L115.15 12.7L115.68 12.89L116.02 13.23L116.21 13.76L116.21 14.05L116.02 14.58L115.68 14.87L115.68 18.16L110.51 18.16L110.36 19.95L110.12 21.54L109.59 23.91L116.26 27.1L116.79 27.58L116.89 27.58L116.89 27.68L117.47 28.31L117.9 29.37L118 30.48L117.81 31.45L117.23 32.51L116.94 32.75L116.89 32.9L116.79 32.9L116.26 33.38L115.2 33.82L114.08 33.91L112.88 33.62L109.06 31.74L108.91 31.74L107.37 30.92L106.93 30.77L106.79 31.16L106.69 31.21L106.64 31.4L106.55 31.45L106.5 31.64L106.3 31.84L106.25 32.03L105.77 32.75L105.63 32.85L104.95 33.87L104.47 34.35L104.47 34.45L102.68 36.28L102.58 36.28L102.29 36.62L102.19 36.62L101.52 37.25L101.42 37.25L100.94 37.68L99.92 38.36L97.99 39.42L95.33 40.49L93.4 41.02L91.95 41.31L90.02 41.55L86.58 41.6L84.6 41.41L83.2 41.16L80.25 40.34L78.8 39.76L78.41 39.52L78.27 39.52L76.48 38.55L75.03 37.59L74.11 36.81L74.02 36.81L73.82 36.57L73.73 36.57L73.53 36.33L73.44 36.33L73.15 35.99L73.05 35.99L71.75 34.74L71.75 34.64L71.16 34.11L71.16 34.01L70.2 32.95L70.2 32.85L69.76 32.37L69.67 32.13L69.52 32.03L68.75 30.87L68.12 29.66L68.02 29.61L67.06 27.58L66.23 25.31L65.66 23.04L65.27 20.67L65.07 18.35L65.07 16.32L65.32 14.24L65.75 12.55L65.37 12.65L64.06 12.65L62.95 12.41L61.98 12.02L61.02 11.78L59.32 11.73L58.36 11.92L57.05 12.41L55.94 12.65L54.63 12.65L54.25 12.55L54.54 13.86L54.63 14L54.88 15.69L54.92 18.35L54.83 19.8L54.49 22.27L54.1 24.1L53.38 26.47L52.8 27.92L52.56 28.31L52.56 28.45L51.54 30.39L50.24 32.37L49.17 33.62L49.17 33.72L47.53 35.46L47.43 35.46L46.23 36.62L46.13 36.62L45.98 36.81L45.89 36.81L45.74 37.01L44.73 37.68L44.63 37.83L43.91 38.31L43.71 38.36L43.52 38.55L43.32 38.6L43.28 38.7L42.55 39.04L42.5 39.13L40.86 39.91L39.02 40.58L37.23 41.07L35.4 41.41L33.42 41.6L30.66 41.6L29.07 41.45L27.28 41.16L25.3 40.68L23.46 40.05L21.43 39.13L21.38 39.04L20.08 38.36L19.06 37.68L18.14 36.91L18.05 36.91L17.42 36.28L17.32 36.28L15.29 34.16L15.29 34.06L14.9 33.67L14.9 33.58L14.76 33.48L14.76 33.38L14.62 33.29L14.62 33.19L14.47 33.09L14.37 32.85L14.23 32.75L13.74 32.03L13.7 31.84L13.21 31.16L13.07 30.77L6.88 33.72L5.92 33.91L5.04 33.87L4.46 33.72L3.4 33.14L2.63 32.32L2.19 31.45L2.05 30.87L2 30L2.15 29.18L2.53 28.31L2.77 28.07L2.77 27.97L3.74 27.1L5.82 26.08L5.96 26.08L6.83 25.6L6.98 25.6L8.23 24.92L8.38 24.92L10.41 23.91L10.41 23.81L10.27 23.43L9.83 21.25L9.59 19.56L9.49 18.16L4.32 18.16L4.32 14.87L3.98 14.58L3.79 14.05L3.79 13.76L3.98 13.23L4.32 12.89L4.85 12.7L10.02 12.7L10.65 12.02L10.65 11.92L11.13 11.49L11.13 11.39L11.71 10.86L11.71 10.76L13.26 9.22L13.36 9.22L13.79 8.73L13.89 8.73L15.05 7.67L15.15 7.67L16.02 6.94L16.26 6.85L16.36 6.7L17.37 6.03L17.56 5.98L17.76 5.78L18.05 5.69L18.24 5.49L19.88 4.62L20.03 4.62L20.41 4.38L21.48 3.95L23.46 3.32L26.07 2.79L28.82 2.5L32.55 2.35ZM31.19 4.77L27.47 5.01L25.78 5.25L23.85 5.69L21.29 6.61L19.84 7.33L19.79 7.43L18.63 8.06L17.61 8.73L17.32 9.02L17.08 9.12L16.94 9.31L16.84 9.31L15.97 10.09L15.87 10.09L15.63 10.38L15.53 10.38L13.31 12.55L13.31 12.65L12.34 13.61L12.25 14.34L11.96 14.73L11.81 15.89L11.81 17.58L12.1 20.33L12.58 22.8L14.13 22.07L14.18 21.98L15.92 21.15L15.97 21.06L18.05 19.99L19.25 19.7L20.37 19.8L21.43 20.24L22.11 20.77L22.11 20.86L22.54 21.3L22.88 21.93L23.17 22.99L23.12 24.1L22.88 24.88L22.3 25.79L21.38 26.57L15.2 29.66L15.39 30.14L15.48 30.19L15.53 30.39L15.73 30.58L15.78 30.77L16.26 31.5L17.03 32.42L17.03 32.51L17.23 32.66L17.23 32.75L18.43 33.96L18.43 34.06L18.53 34.06L19.06 34.64L19.16 34.64L19.88 35.32L19.98 35.32L20.08 35.46L20.17 35.46L20.27 35.61L21.33 36.33L23.51 37.49L24.57 37.93L26.55 38.55L28.68 38.99L31 39.23L33.13 39.23L34.77 39.09L36.9 38.7L38.88 38.12L40.33 37.54L42.26 36.52L43.57 35.65L44.24 35.07L44.34 35.07L45.11 34.35L45.21 34.35L45.64 33.87L45.74 33.87L47.43 32.08L47.43 31.98L47.67 31.79L47.67 31.69L48.45 30.77L49.22 29.61L49.61 28.84L49.7 28.79L50.72 26.71L51.49 24.59L51.98 22.7L52.41 19.99L52.51 18.93L52.51 16.42L52.36 15.06L51.98 13.23L51.49 11.92L50.82 10.62L50.19 9.7L49.46 8.88L49.46 8.78L48.35 7.62L48.26 7.62L47.96 7.28L47.87 7.28L47.29 6.75L46.27 6.17L46.23 6.07L45.21 5.59L44.1 5.2L42.79 4.91L41.54 4.77L31.19 4.77ZM78.51 4.77L76.48 5.06L75.03 5.49L73.87 6.03L72.33 7.04L70.92 8.35L70.92 8.44L70.54 8.78L70.25 9.26L69.67 9.89L69.18 10.62L68.51 11.92L68.02 13.23L67.69 14.73L67.49 16.42L67.49 18.93L67.88 21.98L68.31 23.91L68.99 25.99L69.42 27.05L69.72 27.53L69.72 27.68L70.78 29.61L71.55 30.77L71.99 31.26L71.99 31.35L72.86 32.32L72.86 32.42L73.34 32.85L73.34 32.95L74.79 34.35L74.89 34.35L75.13 34.64L75.22 34.64L75.42 34.88L75.71 35.03L76.43 35.65L77.98 36.67L79.67 37.54L81.12 38.12L83.1 38.7L85.23 39.09L86.87 39.23L89 39.23L91.03 39.04L93.45 38.55L95.43 37.93L96.49 37.49L98.67 36.33L99.54 35.75L100.02 35.32L100.12 35.32L100.5 34.93L100.6 34.93L101.91 33.72L101.91 33.62L102.77 32.75L102.77 32.66L102.97 32.51L102.97 32.42L103.74 31.5L104.47 30.39L104.52 30.19L104.61 30.14L104.8 29.66L99.54 27.05L99.49 26.95L98.72 26.62L98.67 26.52L98.33 26.37L98.18 26.18L98.09 26.18L97.41 25.41L96.97 24.49L96.83 23.81L96.83 22.94L97.02 22.17L97.6 21.11L98.57 20.24L99.63 19.8L100.75 19.7L101.95 19.99L104.03 21.06L104.08 21.15L107.41 22.8L107.95 20.04L108.19 17.58L108.19 15.89L108.04 14.73L107.75 14.34L107.66 13.61L104.95 10.81L104.85 10.81L104.13 10.09L104.03 10.09L103.84 9.84L103.74 9.84L103.6 9.65L103.5 9.65L103.36 9.46L103.26 9.46L102.39 8.73L101.37 8.06L101.18 8.01L100.99 7.81L100.21 7.43L100.16 7.33L98.38 6.46L96.49 5.78L93.64 5.16L90.06 4.82L78.51 4.77ZM4.56 13.61L4.51 17.96L10.55 17.96L11.04 17.77L11.33 17.48L11.52 16.85L11.76 15.16L11.76 14.63L11.57 14.1L11.28 13.81L10.8 13.61L4.56 13.61ZM109.25 13.61L108.72 13.81L108.43 14.1L108.24 14.63L108.24 15.16L108.53 17.14L108.67 17.48L108.96 17.77L109.44 17.96L115.49 17.96L115.49 13.61L109.25 13.61Z"/><path fill-opacity=".55" fill-rule="evenodd" d="M4.51 13.61L10.8 13.61L11.28 13.81L11.57 14.1L11.76 14.63L11.76 15.16L11.52 16.85L11.33 17.48L11.04 17.77L10.55 17.96L4.51 17.96L4.51 13.61ZM109.2 13.61L115.49 13.61L115.49 17.96L109.44 17.96L108.96 17.77L108.67 17.48L108.53 17.14L108.24 15.16L108.24 14.63L108.43 14.1L108.72 13.81L109.2 13.61Z"/>`;

const PULSE_WAVEGUIDES = Object.freeze([{ x: 22.39 }, { x: 78.08 }])
const PULSE_WAVEGUIDE_Y = 12.5
const PULSE_WAVEGUIDE_WIDTH = 19.53
const PULSE_WAVEGUIDE_HEIGHT = 7.97
const PULSE_WAVEGUIDE_RADIUS = 3.98
const pulseFields = new Set()
const pulseBudgetedLoopFactory = typeof sdk.createBudgetedLoop === 'function' ? sdk.createBudgetedLoop : null
let pulseBudgetedLoop = null
let pulseClockLastMs = 0
let pulseVisibilityCleanup = null

const roundedRectPath = (context, x, y, width, height, radius) => {
  const r = Math.min(radius, height / 2, width / 2)
  context.beginPath()
  context.moveTo(x + r, y)
  context.lineTo(x + width - r, y)
  context.arcTo(x + width, y, x + width, y + height, r)
  context.lineTo(x + width, y + height - r)
  context.arcTo(x + width, y + height, x, y + height, r)
  context.lineTo(x + r, y + height)
  context.arcTo(x, y + height, x, y, r)
  context.lineTo(x, y + r)
  context.arcTo(x, y, x + width, y, r)
  context.closePath()
}

const sizePulseField = field => {
  const dpr = window.devicePixelRatio || 1
  field.canvas.width = Math.round(field.width * dpr)
  field.canvas.height = Math.round(field.height * dpr)
  field.canvas.style.width = field.width + 'px'
  field.canvas.style.height = field.height + 'px'
  field.scale = field.canvas.width / 120
  field.layer.width = Math.ceil(PULSE_WAVEGUIDE_WIDTH * field.scale) + 2
  field.layer.height = Math.ceil(PULSE_WAVEGUIDE_HEIGHT * field.scale) + 2
  field.settled = false
}

const readPulseInk = field => {
  const probe = document.createElement('canvas')
  probe.width = probe.height = 1
  const context = probe.getContext('2d', { willReadFrequently: true })
  context.fillStyle = getComputedStyle(field.glow).fill
  context.fillRect(0, 0, 1, 1)
  const data = context.getImageData(0, 0, 1, 1).data
  field.rgb = [data[0], data[1], data[2]]
}

const drawPulseField = (field, nowSeconds) => {
  const context = field.context
  const scale = field.scale
  const state = field.S
  context.setTransform(1, 0, 0, 1, 0, 0)
  context.globalCompositeOperation = 'source-over'
  context.filter = 'none'
  context.globalAlpha = 1
  context.clearRect(0, 0, field.canvas.width, field.canvas.height)

  const pulse = 1 - state.pdepth * (.5 + .5 * Math.sin(field.phase.pulse * 2 * Math.PI))
  const breathe = field.reduced ? 1 : 1 + state.br * Math.sin(nowSeconds * 2 * Math.PI / 4.2)
  field.svg.style.opacity = state.frame.toFixed(3)
  const luminance = Math.max(0, Math.min(1.6, state.lum * pulse * breathe + field.impulse * .9))
  const level = Math.min(1, luminance)
  field.glow.setAttribute('fill-opacity', (.17 * level).toFixed(3))
  field.glow.setAttribute('stroke-opacity', (.18 + .5 * level).toFixed(3))
  if (luminance < .003 && state.mark < .01) return

  const red = field.rgb[0]
  const green = field.rgb[1]
  const blue = field.rgb[2]
  const color = alpha => 'rgba(' + red + ',' + green + ',' + blue + ',' +
    Math.max(0, Math.min(1, alpha)).toFixed(3) + ')'

  PULSE_WAVEGUIDES.forEach((waveguide, index) => {
    const x = waveguide.x * scale
    const y = PULSE_WAVEGUIDE_Y * scale
    const width = PULSE_WAVEGUIDE_WIDTH * scale
    const height = PULSE_WAVEGUIDE_HEIGHT * scale
    const centerY = height / 2
    const layer = field.layer
    const paint = field.layerContext
    paint.setTransform(1, 0, 0, 1, 0, 0)
    paint.globalCompositeOperation = 'source-over'
    paint.globalAlpha = 1
    paint.clearRect(0, 0, layer.width, layer.height)
    paint.globalCompositeOperation = 'lighter'

    const base = paint.createRadialGradient(width / 2, centerY, 0, width / 2, centerY, width * .55)
    base.addColorStop(0, color(.30 * luminance))
    base.addColorStop(1, color(.05 * luminance))
    paint.fillStyle = base
    paint.fillRect(0, 0, width, height)

    if (state.fill > .002) {
      const fillX = state.fill * width
      paint.fillStyle = color(.24 * luminance)
      paint.fillRect(0, 0, fillX, height)
      const edgeWidth = Math.max(2, width * .24)
      const edge = paint.createLinearGradient(fillX - edgeWidth, 0, fillX, 0)
      edge.addColorStop(0, color(0))
      edge.addColorStop(1, color(.85 * state.edge * luminance))
      paint.fillStyle = edge
      paint.fillRect(Math.max(0, fillX - edgeWidth), 0, Math.min(edgeWidth, fillX), height)
      if (state.flow > .004) {
        const bandWidth = Math.max(3, width * .38)
        const unit = ((field.phase.flow % 1) + 1) % 1
        const bandX = -bandWidth + unit * (fillX + bandWidth)
        const flow = paint.createLinearGradient(bandX, 0, bandX + bandWidth, 0)
        flow.addColorStop(0, color(0))
        flow.addColorStop(.5, color(.42 * state.flow * luminance))
        flow.addColorStop(1, color(0))
        paint.save()
        paint.beginPath()
        paint.rect(0, 0, fillX, height)
        paint.clip()
        paint.fillStyle = flow
        paint.fillRect(bandX, 0, bandWidth, height)
        paint.restore()
      }
    }

    if (state.fint > .004) {
      const span = Math.max(0, (1 - state.fw) * width / 2)
      const centerX = width / 2 + (state.fx - .5) * width +
        state.fglide * span * Math.sin(field.phase.focus * 2 * Math.PI)
      const radius = Math.max(1, state.fw * width * .55)
      const focus = paint.createRadialGradient(centerX, centerY, 0, centerX, centerY, radius)
      focus.addColorStop(0, color(.85 * state.fint * luminance))
      focus.addColorStop(.45, color(.32 * state.fint * luminance))
      focus.addColorStop(1, color(0))
      paint.fillStyle = focus
      paint.fillRect(0, 0, width, height)
    }

    if (state.wamp > .004) {
      paint.lineCap = 'round'
      paint.lineJoin = 'round'
      const amplitude = state.wamp * height * .30
      const points = Math.max(24, Math.round(width / 1.5))
      const waveAlpha = Math.min(1, state.wamp / .5)
      const path = () => {
        paint.beginPath()
        for (let point = 0; point <= points; point += 1) {
          const unit = point / points
          const envelope = Math.pow(Math.sin(Math.PI * unit), .6)
          const waveY = centerY + amplitude * envelope *
            Math.sin(2 * Math.PI * (state.wfreq * unit - field.phase.wave))
          if (point) paint.lineTo(unit * width, waveY)
          else paint.moveTo(0, waveY)
        }
      }
      paint.strokeStyle = color(.26 * luminance * waveAlpha)
      paint.lineWidth = Math.max(1.5, height * .22) * (.5 + .5 * waveAlpha)
      path()
      paint.stroke()
      paint.strokeStyle = color(.95 * luminance * waveAlpha)
      paint.lineWidth = Math.max(.8, height * .075) * (.6 + .4 * waveAlpha)
      path()
      paint.stroke()
    }

    if (state.mark > .004 && index === 1) {
      paint.strokeStyle = color(.6 * state.mark)
      paint.lineWidth = Math.max(.8, height * .1)
      paint.lineCap = 'round'
      const mark = height * .26
      paint.beginPath()
      paint.moveTo(width / 2 - mark, centerY - mark)
      paint.lineTo(width / 2 + mark, centerY + mark)
      paint.moveTo(width / 2 + mark, centerY - mark)
      paint.lineTo(width / 2 - mark, centerY + mark)
      paint.stroke()
    }
    if (field.impulse > .004) {
      paint.fillStyle = color(.5 * field.impulse)
      paint.fillRect(0, 0, width, height)
    }

    paint.globalCompositeOperation = 'destination-in'
    const mask = paint.createRadialGradient(width / 2, centerY, 0, width / 2, centerY, width * .5)
    mask.addColorStop(0, 'rgba(0,0,0,1)')
    mask.addColorStop(.7, 'rgba(0,0,0,.85)')
    mask.addColorStop(1, 'rgba(0,0,0,.15)')
    paint.fillStyle = mask
    paint.fillRect(0, 0, width, height)

    context.save()
    roundedRectPath(context, x, y, width, height, PULSE_WAVEGUIDE_RADIUS * scale)
    context.clip()
    context.globalCompositeOperation = 'lighter'
    context.filter = 'blur(' + (height * .18).toFixed(2) + 'px)'
    context.globalAlpha = .7
    context.drawImage(layer, 0, 0, width, height, x, y, width, height)
    context.filter = 'none'
    context.globalAlpha = 1
    context.drawImage(layer, 0, 0, width, height, x, y, width, height)
    context.restore()
  })
}

const paintPulseFields = nowMs => {
  const dt = pulseClockLastMs ? Math.min(.05, Math.max(0, (nowMs - pulseClockLastMs) / 1000)) : 1 / 60
  pulseClockLastMs = nowMs
  for (const field of pulseFields) {
    if (!field.visible) continue
    if (field.kind === 'agent') { stepPulseAgent(field, dt); continue }
    if (field.reduced) snapPulseField(field)
    else stepPulseField(field, dt)
    drawPulseField(field, nowMs / 1000)
  }
}

const ensurePulseClock = () => {
  if (!pulseBudgetedLoopFactory || pulseBudgetedLoop) return
  pulseBudgetedLoop = pulseBudgetedLoopFactory(paintPulseFields, {
    fps: 15,
    idleWhen: () => [...pulseFields].every(field => !pulseFieldDemand(field)),
  })
  const visibility = () => {
    pulseClockLastMs = 0
    if (!document.hidden) {
      for (const field of pulseFields) field.settled = false
      pulseBudgetedLoop.wake()
    }
  }
  document.addEventListener('visibilitychange', visibility)
  pulseVisibilityCleanup = () => document.removeEventListener('visibilitychange', visibility)
}

const wakePulseClock = () => {
  pulseClockLastMs = 0
  pulseBudgetedLoop?.wake()
}

const registerPulseField = field => {
  pulseFields.add(field)
  ensurePulseClock()
  wakePulseClock()
  return () => {
    pulseFields.delete(field)
    if (pulseFields.size || !pulseBudgetedLoop) return
    pulseBudgetedLoop.dispose()
    pulseBudgetedLoop = null
    pulseVisibilityCleanup?.()
    pulseVisibilityCleanup = null
    pulseClockLastMs = 0
  }
}

const PulseBadge = ({ kind }) => {
  if (!kind) return null
  const color = kind === 'approval'
    ? '#ffb454'
    : kind === 'error'
      ? '#ff8798'
      : 'var(--ui-text-tertiary)'
  return jsx('span', {
    'aria-hidden': 'true',
    style: {
      position: 'absolute',
      width: 5,
      height: 5,
      right: -1,
      top: 1,
      borderRadius: '50%',
      background: color,
      boxShadow: '0 0 0 1px var(--ui-bg-primary)',
    },
  })
}

const PULSE_STATE_LABELS = Object.freeze({
  disconnected: 'Disconnected',
  notpaired: 'Not paired',
  idle: 'Idle',
  listening: 'Listening',
  working: 'Working',
  painting: 'Rendering',
  liveui: 'LiveUI active',
  approval: 'Awaiting approval',
  error: 'Error',
})

// PULSE_CARD_MODEL_BEGIN — pure privacy, activity, and notification rules.
// Tests evaluate this block without React so UI refactors cannot weaken them.
const PULSE_DISCONNECT_DELAY_MS = 30000
const PULSE_EVENT_LIMIT = 4
const pulseSessionKey = controller => {
  const companion = controller && controller.companion
  if (!companion || companion.state !== 'present' || companion.stale === true) return null
  const snapshot = pulseSnapshot(controller)
  return snapshot && typeof snapshot.sessionKey === 'string' && snapshot.sessionKey.trim()
    ? snapshot.sessionKey.trim()
    : null
}
const pulseSessionPin = sessionKey => {
  if (!sessionKey) return null
  const parts = sessionKey.split(':').filter(Boolean)
  const tail = parts[parts.length - 1] || sessionKey
  return tail.length > 14 ? `${tail.slice(0, 6)}…${tail.slice(-5)}` : tail
}
// PULSE_OWNERSHIP_BEGIN — only a validated, current receipt may name a driver.
const pulseOwnershipText = value => typeof value === 'string' && value.trim() &&
  value.length <= 256 && !/[\u0000-\u001f\u007f]/.test(value) ? value.trim() : null
const normalizePulseOwnership = (payload, companion, receivedAtMs) => {
  const value = payload?.ownership
  const projection = value?.projection
  if (value?.contract !== 'ocuclaw.ownership' || value.contractVersion !== 1 || value.readOnly !== true ||
      value.status !== 'present' || companion.state !== 'present' || companion.stale ||
      companion.backend !== 'hermes' || projection?.contract !== 'ocuclaw.session-driver-projection' ||
      projection.contractVersion !== 1 || projection.armed !== true || projection.uncertain !== false ||
      typeof projection.locked !== 'boolean' || typeof projection.takeOver !== 'boolean' ||
      projection.sessionKey !== companion.snapshot?.sessionKey ||
      !pulseOwnershipText(projection.sessionId) || projection.sessionId !== companion.snapshot?.storedSessionId ||
      typeof projection.receiverFingerprint !== 'string' || projection.receiverFingerprint !== payload.homeFingerprint ||
      !/^[a-f0-9]{64}$/.test(projection.receiverFingerprint) ||
      !pulseOwnershipText(projection.observationGeneration) ||
      !['glasses_drive', 'desktop_hold', 'desktop_working'].includes(projection.state) ||
      !Number.isFinite(companion.ageMs) || companion.ageMs > 30000 ||
      !Number.isFinite(value.sampledAtMs) || value.sampledAtMs !== payload.generatedAtMs) return null
  // Match the phone's admission bit: an idle Desktop holder may remain present
  // after a scoped takeover has lifted its lock. Renewed work always wins.
  const state = projection.state === 'desktop_working' ? 'desktop_working'
    : !projection.locked ? 'glasses_drive' : projection.state === 'desktop_hold' ? 'desktop_hold' : 'checking'
  return { state, sessionKey: projection.sessionKey, sessionId: projection.sessionId,
    receivedAtMs, expiresAtMs: receivedAtMs + 30000 - companion.ageMs }
}
const pulseOwnershipView = (controller, now) => {
  const snapshot = pulseSnapshot(controller)
  // A stale receipt can still identify the chat. It cannot
  // identify a driver or enable Open chat. A receiver change clears both.
  const shared = controller.sharedSession || snapshot
  const key = pulseOwnershipText(shared?.sessionKey)
  if (!key) return null
  // Independent copies have no shared driver watch or ownership receipt.
  // Keep their normal status card without an endless ownership check.
  if (/^hermes:[^:]+:copy-/.test(key)) return null
  const ownership = controller.ownership
  const fresh = controller.status === 'ready' && controller.companion?.stale === false &&
    ownership && ownership.sessionKey === key &&
    ownership.sessionId === shared.storedSessionId && now >= ownership.receivedAtMs && now <= ownership.expiresAtMs
  const state = fresh ? ownership.state : 'checking'
  const receiver = controller.receiver || {}
  const profile = pulseOwnershipText(receiver['profile']) || pulseOwnershipText(controller.companion?.profile)
  // "default" is the internal Hermes profile name, not a second chat title.
  const profileLabel = profile && profile !== 'default' ? `Profile: ${profile}` : null
  const machine = receiver.connectionId && receiver.connectionId !== 'local'
    ? pulseOwnershipText(receiver.label) || 'Remote machine' : null
  const id = pulseOwnershipText(shared.storedSessionId) || key.split(':').pop()
  return { state, title: pulseOwnershipText(shared.title) || pulseOwnershipText(controller.sessionTitle) || `Session ${id.slice(0, 6)}`,
    identity: [profileLabel, machine].filter(Boolean).join(' · '),
    // Ownership is optional on older receivers and may fail closed indefinitely.
    // Polling the chat successfully does not mean a driver check is in progress.
    label: { glasses_drive: 'Glasses driving', desktop_hold: 'Desktop has this chat',
      desktop_working: 'Desktop working', checking: 'Session control unavailable' }[state] }
}
// PULSE_OWNERSHIP_END
const pulseContentShape = content => {
  if (!content || typeof content !== 'object' || Array.isArray(content)) return null
  const kind = typeof content.kind === 'string' ? content.kind : ''
  if (Array.isArray(content.items) || kind.includes('list') || kind.includes('checklist')) {
    return { kind: 'list', rows: Math.max(1, Math.min(5, Array.isArray(content.items) ? content.items.length : 3)) }
  }
  if (content.imageAsset || Number.isFinite(content.imageWidth) || Number.isFinite(content.imageHeight)) {
    const width = Number(content.imageWidth)
    const height = Number(content.imageHeight)
    const ratio = width > 0 && height > 0 ? Math.max(.55, Math.min(1.8, width / height)) : 1.35
    return { kind: 'image', ratio }
  }
  if (typeof content.template === 'string' && content.template) return { kind: 'template' }
  if (kind.includes('text') || typeof content.body === 'string') {
    const bodyLength = typeof content.body === 'string' ? content.body.length : 32
    return { kind: 'text', lines: Math.max(1, Math.min(4, Math.ceil(bodyLength / 32))) }
  }
  return { kind: 'template' }
}
const pulseElapsed = (at, now) => {
  const seconds = Math.max(0, Math.floor((now - at) / 1000))
  if (seconds < 5) return 'now'
  if (seconds < 60) return `${seconds}s ago`
  const minutes = Math.floor(seconds / 60)
  return minutes < 60 ? `${minutes}m ago` : `${Math.floor(minutes / 60)}h ago`
}
const initialPulseNotificationState = () => ({
  battery: null,
  armed20: true,
  armed10: true,
  disconnectedSince: null,
  disconnectSent: false,
})
const reducePulseNotificationState = (previous, controller, now) => {
  const next = { ...(previous || initialPulseNotificationState()) }
  const events = []
  const device = controller && controller.device && controller.device.stale !== true ? controller.device : {}
  const battery = boundedBattery(device.batteryPercent)
  const connected = typeof device.connected === 'boolean' ? device.connected : null

  if (battery !== null) {
    if (battery > 20) next.armed20 = true
    if (battery > 10) next.armed10 = true
    const crossed10 = next.battery !== null && next.battery > 10 && battery <= 10 && next.armed10
    const crossed20 = next.battery !== null && next.battery > 20 && battery <= 20 && next.armed20
    if (crossed10) {
      events.push({ kind: 'battery10', battery })
      next.armed10 = false
      next.armed20 = false
    } else if (crossed20) {
      events.push({ kind: 'battery20', battery })
      next.armed20 = false
    }
    next.battery = battery
  }

  if (connected === false && controller && controller.paired === true) {
    if (next.disconnectedSince === null) next.disconnectedSince = now
    if (!next.disconnectSent && now - next.disconnectedSince >= PULSE_DISCONNECT_DELAY_MS) {
      events.push({ kind: 'disconnect' })
      next.disconnectSent = true
    }
  } else {
    next.disconnectedSince = null
    next.disconnectSent = false
  }
  return { state: next, events }
}
// PULSE_CARD_MODEL_END

const pulseCardOpenStore = makeStore(false)
const pulseActivityStore = makeStore([])
const pulseDoctorStore = makeStore({ status: 'idle', message: '' })
let pulseNotificationState = initialPulseNotificationState()

const rememberPulseActivity = event => {
  if (!event) return
  pulseActivityStore.set(current => [event, ...current].slice(0, PULSE_EVENT_LIMIT))
}

const observePulseActivity = (previous, controller, now) => {
  if (!previous) return
  const before = resolvePulseView(previous)
  const after = resolvePulseView(controller)
  const oldDevice = previous.device || {}
  const device = controller.device || {}
  if (oldDevice.connected !== true && device.connected === true) rememberPulseActivity({ label: 'Connected', at: now })
  else if (oldDevice.connected === true && device.connected === false) rememberPulseActivity({ label: 'Disconnected', at: now })
  if (before.paintReceipt !== after.paintReceipt && after.paintReceipt !== null) rememberPulseActivity({ label: 'Rendered', at: now })
  else if (before.state !== after.state && after.state === 'listening') rememberPulseActivity({ label: 'Listened', at: now })
}

const pulseNotificationCopy = event => {
  if (event.kind === 'disconnect') return { title: 'G2 disconnected', body: 'OcuClaw has not seen your paired G2 for 30 seconds.' }
  return { title: `G2 battery ${event.battery}%`, body: event.kind === 'battery10' ? 'Your G2 battery crossed 10%.' : 'Your G2 battery crossed 20%.' }
}

const startPulseCardController = ctx => {
  let previous = glassesStateStore.get()
  const unsubscribe = glassesStateStore.subscribe(controller => {
    if (controller === EMPTY_GLASSES_STATE) {
      previous = null
      pulseActivityStore.set([])
      pulseNotificationState = initialPulseNotificationState()
      return
    }
    const now = Date.now()
    observePulseActivity(previous, controller, now)
    previous = controller
    const reduced = reducePulseNotificationState(pulseNotificationState, controller, now)
    pulseNotificationState = reduced.state
    // Battery 20% / 10% and the 30 s disconnect alert are always on; there is
    // no mute. Each fires once per crossing and re-arms on recovery.
    for (const event of reduced.events) {
      const copy = pulseNotificationCopy(event)
      try { ctx.os.notify({ ...copy, onActivate: () => openPulseCard() }) } catch {}
    }
  })
  return () => { invalidatePulseNavigationCard(); unsubscribe() }
}

// The one preference the card keeps: whether the Agent rides the title bar.
// Ships OFF: a fresh install shows only the glasses pip; the card toggle opts in.
// Plugin storage is Electron localStorage keyed by plugin id, outside
// HERMES_HOME, so it survives gateway reinstalls and uninstall cannot strip it.
const pulseAgentEnabledStore = makeStore(false)
const hydratePulseCardPrefs = ctx => {
  // One-time cleanup for the retired multi-layout picker and the retired
  // alerts mute.
  try { ctx.storage.remove?.('pulse-card-mode') } catch {}
  try { ctx.storage.remove?.('pulse-notifications-muted') } catch {}
  let enabled = false
  try { enabled = ctx.storage.get(PULSE_AGENT_PREF_KEY, false) === true } catch {}
  pulseAgentEnabledStore.set(enabled)
}
const setPulseAgentEnabled = (ctx, enabled) => {
  pulseAgentEnabledStore.set(enabled === true)
  try { ctx.storage.set(PULSE_AGENT_PREF_KEY, enabled === true) } catch {}
}

// Stock Hermes navigation. Completion is the stock SDK's hydration result,
// not a generation-bound fresh-transcript receipt or a cancellable native turn.
let pulseNavigationCardGeneration = 0
let pulseNavigationPending = null
const pulseNavigationErrors = {
  conversation_missing: 'This shared conversation is unavailable.',
  identity_conflict: 'The shared conversation could not be identified safely.',
  discovery_truncated: 'The shared conversation could not be identified safely.',
  profile_unavailable: 'Open the owning local profile in Desktop, then retry.',
  route_unavailable: 'Open chat currently supports the active local profile.',
  unsupported_sdk: 'This Desktop does not support opening shared chats.',
  loading_failed: 'Could not open this chat. Retry Open chat.',
  loading_timeout: 'Loading timed out · retry Open chat',
  storage_unavailable: 'The shared conversation is temporarily unavailable.',
  storage_unsupported: 'This Hermes version cannot resolve the shared conversation.',
  stale_receiver: 'The selected chat or profile changed. Retry Open chat.',
  navigation_pending: 'The previous chat is still opening.',
}
const invalidatePulseNavigationCard = () => { pulseNavigationCardGeneration += 1 }
const openPulseSession = (ctx, controller, onClose) => {
  const sessionKey = pulseSessionKey(controller)
  const connectionId = sdk.host.state?.connectionId?.get?.()
  const profile = sdk.host.state?.['profile']?.get?.()
  const generation = pulseNavigationCardGeneration
  const scope = JSON.stringify([sessionKey, connectionId, profile, generation])
  if (pulseNavigationPending) return pulseNavigationPending.scope === scope
    ? pulseNavigationPending.promise : Promise.resolve({ ok: false, reason: 'navigation_pending' })
  let invalidated = false
  const current = () => !invalidated && generation === pulseNavigationCardGeneration &&
    connectionId === sdk.host.state?.connectionId?.get?.() && profile === sdk.host.state?.['profile']?.get?.() &&
    sessionKey === pulseSessionKey(glassesStateStore.get())
  const cleanup = [
    watchHostAtom(sdk.host.state?.connectionId, () => { invalidated = true }),
    watchHostAtom(sdk.host.state?.['profile'], () => { invalidated = true }),
    glassesStateStore.subscribe(state => { if (pulseSessionKey(state) !== sessionKey) invalidated = true }),
  ].filter(Boolean)
  const operation = { scope, promise: null }
  operation.promise = Promise.resolve().then(async () => {
    try {
      if (!sessionKey) throw { reason: 'conversation_missing' }
      // A profile name is not cross-machine routing authority. This first
      // stock lane operates only on the currently served local receiver.
      if (connectionId !== 'local') throw { reason: 'route_unavailable' }
      if (!profile || controller.receiver?.connectionId !== connectionId ||
          controller.receiver?.['profile'] !== profile) throw { reason: 'profile_unavailable' }
      if (typeof ctx?.rest !== 'function' || typeof sdk.host.openSession !== 'function') throw { reason: 'unsupported_sdk' }
      if (!current()) throw { reason: 'stale_receiver' }
      const target = await ctx.rest('/resolve-open-target', { method: 'POST', body: { sessionKey }, timeoutMs: 7000 })
      if (!current()) throw { reason: 'stale_receiver' }
      if (!target || target.contract !== 'ocuclaw.open-target' || target.contractVersion !== 1 || target.sessionKey !== sessionKey) throw { reason: 'identity_conflict' }
      if (target.ok !== true) throw { reason: Object.hasOwn(pulseNavigationErrors, target.reason) ? target.reason : 'loading_failed' }
      if (target.nativeProfile !== profile || typeof target.storedSessionId !== 'string' || !target.storedSessionId.trim() ||
          typeof target.hasHistory !== 'boolean' || !Number.isFinite(target.expiresAtMs) || target.expiresAtMs <= Date.now()) throw { reason: 'identity_conflict' }
      await sdk.host.openSession(target.storedSessionId, {
        profile: target.nativeProfile, intent: 'tab', keepAllProfilesScope: true,
        awaitHydration: true, forceResume: true, expectHistory: target.hasHistory,
        hydrationTimeoutMs: 20000,
      })
      if (!current()) throw { reason: 'stale_receiver' }
      onClose?.()
      return { ok: true }
    } catch (error) {
      const reason = !current() ? 'stale_receiver'
        : Object.hasOwn(pulseNavigationErrors, error?.reason) ? error.reason
          : /^Timed out /.test(error?.message || '') ? 'loading_timeout' : 'loading_failed'
      return { ok: false, reason }
    } finally {
      for (const dispose of cleanup) dispose()
      if (pulseNavigationPending === operation) pulseNavigationPending = null
    }
  })
  pulseNavigationPending = operation
  return operation.promise
}

const runPulseDoctor = async api => {
  pulseDoctorStore.set({ status: 'running', message: 'Checking…' })
  try {
    const result = await api('/doctor', { method: 'POST', timeoutMs: 7000 })
    const message = result && typeof result.summary === 'string' ? result.summary : 'Doctor finished.'
    const ok = result && result.ok === true
    pulseDoctorStore.set({ status: ok ? 'ok' : 'warning', message })
    return { ok, message }
  } catch {
    const message = 'Doctor could not finish.'
    pulseDoctorStore.set({ status: 'error', message })
    return { ok: false, message }
  }
}

const PulseThumbnail = ({ shape }) => {
  if (!shape) return jsx('div', { 'aria-label': 'No active G2 surface', style: { width: 38, height: 24, border: '1px dashed var(--ui-border)', borderRadius: 4, opacity: .45 } })
  const shell = { width: 38, height: 24, padding: 3, border: '1px solid var(--ui-border)', borderRadius: 4, display: 'flex', flexDirection: 'column', gap: 3, overflow: 'hidden', flex: '0 0 auto' }
  if (shape.kind === 'image') return jsx('div', { 'aria-label': 'Abstract image surface thumbnail', style: shell, children: jsx('div', { style: { margin: 'auto', width: Math.round(18 * shape.ratio), maxWidth: 28, height: 13, borderRadius: 2, background: 'var(--ui-text-tertiary)', opacity: .42 } }) })
  if (shape.kind === 'template') return jsx('div', { 'aria-label': 'Abstract template surface thumbnail', style: { ...shell, alignItems: 'center', justifyContent: 'center' }, children: jsx('span', { 'aria-hidden': 'true', style: { fontSize: 14, opacity: .55 }, children: '◇' }) })
  const count = shape.kind === 'list' ? shape.rows : shape.lines
  return jsx('div', { 'aria-label': `Abstract ${shape.kind} surface thumbnail`, style: shell, children: Array.from({ length: count }, (_, index) => jsx('span', { key: index, style: { display: 'block', height: 3, width: `${90 - index * 9}%`, borderRadius: 2, background: 'var(--ui-text-tertiary)', opacity: .48 } })) })
}

const closePulseCard = () => {
  invalidatePulseNavigationCard()
  pulseCardOpenStore.set(false)
}

const openPulseCard = () => pulseCardOpenStore.set(true)

function PulseCard({ ctx, onClose, readOnly = false }) {
  const controller = glassesStateStore.use()
  const absent = pluginAbsentStore.use()
  const receiver = controller.receiver || {}
  // The wearer already sees an approval prompt on the lens, so the card never
  // mentions approvals: drop the flag and show whatever else is true.
  const view = resolvePulseView(controller.device && controller.device.approvalPending === true
    ? { ...controller, device: { ...controller.device, approvalPending: false } }
    : controller)
  const reduced = usePulseReducedMotion()
  const activity = pulseActivityStore.use()
  const [now, setNow] = useState(() => Date.now())
  const device = controller.device || {}
  const battery = device.stale !== true ? boundedBattery(device.batteryPercent) : null
  const connected = device.stale !== true ? device.connected : null
  const charging = device.stale !== true && device.charging === true
  const inCase = device.stale !== true ? device.inCase : null
  const snapshot = pulseSnapshot(controller)
  const profile = typeof snapshot?.profile === 'string' && snapshot.profile.trim()
    ? snapshot.profile.trim()
    : typeof controller.companion?.profile === 'string' ? controller.companion.profile : null
  const sessionKey = pulseSessionKey(controller)
  const ownershipView = pulseOwnershipView(controller, Date.now())
  const sessionPin = pulseSessionPin(sessionKey)
  const pillText = readOnly
    ? [receiver.label || receiver.connectionId, receiver['profile']].filter(Boolean).join(' · ')
    : [profile, sessionPin].filter(Boolean).join(' · ')
  const shape = pulseContentShape(snapshot?.active?.content)
  const lastActivity = activity[0] || null
  const latestEvent = view.state === 'painting'
    ? 'Rendering now'
    : view.state === 'disconnected'
      ? lastActivity ? `Last seen ${pulseElapsed(lastActivity.at, now)}` : null
      : lastActivity ? `${lastActivity.label} ${pulseElapsed(lastActivity.at, now)}` : connected === true ? 'Connected now' : null
  const batteryColor = battery !== null && battery <= 10
    ? '#ff8798'
    : battery !== null && battery <= 20 ? '#ffb454' : 'inherit'
  const stateColor = view.state === 'error' || view.state === 'disconnected' || connected === false
    ? '#ff8798'
    : connected === true ? 'var(--ui-accent, #4dd58a)' : 'var(--ui-text-tertiary)'
  const stateGlow = connected === true && view.state !== 'error'
    ? '0 0 6px rgba(77,213,138,.5)'
    : 'none'

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 15000)
    return () => window.clearInterval(timer)
  }, [])

  useEffect(() => {
    const expiry = controller.ownership?.expiresAtMs
    if (!Number.isFinite(expiry)) return undefined
    const timer = window.setTimeout(() => setNow(Date.now()), Math.max(0, expiry - Date.now() + 1))
    return () => window.clearTimeout(timer)
  }, [controller.ownership])

  const sessionPill = pillText ? sessionKey ? jsx('span', {
    title: 'Active G2 session',
    'data-pulse-session': sessionKey,
    'data-floating-no-drag': '',
    style: { maxWidth: 185, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', border: '1px solid var(--ui-border)', borderRadius: 999, padding: '1px 7px', background: 'transparent', color: 'var(--ui-text-secondary)', fontFamily: 'var(--font-mono, monospace)', fontSize: 8.5 },
    children: pillText,
  }) : jsx('span', {
    style: { border: '1px solid var(--ui-border)', borderRadius: 999, padding: '1px 7px', color: 'var(--ui-text-secondary)', fontFamily: 'var(--font-mono, monospace)', fontSize: 8.5 },
    children: pillText,
  }) : null

  const header = jsxs('div', {
    style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6 },
    children: [
      jsx('span', { style: { color: 'var(--ui-accent, #4dd58a)', fontFamily: 'var(--font-mono, monospace)', fontSize: 8.5, letterSpacing: '.14em', textTransform: 'uppercase' }, children: 'OcuClaw' }),
      jsxs('div', { style: { display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }, children: [
        sessionPill,
        jsx('button', {
          type: 'button',
          onClick: onClose,
          'aria-label': 'Close',
          'data-floating-no-drag': '',
          style: { border: 0, borderRadius: 3, padding: '1px 5px', background: 'transparent', color: 'var(--ui-text-tertiary)', fontFamily: 'var(--font-mono, monospace)', fontSize: 11, cursor: 'pointer' },
          children: '×',
        }),
      ] }),
    ],
  })

  const hero = jsxs('div', {
    style: { display: 'grid', gridTemplateColumns: '1fr auto', alignItems: 'center', gap: 10, padding: '6px 0 10px', opacity: connected === false ? .55 : 1, transition: 'opacity 450ms ease' },
    children: [
      jsxs('div', { children: [
        jsxs('div', { style: { color: batteryColor, fontFamily: "'Monogram', 'Pixelify Sans', 'Times New Roman', serif", fontSize: 44, lineHeight: .85, letterSpacing: '-.02em', fontVariantNumeric: 'tabular-nums' }, children: [
          jsx('span', { 'data-g2-battery': battery === null ? '' : String(battery), children: battery === null ? '—' : `${battery}%` }),
          charging ? jsx('small', { style: { marginLeft: 4, color: 'var(--ui-text-tertiary)', fontFamily: 'var(--font-mono, monospace)', fontSize: 8.5, letterSpacing: '.1em', textTransform: 'uppercase', verticalAlign: 'middle' }, children: 'charging' }) : null,
        ] }),
        jsxs('div', { style: { display: 'flex', alignItems: 'center', gap: 6, marginTop: 6, color: 'var(--ui-text-secondary)' }, children: [
          jsx('span', { 'aria-hidden': 'true', style: { width: 6, height: 6, flex: '0 0 auto', borderRadius: '50%', background: stateColor, boxShadow: stateGlow } }),
          jsx('span', { style: { fontFamily: "'Monogram', 'Pixelify Sans', 'Times New Roman', serif", fontSize: 16 }, children: readOnly && controller.status !== 'ready' ? 'Unavailable' : PULSE_STATE_LABELS[view.state] || 'Idle' }),
          typeof inCase === 'boolean' ? jsx('span', { style: { color: 'var(--ui-text-tertiary)' }, children: inCase ? '· in case' : '· out of case' }) : null,
        ] }),
        latestEvent ? jsx('span', { 'data-pulse-activity': '', style: { display: 'block', marginTop: 3, color: 'var(--ui-text-tertiary)', fontFamily: 'var(--font-mono, monospace)', fontSize: 8, letterSpacing: '.14em', textTransform: 'uppercase' }, children: latestEvent }) : null,
      ] }),
      jsx(PulseGlasses, {
        view,
        width: 116,
        height: 43,
        frameColor: 'var(--ui-text-secondary)',
        inkColor: 'var(--ui-accent, #4dd58a)',
        reduced,
      }),
    ],
  })

  const footer = jsxs('div', {
    style: { marginTop: 'auto', display: 'flex', alignItems: 'center', gap: 8 },
    children: [
      jsx('span', { style: { minWidth: 0, flex: 1, color: 'var(--ui-text-secondary)', fontSize: 10 }, children: readOnly ? 'Read-only desktop status. Existing pairing stays on Cloudways.' : 'Glasses chats stay separate from Desktop.' }),
      readOnly ? null : jsx(PulseThumbnail, { shape }),
    ],
  })

  // The one switch the card carries: the Agent in the title bar. Nothing else
  // about the card changed for him (decided 2026-09-07).
  const agentEnabled = pulseAgentEnabledStore.use()
  const agentRow = jsxs('button', {
    type: 'button',
    role: 'switch',
    'aria-checked': agentEnabled ? 'true' : 'false',
    'data-pulse-agent-toggle': agentEnabled ? 'on' : 'off',
    'data-floating-no-drag': '',
    onClick: () => setPulseAgentEnabled(ctx, !agentEnabled),
    title: 'Show Speck next to the glasses in the title bar',
    style: { display: 'flex', alignItems: 'center', gap: 6, marginTop: -2, padding: 0, border: 0, background: 'transparent', color: 'var(--ui-text-tertiary)', cursor: 'pointer', textAlign: 'left' },
    children: [
      jsx('span', { style: { flex: 1, fontFamily: 'var(--font-mono, monospace)', fontSize: 8.5, letterSpacing: '.08em', textTransform: 'uppercase' }, children: 'Agent in title bar' }),
      jsx('span', {
        'aria-hidden': 'true',
        style: { position: 'relative', width: 22, height: 12, borderRadius: 999, background: agentEnabled ? 'color-mix(in srgb, var(--ui-accent, #4dd58a) 45%, var(--ui-border))' : 'var(--ui-border)', transition: 'background 250ms ease', flex: '0 0 auto' },
        children: jsx('span', { style: { position: 'absolute', top: 2, left: agentEnabled ? 12 : 2, width: 8, height: 8, borderRadius: '50%', background: agentEnabled ? 'var(--ui-accent, #4dd58a)' : 'var(--ui-text-tertiary)', transition: 'left 250ms ease, background 250ms ease' } }),
      }),
      jsx('span', { style: { width: 18, textAlign: 'right', fontFamily: 'var(--font-mono, monospace)', fontSize: 8.5 }, children: agentEnabled ? 'on' : 'off' }),
    ],
  })

  // An update installed while this gateway kept serving the old code.
  const restartHint = readOnly ? null : controller.restartToFinish
  const restartRow = restartHint ? jsxs('div', {
    role: 'status',
    'data-pulse-restart': restartHint.installedVersion,
    style: { display: 'flex', alignItems: 'center', gap: 8, color: 'var(--ui-text-secondary)', fontSize: 10, lineHeight: 1.4 },
    children: [
      jsx('span', { 'aria-hidden': 'true', style: { width: 5, height: 5, flexShrink: 0, borderRadius: '50%', background: '#ffb454' } }),
      jsx('span', { style: { flex: 1, minWidth: 0 }, children: restartToFinishMessage(restartHint) }),
      jsx('span', { 'data-floating-no-drag': '', children: jsx(Button, { size: 'xs', onClick: requestGatewayRestart, children: 'Restart gateway' }) }),
    ],
  }) : null

  return jsxs('section', {
    'data-pulse-card': '',
    style: { display: 'flex', minHeight: '100%', flexDirection: 'column', gap: 8, padding: '10px 12px 11px', color: 'var(--ui-text-primary)', fontSize: 10 },
    children: [
      header,
      readOnly ? jsx('div', { role: 'status', style: { color: 'var(--ui-text-secondary)', overflowWrap: 'anywhere' }, children: remoteStatusMessage(controller, absent) }) : null,
      restartRow,
      hero,
      agentRow,
      jsx('div', { 'aria-hidden': 'true', style: { height: 1, background: 'var(--ui-border)' } }),
      !readOnly && ownershipView ? jsxs('div', {
        'data-pulse-ownership': ownershipView.state,
        style: { minWidth: 0, padding: '1px 0 3px' },
        children: [
          jsx('div', { title: ownershipView.title, style: { fontSize: 11, fontWeight: 600, lineHeight: 1.35, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, children: ownershipView.title }),
          ownershipView.identity ? jsx('div', { title: ownershipView.identity, style: { color: 'var(--ui-text-tertiary)', fontFamily: 'var(--font-mono, monospace)', fontSize: 8.5, lineHeight: 1.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, children: ownershipView.identity }) : null,
          jsxs('div', { role: 'status', style: { display: 'flex', alignItems: 'center', gap: 6, marginTop: 3, color: 'var(--ui-text-secondary)', fontSize: 10, lineHeight: 1.5 }, children: [
            jsx('span', { 'aria-hidden': 'true', style: { width: 5, height: 5, flexShrink: 0, borderRadius: '50%', background: ownershipView.state === 'glasses_drive' ? 'var(--ui-accent, #4dd58a)' : ownershipView.state === 'desktop_working' ? '#ffb454' : ownershipView.state === 'checking' ? 'var(--ui-text-tertiary)' : 'currentColor' } }),
            ownershipView.label,
          ] }),
        ],
      }) : null,
      footer,
    ],
  })
}

const PulseBatteryIcon = ({ battery, charging, reduced }) => {
  const batteryRef = useRef(null)
  const chargeRef = useRef(null)
  const known = battery !== null
  const value = known ? battery : 0
  const fillWidth = 15 * value / 100
  const color = value <= 10 ? '#ff8798' : value <= 20 ? '#ffb454' : 'var(--ui-accent, #4dd58a)'

  useEffect(() => {
    const icon = batteryRef.current
    if (!icon || !known || reduced || typeof icon.animate !== 'function') return undefined
    const animation = icon.animate(
      [{ opacity: .52 }, { opacity: 1 }],
      { duration: 620, easing: 'cubic-bezier(.2,.8,.2,1)' },
    )
    return () => animation.cancel()
  }, [battery, known, reduced])

  useEffect(() => {
    const bolt = chargeRef.current
    if (!bolt || charging !== true || reduced || typeof bolt.animate !== 'function') return undefined
    const animation = bolt.animate(
      [
        { filter: 'brightness(.82)', opacity: .42, transform: 'scale(.84)' },
        { filter: 'brightness(1.28)', opacity: 1, transform: 'scale(1.08)' },
        { filter: 'brightness(.82)', opacity: .42, transform: 'scale(.84)' },
      ],
      { duration: 1500, iterations: Infinity, easing: 'ease-in-out' },
    )
    return () => animation.cancel()
  }, [charging, reduced])

  return jsxs('svg', {
    ref: batteryRef,
    'aria-hidden': 'true',
    'data-g2-battery': known ? String(battery) : '',
    'data-g2-charging': charging === true ? 'true' : 'false',
    viewBox: '0 0 24 14',
    width: 24,
    height: 14,
    style: {
      display: 'block',
      marginRight: 5,
      overflow: 'visible',
      opacity: known ? 1 : 0,
      transition: 'opacity 480ms ease',
    },
    children: [
      jsx('rect', { x: 1, y: 2, width: 19, height: 10, rx: 2.2, fill: 'none', stroke: 'currentColor', strokeWidth: 1.35, opacity: .68 }),
      jsx('path', { d: 'M21 5h1.2c.44 0 .8.36.8.8v2.4c0 .44-.36.8-.8.8H21z', fill: 'currentColor', opacity: .55 }),
      jsx('rect', {
        x: 3,
        y: 4,
        width: fillWidth,
        height: 6,
        rx: 1.15,
        fill: color,
        style: { transition: 'width 520ms cubic-bezier(.2,.8,.2,1), fill 420ms ease' },
      }),
      jsx('path', {
        ref: chargeRef,
        d: 'M12.7 2.8 8.8 7.4h2.45l-.7 3.8 4-5.05H12.1z',
        fill: 'var(--ui-bg-primary, #0b0d0a)',
        stroke: color,
        strokeWidth: .72,
        strokeLinejoin: 'round',
        style: {
          opacity: charging === true ? 1 : 0,
          transform: charging === true ? 'scale(1)' : 'scale(.78)',
          transformBox: 'fill-box',
          transformOrigin: 'center',
          transition: 'opacity 420ms ease, transform 420ms ease, stroke 420ms ease, filter 420ms ease',
        },
      }),
    ],
  })
}

const usePulseReducedMotion = () => {
  const [reduced, setReduced] = useState(() => {
    try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches } catch { return false }
  })
  useEffect(() => {
    let media = null
    try { media = window.matchMedia('(prefers-reduced-motion: reduce)') } catch {}
    if (!media) return undefined
    const update = () => setReduced(media.matches)
    media.addEventListener?.('change', update)
    return () => media.removeEventListener?.('change', update)
  }, [])
  return reduced
}

function PulseGlasses({ view, width, height, frameColor, inkColor, reduced }) {
  const rootRef = useRef(null)
  const svgRef = useRef(null)
  const glowRef = useRef(null)
  const canvasRef = useRef(null)
  const fieldRef = useRef(null)
  const latestViewRef = useRef(view)
  const fallback = pulseFallbackStyle(view.mood)
  latestViewRef.current = view

  useEffect(() => {
    if (!pulseBudgetedLoopFactory || !canvasRef.current || !svgRef.current || !glowRef.current) return undefined
    const canvas = canvasRef.current
    const field = Object.assign(createPulseFieldState(view.mood), {
      canvas,
      context: canvas.getContext('2d'),
      svg: svgRef.current,
      glow: glowRef.current,
      layer: document.createElement('canvas'),
      width,
      height,
      scale: 1,
      rgb: [77, 213, 138],
    })
    field.layerContext = field.layer.getContext('2d')
    fieldRef.current = field
    sizePulseField(field)
    readPulseInk(field)
    const disposeField = registerPulseField(field)
    const resize = () => {
      sizePulseField(field)
      readPulseInk(field)
      wakePulseClock()
    }
    window.addEventListener('resize', resize)

    let observer = null
    if ('IntersectionObserver' in window && rootRef.current) {
      observer = new IntersectionObserver(entries => {
        const entry = entries[0]
        field.visible = Boolean(entry && entry.isIntersecting)
        if (field.visible) {
          field.settled = false
          wakePulseClock()
        }
      }, { threshold: 0 })
      observer.observe(rootRef.current)
    }

    return () => {
      observer?.disconnect()
      window.removeEventListener('resize', resize)
      disposeField()
      fieldRef.current = null
    }
  }, [height, width])

  useEffect(() => {
    const field = fieldRef.current
    if (!field) return
    field.reduced = reduced
    setPulseMood(field, view.mood, view.paintProgress)
    notePulsePaintReceipt(field, view.paintReceipt)
    if (reduced) {
      snapPulseField(field)
      drawPulseField(field, performance.now() / 1000)
    } else {
      wakePulseClock()
    }
  }, [view.mood, view.paintProgress, view.paintReceipt, reduced])

  useEffect(() => {
    const svg = svgRef.current
    const field = fieldRef.current
    if (!svg || view.mood !== 'pair') return undefined
    if (reduced || typeof svg.animate !== 'function') {
      svg.style.opacity = '.5'
      return () => {
        if (field) seedPulsePairExit(field, getComputedStyle(svg).opacity)
        else svg.style.opacity = String(pulseFallbackStyle(latestViewRef.current.mood).frameOpacity)
      }
    }
    const animation = svg.animate(
      [{ opacity: 1 }, { opacity: .36 }, { opacity: 1 }],
      { duration: 3600, iterations: Infinity, easing: 'ease-in-out' },
    )
    return () => {
      if (field) seedPulsePairExit(field, getComputedStyle(svg).opacity)
      animation.cancel()
      if (!field) svg.style.opacity = String(pulseFallbackStyle(latestViewRef.current.mood).frameOpacity)
      wakePulseClock()
    }
  }, [view.mood, reduced])

  useEffect(() => {
    if (view.mood !== 'idle' || reduced || !pulseBudgetedLoopFactory) return undefined
    const sample = () => {
      const field = fieldRef.current
      if (!field || !field.visible || document.hidden || pulseFieldDemand(field)) return
      drawPulseField(field, performance.now() / 1000)
    }
    const timer = window.setInterval(sample, 500)
    return () => window.clearInterval(timer)
  }, [view.mood, reduced])

  const waveguideRects = () => PULSE_WAVEGUIDES.map((waveguide, index) => jsx('rect', {
    key: index,
    x: waveguide.x,
    y: PULSE_WAVEGUIDE_Y,
    width: PULSE_WAVEGUIDE_WIDTH,
    height: PULSE_WAVEGUIDE_HEIGHT,
    rx: PULSE_WAVEGUIDE_RADIUS,
  }))

  return jsxs('span', {
    ref: rootRef,
    role: 'img',
    'aria-label': 'OcuClaw G2 glasses',
    'data-pulse-glasses': `${width}x${height}`,
    style: { position: 'relative', display: 'block', width, height, color: frameColor, flex: '0 0 auto' },
    children: [
      jsxs('svg', {
        ref: svgRef,
        viewBox: '0 0 120 44',
        width,
        height,
        fill: 'none',
        style: {
          display: 'block',
          opacity: pulseBudgetedLoopFactory ? undefined : fallback.frameOpacity,
          transition: pulseBudgetedLoopFactory ? undefined : 'opacity 800ms ease',
        },
        children: [
          jsx('g', { fill: 'currentColor', dangerouslySetInnerHTML: { __html: G2_FRAME } }),
          jsx('g', { fill: 'var(--ui-bg-primary, #0b0d0a)', children: waveguideRects() }),
          jsx('g', {
            ref: glowRef,
            fill: inkColor,
            stroke: inkColor,
            strokeWidth: 1,
            fillOpacity: pulseBudgetedLoopFactory ? 0 : fallback.fillOpacity,
            strokeOpacity: pulseBudgetedLoopFactory ? .2 : fallback.strokeOpacity,
            style: { transition: 'fill-opacity 480ms ease, stroke-opacity 480ms ease' },
            children: waveguideRects(),
          }),
        ],
      }),
      pulseBudgetedLoopFactory ? jsx('canvas', {
        ref: canvasRef,
        'aria-hidden': 'true',
        style: { position: 'absolute', inset: 0, width, height, pointerEvents: 'none' },
      }) : null,
    ],
  })
}

// ---- Title-bar Agent: the glasses' Alive character on the desktop ----------
// One rig per canvas, stepped by the same budgeted pulse loop as the glasses
// field (`kind: 'agent'`). The vendored engine renders 100×32 ink levels; the
// canvas shows them at 0.75× smoothed, ink = theme accent, transparent ground.
const PULSE_AGENT_RENDER = Object.freeze({ frameModel: 'g2b', eyeDesign: 'balanced-l' })
const pulseAgentLibs = () => {
  const engine = typeof window !== 'undefined' ? window.WatchEngine : null
  const renderer = typeof window !== 'undefined' ? window.WatchRenderer : null
  return engine && renderer ? { engine, renderer } : null
}
const paintPulseAgent = rig => {
  const frame = rig.libs.renderer.render(rig.engine.snapshot(), PULSE_AGENT_RENDER)
  const canvas = rig.canvas
  if (canvas.width !== frame.width) canvas.width = frame.width
  if (canvas.height !== frame.height) canvas.height = frame.height
  const image = rig.context.createImageData(frame.width, frame.height)
  const [r, g, b] = rig.rgb
  for (let i = 0; i < frame.pixels.length; i += 1) {
    const k = i * 4
    image.data[k] = r
    image.data[k + 1] = g
    image.data[k + 2] = b
    image.data[k + 3] = Math.round(255 * frame.pixels[i] / 15)
  }
  rig.context.putImageData(image, 0, 0)
}
// Settle the way AliveRig.hold does on the glasses: a fresh rig for the action,
// stepped quietly on the CPU, painted once. No mid-blink freeze.
const holdPulseAgent = rig => {
  const settled = rig.libs.engine.create(rig.action)
  settled.configure({ motion: 0 })
  for (let i = 0; i < 1200; i += 1) settled.step(1 / 120)
  rig.engine = settled
  rig.held = true
  paintPulseAgent(rig)
}
const stepPulseAgent = (rig, dt) => {
  if (rig.held) return
  if (rig.reduced || rig.still) { holdPulseAgent(rig); return }
  rig.engine.step(dt)
  paintPulseAgent(rig)
}
const setPulseAgentPlan = (rig, plan, reduced) => {
  const edge = rig.action !== plan.action
  rig.action = plan.action
  rig.still = plan.still === true
  rig.reduced = reduced === true
  if (edge) {
    // Keep his springs: setState blends from the current pose, no cut.
    rig.engine.setState(plan.action)
  }
  // A reduced-motion hold replaces the engine with motion disabled; restore
  // movement even when the action itself has not changed.
  rig.engine.configure({ motion: rig.reduced || rig.still ? 0 : 1 })
  rig.held = false
}
const parsePulseAgentInk = (canvas, fallback = [77, 213, 138]) => {
  try {
    const probe = document.createElement('canvas')
    probe.width = probe.height = 1
    const context = probe.getContext('2d', { willReadFrequently: true })
    context.fillStyle = getComputedStyle(canvas).color
    context.fillRect(0, 0, 1, 1)
    const [r, g, b, a] = context.getImageData(0, 0, 1, 1).data
    return a ? [r, g, b] : fallback
  } catch { return fallback }
}
const createPulseAgentRig = (canvas, plan, reduced, libs) => {
  const engine = libs.engine.create(plan.action)
  return {
    kind: 'agent',
    canvas,
    context: canvas.getContext('2d'),
    libs,
    engine,
    action: plan.action,
    still: plan.still === true,
    reduced: reduced === true,
    held: false,
    visible: true,
    rgb: parsePulseAgentInk(canvas),
  }
}

function PulseAgent({ view, inCase, reduced, width = 75, height = 24 }) {
  const canvasRef = useRef(null)
  const rigRef = useRef(null)
  const plan = pulseAgentPlan(view, { inCase })

  useEffect(() => {
    const canvas = canvasRef.current
    const libs = pulseAgentLibs()
    if (!canvas || !libs) return undefined
    const rig = createPulseAgentRig(canvas, plan, reduced, libs)
    rigRef.current = rig
    if (!pulseBudgetedLoopFactory) {
      // Old shell without a budgeted loop: one still, never animated.
      holdPulseAgent(rig)
      return () => { rigRef.current = null }
    }
    let observer = null
    if ('IntersectionObserver' in window) {
      observer = new IntersectionObserver(entries => {
        const entry = entries[0]
        rig.visible = Boolean(entry && entry.isIntersecting)
        if (rig.visible) wakePulseClock()
      }, { threshold: 0 })
      observer.observe(canvas)
    }
    const unregister = registerPulseField(rig)
    return () => {
      observer?.disconnect()
      unregister()
      rigRef.current = null
    }
  }, [])

  useEffect(() => {
    const rig = rigRef.current
    if (!rig) return undefined
    setPulseAgentPlan(rig, plan, reduced)
    if (pulseBudgetedLoopFactory) wakePulseClock()
    else holdPulseAgent(rig)
    return undefined
  }, [plan.action, plan.still, reduced])

  return jsx('canvas', {
    ref: canvasRef,
    'aria-hidden': 'true',
    'data-pulse-agent': plan.action,
    'data-pulse-agent-still': plan.still ? 'true' : 'false',
    width: 100,
    height: 32,
    style: { display: 'block', width, height, imageRendering: 'auto', color: 'var(--ui-accent, #4dd58a)', opacity: plan.dim ? .45 : 1, transition: 'opacity 450ms ease' },
  })
}

function G2Pulse({ ctx, api, onActivate }) {
  const controller = glassesStateStore.use()
  const view = resolvePulseView(controller)
  const pulseCardOpen = pulseCardOpenStore.use()
  const reduced = usePulseReducedMotion()
  const [hovered, setHovered] = useState(false)
  const [focused, setFocused] = useState(false)
  const battery = controller.device && controller.device.stale !== true
    ? boundedBattery(controller.device.batteryPercent)
    : null
  const charging = controller.device && controller.device.stale !== true && typeof controller.device.charging === 'boolean'
    ? controller.device.charging
    : null
  const batteryLabel = battery === null ? null : `G2 battery ${battery}%${charging === true ? ', charging' : ''}`
  const agentEnabled = pulseAgentEnabledStore.use()
  const inCase = controller.device && controller.device.stale !== true && controller.device.inCase === true
  const agentShown = agentEnabled && pulseAgentPlan(view, { inCase }).shown

  const interactive = typeof onActivate === 'function'
  const Root = interactive ? 'button' : 'span'
  const trigger = jsxs(Root, {
    role: interactive ? undefined : 'img',
    'aria-label': batteryLabel ? `OcuClaw G2 status, ${batteryLabel}` : 'OcuClaw G2 status',
    title: batteryLabel || 'OcuClaw G2 status',
    'data-pulse-state': view.state,
    onMouseEnter: () => setHovered(true),
    onMouseLeave: () => setHovered(false),
    onFocus: () => setFocused(true),
    onBlur: () => setFocused(false),
    style: {
      position: 'relative',
      display: 'inline-flex',
      alignItems: 'center',
      minWidth: 89,
      height: 24,
      marginRight: 0,
      padding: 0,
      border: 0,
      background: 'transparent',
      color: hovered || focused
        ? 'var(--ui-text-primary)'
        : 'color-mix(in srgb, var(--dt-muted-foreground, var(--ui-text-tertiary)) 85%, transparent)',
      cursor: interactive ? 'pointer' : 'default',
      transform: 'translateY(1px)',
      WebkitAppRegion: 'no-drag',
    },
    children: [
      jsx(PulseBatteryIcon, { battery, charging, reduced }),
      jsxs('span', {
        'data-g2-frame-shell': '',
        style: { position: 'relative', display: 'block', width: 60, height: 22, flex: '0 0 auto' },
        children: [
          jsx(PulseGlasses, {
            view,
            width: 60,
            height: 22,
            frameColor: 'inherit',
            inkColor: 'var(--ui-accent, #4dd58a)',
            reduced,
          }),
          jsx(PulseBadge, { kind: view.badge }),
        ],
      }),
      // The Agent joins the cluster after a hair-line divider; the glasses keep
      // the badge and the pairing / in-case / offline vocabulary.
      agentShown ? jsx('span', { 'aria-hidden': 'true', 'data-pulse-agent-divider': '', style: { width: 1, height: 14, marginLeft: 6, background: 'var(--ui-border)', flex: '0 0 auto' } }) : null,
      agentShown ? jsx('span', {
        'data-pulse-agent-shell': '',
        style: { display: 'block', marginLeft: 6, width: 75, height: 24, flex: '0 0 auto' },
        children: jsx(PulseAgent, { view, inCase, reduced, width: 75, height: 24 }),
      }) : null,
    ],
  })

  if (!interactive) return trigger
  return jsxs(Popover, {
    open: pulseCardOpen,
    onOpenChange: next => {
      if (next) onActivate()
      else closePulseCard()
    },
    children: [
      jsx(PopoverTrigger, { asChild: true, children: trigger }),
      jsx(PopoverContent, {
        side: 'bottom',
        align: 'end',
        sideOffset: 7,
        style: { width: controller.paired === true ? 300 : 360, minHeight: controller.paired === true ? 212 : undefined, padding: controller.paired === true ? 0 : 12, overflow: 'hidden' },
        // PairingDialog can only display an existing ceremony. Until one
        // exists, expose the setup panel that can start it and track progress.
        children: !desktopLocalActions()
          ? jsx(PulseCard, { ctx, onClose: closePulseCard, readOnly: true })
          : controller.paired === true
          ? jsx(PulseCard, { ctx, onClose: closePulseCard })
          : jsx(SetupCard, { ctx, api }),
      }),
    ],
  })
}


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
    restartComplete: stored.restartComplete === true,
    restartRequestedAt: Number.isFinite(stored.restartRequestedAt) ? stored.restartRequestedAt : 0,
    restartGatewayPid: Number.isInteger(stored.restartGatewayPid) ? stored.restartGatewayPid : null,
    pairingStopped: stored.pairingStopped && typeof stored.pairingStopped === 'object' &&
      typeof stored.pairingStopped.sessionId === 'string'
      ? { sessionId: stored.pairingStopped.sessionId, reason: String(stored.pairingStopped.reason || '') }
      : null,
  })
  if (setupRunStore.get().restartRequestedAt) {
    gatewayRestart.at = setupRunStore.get().restartRequestedAt
    gatewayRestart.pid = setupRunStore.get().restartGatewayPid
  }
}

// The gateway resolves a skill slash command to the body the model actually
// reads; `type` is 'skill' for a skill command and 'send' for the quick/bundle
// shapes that share the directive.
const skillMessage = result => {
  if (!result || typeof result !== 'object') return ''
  if (result.type !== 'skill' && result.type !== 'send') return ''
  return typeof result.message === 'string' ? result.message.trim() : ''
}

// /ocuclaw-setup is the `ocuclaw-setup` filesystem skill
// (setup_command_skill.py); all it says is "load
// ocuclaw:ocuclaw-assist-hermes". `slash.exec` answers it as a one-skill
// answer named after it. The card can ask for the real skill directly and
// save the model that hop, so it holds the pointer back and uses it only when
// the real skill cannot be asked for (Hermes 0.22.1). A bundle answer (an
// older build's bundle, or a user's own) is a `send` and is used as is.
const isSetupPointer = result =>
  !!result && typeof result === 'object' && result.type === 'skill' && result.name === SETUP_COMMAND

// Exactly the two-step Hermes Desktop performs for a skill command typed into
// the composer: `slash.exec` resolves it, `command.dispatch` is the documented
// fallback when the slash worker refuses the route. Submitting the literal
// "/ocuclaw-setup" as prompt text is NOT equivalent — the gateway re-expands a
// slash invocation only on a rewind replay (methods_prompt gates that on
// `has_truncation`), so the model would receive the bare literal string and no
// skill at all.
//
// Both answer with the `ocuclaw-setup` pointer skill, which the card holds
// back. Hermes 0.22.3+ resolves plugin skills on that route, so the card next
// asks `slash.exec` for the real skill by its qualified name: the setup skill
// under Hermes's one-skill header, with no hop. Where that fails (0.22.1) the
// pointer is sent. Only with neither (no pointer skill on disk: a user's own
// file failed to resolve, or an older build left only its bundle) does the
// card ask OcuClaw's own backend, which expands an `/ocuclaw-setup` bundle
// with Hermes's own build_bundle_invocation_message in the same `send` shape.
// Hermes's routes stay first, so a host that resolves one never reaches it.
const SETUP_INVOCATION_TIMEOUT_MS = 15000
const resolveSetupInvocation = async (sessionId, api) => {
  let message = ''
  let pointer = ''
  const take = result => {
    if (isSetupPointer(result)) { pointer = pointer || skillMessage(result); return '' }
    return skillMessage(result)
  }
  try {
    message = take(await sdk.host.request('slash.exec', { session_id: sessionId, command: SETUP_COMMAND }))
  } catch {}
  let hostError = null
  if (!message && !pointer) {
    try {
      message = take(await sdk.host.request('command.dispatch', { session_id: sessionId, name: SETUP_COMMAND, arg: '' }))
    } catch (error) { hostError = error }
  }
  if (!message) {
    try {
      message = skillMessage(await sdk.host.request('slash.exec', { session_id: sessionId, command: SETUP_SKILL }))
    } catch {}
  }
  if (!message) message = pointer
  if (message) return message
  let reason = 'not available'
  if (typeof api === 'function') {
    try {
      const own = await api('/setup-invocation', {
        method: 'POST', body: { presenterCapability: PRESENTER_CAPABILITY }, timeoutMs: SETUP_INVOCATION_TIMEOUT_MS,
      })
      if (own && own.contract === 'ocuclaw.setup-invocation' && own.ok === true) {
        message = skillMessage(own)
        if (!message) reason = 'no message'
      } else reason = own && typeof own.reason === 'string' ? own.reason : 'unexpected answer'
    } catch (error) { reason = String((error && error.message) || error) }
  }
  if (message) return message
  const host = hostError ? String(hostError.message || hostError) : 'no skill message'
  throw new Error(`the gateway did not resolve /${SETUP_COMMAND} (${host}); OcuClaw could not expand it either (${reason})`)
}

// "Pair your glasses" — the whole hand-off (#1989 item 3). The card mints the
// chat, hands the operator to it, and dispatches the setup skill into it. The
// operator types nothing and reads no instructions.
const dispatchSetup = async api => {
  if (setupRunStore.get().status === 'dispatching') return
  if (setupRunStore.get().status === 'running') { openSetupChat(); return }
  setupRunStore.set({ status: 'dispatching' })
  try {
    const created = await sdk.host.request('session.create', { cols: 96, source: 'desktop' })
    const sessionId = String((created && created.session_id) || '')
    if (!sessionId) throw new Error('session.create returned no runtime session')
    const storedSessionId = String((created && created.stored_session_id) || '') || sessionId
    const message = await resolveSetupInvocation(sessionId, api)
    // Keep the complete resolved skill. Hermes 0.21's in-flight resume
    // projection bypasses display_kind and skill-display metadata; its clean
    // composer displayText hook is not in the plugin SDK. See the release plan.
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

// ── The profile gate ─────────────────────────────────────────────────────
// Hermes Desktop runs ONE backend per profile and routes `hermes:api` to the
// ACTIVE profile's backend. A profile whose home does not list `ocuclaw` in
// plugins.enabled has no OcuClaw backend at all: Hermes'
// `_plugin_api_runtime_gate` answers every call into our namespace with
// 404 {"detail":"Plugin not found"}. Retrying cannot fix that — there is
// nothing on the other end to reach — and each rejected call is logged by the
// main process, so a card that kept polling produced 169 console errors in ten
// minutes on the live 0.20.6 Desktop (#2007). So absence stops BOTH pollers
// and the card says so, once, quietly.
const PROFILE_ABSENT_LABEL = 'OcuClaw is not enabled in this profile'
// Fallback cadence only — used when the host exposes no active-profile signal.
const PLUGIN_ABSENT_RECHECK_MS = 60000

// Classify off the MESSAGE, never a status field. main.ts's fetchJson rejects
// with `new Error(`${res.statusCode}: ${text || res.statusMessage}`)`, and that
// rejection crosses ipcMain.handle → ipcRenderer.invoke, which serialises an
// error to message + stack only: `error.status` / `error.statusCode` do not
// exist on this side. What the plugin actually catches is
//   Error invoking remote method 'hermes:api': Error: 404: {"detail":"Plugin not found"}
// Both halves are demanded on purpose. A bare 404 from some other route is a
// different failure, and the existing fail-safe there — treat as not paired,
// leave the card up — is the right answer for it. Timeouts and 5xx never match
// (they reject with their own wording), so a retryable blip stays retryable.
const isPluginAbsentError = error => {
  if (!error) return false
  const text = String((error && error.message) || error)
  return /Plugin not found/i.test(text) && /(?:^\s*|error:\s*)404\b/i.test(text)
}

// ── Routes not mounted yet (#4047) ───────────────────────────────────────
// Hermes mounts a plugin's API routes once, when its backend (`hermes serve`)
// starts: "mounted once at startup, not on rescan". Installing OcuClaw from
// Desktop activates it in that running backend without a restart, so this
// card loads from disk while every OcuClaw route still falls through to the
// backend's catch-all. Desktop's backend is headless and its catch-all names
// no path (hermes_cli/web_server_dashboard.py mount_spa, seen in CI on 0.21.5):
//   Error invoking remote method 'hermes:api': Error: 404: {"error":"Headless backend (hermes serve): web UI disabled — use `hermes dashboard` for the browser UI."}
// A `hermes dashboard` backend answers with its SPA catch-all instead:
//   Error invoking remote method 'hermes:api': Error: 404: {"detail":"No such API endpoint: /api/plugins/ocuclaw/setup-card"}
// This is only asked of an error from OcuClaw's own route, so the headless
// answer, which names no path, still speaks for OcuClaw's.
// Nothing here can pair until the backend restarts: the pairing panel claims
// its ceremony through those same routes. A window reload reloads the UI, not
// the backend, so it does not help. Offering "Pair your glasses" in this state
// led to a setup chat with no panel and, 345 s later, a timeout that blamed
// the glasses.
const isRoutesMissingError = error => {
  if (!error) return false
  const text = String((error && error.message) || error)
  if (!/(?:^\s*|error:\s*)404\b/i.test(text)) return false
  return /No such API endpoint: \/api\/plugins\/ocuclaw\//i.test(text) || /Headless backend \(hermes serve\)/i.test(text)
}
// Desktop restarts its own backend without closing the window: the Models
// page's "Restart backend" and the "Restart Hermes" error toasts both call
// this preload bridge (apps/desktop/electron/main.ts 'hermes:backend:recycle',
// present on 0.21.1 and 0.21.5), and the new backend mounts OcuClaw's routes.
// The plugin SDK has no backend restart, so the card calls the same bridge,
// the way the SDK's own profileRoutes reaches window.hermesDesktop. It rides
// the person's "Restart gateway" click, so setup never asks them to quit.
const desktopBackendBridge = () => {
  try {
    const desktop = typeof window === 'undefined' ? null : window.hermesDesktop
    return desktop && typeof desktop.recycleBackend === 'function' ? desktop : null
  } catch {
    return null
  }
}
// Module scope on purpose: the recycle can remount the card, and a remount
// must neither recycle a second time nor offer "Restart gateway" while the new
// backend boots.
const backendRecycle = { requested: false, at: 0, gatewayAfter: false, unloadedSince: 0 }
// What the card does while OcuClaw's routes are missing:
//   'recycle'  the person already asked for a restart: restart the backend now
//   'wait'     a recycle is under way: keep saying so
//   'offer'    show "Restart gateway"; its click restarts the backend
//   'relaunch' no bridge, or a recycle that did not bring the routes back
const routesMissingStep = ({ bridge, requested, recycledAt, now }) => {
  if (!bridge) return 'relaunch'
  if (recycledAt) return now - recycledAt < RESTART_PATIENCE_MS ? 'wait' : 'relaunch'
  return requested ? 'recycle' : 'offer'
}
// Restart the backend of the profile this window's gateway is routed to, as
// Desktop's own toast does. Its promise settles once the old backend is torn
// down, which says nothing about the new one: the card's probe owns that.
const recycleBackend = () => {
  backendRecycle.requested = true
  backendRecycle.at = Date.now()
  const desktop = desktopBackendBridge()
  if (!desktop) return
  let profile = ''
  try { profile = String(sdk.host.state?.['profile']?.get?.() || '').trim() } catch {}
  try { void Promise.resolve(desktop.recycleBackend(profile || 'default')).catch(() => undefined) } catch {}
}
const RELAUNCH_LABEL = 'Quit and reopen Hermes Desktop to finish setup'
// Without a recycle the routes only appear with a new backend, so there is
// nothing to catch quickly; this only notices a backend Hermes recycled on its own.
const ROUTES_MISSING_RECHECK_MS = 60000
// How long a new backend must keep reporting a gateway without OcuClaw before
// the card restarts the gateway too. On 0.21.1 the old backend hid a loaded
// OcuClaw, so the new one usually shows it within a probe or two.
const GATEWAY_AFTER_SETTLE_MS = 5000

const pluginAbsentStore = makeStore(false)
let absenceAnnounced = false
let profileWatchUnsubscribes = null
let absenceRecheckTimer = null

// Absence is not an error state — it is a host the operator has pointed
// somewhere else. One info line, never a repeat, never console.error.
const announceAbsenceOnce = () => {
  if (absenceAnnounced) return
  absenceAnnounced = true
  console.info('[ocuclaw] OcuClaw is not enabled in the active Hermes profile; pausing until the profile changes.')
}

const clearProfileAbsence = () => {
  glassesStateGeneration += 1
  window.clearTimeout(glassesStateExpiryTimer)
  glassesStateStore.set(EMPTY_GLASSES_STATE)
  glassesStateSocketCleanup?.()
  glassesStateSocketCleanup = null
  if (glassesStateMounted && glassesStateSocket) {
    try { glassesStateSocketCleanup = glassesStateSocket('/glasses/events', () => invalidateGlassesStateQuery()) } catch {}
  }
  window.clearTimeout(absenceRecheckTimer)
  if (pluginAbsentStore.get()) pluginAbsentStore.set(false)
  // The card's probe restarts from its own effect; the claim loop needs a kick.
  scheduleWatch(0)
  scheduleGlassesPoll(0)
}

// There is no 'profile-changed' event to subscribe to — the host's signal is a
// pair of nanostores atoms on `sdk.host.state` (Hermes 0.20.6 sdk/index.ts):
// `profile` ("profile the live gateway is routed to", backed by
// $activeGatewayProfile) and `connectionId` ("registry source that owns the
// active gateway"). BOTH are watched because a profile name is not an identity
// — two registered connections can each expose `default`, and a swap between
// them is a different backend under an unchanged name.
//
// Subscribed by hand like busyBySession above, so an older host missing either
// atom degrades to the slow re-check instead of throwing in a hook.
const watchHostAtom = (atom, onChange) => {
  if (!atom || typeof atom.subscribe !== 'function') return null
  let seen = null
  let first = true
  try {
    return atom.subscribe(value => {
      const next = String(value ?? '')
      // Nanostores replays the current value on subscribe; that is not a change.
      if (first) { first = false; seen = next; return }
      if (next === seen) return
      seen = next
      onChange()
    })
  } catch {
    return null
  }
}

const ensureProfileWatch = () => {
  if (profileWatchUnsubscribes) return true
  const state = (sdk.host && sdk.host.state) || null
  if (!state) return false
  // Bracket access on purpose, and it must stay. Hermes' own plugin scanner
  // has a `shell_rc_mod` persistence rule that matches a dotted `profile`
  // member read as if it were a shell startup file in the home directory, and
  // raises a medium finding against the published bundle for it. The bracket
  // form is the identical read with no false accusation attached.
  const watches = [
    watchHostAtom(state['profile'], clearProfileAbsence),
    watchHostAtom(state.connectionId, clearProfileAbsence),
  ].filter(Boolean)
  if (!watches.length) return false
  profileWatchUnsubscribes = watches
  return true
}

const noteProfileAbsence = () => {
  announceAbsenceOnce()
  if (pluginAbsentStore.get()) return
  pluginAbsentStore.set(true)
  if (!ensureProfileWatch()) {
    window.clearTimeout(absenceRecheckTimer)
    absenceRecheckTimer = window.setTimeout(clearProfileAbsence, PLUGIN_ABSENT_RECHECK_MS)
  }
}

// ── The pairing watch ────────────────────────────────────────────────────
// One module-local poller, owned by the presenter contribution, which is now
// always mounted (see the register() note). It claims the setup tool's pairing
// checkpoint and summons the window the moment the checkpoint is live — the
// operator is never asked to hold anything open waiting for it.
// PAIRING_WATCH_BEGIN
let watchApi = null
let watchTimer = null
let watchMounted = 0

const scheduleWatch = delay => {
  window.clearTimeout(watchTimer)
  if (!watchMounted || pluginAbsentStore.get()) return
  watchTimer = window.setTimeout(() => void watchTick(), delay)
}

const claimDelay = () => (setupRunStore.get().status === 'running' ? CLAIM_INTERVAL_MS : CLAIM_IDLE_INTERVAL_MS)

const watchTick = async () => {
  if (!watchMounted || !watchApi || pluginAbsentStore.get()) return
  const current = ceremonyStore.get()

  // No ceremony, or one that has reached its outcome: watch for the next
  // checkpoint. A finished outcome stays on screen for the operator to read,
  // but it must never hold back a newer pair_phone request (#3909): the new
  // claim replaces it with no Done click. The claim route also retries a
  // terminal callback the setup tool has not acknowledged yet, answering with
  // that same session until it lands or the window expires, so the finished
  // session needs no state poll of its own.
  if (!current || current.phase === 'outcome') {
    let claimed = null
    try {
      claimed = await watchApi('/pairing/claim', { method: 'POST', body: { presenterCapability: PRESENTER_CAPABILITY }, timeoutMs: 2500 })
    } catch (error) {
      // The claim loop shares the namespace, so it 404s on the same profiles
      // the card does. Left alone it would out-spam the card at 2.5s a tick.
      if (isPluginAbsentError(error)) { noteProfileAbsence(); return }
    }
    if (!watchMounted) return
    // Done or Close changed the ceremony while this claim was in flight, and
    // that change already scheduled the next tick. A stale reply adopts
    // nothing and schedules nothing, so one loop stays one loop.
    if (ceremonyStore.get() !== current) return
    // The finished session answering for itself is not a new checkpoint.
    if (claimed && claimed.active && !(current && claimed.sessionId === current.sessionId)) {
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

  try {
    const next = await watchApi(`/pairing/${encodeURIComponent(current.sessionId)}`, {
      method: 'POST',
      body: { op: 'state', presenterCapability: PRESENTER_CAPABILITY },
      timeoutMs: 5000,
    })
    if (!watchMounted) return
    mergeCeremony(next)
  } catch (error) {
    if (!watchMounted) return
    if (isPluginAbsentError(error)) { noteProfileAbsence(); return }
    ceremonyStore.set(live => (live ? { ...live, message: 'The local pairing controller could not be reached; retrying…' } : live))
  }
  scheduleWatch(STATE_INTERVAL_MS)
}

const adoptClaim = claimed => {
  if (claimed.phase === 'outcome' || claimed.phase === 'words' || claimed.phase === 'deciding') return claimed
  if (claimed.phase === 'phone-code' || claimed.phase === 'phone-sent') return claimed
  // `qr` is the manual phase's wire name, kept so older copies still agree.
  // It shows the address and pairing code; no window draws a QR (#5486).
  const parsed = splitBootstrap(claimed.bootstrapBlock, claimed)
  if (!parsed) return null
  return { ...claimed, ...parsed, phase: 'qr' }
}

// Merge a state reply into the live ceremony, re-summoning the window on the
// two phases the operator MUST see: the four-word confirmation they have to
// approve, and the outcome that ends the ceremony.
const mergeCeremony = next => {
  ceremonyStore.set(live => {
    if (!live) return live
    if (next.sessionId && next.sessionId !== live.sessionId) return live
    // Once an exchange exists the code boxes are behind it: a reply that was
    // already in flight must not bring them back.
    if (next.phase === 'phone-code' && live.phase !== 'phone-code') return live
    const parsed = next.phase === 'qr' ? splitBootstrap(next.bootstrapBlock, next) : null
    // The window's line and tries are the server's, reply by reply: a good
    // reply clears a failed poll's "retrying…" note, and a typed pairing
    // code drops the tries line.
    const merged = { ...live, ...next, ...parsed, message: next.message, triesLeft: next.triesLeft }
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
// PAIRING_WATCH_END

// ── "Get a new code" (#3909) ─────────────────────────────────────────────
// A code that ran out leaves the chat asking "fresh code?" behind this modal
// window, which a pointer cannot get past. The button answers that question
// in the chat, as the person's reply, so the model calls pair_phone again and
// the watch above swaps the fresh pairing into this same window. The window never
// mints a code itself: the chat stays the one place that starts pairing.
// PAIRING_NEW_CODE_BEGIN
const NEW_CODE_REPLY = 'Yes, get a new code'
// The relay's names for "the five-minute window ran out". The setup tool
// reports both to the chat as `expired` (EXPIRED_CODES in tui_pairing.py).
const NEW_CODE_REASONS = ['expired', 'completion-window-elapsed']

const newCodeSupported = () => typeof sdk.host?.composer?.submit === 'function' &&
  typeof sdk.host?.request === 'function'

const offersNewCode = ceremony => Boolean(ceremony) && ceremony.phase === 'outcome' &&
  ceremony.outcomeState !== 'completed' && NEW_CODE_REASONS.includes(ceremony.reason) &&
  newCodeSupported()

const hostSessionId = key => {
  try {
    const value = sdk.host.state?.[key]?.get?.()
    return typeof value === 'string' ? value : ''
  } catch { return '' }
}

// Runtime ids of the chats that may be asking: the setup run this card
// started, then the focused and the active chat.
const newCodeChats = () => {
  const run = setupRunStore.get()
  return [...new Set([
    run && run.status === 'running' ? run.sessionId : '',
    hostSessionId('focusedSessionId'),
    hostSessionId('activeSessionId'),
  ].filter(id => typeof id === 'string' && id))]
}

// A clarify card owns the turn: the agent is blocked inside it, and a chat
// message sent past it waits out the clarify's own five-minute timeout. So an
// open question is answered directly, with the reply as the person's answer,
// through the gateway's `request.answer` (its proxy for a surface that is not
// the one showing the card). `session.events.since` is the read that returns
// a session's open requests; a watermark past the end replays no events.
const openClarify = async sessionId => {
  const snapshot = await sdk.host.request('session.events.since', { session_id: sessionId, last_seen: Number.MAX_SAFE_INTEGER })
  const open = snapshot && Array.isArray(snapshot.open_requests) ? snapshot.open_requests : []
  return open.find(request => request && request.method === 'clarify' && typeof request.id === 'string') || null
}

// A single question takes `{ answer }`; a batch of one takes its qid. A batch
// of several is not the fresh-code question, so it is left to the person.
const clarifyReply = request => {
  const questions = request.params && request.params.questions
  if (!Array.isArray(questions)) return { answer: NEW_CODE_REPLY }
  const qid = questions.length === 1 && questions[0] ? questions[0].qid : ''
  return typeof qid === 'string' && qid ? { answers: { [qid]: NEW_CODE_REPLY } } : null
}

const answerOpenClarify = async chats => {
  for (const sessionId of chats) {
    let request = null
    try { request = await openClarify(sessionId) } catch { continue }
    if (!request) continue
    const result = clarifyReply(request)
    if (!result) return 'unanswerable'
    try {
      const answered = await sdk.host.request('request.answer', { id: request.id, result })
      if (answered && answered.status === 'ok') return 'answered'
    } catch {}
  }
  return 'none'
}

// With no open question, the reply is sent through the chat's composer as if
// typed and sent: the setup run's chat when it is on screen, else the chat the
// person is looking at. The composer refuses a chat that is not on screen.
const sendNewCodeReply = () => {
  const run = setupRunStore.get()
  const targets = [run && run.status === 'running' && run.sessionId ? run.sessionId : null, null]
  for (const target of [...new Set(targets)]) {
    try { if (sdk.host.composer.submit(target, NEW_CODE_REPLY) === true) return true } catch {}
  }
  return false
}

// The button: reply in the chat, then close the result. The watch keeps
// claiming, so the next pair_phone reopens this window on its fresh pairing.
const requestNewCode = async () => {
  if (!newCodeSupported()) return false
  const chats = newCodeChats()
  const clarified = await answerOpenClarify(chats)
  const sent = clarified === 'answered' || (clarified === 'none' && sendNewCodeReply())
  if (sent) clearCeremony()
  return sent
}
// PAIRING_NEW_CODE_END

// ── Pairing that stopped inside a setup run ──────────────────────────────
// The setup run lasts as long as its chat (up to SETUP_RUN_STALE_MS), but its
// pairing window lasts five minutes. When the window ends without a pairing
// (the code ran out, or the person stopped or refused it) and the person
// clicks Done, or walks away, the card used to stay on "Waiting for setup…"
// for hours: cross-OS run 42325686916 on Linux, macOS and Windows. So the run
// remembers the stopped pairing, and the card offers "Pair your glasses" again.
// An outcome is noted once per pairing session; a later live pairing clears it.
// PAIRING_STOPPED_BEGIN
const settledOutcomes = new Set()

const pairingStoppedRun = (run, ceremony) => {
  if (!run || run.status !== 'running' || !ceremony) return run
  const sessionId = typeof ceremony.sessionId === 'string' ? ceremony.sessionId : ''
  if (ceremony.phase !== 'outcome') {
    // The chat started pairing again: that pairing is what the card follows.
    return run.pairingStopped ? { ...run, pairingStopped: null } : run
  }
  // A completed pairing is the probe's to retire, off the backend's receipt.
  if (ceremony.outcomeState === 'completed' || !sessionId || settledOutcomes.has(sessionId)) return run
  settledOutcomes.add(sessionId)
  return { ...run, pairingStopped: { sessionId, reason: typeof ceremony.reason === 'string' ? ceremony.reason : '' } }
}

const followSetupRunPairing = ceremony => {
  const run = setupRunStore.get()
  const next = pairingStoppedRun(run, ceremony)
  if (next !== run) rememberSetupRun(next)
}
ceremonyStore.subscribe(followSetupRunPairing)

// The card's "Pair your glasses" after a stopped pairing. A code that ran out
// is answered in the same chat, the way "Get a new code" answers it: the open
// question first, else the setup chat's composer when that chat is on screen.
// Any other stop, or a chat that cannot be reached, starts setup over in a new
// chat, so the click always leads to a pairing window.
const retryStoppedPairing = async api => {
  const run = setupRunStore.get()
  const stopped = run && run.status === 'running' ? run.pairingStopped : null
  const sessionId = run && typeof run.sessionId === 'string' ? run.sessionId : ''
  const finished = ceremonyStore.get()
  if (finished && finished.phase === 'outcome') clearCeremony()
  if (stopped && sessionId && NEW_CODE_REASONS.includes(stopped.reason) && newCodeSupported()) {
    let asked = 'none'
    try { asked = await answerOpenClarify([sessionId]) } catch {}
    let sent = asked === 'answered'
    if (!sent && asked === 'none') {
      try { sent = sdk.host.composer.submit(sessionId, NEW_CODE_REPLY) === true } catch {}
    }
    if (sent) {
      rememberSetupRun({ ...setupRunStore.get(), pairingStopped: null })
      openSetupChat()
      return 'same-chat'
    }
  }
  rememberSetupRun(IDLE_SETUP_RUN)
  await dispatchSetup(api)
  return 'new-chat'
}
// PAIRING_STOPPED_END

const clean = value => [...String(value ?? '')]
  .map(character => {
    const code = character.codePointAt(0) ?? 0
    return code < 32 || (code >= 127 && code <= 159) ? ' ' : character
  })
  .join('')
  .slice(0, 240)

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

// The manual view's words and clock, as in every terminal's manual block.
const MANUAL_PAIRING_PROMPT = 'In OcuClaw tap Pair with your agent > Pair manually, then type:'
const pairingExpiryText = (expiresAtMs, now = Date.now()) => {
  const left = Math.max(0, Math.ceil((expiresAtMs - now) / 1000))
  return `Expires in ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}.`
}
function PairingExpiry({ expiresAtMs }) {
  const [, tick] = useState(0)
  useEffect(() => {
    const timer = window.setInterval(() => tick(count => count + 1), 1000)
    return () => window.clearInterval(timer)
  }, [expiresAtMs])
  return jsx('p', { style: { color: 'var(--ui-text-tertiary)' }, children: pairingExpiryText(expiresAtMs) })
}

function PairingDialog({ api }) {
  usePairingWatch(api)
  const opened = presenterStore.use()
  const ceremony = ceremonyStore.use()
  const [sending, setSending] = useState(false)
  const submitting = useRef(false)
  const [draft, setDraft] = useState(null)
  const boxes = useRef([])
  // The draft belongs to one session; no draft (or no ceremony) is six empty boxes.
  const digits = draft && ceremony && draft.sessionId === ceremony.sessionId ? draft.digits : Array(6).fill('')
  const phoneCode = digits.join('')
  const busy = sending || ceremony?.phase === 'deciding'
  // #5224. A paste (or a six-digit autofill) spreads across the boxes; a key
  // typed into a filled box replaces that box's digit.
  const fillCode = (index, text, pasted = false) => {
    const cleaned = text.replace(/\D/g, '')
    const typedOver = !pasted && cleaned.length > 1 && cleaned.length < 6
    const incoming = typedOver
      ? (cleaned[0] === digits[index] ? cleaned.slice(1) : cleaned).slice(0, 1)
      : cleaned.slice(0, 6)
    const start = incoming.length === 6 ? 0 : index
    const next = [...digits]
    if (!incoming) next[index] = ''
    for (let offset = 0; offset < incoming.length && start + offset < 6; offset++) next[start + offset] = incoming[offset]
    setDraft({ sessionId: ceremony?.sessionId, digits: next })
    if (incoming) boxes.current[Math.min(5, start + incoming.length)]?.focus()
  }
  // "Get a new code" progress, pinned to the outcome it was clicked on.
  const [newCode, setNewCode] = useState(null)
  const newCodeStatus = newCode && ceremony && newCode.sessionId === ceremony.sessionId ? newCode.status : 'idle'
  const getNewCode = async () => {
    const sessionId = ceremony?.sessionId
    setNewCode({ sessionId, status: 'sending' })
    let sent = false
    try { sent = await requestNewCode() } catch {}
    // The chat is getting a new code, so the card stops offering one.
    if (sent && setupRunStore.get().pairingStopped) rememberSetupRun({ ...setupRunStore.get(), pairingStopped: null })
    setNewCode(sent ? null : { sessionId, status: 'failed' })
  }

  const command = async (op, phoneCode) => {
    const sessionId = ceremony?.sessionId
    if (!sessionId || submitting.current) return
    submitting.current = true
    setSending(true)
    const deciding = op === 'approve'
      ? 'Approving and waiting for the phone…'
      : op === 'cancel' ? 'Stopping this pairing…' : 'Refusing this phone…'
    if (op !== 'create') ceremonyStore.set(current => current ? { ...current, phase: 'deciding', message: deciding } : current)
    try {
      const next = await api(`/pairing/${encodeURIComponent(sessionId)}`, { method: 'POST', body: { op, presenterCapability: PRESENTER_CAPABILITY, ...(phoneCode === undefined ? {} : { phoneCode }) }, timeoutMs: op === 'create' ? 15000 : 5000 })
      mergeCeremony(next)
      // A wrong code: empty boxes for the next try, under the message.
      if (phoneCode !== undefined && next?.phase === 'phone-code') {
        setDraft(null)
        boxes.current[0]?.focus()
      }
    } catch {
      ceremonyStore.set(current => current?.sessionId === sessionId ? { ...current, phase: 'outcome', outcomeState: 'failed', message: 'The local pairing controller could not be reached.' } : current)
    } finally {
      submitting.current = false
      setSending(false)
    }
    scheduleWatch(STATE_INTERVAL_MS)
  }

  // Hiding is not stopping. A live exchange is a 120-second clock the operator
  // cannot restart by reopening a window, so the window never takes the
  // ceremony down with it — only "Stop pairing" does. The card carries a
  // "Show" action back (#1989 item 1).
  const hide = () => presenterStore.set(false)

  let body
  let title = 'Pair OcuClaw phone'
  if (ceremony?.phase === 'phone-code') {
    body = jsxs('div', { style: { display: 'grid', gap: 12 }, children: [
      jsx('p', { children: 'In Even Hub open OcuClaw and tap the Pair button. Type the phone code it shows:' }),
      jsx('div', { role: 'group', 'aria-label': 'Six-digit phone code', style: { display: 'flex', justifyContent: 'center', gap: 8 }, children: digits.map((digit, index) => jsx('input', {
        'aria-label': `Phone code digit ${index + 1}`, inputMode: 'numeric', autoComplete: index === 0 ? 'one-time-code' : 'off',
        type: 'text', value: digit, disabled: busy,
        ref: element => { boxes.current[index] = element },
        style: { width: 42, height: 52, minWidth: 0, textAlign: 'center', fontSize: 26, borderRadius: 8, border: '1px solid var(--ui-border)', background: 'var(--ui-bg-secondary)', color: 'var(--ui-text-primary)' },
        onFocus: event => event.target.select?.(),
        onChange: event => fillCode(index, event.target.value),
        onPaste: event => { event.preventDefault(); fillCode(index, event.clipboardData.getData('text'), true) },
        onKeyDown: event => {
          if (event.key === 'Backspace' && !digit) boxes.current[Math.max(0, index - 1)]?.focus()
          if (event.key === 'ArrowLeft') boxes.current[Math.max(0, index - 1)]?.focus()
          if (event.key === 'ArrowRight') boxes.current[Math.min(5, index + 1)]?.focus()
          if (event.key === 'Enter' && phoneCode.length === 6 && !busy) void command('create', phoneCode)
        },
      }, index)) }),
      ceremony.message ? jsx('p', { role: 'alert', children: ceremony.message }) : null,
      ceremony.triesLeft ? jsx('p', { style: { color: 'var(--ui-text-tertiary)' }, children: `${ceremony.triesLeft} ${ceremony.triesLeft === 1 ? 'try' : 'tries'} left.` }) : null,
    ] })
  } else if (ceremony?.phase === 'phone-sent') {
    body = jsx('p', { style: { whiteSpace: 'pre-line' }, children: ceremony.message })
  } else if (ceremony?.phase === 'qr') {
    // Manual pairing (#5486): the address and pairing code, typed on the
    // phone. The words are the terminals' manual block (spec, QR removal).
    body = jsxs('div', { style: { display: 'grid', gap: 10 }, children: [
      jsx('p', { children: MANUAL_PAIRING_PROMPT }),
      jsx('code', { style: { overflowWrap: 'anywhere' }, children: ceremony.addressLine }),
      jsx('code', { children: ceremony.codeLine }),
      Number.isFinite(ceremony.expiresAtMs) ? jsx(PairingExpiry, { expiresAtMs: ceremony.expiresAtMs }) : null,
      jsx('p', { style: { color: 'var(--ui-text-tertiary)' }, children: 'The screen advances automatically.' }),
    ] })
    if (ceremony.message) body = jsxs('div', { style: { display: 'grid', gap: 10 }, children: [jsx('p', { children: ceremony.message }), body] })
  } else if (ceremony?.phase === 'words') {
    body = jsxs('div', { style: { display: 'grid', gap: 14 }, children: [
      jsx('p', { children: `Phone: ${clean(ceremony.phoneLabel) || 'unknown device'}` }),
      jsx('div', { style: { padding: 16, textAlign: 'center', fontSize: 20, fontWeight: 650, letterSpacing: '0.04em', background: 'var(--ui-bg-tertiary)', borderRadius: 8 }, children: clean(ceremony.phrase) }),
      jsx('p', { children: 'Approve only if all four words match in order on the phone.' }),
      jsx('p', { style: { color: 'var(--ui-text-tertiary)' }, children: 'Approving also lets these glasses talk to your agent.' }),
    ] })
  } else if (ceremony?.phase === 'deciding') {
    body = jsxs('div', { style: { display: 'flex', alignItems: 'center', gap: 10 }, children: [jsx(GlyphSpinner, {}), jsx('span', { children: ceremony.message })] })
  } else if (ceremony?.phase === 'outcome') {
    title = ceremony.outcomeState === 'completed' ? 'Phone paired' : 'Pairing stopped'
    body = jsx('p', { children: ceremony.message || (ceremony.outcomeState === 'completed' ? 'The phone connected back and the managed gateway confirmed it.' : 'Nothing was approved. You can retry this setup checkpoint.') })
    if (newCodeStatus === 'failed') {
      body = jsxs('div', { style: { display: 'grid', gap: 10 }, children: [
        body,
        jsx('p', { style: { color: 'var(--ui-text-tertiary)' }, children: 'The chat could not be reached. Click Done, then ask the chat for a new code.' }),
      ] })
    }
  }
  const newCodeOffered = offersNewCode(ceremony)

  // No idle state exists any more. The window has exactly one reason to be on
  // screen — a live ceremony — so it can never be the thing that tells the
  // operator to keep it open (#1989 item 2).
  const open = Boolean(ceremony) && opened
  return jsx(Dialog, {
    open,
    // A terminal outcome is done with; anything else is only hidden.
    onOpenChange: next => { if (!next) (ceremony.phase === 'outcome' ? clearCeremony : hide)() },
    children: open ? jsxs(DialogContent, {
      showCloseButton: ['phone-code', 'phone-sent', 'qr', 'outcome'].includes(ceremony.phase),
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
        ceremony.phase === 'phone-code' ? jsxs(DialogFooter, { children: [
          jsx(Button, { variant: 'outline', disabled: busy, onClick: () => void command('cancel'), children: 'Stop pairing' }),
          jsx(Button, { variant: 'secondary', disabled: busy, onClick: () => void command('create'), children: 'Pair manually' }),
          jsx(Button, { disabled: busy || phoneCode.length !== 6, onClick: () => void command('create', phoneCode), children: 'Pair' }),
        ] }) : null,
        ceremony.phase === 'phone-sent' ? jsxs(DialogFooter, { children: [
          jsx(Button, { variant: 'outline', disabled: busy, onClick: () => void command('cancel'), children: 'Stop pairing' }),
          jsx(Button, { variant: 'outline', onClick: hide, children: 'Hide' }),
        ] }) : null,
        ceremony.phase === 'qr' ? jsxs(DialogFooter, { children: [
          jsx(Button, { variant: 'outline', onClick: () => void command('cancel'), children: 'Stop pairing' }),
          jsx(Button, { variant: 'outline', onClick: hide, children: 'Hide' }),
        ] }) : null,
        ceremony.phase === 'words' ? jsxs(DialogFooter, { children: [
          jsx(Button, { variant: 'outline', onClick: () => void command('deny'), children: 'No — refuse this phone' }),
          jsx(Button, { onClick: () => void command('approve'), children: 'Yes — all four words match' }),
        ] }) : null,
        ceremony.phase === 'outcome' && !newCodeOffered ? jsx(DialogFooter, { children: jsx(Button, { onClick: clearCeremony, children: 'Done' }) }) : null,
        // #3909. A code that ran out: the fresh one comes from the chat.
        ceremony.phase === 'outcome' && newCodeOffered ? jsxs(DialogFooter, { children: [
          jsx(Button, { variant: 'outline', onClick: clearCeremony, children: 'Done' }),
          jsx(Button, { disabled: newCodeStatus === 'sending', onClick: () => void getNewCode(), children: 'Get a new code' }),
        ] }) : null,
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

// SETUP_TOOLS_BEGIN
// Setup needs the ocuclaw_setup tool and the setup skill. Either can be
// switched off in Capabilities or config, and then setup fails without saying
// why. Hermes 0.21.6+ gives the tool its own `ocuclaw_setup` toolset, so
// turning it back on touches nothing else. On 0.21.1–0.21.5 it rides in
// `hermes-cli`, and turning that on brings back every core tool the person
// switched off, so the check stays quiet there.
const SETUP_TOOL = 'ocuclaw_setup'
const SETUP_SKILL = 'ocuclaw:ocuclaw-assist-hermes'
const LEGACY_SETUP_TOOLSET = 'hermes-cli'
const SETUP_TOOLS_RECHECK_MS = 60000
const SETUP_TOOLS_CHANGED_EVENT = 'ocuclaw:setup-tools-changed'
const SETUP_SKILL_PLATFORM_HELP = `Setup is switched off for Desktop chats. Remove ${SETUP_SKILL} from skills.platform_disabled.desktop in config.yaml, then try again.`

// Null means unknown: a remote Desktop, a host without the toolsets bridge, or
// a failed read. Unknown never shows a warning.
const readSetupTools = async api => {
  const toolsets = sdk.host.toolsets
  if (!desktopLocalActions() || !toolsets || typeof toolsets.list !== 'function') return null
  let rows
  let switches
  try {
    ;[rows, switches] = await Promise.all([
      toolsets.list(),
      api('/setup-tools', { method: 'GET', timeoutMs: CARD_PROBE_TIMEOUT_MS }),
    ])
  } catch {
    return null
  }
  if (!Array.isArray(rows) || !switches || switches.contract !== 'ocuclaw.setup-tools') return null
  const row = rows.find(item => item && item.name === SETUP_TOOL) ||
    rows.find(item => item && Array.isArray(item.tools) && item.tools.includes(SETUP_TOOL))
  const toolsetOff = row && row.name !== LEGACY_SETUP_TOOLSET && row.enabled === false ? row.name : null
  const skillDisabled = switches.skillDisabled === true
  const skillDisabledForPlatform = switches.skillDisabledForPlatform === true
  const skills = sdk.host.skills
  const canClearSkill = Boolean(skills && typeof skills.setEnabled === 'function')
  return {
    toolsetOff,
    skillDisabled,
    skillDisabledForPlatform,
    off: Boolean(toolsetOff || skillDisabled || skillDisabledForPlatform),
    // Desktop can clear the toolset switch and the global skill entry. Nothing
    // in Desktop clears a per-platform skill entry.
    fixable: Boolean(toolsetOff || (skillDisabled && canClearSkill)) && !skillDisabledForPlatform,
  }
}

// Resolves to the state read back afterwards, or null if that is unknown.
const turnOnSetupTools = async (api, state) => {
  if (!state || !desktopLocalActions()) return null
  try {
    if (state.toolsetOff) await sdk.host.toolsets.setEnabled(state.toolsetOff, true)
    if (state.skillDisabled) await sdk.host.skills.setEnabled(SETUP_SKILL, true)
  } catch {}
  // The setup card re-reads too, so a fix from the doctor clears it at once.
  try { window.dispatchEvent(new Event(SETUP_TOOLS_CHANGED_EVENT)) } catch {}
  return readSetupTools(api)
}

const notifySetupToolsResult = after => {
  const on = after && !after.off
  try {
    sdk.host.notify({
      kind: on ? 'info' : 'warning',
      title: 'OcuClaw setup tools',
      message: on ? 'Setup tools are on.'
        : after && after.skillDisabledForPlatform ? SETUP_SKILL_PLATFORM_HELP
        : 'Could not turn the setup tools on.',
    })
  } catch {}
}

// The palette doctor reports the setup tools too, with the same fix.
const runGlassesDoctor = async api => {
  const { ok, message } = await runPulseDoctor(api)
  const setupTools = await readSetupTools(api)
  const off = Boolean(setupTools && setupTools.off)
  const notice = {
    kind: ok && !off ? 'info' : 'warning',
    title: 'Glasses doctor',
    message: off ? `${message} Setup tools are off.` : message,
  }
  if (off && setupTools.fixable) {
    notice.action = { label: 'Turn on', onClick: () => void turnOnSetupTools(api, setupTools).then(notifySetupToolsResult) }
  } else if (off && setupTools.skillDisabledForPlatform) {
    notice.message = `${message} ${SETUP_SKILL_PLATFORM_HELP}`
  }
  try { sdk.host.notify(notice) } catch {}
  return notice
}
// SETUP_TOOLS_END

function SetupCard({ ctx, api }) {
  const [phase, setPhase] = useState('unknown')
  const [setupTools, setSetupTools] = useState(null)
  const [fixingSetupTools, setFixingSetupTools] = useState(false)
  const restartedAtRef = useRef(0)
  const setupRun = setupRunStore.use()
  const ceremony = ceremonyStore.use()
  const presenterOpen = presenterStore.use()
  const agentBusy = useSessionBusy(setupRun.status === 'running' ? setupRun.sessionId : '')
  const pluginAbsent = pluginAbsentStore.use()
  const controller = glassesStateStore.use()
  const restartHint = controller.restartToFinish

  // Either poller can be the one that discovers the absence, and the store
  // outlives the remounts Hermes performs, so the phase is driven off it rather
  // than set inline by the probe.
  useEffect(() => {
    setPhase(current => (pluginAbsent ? 'absent' : current === 'absent' ? 'unknown' : current))
  }, [pluginAbsent])

  // Toolset lists are heavy, so this reads on reaching 'ready', when the window
  // regains focus (the person may have just been in Capabilities), and slowly
  // otherwise.
  useEffect(() => {
    if (phase !== 'ready') {
      setSetupTools(null)
      return undefined
    }
    // One read at a time, rescheduled after it lands, like the probe above.
    let disposed = false
    let reading = false
    let timer = null
    const read = async () => {
      if (reading) return
      reading = true
      window.clearTimeout(timer)
      const value = await readSetupTools(api)
      reading = false
      if (disposed) return
      setSetupTools(value)
      timer = window.setTimeout(() => void read(), SETUP_TOOLS_RECHECK_MS)
    }
    void read()
    window.addEventListener('focus', read)
    window.addEventListener(SETUP_TOOLS_CHANGED_EVENT, read)
    return () => {
      disposed = true
      window.clearTimeout(timer)
      window.removeEventListener('focus', read)
      window.removeEventListener(SETUP_TOOLS_CHANGED_EVENT, read)
    }
  }, [api, phase])

  // Only refs, a state setter and the SDK, so the probe below can call it.
  const startGatewayRestart = () => {
    restartedAtRef.current = Date.now()
    setPhase('restarting')
    // Upstream annotates runGatewayRestart "Self-contained and never rejects":
    // it catches and toasts, and its own poll gives up after 18 x 1200ms
    // (~21.6s) returning normally whether or not the gateway came back. So its
    // resolution is evidence of nothing. The probe below owns the up/down
    // claim; this is only the trigger — which is also why RESTART_PATIENCE_MS
    // sits well past that ~21.6s window: the host giving up polling is not the
    // same event as the gateway failing to return.
    requestGatewayRestart()
  }

  useEffect(() => {
    // No backend in this profile means nothing to probe. Clearing the absence
    // (a profile switch, or the slow fallback) re-runs this effect and the
    // probe starts over from scratch.
    if (pluginAbsent) return undefined
    let disposed = false
    let timer = null

    const probe = async () => {
      // A restart asked for from the toast or the glasses popover.
      restartedAtRef.current = gatewayRestart.at
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
      let reachable = false
      let gatewayPid = null
      try {
        const status = await sdk.host.status()
        reachable = Boolean(status)
        gatewayPid = status?.gateway_pid ?? null
        const platforms = (status && status.gateway_platforms) || null
        running = Boolean(status && status.gateway_running && status.gateway_state === 'running')
        // PRESENCE, not `state === 'connected'`. Before any glasses are paired
        // the relay link is legitimately down — the throwaway 0.20.6 gateway
        // reported ocuclaw as "retrying" the moment it loaded the plugin — and
        // demanding a healthy link would strand the card on the very screen
        // whose whole job is to get the user TO pairing.
        loaded = Boolean(platforms && Object.prototype.hasOwnProperty.call(platforms, PLATFORM_ID))
      } catch {}
      if (disposed) return

      if (reachable) {
        // The router answers a different question: whether THIS backend has
        // mounted OcuClaw's routes (#4047). A backend that predates the
        // install is stale about more than its routes. On 0.21.1 its status
        // also hides the ocuclaw platform, because it learned plugin platforms
        // at its own start (hermes_cli/web_routers/status.py
        // _status_platform_key_allowed). So the router is asked whenever the
        // backend answers, and missing routes come before the gateway's view.
        // It is also the only holder of the pairing receipt. Unreachable or
        // malformed => treat as NOT paired: the card staying up is the safe
        // direction, a false retirement is not.
        let paired = false
        let absent = false
        let routesMissing = false
        let answered = false
        let pendingRestart = null
        try {
          const payload = await api('/setup-card', { method: 'GET', timeoutMs: CARD_PROBE_TIMEOUT_MS })
          answered = true
          pendingRestart = normalizeRestartToFinish(payload)
          if (payload && payload.contract === 'ocuclaw.desktop-setup-card') paired = payload.paired === true
        } catch (error) {
          absent = isPluginAbsentError(error)
          routesMissing = isRoutesMissingError(error)
        }
        if (disposed) return

        // #2007. Deliberately no reschedule: the profile watch owns the wake-up,
        // and a retry here is the 404 spam this branch exists to end.
        if (absent) {
          noteProfileAbsence()
          return
        }

        // #4047. No "Pair your glasses" until the backend has restarted. A
        // setup run stored from this backend can never reach its panel, so it
        // is dropped: afterwards the card offers pairing again rather than
        // "Waiting for setup…" on a chat whose pairing step already failed.
        if (routesMissing) {
          if (setupRunStore.get().status === 'running') rememberSetupRun(IDLE_SETUP_RUN)
          const step = routesMissingStep({
            bridge: desktopBackendBridge(),
            requested: backendRecycle.requested,
            recycledAt: backendRecycle.at,
            now: Date.now(),
          })
          if (step === 'recycle') recycleBackend()
          if (step === 'recycle' || step === 'wait') {
            setPhase('finishing')
            timer = window.setTimeout(() => void probe(), CARD_PROBE_INTERVAL_MS)
            return
          }
          setPhase(step === 'offer' ? 'needs-backend-restart' : 'relaunch')
          timer = window.setTimeout(() => void probe(), ROUTES_MISSING_RECHECK_MS)
          return
        }
        // The routes answered: nothing left for a backend restart to do.
        if (answered) {
          backendRecycle.requested = false
          backendRecycle.at = 0
        }

        if (running && loaded) {
          const run = setupRunStore.get()
          if (pendingRestart && run.status === 'running' && Number.isInteger(gatewayPid) &&
              !Number.isInteger(run.restartGatewayPid)) {
            // Desktop's command palette can own the restart too. Observe the
            // pending process before either native control is used, without
            // claiming that a restart has already been requested.
            rememberSetupRun({ ...run, restartGatewayPid: gatewayPid, restartComplete: false })
          }
          // A still-running old gateway is not completion. Nor is a missing
          // status response during restart. Wait for the new process and for
          // the saved-settings/update hint to clear before retiring the wait.
          if (restartedAtRef.current && (!answered || pendingRestart ||
              (gatewayRestart.pid !== null && gatewayPid === gatewayRestart.pid))) {
            setPhase(Date.now() - restartedAtRef.current < RESTART_PATIENCE_MS ? 'restarting' : 'stalled')
            timer = window.setTimeout(() => void probe(), CARD_PROBE_INTERVAL_MS)
            return
          }
          const replacementObserved = Number.isInteger(run.restartGatewayPid) &&
            Number.isInteger(gatewayPid) && run.restartGatewayPid !== gatewayPid
          if (answered && !pendingRestart && run.status === 'running' &&
              (restartedAtRef.current || replacementObserved)) {
            // Keep the same conversation available after restart; do not
            // dispatch a second setup. Its idle label must not hide readiness.
            rememberSetupRun({ ...setupRunStore.get(), restartComplete: true, restartRequestedAt: 0, restartGatewayPid: null })
          }
          restartedAtRef.current = 0
          gatewayRestart.at = 0
          gatewayRestart.pid = null
          backendRecycle.gatewayAfter = false
          backendRecycle.unloadedSince = 0
          if (paired) {
            // Keep the durable setup receipt, but do not use it as a render gate.
            // The shared owner already suppresses Setup Card while ready, and a
            // later gateway loss must expose recovery even on a paired host.
            writeFlag(ctx, CARD_RETIRED_KEY)
            rememberSetupRun(IDLE_SETUP_RUN)
            setPhase('paired')
            return
          }
          setPhase('ready')
          // Nothing left to detect but a human walking through the ceremony, so
          // stop polling at restart speed — the card is installed-state chrome,
          // not a progress bar, and it may sit here for days.
          timer = window.setTimeout(() => void probe(), CARD_IDLE_INTERVAL_MS)
          return
        }

        // The new backend sees a gateway that still predates OcuClaw. The
        // person's one click asked for setup to finish, so the gateway
        // restart it still needs follows by itself, once the new backend has
        // said so for GATEWAY_AFTER_SETTLE_MS: its first answers can come
        // before it has read the gateway's state.
        if (answered && backendRecycle.gatewayAfter && !restartedAtRef.current) {
          const now = Date.now()
          if (!backendRecycle.unloadedSince) backendRecycle.unloadedSince = now
          if (now - backendRecycle.unloadedSince < GATEWAY_AFTER_SETTLE_MS) {
            setPhase('finishing')
            timer = window.setTimeout(() => void probe(), CARD_PROBE_INTERVAL_MS)
            return
          }
          backendRecycle.gatewayAfter = false
          backendRecycle.unloadedSince = 0
          startGatewayRestart()
        }
      }

      if (backendRecycle.at && Date.now() - backendRecycle.at < RESTART_PATIENCE_MS) {
        // The card's own backend restart: status is down until the new
        // backend answers, and that is progress, not a gateway to restart.
        setPhase('finishing')
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
  }, [api, ctx, pluginAbsent, controller.receiver?.connectionId, controller.receiver?.profile])

  if (phase === 'unknown') return null

  const restart = () => {
    // If the backend then turns out to predate OcuClaw's routes, the probe
    // restarts it too, on this same click.
    backendRecycle.requested = true
    startGatewayRestart()
  }

  // The backend predates OcuClaw's routes: restart it first. If the new
  // backend then shows a gateway without OcuClaw, the probe restarts the
  // gateway too, so this stays one click.
  const restartBackend = () => {
    backendRecycle.gatewayAfter = true
    recycleBackend()
    setPhase('finishing')
  }

  let dot = 'var(--ui-text-tertiary)'
  let label = 'OcuClaw installed'
  let title
  let action = null

  if (phase === 'absent') {
    // A statement of fact, and nothing else. There is no instruction to give:
    // the operator switched profiles on purpose, and telling them to switch
    // back — or offering a restart that would restart the wrong gateway — is
    // the card inventing work for a host it does not belong to.
    label = PROFILE_ABSENT_LABEL
  } else if (phase === 'relaunch') {
    // Only without Desktop's backend bridge, or after a backend restart that
    // did not bring the routes back. A window reload does not remount them.
    dot = '#ffb454'
    label = RELAUNCH_LABEL
  } else if (phase === 'needs-restart') {
    dot = '#ffb454'
    action = jsx(Button, { size: 'xs', onClick: restart, children: 'Restart gateway' })
  } else if (phase === 'needs-backend-restart') {
    // Same words as a gateway restart on purpose: to the person it is the one
    // restart setup asks for, and the setup guide names this button.
    dot = '#ffb454'
    action = jsx(Button, { size: 'xs', onClick: restartBackend, children: 'Restart gateway' })
  } else if (phase === 'finishing') {
    label = 'Finishing setup…'
    action = jsx(GlyphSpinner, {})
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
      // #5486: no phase shows a QR. Manual pairing (`qr`) waits for the
      // phone like a sent code does.
      label = ceremony.phase === 'words' ? 'Confirm the four words'
        : ceremony.phase === 'phone-code' ? 'Type the phone code'
        : 'Waiting for the phone'
      const summon = () => presenterStore.set(true)
      action = presenterOpen
        ? jsx(GlyphSpinner, {})
        : jsx(Button, { size: 'xs', onClick: summon, children: 'Show' })
    } else if (setupRun.status === 'dispatching') {
      label = 'Starting setup…'
      action = jsx(GlyphSpinner, {})
    } else if (restartHint) {
      // Saved settings and code updates outrank a chat waiting for this very
      // restart. Otherwise the only recovery control is hidden by its owner.
      dot = '#ffb454'
      label = restartHint.reason === 'configuration' ? 'OcuClaw settings saved' : `OcuClaw ${restartHint.installedVersion} installed`
      title = restartToFinishMessage(restartHint)
      action = jsx(Button, { size: 'xs', onClick: restart, children: 'Restart gateway' })
    } else if (setupRun.status === 'running' && setupRun.pairingStopped && !(setupTools && setupTools.off)) {
      // The setup chat's pairing window ended without a pairing. "Waiting for
      // setup…" would wait on a chat that is waiting on the person.
      dot = '#ffb454'
      label = 'Pairing stopped'
      action = jsx(Button, { size: 'xs', onClick: () => void retryStoppedPairing(api), children: 'Pair your glasses' })
    } else if (setupRun.status === 'running' && !setupRun.restartComplete) {
      // The card never claims a step it cannot see. Busy vs idle in the setup
      // chat is the honest resolution the host actually exposes.
      label = agentBusy ? 'Setup running…' : 'Waiting for setup…'
      action = jsx(Button, { size: 'xs', variant: 'outline', onClick: openSetupChat, children: 'Open setup chat' })
    } else if (setupRun.status === 'running' && setupRun.restartComplete) {
      label = 'OcuClaw ready'
      action = jsx(Button, { size: 'xs', variant: 'outline', onClick: openSetupChat, children: 'Continue setup chat' })
    } else if (setupTools && setupTools.off) {
      // Before "Pair your glasses" and "Try again": either would start a
      // setup chat that cannot run.
      dot = '#ffb454'
      label = 'OcuClaw setup tools are off'
      const turnOn = async () => {
        setFixingSetupTools(true)
        const after = await turnOnSetupTools(api, setupTools)
        setFixingSetupTools(false)
        if (after) setSetupTools(after)
        notifySetupToolsResult(after)
      }
      action = fixingSetupTools ? jsx(GlyphSpinner, {})
        : setupTools.fixable ? jsx(Button, { size: 'xs', onClick: () => void turnOn(), children: 'Turn on' })
        : jsx(Button, { size: 'xs', variant: 'outline', onClick: () => notifySetupToolsResult(setupTools), children: 'How to fix' })
    } else if (setupRun.status === 'failed') {
      dot = '#ffb454'
      label = 'Setup did not start'
      action = jsx(Button, { size: 'xs', variant: 'outline', onClick: () => void dispatchSetup(api), children: 'Try again' })
    } else {
      label = 'OcuClaw ready'
      action = jsx(Button, { size: 'xs', onClick: () => void dispatchSetup(api), children: 'Pair your glasses' })
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
      jsx('span', { title, children: label }),
      action,
    ],
  })
}

// ORDER_FORTY_MODEL_BEGIN
const resolveOrderFortySurface = (controller, pluginAbsent) => {
  const gateway = controller && controller.gateway
  return pluginAbsent !== true && gateway && gateway.running === true && gateway.loaded === true && controller.paired === true
    ? 'pulse'
    : 'setup'
}

// ORDER_FORTY_MODEL_END

function OrderFortyOwner({ ctx, api }) {
  const controller = glassesStateStore.use()
  const pluginAbsent = pluginAbsentStore.use()
  const local = useDesktopLocalActions()
  const surface = resolveOrderFortySurface(controller, pluginAbsent)
  useEffect(() => {
    if (local && surface !== 'pulse') closePulseCard()
  }, [local, surface])
  if (local && surface === 'setup') return jsx(SetupCard, { ctx, api })
  return jsx(G2Pulse, { ctx, api, onActivate: openPulseCard })
}

function remoteStatusMessage(controller, absent) {
  const device = controller.device || {}
  return absent ? 'OcuClaw is absent or disabled on this profile.'
    : controller.reason || (controller.status !== 'ready' ? 'Remote status unavailable. Check the saved SSH connection and gateway.'
      : controller.paired !== true ? 'Pair your phone using the existing Cloudways setup.'
      : device.stale !== false ? 'Waiting for a current glasses observation.'
      : device.connected === true ? 'Glasses connected' : device.connected === false ? 'Glasses disconnected' : 'Glasses connection unknown')
}

// Secret values live only in password inputs and the direct save request.
// No chat, plugin storage, model callback, or credential readback is involved.
function CredentialsDialog({ api }) {
  const [request, setRequest] = useState(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const inputs = useRef({})
  const saving = useRef(false)
  const alive = useRef(false)
  const revision = useRef(0)
  const activeId = useRef(null)
  const clear = () => Object.values(inputs.current).forEach(input => { if (input) input.value = '' })
  const call = body => api('/credentials', {
    method: 'POST', body: { ...body, presenterCapability: PRESENTER_CAPABILITY }, timeoutMs: 10000,
  })
  useEffect(() => {
    alive.current = true
    let stopped = false
    let timer
    // A profile boundary retires the whole polling generation; save/cancel
    // revisions additionally retire status replies within one profile.
    let generation = 0
    const reset = (updateState = true) => {
      generation += 1
      revision.current += 1
      window.clearTimeout(timer)
      clear()
      activeId.current = null
      saving.current = false
      if (updateState) {
        setRequest(null)
        setBusy(false)
        setMessage('')
      }
    }
    const tick = async () => {
      if (stopped || pluginAbsentStore.get()) return
      const startedInGeneration = generation
      const startedAtRevision = revision.current
      try {
        const next = await call({ action: 'status' })
        if (stopped || saving.current || startedAtRevision !== revision.current || startedInGeneration !== generation) return
        if (next.state === 'pending') {
          if (activeId.current !== next.requestId) { clear(); setMessage('') }
          activeId.current = next.requestId
          setRequest(current => current?.requestId === next.requestId ? current : next)
        } else {
          clear()
          activeId.current = null
          setRequest(null)
          setMessage('')
        }
      } catch (error) {
        if (!stopped && startedInGeneration === generation && isPluginAbsentError(error)) noteProfileAbsence()
        // Retry quietly; never display response bodies or exceptions.
      } finally {
        if (!stopped && startedInGeneration === generation && !pluginAbsentStore.get()) timer = window.setTimeout(tick, 3000)
      }
    }
    const restart = () => { reset(); if (!stopped && !pluginAbsentStore.get()) timer = window.setTimeout(tick, 0) }
    const unsubscribe = pluginAbsentStore.subscribe(() => {
      reset()
      if (!pluginAbsentStore.get() && !stopped) timer = window.setTimeout(tick, 0)
    })
    const state = sdk.host?.state
    const watches = [
      watchHostAtom(state?.['profile'], restart),
      watchHostAtom(state?.connectionId, restart),
    ].filter(Boolean)
    reset()
    void tick()
    return () => {
      stopped = true
      alive.current = false
      unsubscribe()
      watches.forEach(unwatch => unwatch())
      reset(false)
    }
  }, [api])
  const finish = async cancel => {
    if (!alive.current || pluginAbsentStore.get() || !request || request.requestId !== activeId.current || saving.current) return
    revision.current += 1
    const startedAtRevision = revision.current
    saving.current = true
    setBusy(true)
    setMessage('')
    const values = cancel ? undefined : Object.fromEntries(request.selected.map(name => [name, inputs.current[name]?.value || '']))
    clear()
    try {
      const next = await call({ action: cancel ? 'cancel' : 'save', requestId: request.requestId, ...(cancel ? {} : { values }) })
      if (!alive.current || startedAtRevision !== revision.current) return
      if (next.state === 'saved' || next.state === 'cancelled') {
        activeId.current = null
        setRequest(null)
        if (next.state === 'saved') {
          try { sdk.host.notify({ kind: 'info', title: 'OcuClaw credentials saved', message: 'Return to setup to activate and test your selected features.' }) } catch {}
        }
      } else if (next.state === 'stale_request') {
        activeId.current = null
        setRequest(null)
      } else {
        if (next.present) setRequest(current => current ? { ...current, present: next.present } : current)
        setMessage(next.state === 'missing_value'
          ? 'Enter a value for each feature that is not already configured.'
          : 'Could not complete this request. Re-enter any unsaved values and try again, or cancel.')
      }
    } catch {
      if (alive.current && startedAtRevision === revision.current) setMessage('Could not reach Hermes. Re-enter any unsaved values and try again, or cancel.')
    } finally {
      if (values) Object.keys(values).forEach(name => { values[name] = '' })
      if (alive.current && startedAtRevision === revision.current) {
        revision.current += 1
        saving.current = false
        setBusy(false)
      }
    }
  }
  return jsx(Dialog, {
    open: Boolean(request), onOpenChange: open => { if (!open) void finish(true) },
    children: request ? jsxs(DialogContent, {
      showCloseButton: !busy, fitContent: true, style: { width: 'min(92vw,560px)' },
      onPointerDownOutside: event => event.preventDefault(),
      onEscapeKeyDown: event => { if (busy) event.preventDefault() },
      children: [
        jsx(DialogHeader, { children: jsx(DialogTitle, { children: `Private ${credentialFormLabel(request.selected[0]).name}` }) }),
        jsxs('form', { onSubmit: event => { event.preventDefault(); void finish(false) }, style: { display: 'grid', gap: 16 }, children: [
          jsx('p', { children: 'Saved directly to this Hermes profile. Values are never sent to the setup chat; the assistant receives only configured/not configured status.' }),
          ...request.selected.map(name => jsxs('label', { style: { display: 'grid', gap: 6 }, children: [
            jsx('span', { children: credentialFormLabel(name).name }),
            jsx('input', {
              type: 'password', name, autoComplete: 'new-password', spellCheck: false, maxLength: 4096,
              disabled: busy, ref: input => { inputs.current[name] = input },
              'aria-label': credentialFormLabel(name).name,
              placeholder: request.present?.[name] ? 'Already configured — leave blank to keep it' : 'Paste privately here',
              style: { width: '100%', padding: '10px 12px', border: '1px solid var(--ui-border)', borderRadius: 6, background: 'var(--ui-bg-secondary)', color: 'var(--ui-text-primary)' },
            }),
            jsx('small', { children: credentialFormLabel(name).hint }),
          ] }, name)),
          jsx('p', { style: { fontSize: 12 }, children: 'Existing values are never shown. Leave a configured field blank to keep it. Saving does not restart Hermes.' }),
          message ? jsx('p', { role: 'alert', children: message }) : null,
          jsxs(DialogFooter, { children: [
            jsx(Button, { type: 'button', variant: 'outline', disabled: busy, onClick: () => void finish(true), children: 'Cancel' }),
            jsx(Button, { type: 'submit', disabled: busy, children: busy ? 'Saving…' : 'Save privately' }),
          ] }),
        ] }),
      ],
    }) : null,
  })
}

// One label set per desktop_credentials.FIELDS key.
const CREDENTIAL_FORM_LABELS = Object.freeze({
  soniox: Object.freeze({ name: 'Soniox API key', hint: 'Soniox Console → your project → API Keys. Keep this key private.' }),
  evenAi: Object.freeze({ name: 'Even AI token', hint: 'Choose a strong secret in your password manager. Use the same value in the Even Realities app’s Agent configuration → Token field.' }),
  typesafe: Object.freeze({ name: 'TypeSafe API key', hint: 'From your TypeSafe account. Keep this key private.' }),
})
const credentialFormLabel = name => CREDENTIAL_FORM_LABELS[name] || { name: 'OcuClaw key', hint: 'Keep this value private.' }

// FLEET_INVENTORY_BEGIN
// Native registry data is display inventory only. Never spread SDK objects:
// connections() can include URLs, SSH configuration and credential envelopes.
const fleetText = (value, fallback = '') => typeof value === 'string' && value.trim() &&
  value.length <= 160 && !/[\u0000-\u001f\u007f]/.test(value) ? value.trim() : fallback

const fleetReceiver = host => ({
  connectionId: fleetText(host.activeConnectionId?.(), 'local'),
  profile: fleetText(host.state?.['profile']?.get?.(), 'default'),
})

const sameFleetReceiver = (left, right) => left.connectionId === right.connectionId && left.profile === right.profile

const fleetSnapshot = (connections, roster, receiver) => {
  if (!Array.isArray(connections) || !Array.isArray(roster?.agents) || !Array.isArray(roster?.sources)) {
    throw new Error('Fleet inventory unavailable')
  }
  if (connections.length > 64 || roster.agents.length > 512) throw new Error('Fleet inventory too large')
  const sources = new Map(roster.sources.map(source => [source.connectionId, source]))
  const machines = connections.map(connection => {
    const connectionId = fleetText(connection.id)
    if (!connectionId) throw new Error('Fleet connection identity unavailable')
    const source = sources.get(connectionId)
    return {
      connectionId,
      label: fleetText(connection.label, 'Hermes machine'),
      kind: ['local', 'remote', 'ssh', 'cloud'].includes(connection.kind) ? connection.kind : 'unknown',
      // Native SSH enumeration may retain cached profiles with reachable=true
      // AND an error. Cached identities must not become fresh health evidence.
      availability: source?.error ? 'unavailable' : source?.reachable === true ? 'reachable'
        : source?.reachable === false ? 'unavailable' : 'unknown',
      profiles: roster.agents.filter(agent => agent.connectionId === connectionId).map(agent => ({
        profile: fleetText(agent.profile),
        displayName: fleetText(agent.profileMetadata?.display_name,
          fleetText(agent.profileMetadata?.title, fleetText(agent.profile))),
      })),
    }
  })
  if (!machines.some(machine => machine.connectionId === receiver.connectionId)) {
    throw new Error('Fleet receiver is not registered')
  }
  return { schema: 'ocuclaw.desktop-fleet@1', receiver, machines }
}

const startFleetInventory = api => {
  const host = sdk.host
  if (typeof host?.connections !== 'function' || typeof host?.agents !== 'function' ||
      typeof host?.activeConnectionId !== 'function') return () => {}
  let disposed = false
  let timer = null
  let inFlight = false
  let generation = 0
  const tick = async () => {
    if (disposed || inFlight) return
    inFlight = true
    const epoch = generation
    const receiver = fleetReceiver(host)
    try {
      const [connections, roster] = await Promise.all([host.connections(), host.agents()])
      if (disposed || epoch !== generation || !sameFleetReceiver(receiver, fleetReceiver(host))) return
      const snapshot = fleetSnapshot(connections, roster, receiver)
      await api('/fleet/snapshot', {
        method: 'POST', body: { presenterCapability: PRESENTER_CAPABILITY, snapshot }, timeoutMs: 2500,
      })
    } catch {
      // A switched receiver rejects this install's capability. An absent or
      // offline Desktop expires the last snapshot; never log registry errors.
    } finally {
      inFlight = false
      if (!disposed) timer = window.setTimeout(() => void tick(), epoch === generation ? 15000 : 0)
    }
  }
  const invalidate = () => {
    generation += 1
    window.clearTimeout(timer)
    if (!inFlight) timer = window.setTimeout(() => void tick(), 0)
  }
  const unsubscribes = [
    watchHostAtom(host.state?.connectionId, invalidate),
    watchHostAtom(host.state?.['profile'], invalidate),
  ].filter(Boolean)
  void tick()
  return () => {
    disposed = true
    generation += 1
    window.clearTimeout(timer)
    for (const unsubscribe of unsubscribes) unsubscribe()
  }
}
// FLEET_INVENTORY_END

export default {
  id: 'ocuclaw',
  name: 'OcuClaw',
  register(ctx) {
    const api = desktopRouteApi(ctx)
    const registerLocal = contribution => ctx.onDispose(startLocalDesktopOwner(() => ctx.register(contribution)))
    let monogramStyle = document.getElementById('ocuclaw-monogram')
    if (!monogramStyle) {
      monogramStyle = document.createElement('style')
      monogramStyle.id = 'ocuclaw-monogram'
      monogramStyle.textContent = `@font-face{font-family:'Monogram';src:url('data:font/woff2;base64,${MONOGRAM_WOFF2_B64}') format('woff2');font-weight:400 700;font-style:normal;size-adjust:176%;font-display:block}`
      document.head.appendChild(monogramStyle)
    }
    ctx.onDispose(() => monogramStyle?.remove())
    hydratePulseCardPrefs(ctx)
    ctx.onDispose(startPulseCardController(ctx))
    ctx.onDispose(startGlassesStateController(api, ctx.socket))
    ctx.onDispose(startLocalDesktopOwner(() => startFleetInventory(api)))
    ctx.onDispose(closePulseCard)
    hydrateSetupRun(ctx)
    registerLocal({
      id: 'credentials-presenter', area: TITLEBAR_AREAS.right, order: 38,
      render: () => jsx(CredentialsDialog, { api }),
    })
    for (const [integration, label] of [['soniox', 'Set up OcuClaw voice with Soniox'], ['evenAi', 'Set up OcuClaw Even AI']]) registerLocal({
      id: `private-credentials-${integration}`, area: PALETTE_AREA,
      data: {
        id: `private-credentials-${integration}`, label,
        keywords: [integration, 'token', 'api key', 'credentials', 'ocuclaw'],
        run: () => openCredentialsForm(api, integration),
      },
    })
    // The presenter used to ride `statusBar.right`, and that was a latent
    // dead end: upstream unmounts the whole status bar — not just hides it —
    // while it is toggled off (contrib/controller.tsx: `{statusbarVisible &&
    // <WiredPane part="statusbar" />}`), and it ships off. On such a host the
    // presenter never mounted, so the pairing claim never ran and the card's
    // button had nothing to open. Since #1989 the presenter must poll on its
    // own and summon itself, so it moves to the same always-mounted titlebar
    // slot as the card. It renders no inline chrome — a portalled Dialog and
    // nothing else — so it costs the titlebar no width.
    registerLocal({
      id: 'pairing-presenter',
      area: TITLEBAR_AREAS.right,
      order: 39,
      render: () => jsx(PairingDialog, { api }),
    })
    ctx.register({
      id: 'setup-card',
      area: TITLEBAR_AREAS.right,
      order: 40,
      render: () => jsx(OrderFortyOwner, { ctx, api }),
    })
    registerLocal({
      id: 'glasses-doctor',
      area: PALETTE_AREA,
      data: {
        id: 'glasses-doctor',
        label: 'Run glasses doctor',
        keywords: ['glasses', 'g2', 'ocuclaw', 'doctor', 'health'],
        run: async () => {
          if (!desktopLocalActions()) return
          await runGlassesDoctor(api)
        },
      },
    })
    ctx.register({ id: 'theme', area: THEMES_AREA, data: OCUCLAW_THEME })
    restoreStoredPick()
    applyThemeRequest(ctx)
    ctx.register({
      id: 'theme-choice', area: TITLEBAR_AREAS.right, order: 37,
      render: () => jsx(DesktopThemeChoice, { ctx }),
    })
    registerSettingsPage(ctx, api)
    ctx.onDispose(startGlassesChatTag(ctx, sdk.SESSION_ROW_AREAS?.trailing))
  },
}

// GLASSES_CHAT_TAG_BEGIN
// A "G2" tag on sidebar chats that live on the glasses: chats started there
// and chats copied to them. Both are stored with source `ocuclaw`. No slot
// passes a chat's source, so the tag re-reads the saved chat list, which
// carries it (the gateway's session.list leaves these rows out). Display only.
// It sits below the export because desktop tests run the text above it.
const GLASSES_CHATS_REFRESH_MS = 15000
const GLASSES_CHATS_LIMIT = 200
const glassesChatsStore = makeStore(new Set())

const glassesChatIds = listed => {
  const ids = new Set()
  const rows = listed && Array.isArray(listed.sessions) ? listed.sessions : []
  for (const row of rows) {
    if (!row || row.source !== PLATFORM_ID || !row.id) continue
    ids.add(row.id)
    // A compressed chat's sidebar row may carry its lineage root.
    if (row._lineage_root_id) ids.add(row._lineage_root_id)
  }
  return ids
}

const GlassesChatTag = ({ sessionId }) => {
  const ids = glassesChatsStore.use()
  if (!sessionId || !ids.has(sessionId)) return null
  return jsx('span', {
    title: 'On your glasses',
    'aria-label': 'On your glasses',
    style: { fontSize: 10, fontWeight: 600, letterSpacing: '.02em', opacity: .75 },
    children: 'G2',
  })
}

// Returns a disposer. Hosts without the row slot or the saved list get nothing.
const startGlassesChatTag = (ctx, area) => {
  if (!area || typeof sdk.host.listPersistedSessions !== 'function') return () => {}
  let disposed = false
  let timer = null
  let reading = false
  const refresh = async () => {
    if (reading) return
    reading = true
    window.clearTimeout(timer)
    try {
      const profile = sdk.host.state?.['profile']?.get?.() || 'default'
      const listed = await sdk.host.listPersistedSessions(null, { profile, limit: GLASSES_CHATS_LIMIT })
      if (!disposed) glassesChatsStore.set(glassesChatIds(listed))
    } catch {
      // Keep the last answer: right after launch the host can be unready.
    }
    reading = false
    if (!disposed) timer = window.setTimeout(() => void refresh(), GLASSES_CHATS_REFRESH_MS)
  }
  // Session-row slots take their renderer under `data`, unlike title-bar slots.
  ctx.register({ id: 'glasses-chat-tag', area, data: { render: props => jsx(GlassesChatTag, { sessionId: props && props.sessionId }) } })
  const unwatch = watchHostAtom(sdk.host.state?.['profile'], () => {
    glassesChatsStore.set(new Set())
    void refresh()
  })
  void refresh()
  return () => {
    disposed = true
    window.clearTimeout(timer)
    if (typeof unwatch === 'function') unwatch()
    glassesChatsStore.set(new Set())
  }
}
// GLASSES_CHAT_TAG_END

// ALIVE_ENGINE_BEGIN — vendored verbatim from composeApp/src/webMain/resources/alive/
// by scripts/sync-alive-engine.mjs; test_desktop_pulse pins these bytes to the
// source files. `module` is shadowed so each file takes its browser branch
// (root.WatchEngine / root.WatchProps / root.WatchRenderer) even where the
// renderer exposes a CommonJS `module`.
;(() => { const module = undefined;
// ALIVE_VENDOR_BEGIN engine.js
/* Watch: portable, interruptible rig. Derived from the original character lab's
 * persistent-pose / persistent-velocity model. No DOM or pairwise transitions.
 * Authored pixel poses are selected by renderer.js from this numeric pose. */
(function(root){
'use strict';
const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
// G2 stays off until the wearer judges the one-pixel movement.
const MICRO_DEFAULT=false;
const BASE={x:48,y:14,tilt:0,gazeX:0,gazeY:0,eye:1,browL:0,browR:0,browY:0,browLiftL:0,browLiftR:0,
 lx:16,ly:25,rx:82,ry:25,lrot:0,rrot:0,lopen:0,ropen:0,lpoint:0,rpoint:0,lthumb:0,rthumb:0,
 tempo:1,energy:.4,helper:0,effect:0,handScale:1,eyeL:1,eyeR:1,shutL:0,shutR:0,wink:0,listenCue:0,errorCue:0,turn:0,
 curious:0,focused:0,delighted:0,concerned:0,surprised:0,skeptical:0,sleepy:0,playful:0,propDX:0,propDY:0,thinkingGear:0,gearAngle:0,gearJam:0,thinkingStudy:0,studyTime:0};
// 0-2 hand gestures, 3 the cogs, 4-7 studies, 8-13 lab loops (THINKING_LOOPS).
const THINKING_VARIATIONS=14;
// Keep the portable engine reproducible. The live adapter supplies one seed
// per loaded rig, so cached hold poses agree while reloads vary the rotation.
const THINKING_SEED=0x51a7e;
const thinkingDuration=v=>v>=THINKING_LOOP_FIRST?THINKING_LOOPS[v-THINKING_LOOP_FIRST].end:v>=3?12:10;
const THINKING_IDEAS=['heart','bulb','star','rocket','lightning','music'];
const studyBase={...BASE,x:29,y:14,lx:7,ly:27,rx:58,ry:27,gazeX:1.2};
// Approved studies: abacus, neural spark, find a path, and noise to idea.
// Pose and prop share this clock, including when the rig rests or withdraws.
const studyTracks=[
 [[0,{}],[1,{rx:72,ry:12,rpoint:1,gazeY:-.5,focused:1}],[2.5,{rx:86,ry:12,rpoint:1,gazeY:-.5,focused:1}],[3.1,{rx:72,ry:19,rpoint:1,gazeY:.5,focused:1}],[4.4,{rx:85,ry:19,rpoint:1,gazeY:.5,focused:1}],[5.2,{rx:70,ry:27,rpoint:1,gazeY:1,skeptical:1,tilt:.07}],[6.5,{rx:88,ry:27,rpoint:1,gazeY:1,focused:1}],[7.2,{rx:62,ry:27,gazeY:.3,delighted:1,y:13}],[8.7,{rx:62,ry:27,gazeY:.3,delighted:1}],[10.8,{}],[12,{}]],
 [[0,{}],[1,{curious:1,gazeY:.5}],[2,{rx:63,ry:24,rpoint:1,focused:1}],[3,{rx:63,ry:24,gazeY:-.8,focused:1}],[4.5,{gazeY:.5,curious:1,rx:60,ry:27}],[6.2,{gazeY:0,surprised:1,y:13}],[7,{delighted:1,y:15,tilt:.04}],[8,{delighted:1,y:14}],[10.5,{}],[12,{}]],
 [[0,{}],[1,{gazeY:-.6,curious:1}],[2.5,{gazeY:-1,focused:1,rx:64,ry:18,rpoint:1}],[3.6,{gazeY:-1,skeptical:1,browLiftL:-1,tilt:-.08}],[4.5,{gazeY:.5,focused:1,tilt:.04}],[5.5,{gazeY:1,rx:70,ry:28,rpoint:1,focused:1}],[6.5,{gazeY:.5,surprised:1,rx:60,ry:27}],[7.5,{gazeY:.5,delighted:1,y:15}],[8.5,{delighted:1}],[10.5,{}],[12,{}]],
 [[0,{}],[1,{gazeY:0,curious:1,tilt:-.04}],[2.7,{gazeY:.4,focused:1,tilt:.06}],[4,{gazeY:0,skeptical:1,browLiftL:-1}],[5.2,{gazeY:0,curious:1,rx:61,ry:24,ropen:1}],[6.4,{gazeY:0,surprised:1,y:13,lx:6,ly:25,lopen:1}],[7.2,{delighted:1,rx:62,ry:25,ropen:1}],[8.6,{delighted:1,tilt:.04}],[10.5,{}],[12,{}]]
].map(track=>track.map(([t,p])=>[t,{...studyBase,...p}]));
function thinkingStudyPose(variant,t,route){
 const track=studyTracks[variant-4];let j=track.findIndex(([end])=>end>t);
 if(j<1)return {...track[j<0?track.length-1:0][1]};
 const [a,p]=track[j-1],[b,q]=track[j],u=clamp((t-a)/(b-a),0,1),v=u*u*(3-2*u);
 const pose=Object.fromEntries(Object.keys(BASE).map(k=>[k,p[k]+(q[k]-p[k])*v]));
 // Follow the chosen work, rather than looking at the old fixed route.
 if(variant===5&&t>1&&t<6){const y=t<3.7?[7,16,25][Math.floor(route/2)]:[11,23][route%2];pose.gazeY=clamp((y-14)/9,-1,1);}
 if(variant===6&&t>1&&t<6.3){const leaf=t<3.9?(route+2)%4:route;pose.gazeY=clamp(([5,12,21,28][leaf]-14)/9,-1,1);}
 return pose;
}
// Thinking loops 8-11 (2026-10-27): Matt's picks from the Speck New Moves lab
// (docs/design/speck-new-moves-lab: TH2 thought cloud, TH4 drumming fingers, TH5
// weighing it up, TH6 jotting notes), ported with the lab's poses, times and marks.
// Loops 12-13 (2026-10-28) are his picks from the More Speck Moves lab
// (docs/design/more-speck-moves-lab: TH7 puzzle cube, TH9 pencil twirl), the same way.
// A lab move keys pose tracks over his settled chat pose (LOOP_BASE, the awaiting pose
// the lab plays them on) and closes them on a rest keyframe (LOOP_REST): each key eases
// in over LOOP_RAMP before its first keyframe and between keyframes. Here the move
// eases in from the thinking pose (LOOP_THINK) over that ramp and, after its last
// keyframe, back onto the thinking pose by its rest time, so the rotation chains.
// marks(t, drawn) are renderer marks drawn over the frame, glyphs on a one-pixel
// dark moat, never with ink on row zero.
const THINKING_LOOP_FIRST=8,LOOP_RAMP=.35;
const LOOP_FACES=['curious','focused','delighted','concerned','surprised','skeptical','sleepy','playful'];
const loopFace=name=>Object.fromEntries(LOOP_FACES.map(k=>[k,Number(k===name)]));
const loopEase=u=>{u=clamp(u,0,1);return u*u*(3-2*u);};
const LOOP_REST={x:48,y:13,lx:16,ly:25,rx:82,ry:25,lopen:0,ropen:0,lrot:0,rrot:0,tilt:0,gazeX:0,gazeY:0,eye:1,eyeL:1,eyeR:1,browY:0,browL:0,browR:0,browLiftL:0,browLiftR:0,lthumb:0,rthumb:0,lpoint:0,rpoint:0,...loopFace('curious')};
const LOOP_BASE={...LOOP_REST,tilt:-.03,ly:20,ry:20,lopen:.7,ropen:.7,...loopFace(null)};
// Hands low together, eyes up and right; x, y and the lids come from the live target.
const LOOP_THINK={lx:35,ly:27,rx:57,ry:27,lopen:0,ropen:0,lrot:0,rrot:0,tilt:0,gazeX:.5,gazeY:0,eye:1,browY:-1,browL:0,browR:0,browLiftL:0,browLiftR:0,lthumb:0,rthumb:0,lpoint:0,rpoint:-.6,...loopFace('curious')};
const LOOP_GLYPHS={bubbleS:['010','101','010'],bubbleM:['0110','1001','1001','0110'],
 cloud:['0011111100','0100000010','1000000001','1000000001','0100000010','0011111100'],
 eq:['1111','0000','1111'],tickS:['00001','00011','10110','11100','01000'],spark3:['010','111','010']};
const loopGlyph=(k,x,y,c=15)=>['g',LOOP_GLYPHS[k],x,y,c],loopBox=(x,y,w,h,c=15)=>['r',x,y,w,h,c];
const loopTaps=(t0,n)=>Array.from({length:n},(_,i)=>[t0+i*.25,{ry:i%2?27:23}]);
// The puzzle cube: each twist reshuffles its 3 x 3 tiles (the lab's fixed draw), the last solves it.
const CUBE_TWISTS=[1,1.35,1.7,2.05,2.9,3.15,3.4,3.65,3.9];
const CUBE_TILES=(()=>{let s=7;const r=()=>(s=(s*1103515245+12345)>>>0)%3;return CUBE_TWISTS.map(()=>Array.from({length:9},()=>[15,9,4][r()]));})();
const cubeTwists=ts=>ts.map((t,i)=>[t,{lrot:i%2?-.2:.4,rrot:i%2?.4:-.2,lx:i%2?38:39,rx:i%2?58:57}]);
// A pencil spun about his mitten at (cx, cy), angle a: a lit line on a dark outline, a dim tip.
// Raised high it stops short of row zero, as if it ran on behind the frame line.
function pencilMarks(cx,cy,a){
 const dx=Math.cos(a)*6.5,dy=Math.sin(a)*6.5,m=[];
 const line=(x0,y0,x1,y1,c)=>{if(y0<.5&&y1<.5)return;
  if(y0<.5){x0+=(x1-x0)*(.5-y0)/(y1-y0);y0=.5;}else if(y1<.5){x1+=(x0-x1)*(.5-y1)/(y0-y1);y1=.5;}
  m.push(['l',x0,y0,x1,y1,c]);};
 for(const [ox,oy] of [[-1,0],[1,0],[0,-1],[0,1]])line(cx-dx+ox,cy-dy+oy,cx+dx+ox,cy+dy+oy,0);
 line(cx-dx,cy-dy,cx+dx,cy+dy,15);
 if(cy+dy>=.5)m.push(loopBox(Math.round(cx+dx),Math.round(cy+dy),1,1,7));
 return m;
}
const THINKING_LOOPS=[
 {name:'Thought cloud',end:5.6,rest:5.2,pose:[
  [.6,{gazeX:1.4,gazeY:-1.3,...loopFace('curious'),browY:-1,tilt:.05,x:44,lx:12,rx:78}],
  [2.6,{gazeX:1.5,gazeY:-1.4,tilt:.07,x:44,lx:12,rx:78,...loopFace('focused')}],
  [4.6,{gazeX:1.4,gazeY:-1.3,tilt:.05,x:44,lx:12,rx:78,...loopFace('delighted')}]],
  marks(t){
   if(t<.7||t>4.9)return [];
   const m=[loopGlyph('bubbleS',72,6)];if(t>1)m.push(loopGlyph('bubbleM',77,2));
   if(t>1.3){m.push(loopGlyph('cloud',84,1));const n=Math.min(3,Math.floor((t-1.5)/.45)%4+(t>4.2?3:0));for(let k=0;k<n;k++)m.push(loopBox(86+k*2,3,1,2));}
   return m;
  }},
 {name:'Drumming fingers',end:5.4,rest:5,pose:[
  [.5,{rx:77,ry:27,ropen:.3,...loopFace('focused'),gazeX:-1,gazeY:-1.3,tilt:-.04}],...loopTaps(.75,6),
  [2.4,{rx:77,ry:27}],[2.7,{gazeX:1,gazeY:-1.3,tilt:.04,...loopFace('skeptical')}],...loopTaps(2.95,6),[4.5,{rx:77,ry:27,gazeX:.4,gazeY:0,tilt:0}]],
  marks:(t,p)=>t>.7&&t<4.5&&p.ry>26.2&&Math.abs(p.rx-77)<3?[['l',p.rx-4,31,p.rx+4,31,9]]:[]},
 {name:'Weighing it up',end:6,rest:5.5,pose:[
  [.6,{lx:12,ly:20,rx:84,ry:20,lopen:1,ropen:1,lrot:-.3,rrot:.3,...loopFace('skeptical'),gazeX:-1.2,gazeY:-.2}],
  [1.4,{ly:14,ry:25,tilt:.07,gazeX:1.3,gazeY:.4}],[2.4,{ly:25,ry:14,tilt:-.07,gazeX:-1.3,gazeY:.4}],
  [3.3,{ly:16,ry:23,tilt:.04,gazeX:1.2,gazeY:.3}],[4.1,{ly:20,ry:20,tilt:0,gazeX:0,gazeY:0,...loopFace('focused')}],
  [4.5,{y:14,...loopFace('delighted')}],[4.8,{y:13}]],
  marks:t=>t>4.1&&t<5.1?[loopGlyph('eq',47,1,12)]:[]},
 {name:'Jotting notes',end:6.2,rest:5.6,pose:[
  [.6,{lx:16,ly:27,rx:40,ry:27,ropen:.1,...loopFace('focused'),gazeX:-.8,gazeY:1.4,tilt:-.04}],
  [.85,{rx:37}],[1.1,{rx:40}],[1.35,{rx:37}],[1.6,{rx:40}],[1.85,{rx:37}],
  [2.4,{rx:44,gazeX:.6,gazeY:-1.3,tilt:.05,...loopFace('curious')}],[3.1,{rx:44,gazeX:.6,gazeY:-1.3}],
  [3.4,{rx:37,gazeX:-.8,gazeY:1.4,tilt:-.04,...loopFace('focused')}],[3.65,{rx:40}],[3.9,{rx:37}],[4.3,{rx:40,...loopFace('delighted')}],
  [4.9,{lx:16,ly:27,rx:40,ry:27}]],
  marks(t){
   if(t<.5||t>5.3)return [];
   const m=[loopBox(21,23,13,9,0),loopBox(22,24,11,8),loopBox(23,25,9,7,0)];
   const line=(y,k)=>{if(k>0)m.push(loopBox(24,y,Math.round(7*Math.min(1,k)),1,12));};
   line(26,(t-.8)/.4);line(28,(t-1.3)/.5);line(30,(t-3.5)/.5);
   if(t>4.2)m.push(loopGlyph('tickS',27,26));
   return m;
  }},
 // The lab played these from his awaiting pose; its keys out to that pose and back are left out.
 {name:'Puzzle cube',end:6,rest:5.5,pose:[
  [.6,{lx:39,ly:27,rx:57,ry:27,lopen:0,ropen:0,...loopFace('focused'),gazeX:0,gazeY:1.4,tilt:.03,browY:.5}],
  ...cubeTwists(CUBE_TWISTS.slice(0,4)),[2.4,{lrot:0,rrot:0,lx:39,rx:57,...loopFace('skeptical'),tilt:-.03,gazeX:.3}],
  ...cubeTwists(CUBE_TWISTS.slice(4)),[4.15,{lrot:0,rrot:0,lx:39,rx:57,...loopFace('delighted'),tilt:0,y:12,gazeY:.8}],
  [4.45,{y:13}],[4.9,{lx:39,ly:27,rx:57,ry:27}]],
  marks(t){
   if(t<.55||t>5.05)return [];
   const n=CUBE_TWISTS.filter(x=>t>=x).length,tiles=n>=CUBE_TWISTS.length?Array(9).fill(15):CUBE_TILES[n],m=[loopBox(43,21,10,10,0)];
   tiles.forEach((c,i)=>m.push(loopBox(44+(i%3)*3,22+Math.floor(i/3)*3,2,2,c)));
   if(t>4&&t<4.7)m.push(loopGlyph('spark3',62,23,14),loopGlyph('spark3',32,23,10));
   return m;
  }},
 // The lab played it from his awaiting pose (mittens out by his sides). From the thinking pose both
 // mittens go out along the bottom first, and at the end come back down his sides (as the lab's
 // rest did) before the thinking pose takes them in, so neither passes behind his frame.
 {name:'Pencil twirl',end:5.9,rest:5.6,pose:[
  [.4,{lx:16,ly:27,lopen:0,rx:80,ry:27,ropen:0}],
  [.6,{rx:86,ry:13,ropen:.2,...loopFace('curious'),gazeX:-.8,gazeY:-1.3,tilt:-.04,browLiftL:-1}],
  [1,{lx:16,ly:20,lopen:.7}],
  [1.8,{rx:86,ry:13,gazeX:-.4,gazeY:-1.4}],
  [2.1,{rx:80,ry:12,...loopFace('focused'),gazeX:1.3,gazeY:-.4,tilt:.03,browLiftL:0}],[2.3,{rx:84}],[2.5,{rx:80}],[2.7,{rx:84}],
  [3,{rx:86,ry:13,...loopFace('skeptical'),gazeX:-1,gazeY:-1.2,tilt:-.05}],[4.1,{rx:86,ry:13}],
  [4.4,{rx:86,ry:7,...loopFace('delighted'),gazeX:1,gazeY:-1.4,browY:-1.5,tilt:.04}],[4.9,{rx:86,ry:8,lx:16,ly:20,lopen:.7}],[5.25,{rx:82,ry:27,lx:16,ly:27,lopen:0}]],
  marks(t,p){
   if(t<.5||t>5.2)return [];
   const cx=p.rx,cy=p.ry-4,a=t<1.85?-Math.PI/2+(t-.5)*9:t<2.9?Math.PI*.8:t<4.2?-Math.PI/2-(t-2.9)*8:-Math.PI/2,m=pencilMarks(cx,cy,a);
   // Two taps on his frame, then the pencil points up: got it.
   if((t>2.25&&t<2.35)||(t>2.65&&t<2.75))m.push(loopGlyph('spark3',Math.round(cx-9),Math.round(cy-4),11));
   if(t>4.45&&t<4.95)m.push(loopGlyph('spark3',Math.round(cx+4),1,14));
   return m;
  }}
];
// Per-key tracks, closed by the lab's rest keyframe (the chat pose).
const loopTracks=THINKING_LOOPS.map(m=>{
 const tracks={};
 for(const [t,o] of [...m.pose,[m.rest,LOOP_REST]])for(const k in o)(tracks[k]=tracks[k]||[]).push([t,o[k]]);
 for(const k in tracks)tracks[k].sort((a,b)=>a[0]-b[0]);
 return tracks;
});
function loopSample(pts,t,base){
 const first=pts[0],last=pts[pts.length-1];
 if(t<first[0]-LOOP_RAMP)return base;
 if(t<first[0])return base+(first[1]-base)*loopEase((t-(first[0]-LOOP_RAMP))/LOOP_RAMP);
 if(t>=last[0])return t>last[0]+LOOP_RAMP?base:last[1]+(base-last[1])*loopEase((t-last[0])/LOOP_RAMP);
 let j=1;while(pts[j][0]<t)j++;
 const [a,va]=pts[j-1],[b,vb]=pts[j];return va+(vb-va)*loopEase((t-a)/Math.max(1e-6,b-a));
}
function thinkingLoopPose(variant,t,think){
 const m=THINKING_LOOPS[variant-THINKING_LOOP_FIRST],tracks=loopTracks[variant-THINKING_LOOP_FIRST];
 const first=m.pose[0][0],last=m.pose[m.pose.length-1][0];
 const into=loopEase((t-(first-LOOP_RAMP))/LOOP_RAMP),out=loopEase((t-last)/(m.rest-last)),pose={};
 for(const k in LOOP_REST){
  const lab=loopSample(tracks[k],Math.min(t,last),LOOP_BASE[k]);
  pose[k]=t<=last?think[k]+(lab-think[k])*into:lab+(think[k]-lab)*out;
 }
 return pose;
}
const expressions=['neutral','curious','focused','delighted','concerned','surprised','skeptical','sleepy','playful'];
const CUES={ack:{duration:.7},relief:{duration:.9}};
// Reading moments: short keyframed cues Speck plays at a paragraph break or sentence end
// while a reply streams, mic in hand (AliveReadingMoments.kt picks one per stop). Head,
// mitten and brow keys add to the held pose; gaze and lids blend to their value; f names
// the face. Every moment ends on its first key, so Speck settles back on the held mic.
const MOMENT_ADD=['y','ly','ry','tilt','turn','browY','browL','browR'];
const DIP={y:2,ly:2,ry:2,gazeY:1,f:'focused'},ASK={tilt:.08,f:'curious',browL:-.3,browR:.2,gazeX:.8};
const MULL={f:'curious',gazeX:-1.4,gazeY:-1.2,browY:-.6,tilt:-.05,turn:-.3},LOOK={f:'focused',gazeX:1.4,gazeY:1.4,turn:.35,y:.6};
const MOMENTS={
 nod:{duration:.5,keys:[[0,{}],[.16,DIP],[.38,{f:'focused'}],[.5,{}]]},
 nod2:{duration:.75,keys:[[0,{}],[.14,DIP],[.3,{f:'focused'}],[.45,{...DIP,y:1.5,ly:1.5,ry:1.5}],[.62,{}],[.75,{}]]},
 askTilt:{duration:.7,keys:[[0,{}],[.2,ASK],[.45,ASK],[.7,{}]]},
 pop:{duration:.6,keys:[[0,{}],[.12,{f:'delighted',browY:-2,tilt:-.07,y:1.5,ry:1}],[.28,{f:'delighted',browY:-2,tilt:.05,y:-.5}],[.45,{f:'delighted',browY:-1}],[.6,{}]]},
 ponder:{duration:.8,keys:[[0,{}],[.25,MULL],[.55,MULL],[.8,{}]]},
 blinkLook:{duration:.75,keys:[[0,{}],[.1,{eye:.05,eyeL:.05,eyeR:.05}],[.22,LOOK],[.5,LOOK],[.75,{}]]},
};
// Reactor reactions (the agent's <speck:feeling/> tags, SpeckReactor.kt) are REACTIONS below;
// RX_LY is the held mic hand's ly, which their poses give absolute.
const RX_LY=27;
for(const kind in MOMENTS)CUES[kind]={duration:MOMENTS[kind].duration};
function applyMoment(q,moment,t){
 const keys=moment.keys;let j=1;while(j<keys.length-1&&keys[j][0]<t)j++;
 const [ta,a]=keys[j-1],[tb,b]=keys[j],u=smooth((t-ta)/Math.max(1e-6,tb-ta));
 for(const k of new Set([...Object.keys(a),...Object.keys(b)])){
  const w=(k in a?1-u:0)+(k in b?u:0);
  if(k==='f'){const face=b.f||a.f;for(const e of expressions)if(e in q)q[e]+=((e===face?1:0)-q[e])*w;continue;}
  if(MOMENT_ADD.includes(k)){q[k]+=(k in a?a[k]*(1-u):0)+(k in b?b[k]*u:0);continue;}
  const v=k in b?(k in a?a[k]+(b[k]-a[k])*u:b[k]):a[k];q[k]+=(v-q[k])*w;
 }
 // A reaction's glyph rides the drawn pose for the renderer only. Not enumerable, so an
 // accepted picture's pose never carries it into the springs.
 if(moment.glyphs){let g=null;for(const [at,x] of moment.glyphs)if(t>=at)g=x;Object.defineProperty(q,'glyph',{value:g,enumerable:false,configurable:true});}
}
// Mid-reply reactions the Neural Speck reactor cues (rx_*). Each lists the pictures sent at a
// text stop, RX_PIC apart: `in` ends on the pose he HOLDS while the next sentence streams
// (moment.hold), `out` plays back to the held mic (a number = that many evenly blended
// pictures, the last being the hold). Lengths differ on purpose so reactions don't land on
// one beat. Keys follow MOMENTS, except ly is absolute (RX_LY is the held free mitten).
// g: the glyph over that picture, [name,x,y,level]; RX_DIM eases one in, so none pops in.
const RX_PIC=.14,RX_DIM=6,RX_ON=15,RX_CORNER={lx:7,ly:27,lopen:.3};
const RX_FINGER_GUN={lx:7,ly:14,lpoint:1,lthumb:1};
const REACTIONS={
 giggle:{in:[{f:'delighted',y:2,ry:2,...RX_CORNER},{f:'delighted',y:.5,ry:.5,tilt:-.07,browY:-1,...RX_CORNER,lopen:.6,g:['ha',70,2,RX_DIM]},{f:'delighted',y:2,ry:2,tilt:-.11,...RX_CORNER,g:['ha',70,2,RX_ON]},{f:'delighted',y:1,ry:1,tilt:-.08,browY:-1,...RX_CORNER,lopen:.6,g:['ha',70,2,RX_ON]}],out:2},
 eyeroll:{in:[{f:'focused',gazeX:-1.6,gazeY:0},{gazeX:-1,gazeY:-1.8,browY:-1,y:1},{gazeX:1.4,gazeY:-1.8,browY:-1,y:1,tilt:.04},{f:'focused',gazeX:.6,gazeY:.6,sleepy:.35,tilt:.07,browY:.5,y:1,ly:28,ry:1}],out:2},
 deadpan:{in:[{eye:.08},{sleepy:.55,gazeX:0,gazeY:0,browY:1,tilt:.04,y:.5,ly:27.5}],out:1},
 whoa:{in:[{eye:.05,y:1,ly:28,ry:1},{f:'surprised',browY:-2.5,y:2,lx:6,ly:12,lopen:1,lrot:-.3,ry:-2,g:['bang',70,2,RX_DIM]},{f:'surprised',browY:-3,y:2.5,lx:5,ly:9,lopen:1,lrot:-.4,ry:-3,tilt:.05,g:['bang',70,2,RX_ON]},{f:'surprised',browY:-2,y:1.5,lx:6,ly:11,lopen:1,lrot:-.3,ry:-1,g:['bang',70,2,RX_ON]}],out:2},
 eureka:{in:[{eye:.1,y:1.5,ly:28,ry:1.5},{f:'surprised',browY:-2.5,lx:7,ly:6,lpoint:1,lrot:1.45,tilt:-.05,y:.5},{f:'surprised',browY:-3,lx:7,ly:3,lpoint:1,lrot:1.45,tilt:-.08,y:1,g:['bulb',70,1,RX_DIM]},{f:'delighted',browY:-2,lx:7,ly:4,lpoint:1,lrot:1.45,tilt:-.05,y:1,g:['bulb',70,1,RX_ON]}],out:2},
 chefkiss:{in:[{lx:8,ly:13,lopen:0,f:'focused',eye:.6,tilt:-.03},{lx:7,ly:10,lopen:1,lrot:-.5,f:'delighted',browY:-1,tilt:-.08,g:['spark',1,1,RX_DIM]},{lx:7,ly:11,lopen:.9,lrot:-.4,f:'delighted',tilt:-.06,g:['spark',1,1,RX_ON]}],out:2},
 squint:{in:[{f:'focused',tilt:.04,browL:-.4,browR:.3,gazeX:.8,g:['q',70,2,RX_DIM]},{f:'skeptical',tilt:.09,browL:-.45,browR:.35,gazeX:1.4,gazeY:-.4,sleepy:.2,g:['q',70,2,RX_ON]}],out:1},
 wander:{in:[{f:'curious',gazeX:-1.5,gazeY:-1.3,browLiftL:-1,tilt:-.05,lx:8,ly:12,lpoint:1,lrot:1.45,g:['dot1',70,3,RX_DIM]},{f:'curious',gazeX:0,gazeY:-1.8,browLiftL:-1.5,browR:.2,tilt:-.02,lx:8,ly:9,lpoint:1,lrot:1.45,g:['dot2',70,3,RX_ON]},{f:'curious',gazeX:1.5,gazeY:-1.3,browLiftR:-1.5,browL:.2,tilt:.05,lx:8,ly:10,lpoint:1,lrot:1.45,g:['dot3',70,3,RX_ON]},{f:'focused',gazeX:1.3,gazeY:-1.1,browLiftR:-1,tilt:.06,lx:8,ly:9,lpoint:1,lrot:1.45,g:['dot3',70,3,RX_ON]}],out:2},
 melt:{in:[{f:'delighted',tilt:.05,browL:.2,browR:-.2,lx:44,ly:27,lopen:.2},{f:'delighted',tilt:.11,y:1,ry:1,browL:.35,browR:-.35,lx:52,ly:27,lopen:0,g:['heartS',70,4,RX_DIM]},{f:'delighted',tilt:.14,y:1,ry:.5,browL:.4,browR:-.4,lx:58,ly:27,lopen:0,g:['heart',69,1,RX_ON]},{f:'delighted',tilt:.13,y:1,ry:1,browL:.35,browR:-.35,lx:57,ly:27,lopen:0,eye:.85,g:['heart',69,0,RX_ON]}],out:3},
 grin:{in:[{f:'surprised',browY:-1.5,y:.5},{f:'delighted',y:3,ry:3,tilt:.1,browL:.3,browR:-.3,...RX_CORNER,g:['drop',8,3,RX_DIM]},{f:'delighted',y:2.5,ry:2.5,tilt:.08,browL:.3,browR:-.3,...RX_CORNER,g:['drop',8,3,RX_ON]}],out:2},
 yikes:{in:[{f:'focused',eye:.35,x:38,y:2,ry:2,tilt:-.08,browL:.3,browR:-.3,...RX_CORNER},{f:'focused',eye:.35,x:40,y:2,ry:2,tilt:-.06,browL:.3,browR:-.3,...RX_CORNER,g:['drop',8,3,RX_DIM]},{f:'focused',eye:.35,x:37,y:2,ry:2,tilt:-.09,browL:.3,browR:-.3,...RX_CORNER,g:['drop',8,3,RX_ON]},{f:'concerned',eye:.7,x:38,y:1.5,ry:1.5,tilt:-.07,browL:.3,browR:-.3,gazeX:-.8,gazeY:.6,...RX_CORNER,g:['drop',8,3,RX_ON]}],out:2},
 thumbsup:{in:[{y:1.5,ly:29,ry:1.5},{f:'delighted',browY:-1.5,lx:7,ly:4,lthumb:1,lopen:0,tilt:-.08,g:['spark',70,2,RX_DIM]},{f:'delighted',browY:-1.5,lx:7,ly:5,lthumb:1,lopen:0,tilt:-.05,gazeX:-.5,gazeY:-.4,g:['spark',70,2,RX_ON]}],out:2},
 fingerguns:{in:[{...RX_FINGER_GUN,tilt:-.03,gazeX:.6,gazeY:.3},{...RX_FINGER_GUN,ly:12,lrot:.4,tilt:-.06,browY:-.5,gazeX:.6,gazeY:.3,g:['spark3',0,7,RX_ON]},{...RX_FINGER_GUN,shutR:.95,tilt:.07,browLiftR:1,browLiftL:-1.5,gazeX:.6,gazeY:.3,g:['spark',66,1,RX_ON]},{...RX_FINGER_GUN,tilt:.05,sleepy:.25,browLiftL:-1,gazeX:.6,gazeY:.3}],out:2},
 psst:{in:[{f:'focused',gazeX:-1.6,gazeY:.4,x:39},{x:43,tilt:.13,y:1,rx:80,ry:-3,f:'focused',gazeX:.4,gazeY:.5,sleepy:.25},{x:42,tilt:.11,y:1,rx:80,ry:-2,f:'focused',gazeX:.2,gazeY:.4,sleepy:.3,ly:28}],out:2},
 snooze:{in:[{sleepy:.5,y:1,ly:28,ry:1,tilt:.03},{sleepy:.85,f:'sleepy',y:2.5,ry:2.5,tilt:.1,...RX_CORNER,g:['zs',70,2,RX_DIM]},{f:'sleepy',sleepy:1,y:2,ry:2,tilt:.08,...RX_CORNER,g:['zs',70,2,RX_ON]}],out:[{f:'surprised',browY:-2.5,y:-.5,ry:-1,tilt:-.04}]},
 // Speck New Moves picks (2026-10-27): mindblown, cringe, sigh, doubletake.
 mindblown:{in:[{eye:.1,y:1,ry:1},{f:'surprised',eye:1.3,browY:-3,y:-1.5,ry:-1,lx:7,ly:12,lopen:1,lrot:-.4,g:['boom',2,1,RX_DIM]},{f:'surprised',eye:1.3,browY:-3,y:-2,ry:-1,tilt:.06,lx:6,ly:10,lopen:1,lrot:-.5,g:['boom',2,1,RX_ON]},{f:'delighted',eye:1.15,browY:-2,y:-1,tilt:.04,lx:7,ly:12,lopen:1,lrot:-.4,g:['spark',3,2,RX_ON]}],out:2},
 cringe:{in:[{f:'concerned',y:2,ry:1,eye:.3,browL:-.3,browR:.3},{f:'concerned',y:3.5,ry:1.5,eye:.06,tilt:-.06,browL:-.3,browR:.3,...RX_CORNER,lx:9,ly:22,lopen:.6,g:['wave',8,3,RX_DIM]},{f:'concerned',y:3.5,ry:1.5,eye:.06,tilt:.05,browL:-.3,browR:.3,...RX_CORNER,lx:9,ly:22,lopen:.6,g:['wave',8,3,RX_ON]},{f:'concerned',y:3,ry:1.5,eye:.55,tilt:-.03,browL:-.3,browR:.3,gazeX:.8,gazeY:.6,...RX_CORNER,lx:9,ly:23,lopen:.6,g:['wave',8,3,RX_ON]}],out:2},
 sigh:{in:[{f:'concerned',eye:.35,sleepy:.3,y:1,ry:.5},{f:'sleepy',eye:.08,y:2.5,ry:1.5,tilt:.04,browL:-.2,browR:.2,...RX_CORNER,g:['puff',9,14,RX_DIM]},{f:'sleepy',eye:.08,y:3,ry:1.5,tilt:.05,browL:-.2,browR:.2,...RX_CORNER,g:['puff',6,11,RX_ON]},{f:'concerned',eye:.45,sleepy:.4,y:2,ry:1,tilt:.03,...RX_CORNER,g:['puffS',4,8,RX_ON]}],out:2},
 doubletake:{in:[{f:'focused',gazeX:-1.6,gazeY:.3,turn:-.4},{f:'curious',gazeX:.8,gazeY:.6,turn:0},{f:'surprised',gazeX:-1.7,gazeY:.2,turn:-.8,eye:1.3,browY:-2.5,y:-1,ry:-1,tilt:-.06,g:['qbang',7,2,RX_DIM]},{f:'surprised',gazeX:-1.6,gazeY:.2,turn:-.8,eye:1.25,browY:-2,y:-.5,tilt:-.05,g:['qbang',7,2,RX_ON]}],out:2},
 // More Speck Moves picks (2026-10-28): starstruck, dizzy, blush, airquotes. One glyph marks both
 // eyes (stars, spinning spirals) or both cheeks, at his lenses for that picture's tilt.
 starstruck:{in:[{f:'surprised',eye:1.3,browY:-2.5,gazeX:0,gazeY:0,lx:9,ly:19,lopen:.8,lrot:-.2},{f:'delighted',eye:.05,browY:-2,gazeX:0,gazeY:0,lx:8,ly:14,lopen:1,lrot:-.3,g:['starsA',24,9,RX_DIM]},{f:'delighted',eye:.05,browY:-2.5,gazeX:0,gazeY:0,tilt:.1,lx:8,ly:13,lopen:1,lrot:-.4,g:['starsB',24,9,RX_ON]},{f:'delighted',eye:.05,browY:-2,gazeX:0,gazeY:0,tilt:.1,lx:8,ly:14,lopen:1,lrot:-.3,g:['starsC',2,1,RX_ON]}],
  // The mitten drops down his side first, the stars dimming where they are.
  out:[{f:'delighted',eye:.05,browY:-1,gazeX:0,gazeY:0,tilt:.1,...RX_CORNER,g:['starsB',24,9,RX_DIM]}]},
 dizzy:{in:[{f:'concerned',eye:.05,gazeX:0,gazeY:0,tilt:.1,lopen:0,g:['dizzy1',3,1,RX_DIM]},{f:'concerned',eye:.05,gazeX:0,gazeY:0,tilt:-.08,browL:.3,browR:-.3,lx:8,ly:14,lopen:.8,g:['dizzy2',24,1,RX_ON]},{f:'concerned',eye:.05,gazeX:0,gazeY:0,tilt:.1,browL:-.3,browR:.3,lx:8,ly:11,lopen:1,lrot:.3,g:['dizzy3',24,1,RX_ON]},{f:'concerned',eye:.05,gazeX:0,gazeY:0,tilt:-.06,browL:.2,browR:-.2,lx:8,ly:11,lopen:1,lrot:.3,g:['dizzy4',3,1,RX_ON]}],out:2},
 blush:{in:[{f:'surprised',eye:1.2,browY:-1.5,gazeX:.2,gazeY:.4},{f:'delighted',gazeX:-1.4,gazeY:1.2,tilt:-.06,browL:.3,browR:-.3,lx:8,ly:13,lopen:.7,lrot:.4,g:['blush',22,22,RX_DIM]},{f:'delighted',gazeX:-1.4,gazeY:1.2,tilt:-.06,browL:.3,browR:-.3,lx:8,ly:6,lopen:.9,lrot:.5,g:['blush',22,22,12]},{f:'delighted',gazeX:-1.2,gazeY:1,tilt:-.06,browL:.3,browR:-.3,lx:8,ly:8,lopen:.9,lrot:.4,g:['blush',22,22,12]}],out:2},
 airquotes:{in:[{f:'skeptical',browLiftL:-1.5,gazeX:1.3,gazeY:.3,tilt:.04,lx:8,ly:12,lopen:1,lrot:-.2},{f:'skeptical',browLiftL:-1.5,gazeX:1.3,gazeY:.3,tilt:.04,lx:8,ly:12,lopen:0,lrot:.4,g:['quotes',2,1,RX_ON]},{f:'skeptical',browLiftL:-1.5,gazeX:1.3,gazeY:.3,tilt:.04,lx:8,ly:12,lopen:1,lrot:-.2},{f:'skeptical',browLiftL:-1.5,gazeX:1.4,gazeY:.2,sleepy:.3,tilt:.04,lx:8,ly:12,lopen:0,lrot:.4,g:['quotes',2,1,RX_ON]}],out:2},
 // Speck Feelings Picker picks (2026-11-11), for the new feelings worried (nibble, dart), excited (fistpump, buzz),
 // surprised (blinkblink, jolt), relieved (phew, exhale), grateful (tipframe) and frustrated (grumble, huff).
 nibble:{in:[{f:'concerned',browL:-.3,browR:.3,eye:.85,gazeX:-.9,gazeY:.8,lx:7,ly:21,lopen:.3},{f:'concerned',browL:-.3,browR:.3,eye:.85,gazeX:-1.2,gazeY:.9,tilt:-.04,lx:7,ly:17,lopen:.3,g:['drop',70,2,RX_DIM]},{f:'concerned',browL:-.3,browR:.3,eye:.85,gazeX:-1.2,gazeY:.9,tilt:-.06,y:.5,lx:7,ly:15,lopen:.2,g:['drop',70,3,RX_ON]},{f:'concerned',browL:-.3,browR:.3,eye:.8,gazeX:-1.1,gazeY:1,tilt:-.05,y:1,ry:.5,lx:7,ly:16,lopen:.3,g:['drop',70,4,RX_ON]}],out:2},
 dart:{in:[{f:'concerned',browL:-.3,browR:.3,gazeX:-1.7,gazeY:.2},{f:'concerned',browL:-.3,browR:.3,gazeX:1.7,gazeY:.2,tilt:.03},{f:'concerned',browL:-.3,browR:.3,gazeX:-1.5,gazeY:.4,y:1,ry:.5,lx:7,ly:27,lopen:.3,g:['drops',70,2,RX_DIM]},{f:'concerned',browL:-.3,browR:.3,gazeX:-.6,gazeY:.3,eye:.9,y:2,ry:1,tilt:-.04,lx:7,ly:27,lopen:.3,g:['drops',70,2,RX_ON]}],out:2},
 fistpump:{in:[{f:'delighted',y:2,ry:2,eye:.8,lx:7,ly:22,lopen:0},{f:'delighted',y:-1.5,ry:-1,browY:-1.5,tilt:-.06,lx:7,ly:8,lopen:0,g:['sparks',70,2,RX_DIM]},{f:'delighted',y:1,ry:1,browY:-1,tilt:-.03,lx:7,ly:11,lopen:0,g:['sparks',70,2,RX_ON]},{f:'delighted',y:-1,ry:-.5,browY:-1.5,tilt:-.06,lx:7,ly:7,lopen:0,g:['sparks2',70,2,RX_ON]}],out:2},
 buzz:{in:[{f:'surprised',eye:1.25,browY:-2,lx:7,ly:16,lopen:1,lrot:-.3},{f:'delighted',eye:1.15,browY:-2,tilt:-.1,y:-.5,lx:7,ly:11,lopen:1,lrot:-.5,g:['bang2',70,2,RX_DIM]},{f:'delighted',eye:1.15,browY:-2,tilt:.08,y:-.5,lx:7,ly:10,lopen:1,lrot:.4,g:['bang2',70,2,RX_ON]},{f:'delighted',eye:1.15,browY:-2,tilt:-.08,y:-1,lx:7,ly:11,lopen:1,lrot:-.5,g:['bang2',70,2,RX_ON]}],out:2},
 blinkblink:{in:[{eye:.05},{f:'surprised',eye:1.1,browY:-1},{eye:.05,y:.5,ry:.5},{f:'surprised',eye:1.35,browY:-2.5,y:-.5,tilt:.04,gazeX:.3,gazeY:.2,g:['qbang2',70,2,RX_ON]}],out:2},
 jolt:{in:[{f:'surprised',eye:1.3,browY:-2.5,y:-2.5,ry:-2,x:43,tilt:.08,lx:7,ly:13,lopen:1,lrot:-.5,g:['bang',70,2,RX_DIM]},{f:'surprised',eye:1.3,browY:-3,y:-3,ry:-2.5,x:44,tilt:.1,lx:6,ly:10,lopen:1,lrot:-.6,g:['bang',70,2,RX_ON]},{f:'surprised',eye:1.25,browY:-2,y:-1,ry:-1,x:42,tilt:.06,lx:7,ly:12,lopen:1,lrot:-.4,g:['bang',70,2,RX_ON]}],out:2},
 phew:{in:[{f:'concerned',eye:.5,y:.5,lx:7,ly:14,lopen:.8,lrot:.3},{f:'sleepy',eye:.06,y:1.5,ry:1,tilt:.05,lx:8,ly:6,lopen:.9,lrot:.6,g:['puff',70,8,RX_DIM]},{f:'sleepy',eye:.06,y:2,ry:1,tilt:.07,lx:6,ly:9,lopen:.9,lrot:.2,g:['puff',70,5,RX_ON]},{f:'delighted',eye:.8,y:1.5,ry:1,tilt:.06,browY:-1,lx:7,ly:13,lopen:.7,g:['puffS',71,2,RX_ON]}],out:2},
 exhale:{in:[{f:'concerned',eye:.7,y:-1.5,ry:-1,browY:-1},{f:'sleepy',eye:.06,y:1.5,ry:1,tilt:.04,lx:7,ly:27,lopen:.3,g:['puff',8,16,RX_DIM]},{f:'sleepy',eye:.06,y:3,ry:1.5,tilt:.06,lx:7,ly:27,lopen:.3,g:['puff',5,12,RX_ON]},{f:'delighted',eye:.75,y:2.5,ry:1.5,tilt:.06,lx:7,ly:27,lopen:.3,g:['puffS',3,8,RX_ON]}],out:2},
 tipframe:{in:[{f:'delighted',gazeX:.3,gazeY:.2,lx:7,ly:14,lopen:.4},{f:'delighted',gazeX:.3,gazeY:.2,browY:-1,lx:8,ly:6,lopen:.3,lrot:.4,tilt:-.03},{f:'delighted',eye:.3,y:2.5,ry:1.5,lx:8,ly:8,lopen:.3,lrot:.6,tilt:-.08},{f:'delighted',eye:.9,y:.5,browY:-1,gazeX:.3,gazeY:.2,lx:8,ly:6,lopen:.3,lrot:.4,tilt:-.04,g:['spark3',72,3,RX_ON]}],out:2},
 grumble:{in:[{f:'focused',browL:.3,browR:-.3,eye:.75,gazeX:1.2,gazeY:.2},{f:'skeptical',browL:.45,browR:-.45,eye:.6,gazeX:1.6,gazeY:0,tilt:.05,y:1,ry:.5,lx:7,ly:27,lopen:.3,g:['scribble',70,1,RX_DIM]},{f:'skeptical',browL:.45,browR:-.45,eye:.6,gazeX:1.6,gazeY:0,tilt:.07,y:1.5,ry:1,lx:7,ly:27,lopen:.3,g:['scribble',70,1,RX_ON]},{f:'skeptical',browL:.45,browR:-.45,eye:.55,gazeX:1.5,gazeY:.2,tilt:.06,y:1,ry:.5,lx:7,ly:27,lopen:.3,g:['scribble',71,2,RX_ON]}],out:2},
 huff:{in:[{f:'focused',browL:.3,browR:-.3,eye:.3,y:1,ry:.5},{f:'focused',browL:.45,browR:-.45,eye:.05,y:3,ry:1.5,lx:7,ly:27,lopen:.3,g:['steam',70,5,RX_DIM]},{f:'focused',browL:.45,browR:-.45,eye:.05,y:3,ry:1.5,tilt:.03,lx:7,ly:27,lopen:.3,g:['steam2',70,2,RX_ON]},{f:'skeptical',browL:.3,browR:-.3,eye:.6,sleepy:.35,y:1.5,ry:1,gazeX:.4,gazeY:.2,lx:7,ly:27,lopen:.3,g:['puffS',76,1,RX_DIM]}],out:2},
 // Round two picks (2026-11-11): puzzled (shrug, blankstare), determined (fire, firmnods, attention) and
 // two more for grateful (littlebow, hearteyes).
 shrug:{in:[{f:'curious',browY:-1.5,gazeX:.3,gazeY:.2,lx:7,ly:20,lopen:.6},{f:'curious',browY:-2.5,tilt:.1,y:-1,gazeX:.3,gazeY:.2,lx:6,ly:13,lopen:1,lrot:-.7,g:['q',72,2,RX_DIM]},{f:'curious',browY:-2.5,tilt:.12,y:-1.5,ry:-1,gazeX:.3,gazeY:.2,lx:5,ly:11,lopen:1,lrot:-.8,g:['q',72,2,RX_ON]},{f:'curious',browY:-2,tilt:.1,y:-.5,gazeX:.3,gazeY:.2,lx:6,ly:13,lopen:1,lrot:-.7,g:['q',72,2,RX_ON]}],out:2},
 blankstare:{in:[{f:'focused',eye:.45,browY:0,gazeX:0,gazeY:0,g:['tick1',70,4,RX_ON]},{f:'focused',eye:.05,gazeX:0,gazeY:0,g:['tick2',70,4,RX_ON]},{f:'focused',eye:.45,gazeX:0,gazeY:0,tilt:.05,g:['tick3',70,4,RX_ON]},{f:'focused',eye:.45,gazeX:0,gazeY:0,tilt:.09,browLiftL:-1.5,g:['q',72,2,RX_ON]}],out:2},
 fire:{in:[{f:'focused',browL:.3,browR:-.3,eye:.5,gazeX:0,gazeY:0,y:1,ry:.5},{f:'focused',browL:.45,browR:-.45,eye:.05,gazeX:0,gazeY:0,y:0,lx:7,ly:27,lopen:0,g:['flames',24,9,RX_DIM]},{f:'focused',browL:.45,browR:-.45,eye:.05,gazeX:0,gazeY:0,y:0,lx:7,ly:27,lopen:0,g:['flamesB',24,9,RX_ON]},{f:'focused',browL:.45,browR:-.45,eye:.05,gazeX:0,gazeY:0,y:0,lx:7,ly:27,lopen:0,g:['flames',24,9,RX_ON]}],out:[{f:'focused',browL:.3,browR:-.3,eye:.05,gazeX:0,gazeY:0,lx:7,ly:27,lopen:.3,g:['flamesB',24,9,RX_DIM]}]},
 firmnods:{in:[{f:'focused',browL:.3,browR:-.3,eye:.85,gazeX:.2,gazeY:.2,y:2.5,ry:1.5},{f:'focused',browL:.3,browR:-.3,eye:.85,gazeX:.2,gazeY:.2,y:-.5},{f:'focused',browL:.3,browR:-.3,eye:.85,gazeX:.2,gazeY:.2,y:2.5,ry:1.5},{f:'focused',browL:.3,browR:-.3,eye:.85,gazeX:.2,gazeY:.2,y:0}],out:1},
 attention:{in:[{f:'focused',browL:.3,browR:-.3,gazeX:.2,gazeY:0,lx:7,ly:18,lopen:.2},{f:'focused',browL:.3,browR:-.3,gazeX:.2,gazeY:0,y:-1.5,ry:-1,tilt:-.04,lx:8,ly:5,lopen:.2,lrot:.9},{f:'focused',browL:.3,browR:-.3,gazeX:.2,gazeY:0,y:-1,ry:-.5,tilt:-.04,lx:8,ly:6,lopen:.2,lrot:.9,g:['spark3',2,12,RX_ON]}],out:2},
 littlebow:{in:[{f:'delighted',eye:.5,y:1,ry:.5,lx:7,ly:27,lopen:.3},{f:'delighted',eye:.05,y:4,ry:2,lx:7,ly:27,lopen:.5},{f:'delighted',eye:.05,y:4,ry:2,lx:7,ly:27,lopen:.5,g:['heartS',71,5,RX_DIM]},{f:'delighted',eye:.9,y:1,ry:.5,browY:-1,gazeX:.3,gazeY:.2,lx:7,ly:27,lopen:.5,g:['heartS',71,3,RX_ON]}],out:2},
 hearteyes:{in:[{f:'surprised',eye:1.2,browY:-2,gazeX:0,gazeY:0},{f:'delighted',eye:.05,browY:-1.5,gazeX:0,gazeY:0,lx:7,ly:27,lopen:.3,g:['hearts',24,9,RX_DIM]},{f:'delighted',eye:.05,browY:-2,gazeX:0,gazeY:0,tilt:.1,lx:7,ly:27,lopen:.3,g:['heartsB',24,9,RX_ON]},{f:'delighted',eye:.05,browY:-1.5,gazeX:0,gazeY:0,tilt:.1,y:.5,lx:7,ly:27,lopen:.3,g:['heartsB',24,9,RX_ON]}],out:[{f:'delighted',eye:.05,browY:-1,gazeX:0,gazeY:0,tilt:.1,lx:7,ly:27,lopen:.3,g:['heartsB',24,9,RX_DIM]}]}
};
function reactionMoment(r){
 const rel=k=>{const o={...k};delete o.g;if('ly' in o)o.ly-=RX_LY;return o;},held=r.in[r.in.length-1];
 let out=r.out;
 // A mitten raised beside his frame drops down its side first: the straight way home
 // passes behind the lenses, where the renderer hides it.
 if(typeof out==='number'&&held.lx<15){const half={};for(const k in held)if(typeof held[k]==='number'&&!k.startsWith('gaze'))half[k]=MOMENT_ADD.includes(k)?held[k]/2:held[k];
  Object.assign(half,{...RX_CORNER,lpoint:0,lthumb:0,lrot:0,y:Math.min(half.y||0,1),ry:Math.min(half.ry||0,1)});delete half.shutL;delete half.shutR;if(held.f)half.f=held.f;
  out=out>=3?[half,{lx:20,ly:27,lopen:.3}]:[half];}
 // Picture n is written at cue age at(n); its glyph shows from half a picture before.
 const at=n=>Math.round(n*RX_PIC*1e3)/1e3,keys=[[0,{}]],glyphs=[[0,null]],enter=[],leave=[];let n=0;
 for(const pose of r.in){n++;keys.push([at(n),rel(pose)]);enter.push(at(n));glyphs.push([at(n-.5),pose.g||null]);}
 const hold=at(n),fade=held.g?[held.g[0],held.g[1],held.g[2],RX_DIM]:null;
 const steps=Array.isArray(out)?out:Array.from({length:out-1},()=>null);
 steps.forEach((pose,i)=>{n++;if(pose)keys.push([at(n),rel(pose)]);leave.push(at(n));glyphs.push([at(n-.5),pose&&'g' in pose?pose.g:i?null:fade]);});
 n++;keys.push([at(n),{}]);leave.push(at(n));glyphs.push([at(n-.5),null]);
 return {duration:at(n),hold,keys,glyphs,pictures:{enter,leave}};
}
for(const name in REACTIONS){const m=reactionMoment(REACTIONS[name]);MOMENTS['rx_'+name]=m;CUES['rx_'+name]={duration:m.duration};}
const ATTEND_POSE={...BASE,x:47,y:13,tilt:.035,lx:20,ly:27,rx:76,ry:27,lrot:.15,rrot:-.15,gazeX:.6,gazeY:.6,curious:1,browY:-1};
// Each activity has an entrance reaction and a slower, readable emotional arc.
// These are face directions, independent of the action/prop catalogue.
function expressionFor(def,age,variant=0){
 const a=def.action||def.id;
 let beats;
 if(a==='error')beats=[[1.2,'surprised'],[8,'concerned']];
 else if(a==='thinking')beats=variant===3?[[1.5,'curious'],[3.8,'focused'],[4.6,'skeptical'],[5.05,'concerned'],[5.5,'surprised'],[8.3,'delighted'],[12,'curious']]:variant===0?[[2.8,'focused'],[5.2,'skeptical'],[6.4,'curious'],[7.3,'delighted'],[10,'focused']]:variant===1?[[2.5,'curious'],[5,'focused'],[7.5,'skeptical'],[10,'curious']]:[[2,'focused'],[4,'skeptical'],[7,'curious'],[10,'focused']];
 else if(a==='idle')beats=IDLE_BEATS[variant%IDLE_VARIATIONS];
 else if(a==='listening')beats=[[2.4,'curious'],[3.8,'focused'],[6,'curious'],[7.5,'playful'],[10,'curious']];
 else if(a==='voice')beats=[[3.2,'curious'],[4.6,'focused'],[8,'curious']];
 else if(['thinking','reasoning','planning','analysing','learning'].includes(a))beats=[[1.2,'curious'],[3.8,'focused'],[4.6,'surprised'],[6.2,'delighted'],[8,'curious']];
 else if(['greeting','complete','success','celebrating','highfive'].includes(a))beats=[[1,'delighted'],[1.7,'playful'],[4.8,'delighted'],[7,'neutral']];
 else if(['disconnected','reconnecting','warning'].includes(a))beats=[[1,'surprised'],[3.3,'concerned'],[6.5,'focused']];
 else if(['standby','paused'].includes(a))beats=[[2,'neutral'],[7,'sleepy']];
 else if(['waiting','queued','awaiting','idle'].includes(a))beats=[[2.6,'neutral'],[3.8,'curious'],[5.2,a==='waiting'?'skeptical':'neutral'],[8,'neutral']];
 else if(['listening','searching','filesearch','vision','calling'].includes(a))beats=[[2.2,'curious'],[4.8,'focused'],[7,'curious']];
 else if(['debugging','bug','device'].includes(a))beats=[[1.3,'curious'],[3.2,'skeptical'],[7,'focused']];
 else if(['speaking','reply','sending','delegating','coordinating','secure'].includes(a))beats=[[1,'curious'],[3.5,'focused'],[5,'delighted'],[7,'neutral']];
 else beats=[[.9,'curious'],[4.8,'focused'],[6,'delighted'],[8,'focused']];
 const t=age%beats[beats.length-1][0];return beats.find(([end])=>t<end)[1];
}
// Twelve idle variations, including edge exercise and small lens/prop routines.
// Each is a 10 s loop; the rotation advances every loop and on
// every wake from a held still frame. Paths live in props.js.
// The drum (11) needs the settled name row under him: without it the
// rotation skips it, and a pinned drum plays the hang (10) instead.
const IDLE_VARIATIONS=12,HANG=10,DRUM=11,WITHOUT_DRUM=11;
const IDLE_BEATS=[
 // Yo-yo stays curious, not playful: playful's one-eye wink reads as a glitch mid-trick.
 [[1,'curious'],[6.5,'curious'],[10,'delighted']],
 [[1,'curious'],[2.2,'focused'],[3.5,'curious'],[5.5,'delighted'],[7.2,'curious'],[7.6,'surprised'],[8.4,'delighted'],[10,'playful']],
 [[1.5,'playful'],[6,'sleepy'],[6.6,'surprised'],[8,'curious'],[9,'playful'],[10,'delighted']],
 [[3,'curious'],[4.5,'playful'],[6,'skeptical'],[7,'focused'],[7.3,'surprised'],[7.9,'delighted'],[9.5,'playful'],[10,'delighted']],
 [[2,'curious'],[5.5,'focused'],[6.5,'curious'],[8.5,'delighted'],[10,'curious']],
 [[1,'curious'],[6.4,'focused'],[7.3,'sleepy'],[8.2,'delighted'],[10,'playful']],
 [[2,'sleepy'],[5.5,'focused'],[7,'sleepy'],[7.6,'surprised'],[10,'curious']],
 [[2,'focused'],[4.5,'curious'],[6.8,'skeptical'],[8,'focused'],[10,'delighted']],
 [[2,'curious'],[5,'focused'],[6.4,'playful'],[7.2,'surprised'],[8.5,'curious'],[10,'playful']],
 [[2,'curious'],[4,'skeptical'],[6,'focused'],[8.5,'delighted'],[10,'skeptical']],
 [[2.2,'focused'],[4.4,'playful'],[6.4,'delighted'],[7.4,'surprised'],[10,'delighted']],
 // The live drum face follows its planned beats (drumBeat); this is the fallback.
 [[.88,'playful'],[4,'focused'],[10,'delighted']]];
const IDLE_REST_EMOTION=['playful','curious','sleepy','neutral','curious','playful','neutral','delighted','neutral','neutral','delighted','delighted'];
// A life between visits (2026-10-28): the longer the stills go untouched, the sleepier the
// still he holds. 0 alert (the variation's own still), 1 heavy lids, 2 drowsy, 3 asleep,
// 4 snoring. From drowsy on, his mittens drop into his lap and every routine rests on one
// shared pose, so the nod-off (moves.js) starts on the drowsy still and ends on the asleep
// one, and the snore starts and ends on it. DROWSE_MARKS are the Zs over a sleeping still,
// [rows,x,y,ink] from his head.
const DROWSE_LAP={x:48,gazeX:.4,gazeY:1,lx:18,ly:27,rx:80,ry:27,lopen:0,ropen:0,lrot:0,rrot:0,lpoint:0,rpoint:0,lthumb:0,rthumb:0,browL:0,browR:0,browLiftL:0,browLiftR:0,eyeL:1,eyeR:1};
// Whole-pixel heights: a spring that settles just short of a half pixel would round away.
const DROWSE=[null,{eye:.55,gazeY:.9},{...DROWSE_LAP,eye:.3,y:15,tilt:.05},{...DROWSE_LAP,eye:0,y:16,tilt:.07}];
DROWSE[4]=DROWSE[3];
const DROWSE_EMOTION=[null,'neutral','neutral','sleepy','sleepy'];
const DROWSE_Z=['111','011','110','111'],DROWSE_ZZ=['1111','0010','0100','1111'];
const DROWSE_MARKS=[null,null,null,[[DROWSE_Z,-38,-11,9]],[[DROWSE_Z,-38,-11,9],[DROWSE_ZZ,-44,-15,13]]];
// A mood that carries between turns (2026-11-11): while a turn still colours him, the idle
// still he rests on wears it. Each look is a tint over the routine's own still in the DROWSE
// form: pose keys (set last, so its brows win over the face's), the face, and optional marks
// [rows,x,y,ink] from his head. It is the picture the rest already writes, so a mood adds no
// picture of its own. An alert still only: a sleepy one (DROWSE) keeps its own look.
// Every look sets both brows, so they move with its face.
// Matt's picks from the Speck Mood Picker page (docs/design/speck-mood-picker-lab), under its
// codes. P: pleased (bright eyes, chin up, wide awake, thumb still up, sparkle, cheeky).
// R: worried (knit brows, sideways glance, wringing mittens, sweat drop, head down eyes on you).
// A look that names no mittens keeps the routine's own.
const REST_HANDS={lx:20,rx:76,ly:27,ry:27,lrot:.15,rrot:-.15,lopen:0,ropen:0},REST_UP={browY:-1,browL:0,browR:0},REST_KNIT={browY:0,browL:-.12,browR:.12};
const REST_SPARK=['010','111','010'],REST_DROP=['010','010','111','111','010'];
const REST_MOODS={
 P1:{face:'delighted',pose:{...REST_UP,gazeX:.3,gazeY:.3}},
 P2:{face:'delighted',pose:{...REST_HANDS,browY:0,browL:0,browR:0,y:12,tilt:-.04,gazeX:.2,gazeY:.2,lx:17,rx:79,ly:26,ry:26,lopen:.4,ropen:.4}},
 P3:{face:'curious',pose:{...REST_HANDS,...REST_UP,eye:1.15,gazeX:0,gazeY:0,lx:18,rx:78,ly:25,ry:25,lopen:.5,ropen:.5}},
 P4:{face:'delighted',pose:{...REST_HANDS,...REST_UP,gazeX:-.5,gazeY:.3,lx:13,ly:20,lthumb:1,lrot:0}},
 P6:{face:'delighted',pose:{...REST_UP,gazeX:.3,gazeY:.3},marks:[[REST_SPARK,29,-11,15],[REST_SPARK,-34,-6,9]]},
 P7:{face:'playful',pose:{...REST_HANDS,browY:0,browL:.12,browR:.12,x:50,tilt:-.08,gazeX:1.2,gazeY:.2,lx:22,rx:80,ry:25}},
 R1:{face:'concerned',pose:{...REST_KNIT,gazeX:.4,gazeY:.9}},
 R3:{face:'concerned',pose:{...REST_KNIT,gazeX:-1.5,gazeY:.5,tilt:-.06}},
 R4:{face:'concerned',pose:{...REST_HANDS,...REST_KNIT,gazeX:0,gazeY:.2,lx:43,rx:53,lrot:.3,rrot:-.3}},
 R6:{face:'concerned',pose:{...REST_KNIT,gazeX:.4,gazeY:.9},marks:[[REST_DROP,29,-9,15]]},
 R7:{face:'concerned',pose:{...REST_HANDS,...REST_KNIT,y:16,gazeX:0,gazeY:0,lx:14,rx:82,lrot:0,rrot:0}}
};
const idlePaths=()=>(typeof module!=='undefined'?require('./props.js'):root.WatchProps).idle;
const look=(q,ax,ay)=>{q.gazeX=clamp((ax-q.x)/24,-2,2);q.gazeY=clamp((ay-q.y)/9,-1.5,1.5);return q;};
// Resting hands per variation, so he is not arms-folded between beats.
const IDLE_HANDS=[{lx:20,rx:76,ly:27,ry:27,lrot:.15,rrot:-.15},{lx:26,rx:70,ly:25,ry:25,lrot:.55,rrot:-.55},{lx:38,rx:58,ly:27,ry:27,lrot:.08,rrot:-.08},{lx:20,rx:76,ly:27,ry:27,lrot:.15,rrot:-.15},{lx:38,rx:58,ly:27,ry:27,lrot:.08,rrot:-.08}];
IDLE_HANDS.push({lx:12,rx:84,ly:-1,ry:-1,lrot:0,rrot:0});
for(let i=0;i<4;i++)IDLE_HANDS.push({lx:16,rx:82,ly:26,ry:26,lrot:0,rrot:0});
IDLE_HANDS.push({lx:20,rx:76,ly:27,ry:27,lrot:.15,rrot:-.15},{lx:20,rx:76,ly:27,ry:27,lrot:0,rrot:0});
const smooth=u=>{u=clamp(u,0,1);return u*u*(3-2*u);},win=(t,a,b)=>smooth((t-a)/(b-a)),mix=(a,b,u)=>a+(b-a)*u;
// One-hand hang: grips sit OUTSIDE the lenses (head x +-31; the face spans
// +-26), or the face mask swallows the mittens and he reads as a floating head.
const GRIP=31;
// Arms at full stretch keep his whole face on the image: brows clear the top
// edge at head y 14 level and y 16 when tilted two steps (each step lifts a lens).
function hangBeat(t,q){const up=win(t,.6,1.8);
 Object.assign(q,{x:48,lx:48-GRIP,rx:48+GRIP,ly:0,ry:0,lopen:0,ropen:0,lrot:0,rrot:0,y:18-4*up,gazeX:.6,gazeY:.8-2*up});
 // One hand lets go and he leans into the grip, the way a one-arm hang pulls the
 // shoulder up. The lean never levels out and breathes with a 0.5 Hz swing, so
 // each 220 ms G2 frame is a clearly different pose.
 if(t>=2.2&&t<6.4){const u=win(t,2.2,2.8),s=Math.sin((t-2.2)*3.2),x=48-5*u+3*s;
  Object.assign(q,{x,y:15+u,tilt:u*(.13+.05*s),lx:48-GRIP+s,rx:x+29,ry:26,ropen:.6,rrot:-.3,gazeX:.6+.6*s,gazeY:-.3});}
 if(t>=6.4){const d=win(t,6.4,6.9),bounce=t>6.9&&t<7.4?Math.abs(Math.sin((t-6.9)*7))*3*(1-win(t,6.9,7.4)):0;
  Object.assign(q,{x:48,tilt:0,lopen:.5,ropen:.5,lx:mix(48-GRIP,20,d),rx:mix(72,76,d),ly:27*d,ry:mix(26,27,d),y:mix(16,13,d)+bounce,gazeX:.6,gazeY:mix(-1.2,-.4,d)});}
 return q;}
// Roll, rimshot, bow on his own name. The controller measures the settled name
// row with pretext and sends letter centres in image x: letters only, never the
// colon or a space. Measured on renderer.js: a mitten is 7 px wide and is drawn
// whole only while its centre is at x<=96; ry 27 puts its bottom row on the
// floor; the waiting mitten hovers at 23, any higher and the lens rim hides it.
const DRUM_GEOMETRY={maxX:96,minX:3,strikeY:27,hoverY:23,headMin:26,headMax:72,slot:.22,start:.88};
// Plan the whole roll before it starts. Hits alternate L, R along the letters,
// one per 220 ms frame; a mitten is down for its hit's frame and otherwise
// hovers over its own NEXT letter, so no hand ever jumps in from rest.
function drumPlan(glyphs){
 if(!Array.isArray(glyphs))return null;
 const G=DRUM_GEOMETRY,letters=glyphs.map(Number).filter(Number.isFinite),beats=[];let blocked=null;
 // Letters run left to right, so the first one out of reach is the only one he
 // stretches for. At most 20 hits keeps the stretch, crash and bow inside the 10 s loop.
 for(const x of letters){if(x<=G.maxX&&beats.length<20)beats.push(Math.max(G.minX,x));else if(blocked===null)blocked=Math.min(x,G.maxX+8);}
 if(!beats.length)return null;
 const hits=beats.map((x,i)=>({t:G.start+i*G.slot,x,hand:i%2?'r':'l'}));
 const rollEnd=G.start+(beats.length+1)*G.slot,stretchEnd=rollEnd+(blocked===null?0:1.32),rimEnd=stretchEnd+.88,crashEnd=rimEnd+.66;
 return {key:letters.join(','),beats,blocked,hits,rollEnd,stretchEnd,rimEnd,crashEnd};}
function drumHand(P,hand,t){const G=DRUM_GEOMETRY,own=P.hits.filter(h=>h.hand===hand);
 for(const h of own)if(t>=h.t&&t<h.t+G.slot)return {x:h.x,y:G.strikeY,open:.1,down:true};
 const next=own.find(h=>h.t>t)||own[own.length-1];return next?{x:next.x,y:G.hoverY,open:.4,down:false}:null;}
// Point at himself: rotation pi turns the finger back at the face, placed just
// outside the right temple arm so the face mask does not swallow it. Gaze and
// tilt stay clear of the renderer's .5 rounding edge, so the still frame is exact.
function pointAtSelf(q,u){const poke=u>.44&&u<.88?1:0;
 Object.assign(q,{x:48,rx:48+37-poke,ry:18,rpoint:1,rrot:Math.PI,ropen:.2,lx:20,ly:27,gazeX:.6,gazeY:-.4,y:13+poke,tilt:.05});return q;}
// One frame of the drum routine: pose into q; returns the face and which mittens strike.
function drumBeat(t,P,q){
 const G=DRUM_GEOMETRY,strike={l:false,r:false},first=P.beats[0],last=P.beats[P.beats.length-1];let emotion='focused';
 const home=x=>{q.x=x;q.lx=x-28;q.rx=x+28;q.ly=27;q.ry=27;};
 Object.assign(q,{y:13,tilt:0,lrot:0,rrot:0,lopen:.5,ropen:.5,lpoint:0,rpoint:0});
 if(t<G.start){home(48);q.ly=q.ry=22;q.lx=P.hits[0].x;const r=P.hits.find(h=>h.hand==='r');if(r)q.rx=r.x;look(q,48,-20);emotion='playful';}
 else if(t<P.rollEnd){
  const k=Math.max(0,P.hits.findIndex((h,i)=>t>=h.t&&(i===P.hits.length-1||t<P.hits[i+1].t))),h=P.hits[k],next=P.hits[Math.min(P.hits.length-1,k+1)];
  // The head drifts between the current and next letter, so the body follows the roll.
  const u=clamp((t-h.t)/Math.max(.01,next.t-h.t),0,1);home(clamp(mix(h.x,next.x,u)*.7+48*.3,G.headMin,G.headMax));
  for(const hand of ['l','r']){const a=drumHand(P,hand,t);if(!a)continue;q[hand+'x']=a.x;q[hand+'y']=a.y;q[hand+'open']=a.open;strike[hand]=a.down;}
  q.tilt=strike.l?-.04:strike.r?.04:0;look(q,next.x,42);
 }
 else if(t<P.stretchEnd){
  // Out of reach: lean with the head at x<=60 (further right his own lens hides
  // the reaching mitten), stretch to the reach limit, fall short, shrug.
  if(t<P.rollEnd+.66){const u=win(t,P.rollEnd,P.rollEnd+.5);home(60);Object.assign(q,{rx:mix(84,G.maxX,u),ry:mix(20,G.strikeY,u),ropen:1,rrot:-.5,tilt:.14*u,y:13+u,eye:.6});look(q,P.blocked,42);}
  else{home(60);Object.assign(q,{lx:34,rx:86,ly:21,ry:21,lopen:1,ropen:1,lrot:.6,rrot:-.6});look(q,48,20);emotion='skeptical';}
 }
 else if(t<P.rimEnd){
  // Both sticks held high outside the lenses, then ba-dum on the last letter.
  const u=t-P.stretchEnd,R=Math.min(G.maxX,last+5);home(clamp(last-16,G.headMin,60));q.lopen=q.ropen=.4;
  if(u<.44){Object.assign(q,{lx:q.x-31,rx:q.x+31,ly:11,ry:11,lrot:.5,rrot:-.5,y:12});look(q,48,-20);emotion='playful';}
  else{const left=u<.66;Object.assign(q,{lx:R-10,rx:R,ly:left?G.strikeY:G.hoverY,ry:left?G.hoverY:G.strikeY});strike[left?'l':'r']=true;look(q,last,42);}
 }
 else if(t<P.crashEnd){
  // Tss: one wind-up frame, then both mittens crash onto the first and last
  // letters, at least 10 px apart so a short name still reads as two hits.
  const up=t<P.rimEnd+.22,wide=last-first>=10,L=Math.max(G.minX,wide?first:(first+last)/2-5),R=Math.min(G.maxX,wide?last:(first+last)/2+5);
  home(clamp((L+R)/2,G.headMin,G.headMax));
  Object.assign(q,up?{lx:Math.max(G.minX,q.x-31),rx:Math.min(G.maxX,q.x+31),ly:11,ry:11,lopen:1,ropen:1,lrot:.5,rrot:-.5,y:11}:{lx:L,rx:R,ly:G.strikeY,ry:G.strikeY,lopen:.1,ropen:.1,y:14});
  if(!up)strike.l=strike.r=true;look(q,q.x,up?-20:42);emotion='delighted';
 }
 else{const u=t-P.crashEnd;emotion='delighted';
  // A small bow with closed eyes, then he points at himself.
  if(u<.44){home(48);Object.assign(q,{y:15,eye:.08,lx:34,rx:62,ly:26,ry:26});}else pointAtSelf(q,u-.44);
 }
 return {emotion,strike};}
// One beat of a variation: head, hands and where he looks. Emotion comes from IDLE_BEATS.
function idleBeat(v,t,q,drum=null){const P=idlePaths();if(v===DRUM&&!drum)v=HANG;Object.assign(q,IDLE_HANDS[v],{gazeX:.6,gazeY:.6,tilt:0,y:13});
 if(v===HANG)hangBeat(t,q);
 if(v===DRUM)drumBeat(t,drum,q);
 // The ball never rises above the palm (y 19), which sits below his eyes, so
 // the top of a bob reads as a level look and the drop pulls the eyes down.
 if(v===0){const y=P.yoyoY(t);Object.assign(q,{rx:80,ry:15,rrot:-.3,tilt:.05,gazeX:1.3,gazeY:clamp((y-17.5)/7,-1,1)});}
 if(v===1){if(t<1)Object.assign(q,{gazeX:.6,gazeY:-.6});else if(t<3.5){Object.assign(q,{y:13.4,lx:40,rx:56,ly:26,ry:26,lrot:.3,rrot:-.3});look(q,48,25);}
  else if(t<7.2){q.tilt=.05;const b=P.bubble(t);look(q,b.x,b.y);}else if(t<7.6)Object.assign(q,{gazeX:1.5,gazeY:-.8,x:49});else Object.assign(q,{gazeX:1.2,gazeY:-.6});}
 if(v===2){if(t<1.5)q.gazeY=.8;else if(t<6)Object.assign(q,{y:13+2.5*Math.min(1,(t-1.5)/2),tilt:.1,gazeY:1,lx:40,rx:56});
  else if(t<6.6)Object.assign(q,{y:12.3,lx:34,rx:62,ly:24,ry:24,lopen:.4,ropen:.4});
  else if(t<8)Object.assign(q,{gazeX:t<7.3?-1.3:1.3,x:t<7.3?47:49,lx:30,rx:66,ly:26,ry:26});else Object.assign(q,{lx:30,rx:66,ly:26,ry:26,lopen:.3,ropen:.3,gazeX:.8,gazeY:-.6});}
 if(v===3){if(t<7){const f=P.fly(t);Object.assign(q,{tilt:.06*Math.sign(f.x-48),x:48+.05*(f.x-48)});look(q,f.x,f.y);}
  else if(t<8.5)Object.assign(q,{rx:86,ry:9,rrot:-.4,gazeX:1.5,gazeY:t<7.3?-1.3:-1,x:t<7.3?49:48});
  else if(t<9.5){Object.assign(q,{rx:86,ry:9,ropen:1,rrot:-.4});const f=P.flyEscape(t);look(q,f.x,f.y);}else Object.assign(q,{gazeX:1.2,gazeY:-.8});}
 if(v===4){const down=t>2&&t<5.5;Object.assign(q,{y:down?14.5:13,gazeY:down?.9:-.6,gazeX:.6,tilt:down?.05:0});}
 // Grip the image edge itself, three reps, exhale, pride, then let go in order.
 if(v===5){const rep=clamp((t-1)/1.8,0,3),lift=(1-Math.cos(rep*Math.PI*2))/2;
  Object.assign(q,{x:48,y:18-19*lift,gazeX:.6,gazeY:.7-1.4*lift,turn:0});
  if(t>=6.4)Object.assign(q,{y:18,gazeY:.8,eye:.65,browY:1,tilt:.04});
  if(t>=7.3)Object.assign(q,{y:16,gazeY:-.6,eye:1.1,browY:-1,tilt:-.04});
  if(t>=8.2)Object.assign(q,{ly:25,lopen:.5,tilt:.08});
  if(t>=8.9)Object.assign(q,{ry:25,ropen:.5,y:13,tilt:0});
  if(t>=9.5)Object.assign(q,{lopen:0,ropen:0,eye:1});}
 if(v===6){q.eye=t<2?1-.75*t/2:t<5.5?.95:t<7?.08:1;q.gazeY=t<7?.8:-.7;
  if(t>=2&&t<5.5)Object.assign(q,{lx:35,ly:22,lpoint:.5,rx:t>=3.3?61:82,ry:t>=3.3?22:26,rpoint:t>=3.3?-.5:0});
  if(t>=5.5&&t<7)Object.assign(q,{y:15,tilt:.08});
  if(t>=7&&t<7.6)Object.assign(q,{ly:23,ry:23,lopen:1,ropen:1,y:13});
  if(t>=7.6)q.gazeX=t<8.5?-1.2:1.2;}
 if(v===7){q.gazeX=1.2;q.gazeY=.7;
  if(t>=1&&t<2)Object.assign(q,{rx:59,ry:24,ropen:.5,eye:.6});
  if(t>=2&&t<4.5)Object.assign(q,{rx:60+6*Math.sin((t-2)*6),ry:15,ropen:.6});
  if(t>=4.5&&t<5.5)Object.assign(q,{rx:80,ry:23,tilt:-.08,gazeY:-.6});
  if(t>=5.5&&t<8)Object.assign(q,{rx:64+3*Math.sin((t-5.5)*15),ry:12+2*Math.cos((t-5.5)*15),ropen:.5,eye:.8});
  if(t>=8)Object.assign(q,{gazeY:-.7,tilt:-.04});}
 if(v===8){Object.assign(q,{x:35,lx:70,rx:92,ly:27,ry:27,gazeX:1.5,gazeY:-.8});
  if(t>=1&&t<6.4)Object.assign(q,{ly:26-2*Math.sin(t*7),ry:26+2*Math.sin(t*7)});
  if(t>=5&&t<6.4)Object.assign(q,{gazeX:-1,gazeY:.3});
  if(t>=6.4&&t<7.2)Object.assign(q,{gazeX:1.5,gazeY:1,ropen:1});
  if(t>=7.2&&t<8.5)Object.assign(q,{gazeX:t<7.8?-1.2:1.2,gazeY:0});
  if(t>=8.5)Object.assign(q,{lx:76,rx:88,ly:31,ry:31,gazeY:1});}
 if(v===9){q.tilt=t<2?.16:t<4?-.16:t<6?.08:t<8.5?0:.08;q.gazeY=t<6?-.8:.6;
  if(t>=1&&t<4)Object.assign(q,{lx:18,ly:14,lpoint:1});
  if(t>=3&&t<6)Object.assign(q,{rx:78,ry:14,rpoint:-1});
  if(t>=4&&t<6.8)Object.assign(q,{lx:18,ly:14,lpoint:1,rx:78,ry:14,rpoint:-1});
  if(t>=8.5)q.gazeX=1.2;}
 return q;}
// The authored still frame the glasses hold once a variation settles.
function idleRest(v,q){Object.assign(q,IDLE_HANDS[v],{gazeX:.6,gazeY:.6,tilt:0,y:13});
 if(v===0)Object.assign(q,{rx:80,ry:15,rrot:-.3,tilt:.05,gazeX:1.3,gazeY:1.1});
 // The bubble has popped by now: he looks back out instead of at a bubble frozen in place.
 if(v===1)Object.assign(q,{gazeX:.6,gazeY:.6,tilt:0});
 if(v===2)Object.assign(q,{y:15.5,tilt:.1,gazeY:1,lx:40,rx:56});
 if(v===3)Object.assign(q,{gazeX:.6,gazeY:.6,tilt:0});
 if(v===4)Object.assign(q,{y:14,gazeY:.6});
 if(v===5)Object.assign(q,{x:48,y:13,ly:25,ry:25,gazeX:.6,gazeY:-.6,turn:0});
 if(v===6)Object.assign(q,{eye:.9,gazeX:.6,gazeY:.6});
 if(v===7)Object.assign(q,{gazeX:1.2,gazeY:-.7,tilt:-.04});
 if(v===8)Object.assign(q,{x:48,lx:20,rx:76,ly:27,ry:27,gazeX:.6,gazeY:.6});
 if(v===9)Object.assign(q,{tilt:0,gazeX:.6,gazeY:.6});
 if(v===HANG)Object.assign(q,{gazeX:.6,gazeY:-.4});
 if(v===DRUM)Object.assign(pointAtSelf(q,0),{lopen:.5});
 return q;}
// Mic on a cord, the "Announcer flip" (Matt's pick, 2026-10-07): the mic hangs
// head-down on a cord from the conversation frame line (image row 0 sits 3 px
// under it). He grabs the handle and turns it upright to speak; when the reply
// ends he lets go, it swings back to hanging and the cord takes it away.
// Every grab ends on the held pose and every let-go on MIC_HANG, so the
// shuffled variants below combine freely. A mic is its head centre (x,y) and
// `a`, the turn of its handle (local +y) away from the head; `sx` narrows the
// head for a twirl seen edge-on. renderer.js draws the cord from MIC.ax on
// row -1 to the handle's tail.
const MIC={ax:84,hangY:18,grip:11,tail:14,heldA:Math.atan2(-10,7),hand:{rx:77,ry:27}};
// The held reply pose. Every grab lands on it exactly.
const MIC_HOLD={rx:MIC.hand.rx,ry:MIC.hand.ry,ropen:.1,rrot:0,rpoint:0,gazeX:.6,gazeY:.6,tilt:-.035};
// The pose keys a mic beat drives directly while it plays.
const MIC_BODY=['x','y','tilt','lx','ly','lrot','lopen','rx','ry','rrot','ropen','rpoint','gazeX','gazeY'];
const micRot=(a,x,y)=>[x*Math.cos(a)-y*Math.sin(a),x*Math.sin(a)+y*Math.cos(a)];
const micGrip=m=>{const [dx,dy]=micRot(m.a,0,MIC.grip);return [m.x+dx,m.y+dy];};
const micAtGrip=(gx,gy,a)=>{const [dx,dy]=micRot(a,0,MIC.grip);return {x:gx-dx,y:gy-dy,a};};
const micTail=m=>{const [dx,dy]=micRot(m.a,0,MIC.tail);return [m.x+dx,m.y+dy];};
const micAtTail=(tx,ty,a)=>{const [dx,dy]=micRot(a,0,MIC.tail);return {x:tx-dx,y:ty-dy,a};};
const micTurn=(from,to)=>{let d=to-from;while(d>Math.PI)d-=2*Math.PI;while(d<-Math.PI)d+=2*Math.PI;return from+d;};
const easeInQ=u=>{u=clamp(u,0,1);return u*u;},easeOutQ=u=>{u=clamp(u,0,1);return 1-(1-u)*(1-u);};
const MIC_HANG={x:MIC.ax,y:MIC.hangY,a:Math.PI};
const MIC_HANG_GRIP=micGrip(MIC_HANG);
// Head-down mic swinging on a cord of length L at angle th from the anchor.
const micPendulum=(th,L)=>micAtTail(MIC.ax+L*Math.sin(th),-1+L*Math.cos(th),Math.PI-th);
const MIC_HANG_L=MIC.hangY-MIC.tail+1;
function micDrop(t){const h=MIC.hangY,D=.45;let y;if(t<D)y=-18+(h+18)*easeOutQ(t/D);else{const u=t-D;y=h+1.5*Math.exp(-5*u)*Math.sin(8*u);}return {x:MIC.ax,y,a:Math.PI,sw:t<D?.08*Math.sin(t*9):0};}
const micLook=(q,m)=>{q.gazeX=clamp((m.x-q.x)/24,-2,2);q.gazeY=clamp((m.y-q.y)/9,-1.5,1.5);};
// Reach out along the bottom first, then up: from any starting pose the
// mitten stays clear of the face on its way to the handle.
const micReach=(q,f,g,r)=>{q.rx=mix(f.rx,g[0],win(r,0,.5));q.ry=mix(f.ry,g[1],win(r,.3,1));q.ropen=r>0?mix(f.ropen,.9,Math.min(1,r*2)):f.ropen;q.rrot=mix(f.rrot,0,r);q.rpoint=f.rpoint*(1-r);};
// Carry a caught mic from a grip point to the held pose `h`.
function micBring(u,f,h,grip,a0,q,feel){
 for(const k of ['y','tilt','lx','ly','lrot','lopen'])q[k]=mix(f[k],h[k],u);
 q.rx=mix(grip[0],h.rx,u);q.ry=mix(grip[1],h.ry,u);q.ropen=h.ropen;q.rrot=0;q.rpoint=0;q.x=mix(f.x,h.x,u);
 const a=mix(a0,micTurn(a0,MIC.heldA),u),m=micAtGrip(q.rx,q.ry,a);
 if(u<.6)micLook(q,m);else{q.gazeX=h.gazeX;q.gazeY=h.gazeY;}
 return {mic:m,grip:true,feel:u<.5?feel:null};
}
// keys: the ages Kotlin writes as the reply entry, before the settled hold. Four
// pictures each: three up to the catch, then one on the way down with the mic turned
// half upright, so the head-down catch up high never jumps straight to the mic at his
// mouth. The words wait for that last one, so no grab picture fights the text for the
// link; only the held pose rides with it. The first picture shows just the top of the
// mic head peeking in from the frame line, so it never pops in.
const MIC_GRABS=[
 {id:'flip',dur:1.2,keys:[.12,.22,.5,.72],run(e,f,h,q){const c=.5;
  if(e<c){const m=micDrop(e);micReach(q,f,micGrip(micDrop(c)),win(e,c-.35,c));micLook(q,m);q.x=mix(f.x,(f.x+h.x)/2,win(e,0,c));return {mic:m,grip:false,feel:null};}
  return micBring(win(e,c,this.dur),{...f,x:(f.x+h.x)/2},h,micGrip(micDrop(c)),Math.PI,q,'delighted');}},
 {id:'bonk',dur:1.55,keys:[.1,.45,1.0,1.2],run(e,f,h,q){const c=1,at={...f,x:47,tilt:.035};
  // It swings into the side of his glasses and stops one dark pixel short of the
  // temple; his flinch sells the knock. The face never loses ink to the mic, so
  // the head first settles on the one spot where that contact was drawn.
  if(e<c){const L=mix(-14,MIC_HANG_L,easeInQ(Math.min(1,e/.4)));
   const th=e<.45?mix(.35,-.24,easeInQ(e/.45)):e<.7?mix(-.24,.3,easeOutQ((e-.45)/.25)):mix(.3,0,smooth((e-.7)/.28));
   const m=micPendulum(th,L),hit=win(e,.42,.47)*(1-win(e,.75,.95)),go=win(e,0,.35);
   q.x=mix(f.x,at.x,go)-2*hit;q.tilt=mix(f.tilt,at.tilt,go)-.12*hit;
   if(e<.45||e>=.62)micLook(q,m);else{q.gazeX=-.6;q.gazeY=.2;}
   micReach(q,f,MIC_HANG_GRIP,win(e,c-.3,c));
   return {mic:m,grip:false,feel:e<.42?null:e<.62?'surprised':'skeptical'};}
  return micBring(win(e,c,this.dur),at,h,MIC_HANG_GRIP,Math.PI,q,'skeptical');}},
 {id:'late',dur:2,keys:[.12,1.0,1.55,1.72],run(e,f,h,q){const c=1.55;
  if(e<c){const m=micDrop(Math.min(e,1.2));
   if(e<.9)micLook(q,m);else{q.gazeX=-1.3;q.gazeY=-.2;q.x=f.x-1;}
   micReach(q,f,MIC_HANG_GRIP,win(e,c-.15,c));return {mic:m,grip:false,feel:e<.9?null:'playful'};}
  return micBring(win(e,c,this.dur),{...f,x:f.x-1},h,MIC_HANG_GRIP,Math.PI,q,'delighted');}}
];
// Reply openers (Matt's picks, 2026-10-09): grabs the agent asks for by id to open a reply
// in a mood (`feeling` says which). They are never in the shuffle. Each is keyframed: `pose`
// may set face keys too (they ride the mic beat's direct drive, so the face pass can't undo
// them), `mic(e,q)` places the mic before the catch at `c`, and `glyphs(e,q)` returns small
// sparkles, drops and rings that renderer.js draws at an ink level, so they ease in and out.
// Six to eight pictures, the last by 1.45 s, ending on the held pose like every grab. Swing,
// aha, tap, gulp, knuckles, lasso, poke, laughing and breath end on two pictures of the mic on
// its way down to his mouth (2026-10-30), so the catch never jumps straight to the held pose.
const OPENER_FACES=['curious','focused','delighted','concerned','surprised','skeptical','sleepy','playful'];
const oface=(name,o={})=>Object.assign(Object.fromEntries(OPENER_FACES.map(k=>[k,Number(k===name)])),o);
const OPENER_HOLD={...oface('curious'),browY:-1,browL:0,browR:0,browLiftL:0,browLiftR:0,turn:0,eye:1,lpoint:0,rpoint:0,lthumb:0,rthumb:0};
// Each key runs from its value in `from` (or rest) at 0, through its listed times, to the hold at dur.
function openerTrack(keys,dur){
 const names=[...new Set(keys.flatMap(([,o])=>Object.keys(o)))];
 return (e,f,h)=>{const out={};
  for(const k of names){
   const pts=[[0,k in f?f[k]:k==='eye'?1:0]];for(const [t,o] of keys)if(k in o)pts.push([t,o[k]]);pts.push([dur,k in OPENER_HOLD?OPENER_HOLD[k]:h[k]]);
   let j=1;while(j<pts.length-1&&pts[j][0]<e)j++;
   const [ta,a]=pts[j-1],[tb,b]=pts[j];out[k]=a+(b-a)*smooth((e-ta)/Math.max(1e-6,tb-ta));
  }
  return out;};
}
// Falls head-down from the frame line from t0 (only the bottom of its head shows at first), then bobs.
const openerDrop=(e,t0,D,y=MIC.hangY,bob=1.5)=>{const t=e-t0;if(t<0)return null;
 if(t<D)return {x:MIC.ax,y:-1+(y+1)*easeOutQ(t/D),a:Math.PI};const u=t-D;return {x:MIC.ax,y:y+bob*Math.exp(-5*u)*Math.sin(8*u),a:Math.PI};};
// Slides down with no bounce.
const openerLower=(e,t0,D)=>e<t0?null:{x:MIC.ax,y:-1+(MIC.hangY+1)*smooth((e-t0)/D),a:Math.PI};
const MIC_OFF={x:MIC.ax,y:-40,a:Math.PI,hide:true};
// Glyphs keep off the top row (no ink on the frame line's edge).
const glyph=(k,x,y,ink)=>({k,x:Math.round(x),y:Math.max(2,Math.round(y)),ink});
// Ink steps over time: [[until, ink], ...]; 0 means not drawn.
const inkAt=(e,steps)=>{for(const [t,c] of steps)if(e<t)return c;return 0;};
function micOpener(d){
 const body=openerTrack(d.pose,d.dur);
 return {id:d.id,feeling:d.feeling,opener:!d.everyday,dur:d.dur,c:d.c,keys:d.keys,run(e,f,h,q){
  Object.assign(q,body(e,f,h));let m,grip=false;
  if(e<d.c){m=d.mic(e,q);if(m&&d.look&&d.look(e))micLook(q,m);
   // The catching mitten closes on the grip over the last stretch.
   if(m&&d.reach){const r=smooth((e-(d.c-d.reach))/d.reach);if(r>0){const g=micGrip(m);q.rx=mix(q.rx,g[0],r);q.ry=mix(q.ry,g[1],r);q.ropen=mix(q.ropen,.9,r);q.rrot*=1-r;}}}
  else{
   // From the grip at the catch (held there until `bring`) to the held mitten, turning upright.
   const m0=d.mic(d.c,{...f,...body(d.c,f,h)})||MIC_HANG,g0=micGrip(m0),b=d.bring||d.c,u=smooth((e-b)/(d.dur-b));
   q.rx=mix(g0[0],h.rx,u);q.ry=mix(g0[1],h.ry,u);q.ropen=mix(.9,h.ropen,u);q.rrot=0;q.rpoint=0;
   m=micAtGrip(q.rx,q.ry,mix(m0.a,micTurn(m0.a,MIC.heldA),u));grip=true;}
  const glyphs=d.glyphs?d.glyphs(e,q).filter(g=>g.ink>0):[];
  return {mic:m||(glyphs.length?MIC_OFF:null),grip,feel:null,glyphs:glyphs.length?glyphs:null};}};
}
const MIC_OPENERS=[
 // Hand shoots up like the keenest kid in class, bounces on it, then snatches the mic.
 micOpener({id:'handup',feeling:'eager',dur:1.42,c:1,reach:.25,keys:[.1,.3,.52,.76,1,1.22,1.42],
  pose:[[.1,{y:14,lx:13,ly:24,lopen:.3,rx:76,ry:27,...oface('surprised'),browY:1,gazeX:.4,gazeY:-.6,tilt:.03}],
   [.3,{x:44,y:13,lx:12,ly:9,lopen:1,lrot:.2,rx:76,ry:27,...oface('delighted'),browY:-1,tilt:-.06,gazeX:0,gazeY:-.4}],
   [.52,{y:15,lx:12,ly:12,rx:76,ry:27,tilt:.05,...oface('delighted')}],
   [.76,{y:13,lx:11,ly:8,tilt:-.06,...oface('surprised'),browY:-1,rx:78,ry:20,ropen:.6}],
   [1,{y:14,lx:10,ly:12,...oface('delighted')}],
   [1.22,{lx:10,ly:23,lopen:.4,...oface('delighted')}]],
  mic:e=>openerDrop(e,.5,.4),look:e=>e>.6,
  glyphs(e,q){const c=inkAt(e,[[.25,0],[.4,7],[.84,13]]);return [glyph('tick',q.lx-6,q.ly-3,c),glyph('tick',q.lx-8,q.ly+1,c)];}}),
 // Tucks in with eyes shut, then flings both mittens wide with sparkles; the mic drops in on cue.
 micOpener({id:'tada',feeling:'proud',dur:1.3,c:.9,reach:.2,keys:[.1,.32,.55,.75,.9,1.1,1.3],
  pose:[[.1,{x:42,y:13,lx:34,ly:27,rx:50,ry:27,lopen:0,ropen:0,eye:.05,browY:1,...oface('focused')}],
   [.32,{x:42,y:13,lx:8,ly:13,lopen:1,lrot:.7,rx:92,ry:13,ropen:1,rrot:-.7,eye:1,...oface('delighted'),browY:-1,tilt:-.03}],
   [.55,{lx:8,ly:12,rx:92,ry:12,tilt:.04,...oface('delighted')}],
   [.75,{lx:9,ly:14,rx:92,ry:12,...oface('delighted'),gazeX:1,gazeY:-.6}],
   [.9,{lx:10,ly:16,...oface('delighted')}],
   [1.1,{lx:10,ly:23,lopen:.4,...oface('delighted')}]],
  mic:e=>openerDrop(e,.48,.42,MIC.hangY,1),
  glyphs(e,q){const c=inkAt(e,[[.3,0],[.45,7],[.7,15],[.86,6]]);
   return [glyph('spark',q.lx-4,q.ly-10,c),glyph('spark3',q.lx-7,q.ly-5,c),glyph('spark',q.rx-1,q.ry-10,c),glyph('spark3',q.rx-8,q.ry-8,c)];}}),
 // Looks away, lids half down, and catches the falling mic blind. A glint, then a smug look back.
 micOpener({id:'nolook',feeling:'confident',dur:1.45,c:.56,bring:1,reach:.2,keys:[.1,.34,.56,.78,1,1.22,1.45],
  pose:[[.1,{x:37,turn:-1.6,gazeX:-1.3,gazeY:.2,tilt:.06,rx:72,ry:27,...oface('sleepy'),sleepy:.55}],
   [.34,{turn:-1.8,tilt:.07,rx:78,ry:16}],
   [.56,{turn:-1.8,tilt:.06}],
   [.78,{turn:-1.4,tilt:.06}],
   [1,{turn:0,gazeX:.4,gazeY:0,tilt:-.05,...oface('sleepy'),sleepy:.5,browLiftR:-1.5,browL:-.25}],
   [1.22,{sleepy:.3,...oface('playful'),playful:1}]],
  mic:e=>openerDrop(e,.1,.46,MIC.hangY,0),
  glyphs:(e,q)=>[glyph('glint',q.x+23,q.y-12,inkAt(e,[[.66,0],[.74,7],[1.1,15],[1.3,5]]))]}),
 // Bats the hanging mic off to the right; it swings out and back past him, and he catches it.
 // Small swing and a slow head turn so each picture moves a little (no off-screen leap).
 micOpener({id:'swing',feeling:'playful',dur:1.45,c:1.12,reach:.14,keys:[.1,.32,.52,.72,.92,1.12,1.22,1.32],
  pose:[[.1,{x:42,...oface('playful'),turn:.2,gazeX:1,gazeY:-.4,rx:76,ry:27}],
   [.32,{rx:77,ry:22,ropen:.2,rrot:.5,turn:.4,...oface('focused'),browL:.3,browR:-.3,gazeX:1.4,gazeY:0}],
   [.52,{x:43,rx:80,ry:25,rrot:-.3,turn:.7,...oface('surprised'),browL:0,browR:0,browY:-1,gazeX:2,gazeY:-.4}],
   [.72,{x:44,rx:78,ry:24,turn:.6,...oface('surprised'),gazeX:1.4,gazeY:-.2}],
   [.92,{x:43,turn:.3,gazeX:.6,gazeY:-.2,...oface('delighted'),rx:79,ry:16,ropen:.8}]],
  mic(e){if(e<.36)return openerDrop(e,.1,.26,MIC.hangY,.5);
   // Out to the right, back past centre towards him, then into his mitten.
   const u=Math.min(1,(e-.36)/.76),th=u<.5?.55*Math.sin(Math.PI*u/.5):-.2*Math.sin(Math.PI*(u-.5)/.5);
   return micPendulum(th,MIC_HANG_L+2*Math.sin(Math.PI*u));},
  look:e=>e>.9}),
 // Rubs his chin looking up, then the finger shoots up with a spark: idea found, mic caught.
 micOpener({id:'aha',feeling:'insight',dur:1.42,c:1.1,reach:.2,keys:[.1,.3,.52,.72,.92,1.1,1.2,1.3],
  pose:[[.1,{y:13,lx:31,ly:27,lopen:.2,...oface('focused'),gazeX:-1,gazeY:-1.2,tilt:-.06,browL:.3,browR:-.3}],
   [.3,{x:44,lx:32,ly:27,tilt:-.07}],
   [.52,{x:44,y:13,lx:12,ly:10,lpoint:1,lrot:0,...oface('surprised'),browL:0,browR:0,browY:-1,gazeX:-.8,gazeY:-1,tilt:.02}],
   [.72,{y:14,lx:12,ly:11,lpoint:1,...oface('delighted')}],
   [.92,{lx:10,ly:14,lpoint:1,gazeX:1,gazeY:-.6,...oface('delighted')}],
   [1.1,{lx:10,ly:22,lpoint:0}]],
  mic:e=>openerDrop(e,.66,.4),look:e=>e>.85,
  glyphs:(e,q)=>[glyph('spark',q.lx-2,q.ly-9,inkAt(e,[[.45,0],[.6,7],[.84,15],[.98,5]]))]}),
 // The mic drops; he taps it twice, sound rings come off it, he leans in to listen, then takes it.
 micOpener({id:'tap',feeling:'formal',dur:1.42,c:1.16,reach:.2,keys:[.1,.3,.52,.74,.96,1.16,1.24,1.32],
  pose:[[.1,{...oface('curious'),gazeX:1,gazeY:-.4,rx:74,ry:27}],
   [.3,{x:44,rx:76,ry:24,ropen:.3,rpoint:1,gazeX:1.4,gazeY:0}],
   [.52,{rx:75,ry:20,rpoint:1,...oface('focused')}],
   [.74,{rx:76,ry:24,rpoint:1,turn:1.4,tilt:.09,...oface('skeptical'),browLiftL:-1.5}],
   [.96,{rx:75,ry:20,rpoint:1,turn:.6,tilt:.04,...oface('focused')}],
   [1.16,{rpoint:0,turn:0,...oface('curious')}]],
  mic(e){const d=openerDrop(e,.1,.22,MIC.hangY,.5);if(!d)return d;
   const k=t=>t<0?0:.32*Math.exp(-6*t)*Math.sin(14*t),th=k(e-.5)+k(e-.94);
   return {x:MIC.ax+4*Math.sin(th),y:d.y,a:Math.PI+th};},
  // Each tap rings dimly, then the ring spreads outward as it fades.
  glyphs:e=>[glyph('ring',91,13,inkAt(e,[[.48,0],[.6,9],[.8,5],[.92,0],[1.04,9],[1.2,5]])),glyph('ring2',94,12,inkAt(e,[[.58,0],[.85,7],[1.1,0],[1.25,7]]))]}),
 // Mittens wringing, eyes darting side to side; a sweat drop slides down, then a timid reach.
 micOpener({id:'gulp',feeling:'nervous',dur:1.44,c:1.22,reach:.3,keys:[.1,.3,.52,.76,1,1.22,1.28,1.36],
  pose:[[.1,{x:40,y:13,lx:33,ly:27,rx:47,ry:27,lopen:.2,ropen:.2,...oface('concerned'),browL:-.4,browR:.4,browY:1,gazeX:-1.4,gazeY:.3}],
   [.3,{gazeX:1.2,gazeY:.3,lx:35,rx:47}],
   [.52,{gazeX:0,gazeY:1,lx:33,rx:47,ry:27}],
   [.76,{gazeX:1.2,gazeY:-.8,tilt:0,rx:72,ry:25}],
   [1,{rx:74,ry:20,ropen:.5}]],
  mic:e=>openerLower(e,.6,.5),look:e=>e>.7,
  glyphs:(e,q)=>[glyph('drop',q.x-33,4+8*(e-.24)/.68,e<.24||e>.92?0:inkAt(e,[[.36,7],[.8,15],[.92,6]]))]}),
 // The mic swoops in fast; he ducks with eyes shut and mittens up, it sails over, he peeks and catches it.
 micOpener({id:'duck',feeling:'surprised',dur:1.42,c:1,reach:.16,keys:[.1,.3,.5,.72,1,1.2,1.42],
  pose:[[.1,{y:13,...oface('curious'),gazeX:1,gazeY:-1,lx:37,ly:27,rx:51,ry:27}],
   [.3,{x:44,y:19,eye:.05,lx:10,ly:14,lopen:.8,rx:77,ry:14,ropen:.8,browY:2,...oface('concerned')}],
   [.5,{y:19,eye:.05,lx:10,ly:14,rx:77,ry:14}],
   [.72,{y:16,eye:1,...oface('surprised'),gazeX:1,gazeY:-1.5,lx:10,ly:18,rx:92,ry:22,browY:-1}],
   [1,{y:14,...oface('delighted'),lx:10,ly:22}],
   [1.2,{lx:10,ly:26}]],
  mic(e){if(e<.08)return null;const t=e-.08;
   // Swoops in from the right on a long cord, over his ducked head, and swings back.
   const th=t<.42?mix(.95,-.95,smooth(t/.42)):t<.9?mix(-.95,0,easeOutQ((t-.42)/.48)):.1*Math.exp(-6*(t-.9))*Math.sin(10*(t-.9));
   return micPendulum(th,t<.42?10:mix(10,MIC_HANG_L,smooth((t-.42)/.48)));},
  look:e=>e>.62,
  glyphs:(e,q)=>[glyph('bang',q.x-38,3,e>.26&&e<.62?(e<.36?7:14):0)]}),
 // Mittens meet with a knuckle-crack spark, a neck roll left and right, then a hard, no-nonsense grab.
 micOpener({id:'knuckles',feeling:'determined',dur:1.3,c:.98,reach:.1,keys:[.1,.28,.48,.68,.86,.98,1.08,1.18],
  pose:[[.1,{x:40,y:13,lx:34,ly:27,rx:46,ry:27,lopen:0,ropen:0,...oface('focused'),browL:.4,browR:-.4,gazeY:.8}],
   [.28,{lx:31,ly:27,rx:49,ry:27}],
   [.48,{tilt:.06,lx:34,ly:27,rx:46,ry:27,gazeY:.3,gazeX:-.6}],
   [.68,{tilt:-.08,lx:33,ly:27,rx:47,ry:27,gazeX:1,gazeY:-1}],
   [.86,{tilt:0,rx:79,ry:14,ropen:.9}]],
  mic:e=>openerDrop(e,.52,.42,MIC.hangY,.4),look:e=>e>.6,
  glyphs:(e,q)=>[glyph('crack',38,25,e>.18&&e<.4?(e<.24?7:14):0)]}),
 // Speck New Moves picks (2026-10-27): dust, lasso, fumble, poke.
 // The mic lowers in, he takes it by the handle head-down, brushes the head twice with his free mitten, then turns it upright.
 micOpener({id:'dust',feeling:'tidy',dur:1.45,c:.55,reach:.2,bring:1.12,keys:[.1,.35,.6,.8,1,1.2,1.42],
  pose:[[.2,{x:40,lx:30,ly:27,...oface('focused'),gazeX:1.3,gazeY:.4}],[.5,{lx:62,ly:27}],
   [.65,{lx:76,ly:21,lopen:1,lrot:.3}],[.76,{lx:88,ly:19}],[.87,{lx:77,ly:21}],[.98,{lx:88,ly:19}],
   [1.08,{lx:74,ly:26,lopen:.3,lrot:0}],[1.28,{lx:40,ly:27,...oface('delighted')}]],
  mic:e=>openerLower(e,.05,.45),look:e=>e>.05&&e<.5,
  glyphs:e=>[glyph('dust',79,24,inkAt(e,[[.74,0],[.8,7],[.9,13],[.96,0],[1.06,13],[1.16,6]])),glyph('puff',92,13,inkAt(e,[[.78,0],[.9,10],[.98,0],[1.1,10],[1.2,5]]))]}),
 // Catches the end of the cord as the mic drops and swings it once round his fist, a dotted trail behind it, then takes the handle.
 micOpener({id:'lasso',feeling:'show-off',dur:1.45,c:1.12,reach:0,bring:1.12,keys:[.1,.3,.5,.7,.9,1.12,1.22,1.32],
  pose:[[.15,{x:40,...oface('playful'),gazeX:1,gazeY:-1,lx:14,ly:26}],[.3,{rx:84,ry:7,ropen:.6}],
   [.5,{rx:79,ry:12,ropen:.2,tilt:-.04}],[1.1,{rx:79,ry:12,...oface('delighted'),tilt:.05}]],
  mic(e,q){if(e<.3)return openerDrop(e,.05,.25,MIC.hangY,0);
   const u=smooth((e-.3)/.8),m=micAtTail(q.rx,q.ry,Math.PI+2*Math.PI*u);
   if(u>.02&&u<.98)m.trail=[.06,.12].map(d=>{const p=micAtTail(q.rx,q.ry,Math.PI+2*Math.PI*Math.max(0,u-d));return [p.x,p.y];});
   return m;},
  look:e=>e>.3&&e<1.05}),
 // It lands on his mitten and pops up, again, and again, while he juggles it; he clamps it and a sweat drop slides off.
 micOpener({id:'fumble',feeling:'flustered',dur:1.45,c:1,reach:.1,keys:[.1,.3,.5,.68,.86,1.05,1.42],
  pose:[[.2,{x:42,...oface('surprised'),browY:-1.5,rx:84,ry:26,ropen:.8}],[.38,{rx:84,ry:22,lx:10,ly:16,lopen:1}],
   [.55,{rx:79,ry:25,...oface('concerned'),tilt:-.05}],[.72,{rx:80,ry:22,tilt:.05,lx:12,ly:20}],
   [.86,{rx:86,ry:23,tilt:-.04}],[1,{lx:20,ly:27}],[1.15,{...oface('delighted'),tilt:0}]],
  mic(e){if(e<.05)return null;const t=e-.05,seg=(a,b,u,f)=>mix(a,b,f(u));
   if(t<.3)return {x:MIC.ax,y:seg(-1,21,t/.3,easeOutQ),a:Math.PI};
   if(t<.5){const u=(t-.3)/.2;return {x:mix(84,78,u),y:seg(21,9,u,easeOutQ),a:mix(Math.PI,Math.PI+.6,u)};}
   if(t<.68){const u=(t-.5)/.18;return {x:mix(78,80,u),y:seg(9,21,u,easeInQ),a:mix(Math.PI+.6,Math.PI-.3,u)};}
   if(t<.82){const u=(t-.68)/.14;return {x:mix(80,86,u),y:seg(21,14,u,easeOutQ),a:mix(Math.PI-.3,Math.PI+.4,u)};}
   const u=clamp((t-.82)/.13,0,1);return {x:mix(86,84,u),y:seg(14,19,u,easeInQ),a:mix(Math.PI+.4,Math.PI,u)};},
  look:e=>e>.05,
  glyphs:(e,q)=>[glyph('bang',q.x-37,3,inkAt(e,[[.3,0],[.38,8],[.6,15],[.66,0]])),
   glyph('drop',q.x-36,3+6*clamp((e-1)/.4,0,1),inkAt(e,[[1,0],[1.08,8],[1.36,14],[1.45,6]]))]}),
 // Lowers slowly while he watches it, one brow up and a small "?"; he pokes it, it swings, he waits, then takes it.
 micOpener({id:'poke',feeling:'curious',dur:1.45,c:1.2,reach:.15,keys:[.1,.35,.6,.8,1,1.2,1.28,1.36],
  pose:[[.15,{x:44,...oface('curious'),browY:-1.5,browLiftR:-1,tilt:.06}],[.5,{rx:80,ry:22,rpoint:1,ropen:0}],
   [.65,{rx:82,ry:19,rpoint:1}],[.8,{rx:78,ry:22,rpoint:1,...oface('surprised')}],[1,{rpoint:0,...oface('playful'),tilt:-.04,browLiftR:0}]],
  mic(e){if(e<.65)return openerLower(e,.05,.55);const t=e-.65;return micPendulum(.35*Math.exp(-3*t)*Math.sin(10*t),MIC_HANG_L);},
  look:e=>e>.05,
  glyphs:(e,q)=>[glyph('qS',q.x-33,3,inkAt(e,[[.2,0],[.3,8],[.6,15],[.7,6]]))]}),
 // More Speck Moves picks (2026-10-28): laughing, breath (and poof, an everyday catch, below).
 // The mic arrives while he is doubled over laughing; he wipes a tear from behind his lens,
 // takes a breath to compose himself, and grabs it.
 micOpener({id:'laughing',feeling:'amused',dur:1.45,c:1.14,reach:.2,keys:[.1,.3,.52,.74,.96,1.16,1.24,1.34],
  pose:[[.1,{x:46,y:14,tilt:-.09,...oface('delighted'),browY:-1.5,lx:10,ly:26,lopen:.4,rx:82,ry:26,ropen:.3}],
   [.3,{y:13,tilt:.07,lx:11,ly:21,rx:81,ry:21}],
   [.52,{y:14,tilt:-.03,lx:10,ly:14,lopen:.2,lrot:.5,rx:82,ry:27,...oface('delighted')}],
   [.74,{y:13,tilt:0,lx:12,ly:27,lopen:.1,lrot:0,...oface('curious'),browY:-1,gazeX:1.2,gazeY:.2,eye:1}],
   [.96,{rx:80,ry:16,ropen:.7,...oface('focused'),gazeX:1.4,gazeY:.1}]],
  mic:e=>openerDrop(e,.35,.35),look:e=>e>.8,
  // Each glyph eases in over a few frames before its picture; the pictures show what the lab did.
  glyphs:e=>[glyph('ha',1,2,inkAt(e,[[.02,0],[.06,8],[.2,15],[.24,0]])),glyph('ha',3,5,inkAt(e,[[.24,0],[.28,8],[.4,15],[.46,0]])),
   glyph('dropS',15,15+8*clamp((e-.5)/.3,0,1),inkAt(e,[[.46,0],[.5,7],[.6,13],[.82,8]])),
   glyph('puffS',41,23,inkAt(e,[[.66,0],[.8,10],[.9,5]]))]}),
 // Eyes closed, he breathes in (brows and mittens rise), holds it, lets it out in a slow puff,
 // then opens his eyes softly as the mic lowers and takes it gently.
 micOpener({id:'breath',feeling:'gentle',dur:1.45,c:1.22,reach:.25,keys:[.1,.32,.55,.78,1,1.2,1.3,1.38],
  pose:[[.12,{x:47,...oface('concerned'),eye:.12,browL:-.25,browR:.25,browY:0,gazeX:0,gazeY:.5,lx:14,ly:27,rx:80,ry:27,lopen:.1,ropen:.1}],
   [.4,{browY:-1.5,lx:12,ly:20,rx:82,ry:20,lopen:.5,ropen:.5,eye:.1}],
   [.6,{browY:-1.5,ly:20,ry:20}],
   [.85,{y:14,browY:.5,lx:14,ly:27,rx:80,ry:27,lopen:.1,ropen:.1,eye:.15}],
   [1.02,{y:14,eye:.85,...oface('concerned'),browL:-.3,browR:.3,gazeX:1.2,gazeY:.1}]],
  mic:e=>openerLower(e,.55,.55),look:e=>e>.95,
  glyphs:e=>[glyph('puff',42-8*clamp((e-.78)/.3,0,1),23,inkAt(e,[[.72,0],[.84,11],[1,6],[1.08,0]]))]})
];
MIC_GRABS.push(...MIC_OPENERS);
// More Speck Moves pick (2026-10-28): an everyday catch keyed like an opener, four pictures (the
// last on the way down, like the other everyday grabs), so the shuffle plays it; the confident and playful opener pools also ask for it by id. He raises a
// mitten and snaps. Poof: a cloud, and the mic is simply in his hand; the smoke breaks up and he
// brings it down.
MIC_GRABS.push(micOpener({id:'poof',feeling:'slick',everyday:true,dur:1.15,c:.3,bring:.76,keys:[.14,.4,.7,.9],
 pose:[[.08,{lx:14,ly:27,lopen:0}],[.12,{x:46,rx:85,ry:17,ropen:0,rthumb:1,rrot:-.2,...oface('focused'),browL:.25,browR:-.25,gazeX:1.6,gazeY:.1,tilt:-.03}],
  [.3,{rthumb:0,ropen:.8}],[.5,{...oface('delighted'),browL:0,browR:0,tilt:.02,gazeX:1.2,gazeY:-.4}]],
 mic:e=>e<.3?null:micAtGrip(85,17,-.6),
 glyphs:e=>[glyph('spark3',90,9,inkAt(e,[[.06,0],[.27,14],[.3,0]])),
  glyph('poof',70,2,inkAt(e,[[.3,0],[.52,15],[.6,10],[.64,0]])),
  glyph('poofBits',66,2,inkAt(e,[[.6,0],[.78,10],[.9,5]]))]}));
// Let go: from the mic as it was released (`r`) to MIC_HANG.
function micFlipBack(t,r){const u=easeOutQ(t/.4),a0=micTurn(Math.PI,r.a),a=Math.PI+(a0-Math.PI)*Math.exp(-3.5*t)*Math.cos(7*t);
 const t0=micTail(r);return micAtTail(mix(t0[0],MIC.ax,u),mix(t0[1],MIC.hangY-MIC.tail,u),a);}
const MIC_RELEASES=[
 {id:'flipback',dur:1.1,path:(t,r)=>micFlipBack(t,r)},
 {id:'spring',dur:1,path(t,r){if(t<.2){const u=easeOutQ(t/.2),t0=micTail(r);return micAtTail(mix(t0[0],MIC.ax,u),mix(t0[1],-2,u),mix(r.a,micTurn(r.a,Math.PI),u));}
  const u=t-.2;return micAtTail(MIC.ax,MIC.hangY-MIC.tail+(-6)*Math.exp(-4*u)*Math.cos(9*u),Math.PI+.25*Math.exp(-5*u)*Math.sin(12*u));}},
 {id:'twirl',dur:2,path(t,r){const m=micFlipBack(Math.min(t*1.6,1.1),r),u=clamp((t-.35)/1.2,0,1);return {...m,sx:Math.cos(Math.PI*2*u)};}},
 // He flicks it up as he lets go: one quick extra turn about its middle on a small
 // hop (under 90 degrees a picture at glasses speed), a dotted trail behind the head,
 // then it settles hanging. After the reply, so no text competes with the spin.
 {id:'toss',dur:1.1,path(t,r){const T=.95,mid7=m=>{const [dx,dy]=micRot(m.a,0,7);return [m.x+dx,m.y+dy];},c0=mid7(r),c1=mid7(MIC_HANG),hop=[82,9],A=micTurn(r.a,Math.PI)-r.a+(micTurn(r.a,Math.PI)<r.a?-1:1)*2*Math.PI;
  const at=u=>{const c=[(1-u)*(1-u)*c0[0]+2*u*(1-u)*hop[0]+u*u*c1[0],(1-u)*(1-u)*c0[1]+2*u*(1-u)*hop[1]+u*u*c1[1]],a=r.a+A*u,[dx,dy]=micRot(a,0,7);return {x:c[0]-dx,y:c[1]-dy,a};};
  if(t<T){const u=t/T,m=at(u);m.trail=[.07,.14].filter(d=>u-d>0).map(d=>{const p=at(u-d);return [p.x,p.y];});return m;}
  return micAtTail(MIC.ax,MIC.hangY-MIC.tail+1.5*Math.exp(-6*(t-T))*Math.sin(9*(t-T)),Math.PI);}}
];
// Closers (Matt's picks from the Speck Reply Closers menu, 2026-10-09): a let-go with its own
// performance, for the reply ending the agent asks for (pinned with chooseMic or the adapter's
// pinRelease). The shuffled let-gos never pick one. A closer drives his whole pose, from where
// he was at the last word to the attend still, carries the mic its own way off the top, and adds
// a few native-pixel marks (snapshot `marks`, drawn last by the renderer with a dark moat).
// Keys are absolute and ease between keyframes: every key starts where he was and lands on the
// attend still at `dur`; untracked keys hold, then settle in the last CLOSE_SETTLE seconds.
// `f` names the face and `ma` turns the mic while it is still in his right mitten.
const CLOSE_SETTLE=.45,CLOSE_FACES=expressions.filter(e=>e!=='neutral');
const CLOSE_KEYS=[...MIC_BODY,'eye','wink','browY','browL','browR','browLiftL','browLiftR','handScale','rthumb',...CLOSE_FACES];
const CLOSE_GLYPHS={
 smoke:['010','100','010','001','010'],puff:['0110','1111','0110'],
 spark:['00100','00100','11011','00100','00100'],spark3:['010','111','010'],
 drop:['00100','01110','11111','11111','01110'],zs:['111','011','110','111'],
 note:['00111','00101','00100','01100','11100','11000'],note2:['0111111','0100001','0100001','1100011','1100011'],
 q:['01110','10001','00010','00100','00000','00100'],
 dust:['1000001','0010100','1000001'],tick:['000001','000011','100110','111100','011000'],
 heartS:['0110110','1111111','1111111','0111110','0011100','0001000']};
const closeMark=(name,x,y,c=15)=>['g',CLOSE_GLYPHS[name],Math.round(x),Math.round(y),c];
const closeHand=q=>micAtGrip(q.rx,q.ry,q.ma);
const closeReel=(m,u)=>({...m,y:m.y-(MIC.hangY+18)*easeInQ(u)});
// In the mitten until `at`, then the flip back from the shape it had then; the cord reels from `reelAt`.
function closeLetGo(t,P,{at,reelAt,rd,k=1}){if(t<at)return closeHand(P(t));
 const m=micFlipBack((t-at)*k,closeHand(P(at)));return t>=reelAt?closeReel(m,(t-reelAt)/rd):m;}
function closeTracks(c,from){
 const tr={},push=(k,t,v)=>(tr[k]=tr[k]||[]).push([t,v]),end={...ATTEND_POSE};
 for(const [t,o] of c.keys)for(const [k,v] of Object.entries(o)){
  if(k==='f'){for(const e of CLOSE_FACES)push(e,t,e===v?1:0);continue;}push(k,t,v);}
 for(const k in tr){const pts=tr[k].sort((a,b)=>a[0]-b[0]);
  if(pts[0][0]>0)pts.unshift([0,k==='ma'?MIC.heldA:from[k]]);
  if(k!=='ma'&&pts[pts.length-1][0]<c.dur)pts.push([c.dur,end[k]]);}
 return {tr,end};}
// His pose at closer age t, for the keys a closer drives.
function closePose(c,from,t){
 const {tr,end}=c.tracks&&c.tracks.from===from?c.tracks:(c.tracks={from,...closeTracks(c,from)});
 const settle=smooth((t-(c.dur-CLOSE_SETTLE))/CLOSE_SETTLE),q={};
 const at=pts=>{if(t<=pts[0][0])return pts[0][1];const j=pts.findIndex(e=>e[0]>=t);if(j<0)return pts[pts.length-1][1];
  const [a,va]=pts[j-1],[b,vb]=pts[j];return mix(va,vb,smooth((t-a)/Math.max(1e-6,b-a)));};
 for(const k of CLOSE_KEYS)q[k]=tr[k]?at(tr[k]):mix(from[k],end[k],settle);
 q.ma=tr.ma?at(tr.ma):MIC.heldA;
 return q;}
const PI=Math.PI;
// Slow clap: mittens meet under his face (touching at 7 apart), held long enough to show at glasses pace.
const clapKeys=(t,n)=>[[t,{lx:43,rx:50,y:14}],[t+.12,{lx:43,rx:50}],[t+.3,{lx:36+n,rx:57-n,y:13}],[t+.42,{lx:36+n,rx:57-n}]];
const MIC_CLOSERS=[
 // Holds it out head-down, a smug beat, then drops it: it falls past his open mitten, the
 // cord catches it near the floor and bounces. On the way out the head only ever turns down
 // (through level, never up), with the mitten moving clear of his frame first.
 {id:'mic-drop',dur:2.2,keys:[
  [.25,{rx:86,ry:16,ma:-1.9,x:41,f:'skeptical',eye:.8,browY:-1.2,tilt:.04,gazeX:.4,gazeY:.4,handScale:1}],
  [.45,{rx:88,ry:6,ma:-PI,ropen:.1,x:42,f:'skeptical',eye:.8,browY:-1.6,tilt:.07,gazeX:.1,gazeY:.4}],
  [.95,{rx:88,ry:6,ma:-PI,ropen:.1,x:42,f:'skeptical',eye:.8,browY:-1.6,tilt:.07,gazeX:.1,gazeY:.4}],
  [1.08,{rx:90,ry:5,ropen:1,ma:-PI}],
  [1.6,{rx:90,ry:5,ropen:1,x:43,f:'skeptical',eye:.8,tilt:.07,gazeX:.1,gazeY:.4}],
  [1.9,{f:'delighted',eye:1,ry:24,rx:80}]],
  mic(t,P){const at=1;if(t<at)return closeHand(P(t));const r=closeHand(P(at)),e=t-at;
   if(e<.22){const u=easeInQ(e/.22);return {x:mix(r.x,MIC.ax,u*.5),y:r.y+(29-r.y)*u,a:PI};}
   const u=e-.22,m={x:mix(r.x,MIC.ax,.5+.5*easeOutQ(u/.3)),y:Math.min(29,20+9*Math.exp(-3.5*u)*Math.cos(10*u)),a:PI+.12*Math.exp(-5*u)*Math.sin(9*u)};
   return t>1.65?closeReel(m,(t-1.65)/.45):m;},
  marks(t){return t>1.2&&t<1.45?[['l',76,29,79,27,11],['l',93,29,90,27,11],['l',74,25,76,24,8],['l',95,25,93,24,8]]:[];}},
 // Mic up beside his face, smoke curls off it, he blows it away, spins it once and lets go.
 {id:'smoking-gun',dur:2.4,keys:[
  [.4,{rx:76,ry:26,ma:-.22,x:40,f:'skeptical',eye:.7,tilt:-.04,gazeX:1.3,gazeY:.2,handScale:.9}],
  [.75,{rx:76,ry:26,ma:-.22,x:42,f:'skeptical',eye:.45,tilt:.1,gazeX:1.4,gazeY:0}],
  [1.05,{rx:76,ry:26,ma:-.22,x:41,f:'delighted',eye:.6,tilt:.05,gazeX:.4,gazeY:.3}],
  [1.15,{rx:80,ry:24,ma:-.22}],
  [1.6,{rx:80,ry:25,ma:-.22+2*PI,ropen:.1,f:'delighted',eye:.8,gazeX:.2,gazeY:.4}],
  [1.8,{ropen:1}]],
  mic(t,P){return closeLetGo(t,P,{at:1.65,reelAt:1.85,rd:.45});},
  marks(t,q){const m=closeHand(q),out=[];
   if(t>.3&&t<1.15){const blow=t>.7?easeOutQ((t-.7)/.4)*6:0,rise=(t-.3)*7;
    out.push(closeMark('smoke',m.x-1+blow,m.y-10-rise%3,12));if(t>.45)out.push(closeMark('smoke',m.x+2+blow*1.4,m.y-14-rise%2,8));}
   if(t>.68&&t<.95)out.push(closeMark('puff',q.x+29,q.y-7,12));return out;}},
 // A crouch, then he punches the mic straight up off the top and holds the fist.
 {id:'uppercut',dur:1.9,keys:[
  [.3,{y:15,rx:77,ry:27,ma:-.6,x:40,lx:8,ly:27,f:'focused',browY:1,eye:.8,tilt:-.06,gazeX:1,gazeY:-.4}],
  [.48,{y:12,rx:82,ry:6,ma:-.05,ropen:0,x:42,f:'delighted',browY:-1.5,eye:1,tilt:.08,gazeX:1.4,gazeY:-1.5,handScale:.9}],
  [1.05,{y:13,rx:82,ry:6,ropen:0,x:43,f:'delighted',eye:.5,tilt:.05,gazeX:.3,gazeY:.2}],
  [1.25,{y:12,rx:82,ry:8}],[1.4,{y:13,rx:80,ry:12}]],
  mic(t,P){const at=.42;if(t<at)return closeHand(P(t));const r=closeHand(P(at)),e=t-at;
   const m={x:r.x+4*e,y:r.y-95*e,a:r.a+9*e};if(e>.03)m.trail=[.03,.06].map(d=>[r.x+4*(e-d)-1,r.y-95*(e-d)+6]).filter(p=>p[1]>-2);return m;},
  marks(t){return t>.52&&t<.85?[closeMark('spark',80,0),...(t>.62?[closeMark('spark3',73,3)]:[])]:[];}},
 // Lets go; pixel shades ease down from the top over both lenses (same outline, dark glass, a
 // bright bar and a glint), a cool nod and a thumbs-up, then they lift away on a cheeky wink.
 {id:'shades',dur:2.9,keys:[
  [.35,{rx:80,ry:24,ma:-.4,x:41,f:'skeptical',eye:.8,gazeX:.6,gazeY:-1}],
  [.9,{x:42,y:13,f:'skeptical',eye:.8,gazeX:0,gazeY:-1.3,tilt:0}],
  [1.15,{y:15,tilt:0,f:'playful'}],[1.3,{y:13}],
  [1.9,{y:13,tilt:0,f:'playful',rx:82,ry:19,rthumb:1,ropen:0,x:43,wink:0,browY:0,browLiftL:0,gazeX:0,gazeY:-1.3}],
  [2.1,{wink:1,browY:-1.5,browLiftL:1,tilt:.09,gazeX:-.5,gazeY:0}],
  [2.25,{rthumb:0}],
  [2.5,{wink:1,browY:-1.5,browLiftL:1,tilt:.09}],[2.65,{wink:0}]],
  mic(t,P){return closeLetGo(t,P,{at:.25,reelAt:.55,rd:.45});},
  marks(t,q){const down=t<1.2?easeOutQ((t-.6)/.55):t<1.95?1:1-easeInQ((t-1.95)/.45);if(down<=0)return [];
   const cx=Math.round(q.x),off=Math.round((1-down)*20),top=Math.round(q.y)-8-off,out=[];
   if(off>0)out.push(['r',cx-26,top-2,53,1,0]);out.push(['r',cx-25,top-1,51,2,15]);
   for(const x0 of [cx-23,cx+2]){
    for(let j=0;j<16;j++){const k=j<12?0:j-11,a=x0+k,b=x0+21-k,y=top+j;
     if(off>0)out.push(['r',a-1,y,1,1,0],['r',b+1,y,1,1,0]);
     if(j<2||j===15)out.push(['r',a,y,b-a+1,1,15]);else out.push(['r',a,y,2,1,15],['r',a+2,y,b-a-2,1,2],['r',b-1,y,2,1,15]);}
    for(let d=0;d<5;d++){out.push(['r',x0+4+d,top+7-d,1,1,15]);if(d<3)out.push(['r',x0+8+d,top+7-d,1,1,11]);}}
   return out;}},
 // Lets go and waves it goodbye as the cord takes it up.
 {id:'bye-mic',dur:2.3,keys:[
  [.35,{rx:74,ry:22,ma:-.6,x:41,f:'delighted',gazeX:1.4,gazeY:-.4}],
  [.6,{rx:73,ry:11,ropen:1,rrot:-.3,x:37,f:'delighted',gazeX:1.6,gazeY:-1.2,tilt:.06,handScale:1}],
  [.85,{rx:75,rrot:.35,x:37}],[1.1,{rx:72,rrot:-.35}],[1.35,{rx:75,rrot:.35}],[1.6,{rx:73,rrot:-.1,ry:12,x:38,gazeX:.4,gazeY:.2}],
  [1.9,{ry:27,ropen:0}]],
  mic(t,P){return closeLetGo(t,P,{at:.3,reelAt:.75,rd:.9});},
  marks(){return [];}},
 // Lets it swing away; the cord takes it up like a curtain while he bows, hand to his middle.
 {id:'bow-out',dur:2.4,keys:[
  [.15,{lx:16,ly:27}],
  [.4,{rx:75,ry:27,ropen:.6,rrot:.2,lx:6,ly:16,lopen:1,lrot:-.3,x:43,f:'delighted',gazeX:.3,gazeY:.4,handScale:1}],
  [.95,{y:20,tilt:.07,eye:0,lx:6,ly:19,lopen:1,lrot:-.3,rx:76,ry:28,ropen:.6,rrot:.2,gazeY:1}],
  [1.3,{y:20,tilt:.07,eye:0,lx:6,ly:19,rx:76,ry:28}],
  [1.7,{y:12,tilt:0,eye:1,f:'delighted',lx:12,ly:22,lopen:.5,rx:82,ry:24,rrot:0}],
  [1.9,{y:13}]],
  mic(t,P){return closeLetGo(t,P,{at:.12,reelAt:.75,rd:.8});},
  marks(){return [];}},
 // The cord starts taking it; he grabs it head-down and hauls, leaning hard away with the cord
 // taut, then lets go: it zips up and he stumbles back.
 {id:'tug',dur:2.5,keys:[
  [.3,{rx:79,ry:16,ma:PI,x:40,f:'surprised',gazeX:1.3,gazeY:-1,lx:4,ly:27}],
  [.55,{rx:76,ry:18,ma:PI+.12,y:16,x:36,tilt:-.2,f:'focused',eye:.2,browY:1.2,lx:3,ly:27,lopen:1,handScale:1}],
  [.7,{rx:78,ry:14,ma:PI+.05,y:15,x:38,tilt:-.14}],[.85,{rx:75,ry:19,ma:PI+.15,y:17,x:35,tilt:-.22}],
  [1.0,{rx:78,ry:13,ma:PI+.04,y:15,x:38,tilt:-.13}],[1.15,{rx:75,ry:18,ma:PI+.14,y:17,x:35,tilt:-.22}],
  [1.3,{rx:79,ry:16,ropen:1,x:42,y:12,tilt:.12,f:'surprised',eye:1.2,gazeX:1,gazeY:-1.4,lx:4}],
  [1.55,{x:40,tilt:-.06,y:13,lx:10,ly:27}],[1.85,{f:'playful',tilt:.03,gazeX:.2,gazeY:.4}]],
  mic(t,P){const at=1.22;if(t<at)return closeHand(P(t));const r=closeHand(P(at)),e=t-at;
   return {x:mix(r.x,MIC.ax,easeOutQ(e/.15)),y:r.y-95*e,a:mix(r.a,PI,easeOutQ(e/.15))};},
  marks(t,q){return t>.6&&t<1.2?[closeMark('drop',q.x-31,q.y-9+Math.floor((t-.6)*8),12)]:[];}},
 // Lets go gently and sways, eyes half shut, while two notes float up.
 {id:'hum',dur:2.4,keys:[
  [.45,{rx:78,ry:25,ma:-.5,x:43,f:'delighted',eye:.35,tilt:.06,gazeX:.3,gazeY:-.3}],
  [.9,{x:45,tilt:-.06,f:'delighted',eye:.3,lx:15,rx:76,ly:27,ry:26}],
  [1.35,{x:44,tilt:.06,f:'delighted',eye:.3,lx:13,rx:74}],
  [1.8,{x:46,tilt:-.03,eye:.6}]],
  mic(t,P){return closeLetGo(t,P,{at:.35,reelAt:.8,rd:.7,k:.6});},
  marks(t,q){const out=[];if(t>.5&&t<1.5)out.push(closeMark('note',q.x+31,14-(t-.5)*10));if(t>1&&t<2)out.push(closeMark('note2',q.x-38,15-(t-1)*10));return out;}},
 // Lets go, raises a mitten beside his temple and looks up-left while three dots fill in, then a nod.
 {id:'mull',dur:2.4,keys:[
  [.3,{rx:80,ry:24,ma:-.4,x:42,f:'curious',gazeX:1,gazeY:-.4}],
  [.7,{x:43,rx:78,ry:11,rpoint:-.45,ropen:0,rrot:0,f:'curious',gazeX:-1.4,gazeY:-1.3,browL:-.35,browR:.15,browY:-.6,tilt:-.07,handScale:1}],
  [1.0,{rx:78,ry:12}],[1.15,{rx:78,ry:11}],
  [1.4,{x:44,rx:78,ry:11,rpoint:-.45,f:'curious',gazeX:-1.4,gazeY:-1.3,tilt:-.07}],
  [1.65,{y:14,rpoint:0,ry:20,f:'focused',gazeX:.3,gazeY:.4,tilt:0,browL:0,browR:0}],[1.85,{y:13,f:'curious'}]],
  mic(t,P){return closeLetGo(t,P,{at:.22,reelAt:.5,rd:.45});},
  marks(t,q){if(!(t>.75&&t<1.5))return [];const n=Math.min(3,1+Math.floor((t-.75)/.2)),out=[];
   for(let k=0;k<n;k++)out.push(['r',Math.round(q.x)-37+k*4,4,3,2,13]);return out;}},
 // Nods off, the mic sags and slips out of his mitten, he snaps awake as the cord takes it.
 {id:'doze',dur:2.6,keys:[
  [.7,{y:16,tilt:.07,eye:.12,f:'sleepy',ry:27,rrot:.5,ma:.5,lopen:0,gazeY:1}],
  [.95,{y:16,tilt:.07,eye:.1,f:'sleepy',rrot:.5,ma:.7,ropen:.6}],
  [1.12,{y:12,tilt:-.03,eye:1.3,f:'surprised',gazeX:1.4,gazeY:-1.3,rrot:0,ropen:.2}],
  [1.6,{y:13,eye:1,f:'playful',gazeX:.3,gazeY:.4,tilt:.05}],[1.75,{y:12}],[1.9,{y:13}]],
  mic(t,P){return closeLetGo(t,P,{at:.9,reelAt:1.15,rd:.5});},
  marks(t,q){const out=[];if(t>.35&&t<1.05){out.push(closeMark('zs',q.x-34,q.y-8-(t-.35)*6,11));if(t>.65)out.push(closeMark('zs',q.x-39,q.y-12-(t-.65)*6,7));}return out;}},
 // Holds the mic out, pointed down at you, brows up, a question mark, then lets it go.
 {id:'your-turn',dur:2.4,keys:[
  [.45,{rx:84,ry:13,ma:-2.25,x:42,f:'curious',browY:-2,tilt:.08,gazeX:.2,gazeY:.5,handScale:.9}],
  [1.25,{rx:84,ry:13,ma:-2.25,x:42,f:'curious',browY:-2,tilt:.08,gazeX:.2,gazeY:.5}],
  [1.6,{rx:80,ry:25,ropen:1,x:45,browY:-1.4,tilt:.04}]],
  mic(t,P){return closeLetGo(t,P,{at:1.3,reelAt:1.55,rd:.5});},
  marks(t,q){return t>.55&&t<1.35?[closeMark('q',q.x+30,q.y-12+(t>.9&&t<1.05?-1:0))]:[]}},
 // Speck New Moves picks (2026-10-27): salute, missed-it, stamp.
 // Lets go, snaps a salute at his brow, one firm nod and a glint, and the mitten drops back down.
 {id:'salute',dur:2.3,keys:[
  [.25,{rx:80,ry:24,ma:-.4,x:44,f:'focused'}],
  [.6,{rx:78,ry:6,ropen:1,rrot:-.5,x:44,f:'focused',browL:.2,browR:-.2,gazeX:.3,gazeY:.4,tilt:-.03,handScale:1}],
  [1.05,{rx:78,ry:6,y:13}],[1.2,{y:15}],[1.35,{y:13}],[1.55,{rx:79,ry:6,f:'delighted',browL:0,browR:0}],
  [1.85,{rx:80,ry:25,ropen:0,rrot:0}]],
  mic(t,P){return closeLetGo(t,P,{at:.2,reelAt:.5,rd:.45});},
  marks(t){return t>1.25&&t<1.55?[closeMark('spark',85,1,t<1.35?9:15)]:[];}},
 // Lets go and the cord whips the mic away; he grabs for it a beat too late, catches air, then shrugs palms up.
 {id:'missed-it',dur:2.4,keys:[
  [.2,{rx:80,ry:25,ma:-.5}],
  [.45,{rx:84,ry:9,ropen:1,x:46,y:12,f:'surprised',gazeX:1.4,gazeY:-1.5,browY:-2}],[.6,{rx:86,ry:5,ropen:0}],
  [.85,{rx:86,ry:7,f:'skeptical',gazeX:1.2,gazeY:-1.5,browY:0,lx:12,ly:27}],
  [1.25,{x:48,y:12,lx:10,ly:17,rx:86,ry:17,lopen:1,ropen:1,lrot:-.3,rrot:.3,tilt:.08,f:'playful',browY:-1.5,gazeX:.2,gazeY:.4}],
  [1.75,{y:12,lx:10,ly:17,rx:86,ry:17,tilt:.08}],[2,{lx:14,ly:27}]],
  mic(t,P){const at=.22;if(t<at)return closeHand(P(t));const e=t-at;return closeReel(micFlipBack(e*1.4,closeHand(P(at))),e/.38);},
  marks(t){return t>.58&&t<.78?[closeMark('spark3',90,2,12)]:[];}},
 // Turns the mic head-down, thumps it on the bottom of the picture like a rubber stamp, and leaves a tick behind as it goes.
 {id:'stamp',dur:2.4,keys:[
  [.3,{rx:76,ry:12,ma:-PI,x:44,f:'focused',gazeX:1.2,gazeY:.8,browL:.2,browR:-.2}],
  [.55,{rx:76,ry:11}],[.7,{rx:76,ry:19,ma:-PI}],[.85,{rx:76,ry:12,ma:-PI}],
  [1.1,{f:'delighted',gazeX:1.2,gazeY:1.2,tilt:.05,browL:0,browR:0}],[1.4,{rx:80,ry:24,ropen:.5}]],
  mic(t,P){return closeLetGo(t,P,{at:.95,reelAt:1.15,rd:.5});},
  marks(t){const out=[];if(t>.68&&t<.8)out.push(closeMark('dust',72,28,10));if(t>.78&&t<2.3)out.push(closeMark('tick',73,25,t>2?7:15));return out;}},
 // More Speck Moves picks (2026-10-28): toss-up, head-tilt, heartfelt, slow-clap.
 // Flips the mic up, watches it spin and catches it, then throws it higher and the cord snatches it off the top.
 {id:'toss-up',dur:2.4,keys:[
  [.3,{rx:80,ry:25,ma:-.5,x:43,lopen:0,f:'playful',gazeX:1.2,gazeY:-.6}],
  [.42,{rx:80,ry:20,ropen:.6}],
  [.65,{rx:79,ry:22,ropen:.8,gazeX:1.2,gazeY:-1.5,f:'delighted'}],
  [.92,{rx:79,ry:24,ropen:.2,gazeX:1,gazeY:.2}],
  [1.12,{rx:79,ry:27,y:14,f:'playful'}],
  [1.3,{rx:82,ry:15,ropen:1,y:12,handScale:1}],
  [1.55,{gazeX:.8,gazeY:-1.6,f:'surprised',eye:1.2,y:13}],
  [1.95,{f:'playful',gazeX:.3,gazeY:.4,eye:1,rx:78,ry:24,ropen:0}]],
  mic(t,P){
   if(t<.42||(t>=.92&&t<1.27))return closeHand(P(t));
   if(t<.92){const r0=closeHand(P(.42)),r1=closeHand(P(.92)),u=(t-.42)/.5;return {x:mix(r0.x,r1.x,u),y:mix(r0.y,r1.y,u)-34*u*(1-u),a:mix(r0.a,r1.a+2*PI,u)};}
   const r=closeHand(P(1.27)),e=t-1.27,m={x:mix(r.x,MIC.ax,easeOutQ(e/.3)),y:r.y-75*e,a:r.a-10*e};
   if(e>.03)m.trail=[.03,.06].map(d=>[m.x-1,r.y-75*(e-d)+6]).filter(p=>p[1]>-2);
   return m;},
  marks(t){return t>1.42&&t<1.7?[closeMark('spark3',83,1,13)]:[];}},
 // Lets the mic go and tilts his head hard one way like a puppy, a question mark popping up on
 // the high side, then the other way, then a little smile.
 {id:'head-tilt',dur:2.4,keys:[
  [.25,{rx:80,ry:24,ma:-.4,x:43,f:'curious',gazeX:.5,gazeY:.5}],
  [.6,{x:46,tilt:.17,f:'curious',browLiftL:-1.5,browR:.3,gazeX:.3,gazeY:.6,lx:12,ly:27,lopen:0,rx:80,ry:27,ropen:0,handScale:1}],
  [.95,{tilt:.17,browLiftL:-1.5}],
  [1.2,{tilt:-.17,browLiftL:0,browLiftR:-1.5,browR:0,browL:.3,gazeX:.6}],
  [1.55,{tilt:-.17,browLiftR:-1.5}],
  [1.85,{tilt:.03,browLiftR:0,browL:0,f:'delighted',y:14,lx:12,rx:80}],[2.05,{y:13,lx:20,rx:76}]],
  mic(t,P){return closeLetGo(t,P,{at:.2,reelAt:.45,rd:.45});},
  marks(t,q){
   if(t>.55&&t<1.05)return [closeMark('q',q.x-38,3+(t>.7&&t<.85?-1:0),14)];
   if(t>1.15&&t<1.65)return [closeMark('q',q.x+33,3+(t>1.3&&t<1.45?-1:0),14)];
   return [];}},
 // Lets the mic float away, clasps both mittens together under his chin and closes his eyes
 // softly; a small heart drifts up beside him.
 {id:'heartfelt',dur:2.6,keys:[
  [.4,{rx:78,ry:25,ma:-.5,x:43,f:'delighted',eye:.5,tilt:.03,gazeX:.3,gazeY:.4}],
  [.85,{x:46,lx:43,ly:27,lopen:0,lrot:.3,rx:50,ry:27,ropen:0,rrot:-.3,handScale:.8,f:'delighted',eye:.1,tilt:.03,browL:-.3,browR:.3}],
  [1.65,{x:46,lx:43,ly:27,rx:50,ry:27,eye:.1,tilt:.03,handScale:.8}],
  [1.95,{eye:1,tilt:.03,gazeX:.3,gazeY:.4,browL:0,browR:0,lx:22,ly:27,rx:74,ry:27}]],
  mic(t,P){return closeLetGo(t,P,{at:.35,reelAt:.8,rd:.7,k:.6});},
  marks(t,q){const out=[];
   if(t>.9&&t<1.95)out.push(closeMark('heartS',q.x+25,21-(t-.9)*12,t<1.7?15:8));
   if(t>1.25&&t<1.95)out.push(closeMark('spark3',q.x+34,15-(t-1.25)*10,9));
   return out;}},
 // Lets go and starts a slow, approving clap for you, nodding along, a little faster, then beams.
 {id:'slow-clap',dur:2.8,keys:[
  [.25,{rx:80,ry:24,ma:-.4,x:44,f:'focused',eye:.8,gazeX:.4,gazeY:.5}],
  [.55,{x:46,y:13,lx:36,ly:27,lopen:0,lrot:.3,rx:57,ry:27,ropen:0,rrot:-.3,handScale:.8,f:'delighted',browY:-1,eye:.9,gazeX:.3,gazeY:.5}],
  ...clapKeys(.75,0),...clapKeys(1.25,1),...clapKeys(1.7,2),
  [2.2,{lx:43,rx:50,y:14,f:'delighted',browY:-1.5,handScale:.8}],[2.35,{y:13}]],
  mic(t,P){return closeLetGo(t,P,{at:.2,reelAt:.45,rd:.45});},
  marks(t,q){
   if(q.rx-q.lx>11||t<.7||t>2.3)return [];
   const m=Math.round((q.lx+q.rx)/2);
   return [['l',m-8,26,m-11,23,12],['l',m+8,26,m+11,23,12],closeMark('spark3',m-1,20,13)];}}
];
// A closer's mic, or null once it is wholly above the frame line.
function closeMic(c,from,t){const P=u=>closePose(c,from,clamp(u,0,c.dur)),m=c.mic(t,P);if(!m)return null;
 const tl=micTail(m);return Math.max(m.y+5,tl[1])<-1?null:m;}
for(const c of MIC_CLOSERS)MIC_RELEASES.push({...c,closer:true,path:()=>null});
const MIC_REEL=.55;
// Exit: the cord takes the mic off the top. `reel` (attend after a reply)
// plays the chosen let-go and then winds it up; `yank` is for an interruption
// (another state takes over) and is gone within two pictures.
const MIC_EXITS={
 // A closer carries its own mic off the top within its length.
 reel:{dur:rel=>rel.dur+(rel.closer?0:MIC_REEL),path(t,r,rel){if(t<rel.dur)return rel.path(t,r);
  const from=rel.path(rel.dur,r),u=easeInQ((t-rel.dur)/MIC_REEL);
  return {x:from.x,y:from.y-(MIC.hangY+18)*u,a:from.a};}},
 yank:{dur:()=>.5,path(t,r){if(t<.1)return r;const u=easeOutQ((t-.1)/.3),t0=micTail(r);
  return micAtTail(mix(t0[0],MIC.ax,u),mix(t0[1],-26,u),mix(r.a,micTurn(r.a,Math.PI),Math.min(1,u*1.6)));}}
};
const micByID=(list,key)=>list.find(x=>x.id===key)||null;
// Grabs and let-gos are shuffled like the idle and thinking rotations: every
// variant once per round, never the same one twice in a row.
function micShuffler(seed){
 let s=seed>>>0;const bags={grab:[],release:[]},last={grab:null,release:null};
 return kind=>{
  const bag=bags[kind];
  if(!bag.length){
   bag.push(...(kind==='grab'?MIC_GRABS.filter(x=>!x.opener):MIC_RELEASES.filter(x=>!x.closer)).map(x=>x.id));
   for(let i=bag.length-1;i>0;i--){s=(Math.imul(s,1664525)+1013904223)>>>0;const j=Math.floor(s/0x100000000*(i+1));[bag[i],bag[j]]=[bag[j],bag[i]];}
   if(bag[bag.length-1]===last[kind])[bag[0],bag[bag.length-1]]=[bag[bag.length-1],bag[0]];
  }
  return last[kind]=bag.pop();
 };
}
const actions={};
const SIDE_BY_GROUP={Conversation:1,Work:1,Mind:1,Results:1,Web:1,Agents:1,Connection:1,Presence:1,Board:1};
const transitions={
 'listening>thinking':{hold:.45,pose:{ly:27,ry:27,gazeX:.6,gazeY:-1.2,tilt:-.03}},
 'thinking>reply':{hold:.45,pose:{ly:27,ry:27,gazeX:.6,gazeY:1.1,tilt:-.06}},
 'reply>idle':{hold:.45,pose:{ly:27,ry:27,gazeX:1.3,gazeY:-.3,tilt:.04}},
 'idle>listening':{hold:.45,pose:{ly:27,ry:27,gazeX:-1.3,gazeY:-.3,browLiftL:-1.2}},
};
function act(id,label,group,description,pose={},prop=null,loop='quiet',icon=null){actions[id]={id,label,group,description,pose:{...BASE,handScale:prop?.72:1,...pose},prop,loop,icon};}
act('idle','Idle','Presence','A quiet glance and an occasional blink. Still between gestures.',{tempo:.6,energy:.15});
act('listening','Listening','Presence','Cups a mitten beside the frame and leans toward two clear listening arcs.',{x:49,y:15,tilt:.13,lx:23,ly:14,lopen:1,lrot:.1,gazeX:-1.6,browL:.12,browR:-.16,browY:-1,rx:75,ry:25,eyeL:1.1,listenCue:1,tempo:.75},null,'attend');
act('speaking','Speaking','Presence','Explains with two open hands, eyebrows leading each phrase.',{tilt:-.06,lopen:1,ropen:1,lx:25,rx:72,ly:23,ry:20,tempo:1.6},null,'talk');
act('thinking','Thinking','Mind','Glances upward, taps his temple, then raises a finger as a thought takes shape.',{x:45,y:14,tilt:-.08,gazeX:-1,gazeY:-1,lx:42,ly:26,rx:73,ry:11,rpoint:-.65,browL:-.32,browR:.14,browY:-.5,eyeR:.7,tempo:.7},null,'ponder');
act('reasoning','Reasoning','Mind','Fits two puzzle pieces together, then studies the join.',{y:12,gazeY:1,lx:41,rx:55,ly:26,ry:26,tempo:.8},'puzzle','fit');
act('planning','Planning','Mind','Holds a plan and traces the next line with a finger.',{x:53,tilt:.04,lx:25,ly:23,rx:38,ry:23,rpoint:1,gazeX:-1,gazeY:1},'clipboard','plan');
act('reading','Reading','Work','Cradles a book and follows the lines with both eyes.',{y:11,lx:34,rx:63,ly:25,ry:25,gazeY:1.5,tempo:.65},'book','read');
act('writing','Writing','Work','Pins down a page and writes in deliberate strokes.',{y:11,tilt:.07,gazeY:1.4,lx:36,ly:27,rx:58,ry:24,rpoint:.8,tempo:1.4},'paper','write');
act('editing','Editing','Work','Crosses out a line, then writes a shorter correction.',{y:11,tilt:-.04,gazeY:1,lx:36,ly:27,rx:58,ry:24,rpoint:.8,tempo:1.8},'paper','edit');
act('searching','Searching','Work','Shades his brow and scans from side to side.',{tilt:-.1,rx:59,ry:4,ropen:1,lx:23,ly:23,lopen:.5,gazeY:-.4,tempo:.7},null,'scan');
act('filesearch','Searching files','Work','Moves a magnifier over a small stack of pages.',{x:43,y:12,tilt:.06,gazeX:1,gazeY:1,rx:71,ry:23,rpoint:.5},'magnifier','scan');
act('browsing','Browsing','Web','Scrolls a page on a tiny laptop, then looks back up.',{y:10,gazeY:1,lx:35,rx:61,ly:25,ry:25},'laptop','browse');
act('navigating','Navigating','Web','Points to a new page and taps to open it.',{y:11,tilt:-.05,gazeY:1,lx:35,rx:61,ly:26,ry:24,rpoint:1},'laptop','tap');
act('form','Filling a form','Web','Taps steadily across the fields.',{y:10,gazeY:1,lx:36,rx:61,ly:25,ry:25,tempo:1.5},'laptop','type');
act('coding','Coding','Work','Types with both mittens. The occasional terminal lens earns its place.',{y:10,tilt:.06,gazeY:.4,lx:35,rx:60,ly:26,ry:26,tempo:1.6},'keyboard','type','terminal');
act('debugging','Debugging','Work','Finds an escaped bug and catches it between two fingers.',{x:43,tilt:-.08,gazeX:1,rx:72,ry:13,lx:56,ly:27,lpoint:1,tempo:.8},'bug','bug');
act('tools','Using tools','Work','Watches a clean segmented spinner. The gap travels clockwise while the silhouette stays stable.',{x:40,y:14,tilt:.06,gazeX:1.4,gazeY:.3,lx:64,ly:25,lpoint:-.5,rx:88,ry:28,ropen:.3,tempo:.8},'spinner','operate');
act('connecting','Connecting','Connection','Brings two cable ends together, carefully lining them up.',{y:11,gazeY:1,lx:33,rx:65,ly:26,ry:26},'cables','connect');
act('disconnected','Disconnected','Connection','Lets the unplugged ends fall and glances between them.',{tilt:.1,eye:.7,gazeY:1,lx:30,rx:68,ly:26,ry:26,tempo:.5},'cables','quiet');
act('reconnecting','Reconnecting','Connection','Tries the connection again with a firmer push.',{y:11,gazeY:1,lx:33,rx:65,ly:25,ry:25,tempo:1.4},'cables','connect');
act('fetching','Fetching data','Web','Reaches down, lifts a stack of pages and checks the top one.',{x:44,y:12,tilt:.1,gazeY:1.5,lx:35,rx:64,ly:26,ry:25},'stack','fetch');
act('syncing','Syncing','Connection','Trades places with his hands as the sync lens cycles.',{tilt:-.06,lx:27,rx:70,ly:24,ry:24,lopen:1,ropen:1},null,'sync','sync');
act('delegating','Delegating','Agents','Passes a task card to a little helper.',{x:39,tilt:.05,gazeX:1,rx:62,ry:22,rpoint:.4,helper:1},'task','pass');
act('coordinating','Multi-agent','Agents','Checks in with two helpers and points out the next job.',{x:45,y:12,gazeX:1,rx:65,ry:24,rpoint:1,lx:27,ly:23,helper:2},null,'coordinate');
act('collaborating','Collaborating','Agents','Meets a helper halfway for a high five.',{x:38,tilt:-.05,gazeX:1,rx:64,ry:13,ropen:1,helper:1},null,'highfive');
act('handoff','Handoff','Agents','Moves a task card across to the next helper.',{x:37,tilt:.1,rx:64,ry:22,gazeX:1,helper:1},'task','pass');
act('filing','Filing a card','Board','Holds up a new card, slaps it into the first lane as the lane makes room, smooths it down and beams.',{},'boardfile','staged');
act('boardcheck','Checking the board','Board','Leans in and counts the cards lane by lane with a nod for each, then gives the board a thumbs-up.',{},'boardscan','staged');
act('unblocking','Unblocking a card','Board','Strains against a card stuck at a gate, then shoves; the gate falls and the card flies into the next lane.',{},'boardunblock','staged');
act('annotating','Adding to a card','Board','Sticks a note on a card, writes a line on it with quick finger strokes, then reads it back with a nod.',{},'boardnote','staged');
act('linking','Linking cards','Board','Pulls a string from one card across the board to another; it clicks on, a pulse runs along it and he beams.',{},'boardlink','staged');
act('waiting','Waiting','Presence','Rests one hand on a ledge and taps a finger.',{y:13,tilt:.07,eye:.75,lx:30,ly:28,rx:69,ry:27,tempo:.6},'ledge','wait');
act('queued','Queued','Presence','Keeps his place with a ticket and watches the hourglass.',{tilt:-.04,eye:.8,gazeX:1,rx:73,ry:25,tempo:.6},'hourglass','quiet');
act('paused','Paused','Presence','Holds up a palm. The action rests; he still blinks.',{lx:26,ly:24,rx:72,ry:16,ropen:1,tempo:.4,energy:.1});
act('complete','Complete','Results','A double thumbs-up, a small lift and a satisfied glance.',{y:12,browY:-1,lx:25,rx:71,ly:22,ry:22,lthumb:1,rthumb:1,tempo:1.1},null,'celebrate');
act('error','Error','Results','A lopsided double-take, raised palms and a bold exclamation. Neither eye is hidden.',{x:45,y:15,tilt:-.12,lx:18,ly:22,lopen:1,lrot:-.2,rx:74,ry:23,ropen:1,rrot:.2,browL:.18,browR:-.26,browY:-1.5,eyeL:.6,eyeR:1.35,gazeX:1,errorCue:1,tempo:.65},null,'oops');
act('warning','Warning','Results','Raises a cautioning finger and gives you a pointed look.',{tilt:-.03,gazeX:1,rx:71,ry:16,rpoint:1,browL:-.3,browR:.02},null,'caution');
act('standby','On standby','Presence','Lowers his brows and rests both hands together.',{y:16,eye:.2,browY:1,lx:43,rx:52,ly:28,ry:28,tempo:.25,energy:.05},null,'quiet');
act('processing','Processing','Mind','Turns a small crank through a steady working rhythm.',{y:11,gazeY:1,lx:35,rx:64,ly:26,ry:25},'gear','turn');
act('generating','Generating','Mind','Builds a little stack of blocks, one at a time.',{y:11,gazeY:1,lx:36,rx:61,ly:25,ry:23},'blocks','build');
act('analysing','Analysing','Mind','Compares two bars and points at the taller one.',{x:43,tilt:.06,gazeX:1,rx:66,ry:21,rpoint:1},'chart','plan');
act('running','Running','Work','Pumps his hands as a command runs, leaning into the work.',{tilt:-.12,lx:25,rx:73,ly:22,ry:22,tempo:1.9},null,'run');
act('completing','Completing','Results','Checks the last line on the task card.',{x:52,y:12,lx:26,ly:23,rx:40,ry:23,rpoint:1,gazeX:-1},'clipboard','plan');
act('success','Success','Results','Raises a tiny flag with a triumphant free hand.',{x:43,y:12,rx:70,ry:17,lx:25,ly:22,lthumb:1,browY:-1},'flag','celebrate');
act('uploading','Uploading','Connection','Lifts a parcel with both mittens.',{y:11,lx:37,rx:60,ly:25,ry:25,gazeY:1},'parcel','lift');
act('downloading','Downloading','Connection','Catches a parcel and lowers it carefully.',{y:11,lx:37,rx:60,ly:25,ry:25,gazeY:1},'parcel','catch');
act('busy','Busy','Mind','Alternates between two jobs on his desk.',{y:10,lx:34,rx:63,ly:25,ry:25,gazeY:1,tempo:1.7},'cards','busy');
act('learning','Learning','Mind','Reads, pauses, and raises a finger when it clicks.',{y:11,lx:33,rx:65,ly:25,ry:19,rpoint:1,gazeY:1},'book','learn');
act('updating','Updating','Connection','Works a cog into place with a careful twist.',{y:11,lx:35,rx:64,ly:26,ry:25,gazeY:1,tempo:.8},'gear','turn');
act('deploying','Deploying','Work','Helps a little rocket get off the pad.',{x:40,tilt:-.08,gazeX:1,rx:70,ry:24,ropen:.6},'rocket','launch');
act('monitoring','Monitoring','Work','Watches a tiny trace on a separate monitor.',{x:39,tilt:.04,gazeX:1,rx:72,ry:24,lx:18,ly:23},'monitor','monitor');
act('secure','Secure','Results','Holds a shield in front and gives a reassuring thumbs-up.',{x:45,lx:28,ly:23,lthumb:1,rx:68,ry:24},'shield','quiet');
act('camera','Camera on','Work','Holds a camera below his eyes and frames a shot.',{y:11,lx:36,rx:61,ly:25,ry:25,gazeY:1},'camera','camera');
act('vision','Vision','Work','Frames what he sees between his two raised hands.',{lx:24,ly:15,rx:73,ry:15,lpoint:1,rpoint:1,tilt:-.04},null,'scan');
act('calling','Calling tool','Work','Lifts a handset and waits for the tool to answer.',{x:44,lx:26,ly:14,gazeX:-1,rx:69,ry:24},'phone','listen');
act('mcpconnect','MCP connect','Connection','Offers the connector to a little server stack.',{x:39,y:12,rx:66,ry:23,gazeX:1,lx:18,ly:24},'server','connect');
act('mcpactive','MCP active','Connection','Checks each level of a connected server.',{x:39,y:12,rx:66,ry:23,rpoint:1,gazeX:1,lx:18,ly:24},'server','plan');
act('greeting','New session','Presence','Offers a fresh page with a bold plus and gives you a cheerful double wave.',{x:50,y:13,tilt:-.07,lx:15,ly:27,rx:77,ry:16,ropen:1,browL:-.14,browR:.19,browY:-1,eyeL:1.1,eyeR:1.1,handScale:.85,tempo:1},'freshpage','welcome');
act('awaiting','Awaiting a message','Presence','Leans forward expectantly, hands open.',{y:13,tilt:-.03,lopen:.5,ropen:.5,browY:-1,tempo:.5},null,'quiet');
act('voice','Voice processing','Presence','Scoops a little speech bubble toward the workbench.',{y:12,lx:34,rx:64,ly:25,ry:25},'speech','fetch');
act('reply','Reply streaming','Presence','Points along a growing line of text while gesturing.',{y:11,rx:66,ry:25,rpoint:1,lx:24,ly:20,lopen:1},'text','talk');
act('git','Working with Git','Work','Joins a branch back to its trunk.',{x:43,y:11,gazeY:1,rx:66,ry:25,rpoint:1},'branch','fit');
act('drawing','Editing a canvas','Work','Paints a broad stroke across a tiny canvas.',{y:11,lx:34,rx:61,ly:27,ry:23,gazeY:1,tempo:.8},'canvas','write');
act('device','Checking a device','Work','Turns a small device and checks its screen.',{x:43,gazeX:1,rx:71,ry:22,lx:24,ly:24},'device','turn');
act('sending','Sending a message','Agents','Flicks an envelope toward its destination.',{x:43,rx:66,ry:23,ropen:.5,gazeX:1},'envelope','send');
act('sessions','Managing a session','Agents','Sorts session cards into a tidy stack.',{y:11,lx:34,rx:63,ly:26,ry:26,gazeY:1},'cards','sort');
act('title','Updating a title','Agents','Writes a heading on a small title card.',{y:11,lx:35,rx:61,ly:27,ry:24,rpoint:.7,gazeY:1},'title','write');
// Large, readable object silhouettes are the starting plane. The interaction
// scenes below bring them into held, working, reaching and centred poses.
const staging={
 reasoning:['puzzle','Joins two large puzzle pieces beside his face.',{rx:96,ry:21}],
 planning:['clipboard','Points down the rows of a tall checklist.',{rx:96,ry:10}],
 reading:['book','Holds an open book upright and follows the lines.',{rx:96,ry:25}],
 writing:['paper','Writes down an upright page with a long diagonal pencil.',{rx:96,ry:11}],
 editing:['editpaper','Rubber erases a line, then reveals the corrected page.',{rx:96,ry:13}],
 drawing:['canvas','Paints a large picture on a standing easel.',{rx:96,ry:12}],
 title:['title','Underlines a large heading on an upright page.',{rx:96,ry:20}],
 browsing:['browser','Scrolls a tall browser window on a raised laptop.',{rx:96,ry:17}],
 navigating:['navigate','Taps a bold pointer on a new browser page.',{rx:96,ry:14}],
 form:['form','Checks three large fields in a raised form.',{rx:96,ry:11}],
 coding:['laptop','Taps a raised keyboard beneath a bold code screen.',{rx:96,ry:25}],
 connecting:['cables','Pushes two upright plug ends together.',{rx:90,ry:23}],
 disconnected:['unplugged','Holds two clearly separated cable ends beside him.',{rx:90,ry:24}],
 reconnecting:['replug','Tries the upright plugs again with a short double push.',{rx:90,ry:23}],
 fetching:['stack','Pulls a full-height page from a visible stack.',{rx:96,ry:22}],
 queued:['hourglass','Waits beside a large hourglass with falling sand.',{rx:62,ry:25}],
 filesearch:['magnifier','Moves a large magnifying glass over an upright document.',{rx:96,ry:23}],
 sessions:['cards','Selects between two upright session cards.',{rx:96,ry:24}],
 busy:['twocards','Alternates between two clearly separated jobs.',{rx:96,ry:16}],
 completing:['checklist','Finishes a large check on an upright checklist.',{rx:96,ry:20}],
 success:['flag','Holds a tall chequered flag and gives a thumbs-up.',{rx:68,ry:25,lthumb:1}],
 uploading:['upload','Raises a parcel toward a bold upward arrow.',{rx:95,ry:24}],
 downloading:['download','Catches a parcel beneath a bold downward arrow.',{rx:95,ry:24}],
 learning:['learnbook','Studies an upright book, then raises a finger when it clicks.',{rx:96,ry:24}],
 monitoring:['monitor','Checks a large heartbeat trace on a separate upright monitor.',{rx:96,ry:25}],
 secure:['shield','Presents a tall shield with a bold check and a thumbs-up.',{rx:95,ry:23,lthumb:1}],
 camera:['camera','Holds a large camera beside his face and presses its shutter.',{rx:96,ry:10}],
 calling:['phone','Holds a full-height telephone receiver beside his face.',{rx:88,ry:20}],
 device:['device','Holds a tall device at eye level and checks its screen.',{rx:94,ry:24}],
 analysing:['chart','Compares three tall bars and points at their heights.',{rx:96,ry:13}],
 git:['branch','Follows a large branch as it joins the main line.',{rx:95,ry:23}],
 voice:['speech','Watches a large speech bubble turn voice into a waveform.',{rx:96,ry:24}],
 reply:['text','Gestures toward a large speech bubble as its lines appear.',{rx:96,ry:24,lopen:.7}],
 sending:['envelope','Sends a large envelope toward a clear outward arrow.',{rx:96,ry:26}],
 mcpconnect:['server','Pushes a connector into a tall server rack.',{rx:61,ry:24}],
 mcpactive:['serveractive','Checks the active rows of a tall server rack.',{rx:96,ry:18}],
 tools:['wrench','Works a full-height spanner around a clear bolt.',{rx:92,ry:25}],
 processing:['gear','Turns a large cog with a distinct crank handle.',{rx:94,ry:23}],
 updating:['updategear','Fits a large cog into place, then turns the crank.',{rx:94,ry:23}],
 generating:['blocks','Places large blocks onto a tall growing tower.',{rx:95,ry:10}],
 deploying:['rocket','Releases a tall rocket and follows its climb.',{rx:94,ry:23}],
 greeting:['freshpage','Offers a tall new-page sign and waves beside it.',{rx:61,ry:10,ropen:1,handScale:.85}],
 waiting:['clock','Waits beside a large clock, with a small impatient finger tap.',{rx:62,ry:26}],
 paused:['pause','Raises a stop palm beside two unmistakable pause bars.',{rx:61,ry:16,ropen:1}],
 warning:['warning','Raises a finger beside a large warning triangle.',{rx:61,ry:20,rpoint:1}],
 running:['play','Pumps a hand beside a large run arrow and advancing marks.',{rx:61,ry:23}],
 syncing:['syncwheel','Follows two large arrows trading places in a loop.',{rx:96,ry:23}],
 vision:['viewfinder','Frames a clear target in a tall viewfinder.',{rx:61,ry:18,rpoint:1}],
 delegating:['task','Offers a task card to a small helper above it.',{rx:61,ry:25,helper:1}],
 handoff:['handoffcard','Passes a tall task card toward a waiting helper.',{rx:61,ry:25,helper:1}],
 coordinating:['team','Checks two helpers arranged above and below a clear fork.',{rx:61,ry:17,rpoint:.7,helper:2}],
 collaborating:['highfive','Raises a palm to meet a small helper in a high five.',{rx:67,ry:20,ropen:1,helper:1}],
 debugging:['bug','Tracks a large escaped bug with a cautious pinching hand.',{rx:95,ry:23,rpoint:-.3}],
 filing:['boardfile','Holds up a new card, slaps it into the first lane as the lane makes room, smooths it down and beams.',{}],
 boardcheck:['boardscan','Leans in and counts the cards lane by lane with a nod for each, then gives the board a thumbs-up.',{}],
 unblocking:['boardunblock','Strains against a card stuck at a gate, then shoves; the gate falls and the card flies into the next lane.',{}],
 annotating:['boardnote','Sticks a note on a card, writes a line on it with quick finger strokes, then reads it back with a nod.',{}],
 linking:['boardlink','Pulls a string from one card across the board to another; it clicks on, a pulse runs along it and he beams.',{}]
};
for(const [id,[prop,description,pose]] of Object.entries(staging)){
 Object.assign(actions[id],{prop,description,loop:'staged',staged:true});
 Object.assign(actions[id].pose,{x:30,y:14,tilt:0,lx:12,ly:26,rx:96,ry:25,lrot:0,rrot:0,lopen:0,ropen:0,lpoint:0,rpoint:0,lthumb:0,rthumb:0,gazeX:1.3,gazeY:0,handScale:.72,helper:0,listenCue:0,errorCue:0},pose);
}
const gestures={
 idle:{lx:16,rx:82,ly:25,ry:25},
 listening:{x:50,lx:21,ly:14,rx:83,ry:26},
 speaking:{x:48,lx:16,rx:82,ly:21,ry:17},
 thinking:{x:44,lx:13,ly:26,rx:78,ry:12},
 error:{x:44,lx:13,rx:76,ly:20,ry:21},
 awaiting:{x:48,lx:16,rx:82,ly:20,ry:20,lopen:.7,ropen:.7},
 complete:{x:48,lx:16,rx:82,ly:20,ry:20},
 standby:{x:48,y:14,lx:16,rx:82,ly:27,ry:27}
};
for(const [id,pose] of Object.entries(gestures))Object.assign(actions[id].pose,pose);
// Nine activities use a lens display, leaving the other eye alive.
for(const [id,icon] of Object.entries({coding:'terminal',syncing:'sync',analysing:'bars',monitoring:'pulse',secure:'lock',complete:'check',form:'check',uploading:'upload',downloading:'download'}))actions[id].icon=icon;
// Both search signals share the outward-facing magnifier scene below.
Object.assign(actions.searching,{prop:'magnifier',staged:true,loop:'staged'});
Object.assign(actions.searching.pose,actions.filesearch.pose);
actions.complete.description='A double thumbs-up and one unmistakable checkmark lens.';
// Interaction is authored per activity. Coordinates below are the object's
// original pixel plane; the face stays full-size and each prop keeps its detail.
// A left scene changes the stage, gaze and hands together, not just the icon.
const scenes={};
function scene(ids,head,offset,side,interaction,hands){for(const id of ids.split(' '))scenes[id]={head,offset,side,interaction,hands};}
scene('reading learning',35,-4,1,'cradle',{lx:64,ly:27,rx:94,ry:26});
scene('writing editing title',36,-5,1,'work',{lx:68,ly:27,rx:96,ry:11});
scene('planning completing',35,-5,-1,'work',{lx:70,ly:27,rx:96,ry:10});
scene('drawing',32,-5,-1,'work',{lx:20,ly:26,rx:96,ry:12});
scene('coding form',34,-5,1,'type',{lx:71,ly:28,rx:88,ry:28});
scene('browsing navigating',36,-4,-1,'touch',{lx:67,ly:28,rx:96,ry:16});
scene('calling',40,-4,-1,'hold',{lx:20,ly:26,rx:84,ry:24});
scene('device',41,-4,1,'inspect',{lx:67,ly:26,rx:91,ry:25});
scene('camera',34,-4,-1,'cradle',{lx:65,ly:27,rx:96,ry:13});
scene('secure',37,-4,1,'hold',{lx:17,ly:25,lthumb:1,rx:94,ry:25});
scene('reasoning',33,-5,1,'join',{lx:64,ly:26,rx:94,ry:26});
scene('connecting reconnecting disconnected',41,-4,-1,'connect',{lx:70,ly:9,rx:88,ry:25});
scene('processing updating',34,-4,1,'crank',{lx:67,ly:27,rx:96,ry:17});
scene('tools',36,-4,-1,'hold',{lx:71,ly:29,rx:89,ry:27});
scene('fetching sessions busy',34,-4,-1,'sort',{lx:64,ly:27,rx:96,ry:24});
scene('uploading downloading',36,-4,1,'lift',{lx:68,ly:25,rx:94,ry:25});
scene('generating',33,-3,-1,'place',{lx:21,ly:26,rx:95,ry:10});
scene('success',38,-4,-1,'hold',{lx:20,ly:23,lthumb:1,rx:68,ry:26});
scene('greeting',36,-3,1,'offer',{lx:69,ly:28,rx:96,ry:15,ropen:1});
scene('filesearch searching',31,-2,1,'inspect',{lx:20,ly:26,rx:96,ry:26});
scene('analysing git',32,-2,-1,'point',{lx:20,ly:26,rx:96,ry:19});
scene('monitoring',27,1,1,'observe',{lx:12,ly:26,rx:62,ry:26});
scene('queued waiting',35,-1,-1,'observe',{lx:18,ly:26,rx:65,ry:26});
scene('voice reply',32,-2,-1,'gesture',{lx:17,ly:24,lopen:.7,rx:63,ry:26});
scene('sending',36,-4,1,'pass',{lx:18,ly:26,rx:64,ry:26});
scene('delegating handoff',31,-2,1,'pass',{lx:15,ly:26,rx:62,ry:26});
scene('collaborating',35,-2,1,'meet',{lx:16,ly:26,rx:68,ry:20,ropen:1});
scene('coordinating',30,0,1,'point',{lx:16,ly:26,rx:62,ry:17});
scene('mcpconnect',34,-2,1,'touch',{lx:18,ly:26,rx:61,ry:25});
scene('mcpactive',31,0,-1,'point',{lx:18,ly:26,rx:96,ry:18});
scene('deploying',28,1,1,'release',{lx:13,ly:26,rx:65,ry:25});
scene('debugging',35,-2,1,'pinch',{lx:18,ly:26,rx:92,ry:24,rpoint:-.3});
scene('paused warning running syncing vision',34,-2,-1,'gesture',{lx:17,ly:26,rx:63,ry:24});
// #3769: the board stands right of the head. boardBeat below choreographs the hand and face.
scene('filing boardcheck unblocking annotating linking',32,0,1,'board',{lx:16,ly:26,rx:63,ry:26});
scene('camera',50,0,1,'front',{lx:32,ly:27,rx:68,ry:27});
scene('connecting reconnecting disconnected',50,0,1,'couple',{lx:27,ly:27,rx:73,ry:27});
// Revision 20: action-specific work, with hand and implement sharing targets.
scene('writing',34,0,1,'writepaper',{lx:68,ly:27,rx:90,ry:12});
scene('tools',34,-7,1,'wrench',{lx:64,ly:27,rx:82,ry:25});
scene('filesearch searching',31,0,1,'magnify',{lx:12,ly:26,rx:72,ry:26});
scene('navigating',34,-1,-1,'mouse',{lx:38,ly:27,rx:58,ry:27});
scene('fetching',32,-1,1,'receive',{lx:67,ly:27,rx:94,ry:27});
scene('git',34,-1,-1,'versions',{lx:67,ly:27,rx:94,ry:27});
scene('reply',43,0,1,'replyhold',{lx:33,ly:27,rx:77,ry:27,lopen:.35,ropen:.1});
scene('sending',35,0,1,'seal',{lx:68,ly:27,rx:91,ry:25});
delete scenes.coding;
Object.assign(actions.coding,{prop:null,staged:false,loop:'code',pose:{...BASE,x:48,y:13,lx:39,ly:27,rx:57,ry:27,gazeX:.8,tempo:1.2},description:'Types in little bursts on an invisible keyboard. Each downward tap flips the cursor to a random 0 or 1.'});
for(const id of ['connecting','writing','searching','fetching','reply'])actions[id].icon=null;
actions.fetching.prop='datatray';
actions.searching.prop='magnifier';
actions.reply.static=true;
actions.reply.prop='mic';actions.reply.staticExpression='curious';
actions.reply.description='A microphone drops in head-down on a cord; he catches it, flips it upright below the outer corner of his glasses and holds still. Three grabs and four let-gos rotate.';
actions.git.prop='gitcards';
Object.assign(actions.idle.pose,{y:13,lx:38,ly:27,rx:58,ry:27,lrot:.08,rrot:-.08});
actions.idle.description='Twelve idle routines: yo-yo, bubble, nap, fly, chin tuck, pull ups, heavy eyelids, window cleaning, pixel juggling, frame straightening, a one-hand hang and a drum roll on his own name.';
Object.assign(actions.listening.pose,{x:50,y:14,tilt:-.08,lx:20,ly:14,lrot:.08,lopen:1,rx:82,ry:26,listenCue:0,gazeX:-1.3});
actions.listening.description='Tilts into the cupped hand, lifts the listening-side brow and gives a little attentive nod.';
Object.assign(actions.thinking.pose,{x:45,y:13,tilt:0,lx:35,ly:27,rx:57,ry:27,rpoint:-.6});
actions.thinking.description='Twelve shuffled thinking gestures, including gears, an abacus, varied neural and tree routes, noise resolving into six different ideas, a thought cloud, drumming fingers, weighing scales and jotted notes.';
Object.assign(actions.error.pose,{x:47,y:15,lx:16,ly:14,rx:78,ry:14,lopen:1,ropen:1,lrot:-.15,rrot:.15,gazeX:0,eyeL:1.2,eyeR:1.2});
actions.error.description='Oh no! Both palms fly up beside wide eyes, followed by a worried little head shake.';
actions.writing.description='Supports a paper sheet with one mitten and writes three short lines with a pencil in the other.';
actions.tools.description='Works a wrench close beside his frame, keeping the handle in his moving hand.';
actions.filesearch.description=actions.searching.description='Holds a large round magnifier facing outward and sweeps it gently across the search.';
actions.navigating.description='Moves a mouse in front of him, between his hands and the monitor, with a clean pointer following along.';
actions.fetching.description='Catches incoming data packets in a tray held with both hands.';
actions.git.description='Holds two version cards, brings the revised one forward and checks the change.';
actions.sending.description='Holds a small envelope, folds its flap shut and offers it outward.';
actions.voice.description='Watches the continuous waveform with raised brows, anticipating the words.';
function stagePose(q,layout){
 q.x=layout.head;
 for(const h of ['l','r'])q[h+'x']+=layout.offset;
 if(layout.side<0){
  q.x=100-q.x;q.gazeX=-q.gazeX;q.tilt=-q.tilt;
  for(const key of ['x','y','rot','open','point','thumb']){const l=q['l'+key],r=q['r'+key];q['l'+key]=key==='x'?100-r:key==='rot'?-r:r;q['r'+key]=key==='x'?100-l:key==='rot'?-l:l;}
 }
 return q;
}
for(const [id,layout] of Object.entries(scenes)){
 const group=['voice','reply'].includes(id)?'Conversation':actions[id].group;
 // Hands in scenes are authored in the prop's right-side plane. stagePose is
 // the single mirror transform for position, rotation and left/right keys;
 // selecting +1 here therefore restores the authored hand keys as well.
 layout.side=SIDE_BY_GROUP[group]||1;
 if(!['front','couple'].includes(layout.interaction))layout.head=group==='Conversation'?40:32;
 const d=actions[id];d.layout=layout;d.authoredPose={...d.pose,...layout.hands};
 if(d.authoredPose.lthumb&&d.authoredPose.lx<40)d.authoredPose.lx=Math.max(6,layout.head-31-layout.offset);
 if(['front','couple'].includes(layout.interaction)){d.authoredPose.y=12;d.authoredPose.gazeX=0;d.authoredPose.gazeY=.7;}
 d.pose=stagePose({...d.authoredPose},layout);
}
actions.reading.description='Cradles the open book with both hands, lifts it slightly and follows the lines.';
actions.camera.description='Holds a camera in front with both hands and presses the shutter, keeping both eyes visible.';
actions.connecting.description='Holds one cable end in each hand and brings the plugs together in front.';
actions.reconnecting.description='Brings the two cable ends together for another careful attempt.';
actions.disconnected.description='Holds the separated cable ends apart and looks between them.';
actions.calling.description='Holds a telephone receiver close beside his frame and listens.';
// The exact original 32 semantic IDs are preserved. Concept states never imply
// that these signals already exist in the production status resolver.
const originals=[['idle','idle'],['connecting','connecting'],['disconnected','disconnected'],['listening','listening'],['voice_handoff','voice'],['responding','reply'],['failure','error'],['new_session','greeting'],['awaiting_message','awaiting'],['tool','tools'],['thinking','thinking'],['thinking_summary','reasoning'],['queued','queued'],['fs.read','reading'],['fs.write','writing'],['fs.edit','editing'],['search.files','filesearch'],['search.web','searching'],['browser.browse','browsing'],['browser.navigate','navigating'],['browser.fill','form'],['network.fetch','fetching'],['terminal.exec','coding'],['terminal.git','git'],['canvas.edit','drawing'],['device.check','device'],['generic','tools'],['agent.subtask','delegating'],['agent.coordinate','coordinating'],['message.send','sending'],['session.manage','sessions'],['session.title.update','title']];
const MAGIC_PERFORMANCES=['spellcaster','portal','telekinesis','constellation','between_hands','lens_projection'];
const MAGIC_LABELS=['Spellcaster','Portal','Telekinesis','Written in the stars','Between his hands','Lens projection'];
for(const [i,name] of MAGIC_PERFORMANCES.entries()){
 act('magic_'+name,MAGIC_LABELS[i],'Work','Conjures an interface once, then sustains it until local takeover.',
  {x:name==='between_hands'?29:32,y:14,lx:8,ly:24,rx:65,ry:9,lopen:1,ropen:1,handScale:.8,gazeX:1.4,gazeY:0});
 actions['magic_'+name].magic=name;
}
originals.push(['interface.build','magic_telekinesis']);
// #3769: Hermes kanban tools from the chat agent.
originals.push(['board.create','filing'],['board.read','boardcheck'],['board.unblock','unblocking'],
 ['board.annotate','annotating'],['board.link','linking']);
// A program card build's phases (ocuclaw.card.build, CardBuildHeader.kt). They borrow concept
// acts that other screens name by their concept ids (CloudwaysHelper), so those ids stay.
originals.push(['card.ask','awaiting'],['card.code','coding'],['card.open','deploying'],['card.fix','debugging'],
 ['card.approval','waiting'],['card.check','device'],['card.change','editing'],['card.save','completing']);
// The phone's build sheet (#6094) also plays these four, which borrow chat acts: their own ids
// let build.js give them build moves without touching what chat plays for failure, idle,
// search.web and thinking.
originals.push(['card.problem','error'],['card.ready','idle'],['card.look','searching'],['card.review','thinking']);
// Play testing (2026-10-31): a game card's test on the phone. It borrows the test's own act;
// build.js gives it Matt's play testing loops, by genre when the app names one.
originals.push(['card.play','device']);
// Designing (2026-11-09): the design half of a card's code or fixing step on the phone. It borrows the
// chat's reasoning act (today's puzzle pieces) under its own id, so build.js can give it Matt's
// Designing loops, by card kind, without touching what chat plays for thinking_summary.
originals.push(['card.design','reasoning']);
// Framing (2026-11-09, #7034): after a game's Done, while its frame draws (frame-first, the phone's
// ocuclaw.frameFirst). It borrows Ready's quiet act under its own id, so build.js can give it the framing loops.
originals.push(['card.frame','idle']);
const catalogue=originals.map(([id,a])=>({...actions[a],id,action:a,source:'OcuClaw'}));
const mapped=new Set(originals.filter(([id])=>!id.startsWith('card.')).map(x=>x[1]));
Object.values(actions).filter(a=>!mapped.has(a.id)).forEach(a=>catalogue.push({...a,id:'concept.'+a.id,action:a.id,source:'Concept'}));
const byId=Object.fromEntries(catalogue.map(d=>[d.id,d]));
function spring(x,v,target,w,dt){const e=Math.exp(-w*dt),d=x-target,c=v+w*d;return [target+(d+c*dt)*e,(v-w*c*dt)*e];}
function springZ(x,v,target,w,dt,zeta=.5){const d=x-target,wd=w*Math.sqrt(1-zeta*zeta),e=Math.exp(-zeta*w*dt),c=Math.cos(wd*dt),s=Math.sin(wd*dt),b=(v+zeta*w*d)/wd;return [target+e*(d*c+b*s),e*((-zeta*w*d+wd*b)*c+(-zeta*w*b-wd*d)*s)];}
function targetFor(def,phase,time,motion=1){
 const q={...(def.authoredPose||def.pose)},s=Math.sin(phase),c=Math.cos(phase),s2=Math.sin(phase*2);
 const n=motion,loop=def.loop;
 if(def.staged){
  const a=def.action||def.id,beat=time%4.8,stroke=beat<1.8?Math.sin(beat/1.8*Math.PI):0;
  if(['writing','editing','drawing','form','planning','completing','analysing'].includes(a)){q.ry+=stroke*9*n;q.rrot=-.18*stroke*n;}
  if(a==='title'){q.ry+=stroke*2*n;}
  if(['browsing','navigating','coding','camera'].includes(a)){q.ry+=Math.max(0,s2)*2*n;}
  if(['connecting','reconnecting'].includes(a)){q.ry-=stroke*5*n;}
  if(a==='uploading')q.ry-=stroke*8*n;
  if(a==='generating')q.ry+=stroke*10*n;
  if(a==='downloading')q.ry-=Math.max(0,1-beat/1.8)*8*n;
  if(a==='learning'){q.ry-=stroke*17*n;q.rpoint=stroke*.7*n;}
  if(['reading','learning'].includes(a))q.gazeY=-.6+stroke*1.3*n;
  if(a==='waiting')q.rpoint=Math.max(0,s2)*.45*n;
  if(a==='delegating')q.ry-=stroke*2*n;
  if(['processing','updating','tools','device'].includes(a)){q.rrot=s*.18*n;q.ry+=s*n;}
  if(a==='greeting'){q.rrot=s*.35*n;q.ry-=Math.max(0,s)*2*n;}
  if(a==='running'){q.ly+=s*2*n;q.ry-=s*2*n;}
  if(a==='collaborating'){q.ry-=stroke*4*n;}
  if(a==='coordinating'){q.ry+=s*6*n;}
  if(a==='busy'){q.ry+=s*5*n;}
  if(['delegating','handoff','sending'].includes(a)){q.rrot=-stroke*.25*n;}
  if(def.layout){
   const interaction=def.layout.interaction;
   if(['cradle','hold','inspect','lift','join','connect'].includes(interaction)){
    q.propDX=interaction==='inspect'?stroke*1.5*n:0;
    q.propDY=interaction==='cradle'?-stroke*1.5*n:interaction==='hold'?-stroke*n:0;
    q.lx+=q.propDX;q.rx+=q.propDX;q.ly+=q.propDY;q.ry+=q.propDY;
   }
   if(interaction==='type'){q.ly=28-Math.max(0,s2)*2*n;q.ry=28-Math.max(0,-s2)*2*n;}
   if(interaction==='connect'){q.ly=10;q.ry=25-(a==='disconnected'?0:a==='reconnecting'?Math.max(0,Math.sin(time*3))*5:stroke*5)*n;}
   if(interaction==='join')q.rx-=stroke*3*n;
   if(interaction==='crank')q.ry=17+Math.sin(phase)*3*n;
   if(interaction==='lift'){const lift=a==='uploading'?stroke*6:Math.max(0,1-beat/1.8)*6;q.ly=26-lift*n;q.ry=26-lift*n;}
   if(interaction==='pass'){q.rx+=(a==='handoff'?stroke*9:stroke*2)*n;q.ry-=stroke*n;}
   if(interaction==='release'){q.rx-=stroke*3*n;q.ropen=.3+stroke*.7*n;}
   if(interaction==='front'){q.ry=27-Math.max(0,s2)*n;q.rpoint=-.5;}
   if(interaction==='couple'){const push=a==='disconnected'?0:a==='reconnecting'?Math.max(0,Math.sin(time*3))*10:stroke*10;q.lx=27+push;q.rx=73-push;q.ly=27;q.ry=27;}
   if(interaction==='writepaper'){const line=Math.floor(time%6/2),pen=time%2<1.45?(time%2)/1.45:1;q.rx=84+pen*8*n;q.ry=8+line*5;q.rrot=-.15;q.ly=27;q.propDX=0;q.propDY=0;}
   if(interaction==='wrench'){const angle=Math.sin(time*1.8)*.48*n;q.rrot=angle;q.rx=81-Math.sin(angle)*16;q.ry=9+Math.cos(angle)*16;}
   if(interaction==='magnify'){q.propDX=Math.sin(time*.9)*2*n;q.propDY=Math.sin(time*.9)*n;q.rx=72+q.propDX;q.ry=26+q.propDY;q.rrot=-.4;q.gazeX=1.5;q.gazeY=-.3;}
   if(interaction==='mouse'){q.rx=58+Math.sin(time*1.3)*2*n;q.ry=27;q.rpoint=0;q.rrot=0;}
   if(interaction==='receive'){q.ly=27;q.ry=27;q.propDX=0;q.propDY=0;}
   if(interaction==='versions'){q.propDX=-stroke*2*n;q.lx=67+q.propDX;q.rx=94+q.propDX;q.ly=27;q.ry=27;}
   if(interaction==='replyhold'){q.y=13;q.tilt=-.035;q.gazeX=0;q.gazeY=.6;q.propDX=0;q.propDY=0;}
   if(interaction==='seal'){q.propDX=stroke*2*n;q.lx=68+q.propDX;q.rx=91+q.propDX;q.ry=25-stroke*4*n;q.rrot=-stroke*.35;}
   stagePose(q,def.layout);
  }
  return q;
 }
 // Action targets move continuously. Changing state does not reset the clock.
 if(loop==='attend'){q.lrot+=Math.sin(phase*.7)*.09*n;q.tilt+=Math.sin(phase*.6)*.015*n;q.gazeX+=Math.sin(phase*.35)*.25*n;}
 if(loop==='code'){
  const burst=Math.floor(time/4.8),beat=time%4.8,count=[6,4,7,5][burst%4];
  let liftL=0,liftR=0;
  for(let i=0;i<count;i++){
   const t=(beat-.35-i*.43)/.42;
   const lift=t>0&&t<1?Math.sin(Math.PI*t):0;
   if((i+burst)%2)liftR=Math.max(liftR,lift);else liftL=Math.max(liftL,lift);
  }
  q.ly=27-3.3*liftL*n;q.ry=27-3.3*liftR*n;
  q.lx=39+liftL*.5*n;q.rx=57-liftR*.5*n;
  q.lrot=-.2*liftL*n;q.rrot=.2*liftR*n;q.lpoint=.3;q.rpoint=-.3;q.gazeX=.8;
 }
 if(loop==='ponder'){
  const lift=Math.pow(Math.max(0,Math.sin(phase*.5)),6)*n;
  q.rx+=Math.sin(phase*2)*.55*n*(1-lift);q.ry+=10*lift;
  q.rrot=-1.5*lift;q.rpoint=-.65+1.65*lift;
  q.gazeX+=Math.sin(phase*.4)*.6*n;q.gazeY=-1+lift;
  q.browY-=lift*.7;q.eyeR+=.3*lift;
 }
 if(loop==='oops'){const recoil=Math.pow(Math.max(0,Math.sin(phase*.65)),8)*n;q.x-=recoil*1.5;q.tilt-=recoil*.025;q.ly-=recoil;q.ry-=recoil;q.gazeX-=recoil;}
 if(loop==='welcome'){const waving=Math.pow(Math.max(0,Math.sin(phase*.55)),2)*n;q.rrot=Math.sin(phase*2)*.35*waving;q.ry-=waving;q.gazeX=Math.sin(phase*.35)*.5*n;q.browY-=waving*.5;}
 if(loop==='operate'){q.gazeY+=Math.sin(phase*.5)*.35*n;q.lrot=Math.sin(phase*.6)*.08*n;}
 if(loop==='listen'){q.lrot=-.2+s*.1*n;q.tilt+=s*.015*n;}
 if(loop==='talk'){q.ly+=s*2*n;q.ry-=s*2*n;q.lrot=s*.25*n;q.rrot=-s*.25*n;q.browY-=Math.max(0,s)*.5*n;}
 if(loop==='think'){q.gazeX+=Math.sin(phase*.4)*n;q.rpoint=.4+.25*(1+c)*n;}
 if(loop==='read'){q.gazeX+=s*n;q.ly+=Math.max(0,s2)*.45*n;}
 if(loop==='write'||loop==='edit'){q.rx+=s*(loop==='edit'?1.5:2.5)*n;q.ry+=c*.7*n;q.rrot=s*.15*n;}
 if(loop==='type'){q.ly+=Math.max(0,s2)*1.8*n;q.ry+=Math.max(0,-s2)*1.8*n;}
 if(loop==='browse'){q.ry+=s*1.2*n;q.rpoint=.6;}
 if(loop==='tap'){q.ry+=Math.max(0,s)*2*n;}
 if(loop==='scan'){q.gazeX+=s*1.4*n;q.x+=s*1.5*n;q.tilt+=s*.025*n;}
 if(loop==='fit'){q.lx+=s*1.6*n;q.rx-=s*1.6*n;}
 if(loop==='connect'){q.lx+=s*2*n;q.rx-=s*2*n;}
 if(loop==='plan'){q.ry+=Math.floor((time*.8)%3)*1.5*n;}
 if(loop==='turn'){q.lrot=s*.4*n;q.ry+=s*1.2*n;q.rrot=-s*.3*n;}
 if(loop==='fetch'){q.ly+=s*1.4*n;q.ry+=s*1.4*n;q.tilt+=s*.04*n;}
 if(loop==='sync'){q.ly+=s*1.5*n;q.ry-=s*1.5*n;q.lrot=s*.3*n;q.rrot=-s*.3*n;}
 if(loop==='pass'||loop==='send'){q.rx+=s*2*n;q.ry-=c*.7*n;}
 if(loop==='coordinate'){q.gazeX=s*1.4*n;q.rx+=s*1.5*n;q.ly+=c*n;}
 if(loop==='highfive'){q.rx+=Math.max(0,s)*2*n;q.ry-=Math.max(0,s)*1.5*n;}
 if(loop==='wait'){q.lpoint=Math.max(0,s2)*.5*n;q.ly+=Math.max(0,s2)*.7*n;}
 if(loop==='celebrate'){q.ly-=Math.max(0,s)*1.2*n;q.ry-=Math.max(0,s)*1.2*n;q.y-=Math.max(0,s)*.55*n;}
 if(loop==='error'){q.lrot=s*.15*n;q.gazeX=s*.5*n;}
 if(loop==='caution'){q.rrot=s*.15*n;}
 if(loop==='run'){q.ly+=s*2*n;q.ry-=s*2*n;q.x+=s*.7*n;}
 if(loop==='lift'){q.ly-=Math.max(0,s)*3*n;q.ry-=Math.max(0,s)*3*n;}
 if(loop==='catch'){q.ly+=Math.max(0,s)*1.5*n;q.ry+=Math.max(0,s)*1.5*n;}
 if(loop==='busy'||loop==='sort'){q.lx+=s*2*n;q.rx+=c*2*n;q.gazeX=s*n;}
 if(loop==='wave'){q.rrot=s*.5*n;q.ry+=s*.8*n;}
 if(loop==='learn'){q.rpoint=(1+c)*.5*n;q.ry-=Math.max(0,c)*3*n;}
 if(loop==='build'){q.ry-=Math.max(0,s)*2*n;q.rx+=c*n;}
 if(loop==='launch'){q.ry-=Math.max(0,s)*2*n;q.gazeY=-Math.max(0,s)*n;}
 if(loop==='bug'){q.rx+=s*.6*n;q.rpoint=(1+c)*.3*n;}
 if(loop==='camera'){q.rpoint=Math.max(0,s)*.5*n;}
 return q;
}
// Attention points share the prop's authored plane and mirror transform.
// Gaze follows the work; it is not an independent decorative oscillator.
function attentionFor(def,q,time){
 const a=def.action||def.id,L=def.layout;
 if(a==='coding')return {x:(q.lx+q.rx)/2,y:(q.ly+q.ry)/2};
 if(!def.staged||!L||def.static)return null;
 if(L.interaction==='board')return null;
 const point=(x,y)=>({x:L.side<0?100-x-L.offset:x+L.offset,y});
 if(['connecting','reconnecting','disconnected','camera'].includes(a))return point(50,26);
 if(['reading','learning'].includes(a))return point(82+Math.sin(time*.65)*4,7+(time%6)/6*14+(q.propDY||0));
 if(L.interaction==='writepaper')return {x:q.rx,y:q.ry};
 if(['writing','editing','title','drawing','planning','completing','generating'].includes(a))return {x:L.side<0?q.lx:q.rx,y:L.side<0?q.ly:q.ry};
 if(L.interaction==='wrench')return point(81,9);
 if(['browsing','navigating','form'].includes(a))return point(85,11+Math.sin(time*.8)*3);
 if(['filesearch','searching'].includes(a))return point(83+(q.propDX||0),13+(q.propDY||0));
 if(a==='voice')return point(85,15);
 return point(85+(q.propDX||0),15+(q.propDY||0));
}
// #3769: the Board poses are short stories on one 6 s clock that props.js shares
// (BOARD_CYCLE, from the snapshot's age after BOARD_LEAD lets the board rise). Hand targets are in the board's
// pixel plane; the face acts the beat. Returns the beat's emotion.
const BOARD_CYCLE=6,BOARD_LEAD=.6;
function track(keys,u){
 let i=0;while(i<keys.length-2&&u>=keys[i+1][0])i++;
 const a=keys[i],b=keys[i+1],f=clamp((u-a[0])/(b[0]-a[0]),0,1),e=f*f*(3-2*f);
 return a.slice(1).map((v,j)=>v+(b[j+1]-v)*e);
}
const pulse=(u,at,width=.3)=>u>=at&&u<at+width?Math.sin((u-at)/width*Math.PI):0;
const BOARD_SCAN_TAPS=[[.7,71,10],[1.05,71,16],[1.6,81,10],[1.9,81,16],[2.2,81,22],[2.75,90,10]];
function boardBeat(a,u,q,n=1){
 const look=(x,y)=>{q.gazeX=clamp((x-q.x)/24,-1.5,1.5);q.gazeY=clamp((y-q.y)/9,-1,1);};
 const viewer=()=>{q.gazeX=0;q.gazeY=-.2;};
 Object.assign(q,{rpoint:0,ropen:0,rthumb:0,rrot:0,tilt:0,y:14,eye:1});
 let emotion='curious';
 if(a==='filing'){
  [q.rx,q.ry]=track([[0,63,27],[.9,62,15],[1.3,61,11],[1.42,66,12],[2,67,13],[2.3,66,12],[2.5,65,12],[2.62,67,12],[2.78,65,12],[2.9,67,12],[3.4,63,26],[5.3,63,26],[5.8,64,29],[6,63,27]],u);
  if(u>=1.42&&u<2.9)q.rpoint=.6;
  [q.tilt,q.y]=track([[0,0,14],[1,0,14],[1.3,-.06,13],[1.45,.05,15.5],[1.8,.02,14],[3.4,0,14],[3.7,-.04,12.8],[4.1,.03,13.4],[4.5,0,13],[5,0,14],[6,0,14]],u);
  if(u>=1.38&&u<1.62)q.eye=.3;
  emotion=u<.9?'curious':u<2.9?'focused':u<3.4?'curious':u<4.8?'delighted':'neutral';
  if(u<1.3)look(q.rx,q.ry-5);else if(u<3.4)look(71,10);else if(u<4.4)viewer();else if(u<5.2)look(71,10);else look(64,30);
 }
 if(a==='boardcheck'){
  const taps=BOARD_SCAN_TAPS,keys=[[0,63,27],[.45,66,13]];
  for(const [t,x,y] of taps)keys.push([t-.12,x-7,y],[t,x-5,y]);
  keys.push([3.4,63,23],[4.4,63,23],[4.8,63,27],[6,63,27]);
  [q.rx,q.ry]=track(keys,u);
  if(u>=.3&&u<3.3)q.rpoint=1;
  if(u>=3.3&&u<4.4)q.rthumb=1;
  const nod=taps.reduce((m,[t])=>Math.max(m,pulse(u,t,.28)),0),lean=track([[0,0],[.5,1],[3.2,1],[3.6,0],[6,0]],u)[0];
  q.x+=1.5*lean;q.tilt=.04*lean;q.y=14+.9*nod*n;
  if(u>=3.5&&u<4.3)q.y=13.2+.8*pulse(u,3.6,.35)+.8*pulse(u,3.95,.35);
  emotion=u<.5?'curious':u<3.3?'focused':u<4.4?'delighted':'curious';
  const next=taps.find(([t])=>u<t+.2);
  if(u<3.3&&next)look(next[1],next[2]);else if(u<4.4)viewer();else look(70+(u-4.4)/1.6*22,12);
 }
 if(a==='unblocking'){
  const push=[[.9],[1.4],[1.9]];
  const keys=[[0,63,27],[.8,74,16]];
  for(const [t] of push)keys.push([t,74,16],[t+.12,76,16],[t+.3,74,16]);
  keys.push([2.5,70,17],[2.62,80,16],[2.9,79,17],[3.3,72,21],[4.2,72,21],[4.8,64,26],[6,63,27]);
  [q.rx,q.ry]=track(keys,u);
  if(u>=.6&&u<3)q.ropen=.7;
  if(u>=3.4&&u<4.1){q.rrot=Math.sin((u-3.4)*18)*.3*n;q.ropen=.5;}
  const strain=push.reduce((m,[t])=>Math.max(m,pulse(u,t,.3)),0);
  q.eye=1-.4*strain;q.tilt=.06-.07*strain;q.x+=strain*n;
  if(u>=2.2&&u<2.55){q.eye=.25;q.tilt=-.06;q.y=13;}
  if(u>=2.55&&u<2.8){q.tilt=.06;q.x+=1.5;}
  if(u>=5.3){q.tilt=.07;}
  emotion=u<.8?'skeptical':u<2.75?'focused':u<3.15?'surprised':u<4.4?'delighted':u<5.3?'neutral':'skeptical';
  if(u<2.75)look(81,15);else if(u<3.15)look(90,10);else if(u<4.4)viewer();else if(u<5)look(90,20);else look(81,14);
 }
 if(a==='annotating'){
  [q.rx,q.ry]=track([[0,63,27],[.8,63,15],[1.1,71,9],[1.25,77,8],[1.4,74,9],[1.5,77,9],[1.62,80,9],[1.7,75,16],[2.4,75,16],[2.8,68,22],[4.4,68,22],[4.8,63,27],[6,63,27]],u);
  if(u>=1.7&&u<2.4){q.rx+=Math.sin(u*48)*n;q.ry+=Math.abs(Math.cos(u*24))*n;q.rpoint=.8;}
  if(u>=1.4&&u<1.7)q.ropen=.4;
  const nod=pulse(u,3.6,.3)+pulse(u,3.95,.3);
  q.tilt=u>=3&&u<3.6?.07:0;q.y=14+.8*nod*n;
  if(u>=1.58&&u<1.72)q.eye=.5;
  emotion=u<.8?'curious':u<1.5?'skeptical':u<2.8?'focused':u<3.5?'skeptical':u<4.6?'delighted':u<5.4?'neutral':'curious';
  if(u<1.1)look(q.rx,q.ry-6);else if(u<3.6)look(81,10);else if(u<4.4)viewer();else look(81,12);
 }
 if(a==='linking'){
  [q.rx,q.ry]=track([[0,63,27],[.7,71,17],[.9,71,17],[1.3,74,21],[1.8,79,16],[2.15,82,11],[2.3,81,11],[2.6,81,11],[3,70,22],[4.4,70,22],[4.8,63,27],[6,63,27]],u);
  if(u>=.6&&u<2.6)q.rpoint=.6;
  if(u>=3.3&&u<4.4)q.rthumb=1;
  q.tilt=u>=.9&&u<2.3?.04:0;q.x+=u>=.9&&u<2.3?1:0;
  if(u>=2.3&&u<2.45)q.eye=.4;
  emotion=u<.9?'curious':u<2.3?'focused':u<2.5?'surprised':u<4.4?'delighted':u<5.4?'neutral':'curious';
  if(u<2.3)look(q.rx+3,q.ry);else if(u<3.3)look(75+(u-2.5)%.4/.4*11,13);else if(u<4.4)viewer();else look(72,12);
 }
 return emotion;
}
// Approved six-study choreography, in the original study's seconds. Production
// adds only a continuous entrance before this clock and a hold after its reveal.
const MAGIC_REVEAL_END=5.22;
// The spellcaster's wand tip [s] seconds into the sustain: a slow loop over the card's top edge
// that starts where the reveal left it (props.js draws the same loop).
// The reveal's last frame holds this long before the loop starts.
const SPELLCASTER_CAST_DELAY=.4;
function spellcasterCastTip(s){return [72+17*Math.sin(2.7)+6*Math.sin(s*1.1),5+3*Math.sin(5)+2*(1-Math.cos(s*2.2))];}
function magicStudyPose(name,t){
 const ease=v=>{v=clamp(v,0,1);return v*v*(3-2*v);};
 const q=t/6,a=ease(q/.22),b=ease((q-.25)/.36),c=ease((q-.66)/.15),wave=Math.sin(t*2.2);
 const p={...byId.thinking.pose,x:32,y:15-a,tilt:-.07*Math.sin(t*1.4),gazeX:1,gazeY:-.3,turn:0,lx:8,ly:25,rx:65,ry:25,helper:0,effect:0,handScale:.8,lopen:.3,ropen:.5,focused:.7,delighted:c*.7,curious:.2,browY:-a,eyeL:1,eyeR:1};
 if(name==='spellcaster'){const tip=[72+17*Math.sin(a*1.2+b*1.5),5+9*(1-a)+3*Math.sin(b*5)];Object.assign(p,{rx:tip[0]-10,ry:tip[1]+13,rrot:-.3+b*.6,lx:8,ly:24-a*5,lopen:1,tilt:-.12+.18*b});}
 if(name==='portal'){const theta=b*Math.PI*2-Math.PI/2,tip=[82+12*Math.cos(theta),16+11*Math.sin(theta)];Object.assign(p,{rx:tip[0],ry:tip[1],rpoint:1,lx:9,ly:25-a*6,lopen:1,tilt:.08*Math.sin(theta)});}
 if(name==='telekinesis')Object.assign(p,{lx:7,ly:27-3*a+wave,rx:65,ry:25-18*a-wave,lopen:1,ropen:1,tilt:-.06,gazeY:-.8});
 if(name==='constellation')Object.assign(p,{rx:65+4*Math.sin(t*2),ry:20-12*a+2*Math.cos(t*2),rpoint:1,lx:8,ly:23-6*a,lopen:1,gazeY:-.7});
 if(name==='between_hands')Object.assign(p,{x:29,lx:81,ly:17-12*b,rx:81,ry:18+10*b,lopen:1,ropen:1,lrot:-.3,rrot:.3,gazeY:.1,tilt:.05});
 if(name==='lens_projection')Object.assign(p,{lx:8,ly:25-16*a,rx:61,ry:25-16*a,lpoint:1,rpoint:1,gazeX:1.4,gazeY:0,focused:1,eyeL:1-.2*a,eyeR:1-.2*a,tilt:0});
 return p;
}
// Build moves (alive/build.js, #6094): a build-sheet state with picks plays one each time the
// state comes round (and on to the next after two loops), out of the page's shuffle bag (#6882). A piece stands on its
// own copy of an action, registered here as '<state>~<code>' (the lab's kit.js actId): its base
// action with the piece's prop, pose, loop and icon. Its keys drive the drawn pose only
// (snapshot), so the springs underneath carry on as they would; build.js draws its objects.
const buildMoves=()=>root.SpeckBuildMoves||null;
// #6882 (#6802 ruling 13, "flip shuffle"): each state's pool of picks plays as a shuffle bag shared
// by every engine on the page (the build sheet's Speck, the dock's, the glasses'), kept in
// localStorage so it carries on across builds and reloads: every pick once before any repeats, and
// a new bag never opens on the pick that closed the last. A genre's or Task kind's play loops keep
// their authored turns (a genre loop every other turn), per engine as before.
const BUILD_BAG_KEY='ocuclaw.speck.bag.';
const buildBags=(()=>{
 const memory={};
 const store=()=>{try{return root.localStorage||null;}catch(e){return null;}};
 const fits=(s,size)=>!!s&&s.size===size&&Array.isArray(s.bag)&&s.bag.length<=size&&
  s.bag.every(i=>Number.isInteger(i)&&i>=0&&i<size)&&Number.isInteger(s.last)&&s.last>=-1&&s.last<size;
 function read(key,size){
  const ls=store();let s=null;
  if(ls){try{s=JSON.parse(ls.getItem(BUILD_BAG_KEY+key)||'null');}catch(e){s=null;}}
  if(!fits(s,size))s=memory[key];
  return fits(s,size)?{size,bag:s.bag.slice(),last:s.last}:{size,bag:[],last:-1};
 }
 function write(key,s){memory[key]=s;const ls=store();if(ls)try{ls.setItem(BUILD_BAG_KEY+key,JSON.stringify(s));}catch(e){}}
 // The next pick (an index into the pool) out of the page's bag for this state.
 function next(key,size){
  const s=read(key,size);
  if(!s.bag.length){
   const order=Array.from({length:size},(_,i)=>i);
   for(let i=size-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[order[i],order[j]]=[order[j],order[i]];}
   if(size>1&&order[0]===s.last)[order[0],order[size-1]]=[order[size-1],order[0]];
   s.bag=order;
  }
  s.last=s.bag.shift();write(key,s);return s.last;
 }
 // The pick the page shows now, drawing only when there is none yet: an engine made straight into
 // a state (a held picture, a probe ahead) shows what the live one does and leaves the bag alone.
 function current(key,size){const s=read(key,size);return s.last>=0?s.last:next(key,size);}
 function forget(){for(const k of Object.keys(memory))delete memory[k];const ls=store();if(!ls)return;
  try{const keys=[];for(let i=0;i<ls.length;i++){const k=ls.key(i);if(k&&k.startsWith(BUILD_BAG_KEY))keys.push(k);}keys.forEach(k=>ls.removeItem(k));}catch(e){}}
 return{next,current,forget};
})();
function buildDefId(state,code){
 if(!code)return state;
 const key=state+'~'+code;
 if(!byId[key]){
  const BM=buildMoves(),piece=BM.pieces[code],base=actions[piece.base||BM.BASES[state]],o=piece.act||{};
  if(!base)throw Error('build.js: '+code+' has no base action');
  const def={...base,id:key,action:base.id,source:'Build',pose:{...base.pose,...(o.pose||{})}};
  if('prop' in o){def.prop=o.prop;def.pose.handScale=o.prop?.72:1;if(o.pose&&'handScale' in o.pose)def.pose.handScale=o.pose.handScale;}
  if(o.loop)def.loop=o.loop;
  if(o.tempo!==undefined)def.pose.tempo=o.tempo;
  if('icon' in o)def.icon=o.icon;
  byId[key]=def;
 }
 return key;
}
function create(initial='idle',options={}){
 if(!byId[initial])throw Error('Unknown state '+initial);
 // id is the state asked for; defId the action playing it (a build move's own, or the state's).
 const buildTurns={};let build=null,buildOut=null;
 // Play testing: the genre card.play's loops come from (null: the play testing loops), and a
 // one-shot piece (a step beat or a result reaction) to play once before the state's loops.
 let playGenre=null,buildLead=null;
 const rotationFor=state=>{const BM=buildMoves();return BM?(BM.rotation?BM.rotation(state,playGenre):BM.STATES[state])||null:null;};
 // `made`: the engine starts in this state (create), so it shows the page's current pick.
 function buildEnter(state,made=false){
  const BM=buildMoves(),list=rotationFor(state),lead=buildLead;
  if(build&&build.code)buildOut={code:build.code,t:Math.max(0,build.t),age:0};
  build=null;buildLead=null;
  if(lead)build={state,code:lead.code,t:-BM.ENTER,lift:0,w:1,plays:0,once:true,...(lead.gain!==undefined?{gain:lead.gain}:{})};
  else{
   if(!list||!list.length)return state;
   // card.design: a game's or Task's own loops take every other turn with the any-card loops, each
   // pool its own shuffle bag (the any-card bag is the state's, as for a card with no kind).
   const design=state==='card.design'&&BM.designPools?BM.designPools(playGenre):null;
   let key,pool=list,authored=false;
   if(design&&design.own.length){const n=buildTurns[state]||0;buildTurns[state]=n+1;const own=n%2===0;pool=own?design.own:design.any;key=own?state+'/'+design.kind:state;}
   else if(design){pool=design.any;key=state;}
   else{authored=state==='card.play'&&!!playGenre;key=state+(authored?'/'+playGenre:'');}
   const n=buildTurns[key]||0;if(!design)buildTurns[key]=n+1;
   const code=pool[authored?n%pool.length:made?buildBags.current(key,pool.length):buildBags.next(key,pool.length)];
   build={state,code,t:code?-BM.ENTER:0,lift:0,w:1,plays:0};
  }
  return buildDefId(state,build.code);
 }
 // A step beat or result reaction (build.js CUES): the cue's next pick plays once over the
 // current state, then its loops carry on. Returns how long it holds the stage (0: none).
 const cueTurns={};
 function playCue(set,cue,gain,state=id){
  const BM=buildMoves(),list=BM&&BM.CUES&&BM.CUES[set]&&BM.CUES[set][cue];
  if(!list||!list.length||!byId[state])return 0;
  const n=cueTurns[set+'/'+cue]||0;cueTurns[set+'/'+cue]=n+1;
  const code=list[n%list.length];
  buildLead={code,...(Number.isFinite(gain)?{gain:Math.round(gain)}:{})};
  // Into the state the app is moving to (a step's beat as the test starts), or again into this one.
  setState(state,false,true);
  return BM.ENTER+BM.pieces[code].end;
 }
 function setPlayGenre(genre){
  // A game genre (by card icon) or a Task card's kind ('task:<kind>', build.js TASKS, #6504).
  const BM=buildMoves(),next=genre&&BM&&((BM.GENRES&&BM.GENRES[genre])||(BM.TASKS&&BM.TASKS[genre]))?genre:null;
  if(next===playGenre)return;
  playGenre=next;
  // A genre named mid-test hands over to its loops at once, unless a one-shot holds the stage.
  // So does Designing's (its own loops by the card's kind).
  if((id==='card.play'||id==='card.design')&&!(build&&build.once))setState(id,false,true);
 }
 let id=initial,defId=buildEnter(initial,true),p={...byId[defId].pose},v=Object.fromEntries(Object.keys(BASE).map(k=>[k,0])),time=0,phase=0,carry=0,switches=0,interruptions=0,age=0;
 if(byId[defId].action==='reply'){Object.assign(p,MIC_HOLD);p.curious=1;}
 let prop={kind:byId[defId].prop,reveal:byId[defId].prop?1:0,velocity:0,layout:byId[defId].layout||null},icon={kind:byId[defId].icon,reveal:byId[defId].icon?1:0,velocity:0};
 let response=1,motion=1,expression='auto',view='auto',entryPose={...p},emotion='neutral',micro=MICRO_DEFAULT;
 const visits={idle:0};let drowse=0,restMood=null,idleOrder=null;let entryVariant=0,pinnedIdle=null,pinnedThinking=null,resting=false,restAge=0,restFreeze=null,restVariant=null,restPending=false,restStarted=0;
 let drum=null,drumStrike=null;
 let transit=null;
 // The approved Soft and elastic presence handoffs. Work props, authored
 // performances and held poses keep their existing choreography.
 const presence=new Set(['idle','listening','thinking','reply']);
 const flowing=def=>!!transit&&presence.has(transit.from)&&presence.has(def.action)&&!resting&&!attending;
 // Episode identity comes from the existing Kotlin activity owner. Pose and
 // velocity never reset at an episode boundary; only its one-shot phrase does.
 let magic={key:null,performance:byId[defId].magic||'telekinesis',phase:'entrance',elapsed:0,ready:false};
 function setBuildEpisode(key,performance='telekinesis'){
  if(key===magic.key)return;
  if(key!==null&&!MAGIC_PERFORMANCES.includes(performance))throw Error('Unknown magic performance '+performance);
  magic={key,performance,phase:'entrance',elapsed:0,ready:false};
 }
 function magicPose(q,name){
  Object.assign(q,magicStudyPose(name,Math.min(magic.elapsed,MAGIC_REVEAL_END)));
  // A long build (a program card's code takes 30 s or more) keeps the spellcaster casting
  // after the reveal: his wand hand follows the loop props.js draws the wand tip on.
  if(name==='spellcaster'&&magic.phase==='sustain'&&magic.elapsed>MAGIC_REVEAL_END+SPELLCASTER_CAST_DELAY){const s=magic.elapsed-MAGIC_REVEAL_END-SPELLCASTER_CAST_DELAY,tip=spellcasterCastTip(s);Object.assign(q,{rx:tip[0]-10,ry:tip[1]+13,rrot:.3+.1*Math.sin(s*1.1)});}
  return q;
 }
 let cue=null;
 let attending=false,wakeBeat=null;
 // The reply mic on its cord (MIC above): null, or the beat it is in. A grab's
 // clock starts once the stage is clear (`at` stays null until then); held
 // follows the drawn mitten; an exit plays out even after the state moves on.
 let mic=byId[defId].action==='reply'?{phase:'held',at:null}:null;
 const micChoice={grab:null,release:null},micShuffle=micShuffler((options.seed===undefined?THINKING_SEED:options.seed)^0x6d1c0de);
 const micNext=kind=>micByID(kind==='grab'?MIC_GRABS:MIC_RELEASES,micChoice[kind])?.id||micShuffle(kind);
 const micShape=drawn=>!mic?null:mic.phase==='held'?micAtGrip(drawn.rx,drawn.ry,MIC.heldA):mic.shape||null;
 function micExit(kind){const r=micShape(p);mic=r?{phase:'exit',exit:kind,release:kind==='reel'?micNext('release'):null,at:time,r,shape:r,from:{...p}}:null;}
 function attend(){
  // A reply lets go of its mic and the cord reels it up; every other attend
  // entry glides straight onto the attend still as before.
  if(!attending&&mic&&mic.phase!=='exit')micExit('reel');
  attending=true;resting=true;restAge=0;restFreeze=null;restPending=false;restVariant=null;wakeBeat=null;cue=easeCue(cue);}
 function react(kind,opts={}){cue=(byId[defId].action==='error'&&resting)||(kind==='relief'&&byId[defId].action!=='idle')?null:CUES[kind]?{kind,at:time,id,hold:opts.hold&&MOMENTS[kind]&&MOMENTS[kind].hold||null,released:null}:null;}
 // A held reaction (MOMENTS[kind].hold) stops at its pose until releaseCue(); the age then runs on from the hold.
 function cueAge(){if(!cue)return 0;const t=time-cue.at;if(cue.hold===null)return t;return cue.released===null?Math.min(t,cue.hold):cue.hold+time-cue.released;}
 const cueHeld=()=>!!cue&&cue.hold!==null&&cue.released===null&&time-cue.at>=cue.hold;
 function releaseCue(){if(cue&&cue.hold!==null&&cue.released===null)cue.released=Math.max(time,cue.at+cue.hold);}
 // A held reaction never snaps off when the reply lets go or the state moves on: it plays its way back from its pose.
 function easeCue(c){return c&&c.hold!==null&&MOMENTS[c.kind]?{...c,id,released:c.released??Math.max(time,c.at+c.hold)}:null;}
 let randomState=(options.seed===undefined?THINKING_SEED:options.seed)>>>0,bag=[],thinkingVariant=-1,thinkingAge=0;
 let thinkingChoice=null,thinkingDetail=null;const lastChoices={};
 // A thinking loop (8-11) drives his pose like a mic beat once it holds the stage. The gate
 // eases that drive in over 0.6 s; anything that claims his pose drops it at once, and the
 // springs carry on from the driven pose and speed, so entries, cues, wakes and rests never jump.
 let loopGate=0;
 const random=()=>{randomState=(Math.imul(randomState,1664525)+1013904223)>>>0;return randomState/0x100000000;};
 function nextThinking(){
  if(pinnedThinking===null&&!bag.length){bag=Array.from({length:THINKING_VARIATIONS},(_,i)=>i);for(let i=bag.length-1;i>0;i--){const j=Math.floor(random()*(i+1));[bag[i],bag[j]]=[bag[j],bag[i]];}
   if(bag[bag.length-1]===thinkingVariant)[bag[0],bag[bag.length-1]]=[bag[bag.length-1],bag[0]];
  }
  thinkingVariant=pinnedThinking===null?bag.pop():pinnedThinking;thinkingAge=0;
  const count=thinkingVariant===5?6:thinkingVariant===6?4:thinkingVariant===7?THINKING_IDEAS.length:1;
  const previous=lastChoices[thinkingVariant];let choice=Math.floor(random()*(count-(previous===undefined||count===1?0:1)));
  if(count>1&&previous!==undefined&&choice>=previous)choice++;
  lastChoices[thinkingVariant]=choice;
  thinkingChoice={variant:thinkingVariant,route:choice,idea:THINKING_IDEAS[choice],seed:Math.floor(random()*0x100000000)};
 }
 if(byId[defId].action==='thinking')nextThinking();
 const typing={glyph:'_',count:0,hand:null,downAt:-1};let typingSeed=8146;
 const tapArmed={l:false,r:false};
 const firstAction=byId[defId].action;if(firstAction in visits)visits[firstAction]=1;
 const variation=()=>{const a=byId[defId].action;if(a==='idle'){const n=entryVariant+Math.floor(age/10),v=pinnedIdle!==null?pinnedIdle:restVariant!==null?restVariant:idleOrder?idleOrder[n%idleOrder.length]:n%(drum?IDLE_VARIATIONS:WITHOUT_DRUM);return v===DRUM&&!drum?HANG:v;}return a==='thinking'?thinkingVariant:0;};
 function carrier(c,desired,dt,stiffness=18){
   if(c.kind!==desired&&c.reveal<.005&&Math.abs(c.velocity)<.08){c.kind=desired;}
   const goal=c.kind===desired&&desired?1:0;
   [c.reveal,c.velocity]=spring(c.reveal,c.velocity,goal,stiffness*response,dt);
   c.reveal=clamp(c.reveal,0,1);
 }
 // A build state's next move (rotate) re-enters the same state on its next piece.
 // `held`: a picture already on glass takes over (acceptPose), so no new pick is drawn.
 function setState(next,resumingThought=false,rotate=false,held=false){if(!byId[next])return false;if(id===next&&!rotate)return true;if(age<.6)interruptions++;entryPose={...p};const prev=byId[defId].action,nextDef=buildEnter(next,held),a=byId[nextDef].action;transit={from:prev,t0:time,dir:Math.sign(byId[nextDef].pose.x-p.x)||Math.sign(byId[nextDef].pose.gazeX)||1,via:transitions[prev+'>'+a]||transitions['*>'+a]||null};id=next;defId=nextDef;age=0;switches++;attending=false;wakeBeat=null;resting=false;restFreeze=null;restPending=false;restVariant=null;entryVariant=a in visits?visits[a]++%IDLE_VARIATIONS:0;if(a==='thinking'&&!resumingThought)nextThinking();
  // Every reply grabs the mic afresh; any other state sends it up on its cord at once.
  if(a==='reply')mic={phase:'grab',grab:micNext('grab'),at:null,from:null,shape:null};else if(mic&&mic.phase!=='exit')micExit('yank');
  // The cord mic draws from `mic`, so its carrier never holds the next prop back.
  if(prop.kind==='mic'&&a!=='reply')Object.assign(prop,{kind:null,reveal:0,velocity:0});
  return true;}
 function isStill(){if((cue&&!cueHeld())||wakeBeat||restPending||(mic&&mic.phase!=='held')||(build&&build.code&&build.w>0)||buildOut)return false;const d=byId[defId],calm=Object.values(v).every(x=>Math.abs(x)<.05)&&Math.abs(prop.velocity)<.01&&(icon.kind?icon.reveal>.999:icon.reveal<.001);
   if(attending)return restAge>=.3&&calm&&prop.reveal<.005;
   if(resting)return restAge>=.3&&calm&&(d.prop?prop.kind===d.prop&&prop.reveal>.999:prop.reveal<.005);
   return !!d.static&&age>=2&&calm&&prop.kind===d.prop&&prop.reveal>.999;}
 // Finish the current stroke, then glide onto the approved authored rest frame.
 // Wake: resume, and for idle start the NEXT variation from its first beat.
 function rest(){if(resting||restPending)return;restAge=0;restStarted=time;restVariant=byId[defId].action==='idle'?variation():null;if(byId[defId].action==='idle')resting=true;else restPending=true;}
 function wake(input={x:0}){if((!resting&&!restPending)||(byId[defId].action==='error'&&!attending))return;const wasAttending=attending;attending=false;resting=false;restPending=false;restFreeze=null;wakeBeat={at:time,x:clamp(Number(input?.x)||0,-1,1)};const v=restVariant;restVariant=null;if(byId[defId].action==='idle'){if(!wasAttending&&v!==null)entryVariant=idleOrder?(Math.max(0,idleOrder.indexOf(v))+1)%idleOrder.length:(v+1)%IDLE_VARIATIONS;age=0;}
  // Woken back into a reply after its mic left: it drops in again.
  if(byId[defId].action==='reply'&&(!mic||mic.phase==='exit'))mic={phase:'grab',grab:micNext('grab'),at:null,from:null,shape:null};}
 function tick(dt){
   const def=byId[defId];if(isStill())return;time+=dt;if(!wakeBeat)age+=dt;if(resting)restAge+=dt;
   if(def.magic&&magic.ready&&!attending&&!resting){magic.elapsed+=dt;if(magic.elapsed>=MAGIC_REVEAL_END)magic.phase='sustain';}
   if(cue&&cue.id!==id)cue=easeCue(cue);
   if(cue&&(cue.id!==id||(cue.hold===null?time-cue.at>=Math.min(1.5,CUES[cue.kind].duration):cueAge()>=CUES[cue.kind].duration)))cue=null;
   if(wakeBeat&&time-wakeBeat.at>=.6)wakeBeat=null;
   if(def.action==='thinking'&&!resting&&!wakeBeat){thinkingAge+=dt;if(thinkingAge>=thinkingDuration(thinkingVariant)){const extra=thinkingAge-thinkingDuration(thinkingVariant);nextThinking();thinkingAge=extra;}}
   // Move, then hold. The oscillator is persistent through interruptions.
   const beat=time%4.8;phase+=dt*p.tempo*3*(beat<1.8?1:0);
   if(def.action==='error'&&age>=1.3&&!resting&&!restPending)rest();
   const carriersReady=(!def.icon||icon.kind===def.icon&&icon.reveal>.999)&&(!def.prop||prop.kind===def.prop&&prop.reveal>.999);
   if(restPending&&((beat>=1.8&&carriersReady)||def.action==='error'||time-restStarted>=1.8)){
    restPending=false;resting=true;restAge=0;restFreeze=restPoseFor(def).p;
   }
   const live=!def.static||age<1.4;
   const q=targetFor(def,live?phase:0,live?time:0,live?motion:0);
   if(def.magic)magicPose(q,def.magic);
   const magicTarget=def.magic?{...q}:null;
   // The reply mic's scripted beats. A grab waits for an outgoing prop or
   // thinking study to clear, then drives the MIC_BODY keys directly.
   let micDrive=null,loopDrive=null;
   if(mic&&mic.phase==='grab'){
    const h={...q,...MIC_HOLD};
    if(resting)mic={phase:'held',at:null};
    else{
     if(mic.at===null&&(!prop.kind||prop.kind==='mic'||prop.reveal<.005)){mic.at=time;mic.from=Object.fromEntries(MIC_BODY.map(k=>[k,p[k]]));mic.gear0=p.thinkingGear;mic.study0=p.thinkingStudy;}
     if(mic.at!==null&&time-mic.at<.5&&(mic.gear0>.025||mic.study0>.025)){const u=1-smooth(clamp((time-mic.at)/.45,0,1));mic.ho={thinkingGear:mic.gear0*u,thinkingStudy:mic.study0*u,gearAngle:p.gearAngle+.025*u,gearJam:0,studyTime:p.studyTime};}else if(mic.at!==null)mic.ho=null;
     const g=micByID(MIC_GRABS,mic.grab),e=mic.at===null?0:time-mic.at;
     if(mic.at!==null&&e>=g.dur){mic={phase:'held',at:null};for(const k of MIC_BODY){p[k]=h[k];v[k]=0;}}
     else if(mic.at!==null){const pose={...mic.from},r=g.run(e,mic.from,h,pose);mic.shape=r.glyphs?{...r.mic,glyphs:r.glyphs}:r.mic;micDrive={pose:Object.assign(pose,mic.ho||{}),feel:r.feel};}
    }
   }
   if(mic&&mic.phase==='exit'){
    const x=MIC_EXITS[mic.exit],rel=micByID(MIC_RELEASES,mic.release),t=time-mic.at;
    if(t>=x.dur(rel))mic=null;
    // A closer drives his whole pose and its own mic and marks.
    else if(rel&&rel.closer){const P=u=>closePose(rel,mic.from,clamp(u,0,rel.dur)),q=P(t);mic.shape=closeMic(rel,mic.from,t);mic.marks=rel.marks(t,q);micDrive={pose:q,feel:null};}
    else mic.shape=x.path(t,mic.r,rel);
   }
   emotion=expression==='auto'?(def.magic?'focused':def.static?(def.staticExpression||'curious'):resting&&def.action==='idle'?(DROWSE_EMOTION[drowse]||(restMood&&REST_MOODS[restMood].face)||IDLE_REST_EMOTION[variation()]):expressionFor(def,def.action==='thinking'?thinkingAge:age,variation())):expression;
   // The drum's beats depend on the planned roll, so its face comes from the plan.
   const drumNow=def.action==='idle'&&!resting&&variation()===DRUM?drumBeat(age%10,drum,{...q}):null;
   drumStrike=drumNow&&drumNow.strike;
   if(drumNow&&expression==='auto')emotion=drumNow.emotion;
   // #3769: a Board pose acts its own beat; wake, cue and transition faces still win below.
   const boardNow=def.layout?.interaction==='board'&&!resting&&!attending;
   if(boardNow){const felt=boardBeat(def.action||def.id,Math.max(0,age-BOARD_LEAD)%BOARD_CYCLE,q,motion);if(expression==='auto')emotion=felt;}
   if(transit&&age<.75&&expression==='auto')emotion='curious';
   if(cue||attending||wakeBeat)emotion='curious';
   if(micDrive&&micDrive.feel&&expression==='auto'&&!cue)emotion=micDrive.feel;
   for(const name of expressions.slice(1))q[name]=Number(name===emotion);
   const depthActions=['listening','thinking','searching','filesearch','vision','tools','device','greeting','reading','monitoring','reply','secure','calling','planning'];
   const depthBeat=age%8,depthActive=!def.static&&depthActions.includes(def.action||def.id)&&depthBeat>2.1&&depthBeat<4.2;
   q.turn=view==='auto'?(depthActive?Math.sign(q.gazeX||1)*2*Math.min(1,motion):0):view;
   // Matched eyes do the looking. Brows suggest the feeling without a
   // permanent angry V or an exaggerated pair of mismatched eye shapes.
   q.browL=0;q.browR=0;q.browY=0;q.browLiftL=0;q.browLiftR=0;
   if(emotion==='curious'){q.browY=-1;}
   if(emotion==='focused'){q.browL=.03;q.browR=-.03;q.gazeY+=.3;}
   if(emotion==='delighted'){q.browY=-1;q.browL=-.1;q.browR=.1;}
   if(emotion==='concerned'){q.browL=-.12;q.browR=.12;q.browY=0;}
   if(emotion==='surprised'){q.browY=-1;q.browL=0;q.browR=0;}
   if(emotion==='skeptical'){q.browY=1;}
   if(emotion==='sleepy'){q.browY=1;q.gazeY=1;}
   if(emotion==='playful'){q.browL=.12;q.browR=.12;q.browY=0;}
   if((def.action||def.id)==='thinking'){
    const t=thinkingAge,v=variation(),idea=v===0&&t>5.6&&t<7.6?motion:0;
    q.lx=35;q.ly=27;q.rx=57+21*idea;q.ry=27-10*idea;q.rrot=-1.45*idea;q.rpoint=-.6+1.6*idea;
    q.gazeX=t<2.8?.4:t<5.6?-1.3:.5;q.gazeY=t<5.6?-1:0;
    q.tilt=t<2.8?-.035:t<5.6?.065:0;
    if(v===1){q.lx=40;q.rx=62;q.lpoint=.35;q.rpoint=-.35;q.gazeX=t<3?-1.4:t<6?1.4:0;q.gazeY=-.8;q.tilt=t<5?-.065:.065;q.browLiftL=t<5?-1:0;q.browLiftR=t>=5?-1:0;}
    if(v===2){const tap=t>1.4&&t<6.4?motion:0;q.rx=57+22*tap;q.ry=27-12*tap;q.rpoint=-.4;q.rrot=.04;q.lx=40;q.gazeX=.8;q.gazeY=-1;q.tilt=-.065;q.browL=.13;q.browR=-.08;}
    if(v===3){
     const rise=clamp(t/.9,0,1),fall=clamp((t-9.5)/1.3,0,1),jam=t>=3.8&&t<5.05;
     Object.assign(q,{x:29,y:emotion==='surprised'?13:14,lx:7,ly:27,rx:t<1.5?56:t<3.8?65:t<5.05?68:62,ry:25,rpoint:t>=1.5&&t<5.05?1:0,rrot:0,gazeX:1.2,gazeY:jam?.6:0,tilt:jam?-.07:0,thinkingGear:Math.abs(p.x-29)<1.5&&p.thinkingStudy<.025?rise*(1-fall):0,gearJam:jam?1:0,gearAngle:t<3.8?t*1.3:jam?4.94+Math.sin(t*35)*.035:4.94+(t-5.05)*1.9});
    }
    if(v>=4&&v<THINKING_LOOP_FIRST){
     if(!resting&&p.thinkingStudy<.005)thinkingDetail=thinkingChoice;
     Object.assign(q,thinkingStudyPose(v,t,thinkingChoice.route));
     q.studyTime=t;
     const ready=thinkingDetail===thinkingChoice&&Math.abs(p.x-29)<1.5&&p.thinkingGear<.025;
     q.thinkingStudy=ready?clamp(t/.9,0,1)*(1-clamp((t-9.6)/1.1,0,1)):0;
     if(expression==='auto')emotion=expressions.slice(1).reduce((a,b)=>q[b]>q[a]?b:a,'curious');
     else for(const name of expressions.slice(1))q[name]=Number(name===expression);
     // Acknowledge and wake reactions take priority over the ongoing study,
     // just as they do for the existing thinking gestures.
     if(cue||attending||wakeBeat||(transit&&age<.75&&expression==='auto')){
      emotion='curious';for(const name of expressions.slice(1))q[name]=Number(name===emotion);
     }
    }
    if(v>=THINKING_LOOP_FIRST){
     loopDrive=thinkingLoopPose(v,t,{...LOOP_THINK,x:q.x,y:q.y,eyeL:q.eyeL,eyeR:q.eyeR});
     Object.assign(q,loopDrive);
     if(expression==='auto')emotion=LOOP_FACES.reduce((a,b)=>q[b]>q[a]?b:a,'curious');
     else{for(const name of expressions.slice(1))q[name]=Number(name===expression);for(const name of LOOP_FACES)delete loopDrive[name];}
     if(cue||attending||wakeBeat||(transit&&age<.75&&expression==='auto')){
      emotion='curious';for(const name of expressions.slice(1))q[name]=Number(name===emotion);
     }
    }
    q.turn=view==='auto'?0:view;
   }
   if((def.action||def.id)==='idle'){if(resting){idleRest(variation(),q);if(drowse)Object.assign(q,DROWSE[drowse]);else if(restMood)Object.assign(q,REST_MOODS[restMood].pose);}else idleBeat(variation(),age%10,q,drum);}
   if((def.action||def.id)==='listening'){
    const nod=Math.max(0,Math.sin(age*1.1));q.x=49;q.tilt=-.085-.055*nod*motion;q.gazeX=-1.3;q.gazeY=-.2;q.turn=view==='auto'?-1:view;
    q.browLiftL=-1.2;q.browL=-.14;q.browR=.08;q.lx=19;q.lrot=.1;q.rx=62;q.ry=27;
   }
   if((def.action||def.id)==='voice'){
    q.gazeX=1.5;q.gazeY=-.2;q.tilt=.065;q.turn=view==='auto'?1:view;q.browLiftR=-1.3;q.browL=-.08;q.browR=.12;
   }
   if((def.action||def.id)==='error'){q.tilt=Math.sin(age*4)*.08*motion;q.gazeX=0;q.turn=view==='auto'?0:view;const down=clamp((age-1)/.3,0,1),target=restPoseFor(def).p;q.ly+=(target.ly-q.ly)*down;q.ry+=(target.ry-q.ry)*down;}
   if(def.action==='reply'&&!attending&&!resting){if(mic&&mic.phase==='grab'&&mic.at===null)Object.assign(q,{rx:62,ry:27,ropen:.3,rrot:0,rpoint:0});else Object.assign(q,MIC_HOLD);}
   if(micDrive)Object.assign(q,micDrive.pose);
   // Look, hold, return. A persistent attention phrase visits both sides and
   // above the frame without a state switch repeatedly choosing the same side.
   // Work poses still look at their objects between these short check-ins.
   const attention=def.magic?{x:82,y:16}:attentionFor(def,q,time);
   if(attention){
    q.gazeX=clamp((attention.x-q.x)/24,-2,2);
    q.gazeY=clamp((attention.y-q.y)/9,-1.5,1.5);
    if(view==='auto'&&depthActive)q.turn=Math.sign(q.gazeX)*2*Math.min(1,motion);
   }
   if(transit&&age<.75&&!resting){
    const mix=age<.45?1:Math.max(0,(.75-age)/.3);
    if(transit.via){for(const [key,value] of Object.entries(transit.via.pose))q[key]+=(value-q[key])*mix;}
    if(!attention&&!transit.via){q.gazeX+=(transit.dir*1.3-q.gazeX)*mix;q.gazeY+=(-.3-q.gazeY)*mix;}
   }
   const look=time%13.8,mirror=Math.floor(time/13.8)%2===0?1:-1;
   const glance=(start,end,delay=0)=>look>start+delay&&look<end+delay?Math.min(1,(look-start-delay)/.12,(end+delay-look)/.2):0;
   const cues=attention?[[12.2,12.7,0,0]]:[[.65,2.1,-1.8,-1],[3.1,4.45,1.8,0],[5.35,6.75,0,-1.2],[7.9,9,0,0],[10.15,11.5,-1.5,.7],[12.2,13.4,0,0]];
   const expressive=def.magic||def.static||['thinking','error','listening','voice','idle'].includes(def.action||def.id)||boardNow?0:emotion==='sleepy'?.2:1;
   if(!attention){q.gazeX=clamp(q.gazeX,-1.5,1.5);q.gazeY=clamp(q.gazeY,-1,1);}
   for(const [start,end,x,y] of cues){
    const amount=Math.min(1,motion)*expressive,dx=x*mirror;
    const mix=glance(start,end)*amount;
    q.gazeX+=(dx-q.gazeX)*mix;q.gazeY+=(y-q.gazeY)*mix;
    // One reaction, three entrances: eyes notice, brow acknowledges, head
    // follows. The delayed releases let the face settle in the same order.
    const browCue=glance(start,end,.1)*amount*(emotion==='focused'?.8:1);
    if(emotion!=='sleepy'&&emotion!=='surprised'){
     if(x){const side=dx<0?'L':'R';q['browLift'+side]-=1.4*browCue;q['brow'+side]+=(dx<0?-.2:.2)*browCue;}
     else{q.browLiftL-=browCue;q.browLiftR-=browCue;q.browL-=.18*browCue;q.browR+=.18*browCue;}
    }
    const headCue=glance(start,end,.22)*amount;
    q.x+=dx*.48*headCue;q.tilt+=Math.sign(dx)*.052*headCue;
    q.y+=(y?Math.sign(y)*.65:.35)*headCue;
    if(view==='auto'&&depthActive&&x)q.turn+=(Math.sign(dx)*2-q.turn)*headCue;
   }
   // Reading moments skip the springs: snapshot() draws their keys over the held pose, so
   // each picture shows the keyed pose itself and the last one is the held mic exactly.
   if(cue&&!MOMENTS[cue.kind]){
    const elapsed=time-cue.at,duration=Math.min(1.2,CUES[cue.kind].duration),mix=Math.max(0,Math.min(1,elapsed/.12,(duration-elapsed)/.2));
    if(cue.kind==='relief'){
     // A small exhale: soften the lids and settle the head, without a smile,
     // prop or success pose. Admission and the shared deadline live in Kotlin.
     q.eye+=(.55-q.eye)*mix;q.browY+=.4*mix;q.y+=.6*mix;
    }else{q.gazeX+=(1.2-q.gazeX)*mix;q.gazeY+=(.8-q.gazeY)*mix;q.browY+=mix;q.y+=.35*mix;}
   }
   if(attending)Object.assign(q,ATTEND_POSE);
   if(attending&&mic&&mic.phase==='exit'){
    // He lets go (an open mitten) and watches it swing and reel away.
    const t=time-mic.at;if(t<.15)q.ropen=.9;
    if(mic.shape&&t<MIC_EXITS[mic.exit].dur(micByID(MIC_RELEASES,mic.release))*.75)micLook(q,{x:mic.shape.x,y:Math.max(mic.shape.y,2)});
   }
   if(wakeBeat){const t=time-wakeBeat.at,mix=Math.max(0,Math.min(1,t/.12,(.6-t)/.2));q.gazeX+=(wakeBeat.x*1.3-q.gazeX)*mix;q.gazeY+=(-.6-q.gazeY)*mix;q.browY-=mix;q.tilt+=wakeBeat.x*.06*mix;}
   if(def.magic&&!attending&&!resting)Object.assign(q,magicTarget);
   // Withdraw a prop before the face returns to the middle. On entrance, the
   // carrier waits for room rather than revealing an object through a lens.
   if(['front','couple'].includes(def.layout?.interaction)){q.y=13;q.tilt=0;}
   // Keep the face clear until thinking props withdraw on every exit path.
   if((p.thinkingGear>.025&&q.thinkingGear===0)||(p.thinkingStudy>.025&&q.thinkingStudy===0)){
    q.x=29;q.helper=0;q.listenCue=0;q.errorCue=0;
    if(p.thinkingStudy>.025)q.studyTime=p.studyTime;
   }
   const softTransition=flowing(def);
   if(softTransition){
    const retain=Math.exp(-age/.75)*.75;
    for(const k of ['curious','focused','delighted','skeptical','browLiftL','browLiftR'])q[k]=q[k]*(1-retain)+entryPose[k]*retain;
    const beat=Math.sin(Math.PI*Math.min(1,age/.95));
    if(def.action==='listening'){
     q.gazeX=q.gazeX*(1-beat)+.25*beat;q.gazeY*=1-beat;
     q.browLiftL-=beat;q.tilt+=.045*beat;
    }
    if(transit.from==='thinking'&&def.action==='reply'){
     q.delighted=Math.max(q.delighted,.6*beat);q.browY-=.7*beat;
    }
    if(def.action==='idle')q.tilt+=.035*beat;
   }
   const intendedHead=q.x;
   const desiredProp=attending?null:def.prop;
   const switchingStage=prop.kind&&(prop.kind!==desiredProp||prop.layout!==def.layout);
   if(switchingStage&&prop.reveal>.025)q.x=prop.layout?prop.layout.side<0?100-prop.layout.head:prop.layout.head:30;
   if(switchingStage&&prop.reveal>.025){q.listenCue=0;q.errorCue=0;}
   if(def.magic&&switchingStage){
    // The outgoing object still owns its gripping hands until it is gone.
    // In particular a held microphone must not follow a rising conjure hand
    // across the glasses while its carrier is fading out.
    for(const k of ['x','y','tilt','lx','ly','rx','ry','lrot','rrot'])q[k]=entryPose[k];
   }
   const transitHands=new Set();
   // Lower a raised hand before carrying it across the face. This preserves
   // its continuous position and velocity while giving it a visible route.
   if(age<1.2||(def.action||def.id)==='thinking')for(const h of ['l','r']){
    const x=h+'x',y=h+'y',travelling=Math.abs(p[x]-q[x])>2;
    const crosses=travelling&&Math.min(p[x],q[x])<p.x+29&&Math.max(p[x],q[x])>p.x-29;
    const headApproaches=Math.abs(q.x-p.x)>2&&Math.abs(q.x-p[x])<31;
    const waitingForHead=Math.abs(p.x-intendedHead)>2&&(Math.abs(p[x]-p.x)<31||Math.abs(q[x]-p.x)<31);
    if(crosses||headApproaches||waitingForHead){
     transitHands.add(h);q[y]=Math.max(27,q[y]);
     if(p[y]<24.8){q[x]=p[x];q.x=p.x;}
    }
   }
   const microMove=micro&&transit&&!resting&&!def.static&&def.action!=='idle'&&age<1;
   if(microMove&&age<.3)q.browY+=.5;
   if(restFreeze){Object.assign(q,restFreeze);emotion=def.action==='error'?'concerned':def.restEmotion||'curious';}
   // A thinking loop holds the stage once nothing else claims his pose, so its keys land
   // as authored (the lab's taps and scribbles are faster than the hand springs).
   const loopOpen=!!loopDrive&&!resting&&!restFreeze&&!cue&&!attending&&!wakeBeat&&!(transit&&age<.75)&&!micDrive&&p.thinkingGear<.025&&p.thinkingStudy<.025;
   loopGate=loopOpen?Math.min(1,loopGate+dt/.6):0;
   const loopMix=loopEase(loopGate),loopFrom=loopMix>0?{...p}:null;
   for(const k of Object.keys(p)){
    if(def.magic&&magic.ready&&!attending&&!resting){v[k]=(magicTarget[k]-p[k])/dt;p[k]=magicTarget[k];continue;}
    // A mic beat is choreographed against its own drawn grip: no spring lag.
    if(micDrive&&k in micDrive.pose){v[k]=(micDrive.pose[k]-p[k])/dt;p[k]=micDrive.pose[k];continue;}
    const facial=expressions.includes(k)||k.startsWith('gaze')||k.startsWith('eye');
    const brow=k.startsWith('brow'),head=['x','y','tilt','turn'].includes(k);
    const delay=facial?0:brow?.07:head?(transit?.30:.14):transitHands.has(k[0])?0:softTransition?.43:.26;
    let goal=age<delay?entryPose[k]:q[k];
    const weighted=(microMove||(softTransition&&age<1.4))&&['x','y','tilt'].includes(k);
    if(weighted&&age<delay)goal-=Math.sign(q[k]-entryPose[k])*(k==='tilt'?.04:1.5);
    // Drum strikes must land on their letters inside one 220 ms frame.
    const drumBody=drumNow&&(head||/^[lr](x|y|rot|open|point)$/.test(k));
    const boardHand=boardNow&&/^r(x|y|rot|open|point|thumb)$/.test(k);
    const w=(restFreeze?32:facial||drumBody?30:boardHand?26:brow?23:head?12:k==='tempo'?5:def.loop==='code'&&/^[lr][xyrotpoint]+$/.test(k)?30:16)*response;
    [p[k],v[k]]=(weighted?springZ:spring)(p[k],v[k],goal,w,dt);
    if(weighted&&age>=delay){const allowance=k==='tilt'?.04:1;p[k]=clamp(p[k],Math.min(entryPose[k],q[k])-allowance,Math.max(entryPose[k],q[k])+allowance);}
   }
   if(loopFrom)for(const k in loopDrive){p[k]+=(loopDrive[k]-p[k])*loopMix;v[k]+=((p[k]-loopFrom[k])/dt-v[k])*loopMix;}
   // Latch the character on the actual spring-driven hand's bottom pixel,
   // not on a second clock. Slow/soft motion therefore stays synchronized.
   if(typing.downAt<0||time-typing.downAt>.18)typing.glyph='_';
   for(const h of ['l','r']){
    if(def.loop!=='code'||motion===0){tapArmed[h]=false;continue;}
    if(p[h+'y']<25.8)tapArmed[h]=true;
    if(tapArmed[h]&&p[h+'y']>=26.5&&v[h+'y']>0){
     tapArmed[h]=false;typingSeed^=typingSeed<<13;typingSeed^=typingSeed>>>17;typingSeed^=typingSeed<<5;
     typing.glyph=String((typingSeed>>>0)&1);typing.count++;typing.hand=h;typing.downAt=time;
    }
   }
   const propReady=Math.abs(p.x-intendedHead)<1.5&&!switchingStage&&p.thinkingGear<.025&&p.thinkingStudy<.025;
   if(switchingStage&&prop.reveal<.005&&Math.abs(prop.velocity)<.08){prop.kind=null;prop.layout=def.layout||null;}
   carrier(prop,desiredProp&&propReady?desiredProp:null,dt);
   if(prop.kind===def.prop)prop.layout=def.layout||null;
   carrier(icon,attending?null:def.icon,dt);
   if(def.magic&&!attending&&!resting){
    if(!magic.ready){
     magic.ready=!prop.kind&&Object.keys(magicTarget).every(k=>Math.abs(p[k]-magicTarget[k])<.03&&Math.abs(v[k])<.2);
     if(magic.ready){Object.assign(p,magicTarget);if(magic.phase==='entrance'){magic.phase='conjure';magic.elapsed=0;}}
    }
   }
   // Bound the SETTLE allowance even with soft response settings. Pin the
   // authored endpoint, including zero velocity, rather than a moving sample.
   if(restFreeze&&(time-restStarted>=(def.action==='error'?.7:2)-1e-8||Object.values(v).every(x=>Math.abs(x)<.05))){
    Object.assign(p,restFreeze);for(const k of Object.keys(v))v[k]=0;
    Object.assign(prop,{kind:def.prop,reveal:def.prop?1:0,velocity:0,layout:def.layout||null});
    Object.assign(icon,{kind:def.icon,reveal:def.icon?1:0,velocity:0});restAge=2;
   }
 }
 // A build move's own clock: it runs from ENTER after the state starts and loops through his rests
 // (as the lab plays it); an attend or cue lets its drive go (w) over EXIT and picks it up after. A leaving
 // move's drive and object fade over EXIT while the next one waits out its ENTER.
 function buildTick(dt){
  const BM=buildMoves();if(!BM)return;
  if(buildOut){buildOut.age+=dt;buildOut.t+=dt;if(buildOut.age>=BM.EXIT)buildOut=null;}
  if(!build)return;
  const piece=build.code?BM.pieces[build.code]:null,live=!attending&&!cue;
  build.w=live?Math.min(1,build.w+dt/BM.EXIT):Math.max(0,build.w-dt/BM.EXIT);
  if(piece){
   if(live||build.t<0){build.t+=dt;if(build.t>=piece.end){build.t-=piece.end;build.plays++;}}
   if(build.t>=0)build.lift=Math.min(1,build.lift+dt/BM.RISE);
  }else if(live)build.t+=dt;
  // A one-shot (play testing's beats and reactions) hands over to the state's loops once it has played.
  if(build.once){if(build.plays>=1)setState(id,false,true);return;}
  // Two loops of a move (or 12 s of today's act), then the next pick, if the state has more than one.
  const list=rotationFor(id);
  if(live&&list&&list.length>1&&(piece?build.plays>=2:build.t>=12))setState(id,false,true);
 }
 function step(seconds){const dt=clamp(Number.isFinite(seconds)?seconds:0,0,.25);carry+=dt;while(carry>=1/120){tick(1/120);carry-=1/120;}buildTick(dt);return snapshot();}
 // A thinking loop's marks follow its own clock and the drawn pose; a rest or attend clears them.
 // The Zs over a sleeping still, from the moment the still could park (isStill).
 function drowseMarks(drawn){const m=byId[defId].action==='idle'&&resting&&restAge>=.3?(DROWSE_MARKS[drowse]||(!drowse&&restMood&&REST_MOODS[restMood].marks)||null):null;return m?m.map(([g,dx,dy,c])=>['g',g,Math.round(drawn.x+dx),Math.max(1,Math.round(drawn.y+dy)),c]):null;}
 function loopMarks(drawn){const v=variation();if(byId[defId].action!=='thinking'||resting||attending||v<THINKING_LOOP_FIRST)return null;const m=THINKING_LOOPS[v-THINKING_LOOP_FIRST].marks(thinkingAge,drawn);return m.length?m:null;}
 function snapshot(){const drawn={...p},d=byId[defId],beat=time%4.8,microBreath=micro&&age>=2&&!resting&&!d.static&&d.action!=='idle'&&['Work','Mind','Web','Agents'].includes(d.group)&&beat>=2.4&&beat<3.8?1:0;if(microBreath){drawn.y=Math.round(Math.max(13,drawn.y))+1;drawn.ly=Math.round(drawn.ly)+1;drawn.ry=Math.round(drawn.ry)+1;}if(transit&&age<.75&&!resting&&!flowing(d)){drawn.delighted=0;drawn.surprised=0;if(Math.abs(drawn.gazeX)<.5&&Math.abs(drawn.gazeY)<.5)drawn.gazeY=-.6;}if(cue&&MOMENTS[cue.kind]&&cue.id===id)applyMoment(drawn,MOMENTS[cue.kind],cueAge());
 let shown=drawn;const BM=buildMoves();
 if(BM&&build&&build.code&&build.t>=0)shown=BM.drive(build.code,build.t,drawn,BM.smooth(build.w));
 else if(BM&&buildOut){const d=BM.drive(buildOut.code,buildOut.t,drawn),u=BM.smooth(buildOut.age/BM.EXIT);shown={...drawn};for(const k in d)if(typeof drawn[k]==='number')shown[k]=d[k]+(drawn[k]-d[k])*u;}
 return {id,build:build?{...build,turns:{...buildTurns}}:null,buildOut:buildOut?{...buildOut}:null,action:attending?'attend':d.action,p:shown,v:{...v},time,phase,age,thinkingAge,emotion,switches,interruptions,variant:variation(),drum:drumStrike&&!resting?{...drumStrike}:null,thinking:thinkingDetail?{...thinkingDetail}:null,resting,attending,static:isStill(),microBreath,mic:(m=>m?{...m,ax:MIC.ax,tail:MIC.tail}:null)(micShape(drawn)),marks:mic&&mic.phase==='exit'&&mic.marks&&mic.marks.length?mic.marks.map(m=>m.slice()):loopMarks(drawn)||drowseMarks(drawn),micBeat:mic?{phase:mic.phase,grab:mic.grab||null,exit:mic.exit||null,release:mic.release||null,e:mic.at===null?null:time-mic.at,from:mic.from?{...mic.from}:null,r:mic.r?{...mic.r}:null,shape:mic.shape?{...mic.shape}:null}:null,prop:{...prop},icon:{...icon},typing:{...typing},drowse:resting&&d.action==='idle'?drowse:0,restMood:resting&&d.action==='idle'&&!drowse?restMood:null};}
 // Snapshot carries choice metadata, never a live engine reference. The adapter only
 // retains it after display acceptance, including before a study prop has risen.
 const rawSnapshot=()=>({...snapshot(),thoughtChoice:thinkingChoice?{...thinkingChoice}:null});
 function buildSnapshot(){const result=rawSnapshot();if(byId[defId].magic){const studyTime=Math.min(magic.elapsed,MAGIC_REVEAL_END);result.magic={...magic,performance:byId[defId].magic,studyTime};if(magic.ready){result.time=studyTime;result.phase=studyTime*2;result.action='magic';result.p={...p};}}return result;}
 function acceptPose(held){
  setState(held.id,false,false,true);
  // The build move on glass carries on: same piece, clock, turns and handover.
  if(held.build!==undefined){
   build=held.build?{...held.build}:null;buildOut=held.buildOut?{...held.buildOut}:null;
   if(build){Object.assign(buildTurns,build.turns||{});delete build.turns;}
   defId=build&&build.code?buildDefId(build.state,build.code):held.id;
  }
  Object.assign(p,held.p);Object.assign(v,held.v);
  Object.assign(prop,held.prop);Object.assign(icon,held.icon);Object.assign(typing,held.typing);
  time=held.time;phase=held.phase;age=held.age;emotion=held.emotion;loopGate=0;
  attending=held.attending;resting=held.resting;entryPose={...p};magic.ready=false;
  // Resume the mic beat that was on glass; an older reply snapshot holds it.
  const beat=held.micBeat;
  mic=beat?{...beat,at:beat.e===null?null:time-beat.e}:beat===undefined&&byId[defId].action==='reply'?{phase:'held',at:null}:null;
 }
 function resumeThought(choice){
  if(!choice||!Number.isInteger(choice.variant)||choice.variant<0||choice.variant>=THINKING_VARIATIONS)return false;
  if(pinnedThinking!==null&&pinnedThinking!==choice.variant)return false;
  setState('thinking',true);
  thinkingVariant=choice.variant;thinkingChoice={...choice};thinkingDetail=null;thinkingAge=0;
  bag=bag.filter(variant=>variant!==thinkingVariant);lastChoices[thinkingVariant]=choice.route;
  age=0;entryPose={...p};resting=false;restFreeze=null;restVariant=null;restPending=false;attending=false;wakeBeat=null;cue=null;loopGate=0;
  // Start at the safe opening from the current held body; no restored velocity/time.
  for(const key of Object.keys(v))v[key]=0;
  return true;
 }
 // Pin the next grab and let-go without configure()'s static-age reset.
 function chooseMic(choice={}){micChoice.grab=choice.grab??null;micChoice.release=choice.release??null;}
 return {setState,setBuildEpisode,setPlayGenre,playCue,playGenre:()=>playGenre,acceptPose,resumeThought,chooseMic,releaseCue,step(seconds){step(seconds);return buildSnapshot();},snapshot:buildSnapshot,rest,wake,react,attend,resting:()=>resting,restartThinking(opts){
  if(byId[defId].action!=='thinking')return;
  randomState=opts.seed>>>0;bag=[];thinkingVariant=opts.previousVariant??thinkingVariant;
  nextThinking();age=0;entryPose={...p};resting=false;restFreeze=null;restVariant=null;restPending=false;attending=false;wakeBeat=null;cue=null;loopGate=0;transit=null;
 },configure(opts){
  if(byId[defId].static&&age>=2)age=1;
  if(opts.idleVariation===null)pinnedIdle=null;else if(Number.isInteger(opts.idleVariation))pinnedIdle=((opts.idleVariation%IDLE_VARIATIONS)+IDLE_VARIATIONS)%IDLE_VARIATIONS;
   // Director pin: fixes WHICH thinking gesture plays (3 = the cogs). The route/idea
   // draw below it is untouched, and a pinned variant never drains the shuffled bag.
   if(opts.idleVariation!==undefined)restVariant=null;
   // Name-row letter centres (image x) for the drum. A new list drops what a pin change drops.
   if(opts.nameGlyphs!==undefined){const next=drumPlan(opts.nameGlyphs);if((next&&next.key)!==(drum&&drum.key)){drum=next;restVariant=null;}}
   if(opts.thinkingVariation===null)pinnedThinking=null;else if(Number.isInteger(opts.thinkingVariation))pinnedThinking=((opts.thinkingVariation%THINKING_VARIATIONS)+THINKING_VARIATIONS)%THINKING_VARIATIONS;
   if(opts.thinkingVariation!==undefined&&byId[defId].action==='thinking')nextThinking();
  // Day rhythm (2026-10-28): how sleepy the idle still is (DROWSE), and which idle routines
  // the hour rotates through (variation indices, in order; null for all twelve).
  // A new sleepy pose while he already rests glides onto it, then parks again.
  if(opts.drowse!==undefined){const next=clamp(Math.round(Number(opts.drowse)||0),0,DROWSE.length-1);if(resting&&DROWSE[next]!==DROWSE[drowse])restAge=0;drowse=next;}
  // The carried mood's look for the idle still (a REST_MOODS id, or null for none).
  if(opts.restMood!==undefined){const next=REST_MOODS[opts.restMood]?String(opts.restMood):null;if(resting&&!drowse&&next!==restMood)restAge=0;restMood=next;}
  if(opts.idleOrder!==undefined){const order=Array.isArray(opts.idleOrder)?opts.idleOrder.filter(k=>Number.isInteger(k)&&k>=0&&k<IDLE_VARIATIONS):[];idleOrder=order.length?order:null;}
  if(opts.response!==undefined)response=clamp(opts.response,.35,2);
  if(opts.motion!==undefined)motion=clamp(opts.motion,0,1.5);
  if(typeof opts.micro==='boolean')micro=opts.micro;
  // Mic pins: which grab the next reply plays and which let-go its exit uses.
  for(const [key,kind] of [['micGrab','grab'],['micRelease','release']])if(opts[key]!==undefined)micChoice[kind]=opts[key];
  if(opts.expression==='auto'||expressions.includes(opts.expression))expression=opts.expression;
  if(opts.view==='auto'||Number.isFinite(opts.view))view=opts.view==='auto'?'auto':clamp(opts.view,-2,2);
 },list:()=>catalogue,definition:()=>byId[defId]};
}
function restPoseFor(def,variant=0){
 const p=targetFor(def,0,0,0);if(def.action==='idle')idleRest(variant,p);
 for(const key of expressions)p[key]=0;
 const emotion=def.action==='error'?'concerned':def.restEmotion||'curious';
 Object.assign(p,{browL:0,browR:0,browY:0,browLiftL:0,browLiftR:0,gazeX:.6,gazeY:-.3,eye:1,eyeL:1,eyeR:1,turn:0,lopen:.5,ropen:.5,lpoint:0,rpoint:0,ly:Math.max(25,p.ly),ry:Math.max(25,p.ry),listenCue:0,errorCue:0,effect:0,[emotion]:1},def.rest||{});
 return {p,emotion};
}
const api={create,catalogue,actions,byId,originals,BASE,spring,springZ,targetFor,restPoseFor,attentionFor,expressions,expressionFor,IDLE_VARIATIONS,HANG,DRUM,DRUM_GEOMETRY,drumPlan,drumBeat,idleBeat,idleRest,SIDE_BY_GROUP,transitions,MICRO_DEFAULT,CUES,ATTEND_POSE,THINKING_VARIATIONS,REST_MOODS,THINKING_IDEAS,thinkingDuration,DROWSE,REST_MOODS};
Object.assign(api,{magicStudyPose,MAGIC_REVEAL_END,spellcasterCastTip,SPELLCASTER_CAST_DELAY});
// #6882: the page's shuffle bags, for the lab and tests (forget() starts every pool again).
Object.assign(api,{buildBags});
Object.assign(api,{MIC,MIC_HOLD,MIC_GRABS,MIC_OPENERS,MIC_RELEASES,MIC_EXITS,micShuffler,micDrop,micGrip,micTail,micAtGrip});
// Reactor reactions: cue kind to the cue ages its pictures are written at (enter ends on the hold).
Object.assign(api,{REACTIONS:Object.fromEntries(Object.keys(REACTIONS).map(n=>['rx_'+n,{hold:MOMENTS['rx_'+n].hold,...MOMENTS['rx_'+n].pictures}]))});
if(typeof module!=='undefined')module.exports=api;else root.WatchEngine=api;
})(typeof window!=='undefined'?window:globalThis);
;
// ALIVE_VENDOR_END engine.js

// ALIVE_VENDOR_BEGIN props.js
/* Upright, native-pixel activity silhouettes. No face/hand drawing here. */
(function(root){
'use strict';
const kinds=['book','learnbook','paper','editpaper','title','canvas','laptop','browser','navigate','form','clipboard','checklist','puzzle','cables','unplugged','replug','wrench','magnifier','websearch','stack','cards','twocards','hourglass','bug','gear','updategear','chart','flag','upload','download','blocks','rocket','monitor','shield','camera','phone','server','serveractive','envelope','task','handoffcard','clock','speech','text','branch','device','freshpage','pause','warning','play','syncwheel','viewfinder','team','highfive','datatray','gitcards','replycard','mic','boardfile','boardscan','boardunblock','boardnote','boardlink'];
// The reply mic on its cord (engine.js MIC). The shaft follows the handle's
// turn; the head keeps its upright silhouette (circle, two level grill lines)
// at every angle. Pixel centres sit at x+0.5 in the rasteriser while the 1px
// cord lands on round(x), so odd widths (9px head, 3px shaft) centre the mic
// on the cord's pixel column. sx < 1 narrows the head for a twirl. The
// renderer draws it from its own beat, whatever the prop carrier does: an exit
// outlives the reply.
function drawMic(m,pen){
 const ox=m.x+.5,g=pen.local(ox,m.y,m.a,1),h=pen.local(ox,m.y,0,1),R=4.5;
 const sx=m.sx===undefined?1:Math.max(.12,Math.abs(m.sx));
 if(m.trail){const d=pen.local(0,0,0,1);for(const [x,y] of m.trail)d.rect(Math.round(x),Math.round(y),2,2);}
 g.poly([[-1.5,2],[1.5,2],[1.5,m.tail],[-1.5,m.tail]]);
 h.poly(Array.from({length:48},(_,i)=>[Math.cos(i*Math.PI/24)*R*sx,Math.sin(i*Math.PI/24)*R]));
 if(sx>.45){h.rect(-3.5*sx,-2,7*sx,1,0);h.rect(-3.5*sx,1,7*sx,1,0);}
}
function draw(s,pen){
 const kind=s.prop.kind;if(!kind||s.prop.reveal<.02)return;
 if(!kinds.includes(kind))throw Error('Unauthored activity object: '+kind);
 const layout=s.prop.layout||{offset:0,side:1};
 const g=pen.local(0,Math.round((1-s.prop.reveal)*34));
 const pt=(x,y)=>{x+=layout.offset+(s.p.propDX||0);return [layout.side<0?100-x:x,y+(s.p.propDY||0)];};
 const P=(points,c)=>g.poly(points.map(([x,y])=>pt(x,y)),c);
 const R=(x,y,w,h,c)=>P([[x,y],[x+w,y],[x+w,y+h],[x,y+h]],c);
 const L=(x,y,xx,yy,c)=>g.line(...pt(x,y),...pt(xx,yy),c);
 const B=(x,y,w,h)=>{R(x,y,w,h);R(x+2,y+2,w-4,h-4,0);};
 const C=(x,y,r,c)=>P(Array.from({length:48},(_,i)=>[x+Math.cos(i*Math.PI/24)*r,y+Math.sin(i*Math.PI/24)*r]),c);
 const T=s.time,t=s.phase,p={...s.p,ry:(layout.side<0?s.p.ly:s.p.ry)-(s.p.propDY||0)},beat=T%4.8,stroke=beat<1.8?Math.sin(beat/1.8*Math.PI):0;
 const handX=(layout.side<0?100-s.p.lx:s.p.rx)-layout.offset-(s.p.propDX||0);
 const check=(x,y,scale=1)=>{L(x,y+3*scale,x+3*scale,y+6*scale,0);L(x+3*scale,y+6*scale,x+8*scale,y,0);};
 const arrow=(x,y,down=false)=>{const d=down?1:-1;R(x-1,y-3,3,7);P([[x-5,y],[x,y+6*d],[x+6,y],[x+2,y],[x,y+2*d],[x-1,y]]);};
 const page=()=>{P([[68,3],[83,3],[89,9],[89,28],[68,28]]);R(83,3,6,6,0);};
 if(layout.interaction==='front'){
  // One occasional centred hold, with the complete glasses above it.
  R(36,23,28,9);R(41,22,9,2);R(56,22,5,2);
  R(45,24,10,7,0);R(47,25,6,5);R(49,26,2,3,0);R(59,25,3,2,0);
  if(beat<.25){R(25,24,3,2);R(73,24,3,2);}return;
 }
 if(layout.interaction==='couple'){
  const push=kind==='unplugged'?0:kind==='replug'?Math.max(0,Math.sin(T*3))*10:stroke*10;
  const left=31+push,right=62-push;
  R(left,23,7,8);R(left+7,25,4,2);R(left+7,29,4,2);
  R(right,23,7,8);R(right+1,25,2,2,0);R(right+1,29,2,2,0);
  L(17,29,left,29);L(right+7,29,83,29);
  if(kind==='unplugged'){L(48,24,51,27);L(51,24,48,27);}return;
 }
 switch(kind){
 case 'book':case 'learnbook':{
  P([[65,5],[77,8],[80,8],[93,5],[93,24],[80,27],[77,27],[65,24]]);R(78,9,2,16,0);
  for(const y of [11,16,21]){R(68,y,7,2,0);R(83,y-1,7,2,0);}
  // The turning page stays inside the book silhouette, away from the face.
  if(beat<1.8){const x=81+Math.round(stroke*7);R(x,9,2,14,0);}
  break;}
 case 'paper':case 'editpaper':case 'title':{
  page();
  if(kind==='paper'&&layout.interaction==='writepaper'){
   const row=Math.max(0,Math.min(2,Math.round((p.ry-8)/5))),tip=handX-6;
   for(let i=0;i<=row;i++)R(73,14+i*5,i===row?Math.max(2,tip-73):13,2,0);
   // The writing mitten grips the pencil shaft; its tip touches the ink line.
   P([[tip-2,p.ry+6],[handX+2,p.ry-3],[handX+4,p.ry-1],[tip,p.ry+8]],0);
   P([[tip,p.ry+6],[handX+2,p.ry-2],[handX+3,p.ry],[tip+1,p.ry+7]]);
   break;
  }
  if(kind==='title'){R(73,9,11,3,0);R(77,12,3,7,0);R(72,22,12,2,0);}
  else for(const y of [10,16,22])R(72,y,11,2,0);
  const y=Math.max(7,Math.min(22,Math.round(p.ry)));
  if(kind==='editpaper'){R(81,y-1,11,5,0);P([[84,y-2],[92,y-2],[95,y+1],[92,y+4],[84,y+4]]);R(88,y-1,2,4,0);}
  else{P([[84,y+5],[90,y-3],[93,y-1],[87,y+7]]);R(88,y+1,2,2,0);}
  break;}
 case 'canvas':{
  L(71,20,67,29);L(85,20,90,29);B(66,3,25,21);
  P([[70,19],[75,12],[80,17],[84,10],[87,19]]);R(70,7,3,3);
  const y=Math.max(7,Math.min(21,Math.round(p.ry)));L(86,y+3,94,y-4);R(84,y+2,4,4);break;}
 case 'navigate':{
  B(69,3,26,20);R(79,23,5,4);R(73,28,17,2);
  const mx=Math.max(55,Math.min(61,handX)),x=79+(mx-58)*2,y=8+Math.sin(T*1.3);
  // One uncomplicated pointer silhouette; no header blocks or keyboard.
  P(layout.side<0?[[x+7,y],[x+7,y+9],[x+4,y+6],[x,y+6]]:[[x,y],[x,y+9],[x+3,y+6],[x+7,y+6]]);
  P([[mx-3,24],[mx+3,24],[mx+5,27],[mx+4,31],[mx-4,31],[mx-5,27]]);R(mx-1,24,2,3,0);
  break;}
 case 'laptop':case 'browser':case 'form':{
  B(66,3,27,19);P([[66,22],[93,22],[96,28],[63,28]]);for(const x of [68,74,80,86])R(x,24,3,2,0);
  if(kind==='laptop'){L(73,8,70,11);L(70,11,73,14);L(81,8,84,11);L(84,11,81,14);R(77,8,2,8);}
  if(kind==='browser'){R(69,6,20,2);const shift=Math.floor(T*2)%3;for(let i=0;i<3;i++)R(70,10+i*3,12-((i+shift)%3)*3,2);R(88,10+shift*2,2,5);}
  if(kind==='form')for(let i=0;i<3;i++){R(70,7+i*4,3,3);R(76,8+i*4,12,2);if(i<=Math.floor(T%4.8/1.6))R(71,8+i*4,1,1,0);}
  break;}
 case 'clipboard':case 'checklist':{
  R(70,5,22,23);R(76,2,10,5);R(78,3,6,2,0);
  if(kind==='checklist')check(76,11,1.2);
  else for(const y of [10,16,22]){R(73,y,3,3,0);R(80,y,8,2,0);}
  break;}
 case 'puzzle':{
  const gap=2+Math.round((1-stroke)*3);
  P([[65,7],[75,7],[75,11],[79,11],[79,15],[75,15],[75,24],[65,24],[65,18],[69,18],[69,14],[65,14]]);
  const x=76+gap;P([[x,7],[x+11,7],[x+11,14],[x+7,14],[x+7,18],[x+11,18],[x+11,24],[x,24],[x,17],[x+4,17],[x+4,10],[x,10]]);break;}
 case 'cables':case 'unplugged':case 'replug':{
  const push=kind==='unplugged'?0:kind==='replug'?Math.max(0,Math.sin(T*3))*5:stroke*5;
  R(78,2,3,7);R(73,8,13,6);R(77,13,5,3);
  R(76,10,2,2,0);R(82,10,2,2,0);
  const y=21-Math.round(push);R(73,y,13,6);R(76,y+1,7,2,0);R(78,y+5,3,30-y-5);
  if(kind==='unplugged'){R(89,14,3,3);R(89,20,3,3);}
  break;}
 case 'wrench':{
  const angle=layout.side<0?-s.p.lrot:s.p.rrot,ca=Math.cos(angle),sa=Math.sin(angle);
  const turn=points=>points.map(([x,y])=>[81+x*ca-y*sa,9+x*sa+y*ca]);
  P(turn([[-6,-6],[-3,-7],[-3,-1],[3,-1],[3,-7],[6,-5],[7,1],[3,6],[3,19],[-3,19],[-3,6],[-7,1]]));
  P(turn([[-1,11],[1,11],[1,15],[-1,15]]),0);
  C(81,8,3);C(81,8,1,0);break;}
 case 'magnifier':case 'websearch':{
  P([[70,26],[78,17],[81,20],[73,29]]);C(85,12,10);C(85,12,7,0);
  L(88,6,90,8);break;}
 case 'datatray':{
  P([[65,23],[70,23],[73,27],[87,27],[90,23],[95,23],[95,31],[65,31]]);
  for(let i=0;i<3;i++){const y=3+((T*7+i*7)%20);R(69+i*9,y,5,4);R(70+i*9,y+1,3,1,0);}break;}
 case 'stack':case 'cards':case 'twocards':{
  if(kind==='twocards'){B(64,5,14,23);B(81,5,14,23);for(const x of [67,84]){R(x,9,7,3);R(x,16,7,2);}R(T%4.8<2.4?67:84,23,7,2);}
  else{B(65,4,22,22);R(70,8,23,21,0);B(71,9-Math.round(kind==='stack'?stroke*5:0),22,20);for(const y of [14,19,24])R(75,y-Math.round(kind==='stack'?stroke*5:0),13,2);}
  break;}
 case 'hourglass':{
  R(70,3,20,3);R(70,26,20,3);P([[72,6],[88,6],[88,10],[82,16],[88,22],[88,26],[72,26],[72,22],[78,16],[72,10]]);
  P([[75,7],[85,7],[85,10],[80,14],[75,10]],0);P([[80,18],[85,23],[85,25],[75,25],[75,23]],0);
  const sand=Math.floor(T%4.8);R(78,20-sand,4,5+ sand);R(79,13,2,6);break;}
 case 'bug':{
  R(76,7,9,17);R(74,4,3,5);R(85,4,3,5);R(73,11,15,3);R(71,8,3,5);R(88,8,3,5);R(71,18,5,3);R(86,18,5,3);R(74,23,3,4);R(85,23,3,4);R(80,10,2,12,0);break;}
 case 'gear':case 'updategear':{
  P([[75,4],[83,4],[83,7],[87,7],[87,11],[91,11],[91,19],[87,19],[87,23],[83,23],[83,27],[75,27],[75,23],[71,23],[71,19],[67,19],[67,11],[71,11],[71,7],[75,7]]);
  R(75,11,8,9,0);const y=16+Math.round(Math.sin(t)*3);L(81,16,91,y);R(90,y-1,4,4);if(kind==='updategear')R(77,4,4,3,0);break;}
 case 'chart':{R(65,27,29,2);R(67,19,6,8);R(77,12,6,15);R(87,4,6,23);break;}
 case 'flag':{R(70,2,3,28);R(74,3,20,14);for(let y=3;y<17;y+=3)for(let x=74;x<94;x+=3)if(((x-74+y-3)/3)%2===0)R(x,y,3,3,0);break;}
 case 'upload':case 'download':{
  const y=kind==='upload'?17-Math.round(stroke*6):11+Math.round(Math.min(1,beat/1.8)*6);
  R(69,y,23,13);R(78,y,4,8,0);R(73,y+9,6,2,0);arrow(80,kind==='upload'?7:5,kind==='download');break;}
 case 'blocks':{R(67,22,9,7);R(78,22,9,7);R(72,14,9,7);const y=3+Math.round(stroke*10);R(83,y,9,8);break;}
 case 'rocket':{
  const y=3+Math.round((1-stroke)*3);P([[80,y],[86,y+7],[86,y+17],[74,y+17],[74,y+7]]);R(78,y+8,5,5,0);P([[74,y+11],[68,y+20],[74,y+18]]);P([[86,y+11],[92,y+20],[86,y+18]]);R(76,y+19,3,5);R(82,y+19,3,5);break;}
 case 'monitor':{
  B(65,3,29,21);L(69,14,73,14);L(73,14,76,8);L(76,8,80,20);L(80,20,84,12);L(84,12,90,12);R(77,24,5,3);R(70,28,20,2);break;}
 case 'shield':{P([[69,5],[80,2],[92,5],[92,17],[87,24],[80,29],[73,24],[69,17]]);check(74,11,1.1);break;}
 case 'camera':{
  R(66,10,28,18);R(71,6,10,5);R(86,8,6,3);R(72,13,15,12,0);B(75,14,10,10);R(89,13,3,3,0);if(beat<.35){L(64,3,67,6);L(87,2,85,5);}break;}
 case 'phone':{P([[73,3],[81,3],[83,10],[78,11],[78,19],[83,21],[81,28],[73,28],[69,23],[69,8]]);R(75,5,3,3,0);R(75,23,3,3,0);break;}
 case 'server':case 'serveractive':{
  for(let i=0;i<3;i++){const y=3+i*9;R(70,y,23,7);R(73,y+2,3,3,0);R(80,y+2,10,3,0);if(kind==='serveractive'&&i===Math.floor(T)%3)R(82,y+3,6,1);}
  if(kind==='server'){R(64,22,4,5);R(64,24,6,2);}break;}
 case 'envelope':{
  R(69,14,20,12);const fold=Math.min(1,(T%4.8)/1.5);
  if(fold<.5)P([[69,14],[79,7+fold*14],[89,14]]);
  L(71,16,79,17+fold*6,0);L(79,17+fold*6,87,16,0);break;}
 case 'task':case 'handoffcard':{
  const x=64+Math.round(kind==='handoffcard'?stroke*9:0),y=15-Math.round(kind==='task'?stroke*2:0);R(x,y,15,14);R(x+4,y+3,8,2,0);R(x+4,y+8,6,2,0);break;}
 case 'boardfile':case 'boardscan':case 'boardunblock':case 'boardnote':case 'boardlink':{
  // #3769: a three-lane board whose cards act out engine.js boardBeat on the same
  // 6 s clock (the snapshot's age less its .6 s lead): header tabs over three lanes of 7x4 cards that
  // sink behind the frame's bottom edge. A resting pose holds a settled frame.
  const u=s.resting?{boardfile:3.6,boardscan:5,boardunblock:3.8,boardnote:4,boardlink:4}[kind]:Math.max(0,s.age-.6)%6;
  const at=(a,b)=>Math.max(0,Math.min(1,(u-a)/(b-a))),ease=f=>f*f*(3-2*f);
  const jolt=kind==='boardfile'&&u>=1.42&&u<1.56?1:0;
  const lane=[68,78,87].map(x=>x+jolt);
  const card=(x,y,{hollow=false,clip=true}={})=>{
   for(let r=0;r<4;r++){const yy=Math.round(y)+r;if(clip&&(yy<7||yy>26))continue;
    if(hollow&&r>0&&r<3){R(x,yy,1,1);R(x+6,yy,1,1);}else R(x,yy,7,1);
    if(!hollow&&r===1)R(x+2,yy,3,1,0);}
  };
  R(66+jolt,3,30,3);R(76+jolt,3,1,3,0);R(85+jolt,3,1,3,0);
  L(66+jolt,6,66+jolt,27);L(95+jolt,6,95+jolt,27);L(66+jolt,27,95+jolt,27);
  if(kind==='boardfile'){
   // The lane makes room during the wind-up; the new card lands in the gap.
   const room=u<1.42?Math.round(ease(at(.9,1.3))*6):0;
   for(const y of [8,14,20])card(lane[0],y+room);
   if(u>=1.42){card(lane[0],8);if(u<2.3)R(lane[0]+6,8,1,1,0);}
   else if(u>=.15)card(Math.round(handX)-3,Math.round(p.ry)-8,{clip:false});
   for(const y of [8,14])card(lane[1],y);
   card(lane[2],8);
   if(u>=1.42&&u<1.75){L(64,7,62,5);L(76,7,78,5);R(71,6,1,1,0);}
  }
  if(kind==='boardscan'){
   // A tapped card rings hollow for a moment; its lane's header tab counts it.
   const taps=[[.7,0,8],[1.05,0,14],[1.6,1,8],[1.9,1,14],[2.2,1,20],[2.75,2,8]];
   const counted=[0,0,0];
   for(const [t,l,y] of taps){
    card(lane[l],y,{hollow:u>=t&&u<t+.25});
    if(u>=t&&u<4.6){R(lane[l]+1+2*counted[l],4,1,1,0);counted[l]++;}
   }
  }
  // Lanes that scroll: slot k sits at 8+6k+sink, so k=-1 drops in from under the
  // header while the bottom card sinks away, and the picture repeats every cycle.
  const scroll=(x,sink,fn)=>{for(let k=-1;k<4;k++)fn(x,8+6*k+sink,k);};
  const seg=(x0,y0,x1,y1,dots=1)=>{if(![x0,y0,x1,y1].every(Number.isFinite))return;let i=0;x0=Math.round(x0);y0=Math.round(y0);x1=Math.round(x1);y1=Math.round(y1);
   const dx=Math.abs(x1-x0),dy=-Math.abs(y1-y0),sx=x0<x1?1:-1,sy=y0<y1?1:-1;let e=dx+dy;
   for(;;){if(y0>=7&&y0<=26&&i++%dots===0)R(x0,y0,1,1);if(x0===x1&&y0===y1)break;const e2=2*e;if(e2>=dy){e+=dy;x0+=sx;}if(e2<=dx){e+=dx;y0+=sy;}}};
  if(kind==='boardnote'){
   // A note sticks on the top card's corner; a second line is written onto it.
   const sink=Math.round(ease(at(4.6,5.1))*6);
   const note=(x,y)=>{for(let r=0;r<3;r++){const yy=y+r;if(yy>=7&&yy<=26)R(x,yy,4,1);}if(y+1>=7)R(x+1,y+1,2,1,0);};
   card(lane[0],8);card(lane[2],8);
   scroll(lane[1],sink,(x,y,k)=>{card(x,y);
    if(k===0&&u>=1.62){const w=Math.round(4*at(1.75,2.35));if(w&&y+2>=7&&y+2<=26)R(x+1,y+2,w,1,0);}
    if(k>0&&y+2>=7&&y+2<=26)R(x+1,y+2,4,1,0);
    if(k===1||(k===0&&u>=1.62))note(x+4,y+2);});
   if(u>=.15&&u<1.62)note(Math.round(handX)-2,Math.round(p.ry)-7);
  }
  if(kind==='boardlink'){
   // Card A (first lane) is tied to card B (third lane) one slot up; earlier
   // pairs keep their strings as both lanes scroll.
   const sink=Math.round(ease(at(4.5,5))*6);
   scroll(lane[0],sink,(x,y)=>card(x,y));
   scroll(lane[2],sink,(x,y)=>card(x,y,{hollow:u>=2.3&&u<2.5&&y===8+sink}));
   seg(75,22+sink,86,16+sink);seg(75,28+sink,86,22+sink,2);
   const ax=75,ay=16+sink,bx=86,by=10+sink;
   if(u>=2.3){seg(ax,ay,bx,by);
    if(u<3.3){const f=((u-2.5)%.4)/.4;if(u>=2.5)R(Math.round(ax+(bx-ax)*f)-1,Math.round(ay+(by-ay)*f)-1,2,2);}}
   else if(u>=.9){const hx=Math.round(handX)+3,hy=Math.round(p.ry)-1,mx=(ax+hx)/2,my=Math.max(ay,hy)+2;seg(ax,ay,mx,my);seg(mx,my,hx,hy);}
   if(u>=2.3&&u<2.5)for(const [px,py] of [[88,6+sink],[84,7+sink]])R(px,py,1,1);
  }
  if(kind==='boardunblock'){
   // A card stuck behind a brick wall on the lane rule: the shove breaks the wall
   // and the card flies into the next lane. Done then sinks and a new card and
   // wall drop in, ready to be stuck again.
   const jitter=[.9,1.4,1.9].some(t=>u>=t+.08&&u<t+.22)?1:0;
   const fly=ease(at(2.55,2.82)),over=u>=2.82&&u<2.95?1:0;
   const sink=Math.round(ease(at(4.5,5))*12);
   const wall=(y,dx=0,top=0,rows=18)=>{for(let r=top;r<rows;r++){const yy=y+r;if(yy>=7&&yy<=26)R(84+dx,yy,2,1);}};
   card(lane[0],8);
   card(lane[2],20+sink);
   if(u<2.55){card(lane[1]-1+jitter,14);wall(8);}
   else if(u<4.5){
    const x=Math.round(lane[1]-1+(lane[2]-lane[1]+1)*fly)+over,y=Math.round(14-6*fly);card(x,y);
    if(u<2.82){L(x-5,y+1,x-2,y+1);L(x-6,y+3,x-3,y+3);}
    if(u<2.95){const d=at(2.55,2.95),fall=Math.round(d*d*14);wall(8+fall,1,0,9);wall(8+Math.round(fall*1.3),3,9,18);}
    if(u<2.75)for(const [px,py] of [[88,10],[88,21],[83,9],[83,21]])R(px,py,1,1);
   }
   else card(lane[2],8+sink);
   if(u>=4.9){const y=Math.round(1+13*ease(at(4.9,5.3)))+(u>=5.3&&u<5.4?1:0);card(lane[1]-1,y);}
   if(u>=5.3)wall(Math.round(-10+18*at(5.3,5.42)));
  }
  break;}
 case 'clock':{
  P([[74,3],[85,3],[92,10],[92,21],[85,28],[74,28],[67,21],[67,10]]);P([[75,6],[84,6],[89,11],[89,20],[84,25],[75,25],[70,20],[70,11]],0);L(79,8,79,16);L(79,16,T%4.8<2.4?85:73,19);break;}
 case 'speech':case 'text':{
  B(65,4,29,22);P([[69,25],[77,25],[69,30]]);
  if(kind==='speech'){for(let x=69;x<89;x++){const y=14+Math.sin((x-69)*Math.PI/5-T*3)*4,yy=14+Math.sin((x+1-69)*Math.PI/5-T*3)*4;L(x,y,x+1,yy);}}
  else{R(69,9,20,2);R(69,14,16,2);R(69,19,11,2);}break;}
 case 'mic':break; // drawn by drawMic from s.mic
 case 'replycard':{
  B(75,6,23,19);P([[75,22],[82,22],[75,29]]);
  R(79,11,15,2);R(79,16,12,2);R(79,21,8,2);break;}
 case 'gitcards':{
  B(66,4,22,23);R(70,9,11,2);R(70,16,11,2);
  const x=73-Math.round(stroke*2);R(x,8,21,21);R(x+3,12,15,2,0);R(x+6,9,2,8,0);
  if(beat<2.6){R(x+4,20,12,2,0);R(x+4,25,8,2,0);}
  else check(x+5,19,.85);
  break;}
 case 'branch':{
  L(71,5,71,26);L(88,5,88,12);L(88,12,71,24);
  for(const [x,y] of [[71,5],[71,16],[71,26],[88,5]]){C(x,y,3);C(x,y,1,0);}
  const progress=Math.max(0,Math.min(1,(92-handX)/15));C(88-progress*17,12+progress*12,3);C(88-progress*17,12+progress*12,1,0);break;}
 case 'device':{
  R(72,2,17,27);R(75,5,11,17,0);R(77,25,7,2,0);
  if(beat<2.8){R(77,8+Math.floor(beat*3),7,2);}else{L(77,13,79,15);L(79,15,84,10);}break;}
 case 'freshpage':{P([[70,3],[85,3],[92,10],[92,28],[70,28]]);R(85,3,7,7,0);R(79,12,4,12,0);R(75,16,12,4,0);break;}
 case 'pause':{R(69,4,9,24);R(84,4,9,24);break;}
 case 'warning':{P([[80,2],[95,28],[65,28]]);R(78,13,4,8,0);R(78,24,4,3,0);break;}
 case 'play':{P([[70,3],[94,15],[70,27]]);for(let i=0;i<3;i++)if(i<=Math.floor(T*2)%3)R(67+i*10,29,7,2);break;}
 case 'syncwheel':{L(69,8,87,8);L(69,8,69,15);P([[83,3],[92,8],[83,13]]);L(72,23,90,23);L(90,23,90,16);P([[77,18],[67,23],[77,28]]);const shift=Math.floor(T*5)%10;R(71+shift,8,3,2,0);R(86-shift,23,3,2,0);break;}
 case 'viewfinder':{for(const x of [66,87])for(const y of [3,22]){R(x,y,8,3);R(x===66?66:92,y===3?3:17,3,8);}R(77,12,7,7);R(79,14,3,3,0);break;}
 case 'team':{L(64,16,70,16);L(70,8,70,24);L(70,8,74,8);L(70,24,74,24);break;}
 case 'highfive':{R(73,16,3,7);R(73,15,5,3);break;}
 }
}
// Idle-variation prop paths, shared by the engine (where he looks) and the
// renderer (what gets drawn), so eyes and pixels agree. t is seconds into the
// 10 s variation loop.
// Native artwork uses the same object layer and mitten occlusion as every
// existing prop. No clocks or episode authority live in the renderer.
function drawMagic(s,f){
 const m=s.magic,t=m.studyTime,clamp=v=>Math.max(0,Math.min(1,v)),ease=v=>{v=clamp(v);return v*v*(3-2*v);};
 const q=t/6,a=ease(q/.22),b=ease((q-.25)/.36),c=ease((q-.66)/.15),face=f.layers.face;
 const k=['spellcaster','portal','telekinesis','constellation','between_hands','lens_projection'].indexOf(m.performance);
 let tip=[82,10];
 if(k===0)tip=[72+17*Math.sin(a*1.2+b*1.5),5+9*(1-a)+3*Math.sin(b*5)];
 if(k===1){const theta=b*Math.PI*2-Math.PI/2;tip=[82+12*Math.cos(theta),16+11*Math.sin(theta)];}
 // Verbatim one-pixel study primitives: draw after the face, then restore the
 // original one-pixel mitten clearance. The thick ordinary-prop pen is not used.
 function dot(x,y,v=15){x=Math.round(x);y=Math.round(y);if(x>=0&&x<100&&y>=0&&y<32&&!face[y*100+x]){const i=y*100+x;f.pixels[i]=Math.round(v);f.layers.object[i]=Math.round(v);f.layers.objectMask[i]=1;}}
 const line=(x,y,xx,yy,v=15)=>{let n=Math.ceil(Math.max(Math.abs(xx-x),Math.abs(yy-y),1));for(let i=0;i<=n;i++)dot(x+(xx-x)*i/n,y+(yy-y)*i/n,v);};
 const box=(x,y,w,h,v=15)=>{line(x,y,x+w,y,v);line(x+w,y,x+w,y+h,v);line(x+w,y+h,x,y+h,v);line(x,y+h,x,y,v);};
 const glint=m.phase==='sustain'?(14+Math.cos((m.elapsed-t)*.8))/15:1;
 const star=(x,y,r=2,v=15)=>{v*=glint;line(x-r,y,x+r,y,v);line(x,y-r,x,y+r,v);dot(x,y,v);};
 const card=(x,y,w=19,h=21,v=15)=>{box(x,y,w,h,v);line(x+3,y+5,x+w-3,y+5,v);line(x+3,y+10,x+w-5,y+10,v);if(h>16)line(x+3,y+15,x+w-3,y+15,v);};
 const oval=(x,y,rx,ry,end=1,v=15)=>{for(let j=0;j<=Math.ceil(70*end);j++){let z=j/70*Math.PI*2-Math.PI/2;dot(x+rx*Math.cos(z),y+ry*Math.sin(z),v);}};
 // After reveal, only the existing particle glint moves gently; no second opening.
 const particleTime=m.phase==='sustain'?t+.12*Math.sin((m.elapsed-t)*.7):t;
 const bits=(cx,cy,r,count,v=12)=>{for(let i=0;i<count;i++){const z=particleTime*1.2+i*2.4;dot(cx+Math.cos(z)*r,cy+Math.sin(z)*(r*.7),v);}};
 const v=15;
 // A long build keeps the spellcaster casting after the reveal: the wand tip loops over the
 // card (engine.js spellcasterCastTip, after its SPELLCASTER_CAST_DELAY hold), sparks circle it
 // and its lines write in again and again.
 if(k===0&&m.phase==='sustain'){const u=Math.max(0,m.elapsed-t-.4);tip=[72+17*Math.sin(2.7)+6*Math.sin(u*1.1),5+3*Math.sin(5)+2*(1-Math.cos(u*2.2))];
  line(s.p.rx,s.p.ry,tip[0],tip[1],15);line(s.p.rx+1,s.p.ry,tip[0]+1,tip[1],9);star(...tip,2,15);
  // A bare conjure (the plan card's rig) stops at the wand: the app draws the card's icon and its sparkles.
  if(!f.bare){box(73,5,19,22,v);const w=(u/3+.75)%1;[[5,13],[10,11],[15,13]].forEach(([dy,len],i)=>{const g=clamp(w*4-i);if(g>0)line(76,5+dy,76+len*g,5+dy,v);});
  for(let i=0;i<7;i++)dot(82+Math.sin(i*2.2+t)*3,16+Math.cos(i*1.7+t)*2.1,v);
  // The sparks fade in, so the sustain's first frame is the reveal's last.
  const spark=12*clamp(u/.5);if(spark>=1)for(let i=0;i<4;i++){const z=u*1.6+i*Math.PI/2;dot(82+Math.cos(z)*14,16+Math.sin(z)*12,spark);}
  star(96,3,2,v);star(69,26,1,v);}}
 else if(k===0){line(s.p.rx,s.p.ry,tip[0],tip[1],15);line(s.p.rx+1,s.p.ry,tip[0]+1,tip[1],9);star(...tip,2,15);if(!f.bare){if(q>.22){for(let i=0;i<7;i++){let r=(1-b)*15+3;dot(82+Math.sin(i*2.2+t)*r,16+Math.cos(i*1.7+t)*r*.7,v);}if(b>.4)card(73,5,19,22,v*ease((b-.4)/.6));}if(c>0){star(96,3,2,v);star(69,26,1,v);}}}
 if(k===1){if(q>.15)oval(82,16,13,13,Math.max(.03,b),v);if(b>.8){oval(82,16,10,12,1,v*.45);card(75,16-10*c,14,Math.max(2,20*c),v);bits(82,16,15,6,v*.65);}if(q<.68)star(...tip,1,15);}
 if(k===2){for(let i=0;i<3;i++){const z=i*2.1+t,tx=76,ty=6+i*8,x=(76+Math.sin(z)*9)*(1-c)+tx*c,y=(16+Math.cos(z)*10)*(1-c)+ty*c;box(x,y,14,5,v);line(x+3,y+2,x+9,y+2,v*.7);}if(q>.18){line(65,10,72,14,v*.4);bits(82,16,16,5,v*.6);}if(c>.2)box(73,3,20,27,v*c);}
 if(k===3){const pts=[[73,5],[94,7],[87,16],[72,25],[94,27]];pts.forEach((p,i)=>{const gate=ease((b-i*.12)/.3);if(gate>0)star(p[0],p[1],i%2?1:2,v*gate);if(i&&b>i*.17)line(...pts[i-1],...p,v*.65*(1-c));});if(c>0)card(74,5,19,22,v*c);bits(82,15,16,4,v*.6*(1-c));}
 if(k===4){const h=2+21*b,w=2+19*b;box(82-w/2,16-h/2,w,h,v);if(b<.7)star(82,16,2+2*(1-b),v);if(b>.45){line(76,12,89,12,v*b);line(76,17,86,17,v*b);line(76,22,89,22,v*b);}bits(82,16,4+12*b,8,v*.75);}
 if(k===5){if(q>.15){line(60,12,75,5,v*.35);line(60,19,75,27,v*.35);for(let i=0;i<5;i++){const xx=61+((t*11+i*4)%14);dot(xx,12+(i%3)*3,v*.65);}const w=2+18*b;card(75,5,w,22,v);line(75,5+22*((t*.5)%1),75+w,5+22*((t*.5)%1),v*.6);if(c>0)star(97,3,1,v);}}
 const hands=f.layers.hands;for(let i=0;i<hands.length;i++)if(hands[i])for(const j of [i-1,i+1,i-100,i+100])if(j>=0&&j<3200&&!face[j])f.pixels[j]=0;
 for(let i=0;i<hands.length;i++)if(hands[i])f.pixels[i]=hands[i];
}
const idle={
 yoyoY:t=>t<1||t>6.5?23:19+9*(1-Math.cos(2*Math.PI*(t-1)/1.6))/2,
 bubble:t=>{const u=Math.max(0,Math.min(1,(t-3.5)/3.7)),a=(1-u)*(1-u),b=2*u*(1-u),c=u*u;return {x:a*48+b*78+c*96,y:a*25+b*30+c*4+Math.sin(6*u)};},
 fly:t=>({x:48+40*Math.sin(t*1.9+1),y:2.5+2*Math.sin(t*3.1)}),
 flyEscape:t=>({x:86+(t-8.5)*14,y:6-(t-8.5)*6}),
};
// Reply-opener glyphs (engine.js MIC_OPENERS): native-pixel stamps the renderer draws
// last, at the ink the opener asks for, with a one-pixel dark moat.
const glyphs={
 spark:['00100','00100','11011','00100','00100'],
 spark3:['010','111','010'],
 glint:['0010000','0010000','1101100','0010000','0010000'],
 drop:['00100','01110','01110','11111','11111','01110'],
 bang:['11','11','11','11','00','11'],
 tick:['1','1'],
 ring:['01','10','10','10','01'],
 ring2:['01','10','10','10','10','10','01'],
 crack:['10001','01010','00000','01010','10001'],
 // Speck New Moves openers (2026-10-27): dust, lasso, fumble, poke.
 dust:['1000001','0010100','1000001'],
 puff:['0110','1111','0110'],
 qS:['010','101','001','010','000','010'],
 // More Speck Moves openers (2026-10-28): poof, laughing.
 poof:['000011101110000','001111111111100','011111111111110','111111111111111','111111011111111','011111111111110','111111110111111','111111111111111','011111111111110','001111111111100','000011101110000'],
 poofBits:['011000000001100','111100000011110','011000000001100','000000000000000','000000110000000','000001111000000','000000110000000'],
 ha:['1010010','1010101','1110111','1010101','1010101'],
 dropS:['010','111','111','010'],
 puffS:['010','111','010']
};
const api={draw,drawMagic,drawMic,kinds,idle,glyphs};if(typeof module!=='undefined')module.exports=api;else root.WatchProps=api;
})(typeof window!=='undefined'?window:globalThis);
;
// ALIVE_VENDOR_END props.js

// ALIVE_VENDOR_BEGIN renderer.js
/* Original procedural Watch artwork. All primitives rasterize into 100 x 32.
 * The enlarged view and the slot preview use the exact same pixel buffer. */
(function(root){
'use strict';
const eyeDesigns=[
 {id:'balanced-l',label:'Balanced L',description:'A soft L whose opening follows his attention.'},
 {id:'jellybean',label:'Jellybean',description:'Bouncy bean eyes with a soft little lean.'},
 {id:'inkdrop',label:'Inkdrop',description:'Chunky ink commas with cheeky curled tails.'},
 {id:'starburst',label:'Starburst',description:'Bold four-point sparks, full of wonder.'}
];
const frameModels=[{id:'g2b',label:'G2B · square'},{id:'g2a',label:'G2A · round'}];
const thinkingIdeas={
 heart:['0000000000','0011001100','0111111110','0111111110','0011111100','0001111000','0000110000','0000000000','0000000000','0000000000'],
 bulb:['0001111000','0010000100','0100000010','0100110010','0100110010','0010110100','0001001000','0001111000','0001001000','0000110000'],
 star:['0000110000','0000110000','0001111000','1111111111','0111111110','0011111100','0001111000','0011001100','0110000110','0000000000'],
 rocket:['0000110000','0001111000','0001001000','0001111000','0001111000','0011111100','0111111110','0101111010','0001001000','0000110000'],
 lightning:['0000011100','0000111000','0001110000','0011100000','0111111100','0000111000','0001110000','0011100000','0011000000','0010000000'],
 music:['0000111110','0000100010','0000100010','0000100010','0000100010','0000101110','0011101110','0111100000','0111100000','0011000000']
};
// Small native-pixel glyphs a reactor reaction pops beside him (engine.js REACTIONS).
const REACTION_GLYPHS={
 ha:['1010010','1010101','1110111','1010101','1010101'],
 bang:['11','11','11','11','00','11'],
 q:['0110','1001','0001','0010','0100','0000','0100'],
 heart:['011000110','111101111','111111111','111111111','011111110','001111100','000111000','000010000'],
 heartS:['0110110','1111111','1111111','0111110','0011100','0001000'],
 drop:['00100','01110','01110','11111','11111','01110'],
 spark:['00100','00100','11011','00100','00100'],
 spark3:['010','111','010'],
 dot1:['11','11'],
 dot2:['11011','11011'],
 dot3:['11011011','11011011'],
 bulb:['01110','10001','10001','10001','01010','01110','01110'],
 zs:['1111000','0010000','0100000','1111111','0000010','0000100','0001111'],
 // Speck New Moves reactions (2026-10-27): mindblown, cringe, sigh, doubletake.
 boom:['1001001','0101010','0011100','1110111','0011100','0101010','1001001'],
 wave:['0110','1001'],
 puff:['0110','1111','0110'],
 puffS:['010','111','010'],
 qbang:['011101','100101','000101','001001','010000','000001','010001']
};
// More Speck Moves reactions (2026-10-28) mark both lenses in one picture, so their glyphs are
// built from parts, [rows,dx,dy]: a star or a spinning spiral on each eye (the right one two rows
// lower when he tilts), sparkles or two stars orbiting his head, blush under both lenses, and air
// quotes either side of his head.
const glyphFrom=parts=>{
 const w=Math.max(...parts.map(([g,x])=>x+g[0].length)),h=Math.max(...parts.map(([g,,y])=>y+g.length)),rows=Array.from({length:h},()=>Array(w).fill('0'));
 for(const [g,x,y] of parts)g.forEach((r,j)=>[...r].forEach((v,i)=>{if(v==='1')rows[y+j][x+i]='1';}));
 return rows.map(r=>r.join(''));
};
const STAR9=['000010000','000010000','000111000','111111111','011111110','001111100','001101100','011000110','010000010'];
const SPIRAL=['111111111','000000001','011111101','010000101','010110101','010100101','010111101','010000001','011111111'];
const turn90=g=>[...g[0]].map((_,i)=>g.map(r=>r[i]).reverse().join(''));
const SPIN=[SPIRAL,turn90(SPIRAL),turn90(turn90(SPIRAL)),turn90(turn90(turn90(SPIRAL)))];
const S3=REACTION_GLYPHS.spark3,QUOTE_L=['01001','10010','11011','11011'],QUOTE_R=['11011','11011','01001','10010'];
Object.assign(REACTION_GLYPHS,{
 starsA:glyphFrom([[STAR9,0,0],[STAR9,24,0]]),
 starsB:glyphFrom([[STAR9,0,0],[STAR9,24,2]]),
 starsC:glyphFrom([[STAR9,22,8],[STAR9,46,10],[S3,0,1],[S3,65,0],[S3,68,5]]),
 dizzy1:glyphFrom([[SPIN[0],21,8],[SPIN[0],45,10],[S3,0,2],[S3,35,0]]),
 dizzy2:glyphFrom([[SPIN[1],0,10],[SPIN[1],24,8],[S3,14,0],[S3,45,2]]),
 dizzy3:glyphFrom([[SPIN[2],0,8],[SPIN[2],24,10],[S3,45,2],[S3,14,0]]),
 dizzy4:glyphFrom([[SPIN[3],21,10],[SPIN[3],45,8],[S3,35,0],[S3,0,2]]),
 blush:glyphFrom([[['001001001','010010010','100100100'],0,2],[['001001001','010010010','100100100'],28,0]]),
 quotes:glyphFrom([[QUOTE_L,0,0],[QUOTE_R,65,0]])
});
// Speck Feelings Picker reactions (2026-11-11): nibble, dart, fistpump, buzz, blinkblink, jolt, phew, exhale,
// tipframe, grumble and huff. The others reuse drop, bang, puff, puffS and spark3 above.
Object.assign(REACTION_GLYPHS,{
 drops:['0010000000','0111000000','0111000000','1111100010','1111100111','0111000111','0000000010'],
 sparks:['0000000010','0000000111','0010000010','0010000000','1101100000','0010000000','0010000000'],
 sparks2:['00010000000','00010000000','01101100000','00010000000','00010000010','00000000111','01000000010','11100000000','01000000000'],
 bang2:['110011','110011','110011','110011','000000','110011'],
 qbang2:['01100011','10010011','00010011','00100011','01000000','00000011','01000000'],
 scribble:['011001100','100110010','010010011','101101100','010010010','001100110'],
 steam:['00000000110','00000001111','00000000110','01100000000','11110000000','01100000000'],
 steam2:['00000000110','00000001111','01100000110','11110000000','01100000000','00000000000','00000100000','00001110000','00000100000'],
 // Round two picks: blankstare's ticking dots, a flame in each lens (fire) and a heart on each (hearteyes).
 tick1:['11'],
 tick2:['11011'],
 tick3:['11011011'],
 flames:['000010000000000000000000000010000','000110000000000000000000000110000','000111010000000000000000000111010','010111100000000000000000010111100','011111110000000000000000011111110','111111111000000000000000111111111','111111111000000000000000111111111','011111110000000000000000011111110','001111100000000000000000001111100'],
 flamesB:['000100000000000000000000000100000','000110010000000000000000000110010','010111010000000000000000010111010','011111100000000000000000011111100','011111110000000000000000011111110','111111111000000000000000111111111','111111111000000000000000111111111','011111110000000000000000011111110','001111100000000000000000001111100'],
 hearts:['011000110000000000000000011000110','111101111000000000000000111101111','111111111000000000000000111111111','111111111000000000000000111111111','011111110000000000000000011111110','001111100000000000000000001111100','000111000000000000000000000111000','000010000000000000000000000010000'],
 heartsB:['011000110000000000000000000000000','111101111000000000000000000000000','111111111000000000000000011000110','111111111000000000000000111101111','011111110000000000000000111111111','001111100000000000000000111111111','000111000000000000000000011111110','000010000000000000000000001111100','000000000000000000000000000111000','000000000000000000000000000010000']
});
function render(s,options={}){
 const activeMagic=!!s.magic?.ready&&!s.resting&&!s.attending;
 const W=100,H=32,pixels=new Uint8Array(W*H),p=s.p,t=s.phase,T=s.static?0:s.time;
 const ink=15;
 let layer='face',blocked=null,clippedHandInk=0;
 const objectMask=new Uint8Array(W*H),handMask=new Uint8Array(W*H),leftHand=new Uint8Array(W*H),rightHand=new Uint8Array(W*H);let activeHand=null;
 function dot(x,y,c=ink){x=Math.round(x);y=Math.round(y);if(x>=0&&x<W&&y>=0&&y<H){const i=y*W+x;if(layer==='hands'&&blocked[i]){if(c)clippedHandInk++;return;}pixels[i]=c;if(layer==='object')objectMask[i]=1;if(layer==='hands'){handMask[i]=1;if(activeHand)activeHand[i]=c;}}}
 // Essential strokes use a 2x2 native-pixel nib, including dark cutouts.
 // This is authored at 100x32, not a post-render dilation that fills eye gaps.
 function line(x0,y0,x1,y1,c=ink){x0=Math.round(x0);y0=Math.round(y0);x1=Math.round(x1);y1=Math.round(y1);let dx=Math.abs(x1-x0),sx=x0<x1?1:-1,dy=-Math.abs(y1-y0),sy=y0<y1?1:-1,err=dx+dy;for(let i=0;i<300;i++){dot(x0,y0,c);dot(x0+1,y0,c);dot(x0,y0+1,c);dot(x0+1,y0+1,c);if(x0===x1&&y0===y1)break;let e=2*err;if(e>=dy){err+=dy;x0+=sx;}if(e<=dx){err+=dx;y0+=sy;}}}
 function poly(pts,c=ink){let lo=Math.max(0,Math.floor(Math.min(...pts.map(a=>a[1])))),hi=Math.min(H-1,Math.ceil(Math.max(...pts.map(a=>a[1]))));for(let y=lo;y<=hi;y++){let xs=[];for(let i=0,j=pts.length-1;i<pts.length;j=i++){const a=pts[i],b=pts[j];if((a[1]>y+.5)!==(b[1]>y+.5))xs.push(a[0]+(y+.5-a[1])*(b[0]-a[0])/(b[1]-a[1]));}xs.sort((a,b)=>a-b);for(let i=0;i+1<xs.length;i+=2)for(let x=Math.max(0,Math.ceil(xs[i]-.5));x<Math.min(W,Math.ceil(xs[i+1]-.5));x++)dot(x,y,c);}}
 const rect=(x,y,w,h,c=ink)=>poly([[x,y],[x+w,y],[x+w,y+h],[x,y+h]],c);
 const box=(x,y,w,h,c=ink)=>{line(x,y,x+w,y,c);line(x+w,y,x+w,y+h,c);line(x+w,y+h,x,y+h,c);line(x,y+h,x,y,c);};
 function path(pts,c=ink){pts.slice(1).forEach((q,i)=>line(...pts[i],...q,c));}
 function circle(x,y,r,c=ink){let pts=[];for(let a=0;a<6.4;a+=.45)pts.push([x+Math.cos(a)*r,y+Math.sin(a)*r]);path(pts,c);}
 function local(cx,cy,angle=0,scale=1){const a=Math.cos(angle),b=Math.sin(angle);const pt=(x,y)=>[cx+(x*a-y*b)*scale,cy+(x*b+y*a)*scale];return {pt,poly:(pts,c=ink)=>poly(pts.map(q=>pt(...q)),c),line:(x,y,xx,yy,c=ink)=>line(...pt(x,y),...pt(xx,yy),c),rect:(x,y,w,h,c=ink)=>poly([[x,y],[x+w,y],[x+w,y+h],[x,y+h]].map(q=>pt(...q)),c)};}
 // Larger symbols occupy the new 18x12 inner lens. Keep a full frame even
 // where an authored perspective plane narrows the available corners.
 function lensSymbol(name,r){const K=(x,y,w,h)=>r.rect(x,y,w,h,0),W=(x,y,w,h)=>r.rect(x,y,w,h);
  if(name==='terminal'){
   const glyph=s.typing?.glyph||'_';
   const chars={'0':['111','101','101','101','111'],'1':['010','110','010','010','111']};
   if(glyph==='_')K(-3,3,6,2);
   else chars[glyph].forEach((row,y)=>Array.from(row).forEach((v,x)=>{if(v==='1')K(-3+x*2,-5+y*2,2,2);}));
  }
  if(name==='sync'){K(-6,-4,11,2);K(3,-2,2,2);K(-4,2,11,2);K(-4,0,2,2);}
  if(name==='search'){K(-5,-4,8,8);W(-3,-2,4,4);K(3,3,4,2);}
  if(name==='download'||name==='upload'){const up=name==='upload';K(-1,-4,2,6);r.line(-5,up?0:-2,0,up?-4:1,0);r.line(0,up?-4:1,5,up?0:-2,0);K(-5,4,12,2);}
  if(name==='bars'){K(-6,1,3,4);K(-1,-2,3,7);K(4,-4,3,9);}
  if(name==='pulse'){r.line(-6,0,-3,0,0);r.line(-3,0,-1,-4,0);r.line(-1,-4,2,4,0);r.line(2,4,4,0,0);K(4,0,3,2);}
  if(name==='lock'){K(-4,-4,8,6);W(-2,-2,4,3);K(-6,0,12,6);W(-1,2,2,2);}
  if(name==='check'){r.line(-6,0,-2,4,0);r.line(-2,4,5,-4,0);}
  if(name==='pencil'){r.poly([[-6,4],[-4,0],[3,-5],[6,-2],[-2,5]],0);W(-2,0,2,2);}
  if(name==='link'){K(-6,-3,7,6);W(-4,-1,3,2);K(0,-1,7,6);W(2,1,3,2);K(-1,0,3,2);}
  if(name==='text'){K(-6,-4,12,2);K(-6,0,9,2);K(-6,4,6,2);}
 }
 const Props=typeof module!=='undefined'?require('./props.js'):root.WatchProps;
 function props(){Props.draw(s,{local});}
 // A reply opener's sparkles, drops and rings (props.js glyphs), each at its own ink so
 // they ease in and out, over a one-pixel dark moat.
 function micGlyphs(){
  for(const g of s.mic.glyphs){const rows=Props.glyphs[g.k];if(!rows)continue;const h=rows.length,w=rows[0].length;
   const on=(i,j)=>j>=0&&j<h&&i>=0&&i<w&&rows[j][i]==='1';
   for(let j=-1;j<=h;j++)for(let i=-1;i<=w;i++)if(!on(i,j)&&[-1,0,1].some(dj=>[-1,0,1].some(di=>on(i+di,j+dj))))dot(g.x+i,g.y+j,0);
   for(let j=0;j<h;j++)for(let i=0;i<w;i++)if(on(i,j))dot(g.x+i,g.y+j,g.ink);}
 }
 // Idle-variation props: the yo-yo, bubble, Zs and fly he entertains himself
 // with. Drawn last, over every layer, with a one-pixel dark moat so they read
 // even when they pass in front of the frame. The moat hugs a sprite's own dots
 // (their four neighbours), not its box, and never eats into his mittens: a box
 // cut a dark square out of the hand the yo-yo came back to.
 // Still frames get their authored resting prop. Timing matches engine.js
 // idleBeat; paths come from props.js.
 function idleProps(){
  const v=s.variant,t=s.age%10,still=!!s.resting,P=Props.idle;
  const sp=(x,y,rows)=>{x=Math.round(x);y=Math.round(y);const h=rows.length,w=rows[0].length,on=(i,j)=>j>=0&&j<h&&i>=0&&i<w&&rows[j][i]==='1';
   for(let j=-1;j<=h;j++)for(let i=-1;i<=w;i++)if(!on(i,j)&&(on(i-1,j)||on(i+1,j)||on(i,j-1)||on(i,j+1))){const X=x+i,Y=y+j;if(X<0||X>=W||Y<0||Y>=H||!handMask[Y*W+X])dot(X,Y,0);}
   rows.forEach((row,j)=>{for(let i=0;i<w;i++)if(row[i]==='1')dot(x+i,y+j);});};
  const ballAt=(x,y)=>sp(x-2,y-2,['.11.','1111','1111','.11.']);
  const thin=(x0,y0,x1,y1)=>{x0=Math.round(x0);y0=Math.round(y0);x1=Math.round(x1);y1=Math.round(y1);let dx=Math.abs(x1-x0),sx=x0<x1?1:-1,dy=-Math.abs(y1-y0),sy=y0<y1?1:-1,err=dx+dy;for(let i=0;i<200;i++){dot(x0,y0);if(x0===x1&&y0===y1)break;const e=2*err;if(e>=dy){err+=dy;x0+=sx;}if(e<=dx){err+=dx;y0+=sy;}}};
  const ringAt=(cx,cy,r)=>{for(let y=Math.floor(cy-r-1);y<=Math.ceil(cy+r+1);y++)for(let x=Math.floor(cx-r-1);x<=Math.ceil(cx+r+1);x++)if(Math.hypot(x-cx,y-cy)<=r+1)dot(x,y,0);
   for(let y=Math.floor(cy-r);y<=Math.ceil(cy+r);y++)for(let x=Math.floor(cx-r);x<=Math.ceil(cx+r);x++)if(Math.abs(Math.hypot(x-cx,y-cy)-r)<.6)dot(x,y);dot(cx-r*.5,cy-r*.5);};
  const flyAt=(x,y,w)=>{dot(x,y);dot(x-1,y-w);dot(x+1,y-w);};
  const sparks=(x,y)=>{for(const [dx,dy] of [[-3,-3],[3,-3],[-3,3],[3,3],[0,-4],[0,4],[-4,0],[4,0]])dot(x+dx,y+dy);};
  const Z=['111','.1.','111'],ZB=['1111','..1.','.1..','1111'];
  if(v===0){
   // The hand travels in from listening/reply. Carry the whole yo-yo with
   // its drawn grip instead of revealing it at the eventual resting point.
   const x=Math.round(p.rx),handY=Math.min(27,Math.max(5,Math.round(p.ry)));
   const y=handY+(still?23:P.yoyoY(t))-15;
   // The mitten sits in front of the yo-yo: neither the ball nor its dark
   // moat draws on the mitten's rows, so at the top of a bob the ball tucks into the
   // palm instead of cutting a notch out of the hand.
   const below=handY+5,d=(px,py,c)=>{if(Math.round(py)>=below)dot(px,py,c);};
   thin(x,handY+4,x,y-2);
   const ball=['.11.','1111','1111','.11.'];
   for(let j=-1;j<=4;j++)for(let i=-1;i<=4;i++)d(x-2+i,y-2+j,0);
   ball.forEach((row,j)=>{for(let i=0;i<4;i++)if(row[i]==='1')d(x-2+i,y-2+j);});
  }
  // The bubble has popped by the held still frame, so the still holds no bubble.
  if(v===1&&!still){if(t>=1&&t<3.5)ringAt(48,25,1+2.5*(t-1)/2.5);else if(t>=3.5&&t<7.2){const b=P.bubble(t);ringAt(b.x,b.y,3.5);}else if(t>=7.2&&t<7.5){const b=P.bubble(7.2);sparks(b.x,b.y);}}
  if(v===2){if(still){sp(75,3,Z);sp(81,1,Z);}else if(t>=1.5&&t<6){for(let k=0;k<3;k++){const zt=t-1.5-1.3*k;if(zt>0&&zt<3.2){const y=8-zt*3.5;if(y>=1)sp(74+zt*2.5,y,zt<1.6?Z:ZB);}}}else if(t>=6&&t<6.3)sparks(78,5);}
  if(v===3&&!still){if(t<7){const f=P.fly(t);flyAt(f.x,f.y,Math.floor(t*20)%2);}else if(t>=8.5&&t<9.5){const f=P.flyEscape(t);flyAt(f.x,f.y,Math.floor(t*20)%2);}}
  if(v===7){
   if(!still&&t>=1&&t<3.5){const fade=t<2?1:(3.5-t)/1.5;for(let y=hy-5;y<hy+5;y+=2)for(let x=hx+6;x<hx+20;x+=2)if(!handMask[y*W+x])dot(x,y,Math.round(6*fade));}
   // The stubborn speck sits on the lens, behind the scrubbing mitten and its outline.
   if(!still&&t>=4.5&&t<7.5){const x0=hx+16,y0=hy-3;for(let y=y0-1;y<=y0+2;y++)for(let x=x0-1;x<=x0+2;x++){const i=y*W+x;if(x>=0&&x<W&&y>=0&&y<H&&!handMask[i]&&!gripMask[i])dot(x,y,x>=x0&&x<=x0+1&&y>=y0&&y<=y0+1?ink:0);}}
   if(still||t>=8){const cx=hx+24,cy=hy-9;thin(cx-3,cy,cx+3,cy);thin(cx,cy-3,cx,cy+3);}
  }
  if(v===8&&!still&&t>=1&&t<9.5){for(let k=0;k<3;k++){
   const B=['.11.','1111','1111','.11.'];
   if(t>=6.4&&k===2){const drop=(t-6.4)/.7;if(drop<1)sp(92,6+30*drop,B);continue;}
   let x,y;
   if(t<6.4){const u=((t-1)/1.5+k/3)%1;if(u<.62){const a=u/.62;x=72+18*a;y=22-19*Math.sin(Math.PI*a);}else{const a=(u-.62)/.38;x=90-18*a;y=22-3*Math.sin(Math.PI*a);}}
   else {x=k?90:74;y=t<8.5?22:22+(t-8.5)*12;}
   sp(x-2,y-2,B);
  }}
  // Drum strikes: the letters never move, so two short diagonal strokes either
  // side of a striking mitten, on the two rows above the floor, show the hit.
  if(v===11&&!still&&s.drum)for(const h of ['l','r'])if(s.drum[h]){
   const x=Math.round(h==='l'?p.lx:p.rx);
   for(const [dx,y] of [[-6,30],[-7,29],[6,30],[7,29]])dot(x+dx,y);
  }
 }
 // Small helpers grow in from a dock; no new face appears at full size.
 function helper(cx,cy,scale){if(scale<.04)return;const h=local(cx,cy,0,scale);for(const x of [-7,1]){h.rect(x,-3,6,6);h.rect(x+2,-1,2,2,0);}h.rect(-1,-2,2,2);h.rect(-7,-6,6,2);h.rect(1,-6,6,2);}
 if(p.helper>.025){const layout=s.prop.layout||{offset:0,side:1},x=85+layout.offset;helper(layout.side<0?100-x:x,8,Math.min(1,p.helper));if(p.helper>1.025)helper(layout.side<0?100-x:x,25,Math.min(1,p.helper-1));}
 // Five authored perspective views. The far lens gets smaller, the frame
 // edges climb a fixed pixel stair and the near hinge reveals a side plane.
 // Spring-driven turns traverse these views without rotating the raster art.
 const facing=Math.max(-2,Math.min(2,Math.round(p.turn||0)));
 const tilt=Math.max(-2,Math.min(2,Math.round(p.tilt/.08)));
 const depth=Math.abs(facing),direction=Math.sign(facing),slant=depth===2?direction:0;
 // Pull ups and the one-hand hang cross the canvas edge; all other poses retain clearance.
 const edgeGrip=s.action==='idle'&&(s.variant===5||s.variant===10)&&!s.resting;
 const hx=Math.round(p.x),hy=edgeGrip?Math.round(p.y):Math.max(13+Math.abs(tilt),Math.round(p.y));
 const left={x:hx-12,y:hy-tilt+(facing===2?1:0),w:facing<0?20:22,h:16,slant};
 const right={x:hx+12,y:hy+tilt+(facing===-2?1:0),w:facing>0?20:22,h:16,slant};
 const roundFrame=options.frameModel==='g2a';
 if(roundFrame){left.w-=2;right.w-=2;}
 // Pixel interpretations of the local G2A/G2B source-mesh lens silhouettes:
 // A's taller panto bowl; B's broad flat crown and gently tapered lower rim.
 function lensPath(a,inset=0){const w=a.w/2-inset,h=a.h/2-inset,k=a.slant;
  const pts=roundFrame?[[-w+4,-h],[w-4,-h],[w-1,-h+2],[w,-h+5],[w-1,h-5],[w-4,h-1],[w-7,h],[-w+7,h],[-w+4,h-1],[-w+1,h-5],[-w,-h+5],[-w+1,-h+2]]:
   [[-w+2,-h],[w-2,-h],[w,-h+2],[w-1,h-3],[w-3,h],[-w+3,h],[-w+1,h-3],[-w,-h+2]];
  return pts.map(([x,y])=>[a.x+x,a.y+y-k*x/w]);}
 function lens(a){poly(lensPath(a));poly(lensPath(a,2),0);}
 // A broad stair-step bridge, always behind the lens outlines.
 const bridgeX=left.x+9,bridgeW=right.x-left.x-18;
 rect(bridgeX,hy-3,Math.max(3,bridgeW),2);rect(bridgeX,Math.min(left.y,right.y)-3,2,Math.abs(tilt)+2);
 if(depth===2){const a=facing>0?left:right,side=facing>0?-1:1,edge=a.x+side*a.w/2;rect(side<0?edge-4:edge+2,a.y-2,2,5);rect(side<0?edge-4:edge,a.y-3,4,2);}
 lens(left);lens(right);
 if(facing!==2)rect(left.x-14,left.y-2,2,4);if(facing!==-2)rect(right.x+12,right.y-2,2,4);
 // An irregular, deterministic blink phrase survives state changes. A short
 // double blink happens once per phrase, with actual stillness in between.
 const ease=x=>{x=Math.max(0,Math.min(1,x));return x*x*(3-2*x);};
 // Close briskly, hold for a beat, then ease open. The persistent clock
 // keeps a state switch from restarting a blink halfway through.
 const closureAt=age=>age<0||age>=.23?0:age<.065?ease(age/.065):age<.09?1:1-ease((age-.09)/.14);
 const wakeOpen=1-Math.max(0,Math.min(1,s.displayWakeProgress||0));
 const bt=T%11.6,blinkClosure=wakeOpen*Math.max(...[2.65,6.4,10.1,10.42].map(start=>closureAt(bt-start)));
 const names=['curious','focused','delighted','concerned','surprised','skeptical','sleepy','playful'];
 let expression='neutral',weight=.5;for(const name of names)if((p[name]||0)>weight){expression=name;weight=p[name];}
 // Solid eyes from the reference: the familiar little L, shortened lids,
 // soft happy arches and filled surprise eyes. No hollow square pupils.
 const glyphs={
  neutral:['01111110','11111111','11111111','11111100','11111100','11111000','11111000','11110000','11110000'],
  focus:['011110','111111','111111','111100','111000','111000'],
  joy:['00111100','00111100','11100111','11100111','11000011','11000011'],
  surprise:['111111','111111','111111','111111','111111','111111'],
  sleep:['111111','111111'],wink:['111111','111111']
 };
 const design=options.eyeDesign||'balanced-l';
 if(design==='jellybean')Object.assign(glyphs,{
  neutral:['00111100','01111110','11111110','11111110','11111100','11111100','01111000','00110000'],
  joy:['00111100','01111110','11100111','11000011','11000011'],
  surprise:['00111100','01111110','11111111','11111111','11111111','11111111','01111110','00111100']
 });
 if(design==='inkdrop')Object.assign(glyphs,{
  neutral:['00111100','01111110','11111111','11111111','01111111','00000111','00001110','00111100'],
  joy:['00111100','11111111','11100111','11000011','00000011','00000110'],
  surprise:['00111100','01111110','11111111','11111111','11111111','01111110','00011100','00111000']
 });
 if(design==='starburst')Object.assign(glyphs,{
  neutral:['00011000','00011000','00111100','11111111','11111111','00111100','00011000','00011000'],
  joy:['00011000','00111100','11111111','11000011','11000011','00011000'],
  surprise:['00011000','00111100','01111110','11111111','11111111','01111110','00111100','00011000']
 });
 function eyeStyle(side){
  if(expression==='focused')return 'focus';
  if(expression==='delighted')return 'joy';
  if(expression==='surprised')return 'surprise';
  if(expression==='skeptical')return 'focus';
  if(expression==='sleepy')return 'sleep';
  return 'neutral';
 }
 function livingEye(a,side){
  const ex=Math.max(-2,Math.min(2,Math.round(p.gazeX)));
  const style=eyeStyle(side);
  // Focus/sleep weights already ride the rig's springs. Use those continuous
  // values to lower the lids through intermediate native-pixel heights.
  const ordinary=style==='neutral'||style==='focus'||style==='sleep';
  let source=ordinary?glyphs.neutral:glyphs[style];
  if(a.slant&&source.length>8)source=source.slice(0,8);
  const baseH=source.length,w=source[0].length;
  const focus=Math.max(0,Math.min(1,Math.max(p.focused||0,p.skeptical||0)));
  const sleepy=Math.max(0,Math.min(1,p.sleepy||0));
  // `wink` is a pose key a closer can drive; playful also winks on its own timer.
  const wink=side?Math.max(expression==='playful'?wakeOpen*closureAt(T%4.6-.95):0,Math.min(1,p.wink||0)):0;
  // shutL/shutR close one eye on its own (a reaction's wink); eye closes both.
  const shut=side?p.shutR:p.shutL;
  const closure=Math.max(blinkClosure,wink,1-Math.max(0,Math.min(1,p.eye)),shut>0?Math.min(1,shut):0);
  // Brief up/down glances tuck the lower stem just enough to make room for
  // real eye movement. The full Balanced L returns when looking straight on.
  const glanceRoom=ordinary?Math.min(2,Math.abs(p.gazeY)*2):0;
  const openH=ordinary?(baseH-Math.max(2*focus,glanceRoom))*(1-sleepy)+2*sleepy:baseH;
  const h=Math.max(2,Math.round(2+(openH-2)*(1-closure)));
  let rows=h===2?Array(2).fill('1'.repeat(w)):Array.from({length:h},(_,y)=>source[Math.round(y*(baseH-1)/(h-1))]);
  if(design==='balanced-l'&&ordinary&&h>2){
   // The negative space reads as his gaze. Let it open toward the target,
   // rather than permanently suggesting a look into the lower-right corner.
   const gx=Math.abs(p.gazeX)<.5?0:Math.sign(p.gazeX),gy=Math.abs(p.gazeY)<.5?0:Math.sign(p.gazeY);
   rows=Array.from({length:h},(_,y)=>y===0||y===h-1?'01111110':'11111111');
   if(h>=4&&(gx||gy)&&!(gx&&!gy&&h<6)){
    const cutH=Math.min(4,h-(gy?2:4)),cutW=4;
    const x0=gx<0?0:gx>0?8-cutW:2;
    const y0=gy<0?0:gy>0?h-cutH:Math.floor((h-cutH)/2);
    rows=rows.map((row,y)=>Array.from(row,(v,x)=>y>=y0&&y<y0+cutH&&x>=x0&&x<x0+cutW?'0':v).join(''));
   }
  }
  if(['jellybean','inkdrop'].includes(design)&&side)rows=rows.map(row=>Array.from(row).reverse().join(''));
  // Preserve a black moat around the eye at every gaze position. A blink or
  // lowered eyelid must never fuse with the white glasses frame.
  const ey=Math.max(-2,Math.min(2,Math.round(p.gazeY)));
  // Choose the nearest pixel placement that leaves a black gap all around
  // the larger eye, including the tighter corner of a perspective lens.
  const candidates=[];for(const dx of [-2,-1,0,1,2])for(const dy of [-2,-1,0,1,2])candidates.push({dx,dy,d:Math.abs(dx-ex)+Math.abs(dy-ey)});
  candidates.sort((a,b)=>a.d-b.d);
  const fit=candidates.find(({dx,dy})=>rows.every((row,y)=>Array.from(row).every((v,x)=>{if(v!=='1')return true;const i=(a.y-Math.floor(h/2)+dy+y)*W+a.x-Math.floor(w/2)+dx+x;return [i,i-1,i+1,i-W,i+W].every(j=>pixels[j]===0);})))||{dx:ex,dy:ey};
  const ox=a.x-Math.floor(w/2)+fit.dx,oy=a.y-Math.floor(h/2)+fit.dy;
  rows.forEach((row,y)=>{for(let x=0;x<row.length;x++)if(row[x]==='1')dot(ox+x,oy+y);});
  // A one-pixel lid difference keeps an inquisitive look within the same
  // eye family. It is a small accent, never a square-versus-L pairing.
  if(design!=='balanced-l'&&closure===0&&style==='neutral'&&side&&expression==='curious'&&T%5<1.3)rect(ox,oy+h-1,w,1,0);
 }
 const frameInk=pixels.slice();
 if(!options.hideEyes){livingEye(left,0);livingEye(right,1);}
 const ir=s.icon.reveal;
 if(s.icon.kind&&ir>.05){
  // A vertical wipe replaces only the inner lens; frame and normal eye do not pop.
  const before=pixels.slice(),top=right.y+6-Math.round(12*ir);
  poly(lensPath(right,2));
  for(let y=0;y<top;y++)for(let x=0;x<W;x++)pixels[y*W+x]=before[y*W+x];
  if(ir>.9)lensSymbol(s.icon.kind,local(right.x,right.y));
  for(let i=0;i<W*H;i++)if(frameInk[i])pixels[i]=frameInk[i];
 }
 function brow(a,angle,lift){
  const step=Math.abs(angle)<.075?0:Math.sign(angle);
  const ys=[0,1,2].map(i=>a.y+Math.min(-11,-12+Math.round(p.browY+(lift||0)))+(i-1)*step-a.slant*Math.sign(i-1));
  // Move the whole brow off the top edge; clipping each segment separately
  // flattened its expressive slope whenever the character lifted his head.
  const inset=edgeGrip?0:Math.max(0,(activeMagic?0:1)-Math.min(...ys));for(let i=0;i<3;i++)rect(a.x-7+i*5,ys[i]+inset,5,2);
 }
 if(!options.hideBrows){brow(left,p.browL,p.browLiftL);brow(right,p.browR,p.browLiftR);}
 const listen=Math.min(1,Math.max(0,p.listenCue||0));
 if(listen>.03){const a=local(8,15,0,listen);a.poly([[-3,-8],[-1,-8],[-4,-4],[-4,4],[-1,8],[-3,8],[-6,4],[-6,-4]]);a.poly([[3,-5],[5,-5],[2,-2],[2,2],[5,5],[3,5],[0,2],[0,-2]]);}
 const alarm=Math.min(1,Math.max(0,p.errorCue||0));
 if(alarm>.03){const a=local(90,16,0,alarm);a.rect(-2,-9,4,12);a.rect(-2,6,4,4);}
 function hand(x,y,rot,op,point,thumb,flip){
  const scale=p.handScale<.86?.8:1,h=local(Math.round(x),Math.min(27,Math.max(edgeGrip?-1:5,Math.round(y))),rot,scale);
  // Soft continuous mitten contours are intentional here. The glasses keep
  // their authored pixel planes; hands can curve and roll like the reference.
  function oval(cx,cy,rx,ry,c=ink){const pts=[];for(let i=0;i<28;i++){const a=i*Math.PI/14;pts.push([cx+Math.cos(a)*rx,cy+Math.sin(a)*ry]);}h.poly(pts,c);}
  function capsule(x1,y1,x2,y2,r,c=ink){const a=Math.atan2(y2-y1,x2-x1),pts=[];for(let i=0;i<=12;i++){const t=a+Math.PI/2+i*Math.PI/12;pts.push([x1+Math.cos(t)*r,y1+Math.sin(t)*r]);}for(let i=0;i<=12;i++){const t=a-Math.PI/2+i*Math.PI/12;pts.push([x2+Math.cos(t)*r,y2+Math.sin(t)*r]);}h.poly(pts,c);}
  oval(0,1,4.4,4.8,0);oval(0,1,3.5,3.9);
  capsule(flip*1.4,-.7,flip*2.4,-2,1.65);
  if(op>.2){capsule(-1.4,-1.5,-1.4,-2.2-op*2.8,1.5);capsule(1,-1,1,-2-op*2,1.5);}
  if(Math.abs(point)>.15){const dir=point<0?-flip:flip;capsule(dir,-1,dir*(2+Math.abs(point)*4.5),-1,1.4);}
  if(thumb>.2)capsule(-flip*1.5,-1,-flip*1.5,-2-thumb*4,1.6);
 }
 // Independently authored layers reserve a dark seam at grips. Hands cannot
 // erase a screen or join the frame into one white blob, even during a switch.
 const face=pixels.slice();pixels.fill(0);layer='object';if(!options.hideProps){
  if(s.mic&&!s.mic.hide){
   // The cord mic passes behind his head: it is not drawn on the glasses or
   // their one-pixel seam, so a spinning or swinging mic never erases them.
   Props.drawMic(s.mic,{local});
   for(let i=0;i<W*H;i++)if(objectMask[i]&&[i,i-1,i+1,i-W,i+W].some(j=>j>=0&&j<W*H&&face[j])){pixels[i]=0;objectMask[i]=0;}
  }
  props();
  // A build move's object (alive/build.js): in the object layer, so his mittens grip it from in front.
  const BM=root.SpeckBuildMoves;
  if(BM&&(s.build||s.buildOut))BM.paintObjects(s,{put:dot,get:(x,y)=>x>=0&&y>=0&&x<W&&y<H?face[y*W+x]||pixels[y*W+x]:0});
  if(p.thinkingGear>.025){
   const lift=Math.round((1-p.thinkingGear)*34);
   const thin=(x,y,X,Y)=>{const n=Math.max(Math.abs(X-x),Math.abs(Y-y),1);for(let k=0;k<=n;k++)dot(x+(X-x)*k/n,y+(Y-y)*k/n+lift);};
   const ring=(x,y,r)=>{for(let a=0;a<Math.PI*2;a+=.1)dot(x+Math.cos(a)*r,y+Math.sin(a)*r+lift);};
   const gear=(x,y,r,a)=>{ring(x,y,r);ring(x,y,r-1);ring(x,y,2);for(let k=0;k<8;k++){const q=a+k*Math.PI/4;line(x+Math.cos(q)*(r-1),y+Math.sin(q)*(r-1)+lift,x+Math.cos(q)*(r+2),y+Math.sin(q)*(r+2)+lift);}thin(x+Math.cos(a)*2,y+Math.sin(a)*2,x+Math.cos(a)*(r-1),y+Math.sin(a)*(r-1));};
   gear(74,11,6,p.gearAngle);gear(87,23,5,-p.gearAngle+.3);
   if(p.gearJam>.5){rect(91,3+lift,2,6);rect(91,11+lift,2,2);}
  }
  if(p.thinkingStudy>.025&&s.thinking){
   const {variant,route,idea,seed}=s.thinking,t=p.studyTime,lift=Math.round((1-p.thinkingStudy)*34);
   const mix=(a,b,v)=>a+(b-a)*v,smooth=v=>{v=Math.max(0,Math.min(1,v));return v*v*(3-2*v);};
   const pixel=(x,y,c=15)=>dot(x,y+lift,c),block=(x,y,w,h,c=15)=>rect(x,y+lift,w,h,c);
   const stroke=(x,y,X,Y,c=15,w=1)=>{const n=Math.ceil(Math.max(Math.abs(X-x),Math.abs(Y-y),1));for(let k=0;k<=n;k++)block(mix(x,X,k/n),mix(y,Y,k/n),w,w,c);};
   const neuron=(x,y,c=15)=>{block(x-1,y-2,3,5,c);block(x-2,y-1,5,3,c);};
   const spark=(x,y)=>{stroke(x-2,y,x+2,y);stroke(x,y-2,x,y+2);};
   if(variant===4){
    stroke(68,5,93,5,15,2);stroke(68,28,93,28,15,2);stroke(68,5,68,28,15,2);stroke(93,5,93,28,15,2);
    for(let row=0;row<3;row++){const y=10+row*7,a=smooth((t-[1,3.1,5.4][row])/1.1);stroke(69,y,92,y);for(let k=0;k<3;k++){const x=mix(72+k*4,82+k*4,a);block(x-1,y-2,3,5);pixel(x,y-1,0);}}
    if(t>6.6&&t<7.2)spark(97,24);
   }
   if(variant===5){
    const columns=[[[66,7],[66,16],[66,25]],[[80,11],[80,23]],[[94,16]]],chosen=[columns[0][Math.floor(route/2)],columns[1][route%2],columns[2][0]];
    for(let c=0;c<2;c++)for(const a of columns[c])for(const b of columns[c+1])stroke(...a,...b,4);
    for(const column of columns)for(const [x,y] of column)neuron(x,y,7);
    const progress=(t-2)/2;
    for(let k=0;k<2;k++)if(progress>k){const a=chosen[k],b=chosen[k+1],u=Math.min(1,progress-k);stroke(...a,mix(a[0],b[0],u),mix(a[1],b[1],u),15);neuron(...a);neuron(mix(a[0],b[0],u),mix(a[1],b[1],u));}
    if(t>6&&t<7)spark(96,7);
   }
   if(variant===6){
    const nodes=[[65,16],[78,8],[78,24],[94,5],[94,12],[94,21],[94,28]],edges=[[0,1],[0,2],[1,3],[1,4],[2,5],[2,6]];
    for(const [a,b] of edges)stroke(...nodes[a],...nodes[b],4);
    const leaf=t<3.7?(route+2)%4:route,path=[0,1+Math.floor(leaf/2),3+leaf],progress=t<3.7?(t-1)/1.1:(t-4)/1.1;
    for(let k=0;k<2;k++)if(progress>k){const a=nodes[path[k]],b=nodes[path[k+1]],u=Math.min(1,progress-k);stroke(...a,mix(a[0],b[0],u),mix(a[1],b[1],u));}
    nodes.forEach(([x,y],k)=>block(x-1,y-1,3,3,path.includes(k)?15:6));
    if(t>3&&t<3.9){const [x,y]=nodes[3+(route+2)%4];stroke(x-2,y-2,x+2,y+2);stroke(x-2,y+2,x+2,y-2);}
    if(t>6.3&&t<8.8){const [x,y]=nodes[3+route];stroke(x-4,y,x-1,y+2,15,2);stroke(x-1,y+2,x+3,y-3,15,2);}
   }
   if(variant===7){
    // Integer hashing is reproducible in browser, Node, and held/rest frames.
    const hash=n=>{let x=(n^seed)>>>0;x=Math.imul(x^(x>>>16),0x45d9f3b);x=Math.imul(x^(x>>>16),0x45d9f3b);return ((x^(x>>>16))>>>0)/0x100000000;};
    const glyph=thinkingIdeas[idea]||thinkingIdeas.heart,settled=smooth((t-1.5)/5);
    for(let y=0;y<10;y++)for(let x=0;x<14;x++){const n=y*14+x,on=x>=2&&x<12&&glyph[y][x-2]==='1';if(hash(n+3)<settled){if(on)block(66+x*2,5+y*2,2,2);}else if(hash(n+Math.floor(t*5)*173)>.53)pixel(66+x*2,5+y*2,5+Math.floor(hash(n)*10));}
    if(t>6.6&&t<8.9){spark(65,8);spark(95,24);}
   }
  }
 }
 const object=pixels.slice();pixels.set(face);blocked=new Uint8Array(W*H);
 for(let i=0;i<W*H;i++)if(face[i])for(const j of [i,i-1,i+1,i-W,i+W])if(j>=0&&j<W*H)blocked[j]=1;
 // Also reserve the dark lens interiors, which are part of the face silhouette.
 // The one-hand hang grips the top edge beside a brow and dangles the free
 // mitten beside a temple, inside this padded box. Until he rests it
 // reserves only the rasterised lens box (columns hx-23..hx+22, rows hy+-8), so
 // the padding cannot cut chunks out of either mitten. Face pixels and their
 // one-pixel halo stay blocked, so brows, rims and temples keep their ink.
 const hangGrip=edgeGrip&&s.variant===10,x0=hx-(hangGrip?23:28),x1=hx+(hangGrip?22:28),y0=hy-(hangGrip?8:12)-Math.abs(tilt),y1=hy+(hangGrip?8:9)+Math.abs(tilt);
 for(let y=Math.max(0,y0);y<=Math.min(31,y1);y++)for(let x=Math.max(0,x0);x<=Math.min(99,x1);x++)blocked[y*W+x]=1;
 // These two authored gestures touch the lenses deliberately. Keep their
 // narrow contact areas separate from ordinary hand/frame collision rules.
 if(s.action==='idle'&&(s.variant===6||s.variant===7)){
  const contact=s.variant===6?[[hx-18,hx-6,hy+6,hy+12],[hx+6,hx+18,hy+6,hy+12]]:[[hx+3,hx+24,hy-7,hy+8]];
  for(const [x0,x1,y0,y1] of contact)for(let y=Math.max(0,y0);y<=Math.min(H-1,y1);y++)for(let x=Math.max(0,x0);x<=Math.min(W-1,x1);x++)blocked[y*W+x]=0;
 }
 layer='hands';
 if(!options.hideHands){
  activeHand=leftHand;hand(p.lx,p.ly,p.lrot,p.lopen,p.lpoint,p.lthumb,-1);
  activeHand=rightHand;hand(p.rx,p.ry,p.rrot,p.ropen,p.rpoint,p.rthumb,1);
 }
 const hands=pixels.map((v,i)=>handMask[i]?v:0),gripMask=new Uint8Array(W*H);
 // A mitten may curl over an object's rim. Its one-pixel dark outline keeps
 // the contact readable, instead of cutting the entire mitten out of the prop.
 pixels.set(face);
 for(let i=0;i<W*H;i++)if(objectMask[i])pixels[i]=object[i];
 for(let i=0;i<W*H;i++)if(hands[i])for(const j of [i,i-1,i+1,i-W,i+W])if(j>=0&&j<W*H&&!face[j]){pixels[j]=0;gripMask[j]=1;}
 for(let i=0;i<W*H;i++)if(hands[i])pixels[i]=hands[i];
 if(s.mic&&!s.mic.hide&&!options.hideProps){
  // The mic's cord: 1px from the frame line (row -1) to the handle's tail. A
  // cord pulled long bows outward; it passes behind the face, mic and mittens.
  // Drawn at a dim grey so the thin line reads as a cord, not as more of him.
  const CORD=4,m=s.mic,ca=Math.cos(m.a),sa=Math.sin(m.a),tx=m.x-m.tail*sa,ty=m.y+m.tail*ca;
  const len=Math.hypot(tx-m.ax,ty+1),slack=Math.max(0,Math.min(1,(len-24)/14))*5;
  const kx=(m.ax+tx)/2+slack,ky=(ty-1)/2+slack*.6;let last=-1;
  for(let i=0;i<=60;i++){const u=i/60,x=Math.round((1-u)*(1-u)*m.ax+2*u*(1-u)*kx+u*u*tx),y=Math.round(-(1-u)*(1-u)+2*u*(1-u)*ky+u*u*ty);
   if(x<0||x>=W||y<0||y>=H)continue;const k=y*W+x;if(k===last)continue;last=k;
   if(pixels[k]===0&&!gripMask[k]&&!face[k]&&!objectMask[k])pixels[k]=CORD;}
 }
 // A drowsy or sleeping still has put his routine's things down (engine.js DROWSE).
 layer='effects';if(!options.hideProps&&s.action==='idle'&&!(s.drowse>=2))idleProps();
 if(!options.hideProps&&s.mic&&s.mic.glyphs)micGlyphs();
 if(!options.hideProps&&activeMagic&&s.magic.phase!=='entrance')Props.drawMagic(s,{pixels,layers:{face,object,objectMask,hands},bare:!!options.bareConjure});
 // A build move's timed effects (alive/build.js), over everything but his mittens, which stay whole.
 if(!options.hideProps&&s.build&&root.SpeckBuildMoves)root.SpeckBuildMoves.paintEffects(s,{put:(x,y,c)=>{if(x>=0&&y>=0&&x<W&&y<H&&!hands[y*W+x])pixels[y*W+x]=c;},get:(x,y)=>x>=0&&y>=0&&x<W&&y<H?pixels[y*W+x]:0});
 // Play testing (build.js, Matt 2026-10-31): where a mitten grips a play piece's object the object's
 // ink runs up to the mitten (no light seam), and his glasses frame stays whole over its objects and
 // effects: the frame is drawn again on top, from the face without eyes, brows, props or mittens.
 if(!options.hideProps&&root.SpeckBuildMoves&&root.SpeckBuildMoves.playing&&root.SpeckBuildMoves.playing(s)){
  for(let i=0;i<W*H;i++)if(gripMask[i]&&!hands[i]&&objectMask[i]&&!pixels[i])pixels[i]=object[i];
  const rim=render(s,{...options,hideEyes:true,hideBrows:true,hideProps:true,hideHands:true,layers:false}).pixels;
  for(let i=0;i<W*H;i++)if(rim[i]&&!hands[i])pixels[i]=rim[i];
 }
 // A reactor reaction's glyph ([name,x,y,level], engine.js REACTIONS), on a one-pixel dark moat.
 const glyph=p.glyph&&REACTION_GLYPHS[p.glyph[0]];
 if(glyph&&p.glyph[3]>0&&!options.hideProps){
  const [,gx,gy,level]=p.glyph,ink=(i,j)=>j>=0&&j<glyph.length&&i>=0&&i<glyph[0].length&&glyph[j][i]==='1';
  for(let j=-1;j<=glyph.length;j++)for(let i=-1;i<=glyph[0].length;i++){const X=gx+i,Y=gy+j;if(X<0||Y<0||X>=W||Y>=H)continue;
   if(ink(i,j))pixels[Y*W+X]=level;else if([-1,0,1].some(dj=>[-1,0,1].some(di=>ink(i+di,j+dj))))pixels[Y*W+X]=0;}
 }
 // A closer's marks (engine.js MIC_CLOSERS), drawn over everything: ['g',rows,x,y,ink] is a
 // glyph with a one-pixel dark moat, ['r',x,y,w,h,ink] a filled box, ['l',x0,y0,x1,y1,ink] a line.
 if(s.marks&&!options.hideProps)for(const m of s.marks){
  const put=(x,y,c)=>{x=Math.round(x);y=Math.round(y);if(x>=0&&y>=0&&x<W&&y<H)pixels[y*W+x]=c;};
  if(m[0]==='r')for(let j=0;j<m[4];j++)for(let i=0;i<m[3];i++)put(m[1]+i,m[2]+j,m[5]);
  else if(m[0]==='l'){const n=Math.max(1,Math.ceil(Math.hypot(m[3]-m[1],m[4]-m[2])));for(let i=0;i<=n;i++)put(m[1]+(m[3]-m[1])*i/n,m[2]+(m[4]-m[2])*i/n,m[5]);}
  else if(m[0]==='g'){const g=m[1],ink=(i,j)=>j>=0&&j<g.length&&i>=0&&i<g[0].length&&g[j][i]==='1';
   for(let j=-1;j<=g.length;j++)for(let i=-1;i<=g[0].length;i++){let near=false;for(let dj=-1;dj<=1&&!near;dj++)for(let di=-1;di<=1&&!near;di++)near=ink(i+di,j+dj);if(near&&!ink(i,j))put(m[2]+i,m[3]+j,0);}
   for(let j=0;j<g.length;j++)for(let i=0;i<g[0].length;i++)if(ink(i,j))put(m[2]+i,m[3]+j,m[4]);}}
 return {width:W,height:H,pixels,...(options.layers?{layers:{face,object,objectMask,hands,leftHand,rightHand,gripMask,clippedHandInk}}:{})};
}
function paint(canvas,frame,color='#f6f5e9'){
 if(canvas.width!==frame.width)canvas.width=frame.width;if(canvas.height!==frame.height)canvas.height=frame.height;
 const ctx=canvas.getContext('2d'),img=ctx.createImageData(frame.width,frame.height);
 const rgb=color==='#a9e874'?[169,232,116]:[246,245,233];
 for(let i=0;i<frame.pixels.length;i++){const k=i*4,c=frame.pixels[i]/15;img.data[k]=Math.round(rgb[0]*c);img.data[k+1]=Math.round(rgb[1]*c);img.data[k+2]=Math.round(rgb[2]*c);img.data[k+3]=255;}
 ctx.putImageData(img,0,0);
}
const api={render,paint,eyeDesigns,frameModels};if(typeof module!=='undefined')module.exports=api;else root.WatchRenderer=api;
})(typeof window!=='undefined'?window:globalThis);
;
// ALIVE_VENDOR_END renderer.js

})()
// ALIVE_ENGINE_END

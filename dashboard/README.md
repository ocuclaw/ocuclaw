# OcuClaw dashboard

P13 rejected: this tab is a hand-authored IIFE in ES5, using only Hermes
dashboard SDK globals. It has no frontend build step or additional toolchain.

The page remains read-only. Its one authenticated `SDK.fetchJSON` GET never
starts a probe or pairing. The same backend now also serves the authenticated
Hermes Desktop runtime presenter during a host-owned setup ceremony; it keeps
the Relay Credential, exchange control secret, and callback token server-side.
The backend imports shared bundle modules, never `adapter.py`.

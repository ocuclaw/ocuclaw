const { CONDENSED, FRIENDLY_TITLES } = require("./model.cjs");

const OPENCLAW_ONLY                       = (
  [

    [String.raw`^OcuClaw needs to read and write the attached conversation$`, "I need to read and write this chat,"],
    [String.raw`^for glasses replies and voice input\.$`, "so your glasses can show replies and hear you."],
    [String.raw`^Other conversations and credentials are excluded\.$`, "Nothing else: no other chats, no passwords."],
    [String.raw`^Run again with --details.*$`, null],

    [String.raw`^Checking that OcuClaw is loaded\.\.\.$`, "Checking that OcuClaw is loaded…"],
    [String.raw`^Still checking\. This can take up to 8 minutes\.$`, "Still checking. Up to 8 minutes…"],
    [String.raw`^Still checking that OcuClaw is loaded \(.+ so far\)\.$`, null],

    [String.raw`^Checking Tailscale\.\.\.$`, "Checking Tailscale…"],
    [String.raw`^Installing Tailscale\.\.\.$`, "Installing Tailscale…"],

    [String.raw`^Getting the approval link from Tailscale\.\.\.$`, "Getting a link from Tailscale…"],
    [String.raw`^No Tailscale on your phone\? Install it from the App Store or Google Play and sign in first\.$`, "Tailscale creates a private link between me and your glasses."],
    [String.raw`^On your phone, sign in to Tailscale\. Open this link to approve this server:$`, "Open the link below, log in and approve this server."],

    [String.raw`^Checking the private route\.\.\.$`, "Checking the private route…"],
    [String.raw`^If you say yes, setup will run:$`, "One private route so your phone can reach OcuClaw."],
    [String.raw`^\S*tailscale\b.* serve .*$`, null],
    [String.raw`^tcp://\S+$`, null],

    [String.raw`^\S*tailscale\b.*\\$`, null],
    [String.raw`^(?:serve|--\S+)(?: \S+)*$`, null],
    [String.raw`^Anything but yes leaves this route unchanged\.$`, null],
    [String.raw`^Still waiting for the certificate \((.+) so far\)\.$`, String.raw`Waiting for its certificate, \1 so far…`],

    [String.raw`^Checking for your phone\.\.\.$`, "Checking for your phone…"],
    [String.raw`^Open Even > OcuClaw on your phone\.$`, "On your phone open Even › OcuClaw."],

    [String.raw`^In OcuClaw tap Pair with your agent > Pair manually, then press Enter to show the code\.$`, "Tap Pair with your agent › Pair manually, then press Enter."],

    [String.raw`^Pair your phone$`, null],
    [String.raw`^Keep the pairing code and words private\..*$`, null],
    [String.raw`^It shows a phone code\.$`, "It shows a phone code."],
    [String.raw`^Paste or type the phone code here:$`, "Paste or type the phone code here:"],
    [String.raw`^For manual pairing, type m\.$`, "For manual pairing, type m."],
    [String.raw`^Sent to your phone\.$`, "Sent to your phone."],
    [String.raw`^In OcuClaw tap Pair with your agent\.$`, "In OcuClaw tap Pair with your agent."],
    [String.raw`^In OcuClaw tap Pair with your agent, then type the phone code it shows:$`, "In OcuClaw tap Pair with your agent, then type the phone code it shows:"],
    [String.raw`^Check the four words on your glasses$`, "Check the four words on your glasses"],
    [String.raw`^or in OcuClaw\. They should match the$`, "or in OcuClaw. They should match the"],
    [String.raw`^words that appear here\.$`, "words that appear here."],
    [String.raw`^Phone codes aren't working right now, so here's manual pairing\.$`, "Phone codes aren't working right now, so here's manual pairing."],
    [String.raw`^No phone is waiting with that code\. Check the code in OcuClaw\. If it ran out, tap Get a new code there\.$`, "No phone is waiting with that code. Check the code in OcuClaw. If it ran out, tap Get a new code there."],
    [String.raw`^([0-9]+) (tries|try) left\.$`, String.raw`\1 \2 left.`],
    [String.raw`^That's the pairing code, which goes into the phone\. Here, type the 6-digit phone code that OcuClaw shows\.$`, "That's the pairing code, which goes into the phone. Here, type the 6-digit phone code that OcuClaw shows."],
    [String.raw`^In OcuClaw tap Pair with your agent.*$`, null],
    [String.raw`^Waiting for the phone\. Ctrl-C cancels\.$`, null],
    [String.raw`^Phone: .*$`, null],
    [String.raw`^Check these words match your phone, in this order:$`, null],
    [String.raw`^[┌└+][─-]+[┐┘+]$`, null],
    [String.raw`^[│|].*[│|]$`, null],
    [String.raw`^If they differ, refuse\.$`, null],
    [String.raw`^Type approve, refuse, or cancel:.*$`, null],
    [String.raw`^Not approved\. Type approve, refuse, or cancel:.*$`, "Not approved yet. Type approve, refuse or cancel."],
    [String.raw`^Approved\. Waiting for your phone to connect\.$`, "Approved. Waiting for your phone to connect…"],

    [String.raw`^Waiting for the reply on your glasses\.\.\.$`, "Waiting for the reply…"],
    [String.raw`^Waiting for the phone reply \((.+) so far\)\.$`, String.raw`Waiting for the reply, \1 so far…`],
    [String.raw`^OcuClaw Setup Completion is recorded: .*$`, "Setup is complete."],

    [String.raw`^Code: [a-z-]+$`, null],
  ]
).map(([pattern, short])            => [new RegExp(pattern), short]);

const OPENCLAW_TITLES                                   = {
  ...FRIENDLY_TITLES,
  2: "Access for your glasses",
};

const OPENCLAW_LANDED                                   = {
  2: /applied|granted/,
  3: /ready/,
  4: /running|started/,
  5: /approved|^Tailscale added -[0-9]+ /,
  6: /Certificate ready|already configured/,
};

const OPENCLAW_WORDING          = {
  condensed: [...OPENCLAW_ONLY, ...CONDENSED],
  titles: OPENCLAW_TITLES,

  resumed: [],
  landed: OPENCLAW_LANDED,
  busyByWords: true,

  clickHint: "Ctrl/Cmd + click  ",

  compactLinkHint: "Ctrl/Cmd + click it. On a phone, type it into a new tab:",
};

module.exports = { OPENCLAW_TITLES, OPENCLAW_LANDED, OPENCLAW_WORDING };

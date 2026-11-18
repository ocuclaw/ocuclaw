const process = require("node:process");
const { openLook } = require("./live.cjs");

const DEMO_ORIGIN = "https://openclaw-1234567-8901.cloudwaysagents.com";

function demoScript(part         = "all")             {
  const a             = [
    ["say", "[1/8] Cloudways host"],
    ["say", "  openclaw-1234567-8901 is a Cloudways Managed AI Agents container."],
    ["say", "  Checking the model sign-in..."],
    ["wait", 1.0],
    ["say", ""],
    ["say", "[2/8] Settings"],
    ["ask", "Continue your Desktop and terminal chats on your glasses? Type yes or no: "],
    ["say", "  Glasses settings applied."],
    ["say", ""],
    ["say", "[3/8] OcuClaw"],
    ["say", "  OcuClaw is installed. One restart of your agent loads it."],
    ["say", "  1  This page disconnects for about a minute while your agent restarts."],
    ["say", "  2  Then open the link shown below and send /terminal."],
    ["say", "  3  Setup carries on by itself."],
    ["say", "  If it drops again soon after, open the link again."],
    ["ask", "Restart now? Type yes to continue, anything else stops: "],
    ["say", "  Restarting your agent. This page disconnects in a few seconds."],
    ["say", "  In about a minute, open this link. Not loaded yet? Refresh it."],
    ["say", `  ${DEMO_ORIGIN}/?q=/terminal`],
    ["say", "  Wait until /terminal shows in the box, then send it. Setup carries on by itself."],
    ["wait", 6.0],
  ];
  const b             = [
    ["say", "[1/8] Cloudways host"],
    ["say", "  openclaw-1234567-8901 is a Cloudways Managed AI Agents container."],
    ["say", "  Checking the model sign-in..."],
    ["wait", 1.0],
    ["say", ""],
    ["say", "[2/8] Settings"],
    ["say", "  Settings already applied."],
    ["say", ""],
    ["say", "[3/8] OcuClaw"],
    ["say", "  OcuClaw is loaded and ready."],
    ["say", ""],
    ["say", "[4/8] Tailscale"],
    ["say", "  Checking Tailscale..."],
    ["wait", 1.0],
    ["say", "  Installing Tailscale..."],
    ["wait", 2.5],
    ["say", "  Tailscale 1.102.4 installed."],
    ["say", "  Tailscale is running."],
    ["say", ""],
    ["say", "[5/8] Connect to Tailscale"],
    ["say", "  This server is already approved."],
    ["say", ""],
    ["say", "[6/8] Private route for your phone"],
    ["say", "  Allow access from your tailnet only. Never public; never Tailscale Funnel."],
    ["say", "  Setup will add one private route so your phone can reach OcuClaw."],
    ["say", "  Run setup with --details to see the exact command first."],
    ["ask", "Apply route? Type the full word yes; anything else stops: "],
    ["say", "  Private route configured."],
    ["say", "  Waiting for the certificate. This usually takes a minute or two."],
    ["wait", 2.5],
    ["say", "  Certificate ready."],
    ["say", "  The private route is published and answering."],
    ["say", ""],
    ["say", "[7/8] Pair your phone"],
    ["say", "  Private route ready for pairing."],
    ["say", "  Phone found on your Tailscale network."],
    ["say", "Open Even > OcuClaw on your phone and tap the Pair button."],
    ["say", "Then press Enter to show the code."],
    ["ask", ""],
    ["say", "Manual pairing"],
    ["say", "In OcuClaw tap Pair with your agent > Pair manually, then type:"],
    ["say", "  Address:      wss://ocuclaw-openclaw.your-tailnet.ts.net:8446"],
    ["say", "  Pairing code: 9N8C-JWD3"],
    ["say", "Expires in 5:00."],
    ["wait", 5.0],
    ["say", "  Paired. Your phone is connected."],
    ["say", ""],
    ["say", "[8/8] Your first message"],
    ["say", ""],
    ["say", "In the paired conversation on your phone, send hello."],
    ["say", "Waiting for the reply on your glasses…"],
    ["wait", 3.0],
    ["say", "Your phone reported SDK acceptance of the reply."],
    ["say", "Double-tap the welcome on your glasses to finish."],
    ["say", "OcuClaw setup is complete for this OpenClaw agent."],
  ];
  if (part === "a") return a;
  if (part === "b") return b;
  return [...a, ["drop", null], ...b];
}

function readLine(input     )                  {
  return new Promise((resolve) => {
    let got = "";
    let settled = false;
    const done = (line        ) => {
      if (settled) return;
      settled = true;
      input.off("data", onData);
      input.off("end", onEnd);
      try { input.pause(); } catch (_) {  }
      resolve(line);
    };
    const onData = (chunk         ) => {
      got += String(chunk);
      const end = got.indexOf("\n");
      if (end >= 0) done(got.slice(0, end + 1));
    };
    const onEnd = () => done(got);
    try {
      if (typeof input.setEncoding === "function") input.setEncoding("utf8");
      input.on("data", onData);
      input.on("end", onEnd);
      input.resume();
    } catch (_) {
      done("");
    }
  });
}

function pause(seconds        )                {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, seconds) * 1000));
}

async function runDemo(name        , streamIn     , streamOut     , options              = {})                  {
  const { speed = 1.0, part = "all", ...look } = options;
  const env = look.env ?? process.env;
  const code = 0;
  let opened                  = await openLook(name, streamIn, streamOut, { ...look, env, resumed: part === "b" });
  try {
    for (const [kind, value] of demoScript(part)) {
      const out = opened ? opened.stdout : streamOut;
      const inp = opened ? opened.stdin : streamIn;
      if (kind === "say") {
        out.write(`${value}\n`);
      } else if (kind === "wait") {
        await pause(Number(value) / speed);
      } else if (kind === "ask") {
        out.write(value);
        await readLine(inp);
        out.write("\n");
      } else if (kind === "drop") {

        if (opened) await opened.close(1);
        streamOut.write("\u001b[2J\u001b[H");
        opened = await openLook(name, streamIn, streamOut, { ...look, env, resumed: true });
      }
    }
  } finally {

    if (opened) await opened.close(code);
  }
  return code;
}

module.exports = { DEMO_ORIGIN, demoScript, runDemo };

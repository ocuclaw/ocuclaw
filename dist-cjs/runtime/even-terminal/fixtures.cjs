const FIXTURE_CWD = "/tmp/even-terminal-fixture-project";

const FIXTURE_SESSIONS = [
  { provider: "claude", id: "sess-claude-1", title: "refactor auth", updatedAt: 1_700_000_000_000, cwd: FIXTURE_CWD },
  { provider: "codex", id: "sess-codex-1", title: "fix flaky test", updatedAt: 1_700_000_100_000, cwd: FIXTURE_CWD },
];

function deltas(text) {

  const parts = text.match(/.{1,8}/g) ?? [text];
  return parts.map((t) => ({ type: "text_delta", text: t }));
}

function claudeTextTurn(sessionId) {
  const body = "Done. Updated the handler and added a test.";
  return [
    { type: "status", state: "busy", sessionId },
    { type: "user_prompt", text: "update the handler" },
    { type: "status", state: "text_start", sessionId },
    ...deltas(body),
    { type: "status", state: "text_end", sessionId },
    {
      type: "result",
      success: true,
      text: body,
      sessionId,
      costUsd: 0.012,
      provider: "claude",
      turns: 1,
      durationMs: 4200,
      inputTokens: 1200,
      outputTokens: 80,
    },
    { type: "status", state: "idle", sessionId },
  ];
}

function codexTextTurn(sessionId) {
  const body = "Reproduced the flake and pinned the seed.";
  return [
    { type: "status", state: "busy", sessionId, provider: "codex" },
    { type: "status", state: "text_start", sessionId, provider: "codex" },
    ...deltas(body),
    { type: "status", state: "text_end", sessionId, provider: "codex" },

    {
      type: "result",
      success: true,
      text: body,
      sessionId,
      costUsd: 0,
      provider: "codex",
      turns: 1,
      durationMs: 5300,
      inputTokens: 1500,
      outputTokens: 64,
    },
    { type: "status", state: "idle", sessionId, provider: "codex" },
  ];
}

function claudePermissionTurn(sessionId) {
  return [
    { type: "status", state: "busy", sessionId },
    { type: "tool_start", name: "Bash", toolId: "tool-1" },
    {
      type: "permission_request",
      toolName: "Bash",
      description: "Run: npm test",
      detail: "npm test",
      toolUseId: "tool-1",
      options: [
        { text: "Allow", key: "allow" },
        { text: "Allow always", key: "allowAlways" },
        { text: "Deny", key: "deny" },
      ],
      suggestions: null,
    },
  ];
}

function claudeQuestionTurn(sessionId) {
  return [
    { type: "status", state: "busy", sessionId },
    {
      type: "user_question",
      questions: [
        {
          question: "Which database?",
          header: "DB choice",
          options: [
            { label: "Postgres", description: "relational", preview: "" },
            { label: "SQLite", description: "embedded", preview: "" },
          ],
        },
      ],
      toolUseId: "tool-q1",
    },
  ];
}

module.exports = { FIXTURE_SESSIONS, claudeTextTurn, codexTextTurn, claudePermissionTurn, claudeQuestionTurn };

const VIDEO_FAIL_DETAIL                                  = {
  bot_check: "YouTube refused this server",
  private: "video is private",
  unavailable: "video unavailable",
  sign_in: "site needs a sign-in",
  unsupported: "site not supported",
  no_stream: "no playable stream",
  ytdlp_missing: "yt-dlp missing",
  ytdlp_old: "yt-dlp outdated",
  ffmpeg_missing: "ffmpeg missing",
  read_failed: "video read failed",
};

const DETAILS = new Set(Object.values(VIDEO_FAIL_DETAIL));

function isVideoFailDetail(detail        )          {
  return DETAILS.has(detail);
}

function isVideoToolReason(reason                                    )          {
  return reason === "ytdlp_missing" || reason === "ffmpeg_missing";
}

const PATTERNS                                   = [
  ["bot_check", /not a bot/i],
  ["private", /private video|video is private/i],
  ["sign_in", /sign in to confirm your age|age[- ]restrict|members[- ]only|join this channel|login required|requires? (authentication|login)|--cookies/i],
  ["unsupported", /unsupported url/i],
  ["no_stream", /requested format is not available|no video formats found/i],
  ["unavailable", /video unavailable|has been removed|no longer available|not available in your country|geo.?restrict|HTTP Error 404/i],
];

function videoReadReason(text        )                  {
  for (const [reason, re] of PATTERNS) if (re.test(text)) return reason;
  return "read_failed";
}

function videoPageReason(page                                                        )                  {
  if (page.code === "video_needs_ytdlp") return "ytdlp_missing";
  if (page.code === "video_no_stream") return "no_stream";
  const reason = videoReadReason(page.error || "");
  return reason === "read_failed" && page.ytdlpStale ? "ytdlp_old" : reason;
}

function videoFailReasonOf(detail        )                         {
  for (const [reason, text] of Object.entries(VIDEO_FAIL_DETAIL)) if (text === detail) return reason                   ;
  return null;
}

module.exports = { VIDEO_FAIL_DETAIL, isVideoFailDetail, isVideoToolReason, videoReadReason, videoPageReason, videoFailReasonOf };

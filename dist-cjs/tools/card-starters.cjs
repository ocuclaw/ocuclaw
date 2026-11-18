const CARD_STARTER_LOCALES = Object.freeze(["en", "ja", "ko", "zh-CN", "zh-TW"]         );

const COMMON = `const KEYS = Object.keys(LABELS);
const at2 = ms => { const d = new Date(ms); return d.getHours() + ":" + String(d.getMinutes()).padStart(2, "0"); };
const listOf = v => Array.isArray(v) ? v : [];
const said = v => typeof v === "string" && v.trim() ? v.trim() : "";
const row = (text, gray = 15) => note(fit(text, 260), { gray });
const head = text => label(text);
const update = (s, e) => e.type !== "data" ? s : {
  values: { ...s.values, ...(e.name === "task" ? e.value : { [e.name]: e.value }) },
  at: e.at ?? s.at, source: e.source ?? s.source, fixes: e.name === "task" ? e.fixes ?? null : s.fixes,
};
// Where a value goes: the phone's "Couldn't check <value> · last 07:30" row (ui.unchecked), over two
// lines of its column (w px) when it needs them, else null when the value was checked.
const goneOf = (s, ctx) => (key, w = 260) => {
  const entry = ctx.task?.unchecked?.[key];
  const line = unchecked(entry) ? entry.line : (s.values || {})[key] === null ? WORDS.couldnt + " " + LABELS[key] : "";
  return line ? note(fit(line, w, { lines: 2 }), { lines: 2 }) : null;
};
const statusOf = s => s.at ? (s.source === "test" ? WORDS.fromTest + " · " : "") + at2(s.at) : "";
`;

const MY_MORNING_CODE = `const { page, cols, rows, note, label, taskLine, unchecked, taskState, fit, more } = ui;
const LABELS = { meetings: "Meetings", calendar_connected: "Calendar", weather: "Weather", urgent: "Urgent" };
${COMMON}
return {
  init: () => ({ values: null, at: null, source: null, fixes: null }),
  update,
  view: (s, ctx) => {
    const v = s.values || {};
    const gone = goneOf(s, ctx);
    // Meetings in time order. "No calendar connected" is not "No meetings today".
    const day = () => {
      if (v.calendar_connected === false) return [head(WORDS.meetings), row(WORDS.noCalendar, 12)];
      const list = more(listOf(v.meetings), 3, s.fixes?.meetings);
      const shown = list.shown.map((m, i) => row((said(m?.time) ? said(m.time) + " " : "") + (said(m?.title) || "--")
        + (said(m?.where) ? ", " + said(m.where) : ""), i ? 12 : 15));
      const calendar = gone("calendar_connected");
      return [head(WORDS.meetings), calendar, ...(gone("meetings") ? [gone("meetings")]
        : shown.length ? [...shown, list.row] : calendar ? [] : [row(WORDS.noMeetings, 12)])];
    };
    const side = () => {
      const urgent = more(listOf(v.urgent).filter(said), 2, s.fixes?.urgent);
      return [head(WORDS.weather), gone("weather") ?? row(said(v.weather) || "--"),
        head(WORDS.urgent), ...(gone("urgent") ? [gone("urgent")] : urgent.shown.length
          ? [...urgent.shown.map(u => row(said(u))), urgent.row] : [row(WORDS.noUrgent, 12)])];
    };
    const both = () => [cols([rows(day().filter(Boolean)), rows(side().filter(Boolean))])];
    const views = {
      waiting: [note(WORDS.waiting)],
      unchecked: KEYS.map(key => gone(key, 540)),
      empty: [...both(), note(WORDS.nothing, { gray: 12 })],
      ok: both(),
    };
    return page({ title: WORDS.name, status: statusOf(s), body: [taskLine(ctx), ...views[taskState(s.values)]].filter(Boolean) }, ctx);
  },
};`;

const MY_EVENING_CODE = `const { page, cols, rows, note, label, taskLine, unchecked, taskState, fit, more } = ui;
const LABELS = { still_open: "Still open", tomorrow: "Tomorrow", calendar_connected: "Calendar", prepare_tonight: "Tonight" };
${COMMON}
return {
  init: () => ({ values: null, at: null, source: null, fixes: null }),
  update,
  view: (s, ctx) => {
    const v = s.values || {};
    const gone = goneOf(s, ctx);
    const open = () => {
      const list = more(listOf(v.still_open).filter(said), 3, s.fixes?.still_open);
      return [head(WORDS.open), ...(gone("still_open") ? [gone("still_open")] : list.shown.length
        ? [...list.shown.map(t => row(said(t))), list.row] : [row(WORDS.allDone, 12)])];
    };
    // Tomorrow's first commitments in time order. "No calendar connected" is not "Nothing booked".
    const tomorrow = () => {
      if (v.calendar_connected === false) return [head(WORDS.tomorrow), row(WORDS.noCalendar, 12)];
      const list = more(listOf(v.tomorrow), 2, s.fixes?.tomorrow);
      const shown = list.shown.map((m, i) => row((said(m?.time) ? said(m.time) + " " : "") + (said(m?.title) || "--"), i ? 12 : 15));
      const calendar = gone("calendar_connected");
      return [head(WORDS.tomorrow), calendar, ...(gone("tomorrow") ? [gone("tomorrow")]
        : shown.length ? [...shown, list.row] : calendar ? [] : [row(WORDS.nothingTomorrow, 12)])];
    };
    // The Tonight line: anything to prepare tonight, across the page.
    const tonight = () => gone("prepare_tonight", 540)
      ?? (said(v.prepare_tonight) ? note(fit(WORDS.tonight + ": " + said(v.prepare_tonight), 540)) : null);
    const all = () => [cols([rows(open().filter(Boolean)), rows(tomorrow().filter(Boolean))]), tonight()];
    const views = {
      waiting: [note(WORDS.waiting)],
      unchecked: KEYS.map(key => gone(key, 540)),
      empty: [...all(), note(WORDS.nothing, { gray: 12 })],
      ok: all(),
    };
    return page({ title: WORDS.name, status: statusOf(s), body: [taskLine(ctx), ...views[taskState(s.values)]].filter(Boolean) }, ctx);
  },
};`;

const SHARED                                                    = {
  en: { waiting: "Waiting for the first run", couldnt: "Couldn't check", nothing: "Nothing today", fromTest: "from your test",
    noCalendar: "No calendar connected" },
  ja: { waiting: "最初の実行を待っています", couldnt: "確認できませんでした:", nothing: "今日は何もありません", fromTest: "テストの結果",
    noCalendar: "カレンダー未接続" },
  ko: { waiting: "첫 실행을 기다리는 중", couldnt: "확인하지 못함:", nothing: "오늘은 없음", fromTest: "테스트 결과",
    noCalendar: "캘린더 연결 안 됨" },
  "zh-CN": { waiting: "等待首次运行", couldnt: "无法检查:", nothing: "今天没有内容", fromTest: "来自你的测试", noCalendar: "未连接日历" },
  "zh-TW": { waiting: "等待首次執行", couldnt: "無法檢查:", nothing: "今天沒有內容", fromTest: "來自你的測試", noCalendar: "未連接行事曆" },
};

const MORNING_WORDS                                                    = {
  en: { name: "My morning", meetings: "Meetings", noMeetings: "No meetings today", weather: "Weather", urgent: "Urgent",
    noUrgent: "Nothing urgent" },
  ja: { name: "わたしの朝", meetings: "予定", noMeetings: "今日の予定はありません", weather: "天気", urgent: "急ぎ",
    noUrgent: "急ぎの用はありません" },
  ko: { name: "나의 아침", meetings: "일정", noMeetings: "오늘 일정 없음", weather: "날씨", urgent: "급한 일", noUrgent: "급한 일 없음" },
  "zh-CN": { name: "我的早晨", meetings: "会议", noMeetings: "今天没有会议", weather: "天气", urgent: "紧急", noUrgent: "没有紧急事项" },
  "zh-TW": { name: "我的早晨", meetings: "會議", noMeetings: "今天沒有會議", weather: "天氣", urgent: "緊急", noUrgent: "沒有緊急事項" },
};

const EVENING_WORDS                                                    = {
  en: { name: "My evening", open: "Still open", allDone: "Nothing left open", tomorrow: "Tomorrow",
    nothingTomorrow: "Nothing booked", tonight: "Tonight" },
  ja: { name: "わたしの夜", open: "未完了", allDone: "残りはありません", tomorrow: "明日", nothingTomorrow: "明日の予定はありません",
    tonight: "今夜" },
  ko: { name: "나의 저녁", open: "남은 일", allDone: "남은 일 없음", tomorrow: "내일", nothingTomorrow: "내일 일정 없음", tonight: "오늘 밤" },
  "zh-CN": { name: "我的晚上", open: "未完成", allDone: "没有未完成的事", tomorrow: "明天", nothingTomorrow: "明天没有安排", tonight: "今晚" },
  "zh-TW": { name: "我的晚上", open: "未完成", allDone: "沒有未完成的事", tomorrow: "明天", nothingTomorrow: "明天沒有安排", tonight: "今晚" },
};

const wordsOf = (own                                                   ) => Object.freeze(Object.fromEntries(
  CARD_STARTER_LOCALES.map((locale) => [locale, Object.freeze({ ...SHARED[locale], ...own[locale] })])))                        ;

const freeze =    (value   )    => {
  if (value && typeof value === "object") {
    for (const inner of Object.values(value                           )) freeze(inner);
    Object.freeze(value);
  }
  return value;
};

const CARD_STARTERS                         = freeze([
  {
    blueprintKey: "ocuclaw:glasses-brief",
    starterId: "my-morning",
    version: 1,
    prompt: "Give the user a morning brief for today: calendar events in time order, the local weather, and " +
      "anything urgent waiting on them. Use connected calendar and mail when they are set up. If none are, " +
      "give the date and the weather.",
    inputs: [
      { key: "meetings", type: "list", label: "Meetings", maxItems: 8, fields: { time: "text", title: "text", where: "text" } },
      { key: "calendar_connected", type: "bool", label: "Calendar" },
      { key: "weather", type: "text", label: "Weather", maxBytes: 64 },
      { key: "urgent", type: "list", label: "Urgent", maxItems: 3, of: "text" },
    ],
    sample: {
      meetings: [
        { time: "9:30", title: "Standup", where: "Room 2" },
        { time: "11:00", title: "Design review", where: "" },
        { time: "14:00", title: "1:1 with Sam", where: "Cafe" },
      ],
      calendar_connected: true,
      weather: "Light rain, 14°C",
      urgent: ["Reply to Ana about the venue"],
    },
    words: wordsOf(MORNING_WORDS),
    code: MY_MORNING_CODE,
  },
  {
    blueprintKey: "ocuclaw:day-wrap",
    starterId: "my-evening",
    version: 1,
    prompt: "Give the user a short wrap-up of their day: anything still open from today, tomorrow's first " +
      "commitments in time order, and anything to prepare tonight. Use connected calendar and mail when they " +
      "are set up.",
    inputs: [
      { key: "still_open", type: "list", label: "Still open", maxItems: 6, of: "text" },
      { key: "tomorrow", type: "list", label: "Tomorrow", maxItems: 5, fields: { time: "text", title: "text" } },
      { key: "calendar_connected", type: "bool", label: "Calendar" },
      { key: "prepare_tonight", type: "text", label: "Tonight", maxBytes: 160 },
    ],
    sample: {
      still_open: ["Send the Q3 notes", "Book the dentist"],
      tomorrow: [{ time: "8:30", title: "Gym" }, { time: "10:00", title: "Client call" }],
      calendar_connected: true,
      prepare_tonight: "Print the slides for the client call",
    },
    words: wordsOf(EVENING_WORDS),
    code: MY_EVENING_CODE,
  },
]);

const CARD_STARTER_FIRST_STATE = Object.freeze({ values: null, at: null, source: null, fixes: null });

function cardStarterFor(blueprintKey         )                     {
  return CARD_STARTERS.find((starter) => starter.blueprintKey === blueprintKey) ?? null;
}

function cardStarterById(starterId         )                     {
  return CARD_STARTERS.find((starter) => starter.starterId === starterId) ?? null;
}

function cardStarterLocale(tag         )                    {
  const t = typeof tag === "string" ? tag.trim().replace(/_/g, "-").toLowerCase() : "";
  if (/^zh-(tw|hk|mo|hant)\b/.test(t)) return "zh-TW";
  if (/^zh\b/.test(t)) return "zh-CN";
  const base = t.split("-")[0];
  return base === "ja" || base === "ko" ? base : "en";
}

function cardStarterSource(starter             , locale          = "en")         {
  return `const WORDS = ${JSON.stringify(starter.words[cardStarterLocale(locale)])};\n${starter.code}`;
}

function cardStarterName(starter             , locale          = "en")         {
  return starter.words[cardStarterLocale(locale)].name;
}

function markOf(starter             )                  {
  const names = {}                                     ;
  for (const locale of CARD_STARTER_LOCALES) names[locale] = cardStarterName(starter, locale);
  return { id: starter.starterId, version: starter.version, names };
}

function starterCard(row                                                               )                         {
  if (!row || row.plugin !== "ocuclaw" || typeof row.promptTemplate !== "string") return null;
  const starter = cardStarterFor(row.key);
  if (!starter) return null;
  const prompt = row.promptTemplate.trimEnd();
  return prompt === starter.prompt || prompt.endsWith(`\n${starter.prompt}`) ? markOf(starter) : null;
}

function savedTaskStarterCard(key         , request         )                         {
  const starter = cardStarterFor(key);
  if (!starter || typeof request !== "string") return null;
  const words = request.trimEnd();
  return words === starter.prompt || words.endsWith(`\n${starter.prompt}`) ? markOf(starter) : null;
}

function starterCardMarkOf(raw         , key         )                         {
  const starter = cardStarterFor(key);
  if (!starter || !raw || typeof raw !== "object") return null;
  const mark = raw                                       ;
  return mark.id === starter.starterId && mark.version === starter.version ? markOf(starter) : null;
}

module.exports = { CARD_STARTER_LOCALES, CARD_STARTERS, CARD_STARTER_FIRST_STATE, cardStarterFor, cardStarterById, cardStarterLocale, cardStarterSource, cardStarterName, starterCard, savedTaskStarterCard, starterCardMarkOf };

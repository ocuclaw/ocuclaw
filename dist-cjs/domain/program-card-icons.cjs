const CARD_ICON_QUESTION = "icon";

const CARD_ICON_MIN_CONFIDENCE = 0.6;

const CARD_ICON_CRITERIA                                   = Object.freeze({
  stopwatch: "a stopwatch: timers, countdowns, timing laps or rounds",
  intervals: "a ring of work and rest segments: interval timers, HIIT, tabata, rounds with phases",
  hourglass: "an hourglass: time running out, a sand timer, waiting, time left",
  alarm: "an alarm clock: alarms, wake-ups, reminders at a set time",
  metronome: "a metronome: tempo, beats per minute, rhythm practice, pacing",
  dice: "a die: dice rolls, random picks, board games, chance",
  cards: "a fan of playing cards: card games, solitaire, blackjack, poker, dealing",
  chess: "a chess knight: chess, chess puzzles, strategy and board games",
  tictactoe: "a noughts-and-crosses grid: tic-tac-toe and other small grid games",
  snake: "a snake chasing a dot: snake and other arcade games",
  blocks: "falling blocks: tetris-style puzzle games, stacking games",
  word: "rows of letter tiles: word games, wordle, anagrams, spelling, hangman",
  quiz: "a speech bubble with a question mark: quizzes, trivia, questions and answers",
  flashcards: "a deck of flashcards: flashcards, memorising, vocabulary drills, revision",
  book: "an open book: reading, stories, studying, a book or chapter",
  globe: "a globe: geography, countries, capitals, world clocks, languages and travel",
  calculator: "a calculator: sums, maths, tips, splitting a bill, working something out",
  converter: "two linked values with arrows: unit converters, currency, temperature, cooking measures",
  tally: "tally marks: counters, counting things, laps, reps, a running total",
  scoreboard: "a two-sided scoreboard: keeping score, matches, points for two players or teams",
  chart: "a line chart: progress over time, stats, trends, tracking numbers",
  heartbeat: "a heart with a pulse trace: heart rate, health, vital signs",
  breathing: "a breathing ring: breathing exercises, calm, meditation, box breathing",
  dumbbell: "a dumbbell: workouts, gym sets and reps, strength training",
  water: "a glass filling with water: hydration, drinking water, glasses per day",
  sleep: "a moon with z's: sleep, naps, bedtime, sleep tracking",
  compass: "a compass: directions, bearings, orientation, navigation",
  rain: "a rain cloud: weather, rain, forecasts",
  pin: "a map pin: places, locations, maps, nearby things",
  plane: "an airplane: flights, trips, travel plans, airports",
  sunrise: "a sun rising: mornings, daylight, sunrise and sunset times, routines",
  pot: "a cooking pot: recipes, cooking steps, kitchen timers",
  coffee: "a coffee mug: coffee, breaks, morning routines",
  plant: "a growing plant: habits, growth, gardening, watering",
  flame: "a flame: streaks, burning calories, heat, motivation",
  bell: "a bell: reminders, notifications, alerts",
  house: "a house: home, chores, household, smart home",
  gift: "a gift box: presents, birthdays, celebrations, surprises",
  music: "music notes: music, songs, playlists, practice",
  drawing: "a pencil drawing on a canvas: drawing, sketching, doodles, art",
  chat: "a speech bubble with typing dots: messages, chat, replies",
  rocket: "a rocket: launches, goals, projects, getting started",
  pong: "two paddles and a ball: pong, breakout, bat-and-ball and tennis-style arcade games",
  ufo: "a flying saucer: space shooters, aliens, retro arcade and sci-fi games",
  maze: "a maze with a path: maze games, labyrinths, route-finding puzzles",
  bird: "a bird flying between pipes: tap-to-fly games, one-button dodging games",
  wheel: "a spinning prize wheel: random picker, decision wheel, spin to choose, raffles",
  coinflip: "a flipping coin: heads or tails, coin toss, fifty-fifty choices",
  eightball: "a magic 8-ball: yes or no answers, fortune telling, ask a question, decision maker",
  golf: "a golf flag and ball: golf scores, strokes per hole, mini golf, putting",
  ball: "a football (soccer ball): football and soccer matches, scores, kick-ups, ball sports",
  hoop: "a basketball and hoop: basketball scores, shooting games, free throws",
  runner: "a running figure: running, jogging, couch to 5k, run-walk plans, races",
  bike: "a bicycle: cycling, bike rides, commutes by bike, ride distance",
  flag: "a chequered flag: finish lines, races, goals reached, milestones",
  calendar: "a calendar page: dates, days until an event, schedules, plans for the week",
  star: "a star: favourites, ratings, stars earned, reward charts, gold stars",
  smiley: "a smiling face: mood check-ins, feelings, emotions, how my day went",
  traffic: "a traffic light: stop and go, reaction tests, red-amber-green status, traffic",
  notes: "a notepad and pencil: notes, jotting things down, journals, diaries, writing lists",
  mail: "an envelope: email, letters, inbox, post, sending a message",
  phone: "a phone handset: phone calls, calling someone, contacts, dialling a number",
  camera: "a camera: photos, pictures, snapshots, scanning, a photo log",
  mic: "a microphone: voice memos, recording, dictation, karaoke, singing",
  search: "a magnifying glass: search, look up, find, dictionary, definitions",
  lock: "a padlock: passwords, PIN codes, locks, privacy, security, safes",
  battery: "a battery: battery level, charging, power, energy left",
  gear: "a gear: settings, preferences, setup, tools, maintenance, how things work",
  terminal: "a terminal prompt: code, programming, scripts, commands, developer tools",
  robot: "a robot head: AI assistants, bots, automation, robots",
  speaker: "a loudspeaker: volume, sounds, sound effects, soundboards, white noise",
  headphones: "headphones: podcasts, audiobooks, radio, listening",
  play: "a video screen with a play button: videos, films, TV shows, watching, clips",
  piano: "piano keys: piano, keyboard, melodies, chords, music lessons",
  atom: "an atom: science, physics, chemistry, experiments, science facts",
  recycle: "recycling arrows: recycling, bin day, rubbish and waste, reuse, sorting",
  pill: "a pill capsule with a tick: pill and medication reminders, tablets taken, vitamins, doses",
  tooth: "a tooth with a toothbrush: tooth brushing timers, dentist visits, kids' brushing, flossing",
  wave: "an ocean wave: tides, surfing, the beach, swimming, the sea and boats",
  mountain: "a snowy mountain peak: hiking, climbing, trails, elevation, outdoor trips",
  snowflake: "a snowflake: snow, cold, winter, skiing, freezing temperatures",
  thermometer: "a thermometer: temperature, fever, weather temperatures, heat and cold readings",
  car: "a car: driving, commutes, parking, road trips, fuel and car care",
  train: "a train front: trains, buses, transit departures, timetables, commute times",
  planet: "a ringed planet: space, astronomy, planets, the night sky, stargazing",
  cart: "a shopping cart: shopping lists, groceries, the supermarket, things to buy",
  cake: "a birthday cake with candles: birthdays, parties, anniversaries, age countdowns",
  paw: "a paw print: pets, dog walks, feeding the cat, the vet, pet care",
  fish: "a fish: fishing, aquariums, fish and sea life facts, feeding fish",
  laundry: "a washing machine: laundry timers, wash cycles, chores, drying clothes",
  piggy: "a piggy bank: savings, saving up for something, pocket money, savings goals",
  joystick: "an arcade joystick with a ball-top stick and buttons: arcade games, retro games, fighting games, a joystick",
  arcade: "an upright arcade cabinet: arcade machines, retro arcade games, high scores, coin-op",
  handheld: "a handheld game console with a screen: handheld and portable games, pocket games, retro handhelds",
  crosshair: "a crosshair over a target: shooter games, aiming, target practice, reaction shooting",
  sword: "a sword and shield: RPGs, adventure games, quests, battles, fantasy",
});

const NONE_CRITERION = "no picture plainly names what this app is or does";

const CARD_ICON_QUESTIONS = Object.freeze({
  [CARD_ICON_QUESTION]: Object.freeze({
    type: "choice",
    instructions: Object.freeze({
      question:
        "A small animated picture shows this saved app in the glasses app library. Which picture names what the app is or does at a glance? A loose or generic fit is worse than no picture, so pick none unless one plainly fits.",
      inspect: "app",
    }),
    criteria: Object.freeze({ ...CARD_ICON_CRITERIA, none: NONE_CRITERION }),
  }),
});

function cardIconState(name        , description                ) {
  const text = typeof description === "string" && description.trim() ? `${name}: ${description.trim()}` : name;
  return { app: text };
}

function cardIconOf(answers     )                {
  const answer = answers && typeof answers === "object" ? answers[CARD_ICON_QUESTION] : null;
  const choice = answer && typeof answer.choice === "string" ? answer.choice : null;
  if (!choice || choice === "none") return null;
  if (!Object.prototype.hasOwnProperty.call(CARD_ICON_CRITERIA, choice)) return null;
  const confidence = Number(answer.confidence);
  return Number.isFinite(confidence) && confidence >= CARD_ICON_MIN_CONFIDENCE ? choice : null;
}

const CARD_ICON_KEYWORDS                                              = Object.freeze({
  stopwatch: ["stopwatch", "timer", "countdown", "lap"],
  intervals: ["interval", "hiit", "tabata", "emom", "circuit"],
  hourglass: ["hourglass", "sand timer", "time left"],
  alarm: ["alarm", "wake up", "wake-up", "wakeup"],
  metronome: ["metronome", "tempo", "bpm", "beats per minute"],
  dice: ["dice", "die", "d20", "d6", "roll", "yahtzee"],
  cards: ["solitaire", "blackjack", "poker", "card game", "playing card", "cribbage", "rummy", "snap"],
  chess: ["chess", "knight", "checkmate"],
  tictactoe: ["tic-tac-toe", "tic tac toe", "noughts", "crosses", "connect four"],
  snake: ["snake"],
  blocks: ["tetris", "falling blocks", "blocks", "stacker"],
  word: ["wordle", "anagram", "hangman", "word game", "spelling", "crossword", "scrabble", "boggle", "unscramble", "word of the day"],
  quiz: ["quiz", "trivia", "pub quiz"],
  flashcards: ["flashcard", "vocab", "vocabulary", "memorise", "memorize", "revision"],
  book: ["book", "reading", "story", "chapter", "bible", "poem"],
  globe: ["geography", "capital", "country", "countries", "world clock", "flags of"],
  calculator: ["calculator", "tip", "bill split", "split the bill", "sum", "maths", "math", "percent", "times table", "multiplication", "arithmetic"],
  converter: ["converter", "convert", "conversion", "currency", "exchange rate", "units"],
  tally: ["tally", "counter", "count", "clicker", "reps"],
  scoreboard: ["scoreboard", "score", "scorekeeper", "points", "darts", "cribbage board"],
  chart: ["chart", "graph", "stats", "trend", "progress"],
  heartbeat: ["heart rate", "pulse", "bpm monitor", "blood pressure"],
  breathing: ["breathing", "breath", "breathe", "meditation", "meditate", "calm", "box breathing"],
  dumbbell: ["workout", "gym", "dumbbell", "weights", "strength", "lifting", "push-up", "pushup", "plank", "squat", "lunge", "sit-up", "situp", "burpee", "pull-up", "pullup"],
  water: ["water", "hydration", "hydrate", "drink"],
  sleep: ["sleep", "nap", "bedtime", "snooze"],
  compass: ["compass", "bearing", "north", "orienteering"],
  rain: ["weather", "rain", "forecast", "umbrella"],
  pin: ["map", "location", "nearby", "place", "where"],
  plane: ["flight", "plane", "airport", "boarding", "jet lag", "trip", "itinerary", "travel"],
  sunrise: ["sunrise", "sunset", "morning", "daylight", "dawn"],
  pot: ["recipe", "cooking", "cook", "kitchen", "boil", "egg", "pasta", "rice"],
  coffee: ["coffee", "espresso", "latte", "tea", "brew", "steep", "cafe"],
  plant: ["plant", "garden", "gardening", "watering", "habit", "seed"],
  flame: ["streak", "calorie", "burn", "fire"],
  bell: ["reminder", "notify", "notification", "alert", "chime"],
  house: ["chore", "household", "home", "cleaning", "housework"],
  gift: ["gift", "present", "secret santa", "wishlist", "christmas"],
  music: ["music", "song", "playlist", "guitar", "ukulele", "tuner", "chord", "lyrics", "now playing", "spotify"],
  drawing: ["drawing", "draw", "sketch", "doodle", "paint", "art", "pixel art"],
  chat: ["chat", "message", "reply", "texting", "conversation"],
  rocket: ["rocket", "launch", "project", "goal", "kickoff"],
  pong: ["pong", "breakout", "paddle", "tennis", "ping pong", "table tennis"],
  ufo: ["ufo", "alien", "invader", "space shooter", "asteroid"],
  maze: ["maze", "labyrinth"],
  bird: ["flappy", "bird"],
  wheel: ["wheel", "spinner", "raffle", "random picker", "decision wheel", "lucky draw"],
  coinflip: ["coin", "heads or tails", "coin toss", "coin flip"],
  eightball: ["8-ball", "8 ball", "eight ball", "magic 8", "fortune", "yes or no"],
  golf: ["golf", "putt", "putting", "mini golf"],
  ball: ["football", "soccer", "kick-up", "keepy-uppy", "penalty", "footy"],
  hoop: ["basketball", "hoop", "free throw"],
  runner: ["run", "running", "jog", "jogging", "couch to 5k", "5k", "10k", "marathon", "sprint"],
  bike: ["bike", "cycling", "cycle", "bicycle", "ride"],
  flag: ["finish", "race", "milestone", "lap counter", "finish line"],
  calendar: ["calendar", "days until", "date", "schedule", "week planner", "countdown to", "wedding", "holiday", "vacation", "deadline", "exam", "meeting", "appointment"],
  star: ["star", "favourite", "favorite", "rating", "reward chart", "gold star"],
  smiley: ["mood", "feeling", "emotion", "gratitude", "check-in"],
  traffic: ["traffic light", "reaction", "reflex", "red light", "green light"],
  notes: ["note", "notepad", "journal", "diary", "jot", "list", "agenda"],
  mail: ["email", "mail", "inbox", "postcard", "envelope"],
  phone: ["phone", "call", "dial", "contact", "ring"],
  camera: ["camera", "photo", "picture", "snapshot", "scan", "selfie"],
  mic: ["voice memo", "dictation", "dictate", "record", "recorder", "karaoke", "microphone", "mic"],
  search: ["search", "look up", "lookup", "find", "dictionary", "define", "definition", "meaning"],
  lock: ["password", "pin code", "passcode", "lock", "safe", "vault", "security", "secret"],
  battery: ["battery", "charge", "charging", "power", "energy", "kwh", "kilowatt", "electricity"],
  gear: ["settings", "setting", "config", "setup", "preferences", "gear"],
  terminal: ["terminal", "code", "coding", "script", "command", "shell", "regex", "json", "developer", "git", "repo", "server", "deploy"],
  robot: ["robot", "bot", "ai", "assistant", "automation"],
  speaker: ["soundboard", "sound effect", "white noise", "volume", "speaker", "noise"],
  headphones: ["podcast", "audiobook", "radio", "headphone", "listen"],
  play: ["video", "film", "movie", "tv", "episode", "watch"],
  piano: ["piano", "keyboard", "keys", "melody", "scale"],
  atom: ["science", "physics", "chemistry", "element", "periodic", "atom", "experiment"],
  recycle: ["recycling", "recycle", "bin day", "rubbish", "trash", "waste", "compost"],
  pill: ["pill", "medication", "medicine", "meds", "tablet", "vitamin", "dose"],
  tooth: ["tooth", "teeth", "toothbrush", "brushing", "floss", "dentist"],
  wave: ["tide", "surf", "surfing", "beach", "swim", "swimming", "sea", "ocean", "boat"],
  mountain: ["hike", "hiking", "climb", "climbing", "trail", "mountain", "summit", "elevation"],
  snowflake: ["snow", "ski", "skiing", "winter", "freezing", "frost", "snowboard"],
  thermometer: ["temperature", "fever", "thermometer", "celsius", "fahrenheit"],
  car: ["car", "driving", "drive", "parking", "park", "fuel", "petrol", "road trip", "mileage"],
  train: ["train", "bus", "tram", "metro", "subway", "departure", "timetable", "transit"],
  planet: ["planet", "astronomy", "space", "stargazing", "solar system", "moon phase", "night sky"],
  cart: ["shopping", "grocery", "groceries", "shopping list", "supermarket"],
  cake: ["birthday", "party", "anniversary", "cake", "age"],
  paw: ["pet", "dog", "cat", "puppy", "kitten", "vet", "walkies"],
  fish: ["fish", "fishing", "aquarium"],
  laundry: ["laundry", "washing", "wash cycle", "dryer", "washer"],
  piggy: ["savings", "save up", "saving", "pocket money", "budget", "allowance"],
  joystick: ["joystick", "arcade stick", "fighting game"],
  arcade: ["arcade", "high score", "coin-op", "retro game"],
  handheld: ["handheld", "game boy", "gameboy", "pocket game"],
  crosshair: ["crosshair", "aim", "aiming", "target", "shooter", "shooting"],
  sword: ["rpg", "quest", "dungeon", "adventure", "sword", "battle", "fantasy"],
});

function words(text     ) {
  return ` ${String(typeof text === "string" ? text : "").toLowerCase().replace(/[^a-z0-9-]+/g, " ").replace(/\s+/g, " ").trim()} `;
}

const KEYWORD_MATCHERS                            = Object.entries(CARD_ICON_KEYWORDS).map(([id, list]) => [
  id,
  list.map((word) => new RegExp(` ${words(word).trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:s|es)? `)),
]);

function keywordHits(text     ) {
  const padded = words(text);
  const found                                                                  = [];
  for (const [id, matchers] of KEYWORD_MATCHERS) {
    matchers.forEach((re, word) => {
      const match = re.exec(padded);
      if (match) found.push({ id, start: match.index + 1, end: match.index + match[0].length - 1, word });
    });
  }
  const hits = new Map                ();
  for (const one of found) {
    const inside = found.some((other) => other !== one
      && other.start <= one.start && other.end >= one.end && other.end - other.start > one.end - one.start);
    if (!inside) hits.set(one.id, (hits.get(one.id) || 0) + 1);
  }
  return hits;
}

function keywordCardIcon(name     , description      )                {
  const inName = keywordHits(name);
  if (inName.size === 1) return [...inName.keys()][0];
  const inDescription = keywordHits(description);
  if (inName.size > 1) {
    const both = [...inName.keys()].filter((id) => inDescription.has(id));
    return both.length === 1 ? both[0] : null;
  }
  if (inDescription.size !== 1) return null;
  const [[id, count]] = [...inDescription.entries()];
  return count >= 2 ? id : null;
}

function cardIconKey(name     , description      )         {
  const text = `${typeof name === "string" ? name : ""}\n${typeof description === "string" ? description : ""}`;
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

module.exports = { CARD_ICON_QUESTION, CARD_ICON_MIN_CONFIDENCE, CARD_ICON_CRITERIA, CARD_ICON_QUESTIONS, cardIconState, cardIconOf, CARD_ICON_KEYWORDS, keywordCardIcon, cardIconKey };

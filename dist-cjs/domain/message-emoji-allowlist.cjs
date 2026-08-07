const MESSAGE_EMOJI_ALLOWLIST = [
  "😂", "❤️", "🤣", "👍", "😭", "🙏", "😘", "🥰", "😍", "😊",
  "🎉", "😁", "💕", "🥺", "😅", "🔥", "☺️", "🤦", "🤷", "🙄",
  "😆", "🤗", "😉", "🎂", "🤔", "👏", "🙂", "😳", "🥳", "😎",
  "👌", "😔", "💪", "✨", "💖", "💞", "👀", "😋", "😏", "😢",
  "👉", "💗", "😩", "💯", "🌹", "🎈", "😚", "😐", "😒", "😀",
];

const MESSAGE_EMOJI_ALLOWLIST_SET = new Set(MESSAGE_EMOJI_ALLOWLIST);

module.exports = { MESSAGE_EMOJI_ALLOWLIST, MESSAGE_EMOJI_ALLOWLIST_SET };

const UNSHOWN = /\b(?:beep(?:s|ing)?|chimes?|buzz(?:es|er|ing)?|sound effects?|(?:play|make|makes|plays|playing|making) (?:a |an |the )?(?:\w+ )?(?:sound|sounds|noise|tone|jingle)|(?:through|from|on|over) (?:the |my )?(?:glasses['’]? )?speakers?|vibrat\w*|haptics?|colou?r\w*|purple|orange|red|blue|yellow|pink)\b|소리|진동|색깔|声音|聲音|振动|振動|震动|震動|颜色|顏色|音を|色を/i;

const isUnshownLine = (line         )          => typeof line === "string" && UNSHOWN.test(line);

module.exports = { isUnshownLine };

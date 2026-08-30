function normalizeLogger(logger) {
  if (!logger || typeof logger !== "object") {

    return {
      info: console.log.bind(console),
      warn: console.warn.bind(console),
      error: console.error.bind(console),
      debug: console.debug.bind(console),
      traceLog: console.log.bind(console),
    };
  }
  const info =
    typeof logger.info === "function" ? logger.info.bind(logger) : console.log;
  return {
    info,
    warn: typeof logger.warn === "function" ? logger.warn.bind(logger) : console.warn,
    error: typeof logger.error === "function" ? logger.error.bind(logger) : console.error,
    debug:
      typeof logger.debug === "function" ? logger.debug.bind(logger) : console.debug,

    traceLog:
      typeof logger.traceLog === "function" ? logger.traceLog.bind(logger) : info,
  };
}

module.exports = { normalizeLogger };

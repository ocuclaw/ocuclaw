function createEventChannel             (
  logger                                 ,
  label        ,
) {
  const handlers = new Set                    ();
  return {

    on(handler                    )             {
      if (typeof handler !== "function") return () => {};
      handlers.add(handler);
      return () => handlers.delete(handler);
    },

    emit(event         )       {
      for (const handler of handlers) {
        try {
          handler(event());
        } catch (err     ) {
          logger.warn(`[relay] ${label} handler threw: ${err && err.message ? err.message : err}`);
        }
      }
    },

    get size()         {
      return handlers.size;
    },
  };
}

module.exports = { createEventChannel };

const { AsyncLocalStorage } = require("node:async_hooks");

const deliveryContext = new AsyncLocalStorage               ();

                                                             

                                                                         

function createInMemoryTransportPair()                        {
  const wire               = [];
  let sequence = 0;
  let isClosed = false;
  let hostHandler                                                         = null;
  let phoneHandler                                                         = null;
  let hostSendFailuresRemaining = 0;

  const copy = (frame              )               =>
    JSON.parse(JSON.stringify(frame))                ;

  const chains                                                = {
    host: Promise.resolve(),
    phone: Promise.resolve(),
  };

  function settleHandler(
    endpoint          ,
    handler                                                        ,
    delivered              ,
  )                       {
    if (!handler) return;
    const ancestors = deliveryContext.getStore();
    const run = ()                       => {
      const nested = new Set(ancestors ?? []);
      nested.add(endpoint);
      return deliveryContext.run(nested, () => handler(copy(delivered)));
    };
    if (ancestors?.has(endpoint)) {

      return Promise.resolve()
        .then(run)
        .then(
          () => undefined,
          () => undefined,
        );
    }
    const result = chains[endpoint].then(run);
    chains[endpoint] = result.then(
      () => undefined,
      () => undefined,
    );
    return chains[endpoint];
  }

  const pair                        = {
    host: {
      send(frame) {
        if (isClosed) throw new Error("pairing transport is closed");
        if (hostSendFailuresRemaining > 0) {
          hostSendFailuresRemaining -= 1;
          throw new Error("simulated transport failure");
        }
        const delivered = copy(frame);
        sequence += 1;
        wire.push({ direction: "host->phone", frame: delivered, sequence });
        return settleHandler("phone", phoneHandler, delivered);
      },
      onFrame(handler) {
        hostHandler = handler;
      },
      close() {
        isClosed = true;
      },
    },
    phone: {
      send(frame) {
        if (isClosed) throw new Error("pairing transport is closed");
        const delivered = copy(frame);
        sequence += 1;
        wire.push({ direction: "phone->host", frame: delivered, sequence });
        return settleHandler("host", hostHandler, delivered);
      },
      onFrame(handler) {
        phoneHandler = handler;
      },
      close() {
        isClosed = true;
      },
    },
    wire,
    failHostSends(count) {
      hostSendFailuresRemaining = count;
    },
    closed() {
      return isClosed;
    },
  };

  return pair;
}

module.exports = { createInMemoryTransportPair };

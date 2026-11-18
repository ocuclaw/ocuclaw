const MODEL_LANE_SLOTS = 2;

function createModelLane(slots         = MODEL_LANE_SLOTS)            {
  const size = Number.isInteger(slots) && slots > 0 ? slots : MODEL_LANE_SLOTS;
  let busy = 0;
  const queue                    = [];

  const pump = () => {
    while (busy < size && queue.length > 0) {
      busy++;
      (queue.shift()              )();
    }
  };
  return {
    busy: () => busy,
    waiting: () => queue.length,
    ticket()                  {
      let state                                      = "new";
      let waited                       = null;
      let grant                      = null;
      return {
        held: () => state === "held",
        wait() {
          if (waited) return waited;

          if (state === "done") return (waited = Promise.resolve());
          waited = new Promise      ((resolve) => {
            grant = () => {
              state = "held";
              resolve();
            };
          });
          state = "waiting";
          queue.push(grant              );
          pump();
          return waited;
        },
        release() {
          if (state === "held") {
            state = "done";
            busy--;
            pump();
            return;
          }
          if (state === "waiting") {
            const at = queue.indexOf(grant              );
            if (at >= 0) queue.splice(at, 1);
          }
          state = "done";
        },
      };
    },
  };
}

const MODEL_LANE            = createModelLane();

module.exports = { MODEL_LANE_SLOTS, createModelLane, MODEL_LANE };

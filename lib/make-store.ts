import { RowStore, type RowBackend } from "./row-store";
import { compactConv } from "./conv";
import type { VolatileState } from "./ctx";
import type { Store } from "./store";
import type { Conv } from "./types";

/** The one place that wires the row store (shared by production wiring and tests). */
export function makeStore(o: { backend: RowBackend; now: () => number; state: VolatileState }): Store {
  return new RowStore(o.backend, {
    now: o.now,
    compact: (_k, v, now) => compactConv(v as Conv, now),
    rejections: {
      peek: () => (o.state.rejPending > 0 ? { n: o.state.rejPending, last: o.state.rejLast } : null),
      ack: (n) => { o.state.rejPending = Math.max(0, o.state.rejPending - n); },
    },
  });
}

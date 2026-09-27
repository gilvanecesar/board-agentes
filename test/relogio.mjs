// Frozen clock for the reference snapshot: `node --import ./test/relogio.mjs board.mjs` with BOARD_RELOGIO=<ms>.
// Timers keep working (they don't read Date); only "now" is fixed, so "há 3 dias" reads the same on every run.
const T = Number(process.env.BOARD_RELOGIO);
if (T) {
  const Real = Date;
  globalThis.Date = class extends Real {
    constructor(...a) { if (a.length) super(...a); else super(T); }
    static now() { return T; }
  };
}

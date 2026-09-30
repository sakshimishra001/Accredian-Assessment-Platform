/** Small deterministic PRNG so mock data is identical on the server and in the browser. */
export function seeded(seed: string) {
  let h = 1779033703 ^ seed.length;
  for (let i = 0; i < seed.length; i++) {
    h = Math.imul(h ^ seed.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  let a = h >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Start of today in IST, as epoch ms. All mock dates are offsets from this. */
export const DEMO_DAY_START = (() => {
  const offset = 330 * 60 * 1000;
  const istNow = Date.now() + offset;
  return istNow - (istNow % 86400000) - offset;
})();

/** ISO timestamp `days` from today at `hour:minute` IST. */
export function at(days: number, hour = 10, minute = 0) {
  return new Date(DEMO_DAY_START + days * 86400000 + (hour * 60 + minute) * 60000).toISOString();
}

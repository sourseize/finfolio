import type { SimulationInput } from './types.js';
import { simulate, resolveHorizonMonths, resolveRetirementMonth } from './engine.js';
import { applyShocks } from './economy.js';
import { addMonths, annualToMonthly, percentile, round2, round4 } from './math.js';

/** Small, fast, seedable PRNG (mulberry32). Deterministic across platforms. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Standard normal sample via Box–Muller. */
export function makeNormal(rand: () => number): () => number {
  let spare: number | null = null;
  return () => {
    if (spare !== null) {
      const v = spare;
      spare = null;
      return v;
    }
    let u = 0;
    let v = 0;
    while (u === 0) u = rand();
    while (v === 0) v = rand();
    const mag = Math.sqrt(-2 * Math.log(u));
    const z0 = mag * Math.cos(2 * Math.PI * v);
    spare = mag * Math.sin(2 * Math.PI * v);
    return z0;
  };
}

export interface MonteCarloOptions {
  trials?: number;
  seed?: number;
}

export interface BandPoint {
  t: number;
  period: string;
  p10: number;
  p25: number;
  p50: number;
  p75: number;
  p90: number;
}

export interface MonteCarloResult {
  trials: number;
  seed: number;
  horizonMonths: number;
  /** Net-worth percentile bands, sampled every 12 months (plus the final month). */
  netWorthBands: BandPoint[];
  /** Invested-assets percentile bands on the same sampling. */
  investedBands: BandPoint[];
  /** Share of trials that never ran out of assets within the horizon. */
  successProbability: number;
  /** Share of trials reaching the FI number on or before the planned retirement month. */
  fiByRetirementProbability: number;
  /** Share of trials reaching the FI number at any point within the horizon. */
  fiWithinHorizonProbability: number;
  /** Percentiles of the FI month among trials that reached it (null when none did). */
  fiMonth: { p10: number; p50: number; p90: number } | null;
  endNetWorth: { p10: number; p25: number; p50: number; p75: number; p90: number; mean: number };
  endRealNetWorth: { p10: number; p50: number; p90: number };
  /** Share of trials where net worth fell below zero at some point. */
  negativeNetWorthProbability: number;
}

/**
 * Run the engine many times with randomly sampled monthly returns.
 *
 * Returns are log-normal: ln(1+r) ~ N(μ − σ²/2, σ) per year, scaled to months,
 * so the median path is close to the deterministic run. Scheduled shocks from
 * the economy assumptions are applied on top of the random draws.
 */
export function runMonteCarlo(input: SimulationInput, opts: MonteCarloOptions = {}): MonteCarloResult {
  const trials = Math.max(1, Math.min(5000, Math.round(opts.trials ?? 500)));
  const seed = opts.seed ?? 42;
  const economy = input.scenario.economy;
  const horizon = resolveHorizonMonths(input);
  const retirementMonth = resolveRetirementMonth(input);

  const sigmaM = economy.volatility / Math.sqrt(12);
  const muM = Math.log(1 + economy.expectedReturn) / 12 - (sigmaM * sigmaM) / 2;
  const trendFactor = 1 + annualToMonthly(economy.expectedReturn);

  const rand = mulberry32(seed);
  const normal = makeNormal(rand);

  const sampleIdx: number[] = [];
  for (let t = 11; t < horizon; t += 12) sampleIdx.push(t);
  if (sampleIdx[sampleIdx.length - 1] !== horizon - 1) sampleIdx.push(horizon - 1);

  const nwSamples: number[][] = sampleIdx.map(() => []);
  const invSamples: number[][] = sampleIdx.map(() => []);
  const endNw: number[] = [];
  const endReal: number[] = [];
  const fiMonths: number[] = [];
  let successes = 0;
  let fiByRet = 0;
  let wentNegative = 0;

  for (let k = 0; k < trials; k++) {
    // Pre-draw the whole path so each trial consumes a fixed number of randoms (stable seeding).
    const path = new Float64Array(horizon);
    for (let t = 0; t < horizon; t++) {
      const logR = muM + sigmaM * normal();
      path[t] = applyShocks(economy.shocks, t, Math.exp(logR), trendFactor) - 1;
    }
    const res = simulate(input, { marketReturn: t => path[t], skipRunway: true });

    sampleIdx.forEach((t, i) => {
      nwSamples[i].push(res.months[t].netWorth);
      invSamples[i].push(res.months[t].invested);
    });
    endNw.push(res.summary.endNetWorth);
    endReal.push(res.summary.endRealNetWorth);
    if (res.summary.depletedMonth === null) successes += 1;
    if (res.summary.minNetWorth < 0) wentNegative += 1;
    const fi = res.summary.fire.fiMonth;
    if (fi !== null) {
      fiMonths.push(fi);
      if (fi <= retirementMonth) fiByRet += 1;
    }
  }

  const band = (samples: number[][]): BandPoint[] =>
    sampleIdx.map((t, i) => ({
      t,
      period: addMonths(input.baseline.asOf, t),
      p10: round2(percentile(samples[i], 0.1)),
      p25: round2(percentile(samples[i], 0.25)),
      p50: round2(percentile(samples[i], 0.5)),
      p75: round2(percentile(samples[i], 0.75)),
      p90: round2(percentile(samples[i], 0.9)),
    }));

  const mean = endNw.reduce((s, v) => s + v, 0) / endNw.length;

  return {
    trials,
    seed,
    horizonMonths: horizon,
    netWorthBands: band(nwSamples),
    investedBands: band(invSamples),
    successProbability: round4(successes / trials),
    fiByRetirementProbability: round4(fiByRet / trials),
    fiWithinHorizonProbability: round4(fiMonths.length / trials),
    fiMonth: fiMonths.length
      ? { p10: Math.round(percentile(fiMonths, 0.1)), p50: Math.round(percentile(fiMonths, 0.5)), p90: Math.round(percentile(fiMonths, 0.9)) }
      : null,
    endNetWorth: {
      p10: round2(percentile(endNw, 0.1)),
      p25: round2(percentile(endNw, 0.25)),
      p50: round2(percentile(endNw, 0.5)),
      p75: round2(percentile(endNw, 0.75)),
      p90: round2(percentile(endNw, 0.9)),
      mean: round2(mean),
    },
    endRealNetWorth: {
      p10: round2(percentile(endReal, 0.1)),
      p50: round2(percentile(endReal, 0.5)),
      p90: round2(percentile(endReal, 0.9)),
    },
    negativeNetWorthProbability: round4(wentNegative / trials),
  };
}

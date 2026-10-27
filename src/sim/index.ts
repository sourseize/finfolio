/**
 * FinFolio simulation engine — pure, dependency-free, deterministic.
 *
 *   baseline.ts   derive the starting point from real account/transaction data
 *   economy.ts    economic presets, shocks, deterministic return path
 *   events.ts     life-event catalog + validation
 *   engine.ts     month-by-month projection, FIRE & runway metrics
 *   montecarlo.ts seeded Monte Carlo bands & probabilities
 *   metrics.ts    opportunity cost, scenario comparison, goal feasibility
 */
export * from './types.js';
export * from './math.js';
export * from './economy.js';
export * from './events.js';
export * from './baseline.js';
export * from './engine.js';
export * from './montecarlo.js';
export * from './metrics.js';
export * from './scenario.js';

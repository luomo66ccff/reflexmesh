import { ContractError, probability } from '../core/validation.js';
export interface LabeledPrediction { readonly probability: number; readonly label: 0 | 1 }
/** Requires independently established labels. 'No incident occurred' is NOT a safety label. */
export function calibrationReport(rows: readonly LabeledPrediction[], binCount = 10): { count: number; brier: number; ece: number; bins: readonly { count: number; meanProbability: number; positiveRate: number }[] } {
  if (!rows.length || !Number.isSafeInteger(binCount) || binCount < 1 || binCount > 1000) throw new ContractError('Invalid calibration dataset');
  const bins = Array.from({ length: binCount }, () => ({ count: 0, totalProbability: 0, positive: 0 }));
  let squares = 0;
  for (const row of rows) {
    probability(row.probability);
    if (row.label !== 0 && row.label !== 1) throw new ContractError('Invalid label');
    squares += (row.probability - row.label) ** 2;
    const bin = bins[Math.min(binCount - 1, Math.floor(row.probability * binCount))]!;
    bin.count++; bin.totalProbability += row.probability; bin.positive += row.label;
  }
  const summary = bins.map(b => ({ count: b.count, meanProbability: b.count ? b.totalProbability / b.count : 0, positiveRate: b.count ? b.positive / b.count : 0 }));
  const ece = summary.reduce((sum, b) => sum + b.count / rows.length * Math.abs(b.meanProbability - b.positiveRate), 0);
  return { count: rows.length, brier: squares / rows.length, ece, bins: summary };
}

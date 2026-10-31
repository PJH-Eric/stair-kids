'use strict';

/** 同一批路線下，後一組相對前一組的平均差與兩倍標準誤。 */
module.exports = function pairedComparison(before, after) {
  if (before.length !== after.length || before.length < 2) {
    throw new Error('配對比較需要至少兩組且數量相同的樣本');
  }
  const differences = after.map((value, i) => value - before[i]);
  if (!differences.every(Number.isFinite)) throw new Error('樣本必須是有限數值');
  const n = differences.length;
  const gap = differences.reduce((sum, value) => sum + value, 0) / n;
  const squared = differences.reduce((sum, value) => sum + Math.pow(value - gap, 2), 0);
  return { gap, se2: 2 * Math.sqrt(squared / (n * (n - 1))) };
};

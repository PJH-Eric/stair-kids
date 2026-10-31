'use strict';
const assert = require('node:assert/strict');
const compare = require('../scripts/paired-comparison.js');

assert.deepEqual(compare([10, 100, 1000], [20, 110, 1010]), { gap: 10, se2: 0 });
assert.deepEqual(compare([10, 100, 1000], [10, 100, 1000]), { gap: 0, se2: 0 });
const measured = compare([0, 0, 0], [1, 2, 3]);
assert.equal(measured.gap, 2);
assert.ok(Math.abs(measured.se2 - 2 / Math.sqrt(3)) < 1e-12, '使用配對差值的樣本標準誤');
const regression = compare([100, 200, 300], [50, 150, 250]);
assert.ok(regression.gap < -regression.se2, '一致退步必須被判為顯著倒掛');
const noise = compare([100, 200, 300, 400], [101, 199, 301, 398]);
assert.ok(noise.gap < 0 && noise.gap >= -noise.se2, '抽樣誤差內的小差距不誤判');
assert.throws(() => compare([1], [2]), /至少兩組/);
assert.throws(() => compare([1, 2], [2]), /數量相同/);
assert.throws(() => compare([1, 2], [2, Infinity]), /有限數值/);
console.log('✓ AI 配對統計辨識進步、相同表現、微小雜訊與顯著退步');

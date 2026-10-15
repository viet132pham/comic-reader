const test = require('node:test');
const assert = require('node:assert');
const { scrollSpeed } = require('../lib/scroll.js');

test('scrollSpeed zones', () => {
  assert.strictEqual(scrollSpeed(0.5, 0.25, 10), 0);      // centre rests
  assert.strictEqual(scrollSpeed(0.625, 0.25, 10), 0);    // dead-band edge rests
  assert.strictEqual(scrollSpeed(0.375, 0.25, 10), 0);
  assert.strictEqual(scrollSpeed(1, 0.25, 10), 10);       // bottom edge = full speed down
  assert.strictEqual(scrollSpeed(0, 0.25, 10), -10);      // top edge = full speed up
  assert.strictEqual(scrollSpeed(0.8125, 0.25, 10), 5);   // halfway into bottom zone
  assert.strictEqual(scrollSpeed(1.4, 0.25, 10), 10);     // out-of-range input clamps
  assert.strictEqual(scrollSpeed(-3, 0.25, 10), -10);
});

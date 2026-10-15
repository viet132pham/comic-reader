// Cursor height (0 = top, 1 = bottom) -> scroll speed in [-max, max].
// The middle `dead` band rests; speed ramps linearly to ±max at the edges.
function scrollSpeed(ratio, dead, max) {
  const r = Math.min(1, Math.max(0, ratio));
  const edge = (1 - dead) / 2; // height of each active zone
  if (r > 1 - edge) return max * (r - (1 - edge)) / edge;
  if (r < edge) return -max * (edge - r) / edge;
  return 0;
}

if (typeof module !== 'undefined') module.exports = { scrollSpeed };

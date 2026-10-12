import { describe, expect, it } from 'vitest';
import { clampTimelineTimePerDiv, MAX_TIMELINE_TIME_PER_DIV_MS, parseTimelineTimePerDiv, TIMELINE_TIME_PRESETS_MS } from './timeline-time-scale';

describe('Timeline time scale', () => {
  it('ends the zoom presets at 100 seconds per division', () => {
    expect(TIMELINE_TIME_PRESETS_MS.at(-1)).toBe(100_000);
    expect(TIMELINE_TIME_PRESETS_MS.every(value => value <= MAX_TIMELINE_TIME_PER_DIV_MS)).toBe(true);
    expect(clampTimelineTimePerDiv(200_000)).toBe(100_000);
    expect(clampTimelineTimePerDiv(100_000)).toBe(100_000);
    expect(clampTimelineTimePerDiv(75_000)).toBe(75_000);
  });

  it.each([
    ['100s', 100_000], ['100000ms', 100_000], ['100000', 100_000], ['150s', 100_000],
    ['75.0s', 75_000], ['0.5s', 500], ['.5 s', 500], ['2ms', 2], [' 2 MS ', 2],
  ])('parses %s as %d ms without losing the unit on blur', (text, expected) => {
    expect(parseTimelineTimePerDiv(text)).toBe(expected);
  });

  it.each(['0', '-2', 'NaN', 'Infinity', '10foo', '1s2', ''])('rejects invalid input %s', text => {
    expect(parseTimelineTimePerDiv(text)).toBeUndefined();
  });
});

import { describe, expect, it } from 'vitest';
import { TimelineSampleRate } from './timeline-sample-rate';

function samples(expression: string, timestamps: number[], startsNewSegment = false) {
  return { expression, color: '#123456', currentValue: '1', data: timestamps.map((timestamp, i) => ({
    timestamp, value: 1, display: '1', ...(startsNewSegment && i === 0 ? { startsNewSegment: true } : {}),
  })) };
}

describe('Timeline actual sample rate', () => {
  it('uses sample timestamps rather than message delivery frequency', () => {
    const rate = new TimelineSampleRate();
    rate.accept([samples('a', [0, 10, 20])], 0);
    rate.accept([samples('a', [30, 40, 50])], 200);
    expect(rate.getHz(200)).toBe(100);
  });
  it('averages channel rates instead of multiplying by the number of variables', () => {
    const rate = new TimelineSampleRate();
    rate.accept([samples('a', [0, 10, 20]), samples('b', [0, 10, 20])], 0);
    expect(rate.getHz(0)).toBe(100);
  });
  it('updates across one-second windows when sampling speed changes', () => {
    const rate = new TimelineSampleRate();
    rate.accept([samples('a', Array.from({ length: 101 }, (_, i) => i * 10))], 0);
    expect(rate.getHz(0)).toBe(100);
    rate.accept([samples('a', [1020, 1040, 1060])], 100);
    expect(rate.getHz(100)).toBe(50);
  });
  it('returns zero while idle and starts fresh when new points arrive', () => {
    const rate = new TimelineSampleRate();
    rate.accept([samples('a', [0, 10, 20])], 0);
    expect(rate.getHz(1500)).toBe(0);
    rate.accept([samples('a', [10000, 10020, 10040])], 1600);
    expect(rate.getHz(1600)).toBe(50);
  });
  it('excludes pauses across a new segment even before idle expiry', () => {
    const rate = new TimelineSampleRate();
    rate.accept([samples('a', [0, 10, 20])], 0);
    rate.accept([samples('a', [500, 520, 540], true)], 500);
    expect(rate.getHz(500)).toBe(50);
  });
  it('ignores duplicate, out-of-order and non-finite points', () => {
    const rate = new TimelineSampleRate();
    rate.accept([samples('a', [0, 10, 10, 5, NaN, Infinity, 20])], 0);
    expect(rate.getHz(0)).toBe(100);
  });
});

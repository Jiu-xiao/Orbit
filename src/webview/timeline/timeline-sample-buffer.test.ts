import { describe, expect, it } from 'vitest';
import { appendTimelineSamples, retainTimelineSamples, TimelineFrameBatcher, type TimelineSampleSnapshot } from './timeline-sample-buffer';
import { calculateBufferedRange, TimelineRangeController } from './timeline-range';
import { buildTimelineTraceCommands } from './timeline-trace-path';

const point = (timestamp: number) => ({ timestamp, value: timestamp, display: String(timestamp) });
const snapshot = (data: ReturnType<typeof point>[]): TimelineSampleSnapshot => ({
  expression: 'counter', color: '#4EC9B0', currentValue: data.at(-1)?.display || '', data,
});

describe('Timeline viewport cache', () => {
  it('retains both edge neighbours and evicts unrelated history', () => {
    const data = new Map([['counter', [0, 10, 20, 30, 40, 50, 60].map(point)]]);
    retainTimelineSamples(data, { start: 20, end: 40 });
    expect(data.get('counter')).toEqual([10, 20, 30, 40, 50].map(point));
    retainTimelineSamples(data, null);
    expect(data.get('counter')).toEqual([]);
  });

  it('retains a sparse pair straddling the viewport without joining separate segments', () => {
    const data = new Map([['counter', [point(0), { ...point(100), startsNewSegment: true }]]]);
    retainTimelineSamples(data, { start: 40, end: 60 });
    expect(data.get('counter')).toHaveLength(2);
    expect(buildTimelineTraceCommands(data.get('counter')!, {
      tStart: 40, tEnd: 60, plotLeft: 12, plotWidth: 600, projectY: p => p.value,
    })).toEqual([]);
  });

  it('keeps old display points and reloads them after viewport eviction', () => {
    const data = new Map([['counter', [point(1_199_000), point(1_200_000)]]]);
    const controller = new TimelineRangeController();
    controller.setHistoryBounds({ start: 0, end: 1_200_000 });
    controller.setResolution(1);
    let frame: (() => void) | undefined;
    const oldViewport = { start: 99_000, end: 101_000 };
    const buffer = calculateBufferedRange(oldViewport.start, oldViewport.end, { start: 0, end: 1_200_000 })!;
    const [request] = controller.requestViewport(oldViewport.start, oldViewport.end);
    const batcher = new TimelineFrameBatcher(callback => { frame = callback; return 1; }, () => {}, snapshots => {
      appendTimelineSamples(data, snapshots);
      retainTimelineSamples(data, buffer);
      controller.retainCoverage(buffer);
    });
    batcher.enqueue([snapshot([95_000, 99_000, 100_000, 101_000, 105_000].map(point))], () =>
      controller.completeRequest(request.requestId, request, controller.generation, controller.resolutionKey));
    expect(controller.requestViewport(oldViewport.start, oldViewport.end)).toEqual([]);
    expect(data.get('counter')!.some(p => p.timestamp === 100_000)).toBe(false);
    frame?.();
    expect(data.get('counter')!.some(p => p.timestamp === 100_000)).toBe(true);
    expect(buildTimelineTraceCommands(data.get('counter')!, {
      tStart: oldViewport.start, tEnd: oldViewport.end, plotLeft: 12, plotWidth: 600, projectY: p => p.value,
    }).some(command => command.command === 'lineTo')).toBe(true);
    expect(controller.requestViewport(oldViewport.start, oldViewport.end)).toEqual([]);
    const recent = { start: 1_190_000, end: 1_200_000 };
    retainTimelineSamples(data, recent);
    controller.retainCoverage(recent);
    expect(controller.requestViewport(oldViewport.start, oldViewport.end).length).toBeGreaterThan(0);
  });

  it.each(['zoom', 'cancel'] as const)('rejects a reply invalidated by %s before its animation frame', action => {
    const controller = new TimelineRangeController();
    controller.setHistoryBounds({ start: 0, end: 1000 });
    controller.setResolution(1);
    const [request] = controller.requestViewport(100, 200);
    const generation = controller.generation;
    const resolution = controller.resolutionKey;
    const data = new Map<string, ReturnType<typeof point>[]>();
    let frame: (() => void) | undefined;
    const batcher = new TimelineFrameBatcher(callback => { frame = callback; return 1; }, () => {}, snapshots => {
      appendTimelineSamples(data, snapshots);
    });
    batcher.enqueue([snapshot([point(100), point(200)])], () =>
      controller.completeRequest(request.requestId, request, generation, resolution));
    if (action === 'zoom') controller.setResolution(2);
    else controller.cancelPendingRequests();
    frame?.();
    expect(data.size).toBe(0);
    expect(controller.requestViewport(100, 200).length).toBeGreaterThan(0);
  });

  it('completes empty range replies in the same frame and cancels queued callbacks on disposal', () => {
    let frame: (() => void) | undefined;
    let accepted = 0, flushed = 0;
    const batcher = new TimelineFrameBatcher(callback => { frame = callback; return 1; }, () => {}, () => { flushed++; });
    batcher.enqueue([], () => { accepted++; return true; });
    expect(accepted).toBe(0);
    frame?.();
    expect(accepted).toBe(1);
    expect(flushed).toBe(1);
    batcher.enqueue([], () => { accepted++; return true; });
    batcher.dispose();
    frame?.();
    expect(accepted).toBe(1);
  });
});
const LARGE_HISTORY_SIZE = 250_000;

describe('TimelineFrameBatcher', () => {
  it('updates a small overlapping reply without traversing unrelated retained history', () => {
    let indexedReads = 0;
    const raw = Array.from({ length: LARGE_HISTORY_SIZE }, (_, timestamp) => point(timestamp));
    const existing = new Proxy(raw, {
      get(target, property, receiver) {
        if (typeof property === 'string' && /^\d+$/.test(property)) indexedReads++;
        return Reflect.get(target, property, receiver);
      },
    });
    const replacement = { ...point(120_000), value: -1, startsNewSegment: true };
    const data = new Map([['counter', existing]]);
    appendTimelineSamples(data, [snapshot([replacement, point(120_001)])]);
    expect(indexedReads).toBeLessThan(100);
    expect(data.get('counter')).toBe(existing);
    expect(raw).toHaveLength(LARGE_HISTORY_SIZE);
    expect(raw[120_000]).toBe(replacement);
    expect(raw[119_999]).toEqual(point(119_999));
    expect(raw[120_002]).toEqual(point(120_002));
  });

  it('inserts new points in an overlapping reply without losing the suffix', () => {
    const data = new Map([['counter', [point(0), point(10), point(20), point(30), point(40)]]]);
    appendTimelineSamples(data, [snapshot([point(5), point(10), point(15), point(20), point(25)])]);
    expect(data.get('counter')).toEqual([0, 5, 10, 15, 20, 25, 30, 40].map(point));
  });

  it('coalesces multiple host messages into one animation-frame UI update', () => {
    let frame: (() => void) | undefined;
    const flushed: TimelineSampleSnapshot[][] = [];
    const batcher = new TimelineFrameBatcher(
      callback => { frame = callback; return 1; },
      () => {},
      snapshots => flushed.push(snapshots),
    );

    batcher.enqueue([snapshot([point(1)])]);
    batcher.enqueue([snapshot([point(2), point(3)])]);

    expect(flushed).toEqual([]);
    frame?.();
    expect(flushed).toEqual([[snapshot([point(1), point(2), point(3)])]]);
  });

  it('coalesces out-of-order live and range messages without duplicate timestamps', () => {
    let frame: (() => void) | undefined;
    let flushed: TimelineSampleSnapshot[] | undefined;
    const batcher = new TimelineFrameBatcher(
      callback => { frame = callback; return 1; },
      () => {},
      snapshots => { flushed = snapshots; },
    );

    batcher.enqueue([snapshot([point(30), point(40)])]);
    batcher.enqueue([snapshot([point(10), point(20), point(30)])]);
    frame?.();

    expect(flushed).toEqual([snapshot([point(10), point(20), point(30), point(40)])]);
  });

  it('replays a large retained history without exceeding the JavaScript argument limit', () => {
    let frame: (() => void) | undefined;
    let flushed: TimelineSampleSnapshot[] | undefined;
    const history = Array.from({ length: LARGE_HISTORY_SIZE }, (_, timestamp) => point(timestamp));
    const batcher = new TimelineFrameBatcher(
      callback => { frame = callback; return 1; },
      () => {},
      snapshots => { flushed = snapshots; },
    );

    batcher.enqueue([snapshot(history)]);
    frame?.();

    expect(flushed?.[0].data).toHaveLength(LARGE_HISTORY_SIZE);
    expect(flushed?.[0].data[0]).toEqual(point(0));
    expect(flushed?.[0].data.at(-1)).toEqual(point(LARGE_HISTORY_SIZE - 1));
  });

  it('merges a display range longer than ten minutes without dropping its beginning', () => {
    const existing = [point(0), point(30_000), point(31_000), point(600_000)];
    const data = new Map([['counter', existing]]);

    const latestTimestamp = appendTimelineSamples(data, [snapshot([point(631_001)])]);

    expect(data.get('counter')).toBe(existing);
    expect(existing).toEqual([point(0), point(30_000), point(31_000), point(600_000), point(631_001)]);
    expect(existing.at(-1)!.timestamp - existing[0].timestamp).toBeGreaterThanOrEqual(600_000);
    expect(latestTimestamp).toBe(631_001);
  });

  it('keeps an old range reply when the cache still contains current samples', () => {
    const data = new Map([['counter', [point(1_199_000), point(1_200_000)]]]);
    appendTimelineSamples(data, [snapshot([95_000, 99_000, 100_000, 101_000, 105_000].map(point))]);
    expect(data.get('counter')!.map(p => p.timestamp)).toEqual([
      95_000, 99_000, 100_000, 101_000, 105_000, 1_199_000, 1_200_000,
    ]);
  });

  it('appends a large retained history in place without exceeding the JavaScript argument limit', () => {
    const existing: ReturnType<typeof point>[] = [];
    const data = new Map([['counter', existing]]);
    const history = Array.from({ length: LARGE_HISTORY_SIZE }, (_, timestamp) => point(timestamp));

    const latestTimestamp = appendTimelineSamples(data, [snapshot(history)]);

    expect(data.get('counter')).toBe(existing);
    expect(existing).toHaveLength(LARGE_HISTORY_SIZE);
    expect(existing[0]).toEqual(point(0));
    expect(existing.at(-1)).toEqual(point(LARGE_HISTORY_SIZE - 1));
    expect(latestTimestamp).toBe(LARGE_HISTORY_SIZE - 1);
  });

  it('merges overlapping range and live samples in timestamp order without duplicates', () => {
    const existing = [point(20), point(30), point(40)];
    const data = new Map([['counter', existing]]);

    const latestTimestamp = appendTimelineSamples(data, [snapshot([
      point(0), point(10), point(20), point(30),
    ])]);

    expect(data.get('counter')).toBe(existing);
    expect(existing).toEqual([point(0), point(10), point(20), point(30), point(40)]);
    expect(latestTimestamp).toBe(30);
  });
});

import { describe, expect, it } from 'vitest';
import {
  calculateBufferedRange,
  clampTimelineViewportEnd,
  getTimelineHistoryBounds,
  intersectTimelineRange,
  parseTimelineRangeLoadRequest,
  quantizeTimelineResolution,
  sliceTimelineRange,
  TimelineRangeController,
} from './timeline-range';

const point = (timestamp: number) => ({ timestamp, value: timestamp, display: String(timestamp) });

describe('calculateBufferedRange', () => {
  it('prefetches two visible widths on both sides', () => {
    expect(calculateBufferedRange(300, 400, { start: 0, end: 800 })).toEqual({ start: 100, end: 600 });
  });

  it('clamps the prefetch range to both history boundaries', () => {
    expect(calculateBufferedRange(10, 110, { start: 0, end: 150 })).toEqual({ start: 0, end: 150 });
    expect(calculateBufferedRange(190, 290, { start: 150, end: 300 })).toEqual({ start: 150, end: 300 });
  });

  it('returns no range for empty, invalid, or disjoint bounds', () => {
    expect(calculateBufferedRange(100, 200, null)).toBeNull();
    expect(calculateBufferedRange(200, 100, { start: 0, end: 300 })).toBeNull();
    expect(calculateBufferedRange(400, 500, { start: 0, end: 300 })).toBeNull();
  });
});

describe('clampTimelineViewportEnd', () => {
  it('allows panning a short recording without locking the viewport at its latest edge', () => {
    const bounds = { start: 100, end: 500 };
    expect(clampTimelineViewportEnd(250, 800, bounds, true)).toBe(250);
    expect(clampTimelineViewportEnd(50, 800, bounds, true)).toBe(100);
    expect(clampTimelineViewportEnd(600, 800, bounds, true)).toBe(500);
  });
  it('keeps the viewport within the latest and earliest history edges', () => {
    const bounds = { start: 100, end: 500 };
    expect(clampTimelineViewportEnd(600, 200, bounds)).toBe(500);
    expect(clampTimelineViewportEnd(200, 200, bounds)).toBe(300);
  });

  it('anchors at the latest edge when history is narrower than the viewport', () => {
    expect(clampTimelineViewportEnd(100, 500, { start: 100, end: 300 })).toBe(300);
  });

  it('leaves the requested end unchanged when history is empty', () => {
    expect(clampTimelineViewportEnd(250, 100, null)).toBe(250);
  });
});

describe('intersectTimelineRange', () => {
  it('clamps a requested range to current history bounds', () => {
    expect(intersectTimelineRange({ start: 0, end: 200 }, { start: 50, end: 150 }))
      .toEqual({ start: 50, end: 150 });
  });

  it('returns null when a requested range is outside history', () => {
    expect(intersectTimelineRange({ start: 0, end: 40 }, { start: 50, end: 150 })).toBeNull();
    expect(intersectTimelineRange({ start: 160, end: 200 }, { start: 50, end: 150 })).toBeNull();
  });
});

describe('sliceTimelineRange', () => {
  const points = [point(0), point(10), point(20), point(30), point(40)];

  it('returns points inside the range plus one predecessor', () => {
    expect(sliceTimelineRange(points, 15, 35)).toEqual([point(10), point(20), point(30)]);
  });

  it('does not return a predecessor for a fully disjoint request', () => {
    expect(sliceTimelineRange(points, 50, 60)).toEqual([]);
    expect(sliceTimelineRange(points, -20, -10)).toEqual([]);
  });
});

describe('getTimelineHistoryBounds', () => {
  it('uses the earliest and latest points across expressions', () => {
    expect(getTimelineHistoryBounds([
      [point(20), point(40)],
      [],
      [point(10), point(30), point(50)],
    ])).toEqual({ start: 10, end: 50 });
  });

  it('returns null when every expression is empty', () => {
    expect(getTimelineHistoryBounds([[], []])).toBeNull();
  });
});

describe('quantizeTimelineResolution', () => {
  it('quantizes milliseconds per pixel to stable power-of-two levels', () => {
    expect(quantizeTimelineResolution(800, 100)).toBe(8);
    expect(quantizeTimelineResolution(840, 100)).toBe(8);
    expect(quantizeTimelineResolution(1600, 100)).toBe(16);
  });

  it('rejects invalid viewport dimensions', () => {
    expect(quantizeTimelineResolution(0, 100)).toBeNull();
    expect(quantizeTimelineResolution(800, 0)).toBeNull();
  });
});

describe('parseTimelineRangeLoadRequest', () => {
  it('accepts a bounded resolution-aware range request', () => {
    expect(parseTimelineRangeLoadRequest({
      requestId: 7,
      generation: 3,
      start: 100,
      end: 500,
      resolutionKey: 0.5,
      targetBuckets: 800,
    })).toEqual({
      requestId: 7,
      generation: 3,
      start: 100,
      end: 500,
      resolutionKey: 0.5,
      targetBuckets: 800,
    });
  });

  it('rejects invalid identities, ranges, resolutions, and bucket counts', () => {
    const valid = {
      requestId: 7,
      generation: 3,
      start: 100,
      end: 500,
      resolutionKey: 0.5,
      targetBuckets: 800,
    };

    expect(parseTimelineRangeLoadRequest({ ...valid, requestId: 1.5 })).toBeNull();
    expect(parseTimelineRangeLoadRequest({ ...valid, generation: -1 })).toBeNull();
    expect(parseTimelineRangeLoadRequest({ ...valid, end: 50 })).toBeNull();
    expect(parseTimelineRangeLoadRequest({ ...valid, resolutionKey: 0 })).toBeNull();
    expect(parseTimelineRangeLoadRequest({ ...valid, targetBuckets: 0 })).toBeNull();
    expect(parseTimelineRangeLoadRequest({ ...valid, targetBuckets: 100_001 })).toBeNull();
  });
});

describe('TimelineRangeController', () => {
  it('does not request batch boundaries after ten minutes of continuous live sampling', () => {
    const controller = new TimelineRangeController();
    controller.setResolution(1);
    for (let start = 0; start < 600_000; start += 15) {
      controller.setHistoryBounds({ start: 0, end: start + 12 });
      controller.markLiveSamples([{ expression: 'counter', data: [point(start), point(start + 12)] }]);
    }
    expect(controller.requestViewport(599_197, 599_997)).toEqual([]);
    // This also checks a wide view, which used to create tens of thousands of requests.
    expect(controller.requestViewport(0, 599_997)).toEqual([]);
  });

  it('preserves real segment breaks and does not bridge unrelated expressions', () => {
    const controller = new TimelineRangeController();
    controller.setHistoryBounds({ start: 0, end: 1000 });
    controller.markLiveSamples([{ expression: 'a', data: [point(0), point(100)] }]);
    controller.markLiveSamples([{ expression: 'b', data: [point(900), point(1000)] }]);
    controller.markLiveSamples([{ expression: 'a', data: [{ ...point(500), startsNewSegment: true }, point(600)] }]);
    expect(controller.requestViewport(0, 1000).map(({ start, end }) => ({ start, end }))).toEqual([
      { start: 100, end: 500 }, { start: 600, end: 900 },
    ]);
  });

  it('does not bridge missed live data after visibility or resolution changes', () => {
    const controller = new TimelineRangeController();
    controller.setResolution(1);
    controller.setHistoryBounds({ start: 0, end: 1000 });
    controller.markLiveSamples([{ expression: 'a', data: [point(0), point(100)] }]);
    controller.resetLiveContinuity();
    controller.markLiveSamples([{ expression: 'a', data: [point(900), point(1000)] }]);
    expect(controller.requestViewport(0, 1000)).toHaveLength(1);
    controller.setResolution(2);
    controller.markLiveSamples([{ expression: 'a', data: [point(900), point(1000)] }]);
    expect(controller.requestViewport(0, 1000)[0]).toMatchObject({ start: 0, end: 900 });
  });

  it('bounds fragmented backfill and still fills every missing interval', () => {
    const controller = new TimelineRangeController();
    controller.setHistoryBounds({ start: 0, end: 60_000 });
    for (let start = 0; start < 60_000; start += 15) controller.markLoadedRange({ start, end: start + 12 });
    const requests = controller.requestViewport(0, 60_000);
    expect(requests).toHaveLength(4);
    expect(controller.requestViewport(0, 60_000)).toEqual([]);
    for (const request of requests) expect(controller.completeRequest(request.requestId, request)).toBe(true);
    expect(controller.requestViewport(0, 60_000)).toEqual([]);
  });

  it('rejects abandoned historical replies when returning to follow at the same resolution', () => {
    const controller = new TimelineRangeController();
    controller.setResolution(1);
    controller.setHistoryBounds({ start: 0, end: 600_000 });
    const [historical] = controller.requestViewport(0, 800);
    controller.cancelPendingRequests();
    const [latest] = controller.requestViewport(599_200, 600_000);
    expect(controller.completeRequest(historical.requestId, historical, controller.generation, 1)).toBe(false);
    expect(controller.completeRequest(latest.requestId, latest, controller.generation, 1)).toBe(true);
  });

  it('invalidates loaded and pending coverage when display resolution changes', () => {
    const controller = new TimelineRangeController();
    controller.setHistoryBounds({ start: 0, end: 1000 });
    expect(controller.setResolution(1)).toBe(true);
    const [oldRequest] = controller.requestViewport(300, 400);
    const oldGeneration = controller.generation;

    expect(controller.setResolution(1)).toBe(false);
    expect(controller.setResolution(4)).toBe(true);
    expect(controller.generation).toBe(oldGeneration + 1);
    expect(controller.completeRequest(
      oldRequest.requestId,
      oldRequest,
      oldGeneration,
      1,
    )).toBe(false);
    expect(controller.requestViewport(300, 400)).toEqual([
      { requestId: oldRequest.requestId + 1, start: 100, end: 600 },
    ]);
  });

  it('rejects a response whose generation or resolution does not match its request', () => {
    const controller = new TimelineRangeController();
    controller.setHistoryBounds({ start: 0, end: 500 });
    controller.setResolution(2);
    const [request] = controller.requestViewport(200, 300);

    expect(controller.completeRequest(request.requestId, request, controller.generation - 1, 2)).toBe(false);
    expect(controller.completeRequest(request.requestId, request, controller.generation, 4)).toBe(false);
    expect(controller.completeRequest(request.requestId, request, controller.generation, 2)).toBe(true);
  });

  it('requests the visible range with a two-screen margin on both sides', () => {
    const controller = new TimelineRangeController();
    controller.setHistoryBounds({ start: 0, end: 800 });

    expect(controller.requestViewport(300, 400)).toEqual([
      { requestId: 1, start: 100, end: 600 },
    ]);
  });

  it('does not request future or pre-history data at either boundary', () => {
    const controller = new TimelineRangeController();
    controller.setHistoryBounds({ start: 0, end: 300 });

    expect(controller.requestViewport(0, 100)).toEqual([
      { requestId: 1, start: 0, end: 300 },
    ]);

    const latest = new TimelineRangeController();
    latest.setHistoryBounds({ start: 0, end: 300 });
    expect(latest.requestViewport(200, 300)).toEqual([
      { requestId: 1, start: 0, end: 300 },
    ]);
  });

  it('does not request a range already loaded or in flight', () => {
    const controller = new TimelineRangeController();
    controller.setHistoryBounds({ start: 0, end: 300 });
    const [request] = controller.requestViewport(100, 200);

    expect(controller.requestViewport(100, 200)).toEqual([]);
    expect(controller.completeRequest(request.requestId, { start: request.start, end: request.end })).toBe(true);
    expect(controller.requestViewport(100, 200)).toEqual([]);
  });

  it('does not refresh while at least a half-screen margin remains', () => {
    const controller = new TimelineRangeController();
    controller.setHistoryBounds({ start: 0, end: 1000 });
    const [request] = controller.requestViewport(300, 400);
    controller.completeRequest(request.requestId, { start: request.start, end: request.end });

    expect(controller.requestViewport(450, 550)).toEqual([]);
  });

  it('requests only missing ranges when zooming beyond loaded coverage on both sides', () => {
    const controller = new TimelineRangeController();
    controller.setHistoryBounds({ start: 0, end: 1000 });
    const [request] = controller.requestViewport(300, 400);
    controller.completeRequest(request.requestId, { start: request.start, end: request.end });

    expect(controller.requestViewport(150, 550)).toEqual([
      { requestId: 2, start: 0, end: 100 },
      { requestId: 3, start: 600, end: 1000 },
    ]);
  });

  it('restores two screens of buffered margin after less than half a screen remains', () => {
    const controller = new TimelineRangeController();
    controller.setHistoryBounds({ start: 0, end: 1000 });
    const [request] = controller.requestViewport(300, 400);
    controller.completeRequest(request.requestId, { start: request.start, end: request.end });

    expect(controller.requestViewport(460, 560)).toEqual([
      { requestId: 2, start: 600, end: 760 },
    ]);
  });

  it('requests only the newly retained tail after history bounds advance', () => {
    const controller = new TimelineRangeController();
    controller.setHistoryBounds({ start: 0, end: 150 });
    const [request] = controller.requestViewport(50, 150);
    controller.completeRequest(request.requestId, { start: request.start, end: request.end });

    controller.setHistoryBounds({ start: 0, end: 200 });
    expect(controller.requestViewport(100, 200)).toEqual([
      { requestId: 2, start: 150, end: 200 },
    ]);
  });

  it('accepts known out-of-order responses without treating unknown responses as coverage', () => {
    const controller = new TimelineRangeController();
    controller.setHistoryBounds({ start: 0, end: 500 });
    const [older] = controller.requestViewport(50, 100);
    const [newer] = controller.requestViewport(400, 450);

    expect(controller.completeRequest(newer.requestId, { start: newer.start, end: newer.end })).toBe(true);
    expect(controller.completeRequest(older.requestId, { start: older.start, end: older.end })).toBe(true);
    expect(controller.completeRequest(999, { start: 0, end: 500 })).toBe(false);
  });

  it('tracks live coverage and can reset all client coverage', () => {
    const controller = new TimelineRangeController();
    controller.setHistoryBounds({ start: 0, end: 150 });
    controller.markLoadedRange({ start: 0, end: 150 });

    expect(controller.requestViewport(50, 150)).toEqual([]);
    controller.clearCoverage();
    expect(controller.requestViewport(50, 150)).toEqual([
      { requestId: 1, start: 0, end: 150 },
    ]);
  });

  it('does not reuse request ids after clearing coverage', () => {
    const controller = new TimelineRangeController();
    controller.setHistoryBounds({ start: 0, end: 300 });
    const [oldRequest] = controller.requestViewport(0, 100);

    controller.clearCoverage();
    const [newRequest] = controller.requestViewport(200, 300);

    expect(newRequest.requestId).toBeGreaterThan(oldRequest.requestId);
    expect(controller.completeRequest(oldRequest.requestId, oldRequest)).toBe(false);
    expect(controller.completeRequest(newRequest.requestId, newRequest)).toBe(true);
  });

  it('retries in-flight coverage after visibility restoration', () => {
    const controller = new TimelineRangeController();
    controller.setHistoryBounds({ start: 0, end: 300 });
    const [lostRequest] = controller.requestViewport(100, 200);

    controller.cancelPendingRequests();

    expect(controller.requestViewport(100, 200)).toEqual([
      { requestId: lostRequest.requestId + 1, start: 0, end: 300 },
    ]);
  });
});


describe('Timeline cache coverage eviction', () => {
  it('reloads a previously visited interval after its display cache has been evicted', () => {
    const controller = new TimelineRangeController();
    controller.setHistoryBounds({ start: 0, end: 1000 });
    controller.setResolution(1);
    controller.markLoadedRange({ start: 0, end: 1000 });
    controller.retainCoverage({ start: 800, end: 1000 });
    const requests = controller.requestViewport(100, 200);
    expect(requests.length).toBeGreaterThan(0);
    expect(requests.some(request => request.start <= 100 && request.end >= 200)).toBe(true);
  });
});

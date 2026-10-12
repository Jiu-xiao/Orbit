export interface TimelineDataPoint {
  timestamp: number;
  value: number;
  display: string;
  startsNewSegment?: boolean;
  segmentId?: number;
  channelId?: number;
}

/** Segment identity also survives CSV reads that do not carry a start flag. */
export function startsTimelineSegment(point: TimelineDataPoint, predecessor?: TimelineDataPoint): boolean {
  return !!point.startsNewSegment
    || (point.segmentId !== undefined && predecessor?.segmentId !== undefined && point.segmentId !== predecessor.segmentId)
    || (point.channelId !== undefined && predecessor?.channelId !== undefined && point.channelId !== predecessor.channelId);
}

export interface TimelineSampleSnapshot {
  expression: string;
  color: string;
  currentValue: string;
  data: TimelineDataPoint[];
}

type FrameScheduler = (callback: () => void) => number;
type FrameCanceller = (handle: number) => void;

function appendItems<T>(target: T[], source: readonly T[]) {
  for (const item of source) target.push(item);
}

function mergePointsInPlace(target: TimelineDataPoint[], source: readonly TimelineDataPoint[]) {
  if (source.length === 0) return;
  if (target.length === 0 || target[target.length - 1].timestamp < source[0].timestamp) {
    appendItems(target, source);
    return;
  }

  // Locate just the overlap. Small history replies must not copy the entire
  // retained trace (often hundreds of thousands of points).
  const lowerBound = (timestamp: number, inclusive: boolean) => {
    let low = 0;
    let high = target.length;
    while (low < high) {
      const middle = low + Math.floor((high - low) / 2);
      if (target[middle].timestamp < timestamp || (inclusive && target[middle].timestamp === timestamp)) low = middle + 1;
      else high = middle;
    }
    return low;
  };
  const first = lowerBound(source[0].timestamp, false);
  const afterLast = lowerBound(source[source.length - 1].timestamp, true);
  const merged: TimelineDataPoint[] = [];
  let targetIndex = first;
  let sourceIndex = 0;
  while (targetIndex < afterLast || sourceIndex < source.length) {
    const targetPoint = targetIndex < afterLast ? target[targetIndex] : undefined;
    const sourcePoint = source[sourceIndex];
    if (targetPoint !== undefined && (sourcePoint === undefined || targetPoint.timestamp < sourcePoint.timestamp)) {
      merged.push(targetPoint);
      targetIndex++;
    } else if (targetPoint === undefined || sourcePoint.timestamp < targetPoint.timestamp) {
      merged.push(sourcePoint);
      sourceIndex++;
    } else {
      merged.push(sourcePoint);
      targetIndex++;
      sourceIndex++;
    }
  }
  const oldLength = target.length;
  const delta = merged.length - (afterLast - first);
  if (delta > 0) {
    target.length = oldLength + delta;
    for (let index = oldLength - 1; index >= afterLast; index--) target[index + delta] = target[index];
  }
  for (let index = 0; index < merged.length; index++) target[first + index] = merged[index];
}

/** Coalesces host messages so React and canvas update at most once per frame. */
export class TimelineFrameBatcher {
  private pending: { snapshots: TimelineSampleSnapshot[]; accept?: () => boolean }[] = [];
  private frameHandle: number | null = null;

  constructor(
    private scheduleFrame: FrameScheduler,
    private cancelFrame: FrameCanceller,
    private onFlush: (snapshots: TimelineSampleSnapshot[]) => void,
  ) {}

  enqueue(snapshots: TimelineSampleSnapshot[], accept?: () => boolean) {
    if (snapshots.length === 0 && !accept) return;
    this.pending.push({ snapshots, accept });
    if (this.frameHandle === null) {
      this.frameHandle = this.scheduleFrame(() => {
        this.frameHandle = null;
        const batches = this.pending;
        this.pending = [];
        const merged = new Map<string, TimelineSampleSnapshot>();
        for (const batch of batches) {
          // A range may become stale between receipt and this animation frame.
          if (batch.accept && !batch.accept()) continue;
          this.mergeSnapshots(merged, batch.snapshots);
        }
        // Also apply empty replies: they can complete valid sparse ranges.
        this.onFlush([...merged.values()]);
      });
    }
  }

  private mergeSnapshots(merged: Map<string, TimelineSampleSnapshot>, snapshots: TimelineSampleSnapshot[]) {
    for (const snapshot of snapshots) {
      if (!snapshot.expression || snapshot.data.length === 0) continue;
      let pending = merged.get(snapshot.expression);
      if (!pending) {
        pending = {
          expression: snapshot.expression,
          color: snapshot.color,
          currentValue: snapshot.currentValue,
          data: [],
        };
        merged.set(snapshot.expression, pending);
      }
      pending.color = snapshot.color;
      const previousLatestTimestamp = pending.data.at(-1)?.timestamp ?? Number.NEGATIVE_INFINITY;
      mergePointsInPlace(pending.data, snapshot.data);
      if (snapshot.data.at(-1)!.timestamp >= previousLatestTimestamp) {
        pending.currentValue = snapshot.currentValue;
      }
    }
  }

  dispose() {
    if (this.frameHandle !== null) this.cancelFrame(this.frameHandle);
    this.frameHandle = null;
    this.pending = [];
  }
}

export function appendTimelineSamples(
  dataByExpression: Map<string, TimelineDataPoint[]>,
  snapshots: TimelineSampleSnapshot[],
): number | undefined {
  let latestTimestamp: number | undefined;
  for (const snapshot of snapshots) {
    if (snapshot.data.length === 0) continue;
    const existing = dataByExpression.get(snapshot.expression) || [];
    mergePointsInPlace(existing, snapshot.data);
    dataByExpression.set(snapshot.expression, existing);
    const timestamp = snapshot.data[snapshot.data.length - 1].timestamp;
    if (latestTimestamp === undefined || timestamp > latestTimestamp) latestTimestamp = timestamp;
  }
  return latestTimestamp;
}

/** Retain a viewport's prefetch range and one neighbour on either edge. */
export function retainTimelineSamples(
  dataByExpression: Map<string, TimelineDataPoint[]>,
  range: { start: number; end: number } | null,
) {
  for (const [expression, points] of dataByExpression) {
    if (!range) { if (points.length) dataByExpression.set(expression, []); continue; }
    const boundary = (timestamp: number, after: boolean) => {
      let low = 0, high = points.length;
      while (low < high) {
        const middle = low + Math.floor((high - low) / 2);
        if (points[middle].timestamp < timestamp || (after && points[middle].timestamp === timestamp)) low = middle + 1;
        else high = middle;
      }
      return low;
    };
    const first = Math.max(0, boundary(range.start, false) - 1);
    const after = Math.min(points.length, boundary(range.end, true) + 1);
    if (first > 0 || after < points.length) dataByExpression.set(expression, points.slice(first, after));
  }
}

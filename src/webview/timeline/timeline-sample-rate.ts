import type { TimelineSampleSnapshot } from './timeline-sample-buffer';

export const TIMELINE_SAMPLE_RATE_STALE_MS = 1500;
interface ChannelRate { first: number; last: number; count: number; hz: number; receivedAt: number; }

/** 用原始点的时间戳统计每通道采样率，不累计通道数或绘图点数。 */
export class TimelineSampleRate {
  private channels = new Map<string, ChannelRate>();

  accept(snapshots: readonly TimelineSampleSnapshot[], now = performance.now()): void {
    for (const snapshot of snapshots) {
      let channel = this.channels.get(snapshot.expression);
      for (const point of snapshot.data) {
        if (!Number.isFinite(point.timestamp) || !Number.isFinite(point.value)) continue;
        if (!channel || point.startsNewSegment || now - channel.receivedAt >= TIMELINE_SAMPLE_RATE_STALE_MS) {
          channel = { first: point.timestamp, last: point.timestamp, count: 1, hz: 0, receivedAt: now };
        } else if (point.timestamp > channel.last) {
          channel.last = point.timestamp;
          channel.count++;
          channel.receivedAt = now;
        }
      }
      if (!channel) continue;
      const elapsed = channel.last - channel.first;
      if (elapsed > 0) channel.hz = (channel.count - 1) * 1000 / elapsed;
      if (elapsed >= 1000) {
        channel.first = channel.last;
        channel.count = 1;
      }
      this.channels.set(snapshot.expression, channel);
    }
  }

  getHz(now = performance.now()): number {
    let total = 0, count = 0;
    for (const [expression, channel] of this.channels) {
      if (now - channel.receivedAt >= TIMELINE_SAMPLE_RATE_STALE_MS) {
        this.channels.delete(expression);
      } else {
        total += channel.hz;
        count++;
      }
    }
    return count ? total / count : 0;
  }
}

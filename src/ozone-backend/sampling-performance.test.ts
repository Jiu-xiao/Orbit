import { describe, expect, it, vi } from 'vitest';
import { CmsisDapHelperClient } from './cmsis-dap-helper-channel';
import { CmsisDapTargetChannel } from './session-target-channel';
import { DapSession } from '../debug/dap-session';
import { log } from '../utils/logger';

describe('sampling timing and logging', () => {
  it('separates scheduler wait, RPC time and helper time using monotonic timestamps', async () => {
    let now = 0;
    const clock = vi.spyOn(performance, 'now').mockImplementation(() => now);
    const helper = new CmsisDapHelperClient('unused-helper-path');
    let blockedId = 0;
    (helper as any).child = { stdin: { writable: true, write(line: string) {
      const frame = JSON.parse(line);
      if (frame.method === 'halt') { blockedId = frame.id; return; }
      now += 5;
      (helper as any).handleLine(JSON.stringify({ id: frame.id, result: {
        ok: true, targetState: 'Running', elapsedMs: 3, diagnostics: {
          packets: 2, dapTransferCount: 2, waitRetries: 1, faultClears: 1, transport: 'mock',
        },
      } }));
    } } };
    try {
      const blocked = helper.request('halt');
      const queued = helper.request('readMemoryBatch', {}, { priority: 'timeline' });
      now = 40;
      (helper as any).handleLine(JSON.stringify({ id: blockedId, result: { ok: true, elapsedMs: 40 } }));
      const [, result] = await Promise.all([blocked, queued]);
      expect(result.diagnostics).toMatchObject({ queueWaitMs: 40, rpcElapsedMs: 5, helperProcessingMs: 3 });
      const snapshot = helper.getPerformanceSnapshot();
      expect(snapshot.helperQueueWaitMs).toMatchObject({ count: 1, p50: 40 });
      expect(snapshot.helperRpcElapsedMs).toMatchObject({ count: 1, p50: 5 });
      expect(snapshot.cmsisDap).toMatchObject({ rpcCount: 1, waitRetries: 1, faultClears: 1 });
    } finally { clock.mockRestore(); }
  });

  it('summarizes Timeline successes once a second while preserving samples and immediate errors', async () => {
    let now = 0;
    const clock = vi.spyOn(performance, 'now').mockImplementation(() => now);
    const logger = vi.spyOn(log, 'dap').mockImplementation(() => {});
    const request = vi.fn(async (_method: string, params: any): Promise<any> => ({
      ok: true, targetState: 'Running', elapsedMs: 1,
      data: { reads: params.reads.map((read: any) => ({ ...read, bytes: [1, 2, 3, 4] })) },
      diagnostics: { transport: 'mock', queueWaitMs: 0, rpcElapsedMs: 2, helperProcessingMs: 1, packets: 1 },
    }));
    const channel = new CmsisDapTargetChannel({ helperClient: { request } as any });
    (channel as any).state = 'connected';
    const reads = [{ address: 0x20000000, size: 4 }];
    try {
      for (let i = 0; i < 500; i++) {
        now = i * 2;
        const result = await channel.readMemoryBatch(reads, { priority: 'timeline' });
        expect(result.data?.reads[0].bytes).toEqual(Uint8Array.from([1, 2, 3, 4]));
      }
      expect(logger).not.toHaveBeenCalled();
      now = 1000;
      await channel.readMemoryBatch(reads, { priority: 'timeline' });
      expect(logger).toHaveBeenCalledTimes(1);
      expect(logger.mock.calls[0][0]).toContain('"requests":501');
      expect(logger.mock.calls[0][0]).toContain('"bytes":2004');
      request.mockResolvedValueOnce({ ok: false, errorCode: 'DapAckFault', targetState: 'Error', elapsedMs: 1 });
      const failure = await channel.readMemoryBatch(reads, { priority: 'timeline' });
      expect(failure.ok).toBe(false);
      expect(logger).toHaveBeenCalledTimes(2);
      expect(logger.mock.calls[1][0]).toContain('errorCode=DapAckFault');
    } finally { logger.mockRestore(); clock.mockRestore(); }
  });

  it('counts and sends every valid raw sample, including zero, without requesting target state', async () => {
    let value = 0;
    const backend = { execute: vi.fn(async () => ({ ok: true, data: [{ expression: 'counter', value: value++, display: String(value - 1) }] })), dispose() {} };
    const session = new DapSession(backend as any);
    const s = session as any;
    s.setTargetRunning(true);
    s.dataSamplingSpecs = [{ expression: 'counter', address: 0x20000000, size: 4 }];
    s.dataSamplingEntries = [{ expression: 'counter', color: '#fff' }];
    s.dataSamplingPending.set('counter', []);
    const sent: any[] = [];
    session.on('send', message => sent.push(message));
    for (let i = 0; i < 20; i++) await s.captureFastDataSample();
    s.flushDataSampling();
    expect(sent.find(m => m.event === 'ozoneDataSamples').body.snapshots[0].data.map((p: any) => p.value)).toEqual(Array.from({ length: 20 }, (_, i) => i));
    expect(s.snapshotTargetReadGateMetrics().sampling).toMatchObject({ readsCompleted: 20, samplesAccepted: 20, samplesSent: 20, commitMs: { count: 20 } });
    expect(backend.execute.mock.calls.every(([cmd]: any) => cmd.cmd === 'readFastDataSampling')).toBe(true);
    s.stopDataSampling();
  });

  it('discards a delayed old capture after stop and replacement with the same expression', async () => {
    let complete!: (result: unknown) => void;
    const backend = { execute: () => new Promise(resolve => { complete = resolve; }), dispose() {} };
    const session = new DapSession(backend as any);
    const s = session as any;
    s.setTargetRunning(true);
    s.dataSamplingSpecs = [{ expression: 'counter', address: 0x20000000, size: 4 }];
    s.dataSamplingPending.set('counter', []);
    const capture = s.captureFastDataSample();
    s.stopDataSampling();
    s.dataSamplingSpecs = [{ expression: 'counter', address: 0x20000000, size: 4 }];
    s.dataSamplingPending.set('counter', []);
    complete({ ok: true, data: [{ expression: 'counter', value: 99, display: '99' }] });
    await capture;
    expect(s.dataSamplingPending.get('counter')).toEqual([]);
    expect(s.targetReadInProgress).toBe(false);
    expect(s.snapshotTargetReadGateMetrics().sampling.samplesAccepted).toBe(0);
    s.stopDataSampling();
  });
});

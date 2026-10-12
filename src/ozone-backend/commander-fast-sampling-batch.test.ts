import { describe, expect, it, vi } from 'vitest';
import { OzoneBackend } from './commander';
import type { FastDataSampleSpec, WatchValue } from './types';

function fixture() {
  const backend = new OzoneBackend();
  const memory = new Map<number, number>();
  const put = (address: number, value: number) => {
    const bytes = new Uint8Array(4);
    new DataView(bytes.buffer).setUint32(0, value, true);
    bytes.forEach((byte, offset) => memory.set(address + offset, byte));
  };
  const read = (address: number, size: number) => {
    const bytes = Array.from({ length: size }, (_, i) => memory.get(address + i));
    return bytes.some(byte => byte === undefined) ? null : Uint8Array.from(bytes as number[]);
  };
  put(0x20000100, 0x20001000);
  put(0x20001008, 0x20002000);
  put(0x2000200c, 42);
  put(0x20002030, 0);
  put(0x20000400, 17);
  const single = vi.fn(async (address: number, size: number) => read(address, size));
  const batch = vi.fn(async (reads: Array<{ address: number; size: number }>, _options?: unknown): Promise<any> => ({
    ok: true,
    data: { reads: reads.map(item => ({ address: item.address, bytes: read(item.address, item.size) ?? new Uint8Array() })) },
  }));
  const internal = backend as any;
  internal.sessionTarget = { readMemoryBatch: batch };
  internal.targetReadMemory = single;
  const specs: FastDataSampleSpec[] = [
    { expression: 'power', address: 0x20000400, size: 4 },
    ...[12, 48].map((offset, i) => ({
      expression: 'motor.' + i, address: 0, size: 4,
      pointerChain: [
        { pointerAddress: 0x20000100, offset: 0 },
        { pointerAddress: 0, offset: 8 },
        { pointerAddress: 0, offset },
      ],
    })),
  ];
  const capture = async (selected = specs, priority: 'watch' | 'timeline' = 'timeline') => {
    const result = await backend.execute({ cmd: 'readFastDataSampling', specs: selected, priority });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    return result.data as WatchValue[];
  };
  return { backend, internal, put, read, single, batch, specs, capture };
}

describe('fast sampling batches and per-capture pointer reuse', () => {
  it('reads a scalar and two shared pointer expressions in three owner batches, preserving order and zero', async () => {
    const f = fixture();
    const values = await f.capture();
    expect(values.map(v => [v.expression, v.value, v.address])).toEqual([
      ['power', 17, 0x20000400], ['motor.0', 42, 0x2000200c], ['motor.1', 0, 0x20002030],
    ]);
    expect(f.batch.mock.calls.map(([reads]) => reads)).toEqual([
      [{ address: 0x20000100, size: 4 }, { address: 0x20000400, size: 4 }],
      [{ address: 0x20001008, size: 4 }],
      [{ address: 0x2000200c, size: 4 }, { address: 0x20002030, size: 4 }],
    ]);
    expect(f.single).not.toHaveBeenCalled();
    for (const [, options] of f.batch.mock.calls) expect(options).toEqual({ priority: 'timeline', coalesceKey: 'fast-data-sampling' });
  });

  it('refreshes shared pointer bytes and values on every capture', async () => {
    const f = fixture();
    await f.capture();
    f.put(0x20000100, 0x20003000);
    f.put(0x20003008, 0x20004000);
    f.put(0x2000400c, 99);
    f.put(0x20004030, 100);
    const values = await f.capture();
    expect(values.map(v => v.value)).toEqual([17, 99, 100]);
    expect(f.batch).toHaveBeenCalledTimes(6);
    expect(f.batch.mock.calls[4][0]).toEqual([{ address: 0x20003008, size: 4 }]);
  });

  it('reports bounded read/format timing and exact batch/cache counters on demand', async () => {
    const f = fixture();
    await f.capture();
    const result = await f.backend.execute({ cmd: 'getPerformanceDiagnostics' });
    expect(result).toMatchObject({ ok: true, data: { fastSampling: {
      captures: 1, batchRequests: 3, fallbackReads: 0, cacheHits: 2,
      readMs: { count: 1, retainedCount: 1 }, formatMs: { count: 1, retainedCount: 1 },
    } } });
  });

  it('batches mixed pointer depths and retains Watch priority', async () => {
    const f = fixture();
    f.put(0x20000200, 0x20005000);
    f.put(0x20005004, 23);
    const legacy: FastDataSampleSpec = { expression: 'legacy', address: 0, size: 4, pointerAddress: 0x20000200, pointeeOffset: 4 };
    const values = await f.capture([f.specs[1], legacy], 'watch');
    expect(values.map(v => v.value)).toEqual([42, 23]);
    expect(f.batch).toHaveBeenCalledTimes(3);
    expect(f.batch.mock.calls[1][0]).toEqual([{ address: 0x20001008, size: 4 }, { address: 0x20005004, size: 4 }]);
    for (const [, options] of f.batch.mock.calls) expect(options).toEqual({ priority: 'watch' });
  });

  it('deduplicates roots and leaves on the legacy path without a batch-capable owner', async () => {
    const f = fixture();
    f.internal.sessionTarget = null;
    const values = await f.capture([f.specs[1], { ...f.specs[1], expression: 'same-leaf' }]);
    expect(values.map(v => v.value)).toEqual([42, 42]);
    expect(f.single.mock.calls).toEqual([[0x20000100, 4, 'timeline'], [0x20001008, 4, 'timeline'], [0x2000200c, 4, 'timeline']]);
  });

  it.each(['null', 'short', 'overflow'])('isolates a %s intermediate pointer from a healthy branch', async failure => {
    const f = fixture();
    f.put(0x20001010, failure === 'overflow' ? 0xfffffffC : 0);
    const bad = structuredClone(f.specs[2]);
    bad.pointerChain![1].offset = 16;
    if (failure === 'short') f.single.mockImplementation(async (address, size) => address === 0x20001010 ? new Uint8Array(2) : f.read(address, size));
    if (failure === 'short') f.batch.mockImplementation(async (reads) => ({ ok: true, data: { reads: reads.map(r => ({ address: r.address, bytes: r.address === 0x20001010 ? new Uint8Array(2) : f.read(r.address, r.size) })) } }));
    const values = await f.capture([f.specs[1], bad]);
    expect(values[0].value).toBe(42);
    expect(values[0].error).toBeUndefined();
    expect(values[1].error).toContain('read failed');
    expect(f.batch.mock.calls[2][0]).toEqual([{ address: 0x2000200c, size: 4 }]);
    expect(f.single.mock.calls.some(([address]) => address < 0x20000000)).toBe(false);
  });

  it('falls back through the same owner once per shared node when a batch fails, isolating failed leaves', async () => {
    const f = fixture();
    f.batch.mockResolvedValue({ ok: false, errorCode: 'DapAckFault' });
    f.single.mockImplementation(async (address, size) => address === 0x20002030 ? null : f.read(address, size));
    const values = await f.capture();
    expect(values[0].value).toBe(17);
    expect(values[1].value).toBe(42);
    expect(values[2].error).toContain('read failed');
    expect(f.single.mock.calls.filter(([a]) => a === 0x20000100)).toHaveLength(1);
    expect(f.single.mock.calls.filter(([a]) => a === 0x20001008)).toHaveLength(1);
  });

  it.each(['RequestCancelled', 'NativeOwnerLost'])('stops pending layers after %s without individual retries', async errorCode => {
    const f = fixture();
    f.batch.mockImplementationOnce(async reads => ({ ok: true, data: { reads: reads.map(r => ({ address: r.address, bytes: f.read(r.address, r.size) })) } }));
    f.batch.mockResolvedValue({ ok: false, errorCode });
    const values = await f.capture();
    expect(values[0].value).toBe(17);
    expect(values.slice(1).every(v => v.error)).toBe(true);
    expect(f.batch).toHaveBeenCalledTimes(2);
    expect(f.single).not.toHaveBeenCalled();
  });

  it('does not issue another layer after the captured owner selector is replaced', async () => {
    const f = fixture();
    f.batch.mockImplementation(async reads => {
      f.internal.sessionTarget = {};
      return { ok: true, data: { reads: reads.map(r => ({ address: r.address, bytes: f.read(r.address, r.size) })) } };
    });
    expect((await f.capture()).every(v => v.error)).toBe(true);
    expect(f.batch).toHaveBeenCalledTimes(1);
    expect(f.single).not.toHaveBeenCalled();
  });

  it('stops when the backend session generation changes while a round is in flight', async () => {
    const f = fixture();
    f.batch.mockImplementation(async reads => {
      f.internal.sessionGeneration++;
      return { ok: true, data: { reads: reads.map(r => ({ address: r.address, bytes: f.read(r.address, r.size) })) } };
    });
    expect((await f.capture()).every(v => v.error)).toBe(true);
    expect(f.batch).toHaveBeenCalledTimes(1);
    expect(f.single).not.toHaveBeenCalled();
  });
});

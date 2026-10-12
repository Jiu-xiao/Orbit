import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ activeDebugSession: undefined as any, warning: vi.fn() }));
vi.mock('vscode', () => ({
  debug: {
    get activeDebugSession() { return state.activeDebugSession; },
    onDidChangeActiveDebugSession: () => ({ dispose() {} }),
    onDidTerminateDebugSession: () => ({ dispose() {} }),
    onDidReceiveDebugSessionCustomEvent: () => ({ dispose() {} }),
  },
  workspace: {
    getConfiguration: () => ({ get: (_key: string, fallback: unknown) => fallback }),
    onDidChangeConfiguration: () => ({ dispose() {} }),
  },
  window: { showWarningMessage: state.warning },
}));

import { DataSamplingManager } from './data-sampling-manager';

describe('Timeline sampling rejection feedback', () => {
  beforeEach(() => {
    state.warning.mockReset();
    state.activeDebugSession = undefined;
  });

  function fixture(customRequest: ReturnType<typeof vi.fn>) {
    const backend = { hasTargetConnection: false, execute: vi.fn() };
    const session = { type: 'orbit', customRequest };
    state.activeDebugSession = session;
    const manager = new DataSamplingManager(backend as any);
    return { backend, session, manager };
  }

  it('reports rejected expressions while keeping the supported remote sampler active', async () => {
    const { manager, session, backend } = fixture(vi.fn(async () => ({
      ok: true,
      planned: [
        { expression: 'speed', spec: { expression: 'speed', address: 0x20000100, size: 4 } },
        { expression: 'motors[i].velocity', error: 'unsupported index' },
      ],
    })));
    await (manager as any).startRemoteSampling(session, 0);
    expect(state.warning).toHaveBeenCalledOnce();
    expect(state.warning.mock.calls[0][0]).toContain('motors[i].velocity（unsupported index）');
    expect((manager as any).remoteSampling).toBe(true);
    expect((manager as any).remoteSession).toBe(session);
    expect(backend.execute).not.toHaveBeenCalled();
    manager.dispose();
  });

  it.each(['response', 'exception'])('reports an entirely rejected batch once via %s', async mode => {
    const { manager, session, backend } = fixture(vi.fn(async () => {
      if (mode === 'exception') throw new Error('No expressions can use fast data sampling: motors[i].velocity');
      return { ok: false, planned: [{ expression: 'motors[i].velocity', error: 'unsupported index' }] };
    }));
    await (manager as any).startRemoteSampling(session, 0);
    expect(state.warning).toHaveBeenCalledOnce();
    expect(state.warning.mock.calls[0][0]).toContain('motors[i].velocity');
    expect((manager as any).remoteSampling).toBe(false);
    expect((manager as any).timer).toBeNull();
    expect(backend.execute).not.toHaveBeenCalled();
    manager.dispose();
  });

  it.each(['generation', 'session'])('ignores obsolete startup errors after a %s change', async mode => {
    let reject!: (error: Error) => void;
    const pending = new Promise((_, fail) => { reject = fail; });
    const { manager, session } = fixture(vi.fn(() => pending));
    const starting = (manager as any).startRemoteSampling(session, 0);
    const current = mode === 'session' ? { type: 'orbit' } : session;
    if (mode === 'generation') (manager as any).samplingGeneration++;
    state.activeDebugSession = current;
    (manager as any).remoteSession = current;
    (manager as any).remoteSampling = true;
    reject(new Error('obsolete sampling error'));
    await starting;
    expect(state.warning).not.toHaveBeenCalled();
    expect((manager as any).remoteSampling).toBe(true);
    expect((manager as any).remoteSession).toBe(current);
    // Release test state without sending a stop request to the fake session.
    (manager as any).remoteSampling = false;
    manager.dispose();
  });
});

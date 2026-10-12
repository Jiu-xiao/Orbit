import { afterEach, describe, expect, it, vi } from 'vitest';
import { OzoneBackend } from '../ozone-backend/commander';
import { TargetState } from '../ozone-backend/types';
import { DapSession } from './dap-session';

function backendWithState(stateResult: any) {
  return {
    execute: vi.fn(async (command: { cmd: string }) => command.cmd === 'getTargetState'
      ? stateResult
      : { ok: true, data: null }),
    configureNativeSteps: vi.fn(),
    cancelFlash: vi.fn(),
    dispose: vi.fn(async () => {}),
  } as unknown as OzoneBackend;
}

function connectedSession(backend: OzoneBackend) {
  const session = new DapSession(backend);
  (session as any).phase = 'connected';
  (session as any).targetConnectionEstablished = true;
  return session;
}

afterEach(() => vi.useRealTimers());

describe('DapSession connection-loss cleanup', () => {
  it('terminates a running CMSIS-DAP session on NO_ACK from the existing run poll', async () => {
    vi.useFakeTimers();
    const backend = backendWithState({
      ok: false,
      error: 'DapAckNoAck: DAP_Transfer stopped after 0 of 1 transfers, status ACK=NO_ACK',
      errorCode: 'DapAckNoAck',
    });
    const session = connectedSession(backend);
    const internal = session as any;
    internal.targetRunning = true;
    internal.dataSamplingActive = true;
    const messages: any[] = [];
    session.on('send', message => messages.push(message));
    const shutdownRequested = vi.fn();
    session.on('shutdownRequested', shutdownRequested);
    internal.startPolling();
    internal.startConnectionMonitor();

    await vi.advanceTimersByTimeAsync(200);

    expect(backend.dispose).toHaveBeenCalledWith(false);
    await internal.terminationPromise;
    expect(internal.dataSamplingActive).toBe(false);
    expect(internal.phase).toBe('terminated');
    expect(messages.filter(message => message.event === 'terminated')).toHaveLength(1);
    expect(messages.find(message => message.event === 'terminated')?.body.reason).toBe('DapAckNoAck');
    expect(shutdownRequested).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(backend.execute).toHaveBeenCalledTimes(1);
    expect(backend.execute).not.toHaveBeenCalledWith({ cmd: 'disconnect' });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('also terminates a stopped session when its health monitor reports NO_ACK', async () => {
    vi.useFakeTimers();
    const backend = backendWithState({ ok: false, error: 'SWD NO_ACK', errorCode: 'DapAckNoAck' });
    const session = connectedSession(backend);
    const internal = session as any;
    internal.targetRunning = false;
    internal.startConnectionMonitor();
    await vi.advanceTimersByTimeAsync(500);
    expect(backend.dispose).toHaveBeenCalledWith(false);
    await internal.terminationPromise;
    expect(internal.phase).toBe('terminated');
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['DapAckWait', 'DapAckFault', 'RequestCancelled'])('does not classify %s as a cable disconnect', async errorCode => {
    const backend = backendWithState({ ok: false, error: errorCode, errorCode });
    const session = connectedSession(backend);
    for (let i = 0; i < 3; i++) await (session as any).queryTargetState('non-disconnect');
    expect(backend.dispose).not.toHaveBeenCalled();
    expect((session as any).terminationPromise).toBeNull();
  });

  it('does not issue another state RPC after terminating for NO_ACK', async () => {
    const backend = backendWithState({ ok: false, error: 'SWD NO_ACK', errorCode: 'DapAckNoAck' });
    const session = connectedSession(backend);
    await (session as any).queryTargetState('lost');
    expect(backend.dispose).toHaveBeenCalledWith(false);
    await (session as any).terminationPromise;
    await (session as any).queryTargetState('late-refresh');
    expect(backend.execute).toHaveBeenCalledTimes(1);
    expect(backend.dispose).toHaveBeenCalledOnce();
  });

  it('terminates once and awaits forced owner disposal on explicit disconnect', async () => {
    const backend = backendWithState({ ok: true, data: TargetState.Disconnected });
    const session = connectedSession(backend);
    const messages: any[] = [];
    session.on('send', message => messages.push(message));

    await (session as any).queryTargetState('test');
    await (session as any).terminationPromise;

    expect(backend.dispose).toHaveBeenCalledWith(false);
    expect(messages.filter(message => message.event === 'terminated')).toHaveLength(1);
    expect(messages.find(message => message.event === 'output')?.body.output).toContain('Target connection lost');
  });

  it('does not terminate on owner-unavailable responses before connect succeeds', async () => {
    const backend = backendWithState({
      ok: false,
      error: 'TargetOwnerUnavailable: owner unavailable',
      errorCode: 'TargetOwnerUnavailable',
    });
    const session = new DapSession(backend);

    await (session as any).queryTargetState('pre-launch');

    expect(backend.dispose).not.toHaveBeenCalled();
    expect((session as any).terminationPromise).toBeNull();
  });

  it('requires three consecutive soft state failures before terminating', async () => {
    const backend = backendWithState({
      ok: false,
      error: 'JLinkCallFailed: temporary state read failure',
      errorCode: 'JLinkCallFailed',
    });
    const session = connectedSession(backend);

    await (session as any).queryTargetState('test-1');
    await (session as any).queryTargetState('test-2');
    expect(backend.dispose).not.toHaveBeenCalled();
    await (session as any).queryTargetState('test-3');
    await (session as any).terminationPromise;

    expect(backend.dispose).toHaveBeenCalledWith(false);
  });

  it('waits for graceful disposal on a normal DAP disconnect', async () => {
    const backend = backendWithState({ ok: true, data: TargetState.Halted });
    const session = connectedSession(backend);
    const messages: any[] = [];
    session.on('send', message => messages.push(message));

    await (session as any).handleDisconnect({ type: 'request', seq: 7, command: 'disconnect' });

    expect(backend.execute).toHaveBeenCalledWith({ cmd: 'disconnect' });
    expect(backend.dispose).toHaveBeenCalledWith(true);
    expect(messages.some(message => message.type === 'response' && message.command === 'disconnect')).toBe(true);
    expect(messages.some(message => message.event === 'terminated')).toBe(true);
  });

  it('keeps the DAP termination sequence when owner teardown throws', async () => {
    const backend = backendWithState({ ok: true, data: TargetState.Halted });
    (backend as any).dispose = vi.fn(async () => {
      throw new Error('C++ J-Link helper did not exit after termination request (pid=3844)');
    });
    const session = connectedSession(backend);
    const messages: any[] = [];
    session.on('send', message => messages.push(message));
    const shutdownRequested = vi.fn();
    session.on('shutdownRequested', shutdownRequested);

    await (session as any).handleDisconnect({ type: 'request', seq: 9, command: 'disconnect' });

    expect(messages.some(message => message.type === 'response' && message.command === 'disconnect')).toBe(true);
    expect(messages.some(message => message.event === 'terminated')).toBe(true);
    expect(shutdownRequested).toHaveBeenCalledOnce();
    expect((session as any).phase).toBe('terminated');
  });

  it('resolves dispose when forced owner disposal throws', async () => {
    const backend = backendWithState({ ok: true, data: TargetState.Halted });
    (backend as any).dispose = vi.fn(async () => {
      throw new Error('CMSIS-DAP helper did not exit after termination request (pid=8120)');
    });
    const session = connectedSession(backend);

    await expect(session.dispose()).resolves.toBeUndefined();

    expect(backend.dispose).toHaveBeenCalledWith(false);
    expect((session as any).phase).toBe('terminated');
  });
});

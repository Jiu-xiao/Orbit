import { afterEach, describe, expect, it, vi } from 'vitest';
import { SvdBackgroundDownloader } from './svd-background-downloader';
import { SvdResolution, SvdResolverOptions } from './svd-resolver';

const options: SvdResolverOptions = { cacheRoot: 'C:\\orbit-test\\svd-cache', allowDownload: true };
const missing: SvdResolution = { source: 'unavailable', warning: 'offline' };
const ready: SvdResolution = { source: 'download', path: 'C:\\orbit-test\\STM32F103.svd' };

afterEach(() => vi.useRealTimers());

describe('SVD background download lifecycle', () => {
  it('coalesces simultaneous aliases of the same series into one download', async () => {
    let finish!: (result: SvdResolution) => void;
    const resolve = vi.fn(() => new Promise<SvdResolution>(fulfill => { finish = fulfill; }));
    const writeLog = vi.fn();
    const downloader = new SvdBackgroundDownloader(resolve, writeLog);

    const first = downloader.start('STM32F103C8', options);
    const second = downloader.start('STM32F103C8T6', options);

    expect(second).toBe(first);
    expect(resolve).toHaveBeenCalledTimes(1);
    finish(ready);
    await first;
    expect(writeLog.mock.calls.flat().join('\n')).toContain('下次启动自动使用缓存');
    downloader.dispose();
  });

  it('retries after a failed attempt and stops as soon as the cache is ready', async () => {
    vi.useFakeTimers();
    const resolve = vi.fn().mockResolvedValueOnce(missing).mockResolvedValueOnce(ready);
    const downloader = new SvdBackgroundDownloader(resolve, vi.fn());
    const completion = downloader.start('STM32F103C8T6', options);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(resolve).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await completion;
    expect(resolve).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
    downloader.dispose();
  });

  it('bounds repeated failures to three attempts without rejecting the session caller', async () => {
    vi.useFakeTimers();
    const resolve = vi.fn().mockResolvedValue(missing);
    const downloader = new SvdBackgroundDownloader(resolve, vi.fn());
    const completion = downloader.start('STM32F103C8T6', options);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(resolve).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(14_999);
    expect(resolve).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    await expect(completion).resolves.toBeUndefined();
    expect(resolve).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(0);
    downloader.dispose();
  });

  it('aborts a pending transfer when the extension is disposed and suppresses late results', async () => {
    let transferSignal!: AbortSignal;
    let finish!: (result: SvdResolution) => void;
    const resolve = vi.fn((_device: string, opts: SvdResolverOptions) => {
      transferSignal = opts.signal!;
      return new Promise<SvdResolution>(fulfill => { finish = fulfill; });
    });
    const writeLog = vi.fn();
    const downloader = new SvdBackgroundDownloader(resolve, writeLog);
    const completion = downloader.start('STM32F103C8T6', options);
    downloader.dispose();
    expect(transferSignal.aborted).toBe(true);
    finish(ready);
    await completion;
    expect(writeLog.mock.calls.flat().join('\n')).not.toContain('background ready');
    await downloader.start('STM32F103C8T6', options);
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  it('cancels retry timers on disposal without issuing another request', async () => {
    vi.useFakeTimers();
    const resolve = vi.fn().mockResolvedValue(missing);
    const downloader = new SvdBackgroundDownloader(resolve, vi.fn());
    const completion = downloader.start('STM32F103C8T6', options);
    await vi.advanceTimersByTimeAsync(1);
    expect(vi.getTimerCount()).toBe(1);
    downloader.dispose();
    await completion;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('contains thrown network failures and honours disabled automatic downloads', async () => {
    vi.useFakeTimers();
    const resolve = vi.fn().mockRejectedValue(new Error('network failed'));
    const downloader = new SvdBackgroundDownloader(resolve, vi.fn());
    await downloader.start('STM32F103C8T6', { ...options, allowDownload: false });
    await downloader.start('unrecognised-device', options);
    expect(resolve).not.toHaveBeenCalled();
    const completion = downloader.start('STM32F103C8T6', options);
    await vi.advanceTimersByTimeAsync(20_000);
    await expect(completion).resolves.toBeUndefined();
    expect(resolve).toHaveBeenCalledTimes(3);
    downloader.dispose();
  });
});

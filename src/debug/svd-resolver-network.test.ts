import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as https from 'https';
import * as os from 'os';
import * as path from 'path';
import AdmZip from 'adm-zip';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveSvdForDevice } from './svd-resolver';

vi.mock('https', () => ({ get: vi.fn() }));

interface PendingDownload {
  url: URL;
  signal?: AbortSignal;
  aborted: boolean;
  respond(status: number, headers?: Record<string, string>): EventEmitter;
}

let cacheRoot: string;
const downloads: PendingDownload[] = [];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  cacheRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-svd-network-'));
  // No socket/response is emitted until the test asks. This reproduces a stalled
  // DNS/connect/TLS phase, where a socket inactivity callback cannot rescue launch.
  vi.mocked(https.get).mockImplementation(((url: URL, optionsOrCallback: any, callback?: any) => {
    const options = typeof optionsOrCallback === 'function' ? {} : optionsOrCallback;
    const onResponse = callback ?? optionsOrCallback;
    const request = new EventEmitter() as EventEmitter & { setTimeout: ReturnType<typeof vi.fn> };
    request.setTimeout = vi.fn();
    const download: PendingDownload = {
      url,
      signal: options.signal,
      aborted: false,
      respond(status, headers = {}) {
        const response = Object.assign(new EventEmitter(), {
          statusCode: status,
          headers,
          resume: vi.fn(),
        });
        response.once('end', () => options.signal?.removeEventListener('abort', onAbort));
        onResponse(response);
        return response;
      },
    };
    const onAbort = () => {
      download.aborted = true;
      request.emit('error', Object.assign(new Error('request aborted'), { code: 'ABORT_ERR' }));
    };
    options.signal?.addEventListener('abort', onAbort, { once: true });
    downloads.push(download);
    return request;
  }) as unknown as typeof https.get);
});

afterEach(() => {
  vi.useRealTimers();
  vi.resetAllMocks();
  downloads.splice(0);
  fs.rmSync(cacheRoot, { recursive: true, force: true });
});

function resolve() {
  return resolveSvdForDevice('STM32F103C8T6', { cacheRoot, localPackRoots: [] });
}

async function waitForDownloads(count: number) {
  await vi.waitFor(() => expect(downloads).toHaveLength(count));
}

function complete(download: PendingDownload, body: Buffer) {
  const response = download.respond(200);
  response.emit('data', body);
  response.emit('end');
}

describe('SVD network launch deadline', () => {
  it('cancels the real download path when extension disposal aborts its parent signal', async () => {
    const controller = new AbortController();
    const result = resolveSvdForDevice('STM32F103C8T6', {
      cacheRoot, localPackRoots: [], signal: controller.signal,
    });
    await waitForDownloads(1);
    controller.abort(new Error('extension disposed'));
    expect(await result).toMatchObject({ source: 'unavailable' });
    expect(downloads[0].aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('returns unavailable after 15 seconds even when no socket or response arrives', async () => {
    let settled = false;
    const result = resolve().then(value => { settled = true; return value; });
    await waitForDownloads(1);

    await vi.advanceTimersByTimeAsync(15_000);

    expect(settled).toBe(true);
    expect(downloads[0].aborted).toBe(true);
    expect(await result).toMatchObject({ source: 'unavailable' });
    expect((await result).warning).toContain('总时限 15 秒');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('shares the deadline across redirects, metadata and pack instead of restarting it', async () => {
    let settled = false;
    const result = resolve().then(value => { settled = true; return value; });
    await waitForDownloads(1);
    await vi.advanceTimersByTimeAsync(8_000);
    const redirect = downloads[0].respond(302, { location: '/pack/redirected.pdsc' });
    redirect.emit('end');
    await waitForDownloads(2);
    await vi.advanceTimersByTimeAsync(3_000);
    complete(downloads[1], Buffer.from('<release version="2.4.1"/>'));
    await waitForDownloads(3);

    await vi.advanceTimersByTimeAsync(4_000);

    expect(settled).toBe(true);
    expect(downloads[2].url.pathname).toContain('Keil.STM32F1xx_DFP.2.4.1.pack');
    expect(downloads[2].signal).toBe(downloads[0].signal);
    expect(downloads[2].aborted).toBe(true);
    expect(await result).toMatchObject({ source: 'unavailable' });
    expect(fs.readdirSync(cacheRoot)).toEqual([]);
  });

  it('does not extend the deadline when an unfinished response keeps trickling bytes', async () => {
    let settled = false;
    const result = resolve().then(value => { settled = true; return value; });
    await waitForDownloads(1);
    complete(downloads[0], Buffer.from('<release version="2.4.1"/>'));
    await waitForDownloads(2);
    const response = downloads[1].respond(200);
    for (let i = 0; i < 4; i++) {
      await vi.advanceTimersByTimeAsync(3_000);
      response.emit('data', Buffer.from([0]));
    }
    await vi.advanceTimersByTimeAsync(3_000);

    expect(settled).toBe(true);
    expect(downloads[1].aborted).toBe(true);
    expect(await result).toMatchObject({ source: 'unavailable' });
    expect(fs.readdirSync(cacheRoot)).toEqual([]);
  });

  it('still caches a successful download and clears the deadline timer', async () => {
    const result = resolve();
    await waitForDownloads(1);
    complete(downloads[0], Buffer.from('<release version="2.4.1"/>'));
    await waitForDownloads(2);
    const pack = new AdmZip();
    pack.addFile('SVD/STM32F103.svd', Buffer.from('<f103/>'));
    complete(downloads[1], pack.toBuffer());

    const resolution = await result;
    expect(resolution.source).toBe('download');
    expect(fs.readFileSync(resolution.path!, 'utf8')).toBe('<f103/>');
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(downloads.every(download => !download.aborted)).toBe(true);
  });
});

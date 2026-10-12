import * as path from 'path';
import { log } from '../utils/logger';
import { identifySvdDevice, resolveSvdForDevice, SvdResolverOptions } from './svd-resolver';

const RETRY_DELAYS_MS = [5_000, 15_000];

interface DownloadJob {
  controller: AbortController;
  completion: Promise<void>;
}

/** Extension-host file/network work only: never owns or changes a target/session. */
export class SvdBackgroundDownloader {
  private readonly jobs = new Map<string, DownloadJob>();
  private disposed = false;

  constructor(
    private readonly resolve: typeof resolveSvdForDevice = resolveSvdForDevice,
    private readonly writeLog: (message: string) => void = log.dap,
  ) {}

  start(device: string, options: SvdResolverOptions): Promise<void> {
    const identity = identifySvdDevice(device);
    if (this.disposed || options.allowDownload === false || !identity) return Promise.resolve();
    const key = `${path.resolve(options.cacheRoot).toLowerCase()}|${identity.series}`;
    const existing = this.jobs.get(key);
    if (existing) return existing.completion;

    const controller = new AbortController();
    const completion = this.run(device, options, controller.signal)
      .catch(error => {
        if (!controller.signal.aborted) {
          this.writeLog(`[svd] background device=${device} error=${String(error)}; 调试继续`);
        }
      })
      .finally(() => {
        if (this.jobs.get(key)?.controller === controller) this.jobs.delete(key);
      });
    this.jobs.set(key, { controller, completion });
    return completion;
  }

  dispose(): void {
    this.disposed = true;
    for (const job of this.jobs.values()) job.controller.abort(new Error('Orbit extension disposed'));
    this.jobs.clear();
  }

  private async run(device: string, options: SvdResolverOptions, signal: AbortSignal): Promise<void> {
    const attempts = RETRY_DELAYS_MS.length + 1;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      if (signal.aborted) return;
      this.writeLog(`[svd] background device=${device} attempt=${attempt}/${attempts}`);
      let warning: string | undefined;
      try {
        const result = await this.resolve(device, { ...options, signal });
        if (signal.aborted) return;
        if (result.path) {
          this.writeLog(`[svd] background ready device=${device} path=${result.path} source=${result.source}; 下次启动自动使用缓存`);
          return;
        }
        warning = result.warning;
      } catch (error) {
        if (signal.aborted) return;
        warning = error instanceof Error ? error.message : String(error);
      }
      this.writeLog(`[svd] background unavailable device=${device} attempt=${attempt}/${attempts} error=${warning ?? 'SVD unavailable'}; 调试继续`);
      if (attempt < attempts && !await this.waitForRetry(RETRY_DELAYS_MS[attempt - 1], signal)) return;
    }
  }

  private waitForRetry(delayMs: number, signal: AbortSignal): Promise<boolean> {
    if (signal.aborted) return Promise.resolve(false);
    return new Promise(resolve => {
      const finish = (retry: boolean) => {
        clearTimeout(timer);
        signal.removeEventListener('abort', cancel);
        resolve(retry);
      };
      const cancel = () => finish(false);
      const timer = setTimeout(() => finish(true), delayMs);
      signal.addEventListener('abort', cancel, { once: true });
    });
  }
}

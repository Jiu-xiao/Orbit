import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { randomUUID } from 'crypto';

/** Disk-backed working data belongs to this host, never to the archive list. */
export class TimelineTemporaryCache {
  readonly directory: string;
  readonly ready: Promise<void>;

  constructor(private root = path.join(os.tmpdir(), 'orbit-timeline-cache')) {
    this.root = path.resolve(root);
    this.directory = path.join(this.root, process.pid + '-' + randomUUID());
    this.ready = this.removeOrphans();
  }

  private async removeOrphans() {
    const entries = await fs.readdir(this.root, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const match = /^([1-9]\d*)-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.exec(entry.name);
      if (!match || !entry.isDirectory() || entry.isSymbolicLink()) continue;
      try { process.kill(Number(match[1]), 0); continue; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') continue; }
      // Only our named direct children with a dead owner are disposable.
      const target = path.resolve(this.root, entry.name);
      if (path.dirname(target) === this.root) await fs.rm(target, { recursive: true, force: true }).catch(() => {});
    }
  }

  async removeRecord(directory: string) {
    const target = path.resolve(directory);
    if (path.dirname(target) !== this.directory) throw new Error('Timeline 缓存清理路径不合法');
    await fs.rm(target, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 }).catch(() => {});
  }

  async dispose() {
    await this.ready;
    const target = path.resolve(this.directory);
    if (path.dirname(target) !== this.root) throw new Error('Timeline 缓存清理路径不合法');
    await fs.rm(target, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 }).catch(() => {});
  }
}

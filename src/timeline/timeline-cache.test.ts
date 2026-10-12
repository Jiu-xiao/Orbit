import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { TimelineTemporaryCache } from './timeline-cache';

let root: string;
beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), 'orbit-cache-test-')); });
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

describe('Timeline disposable working data', () => {
  it('removes crash leftovers while preserving live hosts and unrelated directories', async () => {
    const orphan = path.join(root, '2147483647-' + randomUUID());
    const active = path.join(root, process.pid + '-' + randomUUID());
    const unrelated = path.join(root, 'saved-records');
    for (const directory of [orphan, active, unrelated]) { await fs.mkdir(directory); await fs.writeFile(path.join(directory, 'record.csv'), 'data'); }
    const cache = new TimelineTemporaryCache(root);
    await cache.ready;
    expect(await fs.stat(orphan).catch(() => null)).toBeNull();
    expect(await fs.readFile(path.join(active, 'record.csv'), 'utf8')).toBe('data');
    expect(await fs.readFile(path.join(unrelated, 'record.csv'), 'utf8')).toBe('data');
    await cache.dispose();
  });
  it('deletes a closed record and rejects cleanup outside its own cache', async () => {
    const cache = new TimelineTemporaryCache(root);
    await cache.ready;
    const record = path.join(cache.directory, randomUUID());
    await fs.mkdir(record, { recursive: true }); await fs.writeFile(path.join(record, 'record.csv'), 'temporary');
    const archive = path.join(root, 'archive');
    await fs.mkdir(archive); await fs.writeFile(path.join(archive, 'saved.csv'), 'manual');
    await expect(cache.removeRecord(archive)).rejects.toThrow('清理路径不合法');
    await cache.removeRecord(record);
    expect(await fs.stat(record).catch(() => null)).toBeNull();
    await cache.dispose();
    expect(await fs.stat(cache.directory).catch(() => null)).toBeNull();
    expect(await fs.readFile(path.join(archive, 'saved.csv'), 'utf8')).toBe('manual');
  });
});

import * as fs from 'fs';
import * as https from 'https';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OzoneDebugConfigurationProvider } from './ozone-debug-config';

const state = vi.hoisted(() => ({
  settings: {} as Record<string, unknown>,
  workspaceFolders: [] as Array<{ uri: { fsPath: string } }>,
  update: vi.fn(),
}));
vi.mock('vscode', () => ({
  ConfigurationTarget: { Workspace: 2 },
  workspace: {
    get workspaceFolders() { return state.workspaceFolders; },
    getConfiguration: () => ({
      get: (key: string, fallback: unknown) => state.settings[key] ?? fallback,
      update: state.update,
    }),
  },
}));
vi.mock('https', () => ({ get: vi.fn() }));
vi.mock('../utils/logger', () => ({ log: { dap: vi.fn() } }));

let root: string;
let provider: OzoneDebugConfigurationProvider;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-launch-svd-'));
  vi.stubEnv('CMSIS_PACK_ROOT', '');
  vi.stubEnv('LOCALAPPDATA', root);
  state.settings = { svdAutoDownload: true };
  state.workspaceFolders = [{ uri: { fsPath: root } }];
  state.update.mockClear();
  provider = new OzoneDebugConfigurationProvider(root);
  vi.mocked(https.get).mockClear();
});

afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(root, { recursive: true, force: true });
});

function launch(extra: Record<string, unknown> = {}) {
  return provider.resolveDebugConfiguration(undefined, {
    type: 'orbit', name: 'F103', request: 'launch', program: 'firmware.elf',
    device: 'STM32F103C8T6', probe: 'cmsis-dap', ...extra,
  });
}

const manifest = JSON.parse(fs.readFileSync(path.resolve('package.json'), 'utf8'));
const orbitDebugger = manifest.contributes.debuggers.find((debuggerConfig: any) => debuggerConfig.type === 'orbit');

describe('Orbit minimal launch configuration', () => {
  it('contributes a C/C++ debugger with a chip-only initial configuration and an Add Configuration snippet', () => {
    expect(orbitDebugger.languages).toEqual(expect.arrayContaining(['c', 'cpp']));
    expect(orbitDebugger.initialConfigurations).toHaveLength(1);
    const initial = orbitDebugger.initialConfigurations[0];
    expect(Object.keys(initial).sort()).toEqual(['device', 'name', 'request', 'type']);
    expect(initial).toMatchObject({ type: 'orbit', request: 'launch', device: '' });
    expect(orbitDebugger.configurationSnippets[0].body).toMatchObject({
      type: 'orbit', request: 'launch', device: expect.stringContaining('${1:'),
    });
  });

  it.each(['', '   '])('rejects an unfilled chip before resolving defaults or files (%j)', async device => {
    await expect(provider.resolveDebugConfiguration(undefined, {
      ...orbitDebugger.initialConfigurations[0], device,
    })).rejects.toThrow('请先在 launch.json 的 device 中填写芯片型号');
    expect(state.update).not.toHaveBeenCalled();
    expect(https.get).not.toHaveBeenCalled();
  });

  it.each([
    ['build/Debug', 'firmware.elf'],
    ['build/Release', 'firmware.axf'],
    ['build', 'firmware.elf'],
  ])('resolves the generated template after filling only device with firmware in %s', async (buildDir, filename) => {
    const program = path.join(root, buildDir, filename);
    fs.mkdirSync(path.dirname(program), { recursive: true });
    fs.writeFileSync(program, 'test firmware');
    const config = await provider.resolveDebugConfiguration({ uri: { fsPath: root } } as any, {
      ...orbitDebugger.initialConfigurations[0], device: 'STM32F407VET6',
    });
    expect(config).toMatchObject({
      type: 'orbit', request: 'launch', device: 'STM32F407VET6',
      deviceName: 'STM32F407VET6', program, interface: 'SWD', speedKHz: 4000,
      probe: 'auto', flashBeforeDebug: true,
    });
    expect(https.get).not.toHaveBeenCalled();
  });

  it('selects firmware from the launch folder instead of the first folder in a multi-root workspace', async () => {
    const selectedRoot = path.join(root, 'second-project');
    for (const workspaceRoot of [root, selectedRoot]) {
      fs.mkdirSync(path.join(workspaceRoot, 'build/Debug'), { recursive: true });
      fs.writeFileSync(path.join(workspaceRoot, 'build/Debug/firmware.elf'), 'test firmware');
    }
    const config = await provider.resolveDebugConfiguration({ uri: { fsPath: selectedRoot } } as any, {
      ...orbitDebugger.initialConfigurations[0], device: 'STM32F407VET6',
    });
    expect(config.program).toBe(path.join(selectedRoot, 'build/Debug/firmware.elf'));
  });

  it('preserves an explicitly configured firmware path and chip defaults for existing configurations', async () => {
    state.settings.defaultDevice = 'STM32F103C8T6';
    const config = await provider.resolveDebugConfiguration(undefined, {
      type: 'orbit', request: 'launch', name: 'Existing', program: 'custom.elf',
    });
    expect(config).toMatchObject({ device: 'STM32F103C8T6', program: 'custom.elf' });
    expect(state.update).not.toHaveBeenCalled();
  });
});

describe('Orbit launch without a network dependency', () => {
  it('returns a complete launch configuration without starting HTTPS when local SVD is absent', async () => {
    const config = await launch();
    expect(config).toMatchObject({ device: 'STM32F103C8T6', probe: 'cmsis-dap', runToEntryPoint: 'main' });
    expect(config.svdFile).toBeUndefined();
    expect(config.svdPath).toBeUndefined();
    expect(https.get).not.toHaveBeenCalled();
  });

  it('uses the SVD cached by an earlier background download on the next launch', async () => {
    const svd = path.join(root, 'Keil.STM32F1xx_DFP', '2.4.1', 'STM32F103.svd');
    fs.mkdirSync(path.dirname(svd), { recursive: true });
    fs.writeFileSync(svd, '<f103/>');
    const config = await launch();
    expect(config).toMatchObject({ svdFile: svd, svdPath: svd });
    expect(https.get).not.toHaveBeenCalled();
  });

  it.each(['svdFile', 'svdPath'])('preserves the explicit %s alias without any automatic lookup', async field => {
    const svd = 'C:\\explicit\\custom.svd';
    const config = await launch({ [field]: svd });
    expect(config).toMatchObject({ svdFile: svd, svdPath: svd });
    expect(https.get).not.toHaveBeenCalled();
  });

  it('still uses the workspace SVD when automatic network downloading is disabled', async () => {
    state.settings.svdAutoDownload = false;
    const svd = path.join(root, 'STM32F103.svd');
    fs.writeFileSync(svd, '<workspace/>');
    const config = await provider.resolveDebugConfiguration({ uri: { fsPath: root } } as any, {
      type: 'orbit', name: 'F103', request: 'launch', program: 'firmware.elf', device: 'STM32F103C8',
    });
    expect(config.svdFile).toBe(svd);
    expect(https.get).not.toHaveBeenCalled();
  });
});

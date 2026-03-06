import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { PluginRegistry } from '../plugin-registry.js';
import type { PluginContext, BrainPlugin } from '../types.js';

function createMockContext(name: string): PluginContext {
  return {
    dataDir: path.join(os.tmpdir(), 'brain-test-plugins', name),
    log: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
    callBrain: vi.fn().mockResolvedValue({}),
    notify: vi.fn().mockResolvedValue(undefined),
  };
}

describe('PluginRegistry', () => {
  let tmpDir: string;
  let registry: PluginRegistry;

  beforeEach(() => {
    tmpDir = path.join(os.tmpdir(), `brain-plugin-test-${Date.now()}`);
    fs.mkdirSync(tmpDir, { recursive: true });
    registry = new PluginRegistry(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates plugin directory if it does not exist', () => {
    const newDir = path.join(tmpDir, 'subdir');
    const reg = new PluginRegistry(newDir);
    expect(fs.existsSync(newDir)).toBe(true);
  });

  it('starts with no plugins', () => {
    expect(registry.size).toBe(0);
    expect(registry.list()).toEqual([]);
    expect(registry.getRoutes()).toEqual([]);
    expect(registry.getTools()).toEqual([]);
  });

  it('has() returns false for unknown plugin', () => {
    expect(registry.has('nonexistent')).toBe(false);
  });

  it('get() returns null for unknown plugin', () => {
    expect(registry.get('nonexistent')).toBeNull();
  });

  it('loadAll with empty directory loads nothing', async () => {
    await registry.loadAll((name) => createMockContext(name));
    expect(registry.size).toBe(0);
  });

  it('loadAll skips directories without package.json', async () => {
    fs.mkdirSync(path.join(tmpDir, 'empty-dir'));
    await registry.loadAll((name) => createMockContext(name));
    expect(registry.size).toBe(0);
  });

  it('loadAll skips packages without brainPlugin flag', async () => {
    const pluginDir = path.join(tmpDir, 'normal-pkg');
    fs.mkdirSync(pluginDir);
    fs.writeFileSync(path.join(pluginDir, 'package.json'), JSON.stringify({
      name: 'normal-pkg',
      version: '1.0.0',
    }));
    fs.writeFileSync(path.join(pluginDir, 'index.js'), 'module.exports = {}');

    await registry.loadAll((name) => createMockContext(name));
    expect(registry.size).toBe(0);
  });

  it('unloadPlugin returns false for unknown plugin', async () => {
    expect(await registry.unloadPlugin('nonexistent')).toBe(false);
  });

  it('runCycle does nothing with no plugins', async () => {
    await expect(registry.runCycle(1)).resolves.toBeUndefined();
  });

  it('list returns empty array when no plugins loaded', () => {
    expect(registry.list()).toEqual([]);
  });

  it('getRoutes returns plugin-prefixed routes', () => {
    // Manually inject a plugin for testing
    const plugin: BrainPlugin = {
      name: 'test-plugin',
      version: '1.0.0',
      routes: [
        { method: 'test.hello', handler: () => ({ hello: 'world' }) },
      ],
    };

    // Access internal map (testing only)
    (registry as any).plugins.set('test-plugin', {
      plugin,
      path: '/fake',
      loadedAt: new Date().toISOString(),
      error: null,
    });

    const routes = registry.getRoutes();
    expect(routes).toHaveLength(1);
    expect(routes[0].plugin).toBe('test-plugin');
    expect(routes[0].method).toBe('test.hello');
  });

  it('getTools returns plugin-prefixed tools', () => {
    const plugin: BrainPlugin = {
      name: 'test-plugin',
      version: '1.0.0',
      tools: [
        { name: 'test_tool', description: 'A test', schema: {}, handler: () => 'ok' },
      ],
    };

    (registry as any).plugins.set('test-plugin', {
      plugin,
      path: '/fake',
      loadedAt: new Date().toISOString(),
      error: null,
    });

    const tools = registry.getTools();
    expect(tools).toHaveLength(1);
    expect(tools[0].plugin).toBe('test-plugin');
    expect(tools[0].name).toBe('test_tool');
  });

  it('runCycle calls onCycle for loaded plugins', async () => {
    const onCycle = vi.fn();
    const plugin: BrainPlugin = {
      name: 'cycle-plugin',
      version: '1.0.0',
      onCycle,
    };

    (registry as any).plugins.set('cycle-plugin', {
      plugin,
      path: '/fake',
      loadedAt: new Date().toISOString(),
      error: null,
    });

    await registry.runCycle(42);
    expect(onCycle).toHaveBeenCalledWith(42);
  });

  it('runCycle catches errors from plugins', async () => {
    const plugin: BrainPlugin = {
      name: 'bad-plugin',
      version: '1.0.0',
      onCycle: () => { throw new Error('boom'); },
    };

    (registry as any).plugins.set('bad-plugin', {
      plugin,
      path: '/fake',
      loadedAt: new Date().toISOString(),
      error: null,
    });

    // Should not throw
    await expect(registry.runCycle(1)).resolves.toBeUndefined();
  });

  it('unloadPlugin calls onUnload and removes', async () => {
    const onUnload = vi.fn();
    const plugin: BrainPlugin = {
      name: 'unload-test',
      version: '1.0.0',
      onUnload,
    };

    (registry as any).plugins.set('unload-test', {
      plugin,
      path: '/fake',
      loadedAt: new Date().toISOString(),
      error: null,
    });

    expect(registry.has('unload-test')).toBe(true);
    await registry.unloadPlugin('unload-test');
    expect(registry.has('unload-test')).toBe(false);
    expect(onUnload).toHaveBeenCalled();
  });
});

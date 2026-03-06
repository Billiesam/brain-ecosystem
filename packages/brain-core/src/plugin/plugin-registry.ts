import fs from 'node:fs';
import path from 'node:path';
import { getLogger } from '../utils/logger.js';
import type {
  BrainPlugin, PluginContext, PluginRecord,
  PluginRouteDefinition, PluginToolDefinition,
} from './types.js';

/**
 * PluginRegistry — discovers, loads, and manages Brain plugins.
 * Plugins are npm packages with `brainPlugin: true` in package.json,
 * or local directories under ~/.brain/plugins/.
 */
export class PluginRegistry {
  private plugins: Map<string, LoadedPlugin> = new Map();
  private logger = getLogger();
  private pluginDir: string;

  constructor(pluginDir: string) {
    this.pluginDir = pluginDir;
    fs.mkdirSync(pluginDir, { recursive: true });
  }

  /** Load all plugins from the plugin directory. */
  async loadAll(contextFactory: (name: string) => PluginContext): Promise<void> {
    const entries = this.discoverPlugins();

    for (const entry of entries) {
      try {
        await this.loadPlugin(entry.path, contextFactory(entry.name));
      } catch (err) {
        this.logger.error(`Failed to load plugin ${entry.name}: ${(err as Error).message}`);
      }
    }

    this.logger.info(`Loaded ${this.plugins.size}/${entries.length} plugins`);
  }

  /** Load a single plugin by directory path. */
  async loadPlugin(pluginPath: string, context: PluginContext): Promise<boolean> {
    try {
      const manifestPath = path.join(pluginPath, 'package.json');
      if (!fs.existsSync(manifestPath)) {
        this.logger.warn(`No package.json in ${pluginPath}`);
        return false;
      }

      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
      if (!manifest.brainPlugin) {
        this.logger.debug(`${manifest.name} is not a brain plugin (missing brainPlugin flag)`);
        return false;
      }

      const mainFile = path.join(pluginPath, manifest.main || 'index.js');
      if (!fs.existsSync(mainFile)) {
        this.logger.error(`Plugin entry point not found: ${mainFile}`);
        return false;
      }

      // Dynamic import
      const mod = await import(`file://${mainFile.replace(/\\/g, '/')}`);
      const plugin: BrainPlugin = mod.default ?? mod;

      if (!plugin.name || !plugin.version) {
        this.logger.error(`Plugin at ${pluginPath} missing name or version`);
        return false;
      }

      // Prevent duplicate
      if (this.plugins.has(plugin.name)) {
        this.logger.warn(`Plugin ${plugin.name} already loaded, skipping duplicate`);
        return false;
      }

      // Lifecycle: onLoad
      if (plugin.onLoad) {
        await plugin.onLoad(context);
      }

      this.plugins.set(plugin.name, {
        plugin,
        path: pluginPath,
        loadedAt: new Date().toISOString(),
        error: null,
      });

      this.logger.info(`Plugin loaded: ${plugin.name} v${plugin.version}`);
      return true;
    } catch (err) {
      this.logger.error(`Plugin load failed at ${pluginPath}: ${(err as Error).message}`);
      return false;
    }
  }

  /** Unload a plugin by name. */
  async unloadPlugin(name: string): Promise<boolean> {
    const loaded = this.plugins.get(name);
    if (!loaded) return false;

    try {
      if (loaded.plugin.onUnload) {
        await loaded.plugin.onUnload();
      }
    } catch (err) {
      this.logger.error(`Error during ${name} unload: ${(err as Error).message}`);
    }

    this.plugins.delete(name);
    this.logger.info(`Plugin unloaded: ${name}`);
    return true;
  }

  /** Run onCycle for all loaded plugins. */
  async runCycle(cycleCount: number): Promise<void> {
    for (const [name, loaded] of this.plugins) {
      if (loaded.plugin.onCycle) {
        try {
          await loaded.plugin.onCycle(cycleCount);
        } catch (err) {
          this.logger.error(`Plugin ${name} cycle error: ${(err as Error).message}`);
        }
      }
    }
  }

  /** Get all registered IPC routes from plugins. */
  getRoutes(): Array<{ plugin: string } & PluginRouteDefinition> {
    const routes: Array<{ plugin: string } & PluginRouteDefinition> = [];
    for (const [name, loaded] of this.plugins) {
      if (loaded.plugin.routes) {
        for (const route of loaded.plugin.routes) {
          routes.push({ plugin: name, ...route });
        }
      }
    }
    return routes;
  }

  /** Get all registered MCP tools from plugins. */
  getTools(): Array<{ plugin: string } & PluginToolDefinition> {
    const tools: Array<{ plugin: string } & PluginToolDefinition> = [];
    for (const [name, loaded] of this.plugins) {
      if (loaded.plugin.tools) {
        for (const tool of loaded.plugin.tools) {
          tools.push({ plugin: name, ...tool });
        }
      }
    }
    return tools;
  }

  /** List all plugins (loaded + discovered). */
  list(): PluginRecord[] {
    const records: PluginRecord[] = [];

    for (const [, loaded] of this.plugins) {
      records.push({
        name: loaded.plugin.name,
        version: loaded.plugin.version,
        description: loaded.plugin.description ?? '',
        enabled: true,
        loadedAt: loaded.loadedAt,
        error: loaded.error,
      });
    }

    return records;
  }

  /** Get a loaded plugin by name. */
  get(name: string): BrainPlugin | null {
    return this.plugins.get(name)?.plugin ?? null;
  }

  /** Check if a plugin is loaded. */
  has(name: string): boolean {
    return this.plugins.has(name);
  }

  /** Get plugin count. */
  get size(): number {
    return this.plugins.size;
  }

  /** Discover plugins in the plugin directory. */
  private discoverPlugins(): Array<{ name: string; path: string }> {
    const results: Array<{ name: string; path: string }> = [];

    if (!fs.existsSync(this.pluginDir)) return results;

    const entries = fs.readdirSync(this.pluginDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const pluginPath = path.join(this.pluginDir, entry.name);
      const manifestPath = path.join(pluginPath, 'package.json');

      if (fs.existsSync(manifestPath)) {
        try {
          const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
          if (manifest.brainPlugin) {
            results.push({ name: manifest.name || entry.name, path: pluginPath });
          }
        } catch {
          // Invalid manifest, skip
        }
      }
    }

    return results;
  }
}

interface LoadedPlugin {
  plugin: BrainPlugin;
  path: string;
  loadedAt: string;
  error: string | null;
}

import type { StrategyForge, Strategy } from './strategy-forge.js';

// ── Types ──────────────────────────────────────────────

export interface StrategyExportFormat {
  version: string;
  exportedAt: string;
  source: string;
  strategy: {
    name: string;
    type: Strategy['type'];
    description: string;
    rules: Strategy['rules'];
    performance: Strategy['performance'];
    lineage: { parentId: number | null; generation: number };
  };
}

// ── Exporter ───────────────────────────────────────────

export class StrategyExporter {
  constructor(private forge: StrategyForge) {}

  /** Export a strategy to a portable JSON string. */
  export(strategyId: number): string {
    const strategy = this.forge.getStrategy(strategyId);
    if (!strategy) throw new Error(`Strategy #${strategyId} not found`);

    const exportData: StrategyExportFormat = {
      version: '1.0.0',
      exportedAt: new Date().toISOString(),
      source: strategy.brainName,
      strategy: {
        name: strategy.name,
        type: strategy.type,
        description: strategy.description,
        rules: strategy.rules,
        performance: strategy.performance,
        lineage: {
          parentId: strategy.parentId ?? null,
          generation: this.countGenerations(strategy),
        },
      },
    };

    return JSON.stringify(exportData, null, 2);
  }

  /** Export as parsed object. */
  exportObject(strategyId: number): StrategyExportFormat {
    return JSON.parse(this.export(strategyId));
  }

  private countGenerations(strategy: Strategy): number {
    let gen = 0;
    let current = strategy;
    while (current.parentId) {
      const parent = this.forge.getStrategy(current.parentId);
      if (!parent) break;
      gen++;
      current = parent;
    }
    return gen;
  }
}

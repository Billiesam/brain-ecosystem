import type { StrategyForge, Strategy } from './strategy-forge.js';
import type { StrategyExportFormat } from './strategy-exporter.js';

// ── Types ──────────────────────────────────────────────

export interface ImportResult {
  success: boolean;
  strategyId?: number;
  strategyName?: string;
  error?: string;
}

// ── Importer ───────────────────────────────────────────

export class StrategyImporter {
  constructor(private forge: StrategyForge) {}

  /** Import a strategy from JSON string. Returns the created strategy or error. */
  import(json: string): ImportResult {
    let data: StrategyExportFormat;
    try {
      data = JSON.parse(json);
    } catch {
      return { success: false, error: 'Invalid JSON' };
    }

    // Schema validation
    const validation = this.validate(data);
    if (!validation.valid) {
      return { success: false, error: validation.error };
    }

    // Check for duplicate name
    const existing = this.forge.getAll(1000);
    if (existing.some(s => s.name === data.strategy.name)) {
      return { success: false, error: `Strategy name "${data.strategy.name}" already exists` };
    }

    // Validate rule format
    for (const rule of data.strategy.rules) {
      if (!rule.condition || !rule.action) {
        return { success: false, error: 'Each rule must have a condition and action' };
      }
    }

    // Create as draft
    const strategy = this.forge.importStrategy(
      data.strategy.type,
      data.strategy.name,
      data.strategy.description,
      data.strategy.rules,
    );

    return {
      success: true,
      strategyId: strategy.id,
      strategyName: strategy.name,
    };
  }

  /** Validate the export format schema. */
  private validate(data: unknown): { valid: boolean; error?: string } {
    if (!data || typeof data !== 'object') {
      return { valid: false, error: 'Data must be an object' };
    }

    const d = data as Record<string, unknown>;

    if (!d.version || typeof d.version !== 'string') {
      return { valid: false, error: 'Missing or invalid version field' };
    }

    if (!d.strategy || typeof d.strategy !== 'object') {
      return { valid: false, error: 'Missing strategy field' };
    }

    const s = d.strategy as Record<string, unknown>;

    if (!s.name || typeof s.name !== 'string') {
      return { valid: false, error: 'Missing or invalid strategy.name' };
    }

    if (!s.type || typeof s.type !== 'string') {
      return { valid: false, error: 'Missing or invalid strategy.type' };
    }

    const validTypes = ['trade', 'campaign', 'research', 'optimization'];
    if (!validTypes.includes(s.type as string)) {
      return { valid: false, error: `Invalid strategy.type: ${s.type}. Must be one of: ${validTypes.join(', ')}` };
    }

    if (!Array.isArray(s.rules)) {
      return { valid: false, error: 'strategy.rules must be an array' };
    }

    return { valid: true };
  }
}

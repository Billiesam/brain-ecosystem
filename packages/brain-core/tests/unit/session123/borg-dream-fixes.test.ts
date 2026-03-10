import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '..', '..', '..', '..');

describe('Session 123 Quick-Fixes', () => {
  describe('Block 0a: BorgSync enabled in Trading + Marketing', () => {
    it('trading-brain BorgSync has enabled: true with selective config', () => {
      const content = fs.readFileSync(
        path.join(ROOT, 'trading-brain', 'src', 'trading-core.ts'), 'utf-8'
      );
      // Verify BorgSync is created with enabled: true
      expect(content).toContain("enabled: true, mode: 'selective'");
      expect(content).toContain("shareTypes: ['rule', 'insight', 'principle']");
      expect(content).toContain('minConfidence: 0.6');
      expect(content).toContain('syncIntervalMs: 120_000');
    });

    it('marketing-brain BorgSync has enabled: true with selective config', () => {
      const content = fs.readFileSync(
        path.join(ROOT, 'marketing-brain', 'src', 'marketing-core.ts'), 'utf-8'
      );
      expect(content).toContain("enabled: true, mode: 'selective'");
      expect(content).toContain("shareTypes: ['rule', 'insight', 'principle']");
      expect(content).toContain('minConfidence: 0.6');
      expect(content).toContain('syncIntervalMs: 120_000');
    });
  });

  describe('Block 0b: Dream consolidation observation', () => {
    it('research-orchestrator observes dream_consolidation_count', () => {
      const content = fs.readFileSync(
        path.join(ROOT, 'brain-core', 'src', 'research', 'research-orchestrator.ts'), 'utf-8'
      );
      expect(content).toContain("topic.includes('dream')");
      expect(content).toContain("topic.includes('consolidat')");
      expect(content).toContain('internal:dream_consolidation_count');
      expect(content).toContain('memoriesConsolidated');
    });
  });
});

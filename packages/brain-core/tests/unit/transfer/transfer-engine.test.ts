import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { TransferEngine } from '../../../src/transfer/transfer-engine.js';
import { KnowledgeDistiller, runKnowledgeDistillerMigration } from '../../../src/research/knowledge-distiller.js';
import { ThoughtStream } from '../../../src/consciousness/thought-stream.js';

describe('TransferEngine', () => {
  let db: Database.Database;
  let engine: TransferEngine;
  let stream: ThoughtStream;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('journal_mode = WAL');
    engine = new TransferEngine(db, { brainName: 'brain', minSimilarity: 0.2, minTransferConfidence: 0.4 });
    stream = new ThoughtStream(100);
    engine.setThoughtStream(stream);
  });

  describe('initialization', () => {
    it('should create transfer tables', () => {
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'transfer%' OR name LIKE 'knowledge_transfer%'").all() as { name: string }[];
      const names = tables.map(t => t.name);
      expect(names).toContain('transfer_analogies');
      expect(names).toContain('knowledge_transfers');
      expect(names).toContain('transfer_rules');
    });

    it('should start with empty status', () => {
      const status = engine.getStatus();
      expect(status.totalAnalogies).toBe(0);
      expect(status.totalTransfers).toBe(0);
      expect(status.totalRules).toBe(0);
    });
  });

  describe('cross-domain rules', () => {
    it('should add a rule', () => {
      const rule = engine.addRule({
        name: 'test-rule',
        source_brain: 'brain',
        source_event: 'error:reported',
        target_brain: 'trading-brain',
        action: 'warn:instability',
        condition: 'true',
        cooldown_ms: 60_000,
        enabled: true,
      });

      expect(rule.id).toBeDefined();
      expect(rule.fire_count).toBe(0);
    });

    it('should list rules', () => {
      engine.addRule({
        name: 'rule-a',
        source_brain: 'brain',
        source_event: 'error:reported',
        target_brain: 'trading-brain',
        action: 'warn:instability',
        condition: 'true',
        cooldown_ms: 60_000,
        enabled: true,
      });
      engine.addRule({
        name: 'rule-b',
        source_brain: 'marketing-brain',
        source_event: 'post:published',
        target_brain: 'brain',
        action: 'log:activity',
        condition: 'true',
        cooldown_ms: 60_000,
        enabled: false,
      });

      const rules = engine.getRules();
      expect(rules).toHaveLength(2);
    });

    it('should evaluate rules with matching events', () => {
      engine.addRule({
        name: 'error-warn',
        source_brain: 'brain',
        source_event: 'error:reported',
        target_brain: 'trading-brain',
        action: 'warn:instability',
        condition: 'true',
        cooldown_ms: 60_000,
        enabled: true,
      });

      const fired = engine.evaluateRules('brain', 'error:reported', {});
      expect(fired).toContain('error-warn');
    });

    it('should not fire disabled rules', () => {
      engine.addRule({
        name: 'disabled-rule',
        source_brain: 'brain',
        source_event: 'error:reported',
        target_brain: 'trading-brain',
        action: 'warn:instability',
        condition: 'true',
        cooldown_ms: 60_000,
        enabled: false,
      });

      const fired = engine.evaluateRules('brain', 'error:reported', {});
      expect(fired).toHaveLength(0);
    });

    it('should respect cooldown', () => {
      engine.addRule({
        name: 'cooldown-rule',
        source_brain: 'brain',
        source_event: 'error:reported',
        target_brain: 'trading-brain',
        action: 'warn:instability',
        condition: 'true',
        cooldown_ms: 600_000, // 10 min
        enabled: true,
      });

      const first = engine.evaluateRules('brain', 'error:reported', {});
      expect(first).toHaveLength(1);

      const second = engine.evaluateRules('brain', 'error:reported', {});
      expect(second).toHaveLength(0); // Cooldown active
    });

    it('should evaluate conditions', () => {
      engine.addRule({
        name: 'threshold-rule',
        source_brain: 'brain',
        source_event: 'error:reported',
        target_brain: 'trading-brain',
        action: 'warn:instability',
        condition: 'count>=3',
        cooldown_ms: 60_000,
        enabled: true,
      });

      const notEnough = engine.evaluateRules('brain', 'error:reported', { count: 2 });
      expect(notEnough).toHaveLength(0);

      const enough = engine.evaluateRules('brain', 'error:reported', { count: 5 });
      expect(enough).toHaveLength(1);
    });

    it('should enable/disable rules', () => {
      const rule = engine.addRule({
        name: 'toggle-rule',
        source_brain: 'brain',
        source_event: 'test',
        target_brain: 'brain',
        action: 'test',
        condition: 'true',
        cooldown_ms: 60_000,
        enabled: true,
      });

      engine.setRuleEnabled(rule.id!, false);
      const rules = engine.getRules();
      expect(rules.find(r => r.name === 'toggle-rule')!.enabled).toBe(false);
    });

    it('should seed default rules', () => {
      engine.seedDefaultRules();
      const rules = engine.getRules();
      expect(rules.length).toBeGreaterThanOrEqual(5);
      expect(rules.some(r => r.name === 'error-burst-warn-trading')).toBe(true);
      expect(rules.some(r => r.name === 'insight-share-all')).toBe(true);
    });

    it('should not duplicate default rules on re-seed', () => {
      engine.seedDefaultRules();
      engine.seedDefaultRules();
      const rules = engine.getRules();
      expect(rules.length).toBe(5); // Same 5
    });
  });

  describe('analogies', () => {
    it('should find analogies between peer brains', () => {
      // Set up a peer distiller with principles
      const peerDb = new Database(':memory:');
      peerDb.pragma('journal_mode = WAL');
      runKnowledgeDistillerMigration(peerDb);

      // Insert matching principles in both DBs
      runKnowledgeDistillerMigration(db);
      db.prepare('INSERT INTO knowledge_principles (id, domain, statement, success_rate, sample_size, confidence, source) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
        'p1', 'test', 'High error rate correlates with deployment failures', 0.8, 10, 0.7, 'test',
      );
      peerDb.prepare('INSERT INTO knowledge_principles (id, domain, statement, success_rate, sample_size, confidence, source) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
        'p2', 'trading', 'High error rate correlates with trading losses', 0.75, 8, 0.65, 'test',
      );

      const peerDistiller = new KnowledgeDistiller(peerDb, { brainName: 'trading-brain' });
      engine.registerPeerDistiller('trading-brain', peerDistiller);

      const analogies = engine.findAnalogies();
      expect(analogies.length).toBeGreaterThan(0);
      expect(analogies[0]!.similarity).toBeGreaterThan(0.3);
    });

    it('should persist analogies to DB', () => {
      const peerDb = new Database(':memory:');
      peerDb.pragma('journal_mode = WAL');
      runKnowledgeDistillerMigration(peerDb);
      runKnowledgeDistillerMigration(db);

      db.prepare('INSERT INTO knowledge_principles (id, domain, statement, success_rate, sample_size, confidence, source) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
        'p1', 'test', 'Pattern recognition improves with data volume', 0.9, 20, 0.8, 'test',
      );
      peerDb.prepare('INSERT INTO knowledge_principles (id, domain, statement, success_rate, sample_size, confidence, source) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
        'p2', 'peer', 'Pattern recognition accuracy increases with more data samples', 0.85, 15, 0.75, 'test',
      );

      const peerDistiller = new KnowledgeDistiller(peerDb, { brainName: 'peer-brain' });
      engine.registerPeerDistiller('peer-brain', peerDistiller);

      engine.findAnalogies();

      const stored = engine.getAnalogies();
      expect(stored.length).toBeGreaterThan(0);
    });

    it('should return empty if no peers registered', () => {
      const analogies = engine.findAnalogies();
      expect(analogies).toHaveLength(0);
    });
  });

  describe('transfer proposals', () => {
    it('should propose transfers from peer principles', () => {
      const peerDb = new Database(':memory:');
      peerDb.pragma('journal_mode = WAL');
      runKnowledgeDistillerMigration(peerDb);
      runKnowledgeDistillerMigration(db);

      // Peer has a principle that we don't
      peerDb.prepare('INSERT INTO knowledge_principles (id, domain, statement, success_rate, sample_size, confidence, source) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
        'tp1', 'trading', 'Consistent error monitoring reduces system failures', 0.9, 20, 0.85, 'confirmed_hypothesis',
      );

      const peerDistiller = new KnowledgeDistiller(peerDb, { brainName: 'trading-brain' });
      engine.registerPeerDistiller('trading-brain', peerDistiller);

      const proposals = engine.proposeTransfers();
      expect(proposals.length).toBeGreaterThan(0);
      expect(proposals[0]!.status).toBe('pending');
      expect(proposals[0]!.source_brain).toBe('trading-brain');
    });

    it('should not propose already transferred knowledge', () => {
      const peerDb = new Database(':memory:');
      peerDb.pragma('journal_mode = WAL');
      runKnowledgeDistillerMigration(peerDb);
      runKnowledgeDistillerMigration(db);

      peerDb.prepare('INSERT INTO knowledge_principles (id, domain, statement, success_rate, sample_size, confidence, source) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
        'tp1', 'trading', 'Error rates spike during peak hours consistently', 0.9, 20, 0.85, 'confirmed_hypothesis',
      );

      const peerDistiller = new KnowledgeDistiller(peerDb, { brainName: 'trading-brain' });
      engine.registerPeerDistiller('trading-brain', peerDistiller);

      // First round: should propose
      const first = engine.proposeTransfers();
      expect(first.length).toBeGreaterThan(0);

      // Second round: already transferred
      const second = engine.proposeTransfers();
      expect(second).toHaveLength(0);
    });
  });

  describe('transfer resolution', () => {
    it('should apply and validate transfers', () => {
      const peerDb = new Database(':memory:');
      peerDb.pragma('journal_mode = WAL');
      runKnowledgeDistillerMigration(peerDb);
      runKnowledgeDistillerMigration(db);

      peerDb.prepare('INSERT INTO knowledge_principles (id, domain, statement, success_rate, sample_size, confidence, source) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
        'vp1', 'trading', 'Monitoring log frequency prevents outages', 0.88, 12, 0.8, 'confirmed_hypothesis',
      );

      const peerDistiller = new KnowledgeDistiller(peerDb, { brainName: 'trading-brain' });
      engine.registerPeerDistiller('trading-brain', peerDistiller);

      const proposals = engine.proposeTransfers();
      expect(proposals.length).toBeGreaterThan(0);
      const transferId = proposals[0]!.id ?? (db.prepare("SELECT id FROM knowledge_transfers WHERE status='pending' LIMIT 1").get() as { id: number }).id;

      engine.applyTransfer(transferId);
      let history = engine.getTransferHistory();
      expect(history.some(t => t.status === 'applied')).toBe(true);

      engine.validateTransfer(transferId, 0.75);
      history = engine.getTransferHistory();
      expect(history.some(t => t.status === 'validated')).toBe(true);
    });
  });

  describe('transfer score', () => {
    it('should compute transfer effectiveness', () => {
      const score = engine.getTransferScore();
      expect(score.total).toBe(0);
      expect(score.score).toBe(0);
    });
  });

  describe('full analysis cycle', () => {
    it('should run full analyze() without errors', () => {
      const result = engine.analyze();
      expect(result.analogies).toBeDefined();
      expect(result.proposals).toBeDefined();
    });

    it('should emit thoughts during analysis', () => {
      const thoughts: unknown[] = [];
      stream.onThought(t => thoughts.push(t));

      engine.analyze();
      expect(thoughts.length).toBeGreaterThan(0);
    });
  });

  describe('status', () => {
    it('should reflect rules in status', () => {
      engine.seedDefaultRules();
      const status = engine.getStatus();
      expect(status.totalRules).toBe(5);
      expect(status.activeRules).toBe(5);
    });

    it('should reflect pending transfers in status', () => {
      const peerDb = new Database(':memory:');
      peerDb.pragma('journal_mode = WAL');
      runKnowledgeDistillerMigration(peerDb);
      runKnowledgeDistillerMigration(db);

      peerDb.prepare('INSERT INTO knowledge_principles (id, domain, statement, success_rate, sample_size, confidence, source) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
        'sp1', 'peer', 'Systems with health checks recover faster from failures', 0.92, 25, 0.9, 'test',
      );

      const peerDistiller = new KnowledgeDistiller(peerDb, { brainName: 'peer-brain' });
      engine.registerPeerDistiller('peer-brain', peerDistiller);

      engine.proposeTransfers();
      const status = engine.getStatus();
      expect(status.pendingTransfers).toBeGreaterThan(0);
    });
  });
});

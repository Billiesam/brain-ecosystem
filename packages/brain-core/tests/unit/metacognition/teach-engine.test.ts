import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { TeachEngine } from '../../../src/metacognition/teach-engine.js';

describe('TeachEngine', () => {
  let db: Database.Database;
  let engine: TeachEngine;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('journal_mode = WAL');
    engine = new TeachEngine(db);
  });

  it('should create teaching_packages table on construction', () => {
    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name = 'teaching_packages'",
    ).all() as { name: string }[];
    expect(tables.length).toBe(1);
  });

  it('createPackage() creates a teaching package', () => {
    const pkg = engine.createPackage('trading-brain');
    expect(pkg.id).toBeDefined();
    expect(pkg.targetBrain).toBe('trading-brain');
    expect(pkg.createdAt).toBeDefined();
    expect(pkg.effectivenessScore).toBeNull();
  });

  it('createPackage() includes principles count', () => {
    const mockDistiller = {
      getPrinciples: () => [
        { id: 'p1', domain: 'test', statement: 'Error monitoring prevents outages', success_rate: 0.9, sample_size: 20, confidence: 0.85, source: 'test' },
        { id: 'p2', domain: 'test', statement: 'Log analysis finds root causes', success_rate: 0.8, sample_size: 15, confidence: 0.7, source: 'test' },
      ],
      getAntiPatterns: () => [
        { id: 'ap1', domain: 'test', statement: 'Ignoring warnings leads to failures', confidence: 0.8, source: 'test' },
      ],
    };

    engine.setKnowledgeDistiller(mockDistiller as never);

    const pkg = engine.createPackage('trading-brain');
    expect(pkg.principlesCount).toBe(2);
    expect(pkg.antipatternsCount).toBe(1);
    expect(pkg.principles).toHaveLength(2);
    expect(pkg.antiPatterns).toHaveLength(1);
    expect(pkg.principles[0].statement).toBe('Error monitoring prevents outages');
  });

  it('getPackage() returns package by id', () => {
    const created = engine.createPackage('trading-brain');
    const retrieved = engine.getPackage(created.id!);

    expect(retrieved).not.toBeNull();
    expect(retrieved!.id).toBe(created.id);
    expect(retrieved!.targetBrain).toBe('trading-brain');
  });

  it('getPackage() returns null for non-existent id', () => {
    const result = engine.getPackage(999);
    expect(result).toBeNull();
  });

  it('listPackages() lists recent', () => {
    engine.createPackage('trading-brain');
    engine.createPackage('marketing-brain');
    engine.createPackage('trading-brain');

    const packages = engine.listPackages();
    expect(packages).toHaveLength(3);
    // Ordered by id DESC — most recent first
    expect(packages[0].id).toBeGreaterThan(packages[1].id!);
  });

  it('rateEffectiveness() updates score', () => {
    const pkg = engine.createPackage('trading-brain');
    engine.rateEffectiveness(pkg.id!, 0.85);

    const retrieved = engine.getPackage(pkg.id!);
    expect(retrieved!.effectivenessScore).toBeCloseTo(0.85, 2);
  });

  it('rateEffectiveness() clamps score to 0-1', () => {
    const pkg = engine.createPackage('trading-brain');
    engine.rateEffectiveness(pkg.id!, 1.5);

    const retrieved = engine.getPackage(pkg.id!);
    expect(retrieved!.effectivenessScore).toBe(1);
  });

  it('getStatus() returns correct stats', () => {
    engine.createPackage('trading-brain');
    engine.createPackage('marketing-brain');
    engine.rateEffectiveness(1, 0.8);

    const status = engine.getStatus();
    expect(status.totalPackages).toBe(2);
    expect(status.avgEffectiveness).toBeCloseTo(0.8, 2);
    expect(status.recentPackages.length).toBe(2);
  });

  it('works without data sources (empty package)', () => {
    // No distiller, no hypothesis engine, no journal
    const pkg = engine.createPackage('trading-brain');
    expect(pkg.principlesCount).toBe(0);
    expect(pkg.antipatternsCount).toBe(0);
    expect(pkg.strategiesCount).toBe(0);
    expect(pkg.experimentsCount).toBe(0);
    expect(pkg.principles).toEqual([]);
    expect(pkg.antiPatterns).toEqual([]);
    expect(pkg.strategies).toEqual([]);
    expect(pkg.experiments).toEqual([]);
    expect(pkg.journalInsights).toEqual([]);
  });
});

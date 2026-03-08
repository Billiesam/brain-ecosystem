import type Database from 'better-sqlite3';
import type { GoalEngine, Goal, GoalType } from './goal-engine.js';
import { getLogger } from '../utils/logger.js';
import type { ThoughtStream } from '../consciousness/thought-stream.js';

// ── Types ───────────────────────────────────────────────

export interface Roadmap {
  id: number;
  title: string;
  finalGoalId: number;
  status: 'active' | 'completed' | 'abandoned';
  createdAt: string;
}

export interface GoalNode {
  id: number;
  title: string;
  status: string;
  metricName: string;
  targetValue: number;
  currentValue: number;
  progress: number;
}

export interface GoalEdge {
  from: number;
  to: number;
}

export interface RoadmapDAG {
  nodes: GoalNode[];
  edges: GoalEdge[];
}

export interface RoadmapProgress {
  roadmapId: number;
  title: string;
  totalGoals: number;
  completedGoals: number;
  activeGoals: number;
  blockedGoals: number;
  progressPercent: number;
  status: string;
}

export interface DecomposedGoal {
  title: string;
  metricName: string;
  targetValue: number;
  deadlineCycles: number;
  description: string;
  type: GoalType;
  dependsOn: number[]; // indices into the array (resolved to IDs after creation)
}

// ── Migration ───────────────────────────────────────────

export function runRoadmapMigration(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS research_roadmaps (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      final_goal_id INTEGER,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_roadmaps_status ON research_roadmaps(status);
  `);

  // Add depends_on + roadmap_id to goals table
  const addColumn = (col: string, type: string, def: string) => {
    try {
      db.exec(`ALTER TABLE goals ADD COLUMN ${col} ${type} NOT NULL DEFAULT ${def}`);
    } catch { /* already exists */ }
  };
  addColumn('depends_on', 'TEXT', "'[]'");
  addColumn('roadmap_id', 'INTEGER', '0');
}

// ── Engine ──────────────────────────────────────────────

export class ResearchRoadmap {
  private readonly db: Database.Database;
  private readonly goalEngine: GoalEngine;
  private readonly log = getLogger();
  private ts: ThoughtStream | null = null;

  constructor(db: Database.Database, goalEngine: GoalEngine) {
    this.db = db;
    this.goalEngine = goalEngine;
    runRoadmapMigration(db);
  }

  setThoughtStream(stream: ThoughtStream): void { this.ts = stream; }

  // ── Roadmap CRUD ──────────────────────────────────────

  /** Create a new research roadmap with a final goal. */
  createRoadmap(title: string, finalGoalId: number): Roadmap {
    const result = this.db.prepare(
      'INSERT INTO research_roadmaps (title, final_goal_id) VALUES (?, ?)',
    ).run(title, finalGoalId);

    const id = Number(result.lastInsertRowid);

    // Tag the final goal with roadmap_id
    this.db.prepare('UPDATE goals SET roadmap_id = ? WHERE id = ?').run(id, finalGoalId);

    this.log.info(`[roadmap] Created roadmap #${id}: ${title}`);
    this.ts?.emit('roadmap', 'reflecting', `New roadmap: ${title}`, 'notable');

    return this.getRoadmap(id)!;
  }

  getRoadmap(id: number): Roadmap | null {
    const row = this.db.prepare('SELECT * FROM research_roadmaps WHERE id = ?').get(id) as {
      id: number; title: string; final_goal_id: number; status: string; created_at: string;
    } | undefined;
    if (!row) return null;
    return {
      id: row.id,
      title: row.title,
      finalGoalId: row.final_goal_id,
      status: row.status as Roadmap['status'],
      createdAt: row.created_at,
    };
  }

  listRoadmaps(status?: string): Roadmap[] {
    const query = status
      ? 'SELECT * FROM research_roadmaps WHERE status = ? ORDER BY id DESC'
      : 'SELECT * FROM research_roadmaps ORDER BY id DESC';
    const rows = (status
      ? this.db.prepare(query).all(status)
      : this.db.prepare(query).all()
    ) as Array<{ id: number; title: string; final_goal_id: number; status: string; created_at: string }>;

    return rows.map(r => ({
      id: r.id,
      title: r.title,
      finalGoalId: r.final_goal_id,
      status: r.status as Roadmap['status'],
      createdAt: r.created_at,
    }));
  }

  // ── Goal Dependencies ─────────────────────────────────

  /** Check if a goal can start (all dependencies achieved). */
  canStart(goalId: number): boolean {
    const deps = this.getDependencies(goalId);
    if (deps.length === 0) return true;

    for (const depId of deps) {
      const goal = this.goalEngine.getGoal(depId);
      if (!goal || goal.status !== 'achieved') return false;
    }
    return true;
  }

  /** Get goals that are ready to start (no unmet dependencies). */
  getReadyGoals(): Goal[] {
    const active = this.goalEngine.listGoals('active');
    return active.filter(g => this.canStart(g.id!));
  }

  /** Get dependencies for a goal. */
  getDependencies(goalId: number): number[] {
    const row = this.db.prepare('SELECT depends_on FROM goals WHERE id = ?').get(goalId) as { depends_on: string } | undefined;
    if (!row) return [];
    try {
      return JSON.parse(row.depends_on) as number[];
    } catch {
      return [];
    }
  }

  /** Set dependencies for a goal. */
  setDependencies(goalId: number, deps: number[]): void {
    this.db.prepare('UPDATE goals SET depends_on = ? WHERE id = ?').run(JSON.stringify(deps), goalId);
  }

  // ── Decompose ──────────────────────────────────────────

  /** Decompose a goal into sub-goals using heuristic rules. */
  decompose(goal: Goal, currentCycle: number): Goal[] {
    const subGoals: DecomposedGoal[] = [];
    const baseDeadline = Math.floor(goal.deadlineCycles / 3);

    // Phase 1: Data gathering (baseline)
    subGoals.push({
      title: `Daten sammeln für: ${goal.metricName}`,
      metricName: `${goal.metricName}_data_points`,
      targetValue: 10,
      deadlineCycles: baseDeadline,
      description: `Ausreichend Datenpunkte für ${goal.title} sammeln`,
      type: 'discovery',
      dependsOn: [],
    });

    // Phase 2: Hypothesis generation
    subGoals.push({
      title: `Hypothesen für: ${goal.metricName}`,
      metricName: `${goal.metricName}_hypotheses`,
      targetValue: 3,
      deadlineCycles: baseDeadline * 2,
      description: `Testbare Hypothesen für ${goal.title} aufstellen`,
      type: 'discovery',
      dependsOn: [0], // depends on phase 1
    });

    // Phase 3: Achievement of the actual goal
    subGoals.push({
      title: `Ziel erreichen: ${goal.title}`,
      metricName: goal.metricName,
      targetValue: goal.targetValue,
      deadlineCycles: goal.deadlineCycles,
      description: `${goal.description} — nach Datenbasis und Hypothesen`,
      type: goal.type,
      dependsOn: [1], // depends on phase 2
    });

    // Create a roadmap
    const roadmap = this.createRoadmap(`Roadmap: ${goal.title}`, goal.id!);

    // Create sub-goals and resolve dependency indices to IDs
    const createdIds: number[] = [];
    for (const sg of subGoals) {
      const resolvedDeps = sg.dependsOn.map(idx => createdIds[idx]).filter(id => id !== undefined);
      const created = this.goalEngine.createGoal(sg.title, sg.metricName, sg.targetValue, sg.deadlineCycles, {
        description: sg.description,
        type: sg.type,
        currentCycle,
      });
      createdIds.push(created.id!);

      // Set dependencies and roadmap
      this.setDependencies(created.id!, resolvedDeps);
      this.db.prepare('UPDATE goals SET roadmap_id = ? WHERE id = ?').run(roadmap.id, created.id!);
    }

    this.log.info(`[roadmap] Decomposed goal #${goal.id} into ${createdIds.length} sub-goals`);
    this.ts?.emit('roadmap', 'reflecting', `Decomposed "${goal.title}" into ${createdIds.length} phases`, 'notable');

    return createdIds.map(id => this.goalEngine.getGoal(id)!).filter(g => g !== null);
  }

  // ── DAG Visualization ─────────────────────────────────

  /** Build a DAG representation for dashboard visualization. */
  toDAG(roadmapId: number): RoadmapDAG {
    const goals = this.db.prepare(
      'SELECT * FROM goals WHERE roadmap_id = ? ORDER BY id ASC',
    ).all(roadmapId) as Array<{
      id: number; title: string; status: string; metric_name: string;
      target_value: number; current_value: number; depends_on: string;
    }>;

    const nodes: GoalNode[] = goals.map(g => {
      const progress = g.target_value > 0
        ? Math.min(100, (g.current_value / g.target_value) * 100)
        : 0;
      return {
        id: g.id,
        title: g.title,
        status: g.status,
        metricName: g.metric_name,
        targetValue: g.target_value,
        currentValue: g.current_value,
        progress,
      };
    });

    const edges: GoalEdge[] = [];
    for (const g of goals) {
      try {
        const deps = JSON.parse(g.depends_on) as number[];
        for (const dep of deps) {
          edges.push({ from: dep, to: g.id });
        }
      } catch { /* empty */ }
    }

    return { nodes, edges };
  }

  // ── Progress ───────────────────────────────────────────

  /** Get overall roadmap progress. */
  getProgress(roadmapId: number): RoadmapProgress {
    const roadmap = this.getRoadmap(roadmapId);
    if (!roadmap) {
      return {
        roadmapId,
        title: 'Unknown',
        totalGoals: 0,
        completedGoals: 0,
        activeGoals: 0,
        blockedGoals: 0,
        progressPercent: 0,
        status: 'unknown',
      };
    }

    const goals = this.db.prepare(
      'SELECT * FROM goals WHERE roadmap_id = ?',
    ).all(roadmapId) as Array<{ id: number; status: string; depends_on: string }>;

    const total = goals.length;
    const completed = goals.filter(g => g.status === 'achieved').length;
    const active = goals.filter(g => g.status === 'active').length;
    const blocked = goals.filter(g => g.status === 'active' && !this.canStart(g.id)).length;

    // Auto-complete roadmap if all goals achieved
    if (total > 0 && completed === total && roadmap.status === 'active') {
      this.db.prepare("UPDATE research_roadmaps SET status = 'completed' WHERE id = ?").run(roadmapId);
      roadmap.status = 'completed';
    }

    return {
      roadmapId,
      title: roadmap.title,
      totalGoals: total,
      completedGoals: completed,
      activeGoals: active,
      blockedGoals: blocked,
      progressPercent: total > 0 ? Math.round((completed / total) * 100) : 0,
      status: roadmap.status,
    };
  }
}

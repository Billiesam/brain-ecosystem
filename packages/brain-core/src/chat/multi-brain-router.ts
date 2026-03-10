import { getLogger } from '../utils/logger.js';

// ── Types ──────────────────────────────────────────────

export interface MultiBrainRoute {
  brains: string[];
  intent: string;
}

export interface MultiBrainResponse {
  brain: string;
  response: unknown;
  error?: string;
  durationMs: number;
}

export interface AggregatedResponse {
  responses: MultiBrainResponse[];
  markdown: string;
}

type CrossBrainQuery = (brain: string, method: string, params?: unknown) => Promise<unknown>;

// ── Router ──────────────────────────────────────────────

const BRAIN_KEYWORDS: Record<string, string[]> = {
  'brain': ['error', 'fehler', 'bug', 'code', 'synapse', 'dream', 'solution', 'memory', 'pattern', 'modul'],
  'trading-brain': ['trade', 'signal', 'strategy', 'price', 'backtest', 'paper', 'portfolio', 'market', 'position', 'crypto', 'btc'],
  'marketing-brain': ['content', 'post', 'campaign', 'engagement', 'marketing', 'audience', 'social', 'publish', 'bluesky'],
};

const MULTI_BRAIN_KEYWORDS = ['system', 'overview', 'übersicht', 'gesamtsystem', 'alle', 'all brains', 'ecosystem', 'performt', 'performance', 'status gesamt', 'wie läuft'];

const log = getLogger();

export class MultiBrainRouter {
  /** Route a message to one or more brains. */
  route(message: string): MultiBrainRoute {
    const lower = message.toLowerCase();

    // Check multi-brain triggers first
    if (MULTI_BRAIN_KEYWORDS.some(kw => lower.includes(kw))) {
      return { brains: ['brain', 'trading-brain', 'marketing-brain'], intent: 'multi-status' };
    }

    // Score each brain by keyword matches
    const scores: Record<string, number> = {};
    for (const [brain, keywords] of Object.entries(BRAIN_KEYWORDS)) {
      scores[brain] = keywords.filter(kw => lower.includes(kw)).length;
    }

    const matched = Object.entries(scores)
      .filter(([, score]) => score > 0)
      .sort(([, a], [, b]) => b - a)
      .map(([brain]) => brain);

    if (matched.length === 0) {
      // Default: route to the local brain
      return { brains: ['brain'], intent: 'unknown' };
    }

    const intent = matched.length > 1 ? 'cross-brain' : matched[0]!;
    return { brains: matched, intent };
  }

  /** Query multiple brains in parallel and aggregate responses. */
  async queryMultiple(
    brains: string[],
    localBrain: string,
    localHandler: (method: string, params?: unknown) => Promise<unknown>,
    crossBrainQuery: CrossBrainQuery,
    method: string,
    params?: unknown,
    timeoutMs = 5000,
  ): Promise<AggregatedResponse> {
    const responses: MultiBrainResponse[] = [];

    const promises = brains.map(async (brain) => {
      const start = Date.now();
      try {
        let result: unknown;
        if (brain === localBrain) {
          result = await localHandler(method, params);
        } else {
          result = await Promise.race([
            crossBrainQuery(brain, method, params),
            new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), timeoutMs)),
          ]);
        }
        responses.push({ brain, response: result, durationMs: Date.now() - start });
      } catch (err) {
        responses.push({ brain, response: null, error: (err as Error).message, durationMs: Date.now() - start });
      }
    });

    await Promise.all(promises);

    return {
      responses,
      markdown: this.aggregate(responses),
    };
  }

  /** Aggregate responses into markdown. */
  private aggregate(responses: MultiBrainResponse[]): string {
    const sections: string[] = [];

    for (const r of responses) {
      const title = this.brainDisplayName(r.brain);
      if (r.error) {
        sections.push(`## ${title}\n*Fehler: ${r.error}*`);
      } else {
        const content = typeof r.response === 'string'
          ? r.response
          : JSON.stringify(r.response, null, 2).substring(0, 800);
        sections.push(`## ${title}\n${content}`);
      }
    }

    return sections.join('\n\n');
  }

  private brainDisplayName(brain: string): string {
    switch (brain) {
      case 'brain': return 'Brain (Code & Errors)';
      case 'trading-brain': return 'Trading Brain';
      case 'marketing-brain': return 'Marketing Brain';
      default: return brain;
    }
  }
}

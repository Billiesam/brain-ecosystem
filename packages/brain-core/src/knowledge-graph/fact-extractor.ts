import type Database from 'better-sqlite3';
import { getLogger } from '../utils/logger.js';
import type { LLMService } from '../llm/llm-service.js';

// ── Types ───────────────────────────────────────────────

export interface ExtractedFact {
  subject: string;
  predicate: string;
  object: string;
  context?: string;
  confidence: number;
}

export interface FactExtractorConfig {
  brainName: string;
}

// ── Regex Patterns ──────────────────────────────────────

interface ExtractionPattern {
  regex: RegExp;
  predicate: string;
}

const EXTRACTION_PATTERNS: ExtractionPattern[] = [
  { regex: /(.+?)\s+causes\s+(.+)/i, predicate: 'causes' },
  { regex: /(.+?)\s+solves\s+(.+)/i, predicate: 'solves' },
  { regex: /(.+?)\s+requires\s+(.+)/i, predicate: 'requires' },
  { regex: /(.+?)\s+improves\s+(.+)/i, predicate: 'improves' },
  { regex: /(.+?)\s+prevents\s+(.+)/i, predicate: 'prevents' },
  { regex: /when\s+(.+?)\s+then\s+(.+)/i, predicate: 'leads_to' },
];

// ── Extractor ───────────────────────────────────────────

export class FactExtractor {
  private readonly db: Database.Database;
  private readonly config: FactExtractorConfig;
  private readonly log = getLogger();
  private llm: LLMService | null = null;

  constructor(db: Database.Database, config: FactExtractorConfig) {
    this.db = db;
    this.config = config;
    this.log.info(`[FactExtractor] Initialized for ${this.config.brainName}`);
  }

  // ── Setters ──────────────────────────────────────────

  setLLMService(llm: LLMService): void { this.llm = llm; }

  // ── Extraction Methods ───────────────────────────────

  extractFromInsight(text: string, sourceId: string): ExtractedFact[] {
    const facts: ExtractedFact[] = [];

    // Split text into sentences for multi-sentence processing
    const sentences = text.split(/[.;!?\n]+/).map(s => s.trim()).filter(s => s.length > 0);

    for (const sentence of sentences) {
      for (const pattern of EXTRACTION_PATTERNS) {
        const match = sentence.match(pattern.regex);
        if (match && match[1] && match[2]) {
          facts.push({
            subject: match[1].trim(),
            predicate: pattern.predicate,
            object: match[2].trim(),
            context: `insight:${sourceId}`,
            confidence: 0.6,
          });
        }
      }
    }

    this.log.debug(`[FactExtractor] Extracted ${facts.length} fact(s) from insight ${sourceId}`);
    return facts;
  }

  extractFromRule(condition: string, action: string, sourceId: string): ExtractedFact[] {
    const facts: ExtractedFact[] = [];

    facts.push({
      subject: condition.trim(),
      predicate: 'triggers',
      object: action.trim(),
      context: `rule:${sourceId}`,
      confidence: 0.8,
    });

    this.log.debug(`[FactExtractor] Extracted rule fact: ${condition} triggers ${action}`);
    return facts;
  }

  extractFromErrorSolution(
    error: string,
    solution: string,
    context: string,
    sourceId: string,
  ): ExtractedFact[] {
    const facts: ExtractedFact[] = [];

    facts.push({
      subject: error.trim(),
      predicate: 'solved_by',
      object: solution.trim(),
      context: `error:${sourceId}:${context}`,
      confidence: 0.7,
    });

    this.log.debug(`[FactExtractor] Extracted error-solution fact: ${error} solved_by ${solution}`);
    return facts;
  }
}

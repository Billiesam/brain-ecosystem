// ── Adaptive Context — Prompt Enrichment Based on User Profile ─
//
// Adjusts prompt detail level based on the user's skill profile.
// Expert users get concise responses; beginners get detailed explanations.

import type { UserProfile, SkillLevel } from './user-model.js';

// ── Types ───────────────────────────────────────────────

export type DetailLevel = 'concise' | 'normal' | 'detailed';

// ── Functions ───────────────────────────────────────────

export class AdaptiveContext {
  /**
   * Enrich a base prompt based on the user's profile.
   * - If all domains are 'expert': prepend concise instructions.
   * - If any domain is 'beginner': prepend detailed instructions.
   * - Default: return prompt unmodified.
   */
  enrichPrompt(basePrompt: string, profile: UserProfile): string {
    const level = this.getDetailLevel(profile);

    switch (level) {
      case 'concise':
        return `Be concise. Skip basics.\n\n${basePrompt}`;
      case 'detailed':
        return `Explain in detail with examples.\n\n${basePrompt}`;
      default:
        return basePrompt;
    }
  }

  /**
   * Determine the appropriate detail level from a user profile.
   * - 'concise': all domains are expert level
   * - 'detailed': any domain is beginner level
   * - 'normal': default / mixed intermediate
   */
  getDetailLevel(profile: UserProfile): DetailLevel {
    const domains = profile.skillDomains;

    if (domains.size === 0) return 'normal';

    const levels: SkillLevel[] = Array.from(domains.values());

    // If any domain is beginner, give detailed responses
    if (levels.some(l => l === 'beginner')) {
      return 'detailed';
    }

    // If ALL domains are expert, be concise
    if (levels.every(l => l === 'expert')) {
      return 'concise';
    }

    return 'normal';
  }
}

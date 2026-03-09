import { getLogger } from '../../utils/logger.js';

// ── Types ──────────────────────────────────────────────────

export interface MissionHandlerDeps {
  createMission: (topic: string, mode: string) => { id?: number; topic: string; status: string };
}

export interface MissionHandlerResult {
  started: boolean;
  topic: string;
  missionId: number | null;
}

// ── Handler Factory ──────────────────────────────────────────

const log = getLogger();

/**
 * Creates an ActionBridge handler for `start_mission` actions.
 * Translates ContradictionResolver desires into MissionEngine missions.
 */
export function createMissionHandler(deps: MissionHandlerDeps): (payload: Record<string, unknown>) => Promise<MissionHandlerResult> {
  return async (payload: Record<string, unknown>): Promise<MissionHandlerResult> => {
    const desireKey = (payload.desireKey as string) ?? '';
    const description = (payload.description as string) ?? '';

    // Extract topic from desireKey (e.g. "contradiction_hypothesis_vs_a" → "hypothesis vs a")
    let topic = desireKey
      .replace(/^contradiction_/, '')
      .replace(/_/g, ' ');

    // Fallback: extract from description using "X" vs "Y" pattern
    if (topic.length < 3 || topic === desireKey) {
      const match = description.match(/"([^"]+)"\s*vs\s*"([^"]+)"/);
      if (match) {
        topic = `${match[1]} vs ${match[2]}`;
      } else if (description.length > 0) {
        topic = description.substring(0, 80);
      } else {
        topic = 'general research';
      }
    }

    log.info(`[mission-handler] Starting mission for topic="${topic}" (desireKey=${desireKey})`);

    try {
      const mission = deps.createMission(topic, 'quick');
      log.info(`[mission-handler] Mission #${mission.id ?? 0} started: "${topic}"`);

      return {
        started: true,
        topic,
        missionId: mission.id ?? null,
      };
    } catch (err) {
      log.warn(`[mission-handler] Failed to start mission: ${(err as Error).message}`);
      return {
        started: false,
        topic,
        missionId: null,
      };
    }
  };
}

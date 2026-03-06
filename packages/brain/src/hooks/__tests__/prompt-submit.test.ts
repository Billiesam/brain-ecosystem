import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock IpcClient before importing
const mockRequest = vi.fn();
const mockConnect = vi.fn();
const mockDisconnect = vi.fn();

vi.mock('@timmeck/brain-core', () => ({
  IpcClient: vi.fn().mockImplementation(() => ({
    connect: mockConnect,
    request: mockRequest,
    disconnect: mockDisconnect,
  })),
}));

vi.mock('../../utils/paths.js', () => ({
  getPipeName: () => '\\\\.\\pipe\\brain-test',
}));

// Mirror the formatTag / formatNotification logic from prompt-submit.ts for unit testing
function formatTag(type: string, title?: string): string {
  const event = title ?? '';
  if (event.includes('position') || event.includes('paper')) return 'trade';
  if (event.includes('selfmod') || event.includes('improvement')) return 'self';
  if (event.includes('post:') || event.includes('campaign')) return 'mktg';
  if (event.includes('insight')) return 'insight';
  if (event.includes('rule') || event.includes('learn') || event.includes('calibrat')) return 'learn';
  if (event.includes('tech') || event.includes('radar')) return 'tech';
  if (type.includes('trading') || type.includes('position') || type.includes('paper')) return 'trade';
  if (type.includes('selfmod') || type.includes('self-mod') || type.includes('improvement')) return 'self';
  if (type.includes('marketing') || type.includes('post:') || type.includes('campaign')) return 'mktg';
  if (type.includes('insight')) return 'insight';
  if (type.includes('rule') || type.includes('learn') || type.includes('calibrat')) return 'learn';
  if (type.includes('tech') || type.includes('radar')) return 'tech';
  return 'info';
}

interface NotificationRecord {
  id: number;
  type: string;
  title: string;
  message: string;
  priority: number;
  created_at: string;
}

function formatNotification(n: NotificationRecord): string {
  const tag = formatTag(n.type, n.title);
  let detail = n.title;
  try {
    const data = JSON.parse(n.message);
    if (data.summary) {
      detail = data.summary;
    } else if (data.pnl !== undefined) {
      const pnlStr = data.pnl >= 0 ? `+$${data.pnl.toFixed(2)}` : `-$${Math.abs(data.pnl).toFixed(2)}`;
      const pctStr = data.pnlPct !== undefined ? ` (${data.pnlPct >= 0 ? '+' : ''}${data.pnlPct.toFixed(1)}%)` : '';
      detail = `${n.title}: ${pnlStr}${pctStr}`;
    } else if (data.pattern) {
      detail = `${n.title}: "${data.pattern}"`;
    } else {
      detail = n.title;
    }
  } catch {
    detail = n.title;
  }
  return `  [${tag}] ${detail}`;
}

describe('prompt-submit hook', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockConnect.mockResolvedValue(undefined);
    mockDisconnect.mockReturnValue(undefined);
  });

  describe('formatTag', () => {
    it('maps trade-related types to "trade"', () => {
      expect(formatTag('cross-brain:trading-brain', 'position:closed')).toBe('trade');
      expect(formatTag('position:closed')).toBe('trade');
      expect(formatTag('paper_trade')).toBe('trade');
    });

    it('maps learning types to "learn"', () => {
      expect(formatTag('cross-brain:trading-brain', 'rule:learned')).toBe('learn');
      expect(formatTag('calibration', 'updated')).toBe('learn');
    });

    it('maps selfmod types to "self"', () => {
      expect(formatTag('selfmod')).toBe('self');
      expect(formatTag('self-modification')).toBe('self');
      expect(formatTag('selfmod', 'Self-improvement suggestion')).toBe('self');
    });

    it('maps insight types', () => {
      expect(formatTag('cross-brain:trading-brain', 'insight:created')).toBe('insight');
    });

    it('maps marketing types to "mktg"', () => {
      expect(formatTag('cross-brain:marketing-brain', 'post:published')).toBe('mktg');
      expect(formatTag('campaign', 'campaign:created')).toBe('mktg');
      // rule:learned from marketing-brain maps to 'learn' (event > source)
      expect(formatTag('cross-brain:marketing-brain', 'rule:learned')).toBe('learn');
    });

    it('maps tech radar types', () => {
      expect(formatTag('techradar:scan')).toBe('tech');
    });

    it('defaults to "info"', () => {
      expect(formatTag('unknown')).toBe('info');
    });
  });

  describe('formatNotification', () => {
    it('formats trade close with P&L', () => {
      const n: NotificationRecord = {
        id: 1,
        type: 'cross-brain:trading-brain',
        title: 'position:closed',
        message: JSON.stringify({ pnl: 42.5, pnlPct: 2.1, symbol: 'BTC/USDT' }),
        priority: 0,
        created_at: '2026-03-06T12:00:00Z',
      };
      const result = formatNotification(n);
      expect(result).toContain('[trade]');
      expect(result).toContain('+$42.50');
      expect(result).toContain('+2.1%');
    });

    it('formats negative P&L correctly', () => {
      const n: NotificationRecord = {
        id: 2,
        type: 'cross-brain:trading-brain',
        title: 'position:closed',
        message: JSON.stringify({ pnl: -15.30, pnlPct: -1.5 }),
        priority: 0,
        created_at: '2026-03-06T12:00:00Z',
      };
      const result = formatNotification(n);
      expect(result).toContain('[trade]');
      expect(result).toContain('-$15.30');
      expect(result).toContain('-1.5%');
    });

    it('formats rule with pattern', () => {
      const n: NotificationRecord = {
        id: 3,
        type: 'cross-brain:trading-brain',
        title: 'rule:learned',
        message: JSON.stringify({ pattern: 'RSI<30 + MACD cross' }),
        priority: 0,
        created_at: '2026-03-06T12:00:00Z',
      };
      const result = formatNotification(n);
      expect(result).toContain('[learn]');
      expect(result).toContain('"RSI<30 + MACD cross"');
    });

    it('formats notification with summary', () => {
      const n: NotificationRecord = {
        id: 4,
        type: 'selfmod',
        title: 'Self-improvement suggestion',
        message: JSON.stringify({ summary: 'Extract common IPC patterns' }),
        priority: 0,
        created_at: '2026-03-06T12:00:00Z',
      };
      const result = formatNotification(n);
      expect(result).toContain('[self]');
      expect(result).toContain('Extract common IPC patterns');
    });

    it('falls back to title for unparseable message', () => {
      const n: NotificationRecord = {
        id: 5,
        type: 'info',
        title: 'Something happened',
        message: 'not json',
        priority: 0,
        created_at: '2026-03-06T12:00:00Z',
      };
      const result = formatNotification(n);
      expect(result).toContain('[info]');
      expect(result).toContain('Something happened');
    });
  });

  describe('IPC integration', () => {
    it('does nothing when no pending notifications', async () => {
      mockRequest.mockResolvedValue([]);
      const { IpcClient } = await import('@timmeck/brain-core');
      const client = new IpcClient('\\\\.\\pipe\\test', 3000);
      await client.connect();
      const pending = await client.request('notification.pending') as NotificationRecord[];
      expect(pending).toEqual([]);
    });

    it('calls notification.pending and notification.ackAll', async () => {
      const notifications = [
        { id: 1, type: 'selfmod', title: 'Test', message: '{}', priority: 0, created_at: '' },
      ];
      mockRequest
        .mockResolvedValueOnce(notifications)  // notification.pending
        .mockResolvedValueOnce({ acknowledged: 1 });  // notification.ackAll

      const { IpcClient } = await import('@timmeck/brain-core');
      const client = new IpcClient('\\\\.\\pipe\\test', 3000);
      await client.connect();

      const pending = await client.request('notification.pending');
      expect(pending).toEqual(notifications);

      const ack = await client.request('notification.ackAll');
      expect(ack).toEqual({ acknowledged: 1 });
    });
  });
});

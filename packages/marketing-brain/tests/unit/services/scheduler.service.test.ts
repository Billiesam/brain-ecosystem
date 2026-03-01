/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SchedulerService } from '../../../src/services/scheduler.service.js';
import type { SchedulerRepository, ScheduledPostRecord } from '../../../src/db/repositories/scheduler.repository.js';
import type { CalendarService } from '../../../src/services/calendar.service.js';

vi.mock('../../../src/utils/logger.js', () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const mockEmit = vi.fn();
vi.mock('../../../src/utils/events.js', () => ({
  getEventBus: () => ({ emit: mockEmit }),
}));

function makeRecord(overrides: Partial<ScheduledPostRecord> = {}): ScheduledPostRecord {
  return {
    id: 1,
    post_id: null,
    platform: 'x',
    content: 'Test post content',
    format: 'text',
    hashtags: null,
    scheduled_at: '2026-06-01T10:00:00Z',
    status: 'pending',
    published_at: null,
    webhook_url: null,
    created_at: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

describe('SchedulerService', () => {
  let service: SchedulerService;
  let schedulerRepo: {
    create: ReturnType<typeof vi.fn>;
    getById: ReturnType<typeof vi.fn>;
    getAll: ReturnType<typeof vi.fn>;
    getPending: ReturnType<typeof vi.fn>;
    getDue: ReturnType<typeof vi.fn>;
    getByStatus: ReturnType<typeof vi.fn>;
    markPublished: ReturnType<typeof vi.fn>;
    cancel: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    delete: ReturnType<typeof vi.fn>;
    countPending: ReturnType<typeof vi.fn>;
  };
  let calendarService: {
    suggestNextPostTime: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    vi.clearAllMocks();

    schedulerRepo = {
      create: vi.fn(),
      getById: vi.fn(),
      getAll: vi.fn(),
      getPending: vi.fn(),
      getDue: vi.fn(),
      getByStatus: vi.fn(),
      markPublished: vi.fn(),
      cancel: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      countPending: vi.fn(),
    };

    calendarService = {
      suggestNextPostTime: vi.fn(),
    };

    service = new SchedulerService(
      schedulerRepo as unknown as SchedulerRepository,
      calendarService as unknown as CalendarService,
    );
  });

  describe('schedulePost', () => {
    it('should schedule a post with explicit scheduled_at', () => {
      schedulerRepo.create.mockReturnValue(42);

      const result = service.schedulePost({
        platform: 'x',
        content: 'Hello world',
        scheduled_at: '2026-06-01T10:00:00Z',
      });

      expect(result.scheduledId).toBe(42);
      expect(result.scheduledAt).toBe('2026-06-01T10:00:00Z');
      expect(schedulerRepo.create).toHaveBeenCalledWith({
        platform: 'x',
        content: 'Hello world',
        format: undefined,
        hashtags: undefined,
        scheduled_at: '2026-06-01T10:00:00Z',
        webhook_url: undefined,
      });
      expect(calendarService.suggestNextPostTime).not.toHaveBeenCalled();
    });

    it('should use calendarService.suggestNextPostTime when no scheduled_at is provided', () => {
      calendarService.suggestNextPostTime.mockReturnValue({
        time: '2026-06-03T09:00:00Z',
        day: 'Wednesday',
        hour: 9,
        reason: 'Best time for x',
        confidence: 0.8,
      });
      schedulerRepo.create.mockReturnValue(7);

      const result = service.schedulePost({
        platform: 'x',
        content: 'Auto-timed post',
      });

      expect(result.scheduledAt).toBe('2026-06-03T09:00:00Z');
      expect(calendarService.suggestNextPostTime).toHaveBeenCalledWith('x');
    });

    it('should emit a post:scheduled event', () => {
      schedulerRepo.create.mockReturnValue(10);

      service.schedulePost({
        platform: 'linkedin',
        content: 'Event post',
        scheduled_at: '2026-06-05T14:00:00Z',
      });

      expect(mockEmit).toHaveBeenCalledWith('post:scheduled', {
        scheduledId: 10,
        platform: 'linkedin',
        scheduledAt: '2026-06-05T14:00:00Z',
      });
    });

    it('should pass optional fields (format, hashtags, webhook_url) to repo', () => {
      schedulerRepo.create.mockReturnValue(1);

      service.schedulePost({
        platform: 'reddit',
        content: 'Full post',
        format: 'image',
        hashtags: '#reddit,#test',
        scheduled_at: '2026-06-01T10:00:00Z',
        webhook_url: 'https://hooks.example.com/publish',
      });

      expect(schedulerRepo.create).toHaveBeenCalledWith({
        platform: 'reddit',
        content: 'Full post',
        format: 'image',
        hashtags: '#reddit,#test',
        scheduled_at: '2026-06-01T10:00:00Z',
        webhook_url: 'https://hooks.example.com/publish',
      });
    });
  });

  describe('listScheduled', () => {
    it('should delegate to repo.getAll', () => {
      const records = [makeRecord({ id: 1 }), makeRecord({ id: 2 })];
      schedulerRepo.getAll.mockReturnValue(records);

      const result = service.listScheduled();

      expect(result).toEqual(records);
      expect(schedulerRepo.getAll).toHaveBeenCalled();
    });
  });

  describe('listPending', () => {
    it('should delegate to repo.getPending', () => {
      const records = [makeRecord({ id: 3, status: 'pending' })];
      schedulerRepo.getPending.mockReturnValue(records);

      const result = service.listPending();

      expect(result).toEqual(records);
      expect(schedulerRepo.getPending).toHaveBeenCalled();
    });
  });

  describe('cancelPost', () => {
    it('should delegate to repo.cancel', () => {
      service.cancelPost(5);

      expect(schedulerRepo.cancel).toHaveBeenCalledWith(5);
    });
  });

  describe('checkDue', () => {
    it('should process due posts, mark them as published, and emit events', () => {
      const duePosts = [
        makeRecord({ id: 10, content: 'Due post 1' }),
        makeRecord({ id: 11, content: 'Due post 2' }),
      ];
      schedulerRepo.getDue.mockReturnValue(duePosts);

      const result = service.checkDue();

      expect(result).toEqual(duePosts);
      expect(schedulerRepo.markPublished).toHaveBeenCalledWith(10);
      expect(schedulerRepo.markPublished).toHaveBeenCalledWith(11);
      expect(mockEmit).toHaveBeenCalledWith('post:due', {
        scheduledId: 10,
        platform: 'x',
        content: 'Due post 1',
      });
      expect(mockEmit).toHaveBeenCalledWith('post:due', {
        scheduledId: 11,
        platform: 'x',
        content: 'Due post 2',
      });
    });

    it('should fire a POST webhook when webhook_url is present', () => {
      const mockFetch = vi.fn().mockResolvedValue({ ok: true });
      vi.stubGlobal('fetch', mockFetch);

      const duePost = makeRecord({
        id: 20,
        platform: 'linkedin',
        content: 'Webhook post',
        format: 'text',
        hashtags: '#test',
        webhook_url: 'https://hooks.example.com/publish',
      });
      schedulerRepo.getDue.mockReturnValue([duePost]);

      service.checkDue();

      expect(mockFetch).toHaveBeenCalledWith('https://hooks.example.com/publish', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          scheduledId: 20,
          platform: 'linkedin',
          content: 'Webhook post',
          format: 'text',
          hashtags: '#test',
        }),
      });

      vi.unstubAllGlobals();
    });

    it('should return empty array when no posts are due', () => {
      schedulerRepo.getDue.mockReturnValue([]);

      const result = service.checkDue();

      expect(result).toEqual([]);
      expect(schedulerRepo.markPublished).not.toHaveBeenCalled();
      expect(mockEmit).not.toHaveBeenCalled();
    });
  });

  describe('reschedule', () => {
    it('should update the scheduled time via repo.update', () => {
      service.reschedule(15, '2026-07-01T18:00:00Z');

      expect(schedulerRepo.update).toHaveBeenCalledWith(15, {
        scheduled_at: '2026-07-01T18:00:00Z',
      });
    });
  });
});

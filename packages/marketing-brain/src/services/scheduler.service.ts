import type { SchedulerRepository, ScheduledPostRecord } from '../db/repositories/scheduler.repository.js';
import type { CalendarService } from './calendar.service.js';
import { getLogger } from '../utils/logger.js';
import { getEventBus } from '../utils/events.js';

export interface SchedulePostInput {
  platform: string;
  content: string;
  format?: string;
  hashtags?: string;
  scheduled_at?: string;
  webhook_url?: string;
}

export class SchedulerService {
  private logger = getLogger();

  constructor(
    private schedulerRepo: SchedulerRepository,
    private calendarService: CalendarService,
  ) {}

  schedulePost(input: SchedulePostInput): { scheduledId: number; scheduledAt: string } {
    let scheduledAt = input.scheduled_at;

    if (!scheduledAt) {
      const suggestion = this.calendarService.suggestNextPostTime(input.platform);
      scheduledAt = suggestion.time;
      this.logger.info(`No scheduled_at provided; using suggested time: ${scheduledAt} (${suggestion.reason})`);
    }

    const scheduledId = this.schedulerRepo.create({
      platform: input.platform,
      content: input.content,
      format: input.format,
      hashtags: input.hashtags,
      scheduled_at: scheduledAt,
      webhook_url: input.webhook_url,
    });

    this.logger.info(`Post scheduled: id=${scheduledId}, platform=${input.platform}, at=${scheduledAt}`);

    getEventBus().emit('post:scheduled', {
      scheduledId,
      platform: input.platform,
      scheduledAt,
    });

    return { scheduledId, scheduledAt };
  }

  listScheduled(): ScheduledPostRecord[] {
    return this.schedulerRepo.getAll();
  }

  listPending(): ScheduledPostRecord[] {
    return this.schedulerRepo.getPending();
  }

  cancelPost(id: number): void {
    this.schedulerRepo.cancel(id);
    this.logger.info(`Post cancelled: id=${id}`);
  }

  checkDue(): ScheduledPostRecord[] {
    const duePosts = this.schedulerRepo.getDue();

    for (const post of duePosts) {
      getEventBus().emit('post:due', {
        scheduledId: post.id,
        platform: post.platform,
        content: post.content,
      });

      if (post.webhook_url) {
        fetch(post.webhook_url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            scheduledId: post.id,
            platform: post.platform,
            content: post.content,
            format: post.format,
            hashtags: post.hashtags,
          }),
        }).catch((err) => {
          this.logger.warn(`Webhook failed for scheduled post ${post.id}: ${err}`);
        });
      }

      this.schedulerRepo.markPublished(post.id);
      this.logger.info(`Post published: id=${post.id}, platform=${post.platform}`);
    }

    return duePosts;
  }

  reschedule(id: number, newTime: string): void {
    this.schedulerRepo.update(id, { scheduled_at: newTime });
    this.logger.info(`Post rescheduled: id=${id}, newTime=${newTime}`);
  }
}

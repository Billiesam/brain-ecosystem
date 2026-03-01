import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ThoughtStream } from '../../../src/consciousness/thought-stream.js';

describe('ThoughtStream', () => {
  let stream: ThoughtStream;

  beforeEach(() => {
    stream = new ThoughtStream(10);
  });

  describe('emit', () => {
    it('should create a thought with correct fields', () => {
      const thought = stream.emit('self_observer', 'analyzing', 'Test thought');
      expect(thought.id).toBeDefined();
      expect(thought.timestamp).toBeGreaterThan(0);
      expect(thought.engine).toBe('self_observer');
      expect(thought.type).toBe('analyzing');
      expect(thought.content).toBe('Test thought');
      expect(thought.significance).toBe('routine');
      expect(thought.data).toBeUndefined();
    });

    it('should accept significance and data', () => {
      const thought = stream.emit('dream', 'dreaming', 'Dream!', 'breakthrough', { cycles: 5 });
      expect(thought.significance).toBe('breakthrough');
      expect(thought.data).toEqual({ cycles: 5 });
    });

    it('should respect maxThoughts (circular buffer)', () => {
      for (let i = 0; i < 15; i++) {
        stream.emit('orchestrator', 'perceiving', `Thought ${i}`);
      }
      const recent = stream.getRecent(100);
      expect(recent.length).toBe(10);
      // Most recent should be first (reversed)
      expect(recent[0].content).toBe('Thought 14');
      expect(recent[9].content).toBe('Thought 5');
    });
  });

  describe('onThought', () => {
    it('should call listener on emit', () => {
      const listener = vi.fn();
      stream.onThought(listener);
      stream.emit('orchestrator', 'perceiving', 'Hello');
      expect(listener).toHaveBeenCalledTimes(1);
      expect(listener.mock.calls[0][0].content).toBe('Hello');
    });

    it('should return an unsubscribe function', () => {
      const listener = vi.fn();
      const unsub = stream.onThought(listener);
      stream.emit('orchestrator', 'perceiving', 'First');
      unsub();
      stream.emit('orchestrator', 'perceiving', 'Second');
      expect(listener).toHaveBeenCalledTimes(1);
    });

    it('should not break on listener errors', () => {
      stream.onThought(() => { throw new Error('boom'); });
      const listener2 = vi.fn();
      stream.onThought(listener2);
      stream.emit('orchestrator', 'perceiving', 'Test');
      expect(listener2).toHaveBeenCalledTimes(1);
    });
  });

  describe('getRecent', () => {
    it('should return thoughts in reverse order (newest first)', () => {
      stream.emit('a', 'perceiving', 'First');
      stream.emit('b', 'analyzing', 'Second');
      stream.emit('c', 'discovering', 'Third');
      const recent = stream.getRecent(2);
      expect(recent.length).toBe(2);
      expect(recent[0].content).toBe('Third');
      expect(recent[1].content).toBe('Second');
    });

    it('should handle limit larger than buffer', () => {
      stream.emit('a', 'perceiving', 'Only one');
      const recent = stream.getRecent(100);
      expect(recent.length).toBe(1);
    });
  });

  describe('getByEngine', () => {
    it('should filter by engine', () => {
      stream.emit('dream', 'dreaming', 'Dream 1');
      stream.emit('orchestrator', 'perceiving', 'Orch 1');
      stream.emit('dream', 'dreaming', 'Dream 2');
      const dreams = stream.getByEngine('dream');
      expect(dreams.length).toBe(2);
      expect(dreams[0].content).toBe('Dream 2');
      expect(dreams[1].content).toBe('Dream 1');
    });

    it('should return empty array for unknown engine', () => {
      stream.emit('dream', 'dreaming', 'Dream 1');
      expect(stream.getByEngine('unknown').length).toBe(0);
    });
  });

  describe('getStats', () => {
    it('should count per engine, type, and significance', () => {
      stream.emit('dream', 'dreaming', 'D1');
      stream.emit('dream', 'dreaming', 'D2', 'notable');
      stream.emit('orchestrator', 'perceiving', 'O1');
      stream.emit('anomaly_detective', 'discovering', 'A1', 'breakthrough');

      const stats = stream.getStats();
      expect(stats.totalThoughts).toBe(4);
      expect(stats.thoughtsPerEngine['dream']).toBe(2);
      expect(stats.thoughtsPerEngine['orchestrator']).toBe(1);
      expect(stats.thoughtsPerEngine['anomaly_detective']).toBe(1);
      expect(stats.thoughtsPerType['dreaming']).toBe(2);
      expect(stats.thoughtsPerType['perceiving']).toBe(1);
      expect(stats.thoughtsPerType['discovering']).toBe(1);
      expect(stats.thoughtsPerSignificance['routine']).toBe(2);
      expect(stats.thoughtsPerSignificance['notable']).toBe(1);
      expect(stats.thoughtsPerSignificance['breakthrough']).toBe(1);
    });

    it('should track uptime', () => {
      const stats = stream.getStats();
      expect(stats.uptime).toBeGreaterThanOrEqual(0);
    });
  });

  describe('getEngineActivity', () => {
    it('should return engine activity list', () => {
      stream.emit('dream', 'dreaming', 'D1', 'notable');
      stream.emit('dream', 'discovering', 'D2', 'breakthrough');
      stream.emit('orchestrator', 'perceiving', 'O1');

      const activity = stream.getEngineActivity();
      expect(activity.length).toBe(2);

      const dreamActivity = activity.find(a => a.engine === 'dream');
      expect(dreamActivity).toBeDefined();
      expect(dreamActivity!.metrics.totalThoughts).toBe(2);
      expect(dreamActivity!.metrics.discoveries).toBe(1);
      expect(dreamActivity!.metrics.breakthroughs).toBe(1);
      expect(dreamActivity!.status).toBe('active');
    });
  });

  describe('clear', () => {
    it('should clear the buffer', () => {
      stream.emit('dream', 'dreaming', 'D1');
      stream.emit('orchestrator', 'perceiving', 'O1');
      stream.clear();
      expect(stream.getRecent(100).length).toBe(0);
      expect(stream.getStats().totalThoughts).toBe(0);
    });
  });

  describe('getListenerCount', () => {
    it('should return the number of active listeners', () => {
      expect(stream.getListenerCount()).toBe(0);
      const unsub1 = stream.onThought(() => {});
      const unsub2 = stream.onThought(() => {});
      expect(stream.getListenerCount()).toBe(2);
      unsub1();
      expect(stream.getListenerCount()).toBe(1);
      unsub2();
      expect(stream.getListenerCount()).toBe(0);
    });
  });
});

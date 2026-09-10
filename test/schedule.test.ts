import { describe, expect, it } from 'vitest';
import { failureBackoffMs, nextPollDelayMs } from '../src/services/schedule.js';

const MIN = 60_000;
const HOUR = 60 * MIN;

describe('schedule', () => {
  it('polls fresh posts often and old posts rarely', () => {
    const now = new Date('2026-09-10T12:00:00Z');
    const ago = (ms: number) => new Date(now.getTime() - ms);
    expect(nextPollDelayMs(ago(10 * MIN), now)).toBe(1 * MIN);
    expect(nextPollDelayMs(ago(5 * HOUR), now)).toBe(5 * MIN);
    expect(nextPollDelayMs(ago(3 * 24 * HOUR), now)).toBe(30 * MIN);
    expect(nextPollDelayMs(ago(20 * 24 * HOUR), now)).toBe(6 * HOUR);
    expect(nextPollDelayMs(ago(90 * 24 * HOUR), now)).toBe(24 * HOUR);
  });

  it('backs off exponentially with a cap', () => {
    expect(failureBackoffMs(1)).toBe(1 * MIN);
    expect(failureBackoffMs(2)).toBe(2 * MIN);
    expect(failureBackoffMs(5)).toBe(16 * MIN);
    expect(failureBackoffMs(30)).toBe(6 * HOUR);
  });
});

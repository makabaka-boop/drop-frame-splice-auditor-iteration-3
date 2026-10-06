import { describe, expect, it } from 'vitest';
import { formatFrame } from './timecode';
import { chooseTickStep, computeTimelineTicks } from './timeline';

const DAY_FRAMES = {
  '30000/1001': 2_589_408,
  '60000/1001': 5_178_816
} as const;

const RATES = ['30000/1001', '60000/1001'] as const;

describe('timeline ruler ticks', () => {
  it.each(RATES)('never emits the 24h wrap point at full-day zoom for %s', (rate) => {
    const dayFrames = DAY_FRAMES[rate];
    const ticks = computeTimelineTicks(0.0002, { scrollLeft: 0, width: 1200 }, dayFrames);
    expect(ticks.values.length).toBeGreaterThan(1);
    for (const frame of ticks.values) {
      expect(frame).toBeLessThan(dayFrames);
      expect(() => formatFrame(frame, rate)).not.toThrow();
    }
  });

  it.each(RATES)('stays inside the day when scrolled to the day end for %s', (rate) => {
    const dayFrames = DAY_FRAMES[rate];
    const pixelsPerFrame = 0.001;
    const scrollLeft = dayFrames * pixelsPerFrame - 600;
    const ticks = computeTimelineTicks(pixelsPerFrame, { scrollLeft, width: 1200 }, dayFrames);
    expect(ticks.values.length).toBeGreaterThan(0);
    const last = ticks.values[ticks.values.length - 1];
    expect(last).toBeLessThan(dayFrames);
    expect(last).toBeGreaterThan(dayFrames - 200_000);
    for (const frame of ticks.values) {
      expect(() => formatFrame(frame, rate)).not.toThrow();
    }
  });

  it.each(RATES)('keeps every zoom level of the app free of the wrap point for %s', (rate) => {
    const dayFrames = DAY_FRAMES[rate];
    for (const pixelsPerFrame of [0.0002, 0.001, 0.02, 0.08, 0.7, 2]) {
      const maxScroll = Math.max(0, dayFrames * pixelsPerFrame - 1200);
      for (const scrollLeft of [0, maxScroll / 2, maxScroll]) {
        const ticks = computeTimelineTicks(pixelsPerFrame, { scrollLeft, width: 1200 }, dayFrames);
        for (const frame of ticks.values) {
          expect(frame).toBeGreaterThanOrEqual(0);
          expect(frame).toBeLessThan(dayFrames);
          expect(() => formatFrame(frame, rate)).not.toThrow();
        }
      }
    }
  });

  it('falls back to the largest candidate step instead of the whole day', () => {
    const step = chooseTickStep(0.000_000_1, 96);
    expect(step).toBe(1_294_704);
    const ticks = computeTimelineTicks(0.000_000_1, { scrollLeft: 0, width: 1200 }, 2_589_408);
    expect(ticks.values).toEqual([0, 1_294_704]);
  });
});

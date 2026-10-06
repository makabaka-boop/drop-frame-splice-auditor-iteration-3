import { describe, expect, it } from 'vitest';
import { formatFrame, parseTimecode } from './timecode';

describe('drop-frame timecode integer frame conversion', () => {
  it('converts exact ten-minute and hour boundaries for 29.97', () => {
    expect(parseTimecode('00:00:00;00', '30000/1001').totalFrames).toBe(0);
    expect(parseTimecode('00:10:00;00', '30000/1001').totalFrames).toBe(17_982);
    expect(parseTimecode('01:00:00;00', '30000/1001').totalFrames).toBe(107_892);
    expect(parseTimecode('23:59:59;29', '30000/1001').totalFrames).toBe(2_589_407);

    expect(formatFrame(0, '30000/1001')).toBe('00:00:00;00');
    expect(formatFrame(17_982, '30000/1001')).toBe('00:10:00;00');
    expect(formatFrame(107_892, '30000/1001')).toBe('01:00:00;00');
    expect(formatFrame(2_589_407, '30000/1001')).toBe('23:59:59;29');
  });

  it('converts exact ten-minute and hour boundaries for 59.94', () => {
    expect(parseTimecode('00:00:00;00', '60000/1001').totalFrames).toBe(0);
    expect(parseTimecode('00:10:00;00', '60000/1001').totalFrames).toBe(35_964);
    expect(parseTimecode('01:00:00;00', '60000/1001').totalFrames).toBe(215_784);
    expect(parseTimecode('23:59:59;59', '60000/1001').totalFrames).toBe(5_178_815);

    expect(formatFrame(0, '60000/1001')).toBe('00:00:00;00');
    expect(formatFrame(35_964, '60000/1001')).toBe('00:10:00;00');
    expect(formatFrame(215_784, '60000/1001')).toBe('01:00:00;00');
    expect(formatFrame(5_178_815, '60000/1001')).toBe('23:59:59;59');
  });

  it('places the first legal frame of a dropping minute two or four frames after 60 nominal seconds', () => {
    expect(parseTimecode('00:01:00;02', '30000/1001').totalFrames).toBe(1_800);
    expect(formatFrame(1_800, '30000/1001')).toBe('00:01:00;02');

    expect(parseTimecode('00:01:00;04', '60000/1001').totalFrames).toBe(3_600);
    expect(formatFrame(3_600, '60000/1001')).toBe('00:01:00;04');
  });

  it.each([
    ['30000/1001', '00:01:00;00'],
    ['30000/1001', '00:01:00;01'],
    ['60000/1001', '00:01:00;00'],
    ['60000/1001', '00:01:00;03']
  ] as const)('rejects forbidden first-minute labels for %s: %s', (rate, timecode) => {
    expect(() => parseTimecode(timecode, rate)).toThrowError(/不存在/);
  });

  it('rejects malformed fields, over-range hours, and day wrap', () => {
    expect(() => parseTimecode('00:00:00:00', '30000/1001')).toThrowError(/HH:MM:SS;FF/);
    expect(() => parseTimecode('24:00:00;00', '30000/1001')).toThrowError();
    expect(() => parseTimecode('00:00:00;30', '30000/1001')).toThrowError();
    expect(() => parseTimecode('00:00:00;60', '60000/1001')).toThrowError();
    expect(() => formatFrame(2_589_408, '30000/1001')).toThrowError();
  });

  it.each(['30000/1001', '60000/1001'] as const)('round-trips boundaries and deterministic samples for %s', (rate) => {
    const dayFrames = rate === '30000/1001' ? 2_589_408 : 5_178_816;
    const nominal = rate === '30000/1001' ? 30 : 60;
    const dropped = nominal / 15;

    // Every ten-minute boundary and every legal minute boundary.
    for (let hour = 0; hour < 24; hour += 1) {
      for (let minute = 0; minute < 60; minute += 1) {
        const firstFrameOfMinute = minute % 10 === 0 ? 0 : dropped;
        const label = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00;${String(firstFrameOfMinute).padStart(2, '0')}`;
        const frame = parseTimecode(label, rate).totalFrames;
        expect(parseTimecode(formatFrame(frame, rate), rate).totalFrames).toBe(frame);
      }
    }

    // Deterministic pseudo-random sample over the full 24-hour day.
    let seed = 0x1234_5678;
    for (let i = 0; i < 10_000; i += 1) {
      seed = (seed * 1_664_525 + 1_013_904_223) >>> 0;
      const frame = seed % dayFrames;
      const label = formatFrame(frame, rate);
      expect(parseTimecode(label, rate).totalFrames).toBe(frame);
      expect(formatFrame(parseTimecode(label, rate).totalFrames, rate)).toBe(label);
    }
  });
});

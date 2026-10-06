import { describe, expect, it } from 'vitest';
import { analyzeInput, formatClipId } from './analysis';

const baseInput = {
  rate: '30000/1001',
  clips: [
    {
      id: 'A',
      sourceIn: '01:00:00;00',
      sourceOut: '01:00:05;00',
      recordIn: '00:10:00;00'
    },
    {
      id: 'B',
      sourceIn: '02:00:00;00',
      sourceOut: '02:00:05;00',
      recordIn: '00:10:05;00'
    },
    {
      id: 'C',
      sourceIn: '03:00:00;00',
      sourceOut: '03:00:05;00',
      recordIn: '00:10:11;00'
    },
    {
      id: 'D',
      sourceIn: '04:00:00;00',
      sourceOut: '04:00:05;00',
      recordIn: '00:10:15;00'
    }
  ]
} as const;

describe('edit decision analysis', () => {
  it('computes recordOut from integer frame duration and orders clips by record position', () => {
    const response = analyzeInput(baseInput);
    expect(response.ok).toBe(true);
    if (!response.ok) throw new Error(response.issues[0]?.message);

    const { clips, breaks, firstBreak } = response.result;
    expect(clips.map((clip) => clip.id)).toEqual(['A', 'B', 'C', 'D']);
    expect(clips.map((clip) => clip.durationFrames)).toEqual([150, 150, 150, 150]);
    expect(clips[0].recordOut.timecode).toBe('00:10:05;00');
    expect(clips[1].relation).toBe('contiguous');
    expect(clips[2].relation).toBe('gap');
    expect(clips[3].relation).toBe('overlap');
    expect(clips[2].gapBeforeFrames).toBe(30);
    expect(clips[3].overlapBeforeFrames).toBe(30);
    expect(breaks).toHaveLength(2);
    expect(firstBreak?.kind).toBe('gap');
    expect(firstBreak?.afterClipId).toBe('B');
    expect(firstBreak?.beforeClipId).toBe('C');
    expect(firstBreak?.start.timecode).toBe('00:10:10;00');
    expect(firstBreak?.end.timecode).toBe('00:10:11;00');
    expect(clips.find((clip) => clip.id === 'C')?.firstBreak).toBe(true);
  });

  it('uses the dropped minute boundary label after adding a one-minute duration', () => {
    const response = analyzeInput({
      rate: '30000/1001',
      clips: [
        {
          id: 1,
          sourceIn: '00:00:00;00',
          sourceOut: '00:01:00;02',
          recordIn: '00:00:00;00'
        }
      ]
    });
    expect(response.ok).toBe(true);
    if (!response.ok) throw new Error(response.issues[0]?.message);
    expect(response.result.clips[0].recordOut.frame).toBe(1_800);
    expect(response.result.clips[0].recordOut.timecode).toBe('00:01:00;02');
  });

  it('handles an interval contained by an earlier longer clip as overlap with that coverage', () => {
    const response = analyzeInput({
      rate: '30000/1001',
      clips: [
        {
          id: 'long',
          sourceIn: '01:00:00;00',
          sourceOut: '01:00:10;00',
          recordIn: '00:10:00;00'
        },
        {
          id: 'adjacent',
          sourceIn: '02:00:00;00',
          sourceOut: '02:00:02;00',
          recordIn: '00:10:10;00'
        },
        {
          id: 'inside-long',
          sourceIn: '03:00:00;00',
          sourceOut: '03:00:02;00',
          recordIn: '00:10:05;00'
        }
      ]
    });
    expect(response.ok).toBe(true);
    if (!response.ok) throw new Error(response.issues[0]?.message);
    const contained = response.result.clips.find((clip) => clip.id === 'inside-long');
    expect(contained?.relation).toBe('overlap');
    expect(contained?.previousClipId).toBe('long');
    // 半开区间交集：短片被完全包含时，重叠就是它自身的 60 帧，
    // 不能把短片结束之后直到长片结束的帧计入。
    expect(contained?.overlapBeforeFrames).toBe(60);
    const overlapBreak = response.result.breaks.find((item) => item.beforeClipId === 'inside-long');
    expect(overlapBreak?.durationFrames).toBe(60);
    expect(overlapBreak?.start.timecode).toBe('00:10:05;00');
    expect(overlapBreak?.end.timecode).toBe('00:10:07;00');
  });

  it('limits each of several short clips inside one long clip to its own half-open intersection', () => {
    const response = analyzeInput({
      rate: '30000/1001',
      clips: [
        {
          id: 'long',
          sourceIn: '01:00:00;00',
          sourceOut: '01:00:10;00',
          recordIn: '00:10:00;00'
        },
        {
          id: 's1',
          sourceIn: '02:00:00;00',
          sourceOut: '02:00:01;00',
          recordIn: '00:10:02;00'
        },
        {
          id: 's2',
          sourceIn: '03:00:00;00',
          sourceOut: '03:00:01;00',
          recordIn: '00:10:05;00'
        }
      ]
    });
    expect(response.ok).toBe(true);
    if (!response.ok) throw new Error(response.issues[0]?.message);

    const { clips, breaks, firstBreak } = response.result;
    expect(clips.map((clip) => clip.id)).toEqual(['long', 's1', 's2']);
    expect(clips[1].relation).toBe('overlap');
    expect(clips[1].overlapBeforeFrames).toBe(30);
    expect(clips[2].relation).toBe('overlap');
    expect(clips[2].overlapBeforeFrames).toBe(30);

    expect(breaks).toHaveLength(2);
    expect(breaks[0]).toMatchObject({
      kind: 'overlap',
      afterClipId: 'long',
      beforeClipId: 's1',
      durationFrames: 30
    });
    expect(breaks[0].start.timecode).toBe('00:10:02;00');
    expect(breaks[0].end.timecode).toBe('00:10:03;00');
    expect(breaks[1]).toMatchObject({
      kind: 'overlap',
      afterClipId: 'long',
      beforeClipId: 's2',
      durationFrames: 30
    });
    expect(breaks[1].start.timecode).toBe('00:10:05;00');
    expect(breaks[1].end.timecode).toBe('00:10:06;00');

    // 互不相接的短片，重叠带也互不覆盖，累计审阅范围就是两段自身长度之和。
    expect(breaks[0].end.frame).toBeLessThanOrEqual(breaks[1].start.frame);
    expect(firstBreak?.beforeClipId).toBe('s1');
    expect(clips[1].firstBreak).toBe(true);
  });

  it('keeps numeric and textual ids that look alike as distinct identities end to end', () => {
    const response = analyzeInput({
      rate: '30000/1001',
      clips: [
        {
          id: 1,
          sourceIn: '01:00:00;00',
          sourceOut: '01:00:05;00',
          recordIn: '00:10:00;00'
        },
        {
          id: '1',
          sourceIn: '02:00:00;00',
          sourceOut: '02:00:05;00',
          recordIn: '00:10:06;00'
        }
      ]
    });
    expect(response.ok).toBe(true);
    if (!response.ok) throw new Error(response.issues[0]?.message);

    const { clips, firstBreak } = response.result;
    expect(clips[0].id).toBe(1);
    expect(clips[1].id).toBe('1');
    expect(clips[1].relation).toBe('gap');
    expect(clips[1].gapBeforeFrames).toBe(30);
    expect(clips[1].previousClipId).toBe(1);

    expect(firstBreak?.kind).toBe('gap');
    expect(firstBreak?.afterClipId).toBe(1);
    expect(firstBreak?.beforeClipId).toBe('1');
    expect(typeof firstBreak?.afterClipId).toBe('number');
    expect(typeof firstBreak?.beforeClipId).toBe('string');

    // 导出快照经 JSON 往返后仍保留两种 id 的类型身份。
    const exported = JSON.parse(JSON.stringify(response.result)) as typeof response.result;
    expect(exported.clips[0].id).toBe(1);
    expect(exported.clips[1].id).toBe('1');
    expect(exported.firstBreak?.afterClipId).toBe(1);
    expect(exported.firstBreak?.beforeClipId).toBe('1');

    // 屏幕展示必须能区分二者。
    expect(formatClipId(1)).toBe('1');
    expect(formatClipId('1')).toBe('"1"');
    expect(formatClipId(1)).not.toBe(formatClipId('1'));
  });

  it('rejects structural errors, forbidden frames, non-positive durations, duplicates, and day wrap', () => {
    const invalidInputs = [
      null,
      { rate: '29.97', clips: [] },
      { rate: '30000/1001', clips: [] },
      { rate: '30000/1001', clips: [{}] },
      {
        rate: '30000/1001',
        clips: [
          { id: 'x', sourceIn: '00:01:00;00', sourceOut: '00:00:02;00', recordIn: '00:00:00;00' }
        ]
      },
      {
        rate: '30000/1001',
        clips: [
          { id: 'x', sourceIn: '00:00:02;00', sourceOut: '00:00:01;00', recordIn: '00:00:00;00' }
        ]
      },
      {
        rate: '30000/1001',
        clips: [
          { id: 'x', sourceIn: '00:00:00;00', sourceOut: '00:00:01;00', recordIn: '00:00:00;00' },
          { id: 'x', sourceIn: '00:00:00;00', sourceOut: '00:00:01;00', recordIn: '00:00:01;00' }
        ]
      },
      {
        rate: '30000/1001',
        clips: [
          { id: 'x', sourceIn: '00:00:00;00', sourceOut: '00:00:01;00', recordIn: '23:59:59;29' }
        ]
      }
    ];

    for (const input of invalidInputs) {
      const response = analyzeInput(input);
      expect(response.ok, JSON.stringify(input)).toBe(false);
      if (!response.ok) expect(response.issues.length).toBeGreaterThan(0);
    }
  });

  it('returns a serializable immutable analysis snapshot and does not recompute derived fields', () => {
    const response = analyzeInput(baseInput);
    expect(response.ok).toBe(true);
    if (!response.ok) throw new Error(response.issues[0]?.message);
    const exported = JSON.parse(JSON.stringify(response.result)) as typeof response.result;
    expect(exported.schemaVersion).toBe(1);
    expect(exported.clips[0].recordOut).toEqual(response.result.clips[0].recordOut);
    expect(exported.firstBreak).toEqual(response.result.firstBreak);
    expect(exported.dayFrames).toBe(2_589_408);
  });
});

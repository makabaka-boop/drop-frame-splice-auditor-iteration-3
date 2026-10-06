import { describe, expect, it } from 'vitest';
import { analyzeInput, type ClipId } from './analysis';
import { formatFrame, type DropFrameRate } from './timecode';
import {
  createSourceDeliveryExport,
  createSourceDeliveryPreview,
  parseSourceDeliverySelection,
  resolveSourceDelivery,
  type SourceDeliveryPreview
} from './delivery';

const RATE: DropFrameRate = '30000/1001';

interface ClipSpec {
  id: ClipId;
  sourceIn: number;
  sourceOut: number;
  recordIn: number;
  recordOut: number;
}

function idKey(id: ClipId): string {
  return `${typeof id}:${String(id)}`;
}

function analyze(specs: ClipSpec[]) {
  const response = analyzeInput({
    rate: RATE,
    clips: specs.map((spec) => ({
      id: spec.id,
      sourceIn: formatFrame(spec.sourceIn, RATE),
      sourceOut: formatFrame(spec.sourceOut, RATE),
      recordIn: formatFrame(spec.recordIn, RATE)
    }))
  });
  expect(response.ok).toBe(true);
  if (!response.ok) throw new Error(JSON.stringify(response.issues));
  return response.result;
}

const ORACLE_SPECS: ClipSpec[] = [
  { id: 'A', sourceIn: 100, sourceOut: 105, recordIn: 0, recordOut: 5 },
  { id: 'B', sourceIn: 200, sourceOut: 205, recordIn: 3, recordOut: 8 },
  { id: 'C', sourceIn: 300, sourceOut: 305, recordIn: 8, recordOut: 13 }
];

function membersAt(specs: ClipSpec[], frame: number): ClipSpec[] {
  return specs.filter((spec) => spec.recordIn <= frame && frame < spec.recordOut);
}

function memberKey(members: ClipSpec[]): string {
  return members.map((member) => idKey(member.id)).join('|');
}

/**
 * 逐帧覆盖集合预言机：相邻整数帧的贡献片段集合完全一致才合并，
 * 空集合、单成员和多成员都作为独立的最大区间。
 */
function oracleSegments(specs: ClipSpec[], startFrame: number, endFrame: number) {
  const expected: Array<{
    start: number;
    end: number;
    members: ClipSpec[];
  }> = [];
  let runStart = startFrame;
  let runMembers = membersAt(specs, startFrame);

  for (let frame = startFrame + 1; frame <= endFrame; frame++) {
    const members = frame === endFrame ? [] : membersAt(specs, frame);
    if (memberKey(members) !== memberKey(runMembers)) {
      expected.push({ start: runStart, end: frame, members: runMembers });
      runStart = frame;
      runMembers = members;
    }
  }

  return expected;
}

function expectPreviewMatchesOracle(
  preview: SourceDeliveryPreview,
  specs: ClipSpec[],
  startFrame: number,
  endFrame: number
) {
  const expected = oracleSegments(specs, startFrame, endFrame);
  expect(preview.segments).toHaveLength(expected.length);
  expect(preview.durationFrames).toBe(endFrame - startFrame);

  let gapTotal = 0;
  let conflictCount = 0;
  preview.segments.forEach((segment, index) => {
    const item = expected[index];
    expect(segment.index).toBe(index);
    expect(segment.recordStart.frame).toBe(item.start);
    expect(segment.recordEnd.frame).toBe(item.end);
    expect(segment.durationFrames).toBe(item.end - item.start);
    expect(segment.recordStart.timecode).toBe(formatFrame(item.start, RATE));
    expect(segment.recordEnd.timecode).toBe(formatFrame(item.end, RATE));

    expect(segment.contributions.map((contribution) => idKey(contribution.clipId))).toEqual(
      item.members.map((member) => idKey(member.id))
    );
    if (item.members.length === 0) {
      expect(segment.kind).toBe('gap');
      gapTotal += segment.durationFrames;
    } else if (item.members.length === 1) {
      expect(segment.kind).toBe('unique');
    } else {
      expect(segment.kind).toBe('conflict');
      conflictCount += 1;
    }

    for (const contribution of segment.contributions) {
      const spec = item.members.find((member) => idKey(member.id) === idKey(contribution.clipId))!;
      const expectedSourceStart = spec.sourceIn + (item.start - spec.recordIn);
      const expectedSourceEnd = spec.sourceIn + (item.end - spec.recordIn);
      expect(contribution.sourceStart.frame).toBe(expectedSourceStart);
      expect(contribution.sourceEnd.frame).toBe(expectedSourceEnd);
      expect(contribution.recordStart.frame).toBe(item.start);
      expect(contribution.recordEnd.frame).toBe(item.end);
      expect(contribution.durationFrames).toBe(item.end - item.start);
      expect(contribution.sourceStart.timecode).toBe(formatFrame(expectedSourceStart, RATE));
      expect(contribution.sourceEnd.timecode).toBe(formatFrame(expectedSourceEnd, RATE));
    }
  });

  expect(preview.gapFrameTotal).toBe(gapTotal);
  expect(preview.conflictSegmentCount).toBe(conflictCount);
}

describe('source delivery preview', () => {
  it('matches a frame-by-frame coverage-set oracle over a small integer frame domain', () => {
    const result = analyze(ORACLE_SPECS);

    for (let startFrame = 0; startFrame <= 13; startFrame++) {
      for (let endFrame = startFrame + 1; endFrame <= 13; endFrame++) {
        const preview = createSourceDeliveryPreview(result, { startFrame, endFrame });
        expectPreviewMatchesOracle(preview, ORACLE_SPECS, startFrame, endFrame);
      }
    }
  });

  it('classifies gaps, unique sources and conflicts and maps every contribution back to source frames', () => {
    const specs: ClipSpec[] = [
      { id: 'A', sourceIn: 100, sourceOut: 105, recordIn: 0, recordOut: 5 },
      { id: 'B', sourceIn: 200, sourceOut: 204, recordIn: 3, recordOut: 7 },
      { id: 'C', sourceIn: 300, sourceOut: 305, recordIn: 9, recordOut: 14 }
    ];
    const preview = createSourceDeliveryPreview(analyze(specs), { startFrame: 0, endFrame: 10 });

    expect(preview.segments.map((segment) => [
      segment.recordStart.frame,
      segment.recordEnd.frame,
      segment.kind
    ])).toEqual([
      [0, 3, 'unique'],
      [3, 5, 'conflict'],
      [5, 7, 'unique'],
      [7, 9, 'gap'],
      [9, 10, 'unique']
    ]);
    expect(preview.gapFrameTotal).toBe(2);
    expect(preview.conflictSegmentCount).toBe(1);

    const conflict = preview.segments.find((segment) => segment.kind === 'conflict')!;
    expect(conflict.contributions.map((contribution) => contribution.clipId)).toEqual(['A', 'B']);
    expect(conflict.contributions).toMatchObject([
      {
        clipId: 'A',
        sourceStart: { frame: 103 },
        sourceEnd: { frame: 105 },
        recordStart: { frame: 3 },
        recordEnd: { frame: 5 }
      },
      {
        clipId: 'B',
        sourceStart: { frame: 200 },
        sourceEnd: { frame: 202 },
        recordStart: { frame: 3 },
        recordEnd: { frame: 5 }
      }
    ]);
  });

  it('requires conflict adjudication and refuses to export while gaps remain', () => {
    const specs: ClipSpec[] = [
      { id: 'A', sourceIn: 100, sourceOut: 105, recordIn: 0, recordOut: 5 },
      { id: 'B', sourceIn: 200, sourceOut: 204, recordIn: 3, recordOut: 7 },
      { id: 'C', sourceIn: 300, sourceOut: 305, recordIn: 9, recordOut: 14 }
    ];
    const preview = createSourceDeliveryPreview(analyze(specs), { startFrame: 0, endFrame: 10 });

    const unresolved = resolveSourceDelivery(preview, {});
    expect(unresolved.ok).toBe(false);
    if (!unresolved.ok) {
      expect(unresolved.issues.map((issue) => issue.code)).toContain('DELIVERY_CONFLICT_UNRESOLVED');
      expect(unresolved.issues.map((issue) => issue.code)).toContain('DELIVERY_GAP');
    }

    const conflictIndex = preview.segments.findIndex((segment) => segment.kind === 'conflict');
    const decidedButGap = resolveSourceDelivery(preview, { [conflictIndex]: 'B' });
    expect(decidedButGap.ok).toBe(false);
    if (!decidedButGap.ok) {
      expect(decidedButGap.issues).toHaveLength(1);
      expect(decidedButGap.issues[0].code).toBe('DELIVERY_GAP');
    }

    const staleDecision = resolveSourceDelivery(preview, { [conflictIndex]: 'NOT-A-CONTRIBUTOR' });
    expect(staleDecision.ok).toBe(false);
    if (!staleDecision.ok) {
      expect(staleDecision.issues.some((issue) => issue.code === 'DELIVERY_DECISION_NOT_A_CONTRIBUTOR')).toBe(true);
    }
  });

  it('merges only adjacent runs with the same clip identity and continuous source and record coordinates', () => {
    const specs: ClipSpec[] = [
      { id: 'A', sourceIn: 100, sourceOut: 112, recordIn: 0, recordOut: 12 },
      { id: 'B', sourceIn: 200, sourceOut: 208, recordIn: 2, recordOut: 10 },
      { id: 'C', sourceIn: 300, sourceOut: 304, recordIn: 4, recordOut: 8 }
    ];
    const preview = createSourceDeliveryPreview(analyze(specs), { startFrame: 0, endFrame: 12 });
    expect(preview.segments.map((segment) => segment.kind)).toEqual([
      'unique',
      'conflict',
      'conflict',
      'conflict',
      'unique'
    ]);

    const chooseA = resolveSourceDelivery(preview, { 1: 'A', 2: 'A', 3: 'A' });
    expect(chooseA.ok).toBe(true);
    if (chooseA.ok) {
      expect(chooseA.items).toHaveLength(1);
      expect(chooseA.items[0]).toMatchObject({
        clipId: 'A',
        sourceIn: { frame: 100 },
        sourceOut: { frame: 112 },
        recordIn: { frame: 0 },
        recordOut: { frame: 12 },
        durationFrames: 12,
        firstSegmentIndex: 0,
        lastSegmentIndex: 4
      });
    }

    const chooseB = resolveSourceDelivery(preview, { 1: 'B', 2: 'B', 3: 'B' });
    expect(chooseB.ok).toBe(true);
    if (chooseB.ok) {
      expect(chooseB.items.map((item) => [item.clipId, item.recordIn.frame, item.recordOut.frame])).toEqual([
        ['A', 0, 2],
        ['B', 2, 10],
        ['A', 10, 12]
      ]);
      expect(chooseB.items[1].sourceIn.frame).toBe(200);
      expect(chooseB.items[1].sourceOut.frame).toBe(208);
    }

    const alternating = resolveSourceDelivery(preview, { 1: 'A', 2: 'B', 3: 'A' });
    expect(alternating.ok).toBe(true);
    if (alternating.ok) {
      expect(alternating.items.map((item) => item.clipId)).toEqual(['A', 'B', 'A']);
      // 同一片 A 被 B 隔开，即使两端在原片和录制轴上都不相邻，也不能合并。
      expect(alternating.items[0].recordOut.frame).toBe(4);
      expect(alternating.items[2].recordIn.frame).toBe(8);
      const exportPayload = createSourceDeliveryExport(preview, alternating);
      expect(exportPayload.itemCount).toBe(3);
      expect(exportPayload.deliveredFrameTotal).toBe(12);
      expect(Object.keys(exportPayload).sort()).toEqual([
        'dayFrames',
        'deliveredFrameTotal',
        'durationFrames',
        'itemCount',
        'items',
        'rate',
        'schemaVersion',
        'selectionEnd',
        'selectionStart'
      ]);
    }
  });

  it('keeps numeric and look-alike string contributions distinct and serializable', () => {
    const specs: ClipSpec[] = [
      { id: 1, sourceIn: 100, sourceOut: 104, recordIn: 0, recordOut: 4 },
      { id: '1', sourceIn: 200, sourceOut: 204, recordIn: 2, recordOut: 6 }
    ];
    const preview = createSourceDeliveryPreview(analyze(specs), { startFrame: 0, endFrame: 4 });
    const conflict = preview.segments.find((segment) => segment.kind === 'conflict')!;
    expect(conflict.contributions.map((contribution) => contribution.clipId)).toEqual([1, '1']);

    const resolution = resolveSourceDelivery(preview, { [conflict.index]: 1 });
    expect(resolution.ok).toBe(true);
    if (resolution.ok) {
      const payload = createSourceDeliveryExport(preview, resolution);
      const roundTripped = JSON.parse(JSON.stringify(payload)) as ReturnType<typeof createSourceDeliveryExport>;
      const merged = roundTripped.items.find((item) => typeof item.clipId === 'number');
      expect(merged?.clipId).toBe(1);
      expect(roundTripped.items.some((item) => item.clipId === '1')).toBe(false);
    }
  });

  it('parses half-open drop-frame selection timecodes and rejects empty or reversed ranges', () => {
    const valid = parseSourceDeliverySelection(RATE, formatFrame(1800, RATE), formatFrame(1830, RATE));
    expect(valid).toEqual({ ok: true, selection: { startFrame: 1800, endFrame: 1830 } });

    const badTimecode = parseSourceDeliverySelection(RATE, '00:01:00;00', '00:01:01;00');
    expect(badTimecode.ok).toBe(false);
    if (!badTimecode.ok) expect(badTimecode.issues[0].code).toBe('DELIVERY_SELECTION_TIMECODE');

    const reversed = parseSourceDeliverySelection(RATE, '00:00:01;00', '00:00:01;00');
    expect(reversed.ok).toBe(false);
    if (!reversed.ok) expect(reversed.issues[0].code).toBe('DELIVERY_SELECTION_REVERSED');
  });
});

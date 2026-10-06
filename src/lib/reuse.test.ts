import { describe, expect, it } from 'vitest';
import { analyzeInput, formatClipId, type ClipId } from './analysis';
import { auditSourceReuse, type SourceReuseReport } from './reuse';
import { formatFrame, type DropFrameRate } from './timecode';

const RATE: DropFrameRate = '30000/1001';
const DAY_FRAMES = 2_589_408;

interface ClipSpec {
  id: ClipId;
  sourceIn: number;
  sourceOut: number;
  recordIn: number;
}

function analyze(specs: ClipSpec[], rate: DropFrameRate = RATE) {
  const response = analyzeInput({
    rate,
    clips: specs.map((spec) => ({
      id: spec.id,
      sourceIn: formatFrame(spec.sourceIn, rate),
      sourceOut: formatFrame(spec.sourceOut, rate),
      recordIn: formatFrame(spec.recordIn, rate)
    }))
  });
  expect(response.ok).toBe(true);
  if (!response.ok) throw new Error(JSON.stringify(response.issues));
  return response;
}

/** 类型感知的身份键：数值 1 与字符串 "1" 必须区分。 */
function idKey(id: ClipId): string {
  return `${typeof id}:${String(id)}`;
}

interface OracleSegment {
  start: number;
  end: number;
  members: ClipId[];
}

/**
 * 逐帧成员集合预言机：对来源轴上每一帧算出覆盖它的片段集合，
 * 相邻帧集合（≥2 片）完全相同才并入同一段，集合一变立即断开。
 */
function oracle(specs: ClipSpec[]): OracleSegment[] {
  const segments: OracleSegment[] = [];
  const minStart = Math.min(...specs.map((spec) => spec.sourceIn));
  const maxEnd = Math.max(...specs.map((spec) => spec.sourceOut));
  let runStart: number | null = null;
  let runKey: string | null = null;
  let runMembers: ClipId[] = [];

  for (let frame = minStart; frame <= maxEnd; frame++) {
    const members =
      frame < maxEnd
        ? specs
            .filter((spec) => spec.sourceIn <= frame && frame < spec.sourceOut)
            .map((spec) => spec.id)
        : [];
    const key = members.length >= 2 ? members.map(idKey).sort().join('|') : null;
    if (key !== runKey) {
      if (runKey !== null && runStart !== null) {
        segments.push({ start: runStart, end: frame, members: runMembers });
      }
      runStart = key === null ? null : frame;
      runKey = key;
      runMembers = key === null ? [] : members;
    }
  }
  return segments;
}

/** 用逐帧预言机全量核对报告：边界、成员、计数、时码显示与逐帧录制落点。 */
function expectReportMatchesOracle(report: SourceReuseReport, specs: ClipSpec[], rate: DropFrameRate = RATE) {
  const expected = oracle(specs);
  expect(report.segmentCount).toBe(expected.length);
  expect(report.segments).toHaveLength(expected.length);
  expect(report.reusedFrameTotal).toBe(
    expected.reduce((sum, segment) => sum + (segment.end - segment.start), 0)
  );

  const recordOrder = [...specs]
    .sort((a, b) => a.recordIn - b.recordIn)
    .map((spec) => idKey(spec.id));

  report.segments.forEach((segment, index) => {
    const exp = expected[index];
    expect(segment.index).toBe(index);
    expect(segment.sourceStart.frame).toBe(exp.start);
    expect(segment.sourceEnd.frame).toBe(exp.end);
    expect(segment.durationFrames).toBe(exp.end - exp.start);
    // 时码仅作显示：必须等于整数帧的格式化结果。
    expect(segment.sourceStart.timecode).toBe(formatFrame(exp.start, rate));
    expect(segment.sourceEnd.timecode).toBe(formatFrame(exp.end, rate));

    // 成员集合与预言机一致，且按录制时间线顺序列出。
    const expectedMemberKeys = exp.members.map(idKey).sort();
    expect([...segment.clipIds].map(idKey).sort()).toEqual(expectedMemberKeys);
    expect(segment.coverCount).toBe(exp.members.length);
    expect(segment.clipIds.map(idKey)).toEqual(
      recordOrder.filter((key) => expectedMemberKeys.includes(key))
    );

    // 每个覆盖片段按自己的 recordIn 平移出录制区间。
    expect(segment.placements.map((placement) => idKey(placement.clipId))).toEqual(
      segment.clipIds.map(idKey)
    );
    for (const placement of segment.placements) {
      const spec = specs.find((item) => idKey(item.id) === idKey(placement.clipId))!;
      expect(placement.recordStart.frame).toBe(spec.recordIn + (exp.start - spec.sourceIn));
      expect(placement.recordEnd.frame).toBe(spec.recordIn + (exp.end - spec.sourceIn));
      expect(placement.recordStart.timecode).toBe(formatFrame(placement.recordStart.frame, rate));
      expect(placement.recordEnd.timecode).toBe(formatFrame(placement.recordEnd.frame, rate));
      expect(placement.recordEnd.frame).toBeLessThan(report.dayFrames);
    }

    // 逐帧核对：段内每个来源帧在每个覆盖片段里的录制落点都落在声明区间内。
    for (let frame = exp.start; frame < exp.end; frame++) {
      for (const placement of segment.placements) {
        const spec = specs.find((item) => idKey(item.id) === idKey(placement.clipId))!;
        const recordFrame = spec.recordIn + (frame - spec.sourceIn);
        expect(recordFrame).toBeGreaterThanOrEqual(placement.recordStart.frame);
        expect(recordFrame).toBeLessThan(placement.recordEnd.frame);
      }
    }
  });
}

describe('source reuse audit', () => {
  it('attaches a read-only reuse report to every valid analysis without touching the export', () => {
    const specs: ClipSpec[] = [
      { id: 'A', sourceIn: 0, sourceOut: 150, recordIn: 10_000 },
      { id: 'B', sourceIn: 90, sourceOut: 240, recordIn: 20_000 }
    ];
    const response = analyze(specs);

    // 每份有效分析都携带复用审计，且与独立计算结果一致。
    expect(response.reuseReport).toEqual(auditSourceReuse(response.result));

    // 原核对结果结构逐项不变，导出 JSON 不混入复用报告。
    expect(Object.keys(response.result).sort()).toEqual([
      'breaks',
      'clips',
      'dayFrames',
      'firstBreak',
      'rate',
      'schemaVersion'
    ]);
    const exported = JSON.stringify(response.result);
    expect(exported).not.toContain('segments');
    expect(exported).not.toContain('reuseReport');

    // 复用报告是独立对象，可单独序列化下载。
    expect(Object.keys(response.reuseReport).sort()).toEqual([
      'clipCount',
      'dayFrames',
      'rate',
      'reusedFrameTotal',
      'schemaVersion',
      'segmentCount',
      'segments'
    ]);
    const roundTripped = JSON.parse(JSON.stringify(response.reuseReport)) as SourceReuseReport;
    expect(roundTripped).toEqual(response.reuseReport);
  });

  it('reports a short clip contained in a longer one as the shorter interval itself', () => {
    const specs: ClipSpec[] = [
      { id: 'long', sourceIn: 0, sourceOut: 300, recordIn: 1_000 },
      { id: 'short', sourceIn: 60, sourceOut: 120, recordIn: 5_000 }
    ];
    const response = analyze(specs);
    expectReportMatchesOracle(response.reuseReport, specs);

    const [segment] = response.reuseReport.segments;
    expect(segment.sourceStart.frame).toBe(60);
    expect(segment.sourceEnd.frame).toBe(120);
    expect(segment.clipIds).toEqual(['long', 'short']);
    // 长片落点随段平移，短片落点从自己的 recordIn 开始。
    expect(segment.placements[0]).toMatchObject({
      clipId: 'long',
      recordStart: { frame: 1_060 },
      recordEnd: { frame: 1_120 }
    });
    expect(segment.placements[1]).toMatchObject({
      clipId: 'short',
      recordStart: { frame: 5_000 },
      recordEnd: { frame: 5_060 }
    });
  });

  it('reports the crossing overlap of two clips on both rates', () => {
    for (const rate of ['30000/1001', '60000/1001'] as const) {
      const specs: ClipSpec[] = [
        { id: 'A', sourceIn: 0, sourceOut: 150, recordIn: 10_000 },
        { id: 'B', sourceIn: 90, sourceOut: 240, recordIn: 20_000 }
      ];
      const response = analyze(specs, rate);
      expectReportMatchesOracle(response.reuseReport, specs, rate);
      expect(response.reuseReport.rate).toBe(rate);
      const [segment] = response.reuseReport.segments;
      expect(segment.sourceStart.frame).toBe(90);
      expect(segment.sourceEnd.frame).toBe(150);
      expect(segment.coverCount).toBe(2);
    }
  });

  it('splits triple coverage into set-constant runs', () => {
    const specs: ClipSpec[] = [
      { id: 'A', sourceIn: 0, sourceOut: 300, recordIn: 1_000 },
      { id: 'B', sourceIn: 60, sourceOut: 240, recordIn: 2_000 },
      { id: 'C', sourceIn: 90, sourceOut: 150, recordIn: 3_000 }
    ];
    const response = analyze(specs);
    expectReportMatchesOracle(response.reuseReport, specs);

    const segments = response.reuseReport.segments;
    expect(segments).toHaveLength(3);
    expect(segments.map((segment) => [segment.sourceStart.frame, segment.sourceEnd.frame])).toEqual([
      [60, 90],
      [90, 150],
      [150, 240]
    ]);
    expect(segments.map((segment) => segment.coverCount)).toEqual([2, 3, 2]);
    expect(segments[1].clipIds).toEqual(['A', 'B', 'C']);
    expect(response.reuseReport.reusedFrameTotal).toBe(30 + 60 + 90);
  });

  it('treats adjacent half-open endpoints as not reused', () => {
    const specs: ClipSpec[] = [
      { id: 'A', sourceIn: 0, sourceOut: 150, recordIn: 1_000 },
      { id: 'B', sourceIn: 150, sourceOut: 300, recordIn: 2_000 }
    ];
    const response = analyze(specs);
    expectReportMatchesOracle(response.reuseReport, specs);
    expect(response.reuseReport.segments).toHaveLength(0);
    expect(response.reuseReport.reusedFrameTotal).toBe(0);
  });

  it('breaks segments when the active id set changes even at equal cover count', () => {
    // A 全程在线，B 覆盖前半、C 覆盖后半：两段计数都是 2，但成员集合不同，不得合并。
    const specs: ClipSpec[] = [
      { id: 'A', sourceIn: 0, sourceOut: 300, recordIn: 1_000 },
      { id: 'B', sourceIn: 0, sourceOut: 150, recordIn: 2_000 },
      { id: 'C', sourceIn: 150, sourceOut: 300, recordIn: 3_000 }
    ];
    const response = analyze(specs);
    expectReportMatchesOracle(response.reuseReport, specs);

    const segments = response.reuseReport.segments;
    expect(segments).toHaveLength(2);
    expect(segments[0].clipIds).toEqual(['A', 'B']);
    expect(segments[1].clipIds).toEqual(['A', 'C']);
    expect(segments[0].coverCount).toBe(2);
    expect(segments[1].coverCount).toBe(2);
    expect(segments[0].sourceEnd.frame).toBe(150);
    expect(segments[1].sourceStart.frame).toBe(150);
  });

  it('keeps numeric and look-alike string ids as distinct members of one segment', () => {
    const specs: ClipSpec[] = [
      { id: 1, sourceIn: 0, sourceOut: 120, recordIn: 1_000 },
      { id: '1', sourceIn: 0, sourceOut: 120, recordIn: 2_000 },
      { id: 2, sourceIn: 60, sourceOut: 180, recordIn: 3_000 }
    ];
    const response = analyze(specs);
    expectReportMatchesOracle(response.reuseReport, specs);

    const segments = response.reuseReport.segments;
    expect(segments).toHaveLength(2);
    // 1 与 "1" 同字面但身份不同，必须同时出现在成员里。
    expect(segments[0].clipIds).toEqual([1, '1']);
    expect(segments[0].coverCount).toBe(2);
    expect(segments[1].clipIds).toEqual([1, '1', 2]);
    expect(segments[1].coverCount).toBe(3);

    // JSON 往返后身份类型不变。
    const roundTripped = JSON.parse(JSON.stringify(response.reuseReport)) as SourceReuseReport;
    const first = roundTripped.segments[0];
    expect(first.clipIds[0]).toBe(1);
    expect(first.clipIds[1]).toBe('1');
    expect(typeof first.clipIds[0]).toBe('number');
    expect(typeof first.clipIds[1]).toBe('string');
    expect(first.placements.map((placement) => placement.clipId)).toEqual([1, '1']);

    // 展示层同样能区分二者。
    expect(formatClipId(1)).not.toBe(formatClipId('1'));
  });

  it('returns an empty report when no source frame is reused', () => {
    const specs: ClipSpec[] = [
      { id: 'A', sourceIn: 0, sourceOut: 100, recordIn: 1_000 },
      { id: 'B', sourceIn: 1_000, sourceOut: 1_100, recordIn: 2_000 }
    ];
    const response = analyze(specs);
    expectReportMatchesOracle(response.reuseReport, specs);
    expect(response.reuseReport.segmentCount).toBe(0);
    expect(response.reuseReport.clipCount).toBe(2);
  });

  it('handles reuse that ends at the last frame of the day without wrapping', () => {
    const lastFrame = DAY_FRAMES - 1; // 23:59:59;29，日内最后一帧
    const specs: ClipSpec[] = [
      { id: 'tailA', sourceIn: lastFrame - 90, sourceOut: lastFrame, recordIn: 1_000 },
      { id: 'tailB', sourceIn: lastFrame - 60, sourceOut: lastFrame, recordIn: lastFrame - 60 }
    ];
    const response = analyze(specs);
    expectReportMatchesOracle(response.reuseReport, specs);

    const [segment] = response.reuseReport.segments;
    expect(segment.sourceEnd.frame).toBe(lastFrame);
    expect(segment.sourceEnd.timecode).toBe('23:59:59;29');
    // 录制落点顶到日末最后一帧也不回绕。
    const tailB = segment.placements.find((placement) => placement.clipId === 'tailB')!;
    expect(tailB.recordEnd.frame).toBe(lastFrame);
    expect(tailB.recordEnd.timecode).toBe('23:59:59;29');
  });
});

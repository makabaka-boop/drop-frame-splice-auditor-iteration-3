import { describe, expect, it } from 'vitest';
import { analyzeInput, type ClipId } from './analysis';
import {
  buildProvenanceManifest,
  buildProvenancePreview,
  collectProvenanceBlockers,
  type ProvenancePreview
} from './provenance';
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

function previewOf(specs: ClipSpec[], selStart: number, selEnd: number, rate: DropFrameRate = RATE) {
  const { result } = analyze(specs, rate);
  const response = buildProvenancePreview(
    result,
    formatFrame(selStart, rate),
    formatFrame(selEnd, rate)
  );
  expect(response.ok).toBe(true);
  if (!response.ok) throw new Error(JSON.stringify(response.issues));
  return response.preview;
}

/** 类型感知的身份键：数值 1 与字符串 "1" 必须区分。 */
function idKey(id: ClipId): string {
  return `${typeof id}:${String(id)}`;
}

function recordOut(spec: ClipSpec): number {
  return spec.recordIn + (spec.sourceOut - spec.sourceIn);
}

interface OracleRun {
  start: number;
  end: number;
  members: ClipId[];
}

/**
 * 逐帧覆盖集合预言机：对选区内每一个整数帧算出覆盖它的片段集合，
 * 相邻帧集合完全相同才并入同一段，集合一变立即断开（空集合即空隙）。
 */
function oracle(specs: ClipSpec[], selStart: number, selEnd: number): OracleRun[] {
  const runs: OracleRun[] = [];
  let runStart: number | null = null;
  let runKey: string | null = null;
  let runMembers: ClipId[] = [];

  for (let frame = selStart; frame <= selEnd; frame++) {
    const members =
      frame < selEnd
        ? specs
            .filter((spec) => spec.recordIn <= frame && frame < recordOut(spec))
            .map((spec) => spec.id)
        : null;
    const key = members === null ? null : members.map(idKey).sort().join('|');
    if (key !== runKey) {
      if (runKey !== null && runStart !== null) {
        runs.push({ start: runStart, end: frame, members: runMembers });
      }
      runStart = key === null ? null : frame;
      runKey = key;
      runMembers = key === null ? [] : members!;
    }
  }
  return runs;
}

/** 用逐帧预言机全量核对预演：分段、类型、成员集合、原片与录制坐标。 */
function expectPreviewMatchesOracle(
  preview: ProvenancePreview,
  specs: ClipSpec[],
  selStart: number,
  selEnd: number,
  rate: DropFrameRate = RATE
) {
  const expected = oracle(specs, selStart, selEnd);
  expect(preview.segmentCount).toBe(expected.length);
  expect(preview.segments).toHaveLength(expected.length);

  const recordOrder = [...specs]
    .sort((a, b) => a.recordIn - b.recordIn || recordOut(a) - recordOut(b))
    .map((spec) => idKey(spec.id));

  // 选区元数据与汇总计数。
  expect(preview.selection.recordStart.frame).toBe(selStart);
  expect(preview.selection.recordEnd.frame).toBe(selEnd);
  expect(preview.selection.durationFrames).toBe(selEnd - selStart);
  expect(preview.selection.recordStart.timecode).toBe(formatFrame(selStart, rate));
  expect(preview.selection.recordEnd.timecode).toBe(formatFrame(selEnd, rate));
  expect(preview.gapSegmentCount).toBe(expected.filter((run) => run.members.length === 0).length);
  expect(preview.conflictSegmentCount).toBe(
    expected.filter((run) => run.members.length >= 2).length
  );
  expect(preview.gapFrameTotal).toBe(
    expected
      .filter((run) => run.members.length === 0)
      .reduce((sum, run) => sum + (run.end - run.start), 0)
  );
  expect(preview.conflictFrameTotal).toBe(
    expected
      .filter((run) => run.members.length >= 2)
      .reduce((sum, run) => sum + (run.end - run.start), 0)
  );

  preview.segments.forEach((segment, index) => {
    const exp = expected[index];
    expect(segment.index).toBe(index);
    expect(segment.recordStart.frame).toBe(exp.start);
    expect(segment.recordEnd.frame).toBe(exp.end);
    expect(segment.durationFrames).toBe(exp.end - exp.start);
    // 时码仅作显示：必须等于整数帧的格式化结果。
    expect(segment.recordStart.timecode).toBe(formatFrame(exp.start, rate));
    expect(segment.recordEnd.timecode).toBe(formatFrame(exp.end, rate));

    const expectedKind = exp.members.length === 0 ? 'gap' : exp.members.length === 1 ? 'unique' : 'conflict';
    expect(segment.kind).toBe(expectedKind);

    // 成员集合与预言机一致，且按录制时间线顺序列出。
    const expectedMemberKeys = exp.members.map(idKey).sort();
    expect([...segment.contributions.map((item) => item.clipId)].map(idKey).sort()).toEqual(
      expectedMemberKeys
    );
    expect(segment.contributions.map((item) => idKey(item.clipId))).toEqual(
      recordOrder.filter((key) => expectedMemberKeys.includes(key))
    );

    // 每个贡献片段精确平移回原片起止帧。
    for (const contribution of segment.contributions) {
      const spec = specs.find((item) => idKey(item.id) === idKey(contribution.clipId))!;
      expect(contribution.sourceStart.frame).toBe(spec.sourceIn + (exp.start - spec.recordIn));
      expect(contribution.sourceEnd.frame).toBe(spec.sourceIn + (exp.end - spec.recordIn));
      expect(contribution.sourceStart.timecode).toBe(
        formatFrame(contribution.sourceStart.frame, rate)
      );
      expect(contribution.sourceEnd.timecode).toBe(formatFrame(contribution.sourceEnd.frame, rate));
    }

    // 与前后段互不接合：段与段首尾相连、无重叠，整体恰好铺满选区。
    if (index > 0) {
      expect(preview.segments[index - 1].recordEnd.frame).toBe(segment.recordStart.frame);
    }
  });
  expect(preview.segments[0]?.recordStart.frame ?? selStart).toBe(selStart);
  expect(preview.segments[preview.segments.length - 1]?.recordEnd.frame ?? selEnd).toBe(selEnd);

  // 逐帧核对：选区内每一帧落在恰好一段里，且该段贡献集合等于预言机集合。
  for (let frame = selStart; frame < selEnd; frame++) {
    const segment = preview.segments.find(
      (item) => item.recordStart.frame <= frame && frame < item.recordEnd.frame
    )!;
    expect(segment).toBeDefined();
    const expectedKeys = specs
      .filter((spec) => spec.recordIn <= frame && frame < recordOut(spec))
      .map((spec) => idKey(spec.id))
      .sort();
    expect(segment.contributions.map((item) => idKey(item.clipId)).sort()).toEqual(expectedKeys);
    // 该帧在每个贡献片段里的原片落点都位于声明的原片区间内。
    for (const contribution of segment.contributions) {
      const spec = specs.find((item) => idKey(item.id) === idKey(contribution.clipId))!;
      const sourceFrame = spec.sourceIn + (frame - spec.recordIn);
      expect(sourceFrame).toBeGreaterThanOrEqual(contribution.sourceStart.frame);
      expect(sourceFrame).toBeLessThan(contribution.sourceEnd.frame);
    }
  }
}

describe('provenance preview segmentation', () => {
  it('splits a selection into gap, unique and conflict runs matching the per-frame oracle', () => {
    // 小帧域：甲 [100,200) 与乙 [150,260) 交叉，丙 [320,380) 独立，选区首尾都留空隙。
    const specs: ClipSpec[] = [
      { id: '甲', sourceIn: 1_000, sourceOut: 1_100, recordIn: 100 },
      { id: '乙', sourceIn: 2_000, sourceOut: 2_110, recordIn: 150 },
      { id: '丙', sourceIn: 3_000, sourceOut: 3_060, recordIn: 320 }
    ];
    const preview = previewOf(specs, 80, 420);
    expectPreviewMatchesOracle(preview, specs, 80, 420);

    expect(preview.segments.map((segment) => segment.kind)).toEqual([
      'gap',
      'unique',
      'conflict',
      'unique',
      'gap',
      'unique',
      'gap'
    ]);
    expect(
      preview.segments.map((segment) => [segment.recordStart.frame, segment.recordEnd.frame])
    ).toEqual([
      [80, 100],
      [100, 150],
      [150, 200],
      [200, 260],
      [260, 320],
      [320, 380],
      [380, 420]
    ]);
    const conflict = preview.segments[2];
    expect(conflict.contributions.map((item) => item.clipId)).toEqual(['甲', '乙']);
    // 甲：source 1000+(150-100)=1050 → 1000+(200-100)=1100；乙：2000 → 2050。
    expect(conflict.contributions[0].sourceStart.frame).toBe(1_050);
    expect(conflict.contributions[0].sourceEnd.frame).toBe(1_100);
    expect(conflict.contributions[1].sourceStart.frame).toBe(2_000);
    expect(conflict.contributions[1].sourceEnd.frame).toBe(2_050);
  });

  it('matches the oracle for containment, triple coverage and set changes at equal count', () => {
    // 长片包住短片；三重覆盖；同计数但成员集合变化必须断开。
    const batteries: ClipSpec[][] = [
      [
        { id: 'long', sourceIn: 0, sourceOut: 300, recordIn: 10 },
        { id: 'short', sourceIn: 60, sourceOut: 120, recordIn: 70 }
      ],
      [
        { id: 'A', sourceIn: 0, sourceOut: 300, recordIn: 0 },
        { id: 'B', sourceIn: 0, sourceOut: 180, recordIn: 60 },
        { id: 'C', sourceIn: 0, sourceOut: 60, recordIn: 90 }
      ],
      // A 全程在线，B 覆盖前半、C 覆盖后半：两段冲突计数都是 2，成员集合不同，必须断开。
      [
        { id: 'A', sourceIn: 0, sourceOut: 300, recordIn: 0 },
        { id: 'B', sourceIn: 0, sourceOut: 150, recordIn: 0 },
        { id: 'C', sourceIn: 150, sourceOut: 300, recordIn: 150 }
      ],
      // 半开端点交接：两段唯一来源成员集合不同，不得合并。
      [
        { id: 'A', sourceIn: 0, sourceOut: 150, recordIn: 0 },
        { id: 'B', sourceIn: 300, sourceOut: 450, recordIn: 150 }
      ]
    ];
    for (const specs of batteries) {
      const preview = previewOf(specs, 0, 320);
      expectPreviewMatchesOracle(preview, specs, 0, 320);
    }

    // 同计数成员集合变化：两段冲突不得合并。
    const setChange = batteries[2];
    const preview = previewOf(setChange, 0, 320);
    expect(preview.segments.map((segment) => segment.kind)).toEqual([
      'conflict',
      'conflict',
      'gap'
    ]);
    // 同 recordIn 时分析器按 recordOut 排序：B(150) 排在 A(300) 前，成员顺序沿用之。
    expect(preview.segments[0].contributions.map((item) => item.clipId)).toEqual(['B', 'A']);
    expect(preview.segments[1].contributions.map((item) => item.clipId)).toEqual(['A', 'C']);

    // 相邻唯一来源：身份不同，各自成段。
    const handoff = previewOf(batteries[3], 0, 320);
    expect(handoff.segments.map((segment) => segment.kind)).toEqual(['unique', 'unique', 'gap']);
    expect(handoff.segments[0].contributions[0].clipId).toBe('A');
    expect(handoff.segments[1].contributions[0].clipId).toBe('B');
  });

  it('matches the oracle on the 59.94 rate as well', () => {
    const rate: DropFrameRate = '60000/1001';
    const specs: ClipSpec[] = [
      { id: 'X', sourceIn: 100, sourceOut: 220, recordIn: 40 },
      { id: 'Y', sourceIn: 500, sourceOut: 650, recordIn: 130 }
    ];
    const preview = previewOf(specs, 20, 300, rate);
    expectPreviewMatchesOracle(preview, specs, 20, 300, rate);
    expect(preview.rate).toBe(rate);
    expect(preview.dayFrames).toBe(5_178_816);
  });

  it('treats adjacent half-open record endpoints as a handoff, not a conflict', () => {
    const specs: ClipSpec[] = [
      { id: 'A', sourceIn: 0, sourceOut: 150, recordIn: 100 },
      { id: 'B', sourceIn: 400, sourceOut: 550, recordIn: 250 }
    ];
    const preview = previewOf(specs, 100, 400);
    expectPreviewMatchesOracle(preview, specs, 100, 400);
    expect(preview.segments.map((segment) => segment.kind)).toEqual(['unique', 'unique']);
    expect(preview.conflictSegmentCount).toBe(0);
  });

  it('keeps numeric and look-alike string ids as distinct contributors', () => {
    const specs: ClipSpec[] = [
      { id: 1, sourceIn: 0, sourceOut: 120, recordIn: 10 },
      { id: '1', sourceIn: 200, sourceOut: 320, recordIn: 40 }
    ];
    const preview = previewOf(specs, 10, 160);
    expectPreviewMatchesOracle(preview, specs, 10, 160);
    const conflict = preview.segments.find((segment) => segment.kind === 'conflict')!;
    expect(conflict.contributions.map((item) => item.clipId)).toEqual([1, '1']);
    // JSON 往返后身份类型不变。
    const roundTripped = JSON.parse(JSON.stringify(preview)) as ProvenancePreview;
    const rtConflict = roundTripped.segments.find((segment) => segment.kind === 'conflict')!;
    expect(typeof rtConflict.contributions[0].clipId).toBe('number');
    expect(typeof rtConflict.contributions[1].clipId).toBe('string');
  });

  it('handles a selection ending at the last frame of the day without wrapping', () => {
    const lastFrame = DAY_FRAMES - 1;
    const specs: ClipSpec[] = [
      { id: 'tail', sourceIn: 0, sourceOut: 90, recordIn: lastFrame - 90 }
    ];
    const preview = previewOf(specs, lastFrame - 90, lastFrame);
    expectPreviewMatchesOracle(preview, specs, lastFrame - 90, lastFrame);
    expect(preview.selection.recordEnd.frame).toBe(lastFrame);
    expect(preview.selection.recordEnd.timecode).toBe('23:59:59;29');
    const [segment] = preview.segments;
    expect(segment.kind).toBe('unique');
    expect(segment.contributions[0].sourceEnd.frame).toBe(90);
  });

  it('rejects malformed, dropped-frame and non-positive selections', () => {
    const { result } = analyze([{ id: 'A', sourceIn: 0, sourceOut: 300, recordIn: 100 }]);

    const badFormat = buildProvenancePreview(result, '10:00:00', '00:00:20;00');
    expect(badFormat.ok).toBe(false);
    if (!badFormat.ok) {
      expect(badFormat.issues[0].code).toBe('TIMECODE_FORMAT');
      expect(badFormat.issues[0].path).toBe('selectionIn');
    }

    // 00:01:00;01 是非整十分钟边界的禁用帧号。
    const dropped = buildProvenancePreview(result, '00:01:00;01', '00:00:20;00');
    expect(dropped.ok).toBe(false);
    if (!dropped.ok) {
      expect(dropped.issues[0].code).toBe('TIMECODE_DROPPED_FRAME');
    }

    const inverted = buildProvenancePreview(result, '00:00:20;00', '00:00:10;00');
    expect(inverted.ok).toBe(false);
    if (!inverted.ok) {
      expect(inverted.issues[0].code).toBe('SELECTION_RANGE_NON_POSITIVE');
      expect(inverted.issues[0].path).toBe('selectionOut');
    }

    const zeroLength = buildProvenancePreview(result, '00:00:10;00', '00:00:10;00');
    expect(zeroLength.ok).toBe(false);
  });
});

describe('provenance manifest export', () => {
  const specs: ClipSpec[] = [
    { id: '甲', sourceIn: 1_000, sourceOut: 1_100, recordIn: 100 },
    { id: '乙', sourceIn: 2_000, sourceOut: 2_110, recordIn: 150 }
  ];

  it('blocks export while gaps or unresolved conflicts remain', () => {
    // 选区 [80, 280)：空隙 [80,100)、唯一甲、冲突、唯一乙、空隙 [260,280)。
    const preview = previewOf(specs, 80, 280);

    const noRulings = buildProvenanceManifest(preview, new Map());
    expect(noRulings.ok).toBe(false);
    if (!noRulings.ok) {
      expect(noRulings.blockers.map((blocker) => blocker.kind)).toEqual([
        'gap',
        'unresolved-conflict',
        'gap'
      ]);
      expect(noRulings.blockers.map((blocker) => blocker.segmentIndex)).toEqual([0, 2, 4]);
      expect(noRulings.blockers[0].recordStart.frame).toBe(80);
      expect(noRulings.blockers[0].recordEnd.frame).toBe(100);
    }

    // 裁决冲突后仍有两段空隙，导出继续被禁。
    const ruled = buildProvenanceManifest(preview, new Map([[2, '甲']]));
    expect(ruled.ok).toBe(false);
    if (!ruled.ok) {
      expect(ruled.blockers.map((blocker) => blocker.kind)).toEqual(['gap', 'gap']);
    }
  });

  it('rejects rulings that do not name an existing contributor of the segment', () => {
    const preview = previewOf(specs, 100, 260);
    const conflictIndex = preview.segments.findIndex((segment) => segment.kind === 'conflict');

    // 丙不是该段贡献片段；数值 1 也不能裁决字符串 id '1' 之外的段。
    const alien = buildProvenanceManifest(preview, new Map([[conflictIndex, '丙']]));
    expect(alien.ok).toBe(false);
    if (!alien.ok) {
      expect(alien.blockers).toHaveLength(1);
      expect(alien.blockers[0].kind).toBe('unresolved-conflict');
    }

    // 类型不同的同字面 id 同样无效。
    const typedSpecs: ClipSpec[] = [
      { id: 1, sourceIn: 0, sourceOut: 120, recordIn: 10 },
      { id: '1', sourceIn: 200, sourceOut: 320, recordIn: 40 }
    ];
    const typedPreview = previewOf(typedSpecs, 10, 160);
    const typedConflict = typedPreview.segments.findIndex((segment) => segment.kind === 'conflict');
    const wrongType = buildProvenanceManifest(typedPreview, new Map<number, ClipId>([[typedConflict, 2]]));
    expect(wrongType.ok).toBe(false);
    const rightType = buildProvenanceManifest(typedPreview, new Map<number, ClipId>([[typedConflict, '1']]));
    expect(rightType.ok).toBe(true);
  });

  it('exports entries in record order and merges only identical, doubly contiguous runs', () => {
    // 选区 [100, 260)：唯一甲 [100,150)、冲突 [150,200)、唯一乙 [200,260)。
    const preview = previewOf(specs, 100, 260);
    const conflictIndex = 1;

    // 裁决给甲：前两段同为甲且原片、录制坐标均连续，必须合并；乙段身份不同，保持独立。
    const toJia = buildProvenanceManifest(preview, new Map([[conflictIndex, '甲']]));
    expect(toJia.ok).toBe(true);
    if (!toJia.ok) throw new Error('expected manifest');
    expect(toJia.manifest.entryCount).toBe(2);
    expect(toJia.manifest.entries.map((entry) => entry.clipId)).toEqual(['甲', '乙']);
    expect(toJia.manifest.entries[0]).toMatchObject({
      recordStart: { frame: 100 },
      recordEnd: { frame: 200 },
      sourceStart: { frame: 1_000 },
      sourceEnd: { frame: 1_100 },
      durationFrames: 100
    });
    expect(toJia.manifest.entries[1]).toMatchObject({
      recordStart: { frame: 200 },
      recordEnd: { frame: 260 },
      sourceStart: { frame: 2_050 },
      sourceEnd: { frame: 2_110 },
      durationFrames: 60
    });

    // 裁决给乙：冲突段与唯一段的乙身份相同，且原片（2050 相接）、录制（200 相接）
    // 坐标均连续，两段乙必须合并成一条；前面的甲身份不同，保持独立。
    const toYi = buildProvenanceManifest(preview, new Map([[conflictIndex, '乙']]));
    expect(toYi.ok).toBe(true);
    if (!toYi.ok) throw new Error('expected manifest');
    expect(toYi.manifest.entryCount).toBe(2);
    expect(toYi.manifest.entries.map((entry) => entry.clipId)).toEqual(['甲', '乙']);
    expect(toYi.manifest.entries[1]).toMatchObject({
      recordStart: { frame: 150 },
      recordEnd: { frame: 260 },
      sourceStart: { frame: 2_000 },
      sourceEnd: { frame: 2_110 },
      durationFrames: 110
    });

    // 清单按录制顺序铺满整个选区。
    const entries = toYi.manifest.entries;
    expect(entries[0].recordStart.frame).toBe(100);
    expect(entries[entries.length - 1].recordEnd.frame).toBe(260);
    for (let index = 1; index < entries.length; index++) {
      expect(entries[index].recordStart.frame).toBe(entries[index - 1].recordEnd.frame);
    }
  });

  it('never merges across different clip identities even when source frames line up', () => {
    // 两片来源区间首尾相接，录制也相接：身份不同，导出仍是两条。
    const chained: ClipSpec[] = [
      { id: 'A', sourceIn: 0, sourceOut: 100, recordIn: 500 },
      { id: 'B', sourceIn: 100, sourceOut: 200, recordIn: 600 }
    ];
    const preview = previewOf(chained, 500, 700);
    const manifest = buildProvenanceManifest(preview, new Map());
    expect(manifest.ok).toBe(true);
    if (!manifest.ok) throw new Error('expected manifest');
    expect(manifest.manifest.entryCount).toBe(2);
    expect(manifest.manifest.entries.map((entry) => entry.clipId)).toEqual(['A', 'B']);
  });

  it('maps every selected record frame back to the ruled source frame', () => {
    // 三重覆盖，逐帧核对清单给出的原片帧与所选片段的平移公式一致。
    const triple: ClipSpec[] = [
      { id: 'A', sourceIn: 1_000, sourceOut: 1_300, recordIn: 0 },
      { id: 'B', sourceIn: 2_000, sourceOut: 2_180, recordIn: 60 },
      { id: 'C', sourceIn: 3_000, sourceOut: 3_060, recordIn: 90 }
    ];
    const preview = previewOf(triple, 0, 300);
    const rulings = new Map<number, ClipId>();
    for (const segment of preview.segments) {
      if (segment.kind === 'conflict') {
        rulings.set(segment.index, segment.contributions[1].clipId);
      }
    }
    const response = buildProvenanceManifest(preview, rulings);
    expect(response.ok).toBe(true);
    if (!response.ok) throw new Error('expected manifest');

    for (let frame = 0; frame < 300; frame++) {
      const entry = response.manifest.entries.find(
        (item) => item.recordStart.frame <= frame && frame < item.recordEnd.frame
      )!;
      expect(entry).toBeDefined();
      const spec = triple.find((item) => item.id === entry.clipId)!;
      expect(entry.sourceStart.frame + (frame - entry.recordStart.frame)).toBe(
        spec.sourceIn + (frame - spec.recordIn)
      );
    }

    // 合并后的条目不可再合并：相邻条目至少违反一项合并条件。
    const entries = response.manifest.entries;
    for (let index = 1; index < entries.length; index++) {
      const previous = entries[index - 1];
      const current = entries[index];
      const mergeable =
        previous.clipId === current.clipId &&
        previous.sourceEnd.frame === current.sourceStart.frame &&
        previous.recordEnd.frame === current.recordStart.frame;
      expect(mergeable).toBe(false);
    }
  });

  it('shares blocker computation between the panel and the export gate', () => {
    const preview = previewOf(specs, 80, 280);
    const rulings = new Map<number, ClipId>([[2, '甲']]);
    const blockers = collectProvenanceBlockers(preview, rulings);
    expect(blockers.map((blocker) => blocker.kind)).toEqual(['gap', 'gap']);
    const response = buildProvenanceManifest(preview, rulings);
    expect(response.ok).toBe(false);
    if (!response.ok) {
      // 导出闸门与面板展示用的是同一份阻塞项。
      expect(response.blockers).toEqual(blockers);
    }
  });
});

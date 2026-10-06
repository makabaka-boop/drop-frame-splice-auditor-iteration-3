import type {
  AnalysisResult,
  AnalyzedClip,
  ClipId,
  FrameTimecode,
  ValidationIssue
} from './analysis';
import { InvalidTimecodeError, parseTimecode, toFrameTimecode, type DropFrameRate } from './timecode';

/**
 * 来源交付预演：把剪辑师选定的半开录制区间 [selectionIn, selectionOut)
 * 在整数帧坐标上切成“贡献片段集合恒定”的最大区间，逐段标记
 * 空隙 / 唯一来源 / 多来源冲突，并把每个贡献片段精确平移回原片起止帧。
 *
 * 分段结果只计算一次：时间线着色、冲突裁决状态与取材清单导出共用同一份
 * ProvenancePreview。裁决（rulings）以段索引为键，只能引用该段现有贡献片段；
 * 会话层负责把 preview 与 rulings 绑定到产生它们的分析快照。
 */

export interface ProvenanceSelection {
  recordStart: FrameTimecode;
  recordEnd: FrameTimecode;
  durationFrames: number;
}

export interface ProvenanceContribution {
  clipId: ClipId;
  sourceStart: FrameTimecode;
  sourceEnd: FrameTimecode;
}

export type ProvenanceSegmentKind = 'gap' | 'unique' | 'conflict';

export interface ProvenanceSegment {
  index: number;
  kind: ProvenanceSegmentKind;
  recordStart: FrameTimecode;
  recordEnd: FrameTimecode;
  durationFrames: number;
  /** 该段录制区间内的全部贡献片段，按录制时间线顺序；空隙段为空。 */
  contributions: ProvenanceContribution[];
}

export interface ProvenancePreview {
  schemaVersion: 1;
  rate: DropFrameRate;
  dayFrames: number;
  selection: ProvenanceSelection;
  segmentCount: number;
  gapSegmentCount: number;
  conflictSegmentCount: number;
  gapFrameTotal: number;
  conflictFrameTotal: number;
  segments: ProvenanceSegment[];
}

export type ProvenancePreviewResponse =
  | { ok: true; preview: ProvenancePreview }
  | { ok: false; issues: ValidationIssue[] };

export interface ProvenanceBlocker {
  kind: 'gap' | 'unresolved-conflict';
  segmentIndex: number;
  recordStart: FrameTimecode;
  recordEnd: FrameTimecode;
  durationFrames: number;
}

export interface ProvenanceManifestEntry {
  clipId: ClipId;
  recordStart: FrameTimecode;
  recordEnd: FrameTimecode;
  sourceStart: FrameTimecode;
  sourceEnd: FrameTimecode;
  durationFrames: number;
}

export interface ProvenanceManifest {
  schemaVersion: 1;
  rate: DropFrameRate;
  dayFrames: number;
  selection: ProvenanceSelection;
  entryCount: number;
  entries: ProvenanceManifestEntry[];
}

export type ProvenanceManifestResponse =
  | { ok: true; manifest: ProvenanceManifest }
  | { ok: false; blockers: ProvenanceBlocker[] };

interface RawSegment {
  start: number;
  end: number;
  members: AnalyzedClip[];
}

function parseSelectionBoundary(
  value: unknown,
  rate: DropFrameRate,
  path: string,
  issues: ValidationIssue[]
): number | null {
  try {
    return parseTimecode(value, rate).totalFrames;
  } catch (error) {
    if (error instanceof InvalidTimecodeError) {
      issues.push({ code: error.code, message: error.message, path });
      return null;
    }
    throw error;
  }
}

export function buildProvenancePreview(
  result: AnalysisResult,
  selectionIn: unknown,
  selectionOut: unknown
): ProvenancePreviewResponse {
  const issues: ValidationIssue[] = [];
  const startFrame = parseSelectionBoundary(selectionIn, result.rate, 'selectionIn', issues);
  const endFrame = parseSelectionBoundary(selectionOut, result.rate, 'selectionOut', issues);
  if (issues.length > 0) {
    return { ok: false, issues };
  }

  const selStart = startFrame!;
  const selEnd = endFrame!;
  if (selEnd <= selStart) {
    return {
      ok: false,
      issues: [
        {
          code: 'SELECTION_RANGE_NON_POSITIVE',
          message: '选区为半开区间，结束时码必须严格晚于开始时码',
          path: 'selectionOut'
        }
      ]
    };
  }

  const { rate } = result;

  // 端点事件按帧位置归桶：同一帧上先离场后入场，半开区间天然互不接合。
  // 与选区不相交的片段不产生事件；相交片段的端点夹到选区边界内。
  const eventsByFrame = new Map<number, { starts: AnalyzedClip[]; ends: AnalyzedClip[] }>();
  for (const clip of result.clips) {
    if (clip.recordOut.frame <= selStart || clip.recordIn.frame >= selEnd) continue;
    const start = Math.max(clip.recordIn.frame, selStart);
    const end = Math.min(clip.recordOut.frame, selEnd);
    for (const [frame, kind] of [
      [start, 'starts'],
      [end, 'ends']
    ] as const) {
      let bucket = eventsByFrame.get(frame);
      if (!bucket) {
        bucket = { starts: [], ends: [] };
        eventsByFrame.set(frame, bucket);
      }
      bucket[kind].push(clip);
    }
  }

  const eventFrames = [...eventsByFrame.keys()].sort((a, b) => a - b);
  const active = new Map<ClipId, AnalyzedClip>();
  const raws: RawSegment[] = [];

  const emit = (start: number, end: number) => {
    // 成员顺序沿用录制时间线顺序（result.clips 已按录制位置排序），保证输出确定。
    const members = result.clips.filter((clip) => active.has(clip.id));
    raws.push({ start, end, members });
  };

  // 每个事件帧都严格改变活动集合（同帧的离场与入场属于不同片段），
  // 因此相邻段集合必然不同，切出的就是贡献集合恒定的最大区间。
  let previousFrame = selStart;
  for (const frame of eventFrames) {
    if (frame > previousFrame) {
      emit(previousFrame, frame);
    }
    const bucket = eventsByFrame.get(frame)!;
    for (const clip of bucket.ends) active.delete(clip.id);
    for (const clip of bucket.starts) active.set(clip.id, clip);
    previousFrame = frame;
  }
  if (previousFrame < selEnd) {
    emit(previousFrame, selEnd);
  }

  const segments: ProvenanceSegment[] = raws.map((raw, index) => ({
    index,
    kind: raw.members.length === 0 ? 'gap' : raw.members.length === 1 ? 'unique' : 'conflict',
    recordStart: toFrameTimecode(raw.start, rate),
    recordEnd: toFrameTimecode(raw.end, rate),
    durationFrames: raw.end - raw.start,
    // 精确平移回原片：source = clip.sourceIn + (record − clip.recordIn)，整数帧裁决。
    // 段范围 ⊆ 片段录制范围，故 sourceEnd ≤ sourceOut < dayFrames，不触碰日末回绕点。
    contributions: raw.members.map((clip) => ({
      clipId: clip.id,
      sourceStart: toFrameTimecode(clip.sourceIn.frame + (raw.start - clip.recordIn.frame), rate),
      sourceEnd: toFrameTimecode(clip.sourceIn.frame + (raw.end - clip.recordIn.frame), rate)
    }))
  }));

  const gapSegments = segments.filter((segment) => segment.kind === 'gap');
  const conflictSegments = segments.filter((segment) => segment.kind === 'conflict');

  return {
    ok: true,
    preview: {
      schemaVersion: 1,
      rate,
      dayFrames: result.dayFrames,
      selection: {
        recordStart: toFrameTimecode(selStart, rate),
        recordEnd: toFrameTimecode(selEnd, rate),
        durationFrames: selEnd - selStart
      },
      segmentCount: segments.length,
      gapSegmentCount: gapSegments.length,
      conflictSegmentCount: conflictSegments.length,
      gapFrameTotal: gapSegments.reduce((sum, segment) => sum + segment.durationFrames, 0),
      conflictFrameTotal: conflictSegments.reduce(
        (sum, segment) => sum + segment.durationFrames,
        0
      ),
      segments
    }
  };
}

/**
 * 汇总导出阻塞项：空隙段永远阻塞（来源不明，禁止猜测）；
 * 冲突段只有在裁决引用了该段现有贡献片段时才视为已裁决。
 * 片段身份走 SameValueZero：数值 1 与字符串 "1" 不能互相裁决。
 */
export function collectProvenanceBlockers(
  preview: ProvenancePreview,
  rulings: ReadonlyMap<number, ClipId>
): ProvenanceBlocker[] {
  const blockers: ProvenanceBlocker[] = [];
  for (const segment of preview.segments) {
    if (segment.kind === 'unique') continue;
    const resolved =
      segment.kind === 'conflict' &&
      rulings.has(segment.index) &&
      segment.contributions.some(
        (contribution) => contribution.clipId === rulings.get(segment.index)
      );
    if (!resolved) {
      blockers.push({
        kind: segment.kind === 'gap' ? 'gap' : 'unresolved-conflict',
        segmentIndex: segment.index,
        recordStart: segment.recordStart,
        recordEnd: segment.recordEnd,
        durationFrames: segment.durationFrames
      });
    }
  }
  return blockers;
}

/**
 * 全部裁决完成后导出按录制顺序排列的来源清单。
 * 仅在片段身份相同且原片、录制坐标均连续时才合并相邻条目。
 */
export function buildProvenanceManifest(
  preview: ProvenancePreview,
  rulings: ReadonlyMap<number, ClipId>
): ProvenanceManifestResponse {
  const blockers = collectProvenanceBlockers(preview, rulings);
  if (blockers.length > 0) {
    return { ok: false, blockers };
  }

  const entries: ProvenanceManifestEntry[] = [];
  for (const segment of preview.segments) {
    // 走到这里每段必为唯一来源或已裁决冲突，裁决值一定是该段现有贡献片段。
    const chosenId =
      segment.kind === 'unique' ? segment.contributions[0].clipId : rulings.get(segment.index)!;
    const contribution = segment.contributions.find((item) => item.clipId === chosenId)!;
    const entry: ProvenanceManifestEntry = {
      clipId: chosenId,
      recordStart: segment.recordStart,
      recordEnd: segment.recordEnd,
      sourceStart: contribution.sourceStart,
      sourceEnd: contribution.sourceEnd,
      durationFrames: segment.durationFrames
    };
    const last = entries[entries.length - 1];
    if (
      last &&
      last.clipId === entry.clipId &&
      last.sourceEnd.frame === entry.sourceStart.frame &&
      last.recordEnd.frame === entry.recordStart.frame
    ) {
      // 只重指条目字段，不改写共享的 FrameTimecode 对象。
      last.recordEnd = entry.recordEnd;
      last.sourceEnd = entry.sourceEnd;
      last.durationFrames += entry.durationFrames;
      continue;
    }
    entries.push(entry);
  }

  return {
    ok: true,
    manifest: {
      schemaVersion: 1,
      rate: preview.rate,
      dayFrames: preview.dayFrames,
      selection: preview.selection,
      entryCount: entries.length,
      entries
    }
  };
}

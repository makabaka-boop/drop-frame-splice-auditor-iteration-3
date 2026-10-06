import type { AnalysisResult, AnalyzedClip, ClipId, FrameTimecode } from './analysis';
import { toFrameTimecode, type DropFrameRate } from './timecode';

/**
 * 来源复用审计：把各片段的 [sourceIn, sourceOut) 投到同一来源轴，
 * 端点扫描出被至少两片覆盖的最大半开区间。
 * 全部裁决都用整数帧，时码仅在输出时由整数帧反算，用于显示。
 */

export interface SourceReusePlacement {
  clipId: ClipId;
  recordStart: FrameTimecode;
  recordEnd: FrameTimecode;
}

export interface SourceReuseSegment {
  index: number;
  sourceStart: FrameTimecode;
  sourceEnd: FrameTimecode;
  durationFrames: number;
  coverCount: number;
  clipIds: ClipId[];
  placements: SourceReusePlacement[];
}

export interface SourceReuseReport {
  schemaVersion: 1;
  rate: DropFrameRate;
  dayFrames: number;
  clipCount: number;
  segmentCount: number;
  reusedFrameTotal: number;
  segments: SourceReuseSegment[];
}

interface RawSegment {
  start: number;
  end: number;
  members: AnalyzedClip[];
}

/**
 * 片段身份比较走 SameValueZero：数值 1 与字符串 "1" 是不同 id，
 * 与输入校验、接缝分析保持同一套身份语义。
 */
function sameMemberSet(a: AnalyzedClip[], b: AnalyzedClip[]): boolean {
  if (a.length !== b.length) return false;
  const ids = new Set<ClipId>(a.map((clip) => clip.id));
  return b.every((clip) => ids.has(clip.id));
}

export function auditSourceReuse(result: AnalysisResult): SourceReuseReport {
  const { rate, dayFrames } = result;

  // 端点事件按帧位置归桶：同一帧上先离场后入场，半开区间 [in, out) 天然互不接合。
  const eventsByFrame = new Map<number, { starts: AnalyzedClip[]; ends: AnalyzedClip[] }>();
  for (const clip of result.clips) {
    for (const [frame, kind] of [
      [clip.sourceIn.frame, 'starts'],
      [clip.sourceOut.frame, 'ends']
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
  let previousFrame: number | null = null;

  const emit = (start: number, end: number) => {
    // 成员顺序沿用录制时间线顺序（result.clips 已按录制位置排序），保证输出确定。
    const members = result.clips.filter((clip) => active.has(clip.id));
    const last = raws[raws.length - 1];
    // 只有活动片段 ID 集合完全一致才允许接合；集合一变就必须断开，
    // 即使复用计数相同也不能合并。
    if (last && last.end === start && sameMemberSet(last.members, members)) {
      last.end = end;
      return;
    }
    raws.push({ start, end, members });
  };

  for (const frame of eventFrames) {
    if (previousFrame !== null && frame > previousFrame && active.size >= 2) {
      emit(previousFrame, frame);
    }
    const bucket = eventsByFrame.get(frame)!;
    for (const clip of bucket.ends) active.delete(clip.id);
    for (const clip of bucket.starts) active.set(clip.id, clip);
    previousFrame = frame;
  }

  const segments: SourceReuseSegment[] = raws.map((raw, index) => ({
    index,
    sourceStart: toFrameTimecode(raw.start, rate),
    sourceEnd: toFrameTimecode(raw.end, rate),
    durationFrames: raw.end - raw.start,
    coverCount: raw.members.length,
    clipIds: raw.members.map((clip) => clip.id),
    // 每个覆盖片段按自己的 recordIn 平移出对应录制区间，整数帧裁决。
    // 段范围 ⊆ 片段来源范围，故 recordEnd ≤ recordOut < dayFrames，不会触碰日末回绕点。
    placements: raw.members.map((clip) => ({
      clipId: clip.id,
      recordStart: toFrameTimecode(clip.recordIn.frame + (raw.start - clip.sourceIn.frame), rate),
      recordEnd: toFrameTimecode(clip.recordIn.frame + (raw.end - clip.sourceIn.frame), rate)
    }))
  }));

  return {
    schemaVersion: 1,
    rate,
    dayFrames,
    clipCount: result.clips.length,
    segmentCount: segments.length,
    reusedFrameTotal: segments.reduce((sum, segment) => sum + segment.durationFrames, 0),
    segments
  };
}

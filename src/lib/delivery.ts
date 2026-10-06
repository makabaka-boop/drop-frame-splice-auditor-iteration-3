import type { AnalysisResult, AnalyzedClip, ClipId, FrameTimecode } from './analysis';
import { InvalidTimecodeError, parseTimecode, toFrameTimecode, type DropFrameRate } from './timecode';

/**
 * 来源交付预演：在录制轴的半开选区 [recordStart, recordEnd) 上做端点扫描。
 * 每个整数帧都归属于“空隙 / 唯一来源 / 多来源冲突”之一；活动贡献片段集合
 * 不变的连续帧合并成最大区间，集合在任一边界变化都立即断开。
 */

export interface DeliverySelection {
  startFrame: number;
  endFrame: number;
}

export interface DeliveryContribution {
  clipId: ClipId;
  /** 该段在所选片段原片轴上的精确半开映射。 */
  sourceStart: FrameTimecode;
  sourceEnd: FrameTimecode;
  recordStart: FrameTimecode;
  recordEnd: FrameTimecode;
  durationFrames: number;
}

export type DeliverySegmentKind = 'gap' | 'unique' | 'conflict';

export interface DeliverySegment {
  index: number;
  kind: DeliverySegmentKind;
  recordStart: FrameTimecode;
  recordEnd: FrameTimecode;
  durationFrames: number;
  /** 按录制时间线顺序排列；空隙段为空，冲突段至少有两个现有贡献片段。 */
  contributions: DeliveryContribution[];
}

export interface SourceDeliveryPreview {
  schemaVersion: 1;
  rate: DropFrameRate;
  dayFrames: number;
  selectionStart: FrameTimecode;
  selectionEnd: FrameTimecode;
  durationFrames: number;
  segments: DeliverySegment[];
  gapFrameTotal: number;
  conflictSegmentCount: number;
}

export interface SourceDeliveryItem {
  clipId: ClipId;
  sourceIn: FrameTimecode;
  sourceOut: FrameTimecode;
  recordIn: FrameTimecode;
  recordOut: FrameTimecode;
  durationFrames: number;
  firstSegmentIndex: number;
  lastSegmentIndex: number;
}

export interface SourceDeliveryExport {
  schemaVersion: 1;
  rate: DropFrameRate;
  dayFrames: number;
  selectionStart: FrameTimecode;
  selectionEnd: FrameTimecode;
  durationFrames: number;
  itemCount: number;
  deliveredFrameTotal: number;
  items: SourceDeliveryItem[];
}

export interface DeliveryIssue {
  code:
    | 'DELIVERY_SELECTION_TIMECODE'
    | 'DELIVERY_SELECTION_REVERSED'
    | 'DELIVERY_GAP'
    | 'DELIVERY_CONFLICT_UNRESOLVED'
    | 'DELIVERY_DECISION_NOT_A_CONTRIBUTOR';
  message: string;
  segmentIndex?: number;
  path?: string;
}

export type DeliveryDecisions = Readonly<Record<number, ClipId>>;

export type DeliverySelectionResponse =
  | { ok: true; selection: DeliverySelection }
  | { ok: false; issues: DeliveryIssue[] };

export type SourceDeliveryResolution =
  | { ok: true; items: SourceDeliveryItem[]; deliveredFrameTotal: number }
  | { ok: false; issues: DeliveryIssue[] };

interface EventBucket {
  starts: AnalyzedClip[];
  ends: AnalyzedClip[];
}

function deliveryIssue(
  code: DeliveryIssue['code'],
  message: string,
  segmentIndex?: number,
  path?: string
): DeliveryIssue {
  return { code, message, segmentIndex, path };
}

export function parseSourceDeliverySelection(
  rate: DropFrameRate,
  startText: string,
  endText: string
): DeliverySelectionResponse {
  const issues: DeliveryIssue[] = [];
  let startFrame: number | null = null;
  let endFrame: number | null = null;

  try {
    startFrame = parseTimecode(startText, rate).totalFrames;
  } catch (error) {
    if (error instanceof InvalidTimecodeError) {
      issues.push(deliveryIssue('DELIVERY_SELECTION_TIMECODE', error.message, undefined, 'selectionStart'));
    } else {
      throw error;
    }
  }

  try {
    endFrame = parseTimecode(endText, rate).totalFrames;
  } catch (error) {
    if (error instanceof InvalidTimecodeError) {
      issues.push(deliveryIssue('DELIVERY_SELECTION_TIMECODE', error.message, undefined, 'selectionEnd'));
    } else {
      throw error;
    }
  }

  if (startFrame !== null && endFrame !== null && endFrame <= startFrame) {
    issues.push(
      deliveryIssue(
        'DELIVERY_SELECTION_REVERSED',
        '录制选区为半开区间，结束帧必须严格晚于开始帧',
        undefined,
        'selectionEnd'
      )
    );
  }

  if (issues.length > 0 || startFrame === null || endFrame === null) {
    return { ok: false, issues };
  }

  return { ok: true, selection: { startFrame, endFrame } };
}

function makeContribution(
  clip: AnalyzedClip,
  recordStartFrame: number,
  recordEndFrame: number,
  rate: DropFrameRate
): DeliveryContribution {
  // 录制轴与原片轴都是同一片段的一一整数帧映射；按各自偏移完整平移，不用时码浮点运算。
  const sourceStartFrame = clip.sourceIn.frame + (recordStartFrame - clip.recordIn.frame);
  const sourceEndFrame = clip.sourceIn.frame + (recordEndFrame - clip.recordIn.frame);
  return {
    clipId: clip.id,
    sourceStart: toFrameTimecode(sourceStartFrame, rate),
    sourceEnd: toFrameTimecode(sourceEndFrame, rate),
    recordStart: toFrameTimecode(recordStartFrame, rate),
    recordEnd: toFrameTimecode(recordEndFrame, rate),
    durationFrames: recordEndFrame - recordStartFrame
  };
}

export function createSourceDeliveryPreview(
  result: AnalysisResult,
  selection: DeliverySelection
): SourceDeliveryPreview {
  const { rate, dayFrames } = result;
  const { startFrame, endFrame } = selection;

  if (
    !Number.isSafeInteger(startFrame)
    || !Number.isSafeInteger(endFrame)
    || startFrame < 0
    || endFrame > dayFrames
    || endFrame <= startFrame
  ) {
    throw new RangeError('来源交付选区必须是位于录制日内的非空半开整数帧区间');
  }

  const eventsByFrame = new Map<number, EventBucket>();
  const pointSet = new Set<number>([startFrame, endFrame]);

  for (const clip of result.clips) {
    // 只取与半开选区相交的部分；贴住选区起点结束的片段不会进入起点之后的帧。
    const clippedStart = Math.max(clip.recordIn.frame, startFrame);
    const clippedEnd = Math.min(clip.recordOut.frame, endFrame);
    if (clippedStart >= clippedEnd) continue;

    for (const [frame, kind] of [
      [clippedStart, 'starts'],
      [clippedEnd, 'ends']
    ] as const) {
      let bucket = eventsByFrame.get(frame);
      if (!bucket) {
        bucket = { starts: [], ends: [] };
        eventsByFrame.set(frame, bucket);
      }
      bucket[kind].push(clip);
      pointSet.add(frame);
    }
  }

  const points = [...pointSet].sort((a, b) => a - b);
  const active = new Map<ClipId, AnalyzedClip>();
  const segments: DeliverySegment[] = [];
  let gapFrameTotal = 0;
  let conflictSegmentCount = 0;

  for (let pointIndex = 0; pointIndex < points.length - 1; pointIndex++) {
    const frame = points[pointIndex];
    const nextFrame = points[pointIndex + 1];
    const bucket = eventsByFrame.get(frame);

    // 同一帧先离场后入场：[in, out) 的结束帧不贡献该帧，相邻端点不会错误接合。
    bucket?.ends.forEach((clip) => active.delete(clip.id));
    bucket?.starts.forEach((clip) => active.set(clip.id, clip));

    if (nextFrame === frame) continue;

    const members = result.clips.filter((clip) => active.has(clip.id));
    const kind: DeliverySegmentKind =
      members.length === 0 ? 'gap' : members.length === 1 ? 'unique' : 'conflict';

    if (kind === 'gap') gapFrameTotal += nextFrame - frame;
    if (kind === 'conflict') conflictSegmentCount += 1;

    segments.push({
      index: segments.length,
      kind,
      recordStart: toFrameTimecode(frame, rate),
      recordEnd: toFrameTimecode(nextFrame, rate),
      durationFrames: nextFrame - frame,
      contributions: members.map((clip) => makeContribution(clip, frame, nextFrame, rate))
    });
  }

  return {
    schemaVersion: 1,
    rate,
    dayFrames,
    selectionStart: toFrameTimecode(startFrame, rate),
    selectionEnd: toFrameTimecode(endFrame, rate),
    durationFrames: endFrame - startFrame,
    segments,
    gapFrameTotal,
    conflictSegmentCount
  };
}

function findContribution(segment: DeliverySegment, clipId: ClipId): DeliveryContribution | null {
  return segment.contributions.find((contribution) => contribution.clipId === clipId) ?? null;
}

/**
 * 裁决后的取材项只在相邻段同时满足以下条件时合并：
 * 1. 选中的是同一个片段身份（数值 1 与字符串 "1" 不相等）；
 * 2. 原片坐标首尾相接；
 * 3. 录制坐标也首尾相接。
 * 空隙或不同片段一定断开。
 */
function appendResolvedRun(runs: SourceDeliveryItem[], contribution: DeliveryContribution, segmentIndex: number) {
  const previous = runs[runs.length - 1];
  if (
    previous
    && previous.clipId === contribution.clipId
    && previous.sourceOut.frame === contribution.sourceStart.frame
    && previous.recordOut.frame === contribution.recordStart.frame
  ) {
    previous.sourceOut = contribution.sourceEnd;
    previous.recordOut = contribution.recordEnd;
    previous.durationFrames = previous.recordOut.frame - previous.recordIn.frame;
    previous.lastSegmentIndex = segmentIndex;
    return;
  }

  runs.push({
    clipId: contribution.clipId,
    sourceIn: contribution.sourceStart,
    sourceOut: contribution.sourceEnd,
    recordIn: contribution.recordStart,
    recordOut: contribution.recordEnd,
    durationFrames: contribution.durationFrames,
    firstSegmentIndex: segmentIndex,
    lastSegmentIndex: segmentIndex
  });
}

export function resolveSourceDelivery(
  preview: SourceDeliveryPreview,
  decisions: DeliveryDecisions
): SourceDeliveryResolution {
  const issues: DeliveryIssue[] = [];
  const runs: SourceDeliveryItem[] = [];

  for (const segment of preview.segments) {
    if (segment.kind === 'gap') {
      issues.push(
        deliveryIssue(
          'DELIVERY_GAP',
          `第 ${segment.index + 1} 段存在 ${segment.durationFrames} 帧空隙，禁止猜来源`,
          segment.index
        )
      );
      continue;
    }

    if (segment.kind === 'unique') {
      appendResolvedRun(runs, segment.contributions[0], segment.index);
      continue;
    }

    const decision = decisions[segment.index];
    if (decision === undefined) {
      issues.push(
        deliveryIssue(
          'DELIVERY_CONFLICT_UNRESOLVED',
          `第 ${segment.index + 1} 段有 ${segment.contributions.length} 个来源冲突，必须选择一个现有贡献片段`,
          segment.index
        )
      );
      continue;
    }

    const contribution = findContribution(segment, decision);
    if (!contribution) {
      issues.push(
        deliveryIssue(
          'DELIVERY_DECISION_NOT_A_CONTRIBUTOR',
          `第 ${segment.index + 1} 段的裁决不属于当前分析快照中的贡献片段，旧决定不可复用`,
          segment.index
        )
      );
      continue;
    }

    appendResolvedRun(runs, contribution, segment.index);
  }

  if (issues.length > 0) return { ok: false, issues };

  return {
    ok: true,
    items: runs,
    deliveredFrameTotal: runs.reduce((sum, item) => sum + item.durationFrames, 0)
  };
}

export function createSourceDeliveryExport(
  preview: SourceDeliveryPreview,
  resolution: Extract<SourceDeliveryResolution, { ok: true }>
): SourceDeliveryExport {
  return {
    schemaVersion: 1,
    rate: preview.rate,
    dayFrames: preview.dayFrames,
    selectionStart: preview.selectionStart,
    selectionEnd: preview.selectionEnd,
    durationFrames: preview.durationFrames,
    itemCount: resolution.items.length,
    deliveredFrameTotal: resolution.deliveredFrameTotal,
    items: resolution.items
  };
}

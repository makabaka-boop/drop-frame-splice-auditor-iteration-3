import {
  DropFrameRate,
  InvalidTimecodeError,
  isDropFrameRate,
  parseTimecode,
  toFrameTimecode
} from './timecode';
import { auditSourceReuse, type SourceReuseReport } from './reuse';

export type ClipId = string | number;

/**
 * 展示用 id：字符串带引号、数值原样。
 * 数值 1 与文本 "1" 都是合法 id 且互不相同，屏幕上必须能区分。
 */
export function formatClipId(id: ClipId): string {
  return typeof id === 'string' ? JSON.stringify(id) : String(id);
}

export interface FrameTimecode {
  frame: number;
  timecode: string;
}

export interface InputClip {
  id: ClipId;
  sourceIn: string;
  sourceOut: string;
  recordIn: string;
}

export interface ValidationIssue {
  code: string;
  message: string;
  path?: string;
}

export type ClipRelation = 'start' | 'contiguous' | 'gap' | 'overlap';

export interface AnalyzedClip {
  id: ClipId;
  inputIndex: number;
  sourceIn: FrameTimecode;
  sourceOut: FrameTimecode;
  recordIn: FrameTimecode;
  recordOut: FrameTimecode;
  durationFrames: number;
  relation: ClipRelation;
  previousClipId?: ClipId;
  gapBeforeFrames?: number;
  overlapBeforeFrames?: number;
  firstBreak: boolean;
}

export interface TimelineBreak {
  kind: 'gap' | 'overlap';
  afterClipId: ClipId;
  beforeClipId: ClipId;
  start: FrameTimecode;
  end: FrameTimecode;
  durationFrames: number;
  first: boolean;
}

export interface AnalysisResult {
  schemaVersion: 1;
  rate: DropFrameRate;
  dayFrames: number;
  clips: AnalyzedClip[];
  breaks: TimelineBreak[];
  firstBreak: TimelineBreak | null;
}

export type AnalysisResponse =
  | { ok: true; result: AnalysisResult; reuseReport: SourceReuseReport }
  | { ok: false; issues: ValidationIssue[] };

interface ValidatedClip {
  clip: InputClip;
  sourceInFrame: number;
  sourceOutFrame: number;
  recordInFrame: number;
  recordOutFrame: number;
  durationFrames: number;
  inputIndex: number;
}

const DAY_FRAMES = {
  '30000/1001': 2_589_408,
  '60000/1001': 5_178_816
} as const satisfies Record<DropFrameRate, number>;

const ROOT_KEYS = new Set(['rate', 'clips']);
const CLIP_KEYS = new Set(['id', 'sourceIn', 'sourceOut', 'recordIn']);
const TIMECODE_FIELDS = ['sourceIn', 'sourceOut', 'recordIn'] as const;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object'
    && value !== null
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function issue(code: string, message: string, path?: string): ValidationIssue {
  return { code, message, path };
}

function validateId(value: unknown, path: string, issues: ValidationIssue[]): ClipId | null {
  if (typeof value === 'string') {
    if (value.trim().length === 0) {
      issues.push(issue('CLIP_ID_EMPTY', '片段 id 不能为空字符串', path));
      return null;
    }
    return value;
  }

  if (typeof value === 'number' && Number.isSafeInteger(value)) {
    return value;
  }

  issues.push(issue('CLIP_ID_INVALID', '片段 id 必须是非空字符串或安全整数', path));
  return null;
}

function validate(rawInput: unknown): {
  rate: DropFrameRate;
  clips: ValidatedClip[];
  issues: ValidationIssue[];
} {
  const issues: ValidationIssue[] = [];

  if (!isPlainObject(rawInput)) {
    return {
      rate: '30000/1001',
      clips: [],
      issues: [issue('INPUT_OBJECT_REQUIRED', '整份输入必须是包含 rate 与 clips 的 JSON 对象')]
    };
  }

  let rate: DropFrameRate = '30000/1001';
  for (const key of Object.keys(rawInput)) {
    if (!ROOT_KEYS.has(key)) {
      issues.push(issue('INPUT_UNKNOWN_KEY', `根对象包含未定义字段：${key}`, key));
    }
  }

  if (!('rate' in rawInput)) {
    issues.push(issue('RATE_REQUIRED', '必须提供全局 rate', 'rate'));
  } else if (!isDropFrameRate(rawInput.rate)) {
    issues.push(issue('RATE_UNSUPPORTED', 'rate 只允许 30000/1001 或 60000/1001', 'rate'));
  } else {
    rate = rawInput.rate;
  }

  const clipsAreUsable = Array.isArray(rawInput.clips)
    && rawInput.clips.length >= 1
    && rawInput.clips.length <= 200;

  if (!('clips' in rawInput)) {
    issues.push(issue('CLIPS_REQUIRED', '必须提供 clips 数组', 'clips'));
  } else if (!Array.isArray(rawInput.clips)) {
    issues.push(issue('CLIPS_ARRAY_REQUIRED', 'clips 必须是数组', 'clips'));
  } else if (!clipsAreUsable) {
    issues.push(issue('CLIP_COUNT_INVALID', '片段数量必须在 1 至 200 个之间', 'clips'));
  }

  const clips: ValidatedClip[] = [];
  if (!isDropFrameRate(rawInput.rate) || !Array.isArray(rawInput.clips) || !clipsAreUsable) {
    return { rate, clips, issues };
  }

  const seenIds = new Set<ClipId>();
  rawInput.clips.forEach((rawClip, inputIndex) => {
    const clipPath = `clips[${inputIndex}]`;
    if (!isPlainObject(rawClip)) {
      issues.push(issue('CLIP_OBJECT_REQUIRED', '每个片段都必须是对象', clipPath));
      return;
    }

    for (const key of Object.keys(rawClip)) {
      if (!CLIP_KEYS.has(key)) {
        issues.push(issue('CLIP_UNKNOWN_KEY', `片段包含未定义字段：${key}`, `${clipPath}.${key}`));
      }
    }

    for (const key of CLIP_KEYS) {
      if (!(key in rawClip)) {
        issues.push(issue('CLIP_FIELD_REQUIRED', `片段缺少字段：${key}`, `${clipPath}.${key}`));
      }
    }

    let clipId: ClipId | null = null;
    if ('id' in rawClip) {
      clipId = validateId(rawClip.id, `${clipPath}.id`, issues);
      if (clipId !== null) {
        if (seenIds.has(clipId)) {
          issues.push(
            issue('CLIP_ID_DUPLICATE', `片段 id 必须唯一：${String(clipId)}`, `${clipPath}.id`)
          );
        }
        seenIds.add(clipId);
      }
    }

    const frames: Record<(typeof TIMECODE_FIELDS)[number], number | null> = {
      sourceIn: null,
      sourceOut: null,
      recordIn: null
    };

    for (const field of TIMECODE_FIELDS) {
      if (!(field in rawClip)) continue;
      try {
        frames[field] = parseTimecode(rawClip[field], rate).totalFrames;
      } catch (error) {
        if (error instanceof InvalidTimecodeError) {
          issues.push(issue(error.code, error.message, `${clipPath}.${field}`));
        } else {
          throw error;
        }
      }
    }

    if (clipId === null || frames.sourceIn === null || frames.sourceOut === null || frames.recordIn === null) {
      return;
    }

    const durationFrames = frames.sourceOut - frames.sourceIn;
    if (durationFrames <= 0) {
      issues.push(
        issue(
          'CLIP_DURATION_NON_POSITIVE',
          'sourceOut 是排他端，必须严格晚于 sourceIn',
          `${clipPath}.sourceOut`
        )
      );
      return;
    }

    const recordOutFrame = frames.recordIn + durationFrames;
    if (recordOutFrame >= DAY_FRAMES[rate]) {
      issues.push(
        issue(
          'RECORD_INTERVAL_WRAPS_DAY',
          'recordIn 至 recordOut 的区间不得触碰或跨越 24 小时回绕点',
          `${clipPath}.recordIn`
        )
      );
      return;
    }

    clips.push({
      clip: {
        id: clipId,
        sourceIn: rawClip.sourceIn as string,
        sourceOut: rawClip.sourceOut as string,
        recordIn: rawClip.recordIn as string
      },
      sourceInFrame: frames.sourceIn,
      sourceOutFrame: frames.sourceOut,
      recordInFrame: frames.recordIn,
      recordOutFrame,
      durationFrames,
      inputIndex
    });
  });

  return { rate, clips, issues };
}

export function analyzeInput(rawInput: unknown): AnalysisResponse {
  const { rate, clips, issues } = validate(rawInput);
  if (issues.length > 0) {
    return { ok: false, issues };
  }

  const sorted = clips
    .map((item, sortIndex) => ({ item, sortIndex }))
    .sort(
      (a, b) =>
        a.item.recordInFrame - b.item.recordInFrame
        || a.item.recordOutFrame - b.item.recordOutFrame
        || a.sortIndex - b.sortIndex
    );

  const analyzedClips: AnalyzedClip[] = [];
  const breaks: TimelineBreak[] = [];

  sorted.forEach(({ item }, sortedIndex) => {
    const baseClip: AnalyzedClip = {
      id: item.clip.id,
      inputIndex: item.inputIndex,
      sourceIn: toFrameTimecode(item.sourceInFrame, rate),
      sourceOut: toFrameTimecode(item.sourceOutFrame, rate),
      recordIn: toFrameTimecode(item.recordInFrame, rate),
      recordOut: toFrameTimecode(item.recordOutFrame, rate),
      durationFrames: item.durationFrames,
      relation: 'start',
      firstBreak: false
    };

    if (sortedIndex === 0) {
      analyzedClips.push(baseClip);
      return;
    }

    // 用当前起点之前的最远覆盖端判断，才能处理“前一片短、更早的片更长”的包含关系。
    const coverageEnd = analyzedClips
      .filter((clip) => clip.recordIn.frame <= item.recordInFrame)
      .reduce((max, clip) => Math.max(max, clip.recordOut.frame), 0);
    const owner = [...analyzedClips]
      .reverse()
      .find((clip) => clip.recordIn.frame <= item.recordInFrame && clip.recordOut.frame === coverageEnd);

    if (!owner) {
      throw new Error('无法确定录制时间线覆盖范围');
    }

    if (item.recordInFrame > coverageEnd) {
      const timelineBreak: TimelineBreak = {
        kind: 'gap',
        afterClipId: owner.id,
        beforeClipId: item.clip.id,
        start: toFrameTimecode(coverageEnd, rate),
        end: toFrameTimecode(item.recordInFrame, rate),
        durationFrames: item.recordInFrame - coverageEnd,
        first: false
      };
      breaks.push(timelineBreak);
      analyzedClips.push({
        ...baseClip,
        relation: 'gap',
        previousClipId: owner.id,
        gapBeforeFrames: timelineBreak.durationFrames
      });
      return;
    }

    if (item.recordInFrame < coverageEnd) {
      // 半开区间交集：重叠段在当前片段 recordOut 或既有覆盖端中较早者处截止，
      // 长片包住短片时不得把短片结束之后、长片仍在继续的帧计入该短片的重叠。
      const overlapEndFrame = Math.min(item.recordOutFrame, coverageEnd);
      const timelineBreak: TimelineBreak = {
        kind: 'overlap',
        afterClipId: owner.id,
        beforeClipId: item.clip.id,
        start: toFrameTimecode(item.recordInFrame, rate),
        end: toFrameTimecode(overlapEndFrame, rate),
        durationFrames: overlapEndFrame - item.recordInFrame,
        first: false
      };
      breaks.push(timelineBreak);
      analyzedClips.push({
        ...baseClip,
        relation: 'overlap',
        previousClipId: owner.id,
        overlapBeforeFrames: timelineBreak.durationFrames
      });
      return;
    }

    analyzedClips.push({
      ...baseClip,
      relation: 'contiguous',
      previousClipId: owner.id
    });
  });

  if (breaks.length > 0) {
    breaks[0].first = true;
    const firstBreakClip = analyzedClips.find((clip) => clip.id === breaks[0].beforeClipId);
    if (firstBreakClip) {
      firstBreakClip.firstBreak = true;
    }
  }

  const result: AnalysisResult = {
    schemaVersion: 1,
    rate,
    dayFrames: DAY_FRAMES[rate],
    clips: analyzedClips,
    breaks,
    firstBreak: breaks[0] ?? null
  };

  // 来源复用审计与接缝结论同生同灭：一份有效分析同时携带两套只读视图。
  // result 本身不新增字段，原 JSON 导出逐项不变；复用报告单独序列化下载。
  return { ok: true, result, reuseReport: auditSourceReuse(result) };
}

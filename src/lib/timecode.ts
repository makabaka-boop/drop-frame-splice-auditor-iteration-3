export type DropFrameRate = '30000/1001' | '60000/1001';

export interface RateConfig {
  readonly rate: DropFrameRate;
  readonly nominalFramesPerSecond: 30 | 60;
  readonly droppedFrames: 2 | 4;
  readonly blockFrames: number;
  readonly longMinuteFrames: number;
  readonly shortMinuteFrames: number;
  readonly dayFrames: number;
}

export const RATES = {
  '30000/1001': {
    rate: '30000/1001',
    nominalFramesPerSecond: 30,
    droppedFrames: 2,
    blockFrames: 17_982,
    longMinuteFrames: 1_800,
    shortMinuteFrames: 1_798,
    dayFrames: 2_589_408
  },
  '60000/1001': {
    rate: '60000/1001',
    nominalFramesPerSecond: 60,
    droppedFrames: 4,
    blockFrames: 35_964,
    longMinuteFrames: 3_600,
    shortMinuteFrames: 3_596,
    dayFrames: 5_178_816
  }
} as const satisfies Record<DropFrameRate, RateConfig>;

const TIMECODE_PATTERN = /^(\d{2}):(\d{2}):(\d{2});(\d{2})$/;

export function getRateConfig(rate: DropFrameRate): RateConfig {
  return RATES[rate];
}

export function isDropFrameRate(value: unknown): value is DropFrameRate {
  return value === '30000/1001' || value === '60000/1001';
}

export interface ParsedTimecode {
  readonly hours: number;
  readonly minutes: number;
  readonly seconds: number;
  readonly frames: number;
  readonly totalFrames: number;
}

export class InvalidTimecodeError extends TypeError {
  constructor(
    message: string,
    readonly code:
      | 'TIMECODE_FORMAT'
      | 'TIMECODE_OUT_OF_RANGE'
      | 'TIMECODE_DROPPED_FRAME'
      | 'FRAME_OUT_OF_RANGE'
  ) {
    super(message);
    this.name = 'InvalidTimecodeError';
  }
}

export function parseTimecode(value: unknown, rate: DropFrameRate): ParsedTimecode {
  const config = RATES[rate];
  if (typeof value !== 'string') {
    throw new InvalidTimecodeError('时码必须是 HH:MM:SS;FF 字符串', 'TIMECODE_FORMAT');
  }

  const match = TIMECODE_PATTERN.exec(value);
  if (!match) {
    throw new InvalidTimecodeError('时码格式必须固定为 HH:MM:SS;FF', 'TIMECODE_FORMAT');
  }

  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  const seconds = Number(match[3]);
  const frames = Number(match[4]);

  if (hours > 23 || minutes > 59 || seconds > 59 || frames >= config.nominalFramesPerSecond) {
    throw new InvalidTimecodeError('时码字段超出 24 小时或当前帧率范围', 'TIMECODE_OUT_OF_RANGE');
  }

  // 每个非整十分钟的第一秒跳过帧号 00..01（29.97）或 00..03（59.94）。
  if (minutes % 10 !== 0 && seconds === 0 && frames < config.droppedFrames) {
    throw new InvalidTimecodeError(
      `${value} 位于非整十分钟边界，是 SMPTE 丢帧规则中不存在的帧号`,
      'TIMECODE_DROPPED_FRAME'
    );
  }

  const totalMinutes = hours * 60 + minutes;
  const droppedOccurrences = totalMinutes - Math.floor(totalMinutes / 10);
  const totalFrames =
    hours * 3_600 * config.nominalFramesPerSecond +
    minutes * 60 * config.nominalFramesPerSecond +
    seconds * config.nominalFramesPerSecond +
    frames -
    droppedOccurrences * config.droppedFrames;

  if (totalFrames < 0 || totalFrames >= config.dayFrames) {
    throw new InvalidTimecodeError('时码必须位于 24 小时日内，不能回绕', 'TIMECODE_OUT_OF_RANGE');
  }

  return { hours, minutes, seconds, frames, totalFrames };
}

function pad2(value: number): string {
  return value.toString().padStart(2, '0');
}

/**
 * 按十个真实分钟为一组反算。每块第一分钟不丢帧，后九个短分钟各丢一组帧号。
 * 这种整数算法避免把 29.97/59.94 误当成普通 30/60 fps 或时分秒长度。
 */
export function formatFrame(totalFrames: number, rate: DropFrameRate): string {
  const config = RATES[rate];
  if (!Number.isSafeInteger(totalFrames) || totalFrames < 0 || totalFrames >= config.dayFrames) {
    throw new InvalidTimecodeError('整数帧位置超出 24 小时日范围', 'FRAME_OUT_OF_RANGE');
  }

  const blockIndex = Math.floor(totalFrames / config.blockFrames);
  const framesInBlock = totalFrames % config.blockFrames;

  let minuteInBlock: number;
  let labeledFrameInMinute: number;

  if (framesInBlock < config.longMinuteFrames) {
    minuteInBlock = 0;
    labeledFrameInMinute = framesInBlock;
  } else {
    const framesAfterLongMinute = framesInBlock - config.longMinuteFrames;
    minuteInBlock = 1 + Math.floor(framesAfterLongMinute / config.shortMinuteFrames);
    const frameInShortMinute = framesAfterLongMinute % config.shortMinuteFrames;
    // 实际分钟只有 nominal*60-drop 帧；第 0 个真实帧在标签上从跳过帧号之后开始。
    labeledFrameInMinute = frameInShortMinute + config.droppedFrames;
  }

  const totalMinutes = blockIndex * 10 + minuteInBlock;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  const seconds = Math.floor(labeledFrameInMinute / config.nominalFramesPerSecond);
  const frames = labeledFrameInMinute % config.nominalFramesPerSecond;

  return `${pad2(hours)}:${pad2(minutes)}:${pad2(seconds)};${pad2(frames)}`;
}

export function toFrameTimecode(totalFrames: number, rate: DropFrameRate) {
  return {
    frame: totalFrames,
    timecode: formatFrame(totalFrames, rate)
  };
}

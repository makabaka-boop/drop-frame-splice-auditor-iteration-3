export interface TimelineViewport {
  scrollLeft: number;
  width: number;
}

export interface TimelineTicks {
  step: number;
  values: number[];
}

const TICK_STEP_CANDIDATES = [
  1,
  2,
  5,
  10,
  15,
  30,
  60,
  100,
  150,
  300,
  600,
  900,
  1798,
  1800,
  3596,
  3600,
  8991,
  9000,
  17_982,
  35_964,
  53_946,
  107_892,
  215_784,
  431_568,
  647_352,
  1_294_704
];

const MAX_TICK_STEP = TICK_STEP_CANDIDATES[TICK_STEP_CANDIDATES.length - 1];

export function chooseTickStep(pixelsPerFrame: number, targetPixels: number): number {
  return (
    TICK_STEP_CANDIDATES.find((step) => step * pixelsPerFrame >= targetPixels) ?? MAX_TICK_STEP
  );
}

/**
 * 计算可视范围内的标尺刻度。
 * frame === dayFrames 是 24 小时回绕点，不是日内合法时码，
 * 刻度必须停在 dayFrames - 1 及以前，否则格式化会抛错。
 */
export function computeTimelineTicks(
  pixelsPerFrame: number,
  viewport: TimelineViewport,
  dayFrames: number
): TimelineTicks {
  const step = chooseTickStep(pixelsPerFrame, 96);
  const firstFrame = Math.max(0, Math.floor(viewport.scrollLeft / pixelsPerFrame / step) * step);
  const lastVisibleFrame = (viewport.scrollLeft + viewport.width) / pixelsPerFrame;
  const lastTickFrame = Math.min(dayFrames - 1, lastVisibleFrame + step);
  const values: number[] = [];
  for (let frame = firstFrame; frame <= lastTickFrame; frame += step) {
    values.push(frame);
  }
  return { step, values };
}

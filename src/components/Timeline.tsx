import { useEffect, useMemo, useRef, useState } from 'react';
import { AnalysisResult, ClipId, formatClipId } from '../lib/analysis';
import type { SourceDeliveryPreview } from '../lib/delivery';
import { formatFrame } from '../lib/timecode';
import { computeTimelineTicks } from '../lib/timeline';

export interface ReuseHighlight {
  clipId: ClipId;
  startFrame: number;
  endFrame: number;
}

interface TimelineProps {
  result: AnalysisResult;
  pixelsPerFrame: number;
  active: boolean;
  reuseHighlights?: ReuseHighlight[];
  deliveryPreview?: SourceDeliveryPreview;
}

export function Timeline({
  result,
  pixelsPerFrame,
  active,
  reuseHighlights = [],
  deliveryPreview
}: TimelineProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState({ scrollLeft: 0, width: 1200 });
  const width = Math.max(1, result.dayFrames * pixelsPerFrame);

  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;

    const update = () => {
      setViewport({ scrollLeft: element.scrollLeft, width: element.clientWidth });
    };
    update();

    const observer = new ResizeObserver(update);
    observer.observe(element);
    element.addEventListener('scroll', update, { passive: true });
    return () => {
      observer.disconnect();
      element.removeEventListener('scroll', update);
    };
  }, []);

  useEffect(() => {
    if (!active || !result.firstBreak) return;
    document.getElementById('timeline-first-break')?.scrollIntoView({
      behavior: 'smooth',
      inline: 'center',
      block: 'nearest'
    });
  }, [active, result.firstBreak]);

  // 复用证据联动：选中来源段后，把录制时间线上第一个落点滚入视野。
  const highlightKey = reuseHighlights
    .map((highlight) => `${highlight.startFrame}:${highlight.endFrame}`)
    .join('|');
  useEffect(() => {
    if (reuseHighlights.length === 0) return;
    document.getElementById('timeline-reuse-highlight')?.scrollIntoView({
      behavior: 'smooth',
      inline: 'center',
      block: 'nearest'
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [highlightKey]);

  const ticks = useMemo(
    () => computeTimelineTicks(pixelsPerFrame, viewport, result.dayFrames),
    [pixelsPerFrame, viewport, result.dayFrames]
  );

  const x = (frame: number) => frame * pixelsPerFrame;

  return (
    <div
      ref={scrollRef}
      className={`timeline-scroll ${active ? '' : 'timeline-stale'}`}
      aria-label="按录制帧位置绘制的可缩放时间线"
    >
      <svg className="timeline-svg" width={width} height="142" role="img">
        <rect x="0" y="0" width={width} height="142" className="timeline-background" />
        <line x1="0" y1="38" x2={width} y2="38" className="ruler-line" />

        {ticks.values.map((frame) => (
          <g key={frame}>
            <line x1={x(frame)} y1="30" x2={x(frame)} y2="38" className="ruler-tick" />
            {ticks.step * pixelsPerFrame >= 72 && (
              <text x={x(frame) + 3} y="22" className="ruler-label">
                {formatFrame(frame, result.rate)}
              </text>
            )}
          </g>
        ))}

        {result.breaks.map((breakItem, index) => {
          const left = x(breakItem.start.frame);
          const intervalWidth = Math.max(2, breakItem.durationFrames * pixelsPerFrame);
          return (
            <g key={`${breakItem.kind}-${index}`}>
              <rect
                x={left}
                y={78}
                width={intervalWidth}
                height={18}
                className={breakItem.kind === 'gap' ? 'gap-band' : 'overlap-band'}
              >
                <title>
                  {`${breakItem.kind === 'gap' ? '空隙' : '重叠'} ${breakItem.durationFrames} 帧：${breakItem.start.timecode} → ${breakItem.end.timecode}`}
                </title>
              </rect>
            </g>
          );
        })}

        {deliveryPreview && (
          <g aria-label="来源交付预演分段">
            {deliveryPreview.segments.map((segment) => (
              <rect
                key={`delivery-${segment.index}`}
                x={x(segment.recordStart.frame)}
                y={114}
                width={Math.max(1, segment.durationFrames * pixelsPerFrame)}
                height={16}
                className={`delivery-band delivery-band-${segment.kind}`}
              >
                <title>
                  {`交付预演 #${segment.index + 1} ${
                    segment.kind === 'gap'
                      ? '空隙'
                      : segment.kind === 'unique'
                        ? '唯一来源'
                        : '多来源冲突'
                  }：${segment.recordStart.timecode} → ${segment.recordEnd.timecode}（${segment.durationFrames} 帧）`}
                </title>
              </rect>
            ))}
          </g>
        )}

        {result.clips.map((clip, index) => {
          const left = x(clip.recordIn.frame);
          const clipWidth = Math.max(2, clip.durationFrames * pixelsPerFrame);
          return (
            <g key={`${String(clip.id)}-${index}`}>
              <rect
                x={left}
                y={48}
                width={clipWidth}
                height={28}
                className={`clip-rect clip-${clip.relation} ${clip.firstBreak ? 'clip-first-break' : ''}`}
              >
                <title>
                  {`片段 ${formatClipId(clip.id)}\nrecordIn ${clip.recordIn.timecode}\nrecordOut ${clip.recordOut.timecode}\n时长 ${clip.durationFrames} 帧`}
                </title>
              </rect>
              {clipWidth >= 34 && (
                <text x={left + 6} y="67" className="clip-label">
                  {formatClipId(clip.id)}
                </text>
              )}
            </g>
          );
        })}

        {reuseHighlights.map((highlight, index) => {
          const left = x(highlight.startFrame);
          const highlightWidth = Math.max(2, (highlight.endFrame - highlight.startFrame) * pixelsPerFrame);
          return (
            <g
              key={`reuse-${String(highlight.clipId)}-${index}`}
              id={index === 0 ? 'timeline-reuse-highlight' : undefined}
            >
              <rect
                x={left}
                y={44}
                width={highlightWidth}
                height={36}
                className="reuse-highlight-frame"
              >
                <title>{`复用落点：片段 ${formatClipId(highlight.clipId)}`}</title>
              </rect>
              <rect
                x={left}
                y={100}
                width={highlightWidth}
                height={12}
                className="reuse-highlight-band"
              >
                <title>
                  {`复用落点：片段 ${formatClipId(highlight.clipId)}，录制帧 ${highlight.startFrame} – ${highlight.endFrame}`}
                </title>
              </rect>
            </g>
          );
        })}

        {result.firstBreak && (
          <g id="timeline-first-break">
            <line
              x1={x(result.firstBreak.start.frame)}
              y1="4"
              x2={x(result.firstBreak.start.frame)}
              y2="138"
              className="first-break-line"
            />
            <text x={x(result.firstBreak.start.frame) + 6} y="126" className="first-break-label">
              第一断点
            </text>
          </g>
        )}
      </svg>
    </div>
  );
}

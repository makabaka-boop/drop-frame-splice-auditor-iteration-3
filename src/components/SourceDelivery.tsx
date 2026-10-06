import { formatClipId } from '../lib/analysis';
import type {
  DeliveryDecisions,
  DeliveryIssue,
  SourceDeliveryPreview
} from '../lib/delivery';

interface SourceDeliveryProps {
  preview: SourceDeliveryPreview;
  decisions: DeliveryDecisions;
  active: boolean;
  canExport: boolean;
  issues: DeliveryIssue[];
  onChangeDecision: (segmentIndex: number, clipId: string | number) => void;
  onExport: () => void;
}

const SEGMENT_TEXT = {
  gap: '空隙',
  unique: '唯一来源',
  conflict: '多来源冲突'
} as const;

function issueForSegment(issues: DeliveryIssue[], index: number) {
  return issues.find((item) => item.segmentIndex === index);
}

/**
 * 来源交付预演面板只渲染 analyzer 已生成的同一份分段结果；裁决仅允许选择
 * 当前段列出现有贡献片段，非法快照不会把旧 id 传回新结果。
 */
export function SourceDelivery({
  preview,
  decisions,
  active,
  canExport,
  issues,
  onChangeDecision,
  onExport
}: SourceDeliveryProps) {
  const unresolvedCount = preview.segments.filter(
    (segment) => segment.kind === 'conflict' && decisions[segment.index] === undefined
  ).length;

  return (
    <section className="panel delivery-panel" aria-label="来源交付预演">
      <div className="panel-heading">
        <div>
          <h2>来源交付预演</h2>
          <p>
            半开录制区间{' '}
            <code>
              {preview.selectionStart.timecode} → {preview.selectionEnd.timecode}
            </code>{' '}
            · {preview.durationFrames} 帧 · {preview.segments.length} 个集合恒定最大区间 · 空隙{' '}
            <strong>{preview.gapFrameTotal}</strong> 帧 · 冲突 <strong>{unresolvedCount}</strong>/{' '}
            {preview.conflictSegmentCount} 段未裁决
          </p>
        </div>
        <div className="button-row">
          <button
            type="button"
            className="button primary"
            disabled={!canExport}
            onClick={onExport}
          >
            导出来源清单
          </button>
        </div>
      </div>

      {!active && (
        <div className="delivery-warning" role="alert">
          当前输入非法：以下预演和裁决属于上次合法分析快照，不能导出，也不会用于新结果。
        </div>
      )}

      {issues.length > 0 && (
        <div className={active ? 'delivery-warning' : 'delivery-export-blocks'} role="status">
          <strong>{active ? '仍禁止导出：' : '上次合法预演的裁决状态：'}</strong>
          <ul>
            {issues.map((issue, index) => (
              <li key={`${issue.code}-${issue.segmentIndex ?? index}`}>{issue.message}</li>
            ))}
          </ul>
        </div>
      )}

      {issues.length === 0 && active && (
        <div className="delivery-ready" role="status">
          所有帧均有唯一裁决来源；相邻段仅在片段身份、原片坐标和录制坐标都连续时合并。
        </div>
      )}

      <ol className="delivery-segment-list">
        {preview.segments.map((segment) => {
          const blocker = issueForSegment(issues, segment.index);
          const decision = decisions[segment.index];
          return (
            <li
              key={segment.index}
              className={`delivery-segment delivery-${segment.kind} ${blocker ? 'delivery-blocked' : ''} ${
                segment.kind === 'conflict' && decision !== undefined ? 'delivery-decided' : ''
              }`}
            >
              <header className="delivery-segment-head">
                <span className="delivery-index">#{segment.index + 1}</span>
                <span className={`delivery-kind delivery-kind-${segment.kind}`}>
                  {SEGMENT_TEXT[segment.kind]}
                </span>
                <strong>
                  录制帧 {segment.recordStart.frame} – {segment.recordEnd.frame}
                </strong>
                <code>
                  {segment.recordStart.timecode} → {segment.recordEnd.timecode}
                </code>
                <span>{segment.durationFrames} 帧</span>
              </header>

              {segment.kind === 'gap' ? (
                <p className="delivery-contributions">该整数帧区间没有任何贡献片段，禁止猜测来源。</p>
              ) : (
                <ul className="delivery-contributions">
                  {segment.contributions.map((contribution) => {
                    const checked = decision === contribution.clipId;
                    return (
                      <li
                        key={`${typeof contribution.clipId}:${String(contribution.clipId)}`}
                        className={checked ? 'delivery-choice-selected' : ''}
                      >
                        <label>
                          {segment.kind === 'conflict' ? (
                            <input
                              type="radio"
                              name={`delivery-conflict-${segment.index}`}
                              value={String(contribution.clipId)}
                              checked={checked}
                              disabled={!active}
                              onChange={() => onChangeDecision(segment.index, contribution.clipId)}
                            />
                          ) : (
                            <span className="delivery-unique-dot" aria-hidden="true" />
                          )}
                          <code>{formatClipId(contribution.clipId)}</code>
                        </label>
                        <span>
                          原片 {contribution.sourceStart.frame} – {contribution.sourceEnd.frame}（
                          {contribution.sourceStart.timecode} → {contribution.sourceEnd.timecode}）
                        </span>
                        <span>
                          录制 {contribution.recordStart.frame} – {contribution.recordEnd.frame}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              )}
            </li>
          );
        })}
      </ol>
    </section>
  );
}

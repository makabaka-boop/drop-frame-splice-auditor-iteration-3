import { useState } from 'react';
import { formatClipId, type ClipId, type ValidationIssue } from '../lib/analysis';
import type {
  ProvenanceBlocker,
  ProvenancePreview,
  ProvenanceSegment,
  ProvenanceSegmentKind
} from '../lib/provenance';

/**
 * 预演会话视图：分段结果与冲突裁决。会话层（App）保证它们绑定
 * 到产生它们的分析快照；本组件只渲染，不自行跨快照沿用任何决定。
 */
export interface ProvenanceSessionView {
  preview: ProvenancePreview;
  rulings: ReadonlyMap<number, ClipId>;
}

interface ProvenancePreviewPanelProps {
  /** 当前输入是否有效（决定能否生成新预演）。 */
  active: boolean;
  /** 绑定当前有效快照的会话；无绑定会话时为 null。 */
  session: ProvenanceSessionView | null;
  /** 存在已失效的旧会话（输入已变更或非法）。 */
  revoked: boolean;
  /** 选区时码本身的校验问题。 */
  issues: ValidationIssue[];
  /** 当前会话的导出阻塞项（与导出闸门同一份计算）。 */
  blockers: ProvenanceBlocker[];
  onBuild: (selectionIn: string, selectionOut: string) => void;
  onRule: (segmentIndex: number, clipId: ClipId) => void;
  onExport: () => void;
}

const KIND_TEXT: Record<ProvenanceSegmentKind, string> = {
  gap: '空隙',
  unique: '唯一来源',
  conflict: '多来源冲突'
};

function SegmentRow({
  segment,
  rulings,
  onRule
}: {
  segment: ProvenanceSegment;
  rulings: ReadonlyMap<number, ClipId>;
  onRule: (segmentIndex: number, clipId: ClipId) => void;
}) {
  return (
    <li className={`provenance-segment provenance-segment-${segment.kind}`}>
      <span className="provenance-segment-head">
        <span className={`badge provenance-badge-${segment.kind}`}>{KIND_TEXT[segment.kind]}</span>
        <strong>
          录制帧 {segment.recordStart.frame} – {segment.recordEnd.frame}
        </strong>
        <code>
          {segment.recordStart.timecode} → {segment.recordEnd.timecode}
        </code>
        <span>{segment.durationFrames} 帧</span>
      </span>

      {segment.kind === 'gap' && (
        <span className="provenance-gap-note">
          该段无任何片段覆盖：来源不明，禁止猜测，导出被阻止。
        </span>
      )}

      {segment.kind === 'unique' && (
        <span className="provenance-contribution">
          唯一来源 <code>{formatClipId(segment.contributions[0].clipId)}</code> · 原片帧{' '}
          {segment.contributions[0].sourceStart.frame} – {segment.contributions[0].sourceEnd.frame}
          （{segment.contributions[0].sourceStart.timecode} →{' '}
          {segment.contributions[0].sourceEnd.timecode}）
        </span>
      )}

      {segment.kind === 'conflict' && (
        <span
          className="provenance-contributions"
          role="group"
          aria-label={`段 ${segment.index + 1} 冲突裁决`}
        >
          <span className="provenance-conflict-note">重叠覆盖，须裁决一个现有贡献片段：</span>
          {segment.contributions.map((contribution) => {
            const chosen = rulings.get(segment.index) === contribution.clipId;
            return (
              <button
                key={formatClipId(contribution.clipId)}
                type="button"
                className={`provenance-contribution provenance-choice ${
                  chosen ? 'provenance-choice-active' : ''
                }`}
                aria-pressed={chosen}
                onClick={() => onRule(segment.index, contribution.clipId)}
              >
                采用 <code>{formatClipId(contribution.clipId)}</code> · 原片帧{' '}
                {contribution.sourceStart.frame} – {contribution.sourceEnd.frame}（
                {contribution.sourceStart.timecode} → {contribution.sourceEnd.timecode}）
              </button>
            );
          })}
        </span>
      )}
    </li>
  );
}

export function ProvenancePreviewPanel({
  active,
  session,
  revoked,
  issues,
  blockers,
  onBuild,
  onRule,
  onExport
}: ProvenancePreviewPanelProps) {
  const [selectionIn, setSelectionIn] = useState('');
  const [selectionOut, setSelectionOut] = useState('');

  const gapBlockers = blockers.filter((blocker) => blocker.kind === 'gap').length;
  const conflictBlockers = blockers.filter(
    (blocker) => blocker.kind === 'unresolved-conflict'
  ).length;
  const blockerParts: string[] = [];
  if (gapBlockers > 0) blockerParts.push(`${gapBlockers} 段空隙`);
  if (conflictBlockers > 0) blockerParts.push(`${conflictBlockers} 段冲突未裁决`);

  return (
    <section
      className={`panel provenance-panel ${active ? '' : 'provenance-stale'}`}
      aria-label="来源交付预演"
    >
      <div className="panel-heading">
        <div>
          <h2>来源交付预演</h2>
          <p>
            按丢帧时码选择半开录制区间，切成贡献片段集合恒定的最大区间；逐段列出空隙、
            唯一来源或多来源冲突，并把每个贡献片段平移回原片起止帧。
            {!active && <span className="stale-note">（当前输入非法，不能生成新预演）</span>}
          </p>
        </div>
        <div className="button-row">
          <button
            type="button"
            className="button primary"
            disabled={!session || blockers.length > 0}
            onClick={onExport}
          >
            导出取材清单
          </button>
        </div>
      </div>

      <form
        className="provenance-selection-form"
        onSubmit={(event) => {
          event.preventDefault();
          onBuild(selectionIn, selectionOut);
        }}
      >
        <label>
          选区开始
          <input
            type="text"
            value={selectionIn}
            placeholder="HH:MM:SS;FF"
            aria-label="选区开始时码"
            onChange={(event) => setSelectionIn(event.target.value)}
          />
        </label>
        <label>
          选区结束（排他）
          <input
            type="text"
            value={selectionOut}
            placeholder="HH:MM:SS;FF"
            aria-label="选区结束时码"
            onChange={(event) => setSelectionOut(event.target.value)}
          />
        </label>
        <button type="submit" className="button secondary" disabled={!active}>
          生成预演
        </button>
      </form>

      {issues.length > 0 && (
        <div className="issue-list" role="alert">
          <h3>选区非法</h3>
          <ul>
            {issues.map((item, index) => (
              <li key={`${item.code}-${index}`}>
                {item.path && <code>{item.path}</code>}
                <span>{item.message}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {revoked && (
        <div className="provenance-revoked" role="status">
          片段输入已变更，此前预演与冲突裁决全部失效，不会套用到新结果；请重新生成预演。
        </div>
      )}

      {session && (
        <>
          <p className="provenance-summary">
            选区 <code>{session.preview.selection.recordStart.timecode}</code> →{' '}
            <code>{session.preview.selection.recordEnd.timecode}</code>（
            {session.preview.selection.durationFrames} 帧）· 共{' '}
            <strong>{session.preview.segmentCount}</strong> 段 · 空隙{' '}
            <strong>{session.preview.gapFrameTotal}</strong> 帧 · 冲突{' '}
            <strong>{session.preview.conflictFrameTotal}</strong> 帧
          </p>

          <ol className="provenance-segment-list">
            {session.preview.segments.map((segment) => (
              <SegmentRow
                key={segment.index}
                segment={segment}
                rulings={session.rulings}
                onRule={onRule}
              />
            ))}
          </ol>

          <div className="provenance-footer" role="status">
            {blockers.length > 0 ? (
              <span className="provenance-blocked">
                导出受阻：{blockerParts.join('、')}。空隙不能猜测来源，冲突必须裁决。
              </span>
            ) : (
              <span className="provenance-ready">
                选区无空隙，冲突已全部裁决，可按录制顺序导出取材清单。
              </span>
            )}
          </div>
        </>
      )}
    </section>
  );
}

import { formatClipId } from '../lib/analysis';
import type { SourceReuseReport } from '../lib/reuse';

interface ReuseAuditProps {
  report: SourceReuseReport;
  active: boolean;
  selectedIndex: number | null;
  canDownload: boolean;
  onSelect: (index: number) => void;
  onDownload: () => void;
}

/**
 * 只读来源复用审计面板：来源轴分布条 + 复用段证据列表。
 * 不提供任何编辑入口；点击段仅用于联动高亮来源段与录制时间线落点。
 */
export function ReuseAudit({
  report,
  active,
  selectedIndex,
  canDownload,
  onSelect,
  onDownload
}: ReuseAuditProps) {
  const dayFrames = Math.max(1, report.dayFrames);

  return (
    <section
      className={`panel reuse-panel ${active ? '' : 'reuse-stale'}`}
      aria-label="来源复用审计"
    >
      <div className="panel-heading">
        <div>
          <h2>来源复用审计</h2>
          <p>
            只读 · 各片段 [sourceIn, sourceOut) 投到同一来源轴，端点扫描出被至少两片覆盖的最大半开区间，
            活动片段集合一变即断开。共 <strong>{report.segmentCount}</strong> 段 · 复用{' '}
            <strong>{report.reusedFrameTotal.toLocaleString('zh-CN')}</strong> 帧
            {!active && <span className="stale-note">（以下为上次合法结果，不对应当前文本）</span>}
          </p>
        </div>
        <div className="button-row">
          <button
            type="button"
            className="button secondary"
            disabled={!canDownload}
            onClick={onDownload}
          >
            下载复用报告
          </button>
        </div>
      </div>

      {report.segments.length === 0 ? (
        <div className="reuse-empty" role="status">
          所有片段的来源区间互不重叠，未发现来源复用。
        </div>
      ) : (
        <>
          <div className="reuse-axis" role="group" aria-label="来源轴复用分布">
            {report.segments.map((segment) => (
              <button
                key={segment.index}
                type="button"
                className={`reuse-axis-segment ${
                  selectedIndex === segment.index ? 'reuse-axis-selected' : ''
                }`}
                style={{
                  left: `${(segment.sourceStart.frame / dayFrames) * 100}%`,
                  width: `max(${(segment.durationFrames / dayFrames) * 100}%, 4px)`
                }}
                title={`来源 ${segment.sourceStart.timecode} → ${segment.sourceEnd.timecode} · 覆盖 ${segment.coverCount} 片`}
                aria-label={`复用段 ${segment.index + 1}：来源帧 ${segment.sourceStart.frame} 起`}
                onClick={() => onSelect(segment.index)}
              />
            ))}
          </div>

          <ol className="reuse-segment-list">
            {report.segments.map((segment) => (
              <li key={segment.index}>
                <button
                  type="button"
                  className={`reuse-segment ${
                    selectedIndex === segment.index ? 'reuse-selected' : ''
                  }`}
                  aria-pressed={selectedIndex === segment.index}
                  onClick={() => onSelect(segment.index)}
                >
                  <span className="reuse-segment-head">
                    <strong>
                      来源帧 {segment.sourceStart.frame} – {segment.sourceEnd.frame}
                    </strong>
                    <code>
                      {segment.sourceStart.timecode} → {segment.sourceEnd.timecode}
                    </code>
                    <span>
                      {segment.durationFrames} 帧 · 覆盖 {segment.coverCount} 片
                    </span>
                  </span>
                  <span className="reuse-clip-ids">
                    覆盖片段：
                    {segment.clipIds.map((id) => (
                      <code key={formatClipId(id)}>{formatClipId(id)}</code>
                    ))}
                  </span>
                  <span className="reuse-placements">
                    {segment.placements.map((placement) => (
                      <span key={formatClipId(placement.clipId)} className="reuse-placement">
                        <code>{formatClipId(placement.clipId)}</code> 录制帧{' '}
                        {placement.recordStart.frame} – {placement.recordEnd.frame}（
                        {placement.recordStart.timecode} → {placement.recordEnd.timecode}）
                      </span>
                    ))}
                  </span>
                </button>
              </li>
            ))}
          </ol>
        </>
      )}
    </section>
  );
}

import { useEffect, useMemo, useState } from 'react';
import { Timeline, type ReuseHighlight } from './components/Timeline';
import { ResultTable } from './components/ResultTable';
import { ReuseAudit } from './components/ReuseAudit';
import { SAMPLE_INPUT } from './sample';
import { AnalysisResult, ValidationIssue, analyzeInput, formatClipId } from './lib/analysis';
import type { SourceReuseReport } from './lib/reuse';

const ZOOM_LEVELS = [
  { label: '全日览', pixelsPerFrame: 0.0002 },
  { label: '小时', pixelsPerFrame: 0.001 },
  { label: '分钟', pixelsPerFrame: 0.02 },
  { label: '秒', pixelsPerFrame: 0.08 },
  { label: '帧', pixelsPerFrame: 0.7 },
  { label: '放大帧', pixelsPerFrame: 2 }
];

/**
 * 一份有效分析的两套只读视图：接缝结论 + 来源复用审计。
 * 二者来自同一次 analyzeInput，作为整体原子替换，页面永远不会一半新一半旧。
 */
interface ResultSnapshot {
  result: AnalysisResult;
  reuseReport: SourceReuseReport;
}

function parseJsonInput(text: string) {
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    return {
      ok: false as const,
      issues: [
        {
          code: 'JSON_SYNTAX_ERROR',
          message: error instanceof Error ? `JSON 语法错误：${error.message}` : 'JSON 无法解析'
        }
      ]
    };
  }
}

function downloadJson(filename: string, payload: unknown) {
  const blob = new Blob([`${JSON.stringify(payload, null, 2)}\n`], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

export default function App() {
  const [inputText, setInputText] = useState(SAMPLE_INPUT);
  const [lastSnapshot, setLastSnapshot] = useState<ResultSnapshot | null>(null);
  const [selection, setSelection] = useState<{ snapshot: ResultSnapshot; index: number } | null>(
    null
  );
  const [zoomIndex, setZoomIndex] = useState(1);

  const response = useMemo(() => {
    const parsed = parseJsonInput(inputText);
    if (
      typeof parsed === 'object'
      && parsed !== null
      && 'ok' in parsed
      && (parsed as { ok?: boolean }).ok === false
    ) {
      return parsed as { ok: false; issues: ValidationIssue[] };
    }
    return analyzeInput(parsed);
  }, [inputText]);

  const activeSnapshot = useMemo<ResultSnapshot | null>(
    () => (response.ok ? { result: response.result, reuseReport: response.reuseReport } : null),
    [response]
  );

  useEffect(() => {
    if (activeSnapshot) {
      setLastSnapshot(activeSnapshot);
    }
  }, [activeSnapshot]);

  const shownSnapshot = activeSnapshot ?? lastSnapshot;
  const stale = !response.ok;
  const issues = response.ok ? [] : response.issues;

  // 选中证据绑定到产生它的那份快照：新有效输入原子替换两套视图后，旧选中自动失效。
  const selectedSegment =
    selection && shownSnapshot && selection.snapshot === shownSnapshot
      ? shownSnapshot.reuseReport.segments[selection.index] ?? null
      : null;

  const reuseHighlights = useMemo<ReuseHighlight[]>(
    () =>
      selectedSegment
        ? selectedSegment.placements.map((placement) => ({
            clipId: placement.clipId,
            startFrame: placement.recordStart.frame,
            endFrame: placement.recordEnd.frame
          }))
        : [],
    [selectedSegment]
  );

  async function importFile(file: File | undefined) {
    if (!file) return;
    setInputText(await file.text());
  }

  function handleSelectSegment(index: number) {
    if (!shownSnapshot) return;
    setSelection((current) =>
      current && current.snapshot === shownSnapshot && current.index === index
        ? null
        : { snapshot: shownSnapshot, index }
    );
  }

  return (
    <main className="app-shell">
      <header className="hero">
        <div>
          <p className="eyebrow">SMPTE 30000/1001 · 60000/1001</p>
          <h1>丢帧时码合版核对台</h1>
          <p className="subtitle">
            时码先转换为整数帧，再计算 recordOut、空隙与重叠；标尺和表格引用同一份不可变结果。
            来源复用审计把各片段来源区间投到同一来源轴，单独核对原始画面复用。
          </p>
        </div>
        <div className={`status-card ${stale ? 'status-stale' : 'status-valid'}`}>
          <span className="status-dot" />
          <strong>{stale ? '当前结论已撤销' : '当前输入有效'}</strong>
          <small>非法编辑不会替换上次合法结果</small>
        </div>
      </header>

      <section className="workspace-grid">
        <div className="panel input-panel">
          <div className="panel-heading">
            <div>
              <h2>输入 JSON</h2>
              <p>固定 HH:MM:SS;FF，sourceOut 为排他端，数量 1–200。</p>
            </div>
            <div className="button-row">
              <label className="button secondary">
                导入文件
                <input
                  type="file"
                  accept="application/json,.json"
                  onChange={(event) => {
                    void importFile(event.target.files?.[0]);
                    event.target.value = '';
                  }}
                />
              </label>
              <button type="button" className="button secondary" onClick={() => setInputText(SAMPLE_INPUT)}>
                示例
              </button>
              <button
                type="button"
                className="button primary"
                disabled={!activeSnapshot}
                onClick={() =>
                  activeSnapshot &&
                  downloadJson(
                    `dropframe-check-${activeSnapshot.result.rate.replace('/', '_')}.json`,
                    activeSnapshot.result
                  )
                }
              >
                导出核对 JSON
              </button>
            </div>
          </div>
          <textarea
            spellCheck={false}
            value={inputText}
            onChange={(event) => setInputText(event.target.value)}
            aria-label="片段 JSON 输入"
          />
          {stale && (
            <div className="issue-list" role="alert">
              <h3>整份输入已拒绝</h3>
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
        </div>

        <div className="panel rules-panel">
          <h2>丢帧规则</h2>
          <ul>
            <li>29.97：每个非整十分钟跳过 <code>;00</code>、<code>;01</code>。</li>
            <li>59.94：每个非整十分钟跳过 <code>;00</code> 至 <code>;03</code>。</li>
            <li>整十分钟和小时边界不跳帧，不能按普通时分秒乘 30/60。</li>
            <li>recordOut = recordIn + (sourceOut − sourceIn)，触碰 24 小时即拒绝。</li>
            <li>复用审计只看来源轴：同一批来源帧被两片以上覆盖即列出证据。</li>
          </ul>
        </div>
      </section>

      {shownSnapshot && (
        <section className="panel result-panel">
          <div className="panel-heading result-heading">
            <div>
              <h2>核对结果</h2>
              <p>
                全局 rate <code>{shownSnapshot.result.rate}</code> · 日帧长{' '}
                <strong>{shownSnapshot.result.dayFrames.toLocaleString('zh-CN')}</strong> ·{' '}
                {shownSnapshot.result.clips.length} 个片段 · {shownSnapshot.result.breaks.length} 处断点
                {stale && <span className="stale-note">（以下为上次合法结果，不对应当前文本）</span>}
              </p>
            </div>
            <div className="zoom-controls" aria-label="缩放标尺">
              <button
                type="button"
                className="button icon"
                disabled={zoomIndex === 0}
                onClick={() => setZoomIndex((value) => Math.max(0, value - 1))}
              >
                −
              </button>
              <span>{ZOOM_LEVELS[zoomIndex].label}</span>
              <button
                type="button"
                className="button icon"
                disabled={zoomIndex === ZOOM_LEVELS.length - 1}
                onClick={() => setZoomIndex((value) => Math.min(ZOOM_LEVELS.length - 1, value + 1))}
              >
                +
              </button>
            </div>
          </div>

          {shownSnapshot.result.firstBreak ? (
            <div className="first-break-summary" role="status">
              <strong>第一处真实拼接断点</strong>
              <span>
                {shownSnapshot.result.firstBreak.kind === 'gap' ? '空隙' : '重叠'}：片段{' '}
                <code>{formatClipId(shownSnapshot.result.firstBreak.afterClipId)}</code> 与{' '}
                <code>{formatClipId(shownSnapshot.result.firstBreak.beforeClipId)}</code> 之间，
                {shownSnapshot.result.firstBreak.start.timecode} →{' '}
                {shownSnapshot.result.firstBreak.end.timecode}，共{' '}
                {shownSnapshot.result.firstBreak.durationFrames} 帧。
              </span>
            </div>
          ) : (
            <div className="contiguous-summary" role="status">
              所有片段按录制位置首尾相接，未发现空隙或重叠。
            </div>
          )}

          <Timeline
            result={shownSnapshot.result}
            pixelsPerFrame={ZOOM_LEVELS[zoomIndex].pixelsPerFrame}
            active={!stale}
            reuseHighlights={reuseHighlights}
          />
          <ResultTable clips={shownSnapshot.result.clips} />
        </section>
      )}

      {shownSnapshot && (
        <ReuseAudit
          report={shownSnapshot.reuseReport}
          active={!stale}
          selectedIndex={selectedSegment && selection ? selection.index : null}
          canDownload={activeSnapshot !== null}
          onSelect={handleSelectSegment}
          onDownload={() =>
            activeSnapshot &&
            downloadJson(
              `source-reuse-audit-${activeSnapshot.reuseReport.rate.replace('/', '_')}.json`,
              activeSnapshot.reuseReport
            )
          }
        />
      )}

      {!shownSnapshot && (
        <section className="panel empty-state">
          <h2>尚无合法结果</h2>
          <p>修正输入后才会生成整数帧、recordOut 与拼接断点。</p>
        </section>
      )}
    </main>
  );
}

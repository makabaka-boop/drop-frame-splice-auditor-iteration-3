import { AnalyzedClip, formatClipId } from '../lib/analysis';

interface ResultTableProps {
  clips: AnalyzedClip[];
}

const RELATION_TEXT: Record<AnalyzedClip['relation'], string> = {
  start: '首段',
  contiguous: '连续',
  gap: '空隙',
  overlap: '重叠'
};

export function ResultTable({ clips }: ResultTableProps) {
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>顺序</th>
            <th>id</th>
            <th>sourceIn</th>
            <th>sourceOut（排他）</th>
            <th>recordIn</th>
            <th>recordOut</th>
            <th>时长（帧）</th>
            <th>拼接状态</th>
            <th>偏差</th>
          </tr>
        </thead>
        <tbody>
          {clips.map((clip, index) => (
            <tr key={`${String(clip.id)}-${clip.inputIndex}`} className={clip.firstBreak ? 'first-break-row' : ''}>
              <td>{index + 1}</td>
              <td className="clip-id">{formatClipId(clip.id)}</td>
              <td>{clip.sourceIn.timecode}</td>
              <td>{clip.sourceOut.timecode}</td>
              <td>{clip.recordIn.timecode}</td>
              <td>{clip.recordOut.timecode}</td>
              <td className="number">{clip.durationFrames}</td>
              <td>
                <span className={`badge badge-${clip.relation}`}>{RELATION_TEXT[clip.relation]}</span>
                {clip.previousClipId !== undefined && (
                  <span className="previous-id">接 {formatClipId(clip.previousClipId)}</span>
                )}
              </td>
              <td className="number">
                {clip.gapBeforeFrames !== undefined && `空隙 ${clip.gapBeforeFrames} 帧`}
                {clip.overlapBeforeFrames !== undefined && `重叠 ${clip.overlapBeforeFrames} 帧`}
                {(clip.relation === 'start' || clip.relation === 'contiguous') && '—'}
                {clip.firstBreak && <strong className="first-break-inline">第一断点</strong>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

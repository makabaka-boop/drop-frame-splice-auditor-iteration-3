// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import App from './App';

const REUSE_INPUT = JSON.stringify({
  rate: '30000/1001',
  clips: [
    { id: '甲', sourceIn: '01:00:00;00', sourceOut: '01:00:10;00', recordIn: '00:10:00;00' },
    { id: '乙', sourceIn: '01:00:05;00', sourceOut: '01:00:15;00', recordIn: '00:10:10;00' },
    { id: '丙', sourceIn: '02:00:00;00', sourceOut: '02:00:05;00', recordIn: '00:10:25;00' }
  ]
});

const CONTIGUOUS_INPUT = JSON.stringify({
  rate: '30000/1001',
  clips: [
    { id: 'X', sourceIn: '03:00:00;00', sourceOut: '03:00:05;00', recordIn: '00:20:00;00' },
    { id: 'Y', sourceIn: '04:00:00;00', sourceOut: '04:00:05;00', recordIn: '00:20:05;00' }
  ]
});

const INVALID_INPUT = JSON.stringify({ rate: '30000/1001', clips: [] });

// 甲录制 [00:10:00;00, 00:10:10;00)，乙 [00:10:05;00, 00:10:10;00)+150 与甲交叠 150 帧，
// 丙 [00:10:20;00, 00:10:25;00)，乙丙之间留 150 帧空隙。
const PROVENANCE_INPUT = JSON.stringify({
  rate: '30000/1001',
  clips: [
    { id: '甲', sourceIn: '01:00:00;00', sourceOut: '01:00:10;00', recordIn: '00:10:00;00' },
    { id: '乙', sourceIn: '02:00:00;00', sourceOut: '02:00:10;00', recordIn: '00:10:05;00' },
    { id: '丙', sourceIn: '03:00:00;00', sourceOut: '03:00:05;00', recordIn: '00:10:20;00' }
  ]
});

// 同批片段但乙挪到 00:10:06;00：合法的新输入，用于验证旧快照决定不被沿用。
const PROVENANCE_INPUT_V2 = JSON.stringify({
  rate: '30000/1001',
  clips: [
    { id: '甲', sourceIn: '01:00:00;00', sourceOut: '01:00:10;00', recordIn: '00:10:00;00' },
    { id: '乙', sourceIn: '02:00:00;00', sourceOut: '02:00:10;00', recordIn: '00:10:06;00' }
  ]
});

function setInput(value: string) {
  fireEvent.change(screen.getByLabelText('片段 JSON 输入'), { target: { value } });
}

function buildSelection(selectionIn: string, selectionOut: string) {
  fireEvent.change(screen.getByLabelText('选区开始时码'), { target: { value: selectionIn } });
  fireEvent.change(screen.getByLabelText('选区结束时码'), { target: { value: selectionOut } });
  fireEvent.click(screen.getByRole('button', { name: '生成预演' }));
}

function readBlob(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsText(blob);
  });
}

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  // jsdom 缺少的浏览器 API 打桩。
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  Element.prototype.scrollIntoView ??= () => {};
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('page linkage acceptance', () => {
  it('highlights the source segment and every record-timeline landing point on click', () => {
    const { container } = render(<App />);
    setInput(REUSE_INPUT);

    const panel = screen.getByRole('region', { name: '来源复用审计' });
    expect(panel.textContent).toContain('共 1 段');
    expect(panel.textContent).toContain('复用 150 帧');

    // 段证据列出整数帧、时码、覆盖片段与各自录制落点。
    const segmentButton = within(panel).getByRole('button', { name: /来源帧 108042 – 108192/ });
    expect(segmentButton.textContent).toContain('01:00:05;00 → 01:00:10;00');
    expect(segmentButton.textContent).toContain('覆盖 2 片');
    expect(segmentButton.textContent).toContain('"甲"');
    expect(segmentButton.textContent).toContain('"乙"');
    expect(segmentButton.textContent).toContain('录制帧 18132 – 18282');
    expect(segmentButton.textContent).toContain('录制帧 18282 – 18432');

    // 点击前没有高亮。
    expect(container.querySelectorAll('.reuse-highlight-band')).toHaveLength(0);

    fireEvent.click(segmentButton);

    // 来源轴与证据列表同时标记选中。
    expect(segmentButton.getAttribute('aria-pressed')).toBe('true');
    expect(panel.querySelector('.reuse-axis-segment')?.className).toContain('reuse-axis-selected');

    // 录制时间线上出现全部落点：两个覆盖片段各一条高亮带。
    const bands = container.querySelectorAll('.reuse-highlight-band');
    const frames = container.querySelectorAll('.reuse-highlight-frame');
    expect(bands).toHaveLength(2);
    expect(frames).toHaveLength(2);
    // 默认缩放 0.001 px/帧，落点 x 坐标与整数帧严格对应。
    expect(parseFloat(bands[0].getAttribute('x')!)).toBeCloseTo(18132 * 0.001, 6);
    expect(parseFloat(bands[1].getAttribute('x')!)).toBeCloseTo(18282 * 0.001, 6);

    // 再次点击取消选中，高亮全部消失。
    fireEvent.click(segmentButton);
    expect(segmentButton.getAttribute('aria-pressed')).toBe('false');
    expect(container.querySelectorAll('.reuse-highlight-band')).toHaveLength(0);
  });

  it('keeps both stale views on invalid edits and atomically replaces them on new valid input', () => {
    const { container } = render(<App />);
    setInput(REUSE_INPUT);
    expect(screen.getByText('第一处真实拼接断点')).toBeTruthy();

    // 无效编辑：两套旧视图保留但标记过期，下载按钮禁用。
    setInput(INVALID_INPUT);
    expect(screen.getByText('当前结论已撤销')).toBeTruthy();
    const stalePanel = screen.getByRole('region', { name: '来源复用审计' });
    expect(stalePanel.textContent).toContain('共 1 段');
    expect(stalePanel.textContent).toContain('上次合法结果');
    expect(stalePanel.className).toContain('reuse-stale');
    expect(screen.getByText('第一处真实拼接断点')).toBeTruthy();
    expect((screen.getByRole('button', { name: '导出核对 JSON' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: '下载复用报告' }) as HTMLButtonElement).disabled).toBe(true);

    // 新有效输入：接缝视图与复用视图在同一次渲染中整体替换。
    setInput(CONTIGUOUS_INPUT);
    expect(screen.getByText('当前输入有效')).toBeTruthy();
    expect(screen.queryByText('第一处真实拼接断点')).toBeNull();
    expect(screen.getByText('所有片段按录制位置首尾相接，未发现空隙或重叠。')).toBeTruthy();
    const freshPanel = screen.getByRole('region', { name: '来源复用审计' });
    expect(freshPanel.textContent).toContain('未发现来源复用');
    expect(freshPanel.textContent).not.toContain('共 1 段');
    expect(freshPanel.className).not.toContain('reuse-stale');
    expect(container.querySelectorAll('.reuse-highlight-band')).toHaveLength(0);
  });

  it('downloads the reuse report separately from the unchanged check export', async () => {
    const createdBlobs: Blob[] = [];
    URL.createObjectURL = vi.fn((blob: Blob) => {
      createdBlobs.push(blob);
      return `blob:mock-${createdBlobs.length}`;
    });
    URL.revokeObjectURL = vi.fn();
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});

    render(<App />);
    setInput(REUSE_INPUT);

    fireEvent.click(screen.getByRole('button', { name: '导出核对 JSON' }));
    fireEvent.click(screen.getByRole('button', { name: '下载复用报告' }));
    expect(createdBlobs).toHaveLength(2);

    // 原核对导出逐项不变：没有混入任何复用字段。
    const checkExport = JSON.parse(await readBlob(createdBlobs[0])) as Record<string, unknown>;
    expect(Object.keys(checkExport).sort()).toEqual([
      'breaks',
      'clips',
      'dayFrames',
      'firstBreak',
      'rate',
      'schemaVersion'
    ]);
    expect(JSON.stringify(checkExport)).not.toContain('segments');

    // 复用报告单独成文：只含审计内容，不含接缝结论。
    const reuseExport = JSON.parse(await readBlob(createdBlobs[1])) as Record<string, unknown>;
    expect(Object.keys(reuseExport).sort()).toEqual([
      'clipCount',
      'dayFrames',
      'rate',
      'reusedFrameTotal',
      'schemaVersion',
      'segmentCount',
      'segments'
    ]);
    expect(JSON.stringify(reuseExport)).not.toContain('breaks');
    const segments = reuseExport.segments as Array<{ clipIds: string[]; coverCount: number }>;
    expect(segments).toHaveLength(1);
    expect(segments[0].clipIds).toEqual(['甲', '乙']);
    expect(segments[0].coverCount).toBe(2);
  });
});

describe('provenance delivery preview', () => {
  it('rules a conflict and exports the source manifest in record order', async () => {
    const createdBlobs: Blob[] = [];
    URL.createObjectURL = vi.fn((blob: Blob) => {
      createdBlobs.push(blob);
      return `blob:mock-${createdBlobs.length}`;
    });
    URL.revokeObjectURL = vi.fn();
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});

    const { container } = render(<App />);
    setInput(PROVENANCE_INPUT);

    const panel = screen.getByRole('region', { name: '来源交付预演' });
    const exportButton = () =>
      within(panel).getByRole('button', { name: '导出取材清单' }) as HTMLButtonElement;

    // 选区 00:10:02;00 → 00:10:15;00：唯一甲 90 帧、冲突 150 帧、唯一乙 150 帧。
    buildSelection('00:10:02;00', '00:10:15;00');
    expect(panel.textContent).toContain('共 3 段');
    expect(panel.textContent).toContain('冲突 150 帧');
    expect(panel.textContent).toContain('导出受阻：1 段冲突未裁决');
    expect(exportButton().disabled).toBe(true);

    // 分段逐段列出：唯一段直接给出原片起止帧，冲突段列出全部贡献片段。
    expect(panel.textContent).toContain('唯一来源 "甲" · 原片帧 107952 – 108042');
    expect(panel.textContent).toContain('唯一来源 "乙" · 原片帧 215934 – 216084');
    const conflictGroup = within(panel).getByRole('group', { name: '段 2 冲突裁决' });
    const choiceJia = within(conflictGroup).getByRole('button', { name: /采用 "甲"/ });
    const choiceYi = within(conflictGroup).getByRole('button', { name: /采用 "乙"/ });
    expect(choiceJia.textContent).toContain('原片帧 108042 – 108192');
    expect(choiceYi.textContent).toContain('原片帧 215784 – 215934');

    // 时间线、面板与裁决共用同一份分段结果：三段色带与选区边界一一对应。
    const bands = container.querySelectorAll('.provenance-band');
    expect(bands).toHaveLength(3);
    expect(bands[0].classList.contains('provenance-band-unique')).toBe(true);
    expect(bands[1].classList.contains('provenance-band-conflict')).toBe(true);
    expect(bands[2].classList.contains('provenance-band-unique')).toBe(true);
    // 默认缩放 0.001 px/帧，色带 x 坐标与整数帧严格对应。
    expect(parseFloat(bands[0].getAttribute('x')!)).toBeCloseTo(18042 * 0.001, 6);
    expect(parseFloat(bands[1].getAttribute('x')!)).toBeCloseTo(18132 * 0.001, 6);
    expect(parseFloat(bands[2].getAttribute('x')!)).toBeCloseTo(18282 * 0.001, 6);

    // 裁决冲突段采用甲：甲两段身份相同且原片、录制坐标均连续，导出时合并。
    fireEvent.click(choiceJia);
    expect(choiceJia.getAttribute('aria-pressed')).toBe('true');
    expect(panel.textContent).toContain('选区无空隙，冲突已全部裁决');
    expect(exportButton().disabled).toBe(false);

    fireEvent.click(exportButton());
    expect(createdBlobs).toHaveLength(1);
    const manifest = JSON.parse(await readBlob(createdBlobs[0])) as {
      schemaVersion: number;
      rate: string;
      selection: { recordStart: { frame: number }; recordEnd: { frame: number } };
      entryCount: number;
      entries: Array<{
        clipId: string;
        recordStart: { frame: number; timecode: string };
        recordEnd: { frame: number; timecode: string };
        sourceStart: { frame: number; timecode: string };
        sourceEnd: { frame: number; timecode: string };
        durationFrames: number;
      }>;
    };
    expect(manifest.schemaVersion).toBe(1);
    expect(manifest.rate).toBe('30000/1001');
    expect(manifest.selection.recordStart.frame).toBe(18042);
    expect(manifest.selection.recordEnd.frame).toBe(18432);
    expect(manifest.entryCount).toBe(2);
    // 按录制顺序：合并后的甲（240 帧）在前，乙（150 帧）在后。
    expect(manifest.entries[0]).toEqual({
      clipId: '甲',
      recordStart: { frame: 18042, timecode: '00:10:02;00' },
      recordEnd: { frame: 18282, timecode: '00:10:10;00' },
      sourceStart: { frame: 107952, timecode: '01:00:02;00' },
      sourceEnd: { frame: 108192, timecode: '01:00:10;00' },
      durationFrames: 240
    });
    expect(manifest.entries[1]).toEqual({
      clipId: '乙',
      recordStart: { frame: 18282, timecode: '00:10:10;00' },
      recordEnd: { frame: 18432, timecode: '00:10:15;00' },
      sourceStart: { frame: 215934, timecode: '02:00:05;00' },
      sourceEnd: { frame: 216084, timecode: '02:00:10;00' },
      durationFrames: 150
    });
  });

  it('keeps export blocked while any gap remains in the selection', () => {
    render(<App />);
    setInput(PROVENANCE_INPUT);

    const panel = screen.getByRole('region', { name: '来源交付预演' });
    // 选区 00:10:14;00 → 00:10:21;00：唯一乙 30 帧、空隙 150 帧、唯一丙 20 帧。
    buildSelection('00:10:14;00', '00:10:21;00');

    expect(panel.textContent).toContain('共 3 段');
    expect(panel.textContent).toContain('空隙 150 帧');
    expect(panel.textContent).toContain('该段无任何片段覆盖：来源不明，禁止猜测');
    expect(panel.textContent).toContain('导出受阻：1 段空隙');
    expect(
      (within(panel).getByRole('button', { name: '导出取材清单' }) as HTMLButtonElement).disabled
    ).toBe(true);
    // 没有冲突段：不提供任何裁决入口，空隙无法通过裁决消除。
    expect(within(panel).queryAllByRole('button', { name: /采用/ })).toHaveLength(0);
  });

  it('invalidates rulings bound to a stale snapshot and never reuses old decisions', () => {
    const { container } = render(<App />);
    setInput(PROVENANCE_INPUT);
    const panel = screen.getByRole('region', { name: '来源交付预演' });

    buildSelection('00:10:02;00', '00:10:15;00');
    fireEvent.click(within(panel).getByRole('button', { name: /采用 "甲"/ }));
    expect(panel.textContent).toContain('选区无空隙，冲突已全部裁决');
    expect(container.querySelectorAll('.provenance-band')).toHaveLength(3);

    // 非法编辑：旧预演与裁决失效，导出按钮禁用，时间线色带撤下。
    setInput(INVALID_INPUT);
    expect(screen.getByText('当前结论已撤销')).toBeTruthy();
    expect(panel.textContent).toContain('此前预演与冲突裁决全部失效');
    expect(
      (within(panel).getByRole('button', { name: '导出取材清单' }) as HTMLButtonElement).disabled
    ).toBe(true);
    expect(within(panel).queryAllByRole('button', { name: /采用/ })).toHaveLength(0);
    expect(container.querySelectorAll('.provenance-band')).toHaveLength(0);
    expect(
      (within(panel).getByRole('button', { name: '生成预演' }) as HTMLButtonElement).disabled
    ).toBe(true);

    // 新的合法输入：旧会话仍失配，失效提示保留，旧裁决不会自动套用。
    setInput(PROVENANCE_INPUT_V2);
    expect(screen.getByText('当前输入有效')).toBeTruthy();
    expect(panel.textContent).toContain('此前预演与冲突裁决全部失效');
    expect(
      (within(panel).getByRole('button', { name: '导出取材清单' }) as HTMLButtonElement).disabled
    ).toBe(true);

    // 用同样的选区重新生成：分段按新快照重算，裁决从零开始。
    fireEvent.click(within(panel).getByRole('button', { name: '生成预演' }));
    expect(panel.textContent).not.toContain('此前预演与冲突裁决全部失效');
    expect(panel.textContent).toContain('导出受阻：1 段冲突未裁决');
    const choiceJia = within(panel).getByRole('button', { name: /采用 "甲"/ });
    const choiceYi = within(panel).getByRole('button', { name: /采用 "乙"/ });
    expect(choiceJia.getAttribute('aria-pressed')).toBe('false');
    expect(choiceYi.getAttribute('aria-pressed')).toBe('false');
    expect(
      (within(panel).getByRole('button', { name: '导出取材清单' }) as HTMLButtonElement).disabled
    ).toBe(true);

    // 在新快照上重新裁决后才可以导出。
    fireEvent.click(choiceYi);
    expect(
      (within(panel).getByRole('button', { name: '导出取材清单' }) as HTMLButtonElement).disabled
    ).toBe(false);
  });
});

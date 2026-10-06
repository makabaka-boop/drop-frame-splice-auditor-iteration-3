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

function setInput(value: string) {
  fireEvent.change(screen.getByLabelText('片段 JSON 输入'), { target: { value } });
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

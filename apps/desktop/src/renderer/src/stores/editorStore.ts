import { create } from 'zustand';
import type { TransactionLog } from '@dajia/core';
import { demoHouse, type Viewport } from '@dajia/scene-2d';

// demoHouse() 只调一次。调两次拿到的是两份互不相干的文档：屏幕上画的是 B，
// 命中测试查的是 A —— 而且不会有任何报错，只会得到"点了没反应"。
const demo = demoHouse();

export interface EditorState {
  readonly log: TransactionLog;
  readonly storeyId: string;
  /** null = 还没量过窗口尺寸，一帧都还没画 */
  readonly viewport: Viewport | null;
  setViewport: (viewport: Viewport | null) => void;
}

export const useEditor = create<EditorState>((set) => ({
  log: demo.log,
  storeyId: demo.lowerStoreyId,
  viewport: null,
  setViewport: (viewport) => set({ viewport }),
}));

import { dialog, ipcMain, type BrowserWindow } from 'electron';
import { IPC, type ExportPlanResultShape } from '@dajia/protocol';
import { runExportPlan } from './export-plan-core';

/**
 * 「导出平面图」这条 IPC 的**唯一** electron 边界（与 `export-plan.ts` 的 E1 同一条纪律：
 * 那份纯函数不认识 electron，边界只住在这里）。
 *
 * 这一层只做三件事，**一件几何/图面逻辑都没有**：
 * 1. 弹保存对话框拿落盘路径（用户可以取消）；
 * 2. 取消 ⇒ 回 `{ ok:false, error:'已取消保存对话框' }`，**不**当成失败静默丢掉；
 * 3. 其余全交给 electron-free 的 `runExportPlan`。
 *
 * 为什么"取消"要单独回一句而不是回 `ok:true`：renderer 侧要把"用户主动取消"与
 * "导出炸了"分成两种 UI 反馈（前者静默、后者红字）。合流成一个 `ok:false` 的话，
 * 面板就得靠 `error` 的中文去分辨 —— 那是把可判别的布尔换成了字符串匹配。
 */
export function registerExportPlanIpc(getWindow: () => BrowserWindow | null): void {
  ipcMain.removeHandler(IPC.exportPlan);
  ipcMain.handle(IPC.exportPlan, async (_event, raw: unknown): Promise<ExportPlanResultShape> => {
    const win = getWindow();
    // 模态对话框挂在窗口上，父窗口没了就退化成独立对话框（不传第一参）。
    const picked = win === null
      ? await dialog.showSaveDialog({ title: '导出平面图' })
      : await dialog.showSaveDialog(win, { title: '导出平面图' });
    if (picked.canceled || picked.filePath === undefined || picked.filePath === '') {
      return { ok: false, error: '已取消保存对话框' };
    }
    return runExportPlan(raw, picked.filePath);
  });
}

/**
 * 界面缩放：调整 html 根字号（rem 基准），窗口大小不变，
 * 文本/按钮等 rem 单位元素随缩放响应式变化（内容自适应换行/撑开）。
 * 快捷键（Ctrl+±/0）、标题栏控件、设置面板共用同一套持久化与事件。
 */
import { useEffect, useState } from "react";

export const ZOOM_KEY = "aiwb:zoom";
export const ZOOM_MIN = 0.7;
export const ZOOM_MAX = 1.6;
export const ZOOM_STEP = 0.1;
export const ZOOM_DEFAULT = 1;
/** 根字号基准（px），与 styles.css 的 rem 基准一致 */
export const BASE_FONT = 14;

export function loadZoom(): number {
  try {
    const v = parseFloat(localStorage.getItem(ZOOM_KEY) ?? "");
    if (Number.isFinite(v) && v >= ZOOM_MIN && v <= ZOOM_MAX) {
      return Math.round(v * 10) / 10;
    }
  } catch {
    /* ignore */
  }
  return ZOOM_DEFAULT;
}

const clamp = (v: number) => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, v));

/** 应用缩放级别（改 html 根字号），返回实际生效值；persist=false 用于启动恢复（不写回）。 */
export function applyZoom(level: number, persist = true): number {
  const v = Math.round(clamp(level) * 10) / 10;
  document.documentElement.style.fontSize = `${BASE_FONT * v}px`;
  if (persist) {
    try {
      localStorage.setItem(ZOOM_KEY, String(v));
    } catch {
      /* ignore */
    }
  }
  // 通知各处 UI（标题栏/设置）刷新百分比显示
  window.dispatchEvent(new CustomEvent("pi:zoom-changed", { detail: v }));
  return v;
}

export function zoomIn(): number {
  return applyZoom(loadZoom() + ZOOM_STEP);
}
export function zoomOut(): number {
  return applyZoom(loadZoom() - ZOOM_STEP);
}
export function zoomReset(): number {
  return applyZoom(ZOOM_DEFAULT);
}

/** 订阅缩放级别（标题栏/设置控件显示当前百分比）。 */
export function useZoomLevel(): number {
  const [level, setLevel] = useState<number>(loadZoom);
  useEffect(() => {
    const onChange = (e: Event) => setLevel((e as CustomEvent).detail ?? loadZoom());
    window.addEventListener("pi:zoom-changed", onChange);
    return () => window.removeEventListener("pi:zoom-changed", onChange);
  }, []);
  return level;
}

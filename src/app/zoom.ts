/**
 * 界面缩放（整体 zoom）：调整整页显示比例。
 * 快捷键（Ctrl+±/0）、标题栏控件、设置面板共用同一套持久化与事件。
 * 使用 CSS zoom 作用于整页，正文与布局一并缩放（WebView2/Chromium）。
 */
import { useEffect, useState } from "react";

export const ZOOM_KEY = "aiwb:zoom";
export const ZOOM_MIN = 0.7;
export const ZOOM_MAX = 1.6;
export const ZOOM_STEP = 0.1;
export const ZOOM_DEFAULT = 1;

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

/** 应用缩放级别到整页，返回实际生效值；persist=false 用于启动恢复（不写回）。 */
export function applyZoom(level: number, persist = true): number {
  const v = Math.round(clamp(level) * 10) / 10;
  const body = document.body as HTMLElement & { zoom?: string };
  body.zoom = String(v);
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

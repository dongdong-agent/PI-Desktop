/**
 * 主题管理（皮肤系统）：多主题注册表 + 读写 localStorage + 应用到根节点。
 * 皮肤 = 一套 CSS 变量集合；换肤即换 data-theme，业务样式全部走变量。
 */
export type ThemeName = "light" | "dark" | "warm" | "mint" | "deep" | "forest" | "ocean";

export interface ThemeMeta {
  id: ThemeName;
  label: string;
  hint: string;
}

/** 主题注册表（皮肤系统的扩展面：新增皮肤 = 在 CSS 加一套变量 + 在此登记） */
export const THEMES: ThemeMeta[] = [
  { id: "light", label: "☀️ 浅色", hint: "清爽明亮" },
  { id: "dark", label: "🌙 深色", hint: "沉浸护眼" },
  { id: "warm", label: "🕯️ 暖阳", hint: "暖调低刺激" },
  { id: "mint", label: "🌿 薄荷", hint: "清冷绿意" },
  { id: "deep", label: "🔮 午夜紫", hint: "神秘深邃" },
  { id: "forest", label: "🌲 森林", hint: "自然清新" },
  { id: "ocean", label: "🌊 海洋", hint: "宁静清爽" },
];

const KEY = "aiwb:theme";

export function loadTheme(): ThemeName {
  try {
    const v = localStorage.getItem(KEY) as ThemeName | null;
    if (v && THEMES.some((t) => t.id === v)) return v;
  } catch {
    /* ignore */
  }
  return "light";
}

export function applyTheme(theme: ThemeName, persist = true): void {
  document.documentElement.dataset.theme = theme;
  if (persist) {
    try {
      localStorage.setItem(KEY, theme);
    } catch {
      /* ignore */
    }
  }
}

/** 切换主题（循环） */
export function nextTheme(current: ThemeName): ThemeName {
  const idx = THEMES.findIndex((t) => t.id === current);
  const next = THEMES[(idx + 1) % THEMES.length].id;
  applyTheme(next);
  return next;
}
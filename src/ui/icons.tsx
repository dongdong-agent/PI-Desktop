/**
 * 低调线性图标集（stroke = currentColor，颜色随父元素 text/color 变化）。
 * 仅描边、无填充、单色 —— 用于替换界面里的彩色 emoji，保持统一低调风格。
 */
interface IconProps {
  size?: number;
}

const base = (size: number) => ({
  width: size,
  height: size,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.6,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  "aria-hidden": true,
});

export function PinIcon({ size = 13 }: IconProps) {
  return (
    <svg {...base(size)}>
      <path d="M12 17v5" />
      <path d="M9 3.5h6v3.6a3.4 3.4 0 0 0 3.4 3.4H19v2H5v-2h.6A3.4 3.4 0 0 0 9 7.1V3.5z" />
    </svg>
  );
}

export function BubbleIcon({ size = 13 }: IconProps) {
  return (
    <svg {...base(size)}>
      <path d="M4 5.5h16v11H9l-5 4v-15z" />
    </svg>
  );
}

export function PencilIcon({ size = 13 }: IconProps) {
  return (
    <svg {...base(size)}>
      <path d="M17.5 3.5l3 3L8 19l-4.5 1 1-4.5z" />
      <path d="M15 6l3 3" />
    </svg>
  );
}

export function LinkIcon({ size = 13 }: IconProps) {
  return (
    <svg {...base(size)}>
      <path d="M10 13.2a5 5 0 0 0 7 0l3-3.1a5 5 0 0 0-7.1-7L12 4.1" />
      <path d="M14 10.8a5 5 0 0 0-7 0l-3 3.1a5 5 0 0 0 7.1 7L12 19.9" />
    </svg>
  );
}

export function PlusIcon({ size = 13 }: IconProps) {
  return (
    <svg {...base(size)}>
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

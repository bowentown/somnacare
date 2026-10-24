import React from 'react';

/**
 * 统一开关（第 81 轮视觉审查）：此前 12 处手搓开关有 4 种几何尺寸
 * （w-10×h-5 / w-11×h-6 / w-12×h-6）和两种滑块行程（18px / 22px），
 * 同屏相邻卡片肉眼可见不一致。统一为 w-10×h-5 轨道 + w-4 滑块 +
 * 2/22px 行程 + 单一关闭色（slate-600）；开启色随语义传入。
 * 保持原生 checkbox（role=checkbox），e2e 的 getByRole('checkbox') 兼容。
 */
export const Switch: React.FC<{
  checked: boolean;
  onChange: (next: boolean) => void;
  ariaLabel: string;
  /** 开启态轨道色（语义色，如 bg-indigo-500 / bg-sky-500 / bg-amber-500） */
  onClass?: string;
  disabled?: boolean;
  className?: string;
}> = ({ checked, onChange, ariaLabel, onClass = 'bg-indigo-500', disabled = false, className = '' }) => (
  <label
    className={`relative inline-flex items-center shrink-0 ${
      disabled ? 'opacity-50 pointer-events-none' : 'cursor-pointer'
    } ${className}`}
  >
    <input
      type="checkbox"
      aria-label={ariaLabel}
      checked={checked}
      disabled={disabled}
      onChange={(e) => onChange(e.target.checked)}
      className="sr-only peer"
    />
    <div className={`relative w-10 h-5 rounded-full transition-colors ${checked ? onClass : 'bg-slate-600'}`}>
      <span
        className="absolute top-0.5 w-4 h-4 bg-white rounded-full shadow transition-all"
        style={{ left: checked ? '22px' : '2px' }}
      />
    </div>
  </label>
);

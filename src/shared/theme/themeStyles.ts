export type ThemeMode = 'midnight' | 'pure_dark' | 'warm_amber' | 'serene_blue';

export interface ThemeConfig {
  id: ThemeMode;
  name: string;
  tag: string;
  desc: string;
  // App container
  pageBg: string;
  textPrimary: string;
  textSecondary: string;
  textMuted: string;
  // Card styling
  cardBg: string;
  cardBorder: string;
  cardInnerBg: string;
  cardInnerBorder: string;
  /** 文本选中高亮（Tailwind selection: 类） */
  selectionBg: string;
  /** 强调色边框类（border- 前缀完整类） */
  accentBorder: string;
  // Highlights & accents
  accentColor: string;
  accentBg: string;
  /** accentBg 上的前景色：深底配浅字、浅底配深字。调用处禁止硬编码 text-white */
  accentFg: string;
  accentText: string;
  accentRing: string;
  /** 原始十六进制强调色：供 SVG 描边、图表与氛围光等内联样式使用 */
  accentHex: string;
  /** 键盘焦点样式（完整字面量）：拼接的 focus:${accentBorder} 不会被 Tailwind 生成 */
  focusRing: string;
  // Nav bar
  navBg: string;
  navBorder: string;
  navActiveBg: string;
  navActiveText: string;
  navInactiveText: string;
  // Preview
  dot: string;
}

export const APP_THEMES: Record<ThemeMode, ThemeConfig> = {
  midnight: {
    id: 'midnight',
    name: '极光午夜',
    tag: '深邃经典',
    desc: '群青暗夜底 · 晶白与天青卡片 · 靛蓝高亮',
    pageBg: 'bg-[#090d1a]',
    textPrimary: 'text-white',
    textSecondary: 'text-slate-200',
    textMuted: 'text-slate-400',
    cardBg: 'bg-gradient-to-b from-[#1a2338] to-[#121a2c]',
    cardBorder: 'border-slate-700/80',
    cardInnerBg: 'bg-[#0c1222]',
    cardInnerBorder: 'border-slate-800',
    accentColor: 'indigo-500',
    accentBg: 'bg-indigo-600 hover:bg-indigo-700',
    accentFg: 'text-white',
    accentText: 'text-indigo-400',
    accentRing: 'ring-indigo-400',
    accentHex: '#818cf8',
    focusRing: 'focus-visible:ring-2 focus-visible:ring-indigo-400',
    selectionBg: 'selection:bg-indigo-500/30',
    accentBorder: 'border-indigo-400',
    navBg: 'bg-[#0f172a]',
    navBorder: 'border-slate-800',
    navActiveBg: 'bg-indigo-600/25',
    navActiveText: 'text-indigo-400',
    navInactiveText: 'text-slate-400',
    dot: 'bg-indigo-400',
  },
  pure_dark: {
    id: 'pure_dark',
    name: '深空纯黑 (OLED)',
    tag: '极致对比与省电',
    desc: '100%纯黑黑底 · 石墨黑实心卡片 · 锐利白字',
    pageBg: 'bg-[#000000]',
    textPrimary: 'text-white',
    textSecondary: 'text-zinc-200',
    textMuted: 'text-zinc-400',
    cardBg: 'bg-gradient-to-b from-[#19191d] to-[#101012]',
    cardBorder: 'border-zinc-800',
    cardInnerBg: 'bg-[#08080a]',
    cardInnerBorder: 'border-zinc-800',
    accentColor: 'indigo-500',
    accentBg: 'bg-zinc-800 hover:bg-zinc-700',
    accentFg: 'text-white',
    accentText: 'text-zinc-200',
    accentRing: 'ring-zinc-500',
    accentHex: '#d4d4d8',
    focusRing: 'focus-visible:ring-2 focus-visible:ring-zinc-500',
    selectionBg: 'selection:bg-zinc-500/30',
    accentBorder: 'border-zinc-500',
    navBg: 'bg-[#000000]',
    navBorder: 'border-zinc-800',
    navActiveBg: 'bg-zinc-800/80',
    navActiveText: 'text-white',
    navInactiveText: 'text-zinc-500',
    dot: 'bg-zinc-200',
  },
  warm_amber: {
    id: 'warm_amber',
    name: '琥珀暖夜 (助眠)',
    tag: '褪黑素保护',
    desc: '深茶原木底 · 暖赭实心卡片 · 柔金色字符',
    pageBg: 'bg-[#18110b]',
    textPrimary: 'text-amber-50',
    textSecondary: 'text-amber-200',
    textMuted: 'text-amber-300/70',
    cardBg: 'bg-gradient-to-b from-[#2d2117] to-[#221911]',
    cardBorder: 'border-amber-900/60',
    cardInnerBg: 'bg-[#2b1f13]',
    cardInnerBorder: 'border-amber-900/70',
    accentColor: 'amber-500',
    accentBg: 'bg-amber-600 hover:bg-amber-500',
    accentFg: 'text-slate-950',
    accentText: 'text-amber-300',
    accentRing: 'ring-amber-400',
    accentHex: '#fcd34d',
    focusRing: 'focus-visible:ring-2 focus-visible:ring-amber-400',
    selectionBg: 'selection:bg-amber-500/30',
    accentBorder: 'border-amber-400',
    navBg: 'bg-[#1f1610]',
    navBorder: 'border-amber-950',
    navActiveBg: 'bg-amber-600/30',
    navActiveText: 'text-amber-300',
    navInactiveText: 'text-amber-400/60',
    dot: 'bg-amber-400',
  },
  serene_blue: {
    id: 'serene_blue',
    name: '静谧深海 (舒缓)',
    tag: '平静安神',
    desc: '墨绿海渊底 · 藏青色实心卡片 · 冰川青高光',
    pageBg: 'bg-[#061320]',
    textPrimary: 'text-cyan-50',
    textSecondary: 'text-cyan-200',
    textMuted: 'text-cyan-300/70',
    cardBg: 'bg-gradient-to-b from-[#102b46] to-[#0a1d31]',
    cardBorder: 'border-cyan-900/60',
    cardInnerBg: 'bg-[#102a42]',
    cardInnerBorder: 'border-cyan-900/70',
    accentColor: 'cyan-400',
    accentBg: 'bg-cyan-600 hover:bg-cyan-500',
    accentFg: 'text-slate-950',
    accentText: 'text-cyan-300',
    accentRing: 'ring-cyan-400',
    accentHex: '#67e8f9',
    focusRing: 'focus-visible:ring-2 focus-visible:ring-cyan-400',
    selectionBg: 'selection:bg-cyan-500/30',
    accentBorder: 'border-cyan-400',
    navBg: 'bg-[#07192b]',
    navBorder: 'border-cyan-950',
    navActiveBg: 'bg-cyan-600/30',
    navActiveText: 'text-cyan-300',
    navInactiveText: 'text-cyan-400/60',
    dot: 'bg-cyan-400',
  },
};

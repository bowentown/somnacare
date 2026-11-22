/**
 * 科学建议作息（第 114 轮）：把个人睡眠需求 + MSFsc 时型转成可直接采用的
 * 目标作息——"算出来的科学"第一次驱动行为，而不只是上墙展示。
 *
 * 锚定规则：
 * - MSFsc 有值：就寝 = MSFsc − 需求/2（MSFsc 是无社会义务下的睡眠中点，
 *   向两侧各推一半需求），跨午夜规整并钳制 21:00–01:00 合理就寝域；
 * - MSFsc 不可用（自由日/工作日样本不足）：保持现就寝，按需求推起床；
 * - 需求与就寝全程对齐半小时档（与作息目标编辑器 0.5h 步长一致）；
 * - 与当前目标完全一致 → null：不制造假建议，按钮不出现。
 */
export interface ScheduleSuggestion {
  bed: string;          // 'HH:MM'
  wake: string;
  durationHours: number;
  basis: 'msf' | 'need';   // 建议依据：MSFsc 时型锚定 / 现就寝 + 个人需求
}

const round30 = (m: number): number => Math.round(m / 30) * 30;
const norm = (m: number): number => ((m % 1440) + 1440) % 1440;
const toClock = (m: number): string =>
  `${String(Math.floor(norm(m) / 60)).padStart(2, '0')}:${String(norm(m) % 60).padStart(2, '0')}`;

export function computeSuggestedSchedule(
  needMinutes: number,
  msfMinutes: number | null,
  current: { bed: string; wake: string; durationHours: number },
): ScheduleSuggestion | null {
  // 与目标编辑器 4–12h 同域，再对齐半小时档
  const need = Math.max(240, Math.min(720, round30(Math.round(needMinutes))));
  const [cbH, cbM] = current.bed.split(':').map(Number);
  const [cwH, cwM] = current.wake.split(':').map(Number);
  const curBed = Number.isFinite(cbH) && Number.isFinite(cbM) ? norm(cbH * 60 + cbM) : 1380;   // 缺省 23:00
  const curWake = Number.isFinite(cwH) && Number.isFinite(cwM) ? norm(cwH * 60 + cwM) : 420;   // 缺省 07:00

  let bedMin: number;
  let basis: 'msf' | 'need';
  if (msfMinutes !== null && Number.isFinite(msfMinutes)) {
    bedMin = norm(msfMinutes - need / 2);
    // 合理就寝域 21:00–01:00（跨午夜）：域外按侧钳制——白天侧回 21:00，深夜侧压到 01:00
    if (bedMin > 60 && bedMin < 1260) {
      bedMin = bedMin < 660 ? 60 : 1260;   // 钳到更近的域边（660 = 60/1260 中点）
    }
    basis = 'msf';
  } else {
    bedMin = curBed;
    basis = 'need';
  }
  const wakeMin = norm(bedMin + need);
  const durationHours = need / 60;
  const bed = toClock(bedMin);
  const wake = toClock(wakeMin);

  // 与当前完全一致 → 不制造假建议
  if (bed === current.bed && wake === current.wake && Math.abs(durationHours - current.durationHours) < 0.01) {
    return null;
  }
  return { bed, wake, durationHours, basis };
}

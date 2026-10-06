/**
 * 真实月相计算与 SVG 路径生成（纯三角函数，无资源依赖）。
 * 基准：2000-01-06 18:14 UTC 新月；朔望月 29.530588853 天。
 */

const SYNODIC = 29.530588853;
const NEW_MOON_EPOCH_DAYS = Date.UTC(2000, 0, 6, 18, 14) / 86400000;

export interface MoonInfo {
  /** 月龄（天，0=新月，14.77=满月） */
  age: number;
  /** 被照亮比例 0..1 */
  illumination: number;
  /** 是否盈月（新月→满月之间） */
  waxing: boolean;
  /** 八相名称 */
  phaseName: string;
}

export function getMoonInfo(date: Date = new Date()): MoonInfo {
  let age = (date.getTime() / 86400000 - NEW_MOON_EPOCH_DAYS) % SYNODIC;
  if (age < 0) age += SYNODIC;
  const phase = age / SYNODIC; // 0=新月 0.25=上弦 0.5=满月 0.75=下弦
  const illumination = (1 - Math.cos(2 * Math.PI * phase)) / 2;
  const waxing = phase < 0.5;
  const names = ['新月', '娥眉月', '上弦月', '盈凸月', '满月', '亏凸月', '下弦月', '残月'];
  const nameIdx = Math.round(phase * 8) % 8;
  return { age, illumination, waxing, phaseName: names[nameIdx] };
}


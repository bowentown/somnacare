import { useEffect, useState } from 'react';
import { isGestureLive } from '../utils/gestureGate';

/**
 * 分钟时钟（第 129 轮）：全应用共享【单一】60s 定时器。
 *
 * 此前 TodayTab / OneTapSleepTracker / PondCard / EyeCareTab 各挂一个
 * setInterval——四份定时器各自触发四处整块重渲染，且卸载依赖各自的清理。
 * 现在只保留一个模块级 interval，订阅者收到同一个分钟滴答；最后一个订阅
 * 者退出即清定时器（页面空闲零唤醒）。
 *
 * 返回值 = 当前分钟的 Date（每 60s 换新对象）——调用方直接消费，
 * 不各自 new Date()。测试用假时钟（clock.install）照常驱动 setInterval。
 *
 * 手势让路（第 131 轮）：五分区拖拽进行中（isGestureLive）跳过本次通知——
 * 60s 的整分区重渲染脉冲撞进跟手帧必卡一拍。分钟值按绝对时间重算，
 * 跳过的这一拍由下一拍自然补齐（无漂移），定时器本身不停。
 */
type Sub = () => void;
const subs = new Set<Sub>();
let timer: ReturnType<typeof setInterval> | null = null;

function ensureTimer(): void {
  if (timer !== null) return;
  timer = setInterval(() => {
    if (isGestureLive()) return; // 拖拽帧让路，下一拍按真实分钟补上
    for (const fn of subs) fn();
  }, 60_000);
}

function maybeStopTimer(): void {
  if (subs.size === 0 && timer !== null) {
    clearInterval(timer);
    timer = null;
  }
}

const minuteOf = (): number => Math.floor(Date.now() / 60_000);

export function useMinuteTick(): Date {
  const [minute, setMinute] = useState(minuteOf);
  useEffect(() => {
    const sub: Sub = () => setMinute(minuteOf());
    subs.add(sub);
    ensureTimer();
    // 挂载即对齐一次：跨分钟边界挂载（如 12:00:59 → 12:01）不留旧值
    sub();
    return () => {
      subs.delete(sub);
      maybeStopTimer();
    };
  }, []);
  return new Date(minute * 60_000);
}

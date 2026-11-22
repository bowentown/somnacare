/**
 * 睡前习惯共享清单：手动补录（ManualLogModal，带图标）与整夜收尾
 * （ActiveSleepModal，纯文字 chips）共用同一份 id/label，避免两处漂移。
 * id 会写入 SleepRecord.preSleepHabits 并被临床引擎的关联分析消费，
 * 改名前先查 clinicalSleepEngine.ts 里的引用。
 */
export const HABIT_OPTIONS: { id: string; label: string }[] = [
  { id: 'screen_time', label: '睡前玩手机' },
  { id: 'caffeine', label: '下午喝咖啡/茶' },
  { id: 'hot_bath', label: '睡前温水澡' },
  { id: 'meditation', label: '冥想/腹式呼吸' },
  { id: 'reading', label: '纸质书阅读' },
  { id: 'workout', label: '晚间运动' },
  { id: 'alcohol', label: '睡前饮酒' },
  { id: 'heavy_meal', label: '夜宵饱腹' },
];

import { SleepRecord, SleepAnalysisResult, UserProfile } from '../types/sleep';

/**
 * 极光睡眠 (SomnaCare) 厚实规则与临床对话引擎 (Phase 0 深度增强版)
 *
 * 特性：
 * 1. 严格危机安全护栏：无条件拦截自伤、极端绝望、药物处方风险；
 * 2. 深度意图识别分类：深度睡眠、早醒失眠、咖啡因腺苷代谢、节律紊乱、噩梦情绪、睡眠限制(CBT-I)；
 * 3. 动态生理数据插值：将昨夜真实深睡比例、就寝点、时型(Chronotype)、睡眠债务结合推断；
 * 4. 0MB 本地零成本秒级响应，无需任何网络。
 */

// 危机关键词拦截表（严禁绕过，优先输出救助热线与医疗建议）
const CRISIS_KEYWORDS = [
  '想死',
  '自杀',
  '不想活',
  '活着没意思',
  '自残',
  '自伤',
  '割腕',
  '轻生',
  '跳楼',
  '绝望到极点',
  '安眠药吃多少会死',
  '吞安眠药',
];

// 处方药物问询拦截表（严禁提供药物剂量或开药指引）
const DRUG_KEYWORDS = [
  '安眠药吃几颗',
  '阿普唑仑剂量',
  '佐匹克隆怎么吃',
  '地西泮推荐',
  '开点药',
  '推荐处方药',
  '艾司唑仑吃多少',
];

export interface IntentResult {
  category:
    | 'crisis'
    | 'drug_inquiry'
    | 'deep_sleep'
    | 'sleep_latency'
    | 'night_awakening'
    | 'early_awakening'
    | 'caffeine_lifestyle'
    | 'dreams_anxiety'
    | 'circadian_shift'
    | 'nap_recovery'
    | 'detection_principles'
    | 'general_advice';
  matchedKeywords: string[];
}

export function classifyIntent(text: string): IntentResult {
  const lower = text.toLowerCase();

  // 1. 危机检测最高优先级
  for (const kw of CRISIS_KEYWORDS) {
    if (lower.includes(kw)) {
      return { category: 'crisis', matchedKeywords: [kw] };
    }
  }

  // 2. 处方药限制
  for (const kw of DRUG_KEYWORDS) {
    if (lower.includes(kw)) {
      return { category: 'drug_inquiry', matchedKeywords: [kw] };
    }
  }

  // 3. 常见睡眠意图路由
  if (lower.includes('深睡') || lower.includes('慢波') || lower.includes('深度睡眠') || lower.includes('恢复体力')) {
    return { category: 'deep_sleep', matchedKeywords: ['深睡'] };
  }

  if (
    lower.includes('睡不着') ||
    lower.includes('入睡困难') ||
    lower.includes('翻来覆去') ||
    lower.includes('躺很久') ||
    lower.includes('失眠')
  ) {
    return { category: 'sleep_latency', matchedKeywords: ['入睡困难'] };
  }

  if (
    lower.includes('半夜醒') ||
    lower.includes('醒来好几次') ||
    lower.includes('容易醒') ||
    lower.includes('夜间易醒') ||
    lower.includes('易醒') ||
    lower.includes('夜醒') ||
    lower.includes('起夜')
  ) {
    return { category: 'night_awakening', matchedKeywords: ['夜醒', '夜间易醒', '半夜醒', '半夜容易醒', '夜间醒来'] };
  }

  if (lower.includes('早醒') || lower.includes('凌晨三点') || lower.includes('凌晨四点') || lower.includes('再也睡不着')) {
    return { category: 'early_awakening', matchedKeywords: ['早醒'] };
  }

  if (
    lower.includes('咖啡') ||
    lower.includes('奶茶') ||
    lower.includes('浓茶') ||
    lower.includes('抽烟') ||
    lower.includes('喝酒') ||
    lower.includes('夜宵')
  ) {
    return { category: 'caffeine_lifestyle', matchedKeywords: ['生活习惯'] };
  }

  if (lower.includes('做梦') || lower.includes('噩梦') || lower.includes('心慌') || lower.includes('焦虑') || lower.includes('压力大')) {
    return { category: 'dreams_anxiety', matchedKeywords: ['梦境与焦虑'] };
  }

  if (
    lower.includes('熬夜') ||
    lower.includes('倒时差') ||
    lower.includes('生物钟') ||
    lower.includes('晚睡') ||
    lower.includes('通宵') ||
    lower.includes('昼夜')
  ) {
    return { category: 'circadian_shift', matchedKeywords: ['昼夜节律'] };
  }

  if (lower.includes('午睡') || lower.includes('打盹') || lower.includes('小憩') || lower.includes('下午困')) {
    return { category: 'nap_recovery', matchedKeywords: ['午间小憩'] };
  }

  if (
    lower.includes('原理') ||
    lower.includes('怎么测') ||
    lower.includes('打呼噜') ||
    lower.includes('脑电') ||
    lower.includes('准确')
  ) {
    return { category: 'detection_principles', matchedKeywords: ['检测原理'] };
  }

  return { category: 'general_advice', matchedKeywords: [] };
}

/**
 * 完整睡眠分析报告（规则推导）
 */
export function generateLocalClinicalAnalysis(
  recentLogs: SleepRecord[] = [],
  userProfile?: UserProfile
): SleepAnalysisResult {
  const count = recentLogs.length;
  const avgDuration =
    count > 0
      ? Math.round(recentLogs.reduce((acc, r) => acc + (r.durationMinutes || 0), 0) / count)
      : 450;
  const avgDeep =
    count > 0
      ? Math.round(recentLogs.reduce((acc, r) => acc + (r.deepSleepMinutes || 0), 0) / count)
      : 95;
  const avgRem =
    count > 0
      ? Math.round(recentLogs.reduce((acc, r) => acc + (r.remSleepMinutes || 0), 0) / count)
      : 90;
  const avgScore =
    count > 0
      ? Math.round(recentLogs.reduce((acc, r) => acc + (r.sleepScore || 0), 0) / count)
      : 82;
  const avgEfficiency =
    count > 0
      ? Math.round(recentLogs.reduce((acc, r) => acc + (r.sleepEfficiency || 0), 0) / count)
      : 88;
  const avgLatency =
    count > 0
      ? Math.round(recentLogs.reduce((acc, r) => acc + (r.latencyMinutes ?? 15), 0) / count)
      : 16;
  const avgWake =
    count > 0
      ? (recentLogs.reduce((acc, r) => acc + (r.wakeCount || 0), 0) / count).toFixed(1)
      : '1.0';

  const deepPct = avgDuration > 0 ? Math.round((avgDeep / avgDuration) * 100) : 21;
  const remPct = avgDuration > 0 ? Math.round((avgRem / avgDuration) * 100) : 20;

  // 1. 推断昼夜节律时型 (Chronotype)
  let chronotype = '平衡蜂鸟型 (Hummingbird Chronotype)';
  let chronotypeDesc =
    '您的昼夜生物钟具备良好的弹性与适应力，体内皮质醇与褪黑素节律平稳。维持固定作息即可巩固深睡波峰。';

  if (recentLogs[0]?.bedtime) {
    const [h] = recentLogs[0].bedtime.split(':').map(Number);
    if (h >= 21 && h < 23) {
      chronotype = '晨型云雀型 (Lark Chronotype)';
      chronotypeDesc =
        '天生具备早睡早起节律，清晨皮质醇迅速攀升，前一日深度睡眠启动早，适宜早间高专注度工作。';
    } else if (h >= 23 || h < 6) {
      chronotype = '夜型猫头鹰型 (Owl Chronotype)';
      chronotypeDesc =
        '褪黑素分泌峰值较常规推迟1-2小时，晚间思维活跃。建议睡前调暗卧室照度，避免强光抑制入眠。';
    }
  }

  // 2. 评定健康等级
  let healthGrade = '良好 A';
  if (avgScore >= 88) healthGrade = '优良 A+';
  else if (avgScore >= 75) healthGrade = '良好 A';
  else if (avgScore >= 65) healthGrade = '亚健康 B';
  else healthGrade = '需调理 C';
  // 单晚方差很大：不足 3 晚就下"总体处于 X 水平"的结论是统计上的过度自信
  // （第 40 轮真机截图实测：1 晚即评 A+ 且无任何样本量提示）
  // healthGrade 是数据字段，保持干净（不含展示用免责声明）——样本量提示
  // 只拼进 scoreSummary 展示串的句尾（第 41 轮勘误：拼进 grade 会得到
  // "…仅供参考）水平。"的截断句，且污染与云端路径不一致的数据形状）
  const sampleNote = count >= 3 ? '' : `（仅 ${count} 晚，样本不足，仅供参考）`;

  // 3. 提取睡前行为阻碍
  const allHabits = new Set<string>();
  recentLogs.forEach((r) => {
    (r.preSleepHabits || []).forEach((h) => allHabits.add(h));
  });

  const issues: string[] = [];
  if (allHabits.has('screen_time')) {
    issues.push('睡前屏幕蓝光刺激视黑素受体，延迟褪黑素自然分泌约30-45分钟');
  }
  if (allHabits.has('caffeine')) {
    issues.push('午后摄入咖啡因阻断腺苷受体清除，削弱夜间蓄积的睡眠压力（Sleep Drive）');
  }
  if (Number(avgWake) > 1.2) {
    issues.push(`夜间平均觉醒 ${avgWake} 次，截断慢波深睡（N3）的周期连续性`);
  }
  if (avgLatency > 22) {
    issues.push('入睡潜伏期偏长（超20分钟），表明睡前交感神经过度兴奋未能顺利切换');
  }
  if (issues.length === 0) {
    issues.push('作息节律相对稳定，保持良好起卧规律即可');
  }

  const hours = (avgDuration / 60).toFixed(1);
  const targetH = userProfile?.targetDurationHours || 8;
  const debt = (targetH - Number(hours)).toFixed(1);

  return {
    chronotype,
    chronotypeDescription: chronotypeDesc,
    overallHealthGrade: healthGrade,
    scoreSummary:
      count > 0
        ? `近${count}天平均睡眠${hours}小时，深睡率${deepPct}%，总体处于${healthGrade}水平${sampleNote}。`
        : '您还没有睡眠记录——以下为演示口径的示例报告，记录一晚后将自动换成真实数据。',
    clinicalMetricsAnalysis: {
      durationAssessment: `周期平均睡眠时长为 ${hours} 小时（目标 ${targetH} 小时），睡眠债务差额约 ${debt} 小时。总体时长${
        Math.abs(Number(debt)) <= 0.5
          ? '充足合理，利于神经元代谢更新与体力修复'
          : Number(debt) > 0
          ? '低于目标，建议逐步提前就寝、周末避免报复性补觉以免打乱时相'
          : '长于目标——过长与过短同样关联更差结局，可适度压缩卧床窗口以提升睡眠密度'
      }。`,
      deepSleepAssessment: `深睡眠（慢波期N3）平均达 ${avgDeep} 分钟，占总睡眠比 ${deepPct}%（临床推荐健康值为 15%-25%）。脑脊液在此阶段高效冲洗代谢废物，对体力与免疫力恢复至关重要。`,
      remSleepAssessment: `快速眼动期(REM)平均 ${avgRem} 分钟，占比 ${remPct}%（参考健康值为 20%-25%）。此阶段脑电活跃，主导白天情绪消磁、记忆长时存储与神经回路重塑。`,
      efficiencyAssessment: `睡眠效率为 ${avgEfficiency}%（临床优良阈值 >85%）${
        avgEfficiency >= 85
          ? `，处于优良区间，夜间平均 ${avgWake} 次微觉醒在良性生理范围内。`
          : avgEfficiency >= 75
          ? `，还有提升空间，夜间平均 ${avgWake} 次微觉醒偏多，可试着压缩卧床总窗。`
          : `，明显偏低。在床时间远超实际睡眠，建议按睡眠限制疗法压缩卧床窗口，夜间 ${avgWake} 次微觉醒也需关注。`
      }`,
      sleepLatencyAssessment: `平均入睡潜伏期为 ${avgLatency} 分钟（健康参考 10-20 分钟）${
        avgLatency <= 20
          ? '，反映睡前神经松弛机制运行顺畅。'
          : avgLatency <= 30
          ? '，略长于健康区间，可尝试刺激控制法（困了再上床）。'
          : '，明显偏长。这是失眠的核心信号之一，建议严格执行 20 分钟刺激控制。'
      }`,
    },
    identifiedIssues: issues,
    personalizedRecommendations: [
      {
        timeWindow: '白天 / 午后 (07:00 - 15:00)',
        action: '晨间自然日光浴与午后咖啡因阻断',
        detail:
          '晨起30分钟内接触15-20分钟户外阳光，抑制残留褪黑素并校准视交叉上核生物钟；设定下午14:00为咖啡因硬截止时间。',
        impact: '增强夜间自然睡眠驱动力，缩短入睡潜伏期约10分钟',
      },
      {
        timeWindow: '睡前减速期 (21:30 - 22:45)',
        action: '40℃温水沐浴与4-7-8神经降噪呼吸',
        detail:
          '睡前1小时温水洗澡使外周血管舒张、核心体温快速下降；在床上配合APP内4-7-8呼吸引导完成3-4轮，激活迷走神经。',
        impact: '促进深睡眠启动，预计提升深睡占比15-20分钟',
      },
      {
        timeWindow: '夜间睡眠微气候调控',
        action: '卧室控温与白噪音掩蔽',
        detail:
          '保持室温在19-21℃、湿度50%-60%，遮挡所有LED光源；枕边可微量播放APP内深海潮汐或Theta脑波助眠曲。',
        impact: '减少后半夜翻身微觉醒，维持深睡眠连续性',
      },
    ],
    mindsetAffirmation:
      '允许思绪如云朵般悄然飘过，黑夜是身体自我修复的神圣时刻，今晚您将拥有一场深沉安稳的修复之旅。',
  };
}


/**
 * 个性化洞察（Sleep Cycle/Welltory 式数据关联分析）：
 * 从用户自己的记录里挖掘"什么在影响你的睡眠"——就寝漂移、深睡趋势、
 * 睡前习惯关联、心情与时长关联、周末补觉，按显著度取前 3 条。
 * 全部为本地推导，只有数据足够时才输出对应洞察。
 */
export interface PersonalInsight {
  id: string;
  severity: 'good' | 'warn' | 'info';
  title: string;
  body: string;
  quickPrompt: string;
}

const insightBedMin = (bedtime: string): number => {
  const [h, m] = bedtime.split(':').map(Number);
  if (Number.isNaN(h) || Number.isNaN(m)) return 1380;
  return (h < 12 ? h + 24 : h) * 60 + m;
};

const insightWeekend = (date: string): boolean => {
  const [y, m, d] = date.split('-').map(Number);
  if (!y || !m || !d) return false;
  const day = new Date(y, m - 1, d).getDay();
  return day === 0 || day === 6;
};

export function generatePersonalInsights(records: SleepRecord[] = []): PersonalInsight[] {
  const list: PersonalInsight[] = [];
  const avgOf = (arr: SleepRecord[], f: (r: SleepRecord) => number): number =>
    arr.length ? arr.reduce((a, r) => a + f(r), 0) / arr.length : 0;

  if (records.length >= 3) {
    const recent = nightsOnly(records).slice(0, 3);
    const earlier = nightsOnly(records).slice(3, 7);
    const week = nightsOnly(records).slice(0, 7);
    const deepPct = (r: SleepRecord) => (r.durationMinutes > 0 ? (r.deepSleepMinutes / r.durationMinutes) * 100 : 0);

    // 1. 睡前屏幕习惯 ↔ 评分关联
    const screen = week.filter((r) => (r.preSleepHabits || []).includes('screen_time'));
    const noScreen = week.filter((r) => !(r.preSleepHabits || []).includes('screen_time'));
    if (screen.length >= 1 && noScreen.length >= 2) {
      const delta = Math.round(avgOf(noScreen, (r) => r.sleepScore) - avgOf(screen, (r) => r.sleepScore));
      if (delta >= 4) {
        list.push({
          id: 'screen',
          severity: 'warn',
          title: '睡前屏幕正在拉低你的睡眠质量',
          body: `有睡前屏幕习惯的夜晚平均 ${Math.round(avgOf(screen, (r) => r.sleepScore))} 分，其余夜晚 ${Math.round(
            avgOf(noScreen, (r) => r.sleepScore)
          )} 分——相差 ${delta} 分。睡前 1 小时收起手机是目前对你最划算的改善。`,
          quickPrompt: '睡前玩手机影响有多大？',
        });
      }
    }

    // 2. 就寝漂移（近 3 晚 vs 之前）
    if (recent.length >= 2 && earlier.length >= 2) {
      const drift = Math.round(avgOf(recent, (r) => insightBedMin(r.bedtime)) - avgOf(earlier, (r) => insightBedMin(r.bedtime)));
      if (Math.abs(drift) >= 25) {
        const late = drift > 0;
        const scoreDelta = Math.round(avgOf(recent, (r) => r.sleepScore) - avgOf(earlier, (r) => r.sleepScore));
        const scoreTxt =
          scoreDelta >= 2 ? `平均评分随之回升 ${Math.abs(scoreDelta)} 分` : scoreDelta <= -2 ? `平均评分反而下降 ${Math.abs(scoreDelta)} 分` : '平均评分基本持平';
        list.push({
          id: 'drift',
          severity: late ? 'warn' : 'good',
          title: late ? '最近就寝在往后拖' : '最近就寝提前了',
          body: `近 3 晚平均就寝比之前${late ? '晚' : '早'} ${Math.abs(drift)} 分钟，${scoreTxt}。固定起床时间（比固定就寝更有效）是校准生物钟的第一步。`,
          quickPrompt: '最近作息变乱了怎么调回来？',
        });
      }
    }

    // 3. 深睡占比趋势
    if (recent.length >= 2 && earlier.length >= 2) {
      const d = Math.round(avgOf(recent, deepPct) - avgOf(earlier, deepPct));
      if (Math.abs(d) >= 2) {
        list.push({
          id: 'deep',
          severity: d < 0 ? 'warn' : 'good',
          title: d < 0 ? '深睡占比在下滑' : '深睡占比在提升',
          body: `近 3 晚深睡占比 ${Math.round(avgOf(recent, deepPct))}%，比之前${d < 0 ? '低' : '高'} ${Math.abs(d)} 个百分点。${
            d < 0
              ? '深睡集中在前半夜——尝试把就寝提前 30 分钟，并避免睡前酒精（它会显著抑制慢波睡眠）。'
              : '保持当前节奏。深睡集中在前半夜，就寝时间越稳定，深睡波峰越集中。'
          }`,
          quickPrompt: '深睡占比怎么提升？',
        });
      }
    }

    // 4. 醒来心情 ↔ 时长关联
    const good = week.filter((r) => r.wakingMood === 'refreshed');
    const bad = week.filter((r) => r.wakingMood === 'tired' || r.wakingMood === 'groggy');
    if (good.length >= 1 && bad.length >= 2) {
      const dd = Math.round(avgOf(good, (r) => r.durationMinutes) - avgOf(bad, (r) => r.durationMinutes));
      if (dd >= 30) {
        list.push({
          id: 'mood',
          severity: 'info',
          title: '睡得久的那几晚，醒来更清爽',
          body: `醒来感觉清爽的夜晚平均睡 ${Math.round(avgOf(good, (r) => r.durationMinutes))} 分钟，醒后疲惫的夜晚平均 ${Math.round(
            avgOf(bad, (r) => r.durationMinutes)
          )} 分钟——相差约 ${(dd / 60).toFixed(1)} 小时。`,
          quickPrompt: '怎么才能睡够时长？',
        });
      }
    }

    // 5. 周末报复性补觉
    const wknd = week.filter((r) => insightWeekend(r.date));
    const wkdy = week.filter((r) => !insightWeekend(r.date));
    if (wknd.length >= 1 && wkdy.length >= 2) {
      const dd = Math.round(avgOf(wknd, (r) => r.durationMinutes) - avgOf(wkdy, (r) => r.durationMinutes));
      if (dd >= 45) {
        list.push({
          id: 'weekend',
          severity: 'warn',
          title: '周末在报复性补觉',
          body: `周末平均比工作日多睡 ${dd} 分钟。长时间补觉会推迟夜间睡眠压力的积累，让周日更难入睡、周一更疲惫——周末起床时间与工作日相差建议不超过 1 小时。`,
          quickPrompt: '周末补觉到底好不好？',
        });
      }
    }
  }

  if (list.length === 0) {
    list.push({
      id: 'start',
      severity: 'info',
      title: records.length === 0 ? '记录第一晚，解锁个性化洞察' : '继续记录，洞察会越来越准',
      body:
        records.length === 0
          ? '通过一键就寝或手动补录累计 3 晚以上记录，我会从你的真实作息里找出影响睡眠的因素（就寝漂移、习惯关联、深睡趋势）。'
          : '已有少量记录。累计 3 晚以上即可进行趋势对比：就寝漂移、深睡占比趋势、睡前习惯与评分的关联。',
      quickPrompt: records.length === 0 ? '怎么开始记录睡眠？' : '哪些习惯最影响睡眠？',
    });
  }

  const rank = { warn: 0, good: 1, info: 2 } as const;
  return list.sort((a, b) => rank[a.severity] - rank[b.severity]).slice(0, 3);
}

/**
 * 做厚做深的高质量本地对话引擎（意图驱动 + 临床插值 + 安全护栏）
 */
export function generateLocalChatReply(
  userText: string,
  latestRecord?: SleepRecord,
  records: SleepRecord[] = []
): string {
  const intent = classifyIntent(userText);

  // 1. 危机干预安全护栏（无条件熔断）
  if (intent.category === 'crisis') {
    return `❤️ **请珍重您的生命，您并不孤单！**\n\n我们非常关心您的安危与身心感受。当睡眠困难伴随极度的情绪痛苦时，请立刻寻求专业心理与危机支持：\n\n• **全国希望24小时生命求助热线**：400-161-9995\n• **北京心理危机研究与干预中心**：010-82951332 / 800-810-1117\n• **紧急求助电话**：110 / 120\n\n极光睡眠是健康科普工具，无法替代急诊与专业精神科医生。请立刻放下手机，联系身边的亲友或拨打上方免费热线，专业人员随时准备倾听并帮助您度过此刻难关！`;
  }

  // 2. 处方药物咨询安全护栏
  if (intent.category === 'drug_inquiry') {
    return `⚠️ **用药安全声明**：\n\n作为离线睡眠健康顾问，我无法为您提供处方药物（如安眠药、镇静催眠类处方剂）的具体用量、处方推荐或开药指引。\n\n• **医学原则**：镇静催眠类药物属于国家严格管制的处方药，个体耐受性、代谢速度差异极大，必须由具备执业资质的精神心理科或神经内科医生面诊后开具；\n• **无药干预优先**：在临床上，失眠认知行为疗法（CBT-I）是慢性失眠的一线疗法，有效率与持久度均优于短期药物依赖。\n\n如失眠已连续超过 3 周并严重影响白天工作生活，建议前往当地公立医院睡眠医学中心就诊。`;
  }

  // 无任何记录时绝不编造数据：此前的 82 分 / 90 分钟深睡 / 7.5 小时等硬编码兜底值
  // 会被以"结合您最近的记录"的措辞说给从未记录过的用户，属于凭空虚构。
  // 顶层不再设兜底：每个引用个人数据的分支都在分支内优雅降级（deep_sleep/
  // sleep_latency/night_awakening 无记录时去掉个人句，default 分支自行拦截），
  // 文案点名的每个问题都能得到真回答——文件末尾的 dev 自检断言守护这条承诺

  // 提取动态插值数据（到这里必然有真实记录；字段级兜底仅防旧记录缺字段）
  // 用 ?? 只兜"字段缺失"（undefined），不吞 0——0 分/零深睡是合法的真实值
  const score = latestRecord?.sleepScore ?? 82;
  const deep = latestRecord?.deepSleepMinutes ?? 90;
  const durationH = latestRecord ? (latestRecord.durationMinutes / 60).toFixed(1) : '7.5';
  const bedtime = latestRecord?.bedtime ?? '23:30';
  const wakeTime = latestRecord?.wakeTime ?? '07:30';
  const latency = latestRecord?.latencyMinutes ?? 15;
  const wakeCount = latestRecord?.wakeCount ?? 1;

  // 3. 意图分支详尽解答
  switch (intent.category) {
    case 'deep_sleep': {
      const personal = latestRecord
        ? `结合您最近一晚的作息（深睡约 **${deep} 分钟**，入睡时间 **${bedtime}**）：`
        : '我还没有您的深睡记录，先给通用方案（记录一晚后我可以更贴合您）：';
      return `📊 **针对深睡眠（慢波期 N3）提升的临床建议**：\n\n${personal}\n\n1. 🛁 **核心体温下降法**：睡前 60–90 分钟进行约 40℃ 温水浴 15 分钟。热水使体表微血管扩张散热，在进入被窝时身体核心体温迅速下降 0.5–1℃，这是大脑松果体启动慢波深睡的生理触发开关；\n2. ☀️ **早晨户外日光锚定**：晨起 30 分钟内接触 15 分钟自然光，重置视交叉上核生物钟，能让当晚深睡波峰更集中在前两个 90 分钟周期；\n3. 🍷 **睡前严控酒精与重油**：酒精虽能缩短入睡时间，但会严重抑制慢波深睡并打碎后半夜睡眠。今晚可在极光睡眠中开启【床头夜钟伴眠】的白噪音掩蔽，让深睡更连续。`;
    }

    case 'sleep_latency': {
      const personal = latestRecord
        ? `您上一条记录的入睡潜伏期约为 **${latency} 分钟**${latestRecord?.latencyEstimated ? '（按作息推算的估算值）' : ''}。\n\n`
        : '';
      return `🌙 **应对入睡困难 · CBT-I“20分钟刺激控制法”**：\n\n${personal}1. **打破“床 = 焦虑”的条件反射**：若躺下超过 20 分钟仍然毫无睡意，不要在床上翻来覆去强迫自己入睡！越用力想睡，脑内去甲肾上腺素水平越高；\n2. **离开床铺重置**：起身坐在昏暗柔和的灯光下（避免看手机屏幕），翻阅枯燥的书籍或听极光睡眠的 528Hz 修复颂磬，等到眼皮沉重、哈欠连天时再回到床上；\n3. **认知解耦**：告诉自己“闭目静躺本身就能让肌肉与神经获得 60% 以上的体能修复”，无需为今晚是否立刻睡着而自责。`;
    }

    case 'night_awakening': {
      const title = latestRecord ? `针对夜间易醒（夜醒 ${wakeCount} 次）的应对指南` : '针对夜间易醒的应对指南';
      return `⏰ **${title}**：\n\n半夜惊醒或翻身醒来是很多人常见的困扰：\n\n1. **千万不要看时间**：看闹钟屏幕会立刻触发认知算力（“天哪才 3 点”、“我只剩 3 小时能睡了”），瞬间拉高皮质醇心率。把手机倒扣在远离床头的位置；\n2. **腹式呼吸激活迷走神经**：夜间醒来身体微冷，平躺后把双手放在腹部，吸气 4 秒让腹部鼓起，屏息 2 秒，缓慢呼气 6 秒，连续 6–8 轮；\n3. **排查环境温度**：后半夜人体核心体温降至谷底，若卧室过冷或过热会导致翻身微觉醒。建议卧室温度保持在 19–21℃。`;
    }

    case 'early_awakening':
      return `🌅 **针对清晨过早醒来（凌晨 3–5 点）的调理策略**：\n\n早醒通常与深睡周期提前结束、皮质醇提前过早飙升有关：\n\n1. **卧床时间是否过长**：如果晚上 22:00 入睡，早上 4:30 醒来已经睡足 6.5 小时，这是睡眠压力自然释放的结果。可尝试将就寝时间推迟 30–45 分钟（至 22:45–23:00），以压实睡眠密度；\n2. **卧室严格遮光**：清晨微弱的晨光透过窗帘缝隙就会被视网膜感知，抑制褪黑素。换用全遮光窗帘或佩戴丝绸眼罩；\n3. **早醒后勿赖床补觉**：醒来若无法再次入睡，建议在固定时间起床拉开窗帘接受光照，把睡眠动力储蓄留给今晚。`;

    case 'caffeine_lifestyle':
      return `☕ **生活习惯与腺苷代谢机制解析**：\n\n以下为不依赖个人记录的通用科普${latestRecord ? '（结合您记录的习惯标签）' : ''}：\n\n1. **咖啡因半衰期规律**：咖啡因在健康人体内的半衰期约为 5–7 小时，清除 75% 需耗时近 10 小时。下午 14:00 后摄入咖啡、浓茶或奶茶，即使晚上能睡着，脑电波里的慢波振幅也会显著衰减；\n2. **晚间剧烈运动时间窗口**：运动会使核心体温与内啡肽升高持续 2–3 小时，因此高强度心肺锻炼请安排在睡前 3 小时以前完成；\n3. **睡前 2 小时禁夜宵饱食**：胃肠剧烈蠕动会引起夜间胃食管反流和交感神经过载，导致深睡比例断崖式下跌。`;

    case 'dreams_anxiety':
      return `💭 **关于梦境与睡前思绪杂乱的心理疏导**：\n\n多梦并非睡眠质量差的标志！快速眼动期（REM）每晚都会周期性出现 4–5 次，做梦是大脑在整理记忆碎片与情绪消磁：\n\n1. **睡前“担忧便签本”**：睡前半小时拿纸笔写下明天待办事项与心中忧虑，写完合上本子，心理学上称为“认知卸载”，告诉大脑今晚任务已存盘；\n2. **432Hz / 528Hz 脑波引导**：在极光睡眠的助眠音频中，音波振动能协助大脑脑电从高频 Beta 波平缓滑落至 Alpha 和 Theta 波；\n3. **噩梦惊醒时的接地法**：深吸一口气，用双手摸摸被褥的触感，确认自己身处安全的卧室，梦境已完全消散。`;

    case 'circadian_shift':
      return `🧭 **熬夜 / 作息紊乱后的生物钟校准方案**：\n\n人体视交叉上核生物钟的主控发条是“光照”与“进食时段”：\n\n1. **严禁次日白天报复性补觉**：补觉超过 1 小时会彻底打散当晚的睡眠压力（Sleep Drive），导致今夜再次失眠，恶性循环。次日请按原定时间起床；\n2. **早晨吃一份富含蛋白质的早餐**：进食信号会重置肝脏与外周器官的时钟基因；\n3. **午间微小憩**：若白天极度困倦，仅可在下午 13:00–13:30 闭目小憩 20 分钟，并定好闹钟，避免进入深睡阶段醒来昏沉。`;

    case 'nap_recovery':
      return `⚡ **科学高效的午间动力小憩（Power Nap）**：\n\n1. **黄金时长 15–20 分钟**：严格控制在 20 分钟内，此时大脑仅处于浅睡眠（N1/N2），醒来神清气爽；若超过 30 分钟掉入慢波深睡（N3），醒来会产生长达 1 小时的“睡眠惯性（昏沉头痛）”；\n2. **咖啡小憩法（Coffee Nap）**：小憩前喝一小杯黑咖啡立刻闭目休息，20 分钟后咖啡因起效 + 腺苷暂时清除，精力恢复效果倍增；\n3. **截止时间**：午睡严禁晚于下午 15:30，以免截断当晚就寝前的入眠驱动力。`;

    case 'detection_principles':
      return `🔍 **极光睡眠的睡眠分期原理（模型推演，非传感器实测）**：

1. **90分钟超昼夜节律模型**：人的睡眠由 4–6 个约 90 分钟的周期串联（入睡 → 浅睡 → 深睡 → REM）。本应用根据您记录的真实就寝/起床时间，按该节律推演各期分布与占比；
2. **诚实边界**：App 未读取体动/脑波传感器，各期时长与占比为科学模型估算值，仅供作息参考，不能替代多导睡眠监测（PSG）等临床检测；
3. **100% 本地运算与隐私安全**：所有数据均在您的设备内推导存储，无需联网上传服务器。`;

    default: {
      // default（general_advice）整段引用个人数据：无记录时如实告知，不编造
      if (!latestRecord) {
        return `👋 我还没有您的任何睡眠记录——不想拿编造的数字糊弄您。\n\n可以先做其中一件事，我们再细聊：\n• 今晚用【一键就寝】记录第一晚睡眠；\n• 或在【睡眠】页手动补录最近一晚。\n\n也欢迎直接问：怎么提升深睡占比、应对入睡困难、夜间易醒怎么办、咖啡因半衰期、昼夜节律怎么调等，这些我都能答。`;
      }
      return `收到您的问题：“${userText}”！\n\n结合您最近在极光睡眠的记录（当前作息为 **${bedtime} 入睡、${wakeTime} 醒来**，总时长约 **${durationH} 小时**，深睡约 **${deep} 分钟**，评分 **${score} 分**）：\n\n• 您的昼夜生物钟正在根据您的日常规律持续自适应校准；\n• 您随时可以在首页通过【今晚准备入睡】或【晨起手动补录】记录最新起居，并在【偏好】中设置目标作息；\n• 如有其他具体感受（如入睡困难、半夜容易醒、午后犯困等），请直接告诉我，我将为您输出针对性的生理调理方案！`;
    }
  }
}

// ── 结构性护栏（dev 构建一次性自检）────────────────────────────────
// 连续两轮审查暴露同一缺陷类：兜底文案"承诺可以问的问题"和"实际会拦回的
// 分支"写在两处，靠人工对齐必然漂移。这里让承诺可被机器验证——
// 每个点名的示例问题都必须得到真回答，而不是被无记录兜底拦回。
if (import.meta.env?.DEV) {
  const PROMISED_EXAMPLES = ['怎么提升深睡占比', '应对入睡困难', '夜间易醒怎么办'];
  for (const q of PROMISED_EXAMPLES) {
    const r = generateLocalChatReply(q, undefined, []);
    if (r.includes('我还没有您的任何睡眠记录')) {
      console.error(`[clinicalSleepEngine] 兜底文案承诺了「${q}」，却被无记录兜底拦回——文案与意图分支已漂移`);
    }
  }
}
import { nightsOnly } from './recordFilter';

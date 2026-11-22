/**
 * 评估报告提示词（服务端代理与 APK 内直连云端共用）。
 *
 * 为什么必须共用（第 91 轮）：此前只有服务端代理一条路径，APK 内没有
 * server.ts，`POST /api/sleep/analyze` 必然 404，报告永远落到本地规则引擎
 * ——与"三种引擎自由切换"的承诺不符。补直连分支时若各写一份提示词，
 * 同一批数据在两条路径下会得到不可比的报告（本地/云端口径分叉的老坑）。
 *
 * 隐私（第 33 轮联动审计）：userProfile.aiConfig 含 deepseekApiKey /
 * customApiKey，原样序列化会把密钥写进提示词发给模型服务方——自建端点
 * 场景即泄露给第三方。提示词只需要健康相关字段，这里统一剥离。
 */

const SYSTEM_PROMPT = `你是一位世界顶尖的睡眠医学与昼夜节律专家顾问（具备神经生物学与认知行为疗法 CBT-I 背景）。
请基于用户近期记录的睡眠日志、作息习惯与生理指标，进行科学、温暖、高度个性化且具有可操作性的睡眠深度分析，并输出 JSON 格式。
输出格式要求必须严格是 JSON 对象，键名如下：
{
  "chronotype": "识别出的生物节律时型（如：早起云雀型/晨型人、夜猫猫头鹰型/夜型人、温和中庸型、蜂鸟型）",
  "chronotypeDescription": "该节律时型的生理特点与日常作息建议简评（60字以内）",
  "overallHealthGrade": "评估等级（优良 A+ / 良好 A / 亚健康 B / 需调理 C）",
  "scoreSummary": "一句话核心总结评价（25字以内）",
  "clinicalMetricsAnalysis": {
    "durationAssessment": "关于睡眠总时长的科学解读（与目标8小时对比、睡眠债务分析）",
    "deepSleepAssessment": "深睡眠比例与大脑毒素排解/身体机能修复评价（正常应为15%-25%）",
    "remSleepAssessment": "快速眼动期(REM)与情绪整合、记忆巩固评价（正常应为20%-25%）",
    "efficiencyAssessment": "睡眠效率（实际睡着时间/卧床时间）评价（优良标准>85%）",
    "sleepLatencyAssessment": "入睡潜伏期评价（健康范围10-20分钟）"
  },
  "identifiedIssues": [
    "识别出的核心睡眠阻碍1（如：入睡前蓝光暴露抑制褪黑素释放）",
    "识别出的核心睡眠阻碍2"
  ],
  "personalizedRecommendations": [
    {
      "timeWindow": "白天/午后 (07:00 - 18:00)",
      "action": "具体建议标题",
      "detail": "科学机理与具体实操细节",
      "impact": "预计改善指标（如：提升深睡眠15分钟）"
    },
    {
      "timeWindow": "睡前减速期 (21:30 - 23:00)",
      "action": "具体建议标题",
      "detail": "科学机理与具体实操细节",
      "impact": "缩短入睡潜伏期"
    },
    {
      "timeWindow": "夜间环境调控",
      "action": "卧室环境优化",
      "detail": "温度（建议18-20℃）、避光、白噪音运用等",
      "impact": "减少夜醒频次"
    }
  ],
  "mindsetAffirmation": "睡前放松心态寄语，舒缓焦虑（40字以内）"
}
请注意：只输出合法标准JSON字符串，不要添加任何Markdown标记或无关字符。`;

export interface AnalysisPrompts {
  systemPrompt: string;
  userPrompt: string;
}

export function buildAnalysisPrompts(recentLogs: unknown, userProfile: unknown): AnalysisPrompts {
  const { aiConfig: _stripAi, ...safeProfile } = (userProfile || {}) as Record<string, unknown>;
  const userPrompt = `用户档案：${JSON.stringify(Object.keys(safeProfile).length ? safeProfile : { age: 28, targetHours: 8 })}
近期睡眠记录数据：
        ${JSON.stringify(recentLogs)}

请结合以上数据生成精准的睡眠医学诊断报告，返回纯JSON。`;
  return { systemPrompt: SYSTEM_PROMPT, userPrompt };
}

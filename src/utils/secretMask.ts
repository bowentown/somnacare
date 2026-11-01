/**
 * 密钥落盘掩码（第 120 轮，审计遗留 P2）：localStorage 的用户档案里
 * aiConfig 的 *ApiKey 字段不再明文落盘——写侧掩码（XOR 常量流 + Base64URL），
 * 读侧解掩码（兼容旧明文：非 obv1: 前缀原样返回，加载后下次写盘即转掩码）。
 *
 * 诚实边界：这是掩码不是加密——防的是"误分享截图/肉眼翻存储/误复制整段
 * localStorage"，不防拿到设备的攻击者（本地存储对 root 本无密可保）。
 * 出口侧的纪律仍由 backup 导出剥离（SENSITIVE_PROFILE_KEYS）与提示词剥离
 * （clinicalAnalysisPrompt）负责，三道各司其职。
 */
const MASK_PREFIX = 'obv1:';
const OBF_KEY = 'somnacare-local-obf-v1';

const xorStream = (s: string): string =>
  Array.from(s)
    .map((ch, i) => String.fromCharCode(ch.charCodeAt(0) ^ OBF_KEY.charCodeAt(i % OBF_KEY.length)))
    .join('');

export function maskSecret(v: string): string {
  if (!v || v.startsWith(MASK_PREFIX)) return v;
  try {
    const b64 = btoa(unescape(encodeURIComponent(xorStream(v))));
    return MASK_PREFIX + b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  } catch {
    return v;   // 非 UTF8 可编码的异常输入：原样返回（读侧也原样，行为不变）
  }
}

export function unmaskSecret(v: string): string {
  if (!v || !v.startsWith(MASK_PREFIX)) return v;   // 旧明文：原样（写侧会转掩码）
  try {
    const b64 = v.slice(MASK_PREFIX.length).replace(/-/g, '+').replace(/_/g, '/');
    return decodeURIComponent(escape(xorStream(atob(b64))));
  } catch {
    return v;   // 掩码损坏：原样返回，交给既有"密钥无效"链路报错
  }
}

interface WithAiConfig {
  aiConfig?: object;   // 具体接口（AIConfig）可赋给 object，泛型 P 得以保形
}

/** 写侧：所有 *ApiKey 字段转掩码（其余字段原样——URL/模型名不是机密） */
export function maskProfileSecrets<P extends WithAiConfig>(profile: P): P {
  const ai = profile.aiConfig;
  if (!ai) return profile;
  const out: Record<string, unknown> = { ...ai };
  for (const k of Object.keys(out)) {
    if (k.endsWith('ApiKey') && typeof out[k] === 'string') out[k] = maskSecret(out[k] as string);
  }
  // as P：掩码只动 *ApiKey 字段值（同型 string），不改档案形状
  return { ...profile, aiConfig: out } as P;
}

/** 读侧：*ApiKey 字段解掩码（旧明文原样通过，运行时拿到可用密钥） */
export function unmaskProfileSecrets<P extends WithAiConfig>(profile: P): P {
  const ai = profile.aiConfig;
  if (!ai) return profile;
  const out: Record<string, unknown> = { ...ai };
  for (const k of Object.keys(out)) {
    if (k.endsWith('ApiKey') && typeof out[k] === 'string') out[k] = unmaskSecret(out[k] as string);
  }
  return { ...profile, aiConfig: out } as P;
}

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildAnalysisPrompts } from '../../src/utils/clinicalAnalysisPrompt';
import { maskProfileSecrets, unmaskProfileSecrets } from '../../src/utils/secretMask';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

describe('LLM 提示词隐私剥离与落盘密钥掩码', () => {
  it('buildAnalysisPrompts 彻底剥离 aiConfig 与全部 API 密钥，同时保留健康上下文', () => {
    const DEEPSEEK_KEY = 'sk-SECRET-deepseek';
    const CUSTOM_KEY = 'ck-SECRET-custom';
    const profile = {
      name: '鱼片',
      age: 30,
      targetDurationHours: 8,
      aiConfig: {
        provider: 'deepseek' as const,
        deepseekApiKey: DEEPSEEK_KEY,
        customApiKey: CUSTOM_KEY,
        customBaseUrl: 'https://api.deepseek.com',
        deepseekModel: 'deepseek-flash',
      },
    };
    const logs = [{ date: '2026-10-20', bedtime: '23:30', wakeTime: '07:30', durationMinutes: 480 }];

    const { systemPrompt, userPrompt } = buildAnalysisPrompts(logs as any, profile as any);
    const blob = systemPrompt + '\n' + userPrompt;

    expect(blob).not.toContain(DEEPSEEK_KEY);
    expect(blob).not.toContain(CUSTOM_KEY);
    expect(blob).not.toContain('aiConfig');
    expect(blob).toContain('"age":30');
    expect(blob).toContain('"targetDurationHours":8');
    expect(blob).toContain('2026-10-20');
    expect(blob).toContain('23:30');
    expect(systemPrompt.length).toBeGreaterThan(1000);
    expect(systemPrompt).toContain('JSON');
  });

  it('UserProfile 不新增 aiConfig 之外的凭据字段（防黑名单遗漏）', () => {
    const typesSrc = readFileSync(join(ROOT, 'src/types/sleep.ts'), 'utf-8');
    const start = typesSrc.indexOf('export interface UserProfile');
    const body = typesSrc.slice(typesSrc.indexOf('{', start), typesSrc.indexOf('\n}', start));
    const fields = [...body.matchAll(/^\s{2}([A-Za-z]\w*)\??:/gm)].map((m) => m[1]);
    expect(fields.length).toBeGreaterThan(0);
    expect(fields.filter((f) => /token|secret|apikey|credential/i.test(f))).toEqual([]);
  });

  it('secretMask：落盘掩码不含明文且往返还原一致，兼容旧明文输入', () => {
    const rawProfile = {
      name: '鱼片',
      age: 30,
      targetBedtime: '23:30',
      targetWakeTime: '07:30',
      targetDurationHours: 8,
      smartAlarmEnabled: false,
      smartWakeWindowMinutes: 20,
      soundDetectionSensitivity: 'medium' as const,
      brightnessLevel: 100,
      warmthFilter: false,
      aiConfig: {
        provider: 'deepseek' as const,
        deepseekApiKey: 'sk-plain-secret-key',
        customApiKey: 'ck-another-secret',
      },
    };

    const masked = maskProfileSecrets(rawProfile);
    const serialized = JSON.stringify(masked);
    expect(serialized).not.toContain('sk-plain-secret-key');
    expect(serialized).not.toContain('ck-another-secret');
    expect(masked.aiConfig?.deepseekApiKey).toMatch(/^obv1:/);

    const restored = unmaskProfileSecrets(masked);
    expect(restored.aiConfig?.deepseekApiKey).toBe('sk-plain-secret-key');
    expect(restored.aiConfig?.customApiKey).toBe('ck-another-secret');

    // 旧明文兼容：非 obv1: 前缀原样返回
    const legacy = unmaskProfileSecrets(rawProfile);
    expect(legacy.aiConfig?.deepseekApiKey).toBe('sk-plain-secret-key');
  });
});

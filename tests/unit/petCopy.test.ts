import { describe, it, expect } from 'vitest';
import { ALL_POSTCARDS, TRIP_POOL } from '../../src/features/pet/data/travelPostcards';
import { TRIP_POSTCARD_MANIFEST } from '../../src/features/pet/data/postcardIds';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const AI_FRIENDS = ['楼下Claude', '美国豆包Gemini', '被压榨的Qwen', '被蒸馏的Kimi', '意难平的豆包姐姐'];

describe('桌宠与明信片预设文案语料质量', () => {
  const serializedPostcards = JSON.stringify(ALL_POSTCARDS);

  it('经典诗文引用顺序正确，无已知拼凑或颠倒错句', () => {
    const requiredQuotes = [
      '问君何能尔，心远地自偏',
      '曲径通幽处，禅房花木深',
      '晚来天欲雪，能饮一杯无',
      '星汉灿烂，若出其里',
      '天地有大美而不言',
      '念天地之悠悠，独怆然而涕下',
      '醉后不知天在水，满船清梦压星河',
    ];
    for (const q of requiredQuotes) {
      expect(serializedPostcards, `引用：${q}`).toContain(q);
    }

    const badForms = [
      '心远地自偏，问君何能尔',
      '漫漫平沙走白日',
      '光影倒悬若神虚',
      '天地悠悠，独怆然而涕下',
    ];
    for (const b of badForms) {
      expect(serializedPostcards, `禁回退：${b}`).not.toContain(b);
    }
  });

  it('地理物种事实准确，好友评论均在花名册内且绝不盗用自称「本鱼」', () => {
    expect(serializedPostcards).not.toContain('淮河夜月');
    expect(serializedPostcards).toContain('会安夜月丝灯印');
    expect(serializedPostcards).not.toContain('麋鹿');
    expect(serializedPostcards).toContain('驼鹿');
    expect(serializedPostcards).not.toContain('安博塞利');

    for (const card of ALL_POSTCARDS) {
      for (const c of card.friendComments ?? []) {
        expect(AI_FRIENDS, `好友名合法：${c.friend}`).toContain(c.friend);
        expect(c.text, `好友不盗用本鱼：${card.id}`).not.toContain('本鱼');
      }
    }
  });

  it('桌宠播报与本地评论池守住数据诚实与人设边界', () => {
    const petOverlay = readFileSync(join(ROOT, 'src/features/pet/utils/petOverlay.ts'), 'utf-8');
    const petMoments = readFileSync(join(ROOT, 'src/features/pet/utils/petMoments.ts'), 'utf-8');
    expect(petOverlay).not.toContain('翻了那么多次身');
    expect(petMoments).toContain('禁止写死具体钟点');
    const lcStart = petMoments.indexOf('const LOCAL_COMMENTS');
    const lcEnd = petMoments.indexOf('const friends =', lcStart);
    expect(lcStart).toBeGreaterThanOrEqual(0);
    expect(petMoments.slice(lcStart, lcEnd)).not.toContain('本鱼');
  });

  it('轻量抽卡索引 postcardIds.ts 与完整明信片池 TRIP_POOL 100% 同步', () => {
    expect(TRIP_POSTCARD_MANIFEST.length).toBe(TRIP_POOL.length);
    for (let i = 0; i < TRIP_POOL.length; i += 1) {
      expect(TRIP_POSTCARD_MANIFEST[i].id).toBe(TRIP_POOL[i].id);
      expect(TRIP_POSTCARD_MANIFEST[i].souvenirName).toBe(TRIP_POOL[i].souvenir.name);
    }
  });
});

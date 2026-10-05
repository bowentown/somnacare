import { expect, test } from '@playwright/test';

/**
 * 运行时冒烟（第 36 轮）：三条最低限度的"真渲染"用例，锁住静态护栏
 * 挡不住的缺陷类别：
 *  1. 五分区同时渲染（滑动轨道常驻，缺一个就是结构性回归）
 *  2. 得分曲线几何自洽（100 分点必须在 90 分绿线上方——第 25 轮修过的
 *     视觉 bug 的回归锁）
 *  3. 生成评估产出结果（云端无 key 时走本地兜底，链路必须活着）
 */

const seed = async (page: import('@playwright/test').Page) => {
  await page.goto('/');
  await page.waitForLoadState('domcontentloaded');
  await page.evaluate(() => {
    const mk = (date: string, score: number, bed: string, wake: string, dur: number) => ({
      id: 'r-' + date, date, bedtime: bed, wakeTime: wake, durationMinutes: dur,
      deepSleepMinutes: 90, lightSleepMinutes: 300, remSleepMinutes: 70, awakeMinutes: 10,
      sleepScore: score, sleepEfficiency: 90, latencyMinutes: 12, wakeCount: 1,
    });
    localStorage.setItem('somnacare_sleep_records', JSON.stringify([
      mk('2026-10-04', 100, '23:10', '07:10', 470),
      mk('2026-10-03', 86, '23:30', '07:20', 460),
      mk('2026-10-02', 74, '00:10', '07:30', 430),
    ]));
    localStorage.setItem('somnacare_onboarded_v1', '1');
    localStorage.removeItem('somnacare_analysis_v1');
    sessionStorage.clear();
  });
  await page.reload();
  await page.waitForLoadState('domcontentloaded');
  await page.waitForTimeout(4200);   // 开屏动画播完
};

test('五个分区同时渲染（滑动轨道常驻）', async ({ page }) => {
  await seed(page);
  const texts = await page.evaluate(() => document.body.innerText);
  expect(texts).toContain('今晚准备入睡');      // 睡眠
  expect(texts).toContain('趋势与结构');        // 趋势
  expect(texts).toContain('大肥鱼的朋友圈');    // AI 顾问
  expect(texts).toContain('护眼滤镜');          // 护眼
  expect(texts).toContain('界面主题');          // 偏好
});

test('得分曲线几何自洽：100 分点在 90 分绿线上方', async ({ page }) => {
  await seed(page);
  await page.getByRole('navigation', { name: '主标签栏' }).getByRole('button', { name: '趋势' }).click();
  await page.waitForTimeout(600);
  const geo = await page.evaluate(() => {
    // 90 分参考线（emerald）与 100 分数据点（cy 最小的 circle）。
    // cy 缺失的圆点必须过滤——Number(null)===0 曾让断言对着一堆
    // 无坐标圆点假绿（复审 45 轮 D5）
    const line = document.querySelector('svg line.text-emerald-300') as SVGLineElement | null;
    const circles = [...document.querySelectorAll('svg circle')]
      .map((c) => c.getAttribute('cy'))
      .filter((v): v is string => v !== null)
      .map(Number);
    const topPoint = circles.length ? Math.min(...circles) : null;
    return { lineY: line ? Number(line.getAttribute('y1')) : null, topPoint, circleCount: circles.length };
  });
  expect(geo.lineY).not.toBeNull();
  expect(geo.circleCount).toBeGreaterThan(0);   // 至少存在带坐标的数据点
  expect(geo.topPoint).not.toBeNull();
  // 回归锁：最高分点（100 分 → y=10）必须在 90 线（y=22）之上
  expect(geo.topPoint).toBeLessThan(geo.lineY as number);
});

test('生成评估产出结果（本地兜底链路存活）', async ({ page }) => {
  await seed(page);
  await page.getByRole('navigation', { name: '主标签栏' }).getByRole('button', { name: 'AI顾问' }).click();
  await page.waitForTimeout(500);
  await page.evaluate(() => {
    const btn = [...document.querySelectorAll('button')].find((b) => (b.textContent || '').includes('睡眠医学完整评估'));
    btn?.click();
  });
  await page.waitForTimeout(300);
  await page.evaluate(() => {
    const btn = [...document.querySelectorAll('button')].find((b) => /生成评估|刷新评估/.test(b.textContent || ''));
    btn?.click();
  });
  await page.waitForTimeout(2500);
  const texts = await page.evaluate(() => document.body.innerText);
  // 本地兜底结果渲染（评估卡出现内容），且未触发错误边界
  expect(texts).not.toContain('应用界面出现小状况');
  expect(texts.includes('刷新评估') || texts.includes('深睡机能恢复')).toBeTruthy();
});

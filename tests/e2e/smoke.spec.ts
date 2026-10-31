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

test('分区懒渲染：首帧只渲染当前分区，访问后挂载且常驻', async ({ page }) => {
  // 第 74 轮性能改造：滑动轨道常驻（布局不变），分区内容按需挂载——
  // 首帧只有「今天」，趋势/AI/护眼/偏好在首次访问时挂载并保留
  await seed(page);
  const texts = await page.evaluate(() => document.body.innerText);
  expect(texts).toMatch(/早安|午后小睡|今晚准备入睡|该睡了/);   // 睡眠主卡（时段自适应标题）
  expect(texts).not.toContain('大肥鱼的朋友圈');   // 未访问的分区不渲染

  const visit = async (tab: string, marker: string) => {
    await page.getByRole('navigation', { name: '主标签栏' }).getByRole('button', { name: tab, exact: true }).click();
    // 断言驱动等待（第 88 轮）：分区 React.lazy 后 chunk 加载在高负载下
    // 偶超固定 400ms 窗口（假红）——等 marker 真正可见再读全文
    await expect(page.getByText(marker).first()).toBeVisible({ timeout: 8000 });
    const t = await page.evaluate(() => document.body.innerText);
    expect(t).toContain(marker);
  };
  await visit('AI顾问', '大肥鱼的朋友圈');
  await visit('护眼', '护眼滤镜');
  await visit('偏好', '界面主题');
  // 回到今天：访问过的分区保持挂载，今天的内容仍在（梦境漫游=池塘入口，非时段自适应）
  await visit('睡眠', '梦境漫游');
});

test('得分曲线几何自洽：100 分点在 90 分绿线上方', async ({ page }) => {
  await seed(page);
  await page.getByRole('navigation', { name: '主标签栏' }).getByRole('button', { name: '趋势' }).click();
  // 吸附动画落定（AGENTS.md：指数缓出前 100ms 走完 80%，两帧稳定判定会
  // 在尾段放行 → 紧跟的点击落到隔壁分区静默失效）
  await page.waitForTimeout(380);
  // Phase 1：默认视图是起卧时段，切到得分曲线。
  // 等待而非盲等（第 105 轮）：裸 click + 固定 wait 会与"吸附动画 + 懒
  // chunk 就绪"竞态——点击落在隔壁控件或按钮未挂载而静默失效（AGENTS.md
  // 的落定模式；此前 ~1/3 概率整页停在睡眠分区）
  const curveBtn = page.getByRole('button', { name: '得分曲线' });
  await curveBtn.waitFor({ state: 'visible', timeout: 10000 });
  await curveBtn.click();
  await page.waitForTimeout(600);
  const geo = await page.evaluate(() => {
    // 90 分参考线（emerald stroke）与 100 分数据点（cy 最小的 circle）。
    // cy 缺失的圆点必须过滤——Number(null)===0 曾让断言对着一堆
    // 无坐标圆点假绿（复审 45 轮 D5）
    const line = document.querySelector('svg line[stroke="#5ee9b5"]') as SVGLineElement | null;
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

import { test, expect } from '@playwright/test';
import {
  NIGHT_SCHEMA,
  dstr,
  mkRecord,
  navTo,
  openAt,
  seed,
  watchErrors,
} from './_journeyHelpers';

test('旅程42 睡前仪式 CBT-I 闭环：3 模式呼吸、微课打卡、自定义标签联动补录与趋势关联洞察', async ({ page }) => {
  const errors = watchErrors(page);
  const fixed = await openAt(page, 22, 15);
  await seed(page, [], NIGHT_SCHEMA);
  await page.reload();
  await page.waitForLoadState('domcontentloaded');
  await page.waitForTimeout(4200);

  // 1. 打开首页「睡前仪式」二级子页
  await page.getByRole('button', { name: /睡前仪式/ }).click();
  const region = page.getByRole('region', { name: '睡前仪式' });
  await expect(region).toBeVisible();

  // 2. 切换呼吸模式（4-7-8 → 4-4-4-4 盒式 → 4-6 慢呼）
  await region.getByRole('tab', { name: '4-4-4-4 盒式' }).click();
  await expect(region.getByText('4-4-4-4 盒式平衡呼吸')).toBeVisible();
  await region.getByRole('tab', { name: '4-6 慢呼' }).click();
  await expect(region.getByText('4-6 慢速长呼呼吸')).toBeVisible();

  // 3. 打卡今晚睡前仪式清单
  const checklistBtn = region.getByRole('button', { name: /调暗屏幕并远离强光/ });
  await checklistBtn.click();
  await expect(checklistBtn).toHaveAttribute('aria-pressed', 'true');
  await expect(region.getByText('已完成 1/4')).toBeVisible();

  // 4. 展开 CBT-I 微课并标记已学
  await region.getByRole('button', { name: /刺激控制：15–20 分钟离床原则/ }).click();
  await region.getByRole('button', { name: '标记为已学' }).click();
  await expect(region.getByText('已学 1/6')).toBeVisible();

  // 5. 新增自定义睡眠日记标签
  await region.getByLabel('自定义睡眠标签名称').fill('热水泡脚');
  await region.getByRole('button', { name: '添加' }).click();
  await expect(region.getByText('热水泡脚')).toBeVisible();

  // 6. 刷新页面验证微课进度、呼吸模式与自定义标签持久落盘
  await page.reload();
  await page.waitForLoadState('domcontentloaded');
  await page.waitForTimeout(4200);
  await page.getByRole('button', { name: /睡前仪式/ }).click();
  const regionAfterReload = page.getByRole('region', { name: '睡前仪式' });
  await expect(regionAfterReload.getByText('4-6 慢速长呼呼吸')).toBeVisible();
  await expect(regionAfterReload.getByText('已学 1/6')).toBeVisible();
  await expect(regionAfterReload.getByText('热水泡脚')).toBeVisible();

  // 7. 返回首页打开手动补录弹窗，验证自定义标签可直接勾选并落库
  await page.getByRole('button', { name: '返回' }).click();
  await page.getByRole('button', { name: /补录睡眠|手动补录/ }).click();
  const customChip = page.getByRole('button', { name: /热水泡脚/ });
  await expect(customChip).toBeVisible();
  await customChip.click();
  await page.getByRole('button', { name: /保存记录并更新睡眠趋势/ }).click();

  // 8. 切到趋势页，验证仅 1 晚时诚实显示「1/5 晚（还差 4 晚）」而非假相关
  await navTo(page, '趋势');
  await expect(page.getByText('睡前标签关联洞察')).toBeVisible();
  await expect(page.getByText(/热水泡脚 · 1\/5 晚（还差 4 晚）/)).toBeVisible();

  // 9. 注入 5 晚带 caffeine（较短/入睡慢）+ 3 晚无 caffeine（较长/入睡快），验证满 5 晚自动解锁关联差值
  const seeded = [
    ...Array.from({ length: 5 }, (_, i) => ({
      ...mkRecord(dstr(-(i + 1), fixed), '00:15', '06:15', 65),
      durationMinutes: 360,
      latencyMinutes: 40,
      sleepEfficiency: 80,
      preSleepHabits: ['caffeine'],
    })),
    ...Array.from({ length: 3 }, (_, i) => ({
      ...mkRecord(dstr(-(i + 6), fixed), '23:00', '07:15', 90),
      durationMinutes: 495,
      latencyMinutes: 10,
      sleepEfficiency: 94,
      preSleepHabits: [],
    })),
  ];
  await seed(page, seeded, NIGHT_SCHEMA);
  await page.reload();
  await page.waitForLoadState('domcontentloaded');
  await page.waitForTimeout(4200);
  await navTo(page, '趋势');
  await expect(page.getByText('下午喝咖啡/茶')).toBeVisible();
  await expect(page.getByText(/5 晚 vs 3 晚/)).toBeVisible();
  await expect(page.getByText(/评分 -/)).toBeVisible();

  expect(errors).toEqual([]);
});

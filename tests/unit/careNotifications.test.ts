import { describe, it, expect, beforeEach } from 'vitest';
import { installMemoryStorage } from './_helpers';
import { morningAt9From, recallAt21From, weekKeyOf } from '../../src/utils/careNotifications';

const storage = installMemoryStorage();
const at = (y: number, mo: number, d: number, h: number, mi: number) =>
  new Date(y, mo - 1, d, h, mi, 0, 0);

describe('关怀通知时间助手（careNotifications）', () => {
  beforeEach(() => storage.clear());

  it('晨间确认时刻：晚间开监测落次日 09:00，清晨补开落当天 09:00', () => {
    expect(morningAt9From(at(2026, 11, 4, 22, 0)).getTime()).toBe(at(2026, 11, 5, 9, 0).getTime());
    expect(morningAt9From(at(2026, 11, 4, 7, 0)).getTime()).toBe(at(2026, 11, 4, 9, 0).getTime());
  });

  it('断记召回时刻：21:00 前落今晚 21:00，之后落明晚 21:00', () => {
    expect(recallAt21From(at(2026, 11, 4, 20, 59)).getTime()).toBe(at(2026, 11, 4, 21, 0).getTime());
    expect(recallAt21From(at(2026, 11, 4, 21, 30)).getTime()).toBe(at(2026, 11, 5, 21, 0).getTime());
  });

  it('周键以周一为界：同周周三与周日同键、跨周一不同键', () => {
    const wed = weekKeyOf(at(2026, 11, 4, 10, 0));
    const sun = weekKeyOf(at(2026, 11, 8, 10, 0));
    const prevSun = weekKeyOf(at(2026, 11, 1, 10, 0));
    expect(wed).toBe(sun);
    expect(wed).not.toBe(prevSun);
  });
});

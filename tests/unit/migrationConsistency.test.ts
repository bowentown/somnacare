import { describe, it, expect, beforeEach } from 'vitest';
import { installMemoryStorage } from './_helpers';
import { migrateRecordDatesToNightKey } from '../../src/utils/recordDateMigration';
import { nightKeyOfBed } from '../../src/utils/dateUtils';
import { loadAndMigrateRecords } from '../../src/utils/recordsHydrate';

const storage = installMemoryStorage();

const pad = (n: number) => String(n).padStart(2, '0');
const dateStr = (base: Date, off: number) => {
  const d = new Date(base);
  d.setDate(d.getDate() + off);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

describe('记录日期迁移全组合一致性与补水容错', () => {
  beforeEach(() => storage.clear());

  it('迁移结果与权威 nightKeyOfBed 在全部床/醒时刻组合上 100% 一致', () => {
    const base = new Date(2026, 9, 15);
    let scanned = 0;
    const mismatches: string[] = [];

    for (let bMin = 0; bMin < 24 * 60; bMin += 15) {
      for (let wMin = 0; wMin < 24 * 60; wMin += 30) {
        if (wMin === bMin) continue;
        const crossMidnight = wMin < bMin;
        const oldDate = crossMidnight ? dateStr(base, 1) : dateStr(base, 0);
        const rec = {
          id: 'm',
          date: oldDate,
          bedtime: `${pad(Math.floor(bMin / 60))}:${pad(bMin % 60)}`,
          wakeTime: `${pad(Math.floor(wMin / 60))}:${pad(wMin % 60)}`,
          durationMinutes: 480,
          deepSleepMinutes: 90,
          lightSleepMinutes: 300,
          remSleepMinutes: 70,
          awakeMinutes: 10,
          sleepScore: 80,
          sleepEfficiency: 90,
          latencyMinutes: 10,
          wakeCount: 1,
        } as any;
        const got = migrateRecordDatesToNightKey([rec], 'night').records[0].date;
        const bedMs = new Date(2026, 9, 15, Math.floor(bMin / 60), bMin % 60).getTime();
        const want = nightKeyOfBed(bedMs, 'night');
        scanned++;
        if (got !== want && mismatches.length < 5) {
          mismatches.push(`${rec.bedtime}->${rec.wakeTime}: got=${got} want=${want}`);
        }
      }
    }

    expect(scanned).toBeGreaterThan(4000);
    expect(mismatches).toEqual([]);
  });

  it('补水解析遇到损坏 JSON 时保留原始备份并标记 corrupted=true', async () => {
    const broken = '{not valid json';
    storage.map.set('somnacare_sleep_records', broken);
    const res = await loadAndMigrateRecords();
    expect(res.corrupted).toBe(true);
    expect(res.records).toEqual([]);
    expect(storage.map.get('somnacare_sleep_records_backup_corrupted')).toBe(broken);
  });
});

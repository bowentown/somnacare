import { describe, it, expect } from 'vitest';
import { APP_THEMES } from '../../src/shared/theme/themeStyles';

describe('主题契约完整性（APP_THEMES）', () => {
  it('四套主题槽位一一对齐、非空，且 accentBg 不携带硬编码 text-white', () => {
    const entries = Object.entries(APP_THEMES);
    expect(entries.length).toBeGreaterThanOrEqual(4);

    const refKeys = Object.keys(entries[0][1]).sort();
    for (const [name, theme] of entries) {
      expect(Object.keys(theme).sort(), `${name} 槽位对齐`).toEqual(refKeys);
      for (const [k, v] of Object.entries(theme)) {
        expect(typeof v === 'string' && v.trim().length > 0, `${name}.${k} 非空`).toBe(true);
      }
      expect('accentFg' in theme, `${name} 含 accentFg`).toBe(true);
      expect(theme.accentBg, `${name}.accentBg 禁 text-white`).not.toContain('text-white');
    }
  });
});

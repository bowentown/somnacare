import { createStore } from './createStore';
import { DEFAULT_EYE_CARE, ProfileUpdater, UserProfile } from '../types/sleep';
import { APP_THEMES, ThemeConfig } from '../theme/themeStyles';
import { maskProfileSecrets, unmaskProfileSecrets } from '../utils/secretMask';
import { showToast } from './uiStore';

const PROFILE_KEY = 'somnacare_user_profile';

export function createDefaultProfile(): UserProfile {
  return {
    name: '体验用户',
    age: 28,
    targetBedtime: '23:30',
    targetWakeTime: '07:30',
    sleepRecordMode: 'manual',
    targetDurationHours: 8,
    smartAlarmEnabled: true,
    smartWakeWindowMinutes: 20,
    soundDetectionSensitivity: 'medium',
    themeColor: 'midnight',
    brightnessLevel: 100,
    warmthFilter: false,
    eyeCare: { ...DEFAULT_EYE_CARE },
    alarms: [
      {
        id: 'alarm-1',
        time: '07:30',
        label: '周内温和唤醒',
        enabled: true,
        repeatDays: [1, 2, 3, 4, 5],
        tone: 'gentle_chime',
        vibrate: true,
        smartWakeEnabled: true,
        smartWakeWindowMinutes: 20,
      },
      {
        id: 'alarm-2',
        time: '08:30',
        label: '周末舒缓起床',
        enabled: false,
        repeatDays: [6, 7],
        tone: 'aurora_melody',
        vibrate: true,
        smartWakeEnabled: true,
        smartWakeWindowMinutes: 20,
      },
    ],
    aiConfig: {
      provider: 'deepseek',
      deepseekModel: 'deepseek-flash',
      systemPersona:
        '你是一位资深临床睡眠医学与生物钟节律顾问。以温暖关切、科学严谨的语气为用户答疑，重点指导如何提升深度睡眠质量。',
    },
  };
}

export function loadInitialProfile(): UserProfile {
  try {
    const saved = typeof localStorage !== 'undefined' ? localStorage.getItem(PROFILE_KEY) : null;
    if (saved) {
      const parsedProfile = unmaskProfileSecrets(JSON.parse(saved) as UserProfile);
      if (Array.isArray(parsedProfile?.alarms)) {
        parsedProfile.alarms = parsedProfile.alarms.map((a) =>
          a.label === '工作日温和唤醒' ? { ...a, label: '周内温和唤醒' } : a,
        );
      }
      parsedProfile.eyeCare = { ...DEFAULT_EYE_CARE, ...(parsedProfile.eyeCare || {}) };
      parsedProfile.targetBedtime = parsedProfile.targetBedtime || '23:30';
      parsedProfile.targetWakeTime = parsedProfile.targetWakeTime || '07:30';
      parsedProfile.targetDurationHours = Number(parsedProfile.targetDurationHours) || 8;
      parsedProfile.sleepRecordMode = parsedProfile.sleepRecordMode === 'auto' ? 'auto' : 'manual';
      const legacyProvider = parsedProfile.aiConfig?.provider as string | undefined;
      if (legacyProvider === 'built_in' || legacyProvider === 'local_gemma') {
        parsedProfile.aiConfig = { ...(parsedProfile.aiConfig || {}), provider: 'local_rules' };
      }
      return parsedProfile;
    }
  } catch (e) {
    console.error('Failed to parse profile', e);
  }
  return createDefaultProfile();
}

export interface ProfileState {
  profile: UserProfile;
}

export const profileStore = createStore<ProfileState>({
  profile: loadInitialProfile(),
});

export const useProfileStore = profileStore.useStore;

export function getCurrentTheme(profile = profileStore.getState().profile): ThemeConfig {
  return APP_THEMES[(profile.themeColor || 'midnight') as keyof typeof APP_THEMES] || APP_THEMES.midnight;
}

export function updateProfile(updated: ProfileUpdater): void {
  const prev = profileStore.getState().profile;
  const patch = typeof updated === 'function' ? updated(prev) : updated;
  const next: UserProfile = { ...prev, ...patch };
  profileStore.setState({ profile: next });
  try {
    localStorage.setItem(PROFILE_KEY, JSON.stringify(maskProfileSecrets(next)));
  } catch (e) {
    console.warn('[storage] 用户档案写入失败', e);
    showToast('⚠️ 本机存储空间不足，设置修改重启后会丢失');
  }
}

/** 仅供单元测试复位（重新从当前 localStorage 载入） */
export function reloadProfileStore(): void {
  profileStore.setState({ profile: loadInitialProfile() });
}

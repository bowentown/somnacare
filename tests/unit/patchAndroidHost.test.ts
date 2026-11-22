import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  patchAndroidHost,
  patchFilePathsXml,
  patchGradleProperties,
  patchHostManifest,
  patchVariablesGradle,
} from '../../tools/patch-android-host.mts';

describe('patch-android-host 宿主结构化补丁', () => {
  it('正确修补 Capacitor 8.5 换行模板并保持幂等', () => {
    const dir = mkdtempSync(join(tmpdir(), 'somna-android-host-'));
    try {
      mkdirSync(join(dir, 'app/src/main/res/xml'), { recursive: true });
      writeFileSync(
        join(dir, 'app/src/main/res/xml/file_paths.xml'),
        '<?xml version="1.0" encoding="utf-8"?>\n<paths>\n    <external-path name="my_images" path="." />\n</paths>\n',
      );
      // Capacitor 8.5.x 真实格式：<application 后面紧跟换行
      writeFileSync(
        join(dir, 'app/src/main/AndroidManifest.xml'),
        `<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android">
    <application
        android:allowBackup="true"
        android:label="@string/app_name">
        <provider
            android:name="androidx.core.content.FileProvider"
            android:authorities="\${applicationId}.fileprovider" />
    </application>
</manifest>
`,
      );
      writeFileSync(
        join(dir, 'variables.gradle'),
        'ext {\n    minSdkVersion = 23\n    compileSdkVersion = 35\n}\n',
      );
      writeFileSync(join(dir, 'gradle.properties'), 'org.gradle.jvmargs=-Xmx1536m\n');

      const first = patchAndroidHost(dir);
      expect(first.filePathsUpdated).toBe(true);
      expect(first.manifestHardened).toBe(true);
      expect(first.minSdkVersion).toBe(24);
      expect(first.gradlePropsUpdated).toBe(true);

      const manifestAfter = readFileSync(join(dir, 'app/src/main/AndroidManifest.xml'), 'utf-8');
      expect(manifestAfter).toContain('android:allowBackup="false"');
      expect(manifestAfter).toContain('android:usesCleartextTraffic="false"');
      expect(manifestAfter).not.toContain('android:allowBackup="true"');

      const filePathsAfter = readFileSync(join(dir, 'app/src/main/res/xml/file_paths.xml'), 'utf-8');
      expect(filePathsAfter).toContain('name="somnacare_updates"');

      const propsAfter = readFileSync(join(dir, 'gradle.properties'), 'utf-8');
      expect(propsAfter).toContain('android.useAndroidX=true');
      expect(propsAfter).toContain('android.enableJetifier=true');

      // 第二次执行应完全幂等，不重复追加
      const second = patchAndroidHost(dir);
      expect(second.filePathsUpdated).toBe(false);
      expect(second.manifestHardened).toBe(false);
      expect(second.gradlePropsUpdated).toBe(false);
      expect(
        readFileSync(join(dir, 'app/src/main/res/xml/file_paths.xml'), 'utf-8')
          .split('somnacare_updates').length - 1,
      ).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('minSdkVersion 只升不降（模板为 26 时保持 26）', () => {
    const res = patchVariablesGradle('ext {\n    minSdkVersion = 26\n}\n', 24);
    expect(res.minSdkVersion).toBe(26);
    expect(res.content).toContain('minSdkVersion = 26');
  });

  it('无 allowBackup 声明的模板也能安全插入两项属性', () => {
    const out = patchHostManifest('<manifest><application android:label="x"></application></manifest>');
    expect(out).toContain('android:allowBackup="false"');
    expect(out).toContain('android:usesCleartextTraffic="false"');
  });

  it('缺失关键锚点时硬失败而不静默跳过', () => {
    expect(() => patchFilePathsXml('<paths></broken>')).toThrow(/<\/paths>/);
    expect(() => patchHostManifest('<manifest></manifest>')).toThrow(/<application>/);
    expect(() => patchVariablesGradle('ext {}')).toThrow(/minSdkVersion/);
  });

  it('patchGradleProperties 覆盖已有值且不重复行', () => {
    const out = patchGradleProperties('android.useAndroidX=false\n');
    expect(out.match(/android\.useAndroidX=/g)?.length).toBe(1);
    expect(out).toContain('android.useAndroidX=true');
    expect(out).toContain('android.enableJetifier=true');
  });
});

/**
 * Android 宿主工程结构化补丁脚本（Phase 3 替代 build-apk.yml 内百行脆弱 sed）。
 *
 * 各领域插件（cap-sleep-core / cap-sleep-widgets / cap-eye-care / cap-pet-overlay /
 * cap-ad-skip / cap-usage-signal）已在各自 AndroidManifest.xml 中声明
 * 权限、服务与接收器，交由 Android Gradle Plugin Manifest Merger 合并。
 *
 * 本脚本只负责无法下沉到插件的 4 项宿主级修补，并在修改后立即执行配对校验断言：
 *  1. res/xml/file_paths.xml：向 Capacitor 模板自带的 FileProvider 追加更新下载路径 somnacare_updates；
 *  2. app/src/main/AndroidManifest.xml：强制关闭 allowBackup="false" 与 usesCleartextTraffic="false"（安全审计 A2/A13）；
 *  3. variables.gradle：只升不降，保证 minSdkVersion >= 24；
 *  4. gradle.properties：幂等补齐 android.useAndroidX=true 与 android.enableJetifier=true。
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export interface PatchSummary {
  filePathsUpdated: boolean;
  manifestHardened: boolean;
  minSdkVersion: number;
  gradlePropsUpdated: boolean;
}

const UPDATES_PATH_ENTRY =
  '    <external-files-path name="somnacare_updates" path="Download/" />';

export function patchFilePathsXml(xml: string): string {
  if (xml.includes('name="somnacare_updates"')) return xml;
  if (!xml.includes('</paths>')) {
    throw new Error('file_paths.xml 缺少 </paths> 闭合锚点，拒绝静默跳过');
  }
  return xml.replace('</paths>', `${UPDATES_PATH_ENTRY}\n</paths>`);
}

export function patchHostManifest(manifest: string): string {
  const appTagRe = /<application\b([^>]*)>/;
  const match = manifest.match(appTagRe);
  if (!match) {
    throw new Error('AndroidManifest.xml 缺少 <application> 标签，无法应用安全加固');
  }

  let attrs = match[1];
  if (/android:allowBackup\s*=\s*"[^"]*"/.test(attrs)) {
    attrs = attrs.replace(/android:allowBackup\s*=\s*"[^"]*"/, 'android:allowBackup="false"');
  } else {
    attrs = `${attrs}\n        android:allowBackup="false"`;
  }

  if (/android:usesCleartextTraffic\s*=\s*"[^"]*"/.test(attrs)) {
    attrs = attrs.replace(
      /android:usesCleartextTraffic\s*=\s*"[^"]*"/,
      'android:usesCleartextTraffic="false"',
    );
  } else {
    attrs = `${attrs}\n        android:usesCleartextTraffic="false"`;
  }

  const next = manifest.replace(appTagRe, `<application${attrs}>`);
  if (!next.includes('android:allowBackup="false"') || !next.includes('android:usesCleartextTraffic="false"')) {
    throw new Error('AndroidManifest.xml 安全属性加固断言失败');
  }
  return next;
}

export function patchVariablesGradle(gradle: string, floor = 24): { content: string; minSdkVersion: number } {
  const re = /(minSdkVersion\s*=\s*)(\d+)/;
  const m = gradle.match(re);
  if (!m) {
    throw new Error('variables.gradle 缺少 minSdkVersion 定义');
  }
  const current = Number(m[2]);
  if (current >= floor) {
    return { content: gradle, minSdkVersion: current };
  }
  const next = gradle.replace(re, `$1${floor}`);
  return { content: next, minSdkVersion: floor };
}

export function patchGradleProperties(props: string): string {
  const lines = props.split(/\r?\n/);
  const ensure = (key: string, value: string): void => {
    const idx = lines.findIndex((l) => l.trim().startsWith(`${key}=`));
    if (idx >= 0) {
      lines[idx] = `${key}=${value}`;
    } else {
      lines.push(`${key}=${value}`);
    }
  };
  ensure('android.useAndroidX', 'true');
  ensure('android.enableJetifier', 'true');
  return lines.join('\n').replace(/\n*$/, '\n');
}

export function patchAndroidHost(androidDir: string): PatchSummary {
  const root = resolve(androidDir);
  const filePathsPath = join(root, 'app/src/main/res/xml/file_paths.xml');
  const manifestPath = join(root, 'app/src/main/AndroidManifest.xml');
  const variablesPath = join(root, 'variables.gradle');
  const gradlePropsPath = join(root, 'gradle.properties');

  for (const p of [filePathsPath, manifestPath, variablesPath]) {
    if (!existsSync(p)) {
      throw new Error(`Android 宿主文件缺失：${p}`);
    }
  }

  // 1. file_paths.xml
  const origFilePaths = readFileSync(filePathsPath, 'utf-8');
  const nextFilePaths = patchFilePathsXml(origFilePaths);
  writeFileSync(filePathsPath, nextFilePaths, 'utf-8');

  // 2. AndroidManifest.xml (A2 / A13)
  const origManifest = readFileSync(manifestPath, 'utf-8');
  const nextManifest = patchHostManifest(origManifest);
  writeFileSync(manifestPath, nextManifest, 'utf-8');

  // 3. variables.gradle (minSdk >= 24)
  const origVars = readFileSync(variablesPath, 'utf-8');
  const { content: nextVars, minSdkVersion } = patchVariablesGradle(origVars, 24);
  writeFileSync(variablesPath, nextVars, 'utf-8');

  // 4. gradle.properties
  const origProps = existsSync(gradlePropsPath) ? readFileSync(gradlePropsPath, 'utf-8') : '';
  const nextProps = patchGradleProperties(origProps);
  writeFileSync(gradlePropsPath, nextProps, 'utf-8');

  // 配对落地校验断言
  const verifiedFilePaths = readFileSync(filePathsPath, 'utf-8');
  const verifiedManifest = readFileSync(manifestPath, 'utf-8');
  const verifiedVars = readFileSync(variablesPath, 'utf-8');

  if (!verifiedFilePaths.includes('somnacare_updates')) {
    throw new Error('校验失败：file_paths.xml 未包含 somnacare_updates');
  }
  if (!verifiedManifest.includes('androidx.core.content.FileProvider')) {
    throw new Error('校验失败：宿主 AndroidManifest.xml 缺少模板 FileProvider');
  }
  if (!verifiedManifest.includes('android:allowBackup="false"')) {
    throw new Error('校验失败：宿主 AndroidManifest.xml 未关闭 allowBackup');
  }
  if (!verifiedManifest.includes('android:usesCleartextTraffic="false"')) {
    throw new Error('校验失败：宿主 AndroidManifest.xml 未关闭 usesCleartextTraffic');
  }
  const sdkCheck = verifiedVars.match(/minSdkVersion\s*=\s*(\d+)/);
  if (!sdkCheck || Number(sdkCheck[1]) < 24) {
    throw new Error(`校验失败：minSdkVersion 小于 24（实际：${sdkCheck?.[1] ?? '缺失'}）`);
  }

  return {
    filePathsUpdated: nextFilePaths !== origFilePaths,
    manifestHardened: nextManifest !== origManifest,
    minSdkVersion,
    gradlePropsUpdated: nextProps !== origProps,
  };
}

const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (invokedDirectly) {
  const dir = process.argv[2] || 'android';
  const summary = patchAndroidHost(dir);
  console.log(
    `✓ patch-android-host 完成 (${dir})：minSdk=${summary.minSdkVersion}, allowBackup=false, usesCleartextTraffic=false, somnacare_updates=ok`,
  );
}

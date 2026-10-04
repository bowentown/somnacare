/**
 * APK 构建链加固护栏（安全审计 A1/A2/A10 的回归锚）：
 *
 * 构建链问题在 Web 侧护栏里全部不可见——签名回退、allowBackup 缺失、
 * 锁文件绕过都只存在于 workflow 文本中。本护栏钉住：
 *  A1: 发布标签（refs/tags/v*）下缺签名 Secrets 必须 exit 1（debug 变体
 *      debuggable=true，绝不允许以正式版本号进公开 Release），且
 *      release-apk job 只接受 *apk/release/*.apk，找不到即硬失败；
 *  A2: manifest 注入包含 allowBackup="false" / usesCleartextTraffic="false"，
 *      且【sed 注入 + grep 断言】成对出现（缺断言 = 静默失配时照样产出
 *      可被 adb backup 的 APK）；
 *  A10: 主安装步骤优先 npm ci（锁文件精确解析，防供应链版本漂移）。
 *
 * 方法论约束：反向自检——删掉 A1 硬失败分支后同一断言路径必须报红。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const wf = readFileSync(join(ROOT, '.github', 'workflows', 'build-apk.yml'), 'utf-8');

function fail(msg: string): never {
  console.error('✗ verify-apk-build-hardening：' + msg);
  process.exit(1);
}

// A1：发布标签硬失败 + release job 只收 release 变体
const signingStep = wf.split('- name: Apply Fixed Signing Config')[1] ?? '';
if (!signingStep.includes('refs/tags/v*') || !signingStep.includes('exit 1'))
  fail('A1：签名步骤缺少"发布标签硬失败"分支（refs/tags/v* → exit 1）');
if (!wf.includes('find apk -path "*apk/release/*.apk"') || !wf.includes('未找到 release 变体 APK'))
  fail('A1：release-apk job 未收紧为只接受 release 变体 APK');

// A2：allowBackup / usesCleartextTraffic 注入与断言成对出现（各 ≥2 处）
for (const attr of ['android:allowBackup="false"', 'android:usesCleartextTraffic="false"']) {
  const hits = wf.split('\n').filter((l) => l.includes(attr)).length;
  if (hits < 2) fail(`A2：${attr} 需要同时出现 sed 注入与 grep 断言（实际 ${hits} 处）`);
}

// A10：npm ci 优先（锁文件精确解析）
if (!wf.includes('npm ci --legacy-peer-deps || npm install --legacy-peer-deps'))
  fail('A10：主安装步骤未优先 npm ci（锁文件精确解析）');

// 反向自检：删掉 A1 硬失败分支后，同一断言路径必须失去判据
{
  const doctored = wf.replace(
    /if \[\[ "\$\{GITHUB_REF\}" == refs\/tags\/v\* \]\]; then[\s\S]*?fi\n/,
    ''
  );
  if (doctored === wf) fail('反向自检失败：硬失败分支删除操作未命中');
  const doctoredStep = doctored.split('- name: Apply Fixed Signing Config')[1] ?? '';
  if (doctoredStep.includes('refs/tags/v*') && doctoredStep.includes('exit 1')) {
    fail('反向自检失败：删除硬失败分支后判据仍在，断言不可信');
  }
}

console.log('✓ verify-apk-build-hardening：A1 签名硬失败 / A2 备份关闭 / A10 npm ci 全部在位');

import React, { useMemo } from 'react';
import { ThemeConfig } from '../../utils/themeStyles';

// unDraw 插画（unDraw 许可：免费商用、无需署名；见 assets/illustrations/LICENSE-NOTE.md）。
// 镜像已把 unDraw 标准主色规范化为 var(--primary-svg-color)，
// 主题适配 = 在容器上设该变量为当前主题强调色。
import noData from '../../assets/illustrations/no-data.svg?raw';
import lateAtNight from '../../assets/illustrations/late-at-night.svg?raw';
import screenTime from '../../assets/illustrations/screen-time.svg?raw';
import meditation from '../../assets/illustrations/meditation.svg?raw';
import healthyHabit from '../../assets/illustrations/healthy-habit.svg?raw';
import aMomentToRelax from '../../assets/illustrations/a-moment-to-relax.svg?raw';

export type IllustrationName =
  | 'no-data'
  | 'late-at-night'
  | 'screen-time'
  | 'meditation'
  | 'healthy-habit'
  | 'a-moment-to-relax';

const RAW: Record<IllustrationName, string> = {
  'no-data': noData,
  'late-at-night': lateAtNight,
  'screen-time': screenTime,
  meditation: meditation,
  'healthy-habit': healthyHabit,
  'a-moment-to-relax': aMomentToRelax,
};

/** 主题化 unDraw 插画：主色随主题强调色，宽度自适应容器 */
export const Illustration: React.FC<{
  name: IllustrationName;
  theme: ThemeConfig;
  className?: string;
  maxHeight?: number;
}> = ({ name, theme, className = '', maxHeight = 150 }) => {
  // unDraw 的根 <svg> 只有 viewBox 没有尺寸属性，默认铺满容器宽、高度按
  // 纵横比失控溢出——注入尺寸约束让它等比缩到 maxHeight 内并居中
  const html = useMemo(
    () => RAW[name].replace(
      '<svg ',
      `<svg style="max-height:${maxHeight}px;width:auto;max-width:100%;height:auto;" `,
    ),
    [name, maxHeight],
  );
  return (
    <div
      className={`pointer-events-none select-none flex justify-center ${className}`}
      style={
        {
          // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
          '--primary-svg-color': theme.accentHex,
        } as React.CSSProperties
      }
      aria-hidden="true"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
};

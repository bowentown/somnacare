import React, { Component, ErrorInfo, ReactNode } from 'react';

/**
 * 分区级错误边界（第 52 轮）：此前只有根级边界——一张坏记录的渲染
 * 错误会把全部五个分区一起拖垮变成错误页。包在分区内容外层后，损坏
 * 只影响它所在的分区，其余四分区照常可用。
 *
 * 与根级边界刻意的区别：不提供 localStorage.clear 逃生口（那是核弹级
 * 操作，只留给根级），只提供"重试本分区"——渲染错误多由一次性状态
 * 引起，重试（重新渲染）即可恢复。
 */
interface Props {
  children: ReactNode;
  /** 分区名（错误卡文案用） */
  label: string;
}

interface State {
  hasError: boolean;
  error: Error | null;
  retries: number;
}

export class PaneErrorBoundary extends Component<Props, State> {
  public state: State = { hasError: false, error: null, retries: 0 };

  public static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error, retries: 0 };
  }

  public componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error(`[${this.props.label}] 分区渲染错误:`, error, errorInfo);
  }

  private handleRetry = () => {
    // 重试 = 重新挂载分区内容（key 递增强制子树重建）
    this.setState((s) => ({ hasError: false, error: null, retries: s.retries + 1 }));
  };

  public render() {
    if (this.state.hasError) {
      return (
        <div className="rounded-3xl border border-amber-500/40 bg-amber-950/30 p-5 space-y-2 text-center">
          <p className="text-sm font-black text-amber-300">{this.props.label}暂时打不开</p>
          <p className="text-[11px] text-slate-400 leading-relaxed">
            这一分区的数据显示出了问题，其他分区不受影响。
            {this.state.error?.message && (
              <span className="block mt-1 font-mono text-[10px] text-slate-500 break-all">
                {this.state.error.message}
              </span>
            )}
          </p>
          <button
            type="button"
            onClick={this.handleRetry}
            className="px-4 py-2 rounded-xl bg-slate-800 border border-slate-600 text-white text-xs font-bold cursor-pointer active:scale-95 transition-transform"
          >
            重试本分区
          </button>
        </div>
      );
    }
    // key 递增：重试时强制重建子树（彻底重置内部状态，而非复用出错前的树）
    return <React.Fragment key={this.state.retries}>{this.props.children}</React.Fragment>;
  }
}

import React, { Component, ErrorInfo, ReactNode } from 'react';

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  public state: State = {
    hasError: false,
    error: null,
  };

  public static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  public componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error('Uncaught error in SomnaCare:', error, errorInfo);
  }

  private handleReload = () => {
    window.location.reload();
  };

  // 最后的逃生口：崩溃可能由 localStorage 里的坏数据引起，重载只会读到
  // 同一份坏数据再次崩溃（死循环）。给用户一条真正能出去的路。
  private handleReset = () => {
    try { localStorage.clear(); } catch { /* ignore */ }
    window.location.reload();
  };

  public render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen bg-[#070a12] text-white flex flex-col items-center justify-center p-6 text-center">
          <div className="w-12 h-12 rounded-2xl bg-indigo-600/30 text-indigo-400 flex items-center justify-center text-xl mb-4 border border-indigo-500/40">
            🌙
          </div>
          <h2 className="text-lg font-bold mb-2">应用界面出现小状况</h2>
          <p className="text-xs text-slate-400 mb-4 max-w-xs leading-relaxed">
            本地数据可能已损坏。可先尝试重新加载；若反复出现此页面，请重置本地数据
            （会清除睡眠记录，若此前导出过备份可随后从【偏好】导入恢复）。
          </p>
          <button
            type="button"
            onClick={this.handleReload}
            className="px-5 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-bold transition-all shadow-lg"
          >
            重新加载应用
          </button>
          <button
            type="button"
            onClick={this.handleReset}
            className="mt-3 px-5 py-2.5 rounded-xl bg-slate-800 border border-slate-600 text-slate-300 text-xs font-bold transition-all cursor-pointer hover:border-rose-500 hover:text-rose-300"
          >
            重置本地数据并重启
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}

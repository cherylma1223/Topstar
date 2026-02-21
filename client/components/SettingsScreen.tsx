import React from 'react';

interface SettingsScreenProps {
  onBack: () => void;
  onNavigateToAppearance: () => void;
  followSystem: boolean;
  appearanceMode: 'dark' | 'light';
  isAutoReadEnabled: boolean;
  onToggleAutoRead: (val: boolean) => void;
  isAutoAnalyzeEnabled: boolean;
  onToggleAutoAnalyze: (val: boolean) => void;
}

const SettingsScreen: React.FC<SettingsScreenProps> = ({ 
  onBack, 
  onNavigateToAppearance,
  followSystem,
  appearanceMode,
  isAutoReadEnabled,
  onToggleAutoRead,
  isAutoAnalyzeEnabled,
  onToggleAutoAnalyze
}) => {
  const getAppearanceLabel = () => {
    return appearanceMode === 'dark' ? "深色模式" : "浅色模式";
  };

  return (
    <div className="flex flex-col h-full bg-slate-50 dark:bg-background-dark animate-fade-in-up overflow-y-auto no-scrollbar transition-colors">
      <div className="p-6 space-y-6 pb-[calc(100px+env(safe-area-inset-bottom))]">
        
        {/* 用户信息与积分展示 */}
        <div className="flex items-center gap-4 bg-white dark:bg-surface-dark p-5 rounded-2xl border border-slate-100 dark:border-white/5 shadow-sm transition-colors relative group/user active:bg-slate-50 dark:active:bg-white/5 cursor-pointer">
          <div className="size-16 rounded-full bg-gradient-to-br from-blue-500 to-purple-600 flex items-center justify-center text-2xl font-bold text-white shadow-lg shrink-0">
            樊
          </div>
          <div className="flex-1 min-w-0">
            <h2 className="text-slate-900 dark:text-white font-bold text-lg truncate tracking-tight">樊振东</h2>
            <div className="flex items-center gap-3 mt-1">
              <span className="text-slate-500 dark:text-text-secondary text-[13px] font-medium opacity-80">剩余积分：100</span>
              <button className="flex items-center gap-0.5 text-primary dark:text-blue-400 text-[13px] font-bold hover:underline active:opacity-70 transition-all">
                充值 <span className="material-symbols-outlined text-[14px]">chevron_right</span>
              </button>
            </div>
          </div>
          <span className="material-symbols-outlined text-slate-300 dark:text-white/10 text-[20px]">chevron_right</span>
        </div>

        {/* VIP 会员入口卡片 */}
        <div className="rounded-2xl overflow-hidden shadow-2xl border border-white/5 active:scale-[0.99] transition-transform cursor-pointer group relative">
          <div className="bg-gradient-to-br from-[#1a1c2c] to-[#1e2a33] dark:from-[#161d2a] dark:to-[#1e2933] p-5 flex items-center justify-between relative overflow-hidden min-h-[120px] gap-2">
            <div className="absolute top-0 right-0 w-32 h-full bg-blue-500/20 blur-[40px] pointer-events-none rounded-l-full"></div>
            
            <div className="flex flex-col relative z-10 flex-1 min-w-0">
               <div className="flex items-center gap-2">
                 <span className="italic font-black text-2xl text-blue-400 leading-none tracking-tighter drop-shadow-[0_0_8px_rgba(96,165,250,0.5)]">VIP</span>
                 <span className="text-white font-bold text-base tracking-wide truncate">开通 AI 尊享会员</span>
               </div>
               <span className="text-white/60 text-[10px] sm:text-[11px] mt-4 font-bold tracking-tight flex items-center gap-2 whitespace-nowrap overflow-hidden">
                  <span>无限额度</span>
                  <span className="opacity-30">·</span>
                  <span>线下特训</span>
                  <span className="opacity-30">·</span>
                  <span>器材折扣</span>
               </span>
            </div>
            
            <div className="relative z-10 shrink-0">
              <button className="bg-gradient-to-r from-blue-500 to-blue-700 text-white px-4 py-2 rounded-full font-bold text-[13px] shadow-lg shadow-blue-500/30 active:opacity-90 transition-all">
                立即开通
              </button>
            </div>
          </div>
        </div>

        {/* 账号与安全 */}
        <section className="space-y-3">
          <h3 className="text-[12px] font-bold text-slate-400 dark:text-white/25 uppercase tracking-wider px-1">账号与安全</h3>
          <div className="bg-white dark:bg-surface-dark rounded-2xl border border-slate-100 dark:border-white/5 overflow-hidden shadow-sm transition-colors">
            <SettingsItem icon="person" label="个人资料" />
            <SettingsItem icon="shield" label="账号安全" />
            <SettingsItem icon="notifications" label="通知设置" showBorder={false} />
          </div>
        </section>

        {/* 通用设置 */}
        <section className="space-y-3">
          <h3 className="text-[12px] font-bold text-slate-400 dark:text-white/25 uppercase tracking-wider px-1">通用设置</h3>
          <div className="bg-white dark:bg-surface-dark rounded-2xl border border-slate-100 dark:border-white/5 overflow-hidden shadow-sm transition-colors">
            {/* 这里的顺序已根据用户要求交换 */}
            <SettingsToggle 
              icon="slow_motion_video" 
              label="自动分析视频" 
              checked={isAutoAnalyzeEnabled}
              onChange={onToggleAutoAnalyze}
            />
            <SettingsToggle 
              icon="volume_up" 
              label="自动朗读生成结果" 
              checked={isAutoReadEnabled} 
              onChange={onToggleAutoRead} 
            />
            <SettingsItem icon="language" label="语言选择" value="简体中文" />
            <SettingsItem 
              icon="dark_mode" 
              label="外观" 
              value={getAppearanceLabel()}
              showBorder={false} 
              onClick={onNavigateToAppearance}
            />
          </div>
        </section>

        {/* 更多 */}
        <section className="space-y-3">
          <h3 className="text-[12px] font-bold text-slate-400 dark:text-white/25 uppercase tracking-wider px-1">更多</h3>
          <div className="bg-white dark:bg-surface-dark rounded-2xl border border-slate-100 dark:border-white/5 overflow-hidden shadow-sm transition-colors">
            <SettingsItem icon="help" label="帮助与反馈" />
            <SettingsItem icon="info" label="关于我们" />
            <SettingsItem icon="policy" label="隐私政策" showBorder={false} />
          </div>
        </section>

        <button className="w-full py-4 text-red-500 font-bold text-sm bg-red-500/5 hover:bg-red-500/10 border border-red-500/10 rounded-2xl transition-all active:scale-[0.98] mt-4 mb-8">
          退出登录
        </button>
      </div>
    </div>
  );
};

const SettingsItem: React.FC<{ icon: string, label: string, value?: string, showBorder?: boolean, onClick?: () => void }> = ({ icon, label, value, showBorder = true, onClick }) => (
  <button 
    onClick={onClick}
    className={`w-full flex items-center gap-4 px-5 py-4 hover:bg-slate-50 dark:hover:bg-white/5 transition-colors active:bg-slate-100 dark:active:bg-white/10 group ${showBorder ? 'border-b border-slate-50 dark:border-white/5' : ''}`}
  >
    <div className="size-8 rounded-lg bg-gradient-to-br from-blue-400 to-purple-500 flex items-center justify-center shrink-0 shadow-sm opacity-90 group-hover:opacity-100 transition-opacity">
      <span className="material-symbols-outlined text-[20px] text-white" style={{ fontVariationSettings: "'FILL' 0" }}>
        {icon}
      </span>
    </div>
    <span className="flex-1 text-left text-[15px] text-slate-800 dark:text-white/80 font-medium">{label}</span>
    {value && (
      <span className="text-[13px] text-slate-400 dark:text-white/30 font-medium mr-1">{value}</span>
    )}
    <span className="material-symbols-outlined text-slate-300 dark:text-white/10 text-[20px]">chevron_right</span>
  </button>
);

const SettingsToggle: React.FC<{ 
  icon: string, 
  label: string, 
  defaultChecked?: boolean,
  checked?: boolean,
  onChange?: (val: boolean) => void 
}> = ({ icon, label, defaultChecked = false, checked, onChange }) => {
  const [internalChecked, setInternalChecked] = React.useState(defaultChecked);
  const isChecked = checked !== undefined ? checked : internalChecked;

  const handleToggle = () => {
    const newVal = !isChecked;
    if (onChange) {
      onChange(newVal);
    } else {
      setInternalChecked(newVal);
    }
  };

  return (
    <div className="w-full flex items-center gap-4 px-5 py-4 border-b border-slate-50 dark:border-white/5">
      <div className="size-8 rounded-lg bg-gradient-to-br from-blue-400 to-purple-500 flex items-center justify-center shrink-0 shadow-sm opacity-90">
        <span className="material-symbols-outlined text-[20px] text-white" style={{ fontVariationSettings: "'FILL' 0" }}>
          {icon}
        </span>
      </div>
      <span className="flex-1 text-left text-[15px] text-slate-800 dark:text-white/80 font-medium">{label}</span>
      <button 
        onClick={handleToggle}
        className={`w-11 h-6 rounded-full transition-all relative ${isChecked ? 'bg-primary' : 'bg-slate-200 dark:bg-white/10'}`}
      >
        <div className={`absolute top-1 size-4 rounded-full bg-white transition-all shadow-sm ${isChecked ? 'left-6' : 'left-1'}`}></div>
      </button>
    </div>
  );
};

export default SettingsScreen;
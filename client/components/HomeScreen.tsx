
import React from 'react';

interface HomeScreenProps {
  onStartAnalysis: (title: string, icon: string, initialText?: string) => void;
  hasEngaged: boolean;
  onPlayVideo: (url: string) => void;
}

const HomeScreen: React.FC<HomeScreenProps> = ({ onStartAnalysis, hasEngaged, onPlayVideo }) => {
  const chips = [
    { text: "器材推荐", icon: "inventory_2", color: "bg-gradient-to-br from-[#6366f1] to-[#138eec] bg-clip-text text-transparent" },
    { text: "接发球技巧", icon: "sports_tennis", color: "text-primary" },
    { text: "正手拉球要领", icon: "model_training", color: "text-sky-400" }
  ];

  const handleVideoClick = () => {
    onPlayVideo('https://drive.google.com/file/d/13VkToMh1kvnbKRhHsLlgJ_D_WaT-Eef0/view?usp=sharing');
  };

  return (
    <div className="flex flex-col h-full animate-fade-in-up overflow-hidden">
      <div className="flex-1 overflow-y-auto no-scrollbar p-6 pb-48">
        {/* 技术分享 */}
        <div className="mb-8">
          <div className="flex items-center justify-between mb-3 px-1">
            <h3 className="text-sm font-bold text-slate-800 dark:text-white flex items-center gap-2">
              <span 
                className="material-symbols-outlined text-primary text-lg drop-shadow-[0_0_10px_rgba(19,142,236,0.9)] transition-all duration-500"
                style={{ fontVariationSettings: "'FILL' 1, 'wght' 400, 'GRAD' 0, 'opsz' 24" }}
              >
                lightbulb
              </span>
              技术分享
            </h3>
          </div>
          <div 
            onClick={handleVideoClick}
            className="relative group w-full aspect-[21/9] rounded-2xl overflow-hidden border border-slate-200 dark:border-white/10 shadow-2xl cursor-pointer active:scale-[0.99] transition-transform"
          >
            <img 
              src="https://img1.baidu.com/it/u=3325220246,268389528&fm=253&fm=auto&app=138&f=JPEG?w=889&h=500" 
              alt="反手霸王拧" 
              className="w-full h-full object-cover opacity-90 group-hover:scale-105 transition-transform duration-700 bg-slate-200 dark:bg-surface-dark"
            />
            <div className="absolute inset-0 bg-gradient-to-t from-slate-900/60 dark:from-background-dark via-transparent to-transparent"></div>
            <div className="absolute inset-0 flex items-center justify-center">
              <div className="size-12 rounded-full bg-white/20 backdrop-blur-md flex items-center justify-center border border-white/30">
                <span className="material-symbols-outlined text-white text-3xl ml-1">play_arrow</span>
              </div>
            </div>
            <div className="absolute bottom-4 left-4 right-4">
              <h4 className="text-white text-base font-bold tracking-wide drop-shadow-lg">反手霸王拧</h4>
              <p className="text-[11px] text-white/90 mt-0.5 font-medium drop-shadow-md">代表人物：张继科</p>
            </div>
          </div>
        </div>

        {/* AI教练板块 */}
        <div className="mb-4 px-1">
          <h3 className="text-sm font-bold text-slate-800 dark:text-white flex items-center gap-2">
            <span 
              className="material-symbols-outlined text-primary text-lg drop-shadow-[0_0_10px_rgba(19,142,236,0.9)] transition-all duration-500"
              style={{ fontVariationSettings: "'FILL' 1, 'wght' 400, 'GRAD' 0, 'opsz' 24" }}
            >
              psychology
            </span>
            AI教练
          </h3>
        </div>

        <div className="w-full flex flex-col gap-3 mb-8">
          <ActionCard 
            icon="slow_motion_video" 
            title="技术动作分析" 
            desc="智能诊断技术问题" 
            iconClassName="bg-gradient-to-br from-[#818cf8] to-[#138eec] bg-clip-text text-transparent"
            onClick={() => onStartAnalysis("技术动作分析", "slow_motion_video")}
          />
          <ActionCard 
            icon="person" 
            title="AI 场外指导" 
            desc="上传视频，秒出战术" 
            iconClassName="bg-gradient-to-br from-[#6366f1] to-[#138eec] bg-clip-text text-transparent"
            onClick={() => onStartAnalysis("AI 场外指导", "person")}
          />
        </div>

        {/* Suggestion Chips */}
        <div className="flex gap-2 overflow-x-auto no-scrollbar py-2">
          {chips.map((chip, idx) => {
            const isClickable = chip.text === "器材推荐";
            return (
              <button 
                key={idx}
                onClick={() => {
                  if (isClickable) {
                    onStartAnalysis(chip.text, chip.icon);
                  }
                }}
                className={`whitespace-nowrap px-4 py-2.5 bg-white dark:bg-background-dark/50 text-slate-600 dark:text-text-secondary border border-slate-200 dark:border-white/10 rounded-xl text-xs font-medium transition-all flex items-center gap-2 shadow-sm shrink-0 ${isClickable ? 'hover:bg-slate-50 dark:hover:bg-white/5 hover:text-primary dark:hover:text-white active:scale-95' : 'opacity-60 cursor-default'}`}
              >
                <span className={`material-symbols-outlined text-[16px] ${chip.color}`}>{chip.icon}</span>
                {chip.text}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
};

const ActionCard: React.FC<{ 
  icon: string; 
  title: string; 
  desc: string; 
  iconClassName: string; 
  containerClassName?: string;
  onClick: () => void 
}> = ({ icon, title, desc, iconClassName, containerClassName, onClick }) => (
  <button 
    onClick={onClick}
    className="w-full text-left bg-white dark:bg-surface-dark hover:bg-slate-50 dark:hover:bg-surface-lighter border border-slate-100 dark:border-white/5 rounded-2xl p-5 flex items-center gap-5 active:scale-[0.98] transition-all duration-200 group shadow-md dark:shadow-lg"
  >
    <div className={`size-14 rounded-2xl ${containerClassName ? containerClassName : 'bg-slate-100 dark:bg-white/5 border border-slate-200 dark:border-white/5'} flex items-center justify-center shrink-0 group-hover:bg-white dark:group-hover:bg-white/10 transition-colors shadow-inner`}>
      <span className={`material-symbols-outlined text-[32px] ${iconClassName}`}>{icon}</span>
    </div>
    <div className="flex-1 min-w-0">
      <h3 className="text-lg font-bold text-slate-900 dark:text-white/95">{title}</h3>
      <p className="text-xs text-slate-500 dark:text-text-secondary mt-1 font-light truncate">{desc}</p>
    </div>
    <span className="material-symbols-outlined text-slate-300 dark:text-white/10 group-hover:text-primary dark:group-hover:text-white/40 transition-colors">arrow_forward_ios</span>
  </button>
);

export default HomeScreen;

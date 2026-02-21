import React, { useState, useEffect } from 'react';

const ProcessingCard: React.FC = () => {
  const [progress, setProgress] = useState(0);

  useEffect(() => {
    const interval = setInterval(() => {
      setProgress(prev => (prev < 90 ? prev + Math.floor(Math.random() * 10) : prev));
    }, 400);
    return () => clearInterval(interval);
  }, []);

  return (
    <div className="bg-slate-100 dark:bg-bubble-ai text-slate-800 dark:text-white/90 p-5 rounded-2xl rounded-tl-none shadow-md dark:shadow-xl border border-slate-200 dark:border-white/5 relative overflow-hidden w-full group transition-colors">
      <div className="absolute -top-10 -right-10 w-40 h-40 bg-primary/5 dark:bg-primary/10 rounded-full blur-3xl pointer-events-none group-hover:bg-primary/10 dark:group-hover:bg-primary/20 transition-colors"></div>
      
      <div className="flex items-center gap-3 mb-5 relative z-10">
        <div className="w-9 h-9 rounded-full bg-gradient-to-br from-primary/20 to-purple-500/20 dark:from-primary/30 dark:to-purple-500/30 flex items-center justify-center relative">
          <span className="absolute inset-0 rounded-full bg-primary/20 animate-ping opacity-75"></span>
          <span className="material-symbols-outlined text-primary text-xl drop-shadow relative z-10">smart_toy</span>
        </div>
        <div>
          <p className="text-sm font-bold text-slate-900 dark:text-white tracking-wide">AI正在分析视频</p>
        </div>
      </div>

      <div className="relative w-full h-3 bg-slate-200 dark:bg-black/40 rounded-full overflow-hidden mb-3 ring-1 ring-slate-300 dark:ring-white/5">
        <div 
          className="absolute left-0 top-0 bottom-0 bg-gradient-to-r from-primary via-[#4d8eff] to-purple-500 rounded-full transition-all duration-500 ease-out shadow-[0_0_15px_rgba(19,142,236,0.6)]"
          style={{ width: `${progress}%` }}
        >
          <div className="absolute inset-0 bg-gradient-to-r from-transparent via-white/40 to-transparent w-full -translate-x-full animate-shimmer"></div>
        </div>
      </div>

      <div className="flex justify-end items-center text-[10px] text-slate-400 dark:text-text-secondary font-mono relative z-10">
        <span className="text-slate-900 dark:text-white font-bold text-xs">{progress}%</span>
      </div>
    </div>
  );
};

export default ProcessingCard;
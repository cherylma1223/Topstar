import React, { useState } from 'react';
import { AppScreen } from '../types.ts';

interface HistoryEntry {
  id: string;
  title: string;
  time: string;
  section: 'recent' | 'earlier';
}

interface SidebarProps {
  isOpen: boolean;
  onClose: () => void;
  onNavigate: (screen: AppScreen) => void;
  onSettingsClick: () => void;
  historyItems: HistoryEntry[];
}

const Sidebar: React.FC<SidebarProps> = ({ isOpen, onClose, onNavigate, onSettingsClick, historyItems }) => {
  const [searchTerm, setSearchTerm] = useState('');

  const filteredEntries = historyItems.filter(entry => 
    entry.title.toLowerCase().includes(searchTerm.toLowerCase())
  );

  const recentItems = filteredEntries.filter(e => e.section === 'recent');
  const earlierItems = filteredEntries.filter(e => e.section === 'earlier');

  return (
    <>
      <div 
        className={`absolute inset-0 bg-black/40 dark:bg-black/80 z-[190] backdrop-blur-[2px] transition-opacity duration-300 ${isOpen ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}
        onClick={onClose}
      />
      
      <aside className={`absolute top-0 left-0 z-[200] h-full w-[280px] bg-white dark:bg-surface-dark border-r border-slate-100 dark:border-white/10 flex flex-col shadow-xl transition-transform duration-300 ease-in-out ${isOpen ? 'translate-x-0' : '-translate-x-full'}`}>
        <div className="h-16 px-5 flex items-center justify-between border-b border-slate-50 dark:border-white/5 shrink-0 pt-4">
          <span className="text-slate-900 dark:text-white font-bold text-lg font-display tracking-tight">历史对话</span>
          <button 
            onClick={onClose} 
            className="p-2 rounded-full hover:bg-slate-100 dark:hover:bg-white/10 text-slate-400 dark:text-white/40 active:scale-90 transition-all"
          >
            <span className="material-symbols-outlined text-[24px]">close</span>
          </button>
        </div>

        <div className="px-4 py-4 shrink-0">
          <div className="relative flex items-center bg-slate-100 dark:bg-background-dark/50 border border-slate-200 dark:border-white/10 rounded-xl px-3 py-2.5 focus-within:border-primary/50 transition-all shadow-inner">
            <span className="material-symbols-outlined text-slate-400 dark:text-white/30 text-[20px] mr-2">search</span>
            <input 
              type="text"
              placeholder="搜索历史对话..."
              className="bg-transparent border-none text-[13px] text-slate-900 dark:text-white placeholder-slate-400 dark:placeholder-white/20 focus:ring-0 w-full p-0"
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
            />
          </div>
        </div>
        
        <div className="flex-1 overflow-y-auto p-4 pt-2 space-y-6 no-scrollbar">
          {recentItems.length > 0 && (
            <div>
              <p className="text-[11px] font-bold text-slate-400 dark:text-white/25 mb-3 px-1 uppercase tracking-wider">最近</p>
              <div className="space-y-1">
                {recentItems.map(item => (
                  <HistoryItem 
                    key={item.id}
                    title={item.title} 
                    time={item.time} 
                    onClick={() => onNavigate(AppScreen.CHAT)}
                  />
                ))}
              </div>
            </div>
          )}
          
          {earlierItems.length > 0 && (
            <div>
              <p className="text-[11px] font-bold text-slate-400 dark:text-white/25 mb-3 px-1 uppercase tracking-wider">更早</p>
              <div className="space-y-1">
                {earlierItems.map(item => (
                  <HistoryItem 
                    key={item.id}
                    title={item.title} 
                    time={item.time} 
                    onClick={() => onNavigate(AppScreen.CHAT)}
                  />
                ))}
              </div>
            </div>
          )}

          {filteredEntries.length === 0 && (
            <div className="py-10 text-center">
              <span className="material-symbols-outlined text-slate-200 dark:text-white/10 text-4xl block mb-2">history_toggle_off</span>
              <p className="text-xs text-slate-400 italic">未找到匹配记录</p>
            </div>
          )}
        </div>

        <div className="px-4 py-2.5 border-t border-slate-100 dark:border-white/5 bg-slate-50 dark:bg-background-dark/40 pb-[calc(0.6rem+env(safe-area-inset-bottom))]">
          <div className="flex items-center gap-3 p-1.5 rounded-xl hover:bg-slate-100 dark:hover:bg-white/5 transition-colors cursor-pointer group">
            <div className="size-8 rounded-full bg-gradient-to-br from-primary to-purple-500 p-[1px] shadow-md shadow-primary/10">
              <div className="w-full h-full rounded-full bg-slate-100 dark:bg-surface-dark flex items-center justify-center text-[10px] font-bold text-slate-800 dark:text-white group-hover:bg-primary/20 transition-colors">樊</div>
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-[13px] font-semibold text-slate-800 dark:text-white truncate tracking-wide">樊振东</div>
            </div>
            <button 
              onClick={onSettingsClick}
              className="p-1 rounded-lg hover:bg-slate-200 dark:hover:bg-white/10 transition-all active:scale-90"
            >
              <span className="material-symbols-outlined text-slate-400 dark:text-white/20 text-[20px] group-hover:text-primary transition-colors">settings</span>
            </button>
          </div>
        </div>
      </aside>
    </>
  );
};

const HistoryItem: React.FC<{ title: string; time: string; onClick: () => void }> = ({ title, time, onClick }) => (
  <button 
    onClick={onClick}
    className="w-full text-left px-3 py-2.5 rounded-xl hover:bg-slate-100 dark:hover:bg-white/5 active:bg-slate-200 dark:active:bg-white/10 transition-all flex items-center justify-between gap-3 group overflow-hidden"
  >
    <div className="flex-1 min-w-0">
      <h4 className="text-[13px] font-medium text-slate-600 dark:text-white/70 group-hover:text-slate-900 dark:group-hover:text-white transition-colors truncate leading-relaxed">
        {title}
      </h4>
    </div>
    <span className="text-[10px] text-slate-400 dark:text-white/20 font-medium whitespace-nowrap shrink-0">
      {time}
    </span>
  </button>
);

export default Sidebar;
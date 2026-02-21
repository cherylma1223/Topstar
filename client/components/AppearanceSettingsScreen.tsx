import React from 'react';

interface AppearanceSettingsScreenProps {
  onBack: () => void;
  appearanceMode: 'dark' | 'light';
  setAppearanceMode: (mode: 'dark' | 'light') => void;
}

const AppearanceSettingsScreen: React.FC<AppearanceSettingsScreenProps> = ({ 
  onBack,
  appearanceMode,
  setAppearanceMode
}) => {
  return (
    <div className="flex flex-col h-full bg-slate-50 dark:bg-background-dark animate-fade-in-up overflow-y-auto no-scrollbar transition-colors">
      <div className="p-6 space-y-8 pb-[calc(100px+env(safe-area-inset-bottom))]">
        
        <section className="mt-2">
          <div className="bg-white dark:bg-surface-dark rounded-2xl border border-slate-100 dark:border-white/5 overflow-hidden shadow-md dark:shadow-lg transition-colors">
            <SelectionItem 
              label="深色模式" 
              selected={appearanceMode === 'dark'} 
              onClick={() => setAppearanceMode('dark')} 
            />
            <SelectionItem 
              label="浅色模式" 
              selected={appearanceMode === 'light'} 
              onClick={() => setAppearanceMode('light')} 
              showBorder={false}
            />
          </div>
        </section>

      </div>
    </div>
  );
};

const SelectionItem: React.FC<{ 
  label: string, 
  selected: boolean, 
  onClick: () => void, 
  showBorder?: boolean 
}> = ({ label, selected, onClick, showBorder = true }) => (
  <button 
    onClick={onClick}
    className={`w-full flex items-center gap-4 px-5 py-4 hover:bg-slate-50 dark:hover:bg-white/5 transition-colors active:bg-slate-100 dark:active:bg-white/10 group ${showBorder ? 'border-b border-slate-50 dark:border-white/5' : ''}`}
  >
    <div className={`size-5 rounded-full border flex items-center justify-center transition-all ${selected ? 'border-primary bg-primary/5' : 'border-slate-200 dark:border-white/20 bg-slate-50 dark:bg-background-dark/30'}`}>
      {selected && <div className="size-2.5 rounded-full bg-primary shadow-[0_0_8px_rgba(19,142,236,0.6)]"></div>}
    </div>
    <span className={`flex-1 text-left text-[14px] transition-colors ${selected ? 'text-slate-900 dark:text-white font-bold' : 'text-slate-500 dark:text-white/60'}`}>{label}</span>
    {selected && (
      <span className="material-symbols-outlined text-primary text-[20px]">check</span>
    )}
  </button>
);

export default AppearanceSettingsScreen;
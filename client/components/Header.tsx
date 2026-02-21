import React from 'react';

interface HeaderProps {
  onMenuClick: () => void;
  onHomeClick: () => void;
  title: string;
  isBackMode?: boolean;
  hideHome?: boolean;
}

const Header: React.FC<HeaderProps> = ({ 
  onMenuClick, 
  onHomeClick, 
  title, 
  isBackMode = false, 
  hideHome = false
}) => {
  return (
    <header className="flex items-center justify-between px-4 pt-10 pb-3 bg-white/95 dark:bg-background-dark/95 backdrop-blur-md sticky top-0 z-50 border-b border-slate-100 dark:border-white/5 shrink-0 transition-colors">
      <div className="flex items-center gap-1">
        <button 
          onClick={onMenuClick}
          className="flex items-center justify-center w-10 h-10 rounded-full hover:bg-slate-100 dark:hover:bg-white/10 active:scale-95 transition-all text-slate-800 dark:text-white"
        >
          <span className="material-symbols-outlined text-[24px]">
            {isBackMode ? 'arrow_back_ios_new' : 'menu'}
          </span>
        </button>
      </div>
      
      <h1 className="text-[17px] font-bold tracking-widest text-slate-900 dark:text-white font-display absolute left-1/2 -translate-x-1/2 uppercase truncate max-w-[40%] text-center">
        {title}
      </h1>
      
      <div className="flex items-center gap-0.5">
        {!hideHome ? (
          <button 
            onClick={onHomeClick}
            className="flex items-center justify-center w-10 h-10 rounded-full hover:bg-slate-100 dark:hover:bg-white/10 active:scale-95 transition-all text-slate-800 dark:text-white"
          >
            <span className="material-symbols-outlined text-[24px]">home</span>
          </button>
        ) : (
          <div className="w-10 h-10"></div>
        )}
      </div>
    </header>
  );
};

export default Header;
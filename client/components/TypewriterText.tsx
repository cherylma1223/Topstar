
import React, { useState, useEffect, useRef } from 'react';

interface TypewriterTextProps {
  content: string;
  speed?: number;
  onComplete?: () => void;
  enabled?: boolean;
  isInitial?: boolean;
  noBullet?: boolean;
}

const TypewriterText: React.FC<TypewriterTextProps> = ({
  content,
  speed = 30,
  onComplete,
  enabled = true,
  isInitial = false,
  noBullet = false
}) => {
  const [displayedText, setDisplayedText] = useState(enabled ? '' : content);
  const indexRef = useRef(0);
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    if (!enabled) {
      setDisplayedText(content);
      return;
    }

    setDisplayedText('');
    indexRef.current = 0;

    if (timerRef.current) clearInterval(timerRef.current);

    timerRef.current = window.setInterval(() => {
      if (indexRef.current < content.length) {
        const char = content.charAt(indexRef.current);
        setDisplayedText(prev => prev + char);
        indexRef.current++;
      } else {
        if (timerRef.current) clearInterval(timerRef.current);
        if (onComplete) onComplete();
      }
    }, speed);

    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [content, speed, enabled]);

  // 处理 Markdown 链接 [名称](URL)
  const renderContentWithLinks = (text: string) => {
    const linkRegex = /\[([^\]]+)\]\(([^)]+)\)/g;
    const parts = [];
    let lastIndex = 0;
    let match;

    while ((match = linkRegex.exec(text)) !== null) {
      if (match.index > lastIndex) {
        parts.push(text.substring(lastIndex, match.index));
      }
      parts.push(
        <a
          key={match.index}
          href={match[2]}
          target="_blank"
          rel="noopener noreferrer"
          className="text-[#138eec] underline decoration-[#138eec]/30 hover:text-[#138eec]/80 transition-colors font-bold"
        >
          {match[1]}
        </a>
      );
      lastIndex = linkRegex.lastIndex;
    }

    if (lastIndex < text.length) {
      parts.push(text.substring(lastIndex));
    }

    return parts.length > 0 ? parts : text;
  };

  const renderStyledText = (text: string) => {
    if (!text) return null;
    if (isInitial) return <span>{text}</span>;

    const lines = text.split('\n');
    const renderedLines: React.ReactNode[] = [];
    let isInsideVIPSection = false;
    let vipTitle = '';
    let vipLines: string[] = [];

    const flushVIPBlock = () => {
      if (vipLines.length === 0) return;
      renderedLines.push(
        <div key={`vip-block`} className="mb-2 mt-3.5">
          <div className="text-[13px] font-bold text-primary mb-2 flex items-center gap-2">
            <span className="w-1 h-3.5 bg-primary rounded-full shrink-0"></span>
            {vipTitle.replace(/\(VIP专属\)/g, '').replace(/（VIP专属）/g, '').trim()}
          </div>
          <div className="relative rounded-2xl overflow-hidden border border-white/[0.08] min-h-[180px]">
            {/* 模糊的假内容背景层 */}
            <div className="p-4 space-y-2 select-none min-h-[180px]" aria-hidden="true">
              {vipLines.map((vl, vi) => (
                <div key={vi} className="flex items-start gap-2.5">
                  <span className="size-1.5 mt-2 shrink-0 rounded-full bg-white/10"></span>
                  <span className="text-[14px] text-white/60 leading-snug font-medium blur-[6px]">{vl}</span>
                </div>
              ))}
            </div>
            {/* 高级遮罩层 */}
            <div className="absolute inset-0 z-10 flex flex-col items-center justify-center bg-gradient-to-b from-[#1a2530]/70 via-[#1e2933]/85 to-[#1a2530]/70 backdrop-blur-[2px]">
              <div className="size-10 rounded-full bg-gradient-to-br from-[#138eec]/20 to-[#a855f7]/20 border border-white/10 flex items-center justify-center mb-3">
                <span className="material-symbols-outlined text-[20px] text-[#138eec]" style={{ fontVariationSettings: "'FILL' 1" }}>lock</span>
              </div>
              <p className="text-white/80 font-bold text-[13px] mb-1">VIP 专属内容</p>
              <p className="text-white/35 text-[11px] mb-4">开通会员即可解锁教练核心秘诀</p>
              <button
                onClick={() => alert('正在前往账户升级页面...')}
                className="text-[11px] bg-gradient-to-r from-[#138eec] to-[#a855f7] text-white px-6 py-2 rounded-full font-bold tracking-wide hover:opacity-90 active:scale-95 transition-all shadow-lg shadow-[#138eec]/20"
              >
                立即开通
              </button>
            </div>
          </div>
        </div>
      );
      vipLines = [];
    };

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line && i < lines.length - 1) {
        if (!isInsideVIPSection) {
          renderedLines.push(<div key={`space-${i}`} className="h-1"></div>);
        }
        continue;
      }
      if (!line) continue;

      const headerMatch = line.match(/【([^】]+)】/);

      if (headerMatch) {
        const title = headerMatch[1];
        const wasVIP = isInsideVIPSection;
        isInsideVIPSection = title.includes('VIP') || title.includes('秘诀');

        // If we were in a VIP section and now hit a new header, flush the VIP block
        if (wasVIP && !isInsideVIPSection) {
          flushVIPBlock();
        }

        if (isInsideVIPSection) {
          vipTitle = title;
          const restOfLine = line.replace(`【${title}】`, '').trim();
          if (restOfLine) vipLines.push(restOfLine);
          continue;
        }

        const restOfLine = line.replace(`【${title}】`, '').trim();

        renderedLines.push(
          <div key={`header-${i}`} className="mb-2 mt-3.5 first:mt-0">
            <div className="text-[13px] font-bold text-primary mb-2 flex items-center gap-2">
              <span className="w-1 h-3.5 bg-primary rounded-full shrink-0"></span>
              {title}
            </div>
            {restOfLine && (
              <div className={`${noBullet ? 'flex items-start gap-2 pl-1 mb-1' : 'p-3 rounded-xl bg-[#233848]/60 dark:bg-[#233848]/60 border border-white/5 mb-1.5 flex items-start gap-2.5 shadow-sm relative overflow-hidden'}`}>
                {!noBullet && (
                  <span className="size-1.5 mt-2 shrink-0 rounded-full bg-slate-300 dark:bg-white/20"></span>
                )}
                <div className="flex flex-col gap-2 w-full">
                  <span className="text-slate-700 dark:text-white/90 leading-snug font-medium text-[14px]">
                    {renderContentWithLinks(restOfLine)}
                  </span>
                </div>
              </div>
            )}
          </div>
        );
        continue;
      }

      // VIP section body lines — collect them
      if (isInsideVIPSection) {
        vipLines.push(line);
        continue;
      }

      // 处理非标题行
      renderedLines.push(
        <div
          key={`line-${i}`}
          className={`${noBullet ? 'flex items-start gap-2 pl-1 mb-1' : 'p-3 rounded-xl bg-[#233848]/60 dark:bg-[#233848]/60 border border-white/5 mb-1.5 flex items-start gap-2.5 shadow-sm relative overflow-hidden'}`}
        >
          {!noBullet && (
            <span className="size-1.5 mt-2 shrink-0 rounded-full bg-slate-300 dark:bg-white/20"></span>
          )}
          <div className="flex flex-col gap-2 w-full">
            <span className="text-slate-700 dark:text-white/90 leading-snug font-medium text-[14px]">
              {renderContentWithLinks(line)}
            </span>
          </div>
        </div>
      );
    }

    // Flush any remaining VIP block at the end
    if (isInsideVIPSection) {
      flushVIPBlock();
    }

    return renderedLines;
  };

  return (
    <div className="relative leading-tight transition-all duration-300">
      {renderStyledText(displayedText)}
      {enabled && indexRef.current < content.length && (
        <span className="inline-block w-[2px] h-[1.1em] bg-primary ml-0.5 animate-pulse align-middle rounded-full" />
      )}
    </div>
  );
};

export default TypewriterText;


import React, { useState, useRef, useEffect } from 'react';
import { AnalysisReport } from '../types.ts';
import { generateSpeech, decodeBase64, decodeAudioData } from '../geminiService.ts';
import TypewriterText from './TypewriterText.tsx';

interface AnalysisReportCardProps { 
  id: string;
  activeAudioId: string | null;
  onToggleAudio: (id: string | null) => void;
  report: AnalysisReport; 
  isTyping?: boolean; 
  isFieldGuidance?: boolean; 
  onComplete?: () => void;
  onPlayVideo?: (url: string) => void;
}

const AnalysisReportCard: React.FC<AnalysisReportCardProps> = ({ 
  id,
  activeAudioId,
  onToggleAudio,
  report, 
  isTyping = false,
  isFieldGuidance = false,
  onComplete,
  onPlayVideo
}) => {
  const { techName, problems, improvements, videoLinks } = report;
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [isLoadingAudio, setIsLoadingAudio] = useState(false);
  const [step, setStep] = useState<number>(isTyping ? 0 : 2); 
  
  const audioCtxRef = useRef<AudioContext | null>(null);
  const sourceRef = useRef<AudioBufferSourceNode | null>(null);
  const audioBufferRef = useRef<AudioBuffer | null>(null);
  const pausedAtRef = useRef<number>(0);
  const startTimeRef = useRef<number>(0);
  const isManuallyStoppedRef = useRef<boolean>(false);

  const stopAudio = () => {
    if (sourceRef.current) {
      try { 
        isManuallyStoppedRef.current = true;
        if (audioCtxRef.current) {
          pausedAtRef.current += audioCtxRef.current.currentTime - startTimeRef.current;
        }
        sourceRef.current.stop(); 
      } catch (e) {}
      setIsSpeaking(false);
    }
  };

  useEffect(() => {
    if (activeAudioId !== id && isSpeaking) {
      stopAudio();
    }
  }, [activeAudioId, id, isSpeaking]);

  // 组件卸载时清理音频
  useEffect(() => {
    return () => {
      if (sourceRef.current) {
        try { sourceRef.current.stop(); } catch (e) {}
      }
    };
  }, []);

  const handleSpeech = async () => {
    if (isLoadingAudio) return;

    if (!audioCtxRef.current) audioCtxRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });
    const ctx = audioCtxRef.current;
    if (ctx.state === 'suspended') await ctx.resume();

    if (isSpeaking && sourceRef.current) {
      stopAudio();
      onToggleAudio(null);
      return;
    }

    if (!audioBufferRef.current) {
      setIsLoadingAudio(true);
      try {
        const pTitle = isFieldGuidance ? '技术特点' : '技术问题';
        const iTitle = isFieldGuidance ? '战术指导' : '训练建议';
        const speechText = `${techName || ''}。${pTitle}：${problems.map(p => p.text).join('。')}。${iTitle}：${improvements.join('。')}。`;
        
        const base64Audio = await generateSpeech(speechText);
        if (base64Audio) {
          audioBufferRef.current = await decodeAudioData(decodeBase64(base64Audio), ctx, 24000, 1);
          pausedAtRef.current = 0;
        }
      } catch (err) {
        console.error("Speech generation failed", err);
      } finally {
        setIsLoadingAudio(false);
      }
    }

    if (audioBufferRef.current) {
      const buffer = audioBufferRef.current;
      if (pausedAtRef.current >= buffer.duration) pausedAtRef.current = 0;

      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(ctx.destination);
      
      source.onended = () => {
        if (!isManuallyStoppedRef.current) {
          pausedAtRef.current = 0;
          setIsSpeaking(false);
          onToggleAudio(null);
        }
      };

      isManuallyStoppedRef.current = false;
      sourceRef.current = source;
      source.start(0, pausedAtRef.current);
      startTimeRef.current = ctx.currentTime;
      setIsSpeaking(true);
      onToggleAudio(id);
    }
  };

  const handleStepComplete = () => {
    if (isTyping) {
      if (step < 2) setStep(prev => prev + 1);
      else onComplete?.();
    }
  };

  const itemBoxStyles = "p-3 rounded-xl bg-[#233848]/60 dark:bg-[#233848]/60 border border-white/5 mb-1.5 last:mb-0 transition-colors duration-300 shadow-sm";
  const textStyles = "text-[14px] leading-snug text-white/90 font-medium";

  return (
    <div className="w-full animate-fade-in-up">
      <div className="p-4 bg-[#1e2933] rounded-[24px] border border-white/5 shadow-2xl relative overflow-hidden">
        
        <div className="flex items-center justify-between mb-2">
          {techName && (
            <h3 className="text-[15px] font-bold text-white/90 tracking-wide">
              <TypewriterText content={techName} enabled={isTyping && step === 0} onComplete={handleStepComplete} noBullet={true} />
            </h3>
          )}
          
          <button 
            onClick={handleSpeech}
            disabled={isLoadingAudio}
            className={`size-8 rounded-full flex items-center justify-center transition-all bg-gradient-to-br from-[#138eec] to-[#a855f7] active:scale-95 shadow-lg border border-white/10`}
          >
            {isLoadingAudio ? (
              <div className="size-3 border-2 border-white/30 border-t-white rounded-full animate-spin"></div>
            ) : (
              <span className={`material-symbols-outlined text-[18px] text-white font-bold ${isSpeaking ? 'animate-pulse' : ''}`}>
                {isSpeaking ? 'pause' : 'volume_up'}
              </span>
            )}
          </button>
        </div>

        <div className="space-y-3.5">
          {(step >= 1 || !isTyping) && (
            <section className="animate-fade-in-up">
              <h4 className="text-[13px] font-bold text-primary mb-1.5 flex items-center gap-2">
                <span className="w-1 h-3 bg-primary rounded-full shrink-0"></span>
                {isFieldGuidance ? '技术特点' : '技术问题'}
              </h4>
              <div className="space-y-1.5">
                {problems.map((prob, idx) => (
                  <div key={idx} className={itemBoxStyles}>
                    <div className="flex gap-2.5 items-start">
                      <span className="size-1.5 rounded-full bg-white/20 mt-1.5 shrink-0"></span>
                      <div className="flex flex-col gap-2 flex-1">
                        <div className={textStyles}>
                          <TypewriterText content={prob.text} enabled={isTyping && step === 1 && idx === 0} onComplete={idx === problems.length - 1 ? handleStepComplete : undefined} noBullet={true} />
                        </div>
                        {prob.timestamp && (
                          <button 
                            onClick={() => videoLinks && onPlayVideo?.(videoLinks[0].url)}
                            className="w-fit flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded bg-primary/10 text-primary font-black border border-primary/10 hover:bg-primary hover:text-white transition-all active:scale-95"
                          >
                            <span className="material-symbols-outlined text-[12px]">videocam</span>
                            {prob.timestamp}
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </section>
          )}

          {(step >= 2 || !isTyping) && (
            <section className="animate-fade-in-up">
              <h4 className="text-[13px] font-bold text-primary mb-1.5 flex items-center gap-2">
                <span className="w-1 h-3 bg-primary rounded-full shrink-0"></span>
                {isFieldGuidance ? '战术指导' : '训练建议'}
              </h4>
              <div className="space-y-1.5">
                {improvements.map((imp, idx) => (
                  <div key={idx} className={itemBoxStyles}>
                    <div className="flex gap-2.5 items-start">
                      <span className="size-1.5 rounded-full bg-white/20 mt-1.5 shrink-0"></span>
                      <div className={textStyles}>
                        <TypewriterText content={imp} enabled={isTyping && step === 2 && idx === 0} onComplete={idx === improvements.length - 1 ? handleStepComplete : undefined} noBullet={true} />
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </section>
          )}

          {((step >= 2 || !isTyping) && videoLinks && videoLinks.length > 0) && (
            <section className="animate-fade-in-up">
               <h4 className="text-[13px] font-bold text-primary mb-1.5 flex items-center gap-2">
                 <span className="w-1 h-3 bg-primary rounded-full shrink-0"></span>
                 动作示范
               </h4>
               <div className="space-y-1.5">
                 {videoLinks.map((link, idx) => (
                   <button 
                     key={idx}
                     onClick={() => onPlayVideo?.(link.url)}
                     className="w-full flex items-center gap-3 p-2.5 bg-[#233848]/60 hover:bg-primary/10 rounded-xl border border-white/5 transition-all group active:scale-[0.98]"
                   >
                     <div className="size-8 rounded-lg bg-primary/20 flex items-center justify-center text-primary group-hover:bg-primary group-hover:text-white transition-all shadow-inner">
                       <span className="material-symbols-outlined text-[16px]">play_circle</span>
                     </div>
                     <span className="text-[14px] font-bold text-white/90 flex-1 text-left truncate tracking-tight">{link.title}</span>
                     <span className="material-symbols-outlined text-white/10 text-[16px] group-hover:text-primary transition-colors">chevron_right</span>
                   </button>
                 ))}
               </div>
            </section>
          )}
        </div>
      </div>
    </div>
  );
};

export default AnalysisReportCard;

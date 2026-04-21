
import React, { useState, useRef, useEffect } from 'react';
import { AnalysisReport } from '../types.ts';
import {
  getSharedAudioContext,
  getSpeechAudioBuffers,
  getTTSRequestKey,
  type TTSRequest,
} from '../geminiService.ts';
import TypewriterText from './TypewriterText.tsx';

interface AnalysisReportCardProps { 
  id: string;
  activeAudioId: string | null;
  onToggleAudio: (id: string | null) => void;
  report: AnalysisReport; 
  summaryText?: string; // AI Text Summary
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
  summaryText,
  isTyping = false,
  isFieldGuidance = false,
  onComplete,
  onPlayVideo
}) => {
  const { techName, problems, improvements, videoLinks, summaryText: reportSummaryText } = report;
  const activeSummaryText = summaryText || reportSummaryText;
  const vipBlockRegex = /(?:\n|^)【(?:核心秘诀|VIP专属)[^】]*】[\s\S]*$/;
  const vipSummaryText = activeSummaryText?.match(vipBlockRegex)?.[0]?.trim() || '';
  const summaryBodyText = activeSummaryText?.replace(vipBlockRegex, '').trim() || '';
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [isLoadingAudio, setIsLoadingAudio] = useState(false);
  const [step, setStep] = useState<number>(isTyping ? 0 : 2); 
  
  const audioCtxRef = useRef<AudioContext | null>(null);
  const sourceRef = useRef<AudioBufferSourceNode | null>(null);
  const audioBuffersRef = useRef<AudioBuffer[] | null>(null);
  const playbackOffsetRef = useRef<number>(0);
  const startTimeRef = useRef<number>(0);
  const isManuallyStoppedRef = useRef<boolean>(false);
  const activeRequestKeyRef = useRef<string | null>(null);
  const currentSegmentBaseOffsetRef = useRef<number>(0);
  const currentSegmentOffsetRef = useRef<number>(0);
  const totalDurationRef = useRef<number>(0);

  const speechRequest: TTSRequest = {
    contentType: 'report',
    report: {
      ...report,
      summaryText: activeSummaryText,
    },
    isFieldGuidance,
  };

  const getSegmentOffsets = () => {
    const buffers = audioBuffersRef.current || [];
    const offsets: number[] = [];
    let total = 0;

    for (const buffer of buffers) {
      offsets.push(total);
      total += buffer.duration;
    }

    totalDurationRef.current = total;
    return offsets;
  };

  const stopAudio = () => {
    if (sourceRef.current) {
      try { 
        isManuallyStoppedRef.current = true;
        if (audioCtxRef.current) {
          const elapsed = audioCtxRef.current.currentTime - startTimeRef.current;
          playbackOffsetRef.current = Math.min(
            totalDurationRef.current,
            currentSegmentBaseOffsetRef.current + currentSegmentOffsetRef.current + elapsed,
          );
        }
        sourceRef.current.stop(); 
      } catch (e) {}
      sourceRef.current = null;
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

  useEffect(() => {
    void loadAudioBuffers(true);
  }, [report, activeSummaryText, isFieldGuidance]);

  const loadAudioBuffers = async (isBackgroundPrefetch: boolean = false) => {
    const requestKey = getTTSRequestKey(speechRequest);
    if (activeRequestKeyRef.current === requestKey && audioBuffersRef.current?.length) {
      return audioBuffersRef.current;
    }

    if (!isBackgroundPrefetch) {
      setIsLoadingAudio(true);
    }
    try {
      const buffers = await getSpeechAudioBuffers(speechRequest);
      if (buffers?.length) {
        audioBuffersRef.current = buffers;
        activeRequestKeyRef.current = requestKey;
        playbackOffsetRef.current = 0;
        getSegmentOffsets();
        return buffers;
      }
      return null;
    } finally {
      if (!isBackgroundPrefetch) {
        setIsLoadingAudio(false);
      }
    }
  };

  const playFromOffset = (offsetSeconds: number) => {
    const ctx = audioCtxRef.current;
    const buffers = audioBuffersRef.current;
    if (!ctx || !buffers?.length) return;

    const offsets = getSegmentOffsets();
    const totalDuration = totalDurationRef.current;
    if (offsetSeconds >= totalDuration) {
      offsetSeconds = 0;
      playbackOffsetRef.current = 0;
    }

    let segmentIndex = buffers.length - 1;
    for (let i = 0; i < buffers.length; i++) {
      const segmentStart = offsets[i];
      const segmentEnd = segmentStart + buffers[i].duration;
      if (offsetSeconds < segmentEnd) {
        segmentIndex = i;
        break;
      }
    }

    const segmentBaseOffset = offsets[segmentIndex] || 0;
    const segmentOffset = Math.max(0, offsetSeconds - segmentBaseOffset);
    const source = ctx.createBufferSource();
    source.buffer = buffers[segmentIndex];
    source.connect(ctx.destination);

    source.onended = () => {
      if (isManuallyStoppedRef.current) return;

      const nextIndex = segmentIndex + 1;
      if (nextIndex < buffers.length) {
        playbackOffsetRef.current = offsets[nextIndex];
        playFromOffset(offsets[nextIndex]);
        return;
      }

      playbackOffsetRef.current = 0;
      currentSegmentBaseOffsetRef.current = 0;
      currentSegmentOffsetRef.current = 0;
      sourceRef.current = null;
      setIsSpeaking(false);
      onToggleAudio(null);
    };

    isManuallyStoppedRef.current = false;
    sourceRef.current = source;
    currentSegmentBaseOffsetRef.current = segmentBaseOffset;
    currentSegmentOffsetRef.current = segmentOffset;
    startTimeRef.current = ctx.currentTime;
    source.start(0, segmentOffset);
    setIsSpeaking(true);
    onToggleAudio(id);
  };

  const handleSpeech = async () => {
    if (isLoadingAudio) return;

    if (!audioCtxRef.current) audioCtxRef.current = getSharedAudioContext();
    const ctx = audioCtxRef.current;
    if (ctx.state === 'suspended') await ctx.resume();

    if (isSpeaking && sourceRef.current) {
      stopAudio();
      onToggleAudio(null);
      return;
    }

    if (!audioBuffersRef.current?.length) {
      const buffers = await loadAudioBuffers();
      if (!buffers?.length) {
        console.error('Speech generation failed');
        return;
      }
    }

    playFromOffset(playbackOffsetRef.current);
  };

  const handleStepComplete = () => {
    if (isTyping) {
      if (step < 2) setStep(prev => prev + 1);
      else onComplete?.();
    }
  };

  // 决定当前卡片是否只包含 summaryText 和视频 (后端目前的数据结构就是这样)
  const isSimpleSummaryCard = Boolean((summaryBodyText || vipSummaryText) && (!problems || problems.length === 0) && (!improvements || improvements.length === 0));

  const itemBoxStyles = "p-3 rounded-xl bg-[#233848]/60 dark:bg-[#233848]/60 border border-white/5 mb-1.5 last:mb-0 transition-colors duration-300 shadow-sm";
  const textStyles = "text-[14px] leading-snug text-white/90 font-medium";

  return (
    <div className="w-full animate-fade-in-up">
      <div className="p-4 bg-[#1e2933] rounded-[24px] border border-white/5 shadow-2xl relative overflow-hidden">
        
        <div className="flex items-center justify-between mb-2">
          {techName && (
            <h3 className="text-[15px] font-bold text-white/90 tracking-wide">
              <TypewriterText
                content={techName}
                enabled={isTyping && step === 0}
                onComplete={!summaryBodyText ? handleStepComplete : undefined}
                noBullet={true}
              />
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
          {/* 1. Summary Text (AI Text Recommendation) */}
          {summaryBodyText && (
            <section className="animate-fade-in-up mb-4">
               <div className="text-[14px] leading-relaxed text-white/90">
                 <TypewriterText 
                   content={summaryBodyText} 
                   enabled={isTyping && step === 0} 
                   onComplete={() => {
                     // 如果只是简单的 summary 卡片，直接完成；否则走下一步
                     if (isSimpleSummaryCard) {
                       setStep(2); // 跳过问题和建议阶段，直接显示视频
                       onComplete?.();
                     } else {
                       handleStepComplete();
                     }
                   }} 
                 />
               </div>
            </section>
          )}

          {/* 2. Structured Problems */}
          {(step >= 1 || !isTyping) && problems && problems.length > 0 && (
            <section className="animate-fade-in-up mt-2">
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

          {/* 3. Structured Improvements */}
          {(step >= 2 || !isTyping) && improvements && improvements.length > 0 && (
            <section className="animate-fade-in-up mt-2">
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

          {/* 4. Video Demonstrations */}
          {((step >= 2 || !isTyping) && videoLinks && videoLinks.length > 0) && (
            <section className="animate-fade-in-up mt-3">
               <h4 className="text-[13px] font-bold text-primary mb-1.5 flex items-center gap-2">
                 <span className="w-1 h-3 bg-primary rounded-full shrink-0"></span>
                 视频教程
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

          {((step >= 2 || !isTyping) && vipSummaryText) && (
            <section className="animate-fade-in-up mt-3">
              <div className="text-[14px] leading-relaxed text-white/90">
                <TypewriterText content={vipSummaryText} enabled={false} />
              </div>
            </section>
          )}
        </div>
      </div>
    </div>
  );
};

export default AnalysisReportCard;

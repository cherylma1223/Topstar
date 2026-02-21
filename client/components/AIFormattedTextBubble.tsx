
import React, { useState, useRef, useEffect } from 'react';
import TypewriterText from './TypewriterText.tsx';
import { generateSpeech, decodeBase64, decodeAudioData } from '../geminiService.ts';

interface AIFormattedTextBubbleProps {
  id: string;
  content: string;
  isTyping: boolean;
  activeAudioId: string | null;
  onToggleAudio: (id: string | null) => void;
  onComplete?: () => void;
}

const AIFormattedTextBubble: React.FC<AIFormattedTextBubbleProps> = ({
  id,
  content,
  isTyping,
  activeAudioId,
  onToggleAudio,
  onComplete
}) => {
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [isLoadingAudio, setIsLoadingAudio] = useState(false);
  
  // 判断是否为结构化消息
  const isStructured = content.includes('【');
  const isInitialMessage = id.includes('welcome') || (!isStructured && content.length < 80);

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
  }, [activeAudioId]);

  // 组件卸载时强制停止音频
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

    if (isSpeaking) {
      stopAudio();
      onToggleAudio(null);
      return;
    }

    if (!audioBufferRef.current) {
      setIsLoadingAudio(true);
      try {
        const base64Audio = await generateSpeech(content);
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

  return (
    <div className="relative group/bubble max-w-full animate-fade-in-up">
      <div className={`
        ${isStructured ? 'p-4' : 'p-5'} 
        pr-12 rounded-2xl border bg-white dark:bg-[#1e2933] text-slate-700 dark:text-white/90 border-slate-200 dark:border-white/5 rounded-tl-none shadow-sm transition-all hover:shadow-md relative
      `}>
        
        {/* 语音播放按钮 */}
        {!isInitialMessage && (
          <button 
            onClick={handleSpeech}
            disabled={isLoadingAudio}
            className={`absolute top-3 right-3 size-8 rounded-full bg-gradient-to-br from-[#138eec] to-[#a855f7] flex items-center justify-center transition-all active:scale-90 shadow-lg`}
          >
            {isLoadingAudio ? (
              <div className="size-3.5 border-2 border-white/30 border-t-white rounded-full animate-spin"></div>
            ) : (
              <span className={`material-symbols-outlined text-[18px] text-white font-bold ${isSpeaking ? 'animate-pulse' : ''}`}>
                {isSpeaking ? 'pause' : 'volume_up'}
              </span>
            )}
          </button>
        )}

        <div className="text-[15px] leading-relaxed font-medium">
          <TypewriterText 
            content={content} 
            enabled={isTyping} 
            isInitial={isInitialMessage}
            onComplete={onComplete} 
          />
        </div>
      </div>
    </div>
  );
};

export default AIFormattedTextBubble;

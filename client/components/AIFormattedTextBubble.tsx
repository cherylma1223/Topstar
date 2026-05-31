
import React, { useState, useRef, useEffect } from 'react';
import TypewriterText from './TypewriterText.tsx';
import {
  getSharedAudioContext,
  getSpeechAudioBuffers,
  getTTSRequestKey,
  type TTSRequest,
} from '../geminiService.ts';

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
  const audioBuffersRef = useRef<AudioBuffer[] | null>(null);
  const playbackOffsetRef = useRef<number>(0);
  const startTimeRef = useRef<number>(0);
  const isManuallyStoppedRef = useRef<boolean>(false);
  const activeRequestKeyRef = useRef<string | null>(null);
  const currentSegmentBaseOffsetRef = useRef<number>(0);
  const currentSegmentOffsetRef = useRef<number>(0);
  const totalDurationRef = useRef<number>(0);

  const speechRequest: TTSRequest = {
    contentType: 'text',
    text: content,
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
      } catch (e) { }
      sourceRef.current = null;
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
        try { sourceRef.current.stop(); } catch (e) { }
      }
    };
  }, []);

  useEffect(() => {
    if (isInitialMessage) return;
    void loadAudioBuffers(true);
  }, [content, isInitialMessage]);

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

    if (isSpeaking) {
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

  return (
    <div className="relative group/bubble max-w-full animate-fade-in-up">
      <div className={`
        ${isStructured ? 'p-4' : 'p-5'} 
        pr-12 rounded-2xl border bg-white dark:bg-[#1e2933] text-slate-900 dark:text-white/90 border-slate-200 dark:border-white/5 rounded-tl-none shadow-sm transition-all hover:shadow-md relative
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

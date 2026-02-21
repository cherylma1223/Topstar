
import React, { useRef, useEffect, useState } from 'react';
import { Message, MessagePart } from '../types.ts';
import AnalysisReportCard from './AnalysisReportCard.tsx';
import ProcessingCard from './ProcessingCard.tsx';
import TypewriterText from './TypewriterText.tsx';
import AIFormattedTextBubble from './AIFormattedTextBubble.tsx';
import { generateActionImage } from '../geminiService.ts';

interface ChatScreenProps {
  messages: Message[];
  setMessages: React.Dispatch<React.SetStateAction<Message[]>>;
  hasEngaged: boolean;
  setHasEngaged: (val: boolean) => void;
  onUpdateTitle?: (newTitle: string) => void;
  isAutoReadEnabled?: boolean;
  aiIcon?: string;
  onPlayVideo?: (url: string) => void;
  activeAudioId: string | null;
  onToggleAudio: (id: string | null) => void;
  isProcessing?: boolean; // 新增属性
}

const ChatScreen: React.FC<ChatScreenProps> = ({ 
  messages, 
  setMessages, 
  hasEngaged, 
  setHasEngaged, 
  onUpdateTitle,
  isAutoReadEnabled,
  aiIcon = 'psychology',
  onPlayVideo,
  activeAudioId,
  onToggleAudio,
  isProcessing: isGlobalProcessing = false // 使用 props 传进来的值
}) => {
  const [isInternalProcessing, setIsInternalProcessing] = useState(false);
  const isProcessing = isInternalProcessing || isGlobalProcessing; // 组合内部和外部状态
  const scrollRef = useRef<HTMLDivElement>(null);
  
  const selectFileInputRef = useRef<HTMLInputElement>(null);
  const recordFileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
    }
  }, [messages, isProcessing]);

  const handleTypewriterComplete = (msgId: string, partIdx: number) => {
    setTimeout(() => {
      setMessages(prev => prev.map(msg => {
        if (msg.id === msgId) {
          const newParts = [...msg.parts];
          newParts[partIdx] = { ...newParts[partIdx], isTyping: false };
          
          if (partIdx + 1 < newParts.length) {
            const nextPart = newParts[partIdx + 1];
            if (nextPart.type === 'text' || nextPart.type === 'report' || nextPart.type === 'video-screenshot') {
              newParts[partIdx + 1] = { ...nextPart, isTyping: true };
            } else {
              newParts[partIdx + 1] = { ...nextPart, isTyping: false };
              setTimeout(() => handleTypewriterComplete(msgId, partIdx + 1), 300);
            }
          }
          return { ...msg, parts: newParts };
        }
        return msg;
      }));
    }, 400); 
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setHasEngaged(true);
    
    const userMsgId = `u-${Date.now()}`;
    
    const userMsg: Message = {
      id: userMsgId,
      sender: 'user',
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      parts: [{ 
        type: 'video', 
        videoUrl: '', 
        duration: '00:15' 
      }]
    };
    setMessages(prev => [...prev, userMsg]);
    setIsInternalProcessing(true); // 使用内部处理状态
    if (e.target) e.target.value = '';

    const actionDesc = aiIcon === 'person' ? "table tennis match strategy analysis" : "table tennis forehand loop technical action";
    
    generateActionImage(actionDesc).then(generatedThumbnail => {
      const fallbackThumb = 'https://img1.baidu.com/it/u=3325220246,268389528&fm=253&fmt=auto&app=138&f=JPEG?w=889&h=500';
      setMessages(prev => prev.map(m => {
        if (m.id === userMsgId) {
          return {
            ...m,
            parts: m.parts.map(p => p.type === 'video' ? { ...p, videoUrl: generatedThumbnail || fallbackThumb } : p)
          };
        }
        return m;
      }));
    });

    setTimeout(() => {
      setIsInternalProcessing(false); // 结束内部处理状态
      const msgId = `ai-report-${Date.now()}`;
      let finalParts: MessagePart[] = [];

      if (aiIcon === 'person') {
        finalParts = [
          { type: 'text', content: "通过对视频的分析，我总结了双方的技战术特点及战术指导：", isTyping: true },
          { 
            type: 'video-screenshot', 
            screenshotUrl: 'https://lh3.googleusercontent.com/d/1gORLMaz4MA3x-b99L605iGpLUyaqHVRQ', 
            isTyping: false 
          },
          { 
            type: 'report', 
            reportData: { 
              techName: "球员 A", 
              variant: 'blue',
              problems: [
                { text: "正手大角位控制力出色，发球抢攻果断。", timestamp: "" },
                { text: "步伐移动迅速，反手衔接正手转换极快。", timestamp: "" }
              ], 
              improvements: [
                "对手一直发你反手位长球，脚步得提前侧身准备反拉，别犹豫。",
                "适当增加台内摆短，破坏对手上手节奏，寻找转攻机会。"
              ] 
            },
            isTyping: false
          },
          { 
            type: 'report', 
            reportData: { 
              techName: "球员 B", 
              variant: 'gradient',
              problems: [
                { text: "直板横打衔接快，台内球处理非常细腻。", timestamp: "" },
                { text: "关键球敢打敢拼，变线意图隐蔽，防守极其稳健。", timestamp: "" }
              ], 
              improvements: [
                "多利用发球调动对方正手，只要对方一退台，马上变线压反手位。",
                "减少远台对拉，尽可能在近台通过快带和落点控制解决战斗。",
              ] 
            },
            isTyping: false
          }
        ];
        onUpdateTitle?.("球员 A vs 球员 B 战术分析");
      } else {
        finalParts = [
          { type: 'text', content: "您的正手基本功很扎实呀！通过视频慢动作回放，我发现了几处可以优化的地方：", isTyping: true },
          { 
            type: 'report', 
            reportData: { 
              techName: "正手技术诊断报告", 
              variant: 'gradient',
              problems: [
                { text: "重心交换如果能更充分一些，这板球的底劲会更足。", timestamp: "00:04" },
                { text: "引拍时手再放低一点点，击球点的控制会更精准。", timestamp: "00:07" }
              ], 
              improvements: [
                "加强下肢蹬转训练，找找从右脚到左脚的力量传递感。",
                "练习拉下旋球时，尝试从球的后中下部向上前方挥拍摩擦。"
              ],
              videoLinks: [
                { title: "樊振东正手拉球慢动作示范", url: "https://drive.google.com/file/d/13VkToMh1kvnbKRhHsLlgJ_D_WaT-Eef0/view" }
              ]
            },
            isTyping: false
          }
        ];
        onUpdateTitle?.("关于正手攻球的动作分析");
      }
      
      setMessages(prev => [...prev, { 
        id: msgId, 
        sender: 'ai', 
        timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }), 
        parts: finalParts 
      }]);
    }, 3500);
  };

  return (
    <div className="flex flex-col h-full w-full relative">
      <input type="file" ref={selectFileInputRef} onChange={handleFileUpload} accept="video/*" className="hidden" />
      <input type="file" ref={recordFileInputRef} onChange={handleFileUpload} accept="video/*" capture="environment" className="hidden" />

      <div ref={scrollRef} className="flex-1 overflow-y-auto no-scrollbar p-4 space-y-4 pb-40">
        {messages.map((msg) => (
          <div key={msg.id} className={`flex items-start gap-3 animate-fade-in-up ${msg.sender === 'user' ? 'flex-row-reverse' : ''}`}>
            <Avatar sender={msg.sender} aiIcon={aiIcon} />
            <div className={`flex flex-col gap-4 max-w-[85%] ${msg.sender === 'user' ? 'items-end' : 'items-start'}`}>
              
              {msg.parts.map((part, idx) => (
                <div key={idx} className="w-full">
                  {part.type === 'text' && (
                    msg.sender === 'ai' ? (
                      <AIFormattedTextBubble 
                        id={`${msg.id}-${idx}`}
                        content={part.content || ''}
                        isTyping={part.isTyping === true}
                        activeAudioId={activeAudioId}
                        onToggleAudio={onToggleAudio}
                        onComplete={() => handleTypewriterComplete(msg.id, idx)}
                      />
                    ) : (
                      <div className="p-4 rounded-2xl text-[15px] border whitespace-pre-wrap bg-primary text-white border-primary/20 rounded-tr-none">
                        {part.content}
                      </div>
                    )
                  )}
                  {part.type === 'video' && <VideoPreview part={part} onPlay={() => part.videoUrl && onPlayVideo?.(part.videoUrl || '')} />}
                  {part.type === 'video-screenshot' && (
                    <div className="w-full relative rounded-2xl overflow-hidden border border-slate-200 dark:border-white/10 shadow-lg animate-fade-in-up group">
                      <div className="aspect-[1.8/1] w-full bg-slate-800">
                        <img src={part.screenshotUrl} className="w-full h-full object-cover" alt="Analysis Frame" />
                      </div>
                      
                      {aiIcon === 'person' && (
                        <>
                          <div className="absolute top-[18%] left-[5%] animate-in zoom-in fade-in duration-500 delay-300">
                            <div className="flex flex-col items-center gap-1">
                                <div className="bg-primary text-white px-3.5 py-1.5 rounded-xl text-[11px] font-black shadow-lg shadow-primary/40 border border-white/20 whitespace-nowrap">
                                  球员 A
                                </div>
                            </div>
                          </div>
                          <div className="absolute top-[18%] right-[5%] animate-in zoom-in fade-in duration-500 delay-500">
                             <div className="flex flex-col items-center gap-1">
                                <div className="bg-purple-500 text-white px-3.5 py-1.5 rounded-xl text-[11px] font-black shadow-lg shadow-purple-500/40 border border-white/20 whitespace-nowrap">
                                  球员 B
                                </div>
                            </div>
                          </div>
                        </>
                      )}
                    </div>
                  )}
                  {part.type === 'report' && part.reportData && (
                    <AnalysisReportCard 
                      id={`${msg.id}-${idx}`}
                      activeAudioId={activeAudioId}
                      onToggleAudio={onToggleAudio}
                      report={part.reportData} 
                      isTyping={part.isTyping === true} 
                      isFieldGuidance={aiIcon === 'person'}
                      onPlayVideo={onPlayVideo} 
                      onComplete={() => handleTypewriterComplete(msg.id, idx)}
                    />
                  )}
                  {part.type === 'action-card' && (
                    <div className="w-full p-5 rounded-[24px] bg-[#16222c] border border-white/5 shadow-2xl animate-fade-in-up">
                      <p className="text-white font-bold text-[13px] mb-4 ml-1 opacity-60">上传视频</p>
                      <div className="flex gap-4">
                        <button 
                          onClick={() => {
                            onToggleAudio(null);
                            selectFileInputRef.current?.click();
                          }} 
                          className="flex-1 h-28 bg-[#1E4064] rounded-2xl flex flex-col items-center justify-center gap-2 text-white font-bold text-xs active:scale-95 transition-all group"
                        >
                          <span className="material-symbols-outlined text-[32px] group-hover:scale-110 transition-transform">image</span>
                          <span>选择视频</span>
                        </button>
                        <button 
                          onClick={() => {
                            onToggleAudio(null);
                            recordFileInputRef.current?.click();
                          }} 
                          className="flex-1 h-28 bg-primary rounded-2xl flex flex-col items-center justify-center gap-2 text-white font-bold text-xs active:scale-95 transition-all group"
                        >
                          <span className="material-symbols-outlined text-[32px] group-hover:scale-110 transition-transform">videocam</span>
                          <span>拍摄视频</span>
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        ))}
        {isProcessing && (
          <div className="flex items-start gap-3 animate-fade-in-up">
            <Avatar sender="ai" aiIcon={aiIcon} />
            <div className="flex flex-col gap-4 w-full max-w-[85%]">
              {isInternalProcessing ? (
                <ProcessingCard />
              ) : (
                <div className="p-4 rounded-2xl rounded-tl-none bg-slate-100 dark:bg-bubble-ai border border-slate-200 dark:border-white/5 shadow-md w-fit">
                  <div className="flex items-center gap-2 pr-2">
                    <div className="flex gap-1">
                      <div className="w-1.5 h-1.5 bg-primary rounded-full animate-bounce [animation-delay:-0.3s]"></div>
                      <div className="w-1.5 h-1.5 bg-primary rounded-full animate-bounce [animation-delay:-0.15s]"></div>
                      <div className="w-1.5 h-1.5 bg-primary rounded-full animate-bounce"></div>
                    </div>
                    <span className="text-[13px] text-slate-500 dark:text-white/50 font-medium whitespace-nowrap">正在思考...</span>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

const Avatar: React.FC<{ sender: 'ai' | 'user'; aiIcon?: string }> = ({ sender, aiIcon }) => (
  <div className="size-9 shrink-0 mt-1 flex items-center justify-center">
    {sender === 'ai' ? (
      <div className="size-8 rounded-lg bg-gradient-to-br from-[#138eec] to-[#4d8eff] flex items-center justify-center shadow-lg">
        <span className="material-symbols-outlined text-white text-[18px]" style={{ fontVariationSettings: "'FILL' 1" }}>{aiIcon}</span>
      </div>
    ) : (
      <div className="size-9 rounded-full bg-gradient-to-br from-primary to-purple-500 p-[1px] shadow-md shadow-primary/10">
        <div className="w-full h-full rounded-full bg-[#101a22] flex items-center justify-center text-[11px] font-bold text-white">樊</div>
      </div>
    )}
  </div>
);

const VideoPreview: React.FC<{ part: MessagePart; onPlay?: () => void }> = ({ part, onPlay }) => {
  const isLoading = !part.videoUrl;

  return (
    <div 
      onClick={!isLoading ? onPlay : undefined}
      className={`relative w-64 aspect-video bg-slate-900 rounded-2xl overflow-hidden group border border-slate-200 dark:border-white/10 shadow-xl transition-all ${isLoading ? 'cursor-wait' : 'cursor-pointer active:scale-[0.98]'}`}
    >
      {isLoading ? (
        <div className="w-full h-full flex flex-col items-center justify-center bg-slate-800/50 backdrop-blur-sm relative overflow-hidden">
          <div className="absolute inset-0 bg-gradient-to-r from-transparent via-white/5 to-transparent w-full -translate-x-full animate-shimmer"></div>
          <div className="size-10 rounded-full border-2 border-primary/20 border-t-primary animate-spin mb-3"></div>
          <span className="text-[10px] text-white/50 font-black tracking-[0.2em] uppercase animate-pulse">Analyzing Video...</span>
        </div>
      ) : (
        <>
          <img src={part.videoUrl} className="w-full h-full object-cover opacity-70" alt="Thumbnail" />
          <div className="absolute inset-0 flex items-center justify-center">
            <div className="size-16 rounded-full bg-white/20 backdrop-blur-md border border-white/30 flex items-center justify-center group-hover:scale-110 transition-transform shadow-2xl">
              <span className="material-symbols-outlined text-white text-5xl ml-1">play_arrow</span>
            </div>
          </div>
          <div className="absolute bottom-3 right-3 text-[10px] font-bold text-white bg-black/60 px-2 py-0.5 rounded-lg border border-white/10">
            {part.duration}
          </div>
        </>
      )}
    </div>
  );
};

export default ChatScreen;

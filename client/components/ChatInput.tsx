
import React, { useState, useEffect, useRef } from 'react';

interface ChatInputProps {
  onSend: (text: string) => void;
  placeholder?: string;
}

const ChatInput: React.FC<ChatInputProps> = ({ onSend, placeholder = "请输入您的问题" }) => {
  const [inputText, setInputText] = useState('');
  const [isVoiceMode, setIsVoiceMode] = useState(true); 
  const [isRecording, setIsRecording] = useState(false);
  const [transcription, setTranscription] = useState('');
  const recognitionRef = useRef<any>(null);

  useEffect(() => {
    // 初始化语音识别 API
    if (typeof window !== 'undefined') {
      const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
      if (SpeechRecognition) {
        recognitionRef.current = new SpeechRecognition();
        recognitionRef.current.continuous = true;
        recognitionRef.current.interimResults = true;
        recognitionRef.current.lang = 'zh-CN';

        recognitionRef.current.onresult = (event: any) => {
          let currentTranscription = '';
          for (let i = event.resultIndex; i < event.results.length; i++) {
            currentTranscription += event.results[i][0].transcript;
          }
          setTranscription(currentTranscription);
        };
        
        recognitionRef.current.onerror = (event: any) => {
          console.error('语音识别错误:', event.error);
          setIsRecording(false);
        };

        recognitionRef.current.onend = () => {
          setIsRecording(false);
        };
      }
    }
  }, []);

  const handleSend = () => {
    if (isVoiceMode) {
      if (!transcription.trim()) return;
      onSend(transcription);
      setTranscription('');
    } else {
      if (!inputText.trim()) return;
      onSend(inputText);
      setInputText('');
    }
  };

  const handleVoiceStart = (e: React.TouchEvent | React.MouseEvent) => {
    e.preventDefault();
    setTranscription('');
    setIsRecording(true);
    
    if (recognitionRef.current) {
      try {
        recognitionRef.current.start();
      } catch (err) {
        console.warn('语音识别已在运行中');
      }
    } else {
      console.warn('当前浏览器不支持 Web Speech API，无法进行实时转写。');
    }
  };

  const handleVoiceEnd = () => {
    if (!isRecording) return;
    
    if (recognitionRef.current) {
      try {
        recognitionRef.current.stop();
      } catch (e) {}
    }

    // 稍微延迟以确保获取到最终的识别结果
    setTimeout(() => {
      setIsRecording(false);
      if (transcription.trim()) {
        onSend(transcription);
        setTranscription('');
      }
    }, 400);
  };

  return (
    <div className="w-full bg-[#101a22] border-t border-white/5 px-4 pt-3 pb-[calc(1rem+env(safe-area-inset-bottom))] z-[100] shadow-[0_-10px_40px_rgba(0,0,0,0.4)] shrink-0 relative">
      
      {/* 实时语音转文字预览气泡：直接显示识别到的文字 */}
      {isRecording && (
        <div className="absolute left-1/2 -translate-x-1/2 bottom-full mb-6 w-[88%] max-w-sm animate-in fade-in slide-in-from-bottom-2 duration-200">
          <div className="bg-[#1e2933]/95 backdrop-blur-xl border border-white/10 rounded-2xl p-4 shadow-2xl relative">
            <div className="flex items-center gap-3 mb-2 opacity-50">
              <div className="flex gap-0.5 items-end h-3">
                {[0.4, 0.7, 1.0, 0.6, 0.8].map((h, i) => (
                  <div 
                    key={i} 
                    className="w-1 bg-primary rounded-full animate-bounce" 
                    style={{ height: `${h * 100}%`, animationDelay: `${i * 0.1}s` }}
                  />
                ))}
              </div>
              <span className="text-[10px] font-bold tracking-widest uppercase text-white/80">正在听你说话...</span>
            </div>
            <p className="text-white/90 text-[15px] font-medium leading-relaxed min-h-[1.5em]">
              {transcription || '...'}
            </p>
            {/* 气泡小尾巴 */}
            <div className="absolute -bottom-1.5 left-1/2 -translate-x-1/2 w-3 h-3 bg-[#1e2933] border-r border-b border-white/10 rotate-45"></div>
          </div>
        </div>
      )}

      <div className="flex items-center gap-3 max-w-lg mx-auto h-[48px]">
        {/* 左侧功能按钮：添加 */}
        <button className="text-white/40 hover:text-white transition-colors flex-shrink-0 active:scale-90">
          <span className="material-symbols-outlined text-[28px]">add_circle</span>
        </button>

        {/* 输入区主容器 */}
        <div className={`flex-1 flex items-center bg-[#1e2933] border border-white/10 rounded-xl transition-all overflow-hidden h-full ${isRecording ? 'border-primary/50 ring-1 ring-primary/20' : ''}`}>
          
          {isVoiceMode ? (
            <div className="flex-1 flex items-center h-full">
              <button
                onMouseDown={handleVoiceStart}
                onMouseUp={handleVoiceEnd}
                onMouseLeave={handleVoiceEnd}
                onTouchStart={handleVoiceStart}
                onTouchEnd={handleVoiceEnd}
                className={`flex-1 h-full text-[15px] font-bold transition-all flex items-center justify-center gap-2 select-none
                  ${isRecording 
                    ? 'bg-white/5 text-white/90 shadow-inner' 
                    : 'text-white/70 active:bg-white/5'}`}
              >
                按住 说话
              </button>
              
              <button 
                onClick={() => setIsVoiceMode(false)}
                className="w-12 h-full flex items-center justify-center text-white/40 hover:text-white transition-colors border-l border-white/5"
              >
                <span className="material-symbols-outlined text-[22px]">keyboard</span>
              </button>
            </div>
          ) : (
            <div className="flex-1 flex items-center px-4 h-full">
              <input 
                autoFocus
                type="text"
                value={inputText}
                onChange={(e) => setInputText(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleSend()}
                className="bg-transparent border-none text-white text-[15px] placeholder-white/20 focus:ring-0 w-full p-0 leading-tight" 
                placeholder={placeholder} 
              />
              <button 
                onClick={() => setIsVoiceMode(true)}
                className="ml-2 text-white/40 hover:text-white transition-colors active:scale-90"
              >
                <span className="material-symbols-outlined text-[22px]">mic</span>
              </button>
            </div>
          )}
        </div>

        {/* 右侧发送按钮 */}
        <button 
          onClick={handleSend}
          className={`bg-gradient-to-br from-primary to-purple-500 text-white rounded-full w-10 h-10 flex items-center justify-center shadow-lg shadow-primary/30 shrink-0 transition-all active:scale-90`}
        >
          <span className="material-symbols-outlined text-[20px]">send</span>
        </button>
      </div>
    </div>
  );
};

export default ChatInput;

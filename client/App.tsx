
import React, { useState, useEffect, useCallback, useRef } from 'react';
import { AppScreen, Message, MessagePart } from './types.ts';
import Sidebar from './components/Sidebar.tsx';
import Header from './components/Header.tsx';
import HomeScreen from './components/HomeScreen.tsx';
import ChatScreen from './components/ChatScreen.tsx';
import ChatInput from './components/ChatInput.tsx';
import SettingsScreen from './components/SettingsScreen.tsx';
import AppearanceSettingsScreen from './components/AppearanceSettingsScreen.tsx';
import { getAIResponse, EQUIPMENT_ADVISOR_INSTRUCTION, DEFAULT_COACH_INSTRUCTION } from './geminiService.ts';

interface HistoryEntry {
  id: string;
  title: string;
  time: string;
  section: 'recent' | 'earlier';
}

const App: React.FC = () => {
  const [currentScreen, setCurrentScreen] = useState<AppScreen>(AppScreen.HOME);
  const [prevScreen, setPrevScreen] = useState<AppScreen>(AppScreen.HOME);
  const [activeService, setActiveService] = useState<string>("当家球星");
  const [activeIcon, setActiveIcon] = useState<string>("psychology");
  const [isSidebarOpen, setSidebarOpen] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);
  const [hasEngaged, setHasEngaged] = useState(false);
  const [appearanceMode, setAppearanceMode] = useState<'dark' | 'light'>('dark');
  const [isAutoReadEnabled, setIsAutoReadEnabled] = useState(false);
  const [isAutoAnalyzeEnabled, setIsAutoAnalyzeEnabled] = useState(true);
  
  // 新增：全局等待状态，用于控制“正在思考”
  const [isProcessing, setIsProcessing] = useState(false);
  
  const [activeVideoUrl, setActiveVideoUrl] = useState<string | null>(null);
  const [rawVideoUrl, setRawVideoUrl] = useState<string | null>(null);

  // 全局控制语音播放状态，确保切换页面或触发特定导航时能停止语音
  const [activeAudioId, setActiveAudioId] = useState<string | null>(null);
  
  // Define isSettingsFlow to determine if we are in a sub-menu flow
  // This fixes the 'isSettingsFlow' missing variable errors.
  const isSettingsFlow = currentScreen === AppScreen.SETTINGS || currentScreen === AppScreen.APPEARANCE;
  
  const [history, setHistory] = useState<HistoryEntry[]>([
    { id: '1', title: '反手拧拉技术提升策略', time: '14:30', section: 'recent' },
    { id: '2', title: '正手攻球动作分析', time: '昨天', section: 'recent' },
    { id: '3', title: '针对长胶选手发球抢攻战术的深度复盘', time: '昨天', section: 'recent' },
  ]);

  useEffect(() => {
    const isDarkMode = appearanceMode === 'dark';
    if (isDarkMode) {
      document.documentElement.classList.add('dark');
      document.body.classList.add('dark');
    } else {
      document.documentElement.classList.remove('dark');
      document.body.classList.remove('dark');
    }
  }, [appearanceMode]);

  const getInitialMessages = useCallback((serviceTitle?: string): Message[] => {
    let welcomeContent = '您好，我是您的私人教练。请上传或拍一段打球视频，我帮您看下有什么地方可以改进。';
    let showActionCard = true;
    
    if (serviceTitle === "AI 场外指导") {
      welcomeContent = '我是您的智能场外指导。给我一段比赛视频，我能帮您快速分析双方技战术特点，给出实战建议。';
    } else if (serviceTitle === "器材推荐" || serviceTitle?.includes("器材")) {
      welcomeContent = '您好！我是您的乒乓球器材顾问，可以回答器材相关问题，也可以根据您的打法和预算，推荐合适的器材搭配。';
      showActionCard = false;
    }

    const parts: MessagePart[] = [
      {
        type: 'text',
        content: welcomeContent,
        isTyping: true
      }
    ];

    if (showActionCard) {
      parts.push({
        type: 'action-card',
        isTyping: null as any
      });
    }

    return [
      {
        id: `welcome-${Date.now()}`,
        sender: 'ai',
        timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        parts: parts
      }
    ];
  }, []);

  useEffect(() => {
    if (messages.length === 0 && currentScreen !== AppScreen.HOME) {
      setMessages(getInitialMessages(activeService));
    }
  }, [getInitialMessages, messages.length, currentScreen, activeService]);

  const handleResetToHome = () => {
    setActiveAudioId(null); // 立即停止当前语音
    setCurrentScreen(AppScreen.HOME);
    setActiveService("当家球星");
    setActiveIcon("psychology");
    setHasEngaged(false);
    setMessages([]); 
    setSidebarOpen(false);
  };

  const handleSendMessage = async (text: string) => {
    setHasEngaged(true);
    const userMsg: Message = {
      id: `user-${Date.now()}`,
      sender: 'user',
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      parts: [{ type: 'text', content: text }]
    };
    
    setMessages(prev => [...prev, userMsg]);
    
    if (currentScreen === AppScreen.HOME) {
      setCurrentScreen(AppScreen.CHAT);
    }

    const isGeneralService = activeService === "当家球星" || activeService === "技术动作分析" || activeService === "AI 场外指导";

    if (activeService === "器材推荐") {
      setIsProcessing(true); // 开始思考
      const response = await getAIResponse(text, EQUIPMENT_ADVISOR_INSTRUCTION);
      setIsProcessing(false); // 结束思考
      const aiMsg: Message = {
        id: `ai-reply-${Date.now()}`,
        sender: 'ai',
        timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        parts: [{ type: 'text', content: response, isTyping: true }]
      };
      setMessages(prev => [...prev, aiMsg]);
      updateSessionTitle(text);
      return;
    }

    if (isGeneralService) {
      setIsProcessing(true); // 开始思考
      const response = await getAIResponse(text, DEFAULT_COACH_INSTRUCTION);
      setIsProcessing(false); // 结束思考
      const aiMsg: Message = {
        id: `ai-reply-${Date.now()}`,
        sender: 'ai',
        timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        parts: [{ type: 'text', content: response, isTyping: true }]
      };
      setMessages(prev => [...prev, aiMsg]);
      updateSessionTitle(text);
      return;
    }

    // Mock responses for other coaching services
    if (activeService === "正手拉球要领" || activeService === "接发球技巧") {
      setTimeout(() => {
        const aiMsg: Message = {
          id: `ai-reply-${Date.now()}`,
          sender: 'ai',
          timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
          parts: [{ 
            type: 'report', 
            reportData: { 
              techName: activeService, 
              problems: [
                { text: "重心交换要明显，由右脚传递到左脚。", timestamp: "" },
                { text: "挥拍要有摩擦，主要靠小臂的收缩和手腕的转动。", timestamp: "" }
              ], 
              improvements: [
                "每天坚持300次空拍练习，找肌肉记忆。",
                "多练多球，重点体会下旋拉上旋的摩擦点。"
              ],
              videoLinks: [
                { title: "樊振东正手拉球慢动作示范", url: "https://drive.google.com/file/d/13VkToMh1kvnbKRhHsLlgJ_D_WaT-Eef0/view" }
              ]
            },
            isTyping: true 
          }]
        };
        setMessages(prev => [...prev, aiMsg]);
      }, 1000);
    }
  };

  const updateSessionTitle = (text: string) => {
    const isFirstUserMsg = messages.filter(m => m.sender === 'user').length === 0;
    if (isFirstUserMsg) {
      const simplifiedTitle = text.length > 10 ? text.substring(0, 10) + "..." : text;
      handleUpdateTitle(simplifiedTitle);
    }
  };

  const handleStartAnalysis = (title: string, icon: string, initialText?: string) => {
    setActiveAudioId(null); 
    setActiveService(title);
    setActiveIcon(icon);
    
    if (initialText) {
      setMessages([]);
      setCurrentScreen(AppScreen.CHAT);
      setTimeout(() => {
        handleSendMessage(initialText);
      }, 50);
    } else {
      const initialMsgs = getInitialMessages(title);
      setMessages(initialMsgs);
      setCurrentScreen(AppScreen.CHAT);
    }

    const newSession: HistoryEntry = {
      id: `chat-${Date.now()}`,
      title: title,
      time: '刚刚',
      section: 'recent'
    };
    setHistory(prev => [newSession, ...prev]);
  };

  const handleUpdateTitle = (newTitle: string) => {
    setActiveService(newTitle);
    setHistory(prev => {
      const newHistory = [...prev];
      if (newHistory.length > 0) {
        newHistory[0] = { ...newHistory[0], title: newTitle };
      }
      return newHistory;
    });
  };

  const toggleSidebar = () => {
    setActiveAudioId(null); // 打开菜单栏时立即停止语音
    setSidebarOpen(true);
  };
  const closeSidebar = () => setSidebarOpen(false);

  const navigateToSettings = () => {
    setActiveAudioId(null);
    setPrevScreen(currentScreen);
    setCurrentScreen(AppScreen.SETTINGS);
    setSidebarOpen(false);
  };

  const navigateToAppearance = () => {
    setActiveAudioId(null);
    setCurrentScreen(AppScreen.APPEARANCE);
  };

  const handleBack = () => {
    setActiveAudioId(null);
    if (currentScreen === AppScreen.APPEARANCE) {
      setCurrentScreen(AppScreen.SETTINGS);
    } else if (currentScreen === AppScreen.SETTINGS) {
      setCurrentScreen(prevScreen);
      setSidebarOpen(true);
    }
  };

  const playVideo = (url: string) => {
    setActiveAudioId(null); // 点击跳转视频链接时停止语音
    setRawVideoUrl(url);
    const driveIdMatch = url.match(/\/d\/([a-zA-Z0-9_-]+)/) || url.match(/id=([a-zA-Z0-9_-]+)/);
    const fileId = driveIdMatch ? driveIdMatch[1] : '13VkToMh1kvnbKRhHsLlgJ_D_WaT-Eef0';
    setActiveVideoUrl(`https://drive.google.com/file/d/${fileId}/preview`);
  };

  const renderContent = () => {
    switch (currentScreen) {
      case AppScreen.HOME:
        return <HomeScreen onStartAnalysis={handleStartAnalysis} hasEngaged={hasEngaged} onPlayVideo={playVideo} />;
      case AppScreen.CHAT:
        return (
          <ChatScreen 
            messages={messages} 
            setMessages={setMessages} 
            hasEngaged={hasEngaged} 
            setHasEngaged={setHasEngaged} 
            onUpdateTitle={handleUpdateTitle}
            isAutoReadEnabled={isAutoReadEnabled}
            aiIcon={activeIcon}
            onPlayVideo={playVideo}
            activeAudioId={activeAudioId}
            onToggleAudio={setActiveAudioId}
            isProcessing={isProcessing} // 传入正在处理状态
          />
        );
      case AppScreen.SETTINGS:
        return (
          <SettingsScreen 
            onBack={handleBack} 
            onNavigateToAppearance={navigateToAppearance} 
            followSystem={false}
            appearanceMode={appearanceMode}
            isAutoReadEnabled={isAutoReadEnabled}
            onToggleAutoRead={setIsAutoReadEnabled}
            isAutoAnalyzeEnabled={isAutoAnalyzeEnabled}
            onToggleAutoAnalyze={setIsAutoAnalyzeEnabled}
          />
        );
      case AppScreen.APPEARANCE:
        return (
          <AppearanceSettingsScreen 
            onBack={handleBack} 
            appearanceMode={appearanceMode}
            setAppearanceMode={setAppearanceMode}
          />
        );
      default:
        return <HomeScreen onStartAnalysis={handleStartAnalysis} hasEngaged={hasEngaged} onPlayVideo={playVideo} />;
    }
  };

  return (
    <div className="fixed inset-0 bg-slate-100 dark:bg-black overflow-hidden font-body select-none transition-colors duration-300">
      <div className="relative flex flex-col w-full h-full max-w-lg mx-auto bg-slate-50 dark:bg-background-dark border-x border-slate-200 dark:border-white/5 overflow-hidden shadow-2xl transition-colors duration-300">
        
        <Sidebar 
          isOpen={isSidebarOpen} 
          onClose={closeSidebar} 
          onNavigate={(screen) => { 
            setActiveAudioId(null); 
            setCurrentScreen(screen); 
            setSidebarOpen(false); 
          }}
          onSettingsClick={navigateToSettings}
          historyItems={history}
        />
        
        <Header 
          onMenuClick={isSettingsFlow ? handleBack : toggleSidebar} 
          onHomeClick={handleResetToHome}
          title={currentScreen === AppScreen.HOME ? "当家球星" : currentScreen === AppScreen.SETTINGS ? "设置" : currentScreen === AppScreen.APPEARANCE ? "外观" : activeService}
          isBackMode={isSettingsFlow}
          hideHome={isSettingsFlow}
        />
        
        <main className="flex-1 relative overflow-hidden h-full">
          {renderContent()}
        </main>

        {!isSettingsFlow && (
          <div className="absolute bottom-0 left-0 right-0 z-[100]">
            <ChatInput onSend={(text) => {
              setActiveAudioId(null); // 发送新消息时停止朗读
              handleSendMessage(text);
            }} />
          </div>
        )}

        {/* 沉浸式视频播放层 */}
        {activeVideoUrl && (
          <div className="absolute inset-0 z-[1000] bg-black flex flex-col items-center justify-center animate-in fade-in duration-300">
            <div className="absolute top-0 left-0 right-0 p-6 flex justify-between items-center z-[1010] bg-gradient-to-b from-black/90 to-transparent">
              <div className="flex flex-col">
                <span className="text-white font-bold text-[12px] tracking-widest uppercase opacity-80">Video Preview</span>
                <span className="text-white/40 text-[9px]">Embedded Source Player</span>
              </div>
              <button 
                onClick={() => { setActiveVideoUrl(null); setRawVideoUrl(null); }}
                className="size-10 rounded-full bg-white/10 hover:bg-white/20 flex items-center justify-center text-white active:scale-90 transition-all border border-white/10"
              >
                <span className="material-symbols-outlined text-[24px]">close</span>
              </button>
            </div>
            
            <div className="w-full h-full flex items-center justify-center p-0">
              <div className="absolute size-10 rounded-full border-2 border-white/5 border-t-primary animate-spin"></div>
              <iframe 
                key={activeVideoUrl} 
                src={activeVideoUrl}
                className="w-full h-auto aspect-video max-h-full z-20 border-y border-white/5"
                allow="autoplay; fullscreen; encrypted-media; picture-in-picture"
                allowFullScreen
                frameBorder="0"
              ></iframe>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default App;

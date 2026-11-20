
import React, { useState, useEffect, useCallback, useRef } from 'react';
import { AppScreen } from './types.ts';
import type {
  ConversationSummary,
  Message,
  MessagePart,
  NewConversationMessage,
  PersistedMessage,
} from './types.ts';
import Sidebar from './components/Sidebar.tsx';
import Header from './components/Header.tsx';
import HomeScreen from './components/HomeScreen.tsx';
import ChatScreen from './components/ChatScreen.tsx';
import ChatInput from './components/ChatInput.tsx';
import SettingsScreen from './components/SettingsScreen.tsx';
import AppearanceSettingsScreen from './components/AppearanceSettingsScreen.tsx';
import LoginModal from './components/LoginModal.tsx';
import {
  appendConversationMessages,
  createConversation,
  getAIResponseV2,
  getConversation,
  listConversations,
  renameConversation,
} from './geminiService.ts';
import { getToken, logout, refreshSession, requestLogin, useAuthState } from './utils/auth.ts';

/** 入口名 → 图标（历史会话还原时用） */
const SERVICE_ICONS: Record<string, string> = {
  '技术动作分析': 'slow_motion_video',
  'AI 场外指导': 'person',
  '器材推荐': 'sports_tennis',
};

function iconForService(service?: string | null): string {
  return (service && SERVICE_ICONS[service]) || 'psychology';
}

function formatMessageTime(ts?: number | null): string {
  return new Date(ts ?? Date.now()).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/** payload（MessagePart[] 的 JSON 串）优先；坏 JSON 退回纯文本气泡 */
function partsFromPayload(payload: string | null, content: string): MessagePart[] {
  if (payload) {
    try {
      const parsed = JSON.parse(payload);
      if (Array.isArray(parsed) && parsed.length > 0) {
        return parsed.map((part: any) => ({ ...part, isTyping: false }));
      }
    } catch {
      /* 坏数据：退回纯文本 */
    }
  }
  return [{ type: 'text', content, isTyping: false }];
}

function messageFromPersisted(m: PersistedMessage): Message {
  return {
    id: m.id,
    sender: m.role === 'user' ? 'user' : 'ai',
    timestamp: formatMessageTime(m.created_at),
    parts: partsFromPayload(m.payload, m.content),
  };
}

/** 落库只保留能还原的纯文本 / 报告部件：blob 视频地址和截图 base64 刷新后就失效了 */
function persistableParts(parts: MessagePart[]): MessagePart[] {
  return parts.filter(part => part.type === 'text' || part.type === 'report');
}

function partsToContent(parts: MessagePart[]): string {
  return parts
    .map(part => {
      if (part.type === 'text') return part.content || '';
      if (part.type === 'report' && part.reportData) {
        return part.reportData.summaryText || part.reportData.techName || '';
      }
      return '';
    })
    .filter(Boolean)
    .join('\n')
    .trim();
}

const App: React.FC = () => {
  const [currentScreen, setCurrentScreen] = useState<AppScreen>(AppScreen.HOME);
  const [prevScreen, setPrevScreen] = useState<AppScreen>(AppScreen.HOME);
  const [activeService, setActiveService] = useState<string>("当家球星");
  const [activeServiceCategory, setActiveServiceCategory] = useState<string>("当家球星");
  const [activeIcon, setActiveIcon] = useState<string>("psychology");
  const [isSidebarOpen, setSidebarOpen] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);
  const [hasEngaged, setHasEngaged] = useState(false);
  const [appearanceMode, setAppearanceMode] = useState<'dark' | 'light'>(() => {
    try {
      const stored = localStorage.getItem('topstar-appearance-mode');
      if (stored === 'dark' || stored === 'light') return stored;
    } catch {}
    return 'dark';
  });
  const [isAutoReadEnabled, setIsAutoReadEnabled] = useState(false);
  const [isAutoAnalyzeEnabled, setIsAutoAnalyzeEnabled] = useState(true);

  // 新增：全局等待状态，用于控制“正在思考”
  const [isProcessing, setIsProcessing] = useState(false);

  const [activeVideoUrl, setActiveVideoUrl] = useState<string | null>(null);
  const [rawVideoUrl, setRawVideoUrl] = useState<string | null>(null);

  // 全局控制语音播放状态，确保切换页面或触发特定导航时能停止语音
  const [activeAudioId, setActiveAudioId] = useState<string | null>(null);

  // 登录态：对话、视频分析、语音朗读都需要登录
  const { user } = useAuthState();
  useEffect(() => {
    void refreshSession(); // 启动时向服务端确认令牌仍然有效
  }, []);

  // Define isSettingsFlow to determine if we are in a sub-menu flow
  // This fixes the 'isSettingsFlow' missing variable errors.
  const isSettingsFlow = currentScreen === AppScreen.SETTINGS || currentScreen === AppScreen.APPEARANCE;

  // 历史会话：来自服务端（按登录用户绑定），不再有硬编码假数据
  const [history, setHistory] = useState<ConversationSummary[]>([]);
  const [historyQuery, setHistoryQuery] = useState('');
  const [activeConversationId, setActiveConversationId] = useState<string | null>(null);
  // 发消息 / 落库回调里要用最新值，state 会有闭包延迟，这里用 ref 兜底
  const activeConversationIdRef = useRef<string | null>(null);
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const setConversationId = useCallback((id: string | null) => {
    activeConversationIdRef.current = id;
    setActiveConversationId(id);
  }, []);

  /** 拉历史会话列表；q 非空时为标题模糊搜索 */
  const refreshHistory = useCallback(async (q: string = '') => {
    if (!getToken()) {
      setHistory([]);
      return;
    }
    const items = await listConversations(q);
    setHistory(items);
  }, []);

  // 登录后拉列表；退出登录 / 令牌失效后清空本机历史
  useEffect(() => {
    if (user) {
      void refreshHistory('');
      setHistoryQuery('');
    } else {
      setHistory([]);
      setHistoryQuery('');
      setConversationId(null);
    }
  }, [user?.id, refreshHistory, setConversationId]);

  /** 侧边栏搜索：输入即响应，300ms 防抖后请求服务端 */
  const handleSearchHistory = useCallback((q: string) => {
    setHistoryQuery(q);
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    searchTimerRef.current = setTimeout(() => { void refreshHistory(q); }, 300);
  }, [refreshHistory]);

  useEffect(() => () => {
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
  }, []);

  useEffect(() => {
    const isDarkMode = appearanceMode === 'dark';
    if (isDarkMode) {
      document.documentElement.classList.add('dark');
      document.body.classList.add('dark');
    } else {
      document.documentElement.classList.remove('dark');
      document.body.classList.remove('dark');
    }
    try {
      localStorage.setItem('topstar-appearance-mode', appearanceMode);
    } catch {}
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

  /**
   * 不是 /chat 来源的消息（视频分析结果、本地 mock 回复）落库。
   * 还没有会话时先建一个，标题取首条用户消息。
   */
  const persistLocalMessages = useCallback(async (
    messages: NewConversationMessage[],
    titleHint?: string,
  ): Promise<string | null> => {
    if (!getToken()) return null;

    let conversationId = activeConversationIdRef.current;
    if (!conversationId) {
      const firstUser = messages.find(m => m.role === 'user');
      const created = await createConversation({
        title: titleHint || firstUser?.content,
        service: activeServiceCategory,
      });
      if (!created) return null;
      conversationId = created.id;
      setConversationId(conversationId);
    }

    await appendConversationMessages(conversationId, messages);
    void refreshHistory(historyQuery);
    return conversationId;
  }, [activeServiceCategory, historyQuery, refreshHistory, setConversationId]);

  /** 点开某条历史会话：拉详情 → 还原成 Message[] → 切到对话页 */
  const openConversation = useCallback(async (id: string) => {
    setActiveAudioId(null);
    const detail = await getConversation(id);
    if (!detail) {
      void refreshHistory(historyQuery); // 可能是别的设备删了，刷新列表
      return;
    }

    const service = detail.service || '当家球星';
    setConversationId(detail.id);
    setActiveService(service);
    setActiveServiceCategory(service);
    setActiveIcon(iconForService(service));
    setMessages(detail.messages.map(messageFromPersisted));
    setHasEngaged(true);
    setSidebarOpen(false);
    setCurrentScreen(AppScreen.CHAT);
  }, [historyQuery, refreshHistory, setConversationId]);

  const getActionCoachingCardTitle = (response: Awaited<ReturnType<typeof getAIResponseV2>>) => {
    const actionReference = response.references?.find(ref => ref.type === 'actions_doc' && ref.title?.trim());

    if (response.intent === 'VIDEO_ANALYSIS') {
      return actionReference?.title ? `${actionReference.title}技术动作诊断报告` : '技术动作诊断报告';
    }

    return actionReference?.title ? `${actionReference.title}技术指导` : '技术动作指导';
  };

  const handleResetToHome = () => {
    setActiveAudioId(null); // 立即停止当前语音
    setCurrentScreen(AppScreen.HOME);
    setActiveService("当家球星");
    setActiveServiceCategory("当家球星");
    setActiveIcon("psychology");
    setHasEngaged(false);
    setMessages([]);
    setSidebarOpen(false);
    setConversationId(null); // 回首页 = 开新对话
  };

  const handleSendMessage = async (text: string) => {
    if (!getToken()) {
      requestLogin('发送消息需要先登录');
      return;
    }
    setHasEngaged(true);
    const userMsgId = `user-${Date.now()}`;
    const userMsg: Message = {
      id: userMsgId,
      sender: 'user',
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      parts: [{ type: 'text', content: text }]
    };

    // 我们需要更新后的消息列表来构建历史
    const updatedMessages = [...messages, userMsg];
    setMessages(updatedMessages);

    if (currentScreen === AppScreen.HOME) {
      setCurrentScreen(AppScreen.CHAT);
    }

    const isAIService = activeServiceCategory === "当家球星" || activeServiceCategory === "技术动作分析" || activeServiceCategory === "AI 场外指导" || activeServiceCategory === "器材推荐";

    // 构建简化的历史记录发送给后端
    const chatHistory = updatedMessages
      .filter(m => m.id !== userMsgId) // 不包含当前的 userMsg，后端会单独处理 prompt
      .map(m => {
        const textParts = m.parts
          .filter(p => p.type === 'text')
          .map(p => p.content)
          .join('\n');

        const reportParts = m.parts
          .filter(p => p.type === 'report' && p.reportData)
          .map(p => {
            const rd = p.reportData!;
            return `报告：${rd.techName || ''}\n问题：${rd.problems.map(pr => pr.text).join('; ')}\n建议：${rd.improvements.join('; ')}`;
          })
          .join('\n');

        return {
          sender: m.sender,
          content: (textParts + '\n' + reportParts).trim()
        };
      })
      .filter(h => h.content.length > 0)
      .slice(-10);

    if (isAIService) {
      setIsProcessing(true);
      // conversationId 为空 → 后端新建会话并回传 id；clientMsgId 用于重试去重
      const response = await getAIResponseV2(text, chatHistory, undefined, {
        conversationId: activeConversationIdRef.current,
        service: activeServiceCategory,
        clientMsgId: userMsgId,
      });
      setIsProcessing(false);

      if (response.conversation_id && response.conversation_id !== activeConversationIdRef.current) {
        setConversationId(response.conversation_id);
      }
      void refreshHistory(historyQuery);
      
      const parts: MessagePart[] = [];
      
      // 统一化交互：优先使用聚合模式
      // 如果有推荐视频，我们将 answerText 和 videoLinks 塞进同一个 Report Card
      if (response.tutorialVideos && response.tutorialVideos.length > 0) {
        parts.push({
          type: 'report',
          isTyping: true,
          reportData: {
            techName: getActionCoachingCardTitle(response),
            summaryText: response.answerText, // 将文本内容注入作为综述
            problems: [], // Backend 尚未返回此结构，预留
            improvements: [], // Backend 尚未返回此结构，预留
            videoLinks: response.tutorialVideos.map(v => ({
              title: `[${v.platform === 'douyin' ? '抖音' : 'B站'}] ${v.title}`,
              url: v.url
            })),
            variant: 'gradient'
          }
        });
      } else {
        // 退化模式：只有文本
        parts.push({ type: 'text', content: response.answerText, isTyping: true });
      }
      
      const aiMsg: Message = {
        id: `ai-reply-${Date.now()}`,
        sender: 'ai',
        timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        parts: parts
      };
      setMessages(prev => [...prev, aiMsg]);
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
        // 本地 mock 回复也记进会话历史
        void persistLocalMessages([
          {
            role: 'user',
            content: text,
            payload: [{ type: 'text', content: text }],
            client_msg_id: userMsgId,
          },
          {
            role: 'assistant', // icon-check-ignore：消息角色，不是图标
            content: partsToContent(aiMsg.parts) || activeService,
            payload: persistableParts(aiMsg.parts),
          },
        ], text);
      }, 1000);
    }
  };

  const handleStartAnalysis = (title: string, icon: string, initialText?: string) => {
    setActiveAudioId(null);

    // 带预设问题的入口会直接发起对话，需要先登录；不带预设问题的入口只是打开聊天页，可以先看看
    if (initialText && !getToken()) {
      requestLogin('向教练提问需要先登录');
      return;
    }

    setActiveService(title);
    setActiveServiceCategory(title);
    setActiveIcon(icon);
    setConversationId(null); // 新入口 = 新会话，首条消息发出去时后端自动建

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

  };

  /** 视频分析等场景会按报告内容改标题（如「反手拧拉」），同步写回服务端 */
  const handleUpdateTitle = (newTitle: string) => {
    setActiveService(newTitle);
    const conversationId = activeConversationIdRef.current;
    if (!conversationId || !getToken()) return;
    void renameConversation(conversationId, newTitle).then(() => refreshHistory(historyQuery));
  };

  const handleLogout = async () => {
    await logout();
    // 退出登录只清本机：消息区、历史列表、当前会话；服务端数据保留，重新登录还能拉回来
    setHistory([]);
    setHistoryQuery('');
    setConversationId(null);
    handleResetToHome(); // 清掉上一个账号的对话内容
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
    if (!url) return;
    
    if (url.startsWith('blob:')) {
      setRawVideoUrl(url);
      setActiveVideoUrl(url);
    } else if (url.includes('drive.google.com')) {
      setRawVideoUrl(url);
      const driveIdMatch = url.match(/\/d\/([a-zA-Z0-9_-]+)/) || url.match(/id=([a-zA-Z0-9_-]+)/);
      const fileId = driveIdMatch ? driveIdMatch[1] : '13VkToMh1kvnbKRhHsLlgJ_D_WaT-Eef0';
      setActiveVideoUrl(`https://drive.google.com/file/d/${fileId}/preview`);
    } else {
      window.open(url, '_blank');
    }
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
            onPersistMessages={persistLocalMessages}
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
            user={user}
            onLogin={() => requestLogin('登录后可以使用对话、视频分析和语音朗读')}
            onLogout={handleLogout}
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
          historyQuery={historyQuery}
          onSearch={handleSearchHistory}
          onSelectConversation={openConversation}
          activeConversationId={activeConversationId}
          user={user}
          onLogin={() => requestLogin('登录后可以使用对话、视频分析和语音朗读')}
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
              if (!getToken()) {
                requestLogin('发送消息需要先登录，登录后点一下发送即可'); // 返回 false：输入框里的内容保留
                return false;
              }
              setActiveAudioId(null); // 发送新消息时停止朗读
              handleSendMessage(text);
            }} />
          </div>
        )}

        <LoginModal />

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
              {activeVideoUrl.startsWith('blob:') ? (
                <video
                  key={activeVideoUrl}
                  src={activeVideoUrl}
                  className="w-full h-auto aspect-video max-h-full z-20 border-y border-white/5"
                  controls
                  autoPlay
                  playsInline
                />
              ) : (
                <>
                  <div className="absolute size-10 rounded-full border-2 border-white/5 border-t-primary animate-spin"></div>
                  <iframe
                    key={activeVideoUrl}
                    src={activeVideoUrl}
                    className="w-full h-auto aspect-video max-h-full z-20 border-y border-white/5"
                    allow="autoplay; fullscreen; encrypted-media; picture-in-picture"
                    allowFullScreen
                    frameBorder="0"
                  ></iframe>
                </>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default App;

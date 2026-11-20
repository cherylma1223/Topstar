
export type MessageType = 'user' | 'ai';

export interface ProblemDetail {
  text: string;
  timestamp: string;
}

export interface VideoLink {
  title: string;
  url: string;
}

export interface MessagePart {
  type: 'text' | 'video' | 'report' | 'processing' | 'action-card' | 'video-screenshot';
  content?: string;
  videoUrl?: string;
  coverUrl?: string;
  screenshotUrl?: string;
  duration?: string;
  progress?: number;
  reportData?: AnalysisReport;
  isTyping?: boolean; // 新增：标识是否正在执行打字机效果
}

export interface Message {
  id: string;
  sender: MessageType;
  timestamp: string;
  parts: MessagePart[];
}

export interface AnalysisReport {
  techName?: string;
  summaryText?: string; // 新增：整合后的AI分析文本
  problems: ProblemDetail[];
  improvements: string[];
  videoLinks?: VideoLink[]; // 新增：参考视频链接
  variant?: 'blue' | 'gradient'; // 新增：颜色方案
}

/** 侧边栏「历史对话」的一行（来自 GET /api/v2/conversations） */
export interface ConversationSummary {
  id: string;
  title: string;
  service: string | null;
  message_count: number;
  last_message_at: number | null;
  created_at: number;
  updated_at: number;
  /** 标题模糊搜索的命中片段；不是搜索时为 null */
  snippet?: string | null;
}

/** 落库后的消息（GET /api/v2/conversations/:id 返回） */
export interface PersistedMessage {
  id: string;
  seq: number;
  role: 'user' | 'assistant'; // icon-check-ignore：'assistant' 是消息角色，不是图标
  /** 纯文本，拼 LLM 上下文用 */
  content: string;
  /** MessagePart[] 的 JSON 字符串；纯文本消息为 null */
  payload: string | null;
  client_msg_id: string | null;
  analysis_job_id: string | null;
  created_at: number;
}

export interface ConversationDetail extends ConversationSummary {
  messages: PersistedMessage[];
}

/** 追加到会话的消息（POST /conversations/:id/messages 的入参形态） */
export interface NewConversationMessage {
  role: 'user' | 'assistant'; // icon-check-ignore：'assistant' 是消息角色，不是图标
  content: string;
  payload?: MessagePart[] | null;
  client_msg_id?: string | null;
  analysis_job_id?: string | null;
}

export enum AppScreen {
  HOME = 'HOME',
  CHAT = 'CHAT',
  HISTORY = 'HISTORY',
  SETTINGS = 'SETTINGS',
  APPEARANCE = 'APPEARANCE'
}

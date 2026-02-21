
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
  problems: ProblemDetail[];
  improvements: string[];
  videoLinks?: VideoLink[]; // 新增：参考视频链接
  variant?: 'blue' | 'gradient'; // 新增：颜色方案
}

export enum AppScreen {
  HOME = 'HOME',
  CHAT = 'CHAT',
  HISTORY = 'HISTORY',
  SETTINGS = 'SETTINGS',
  APPEARANCE = 'APPEARANCE'
}

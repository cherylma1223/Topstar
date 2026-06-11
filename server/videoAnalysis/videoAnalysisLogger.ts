import fs from 'fs';
import path from 'path';

const LOG_FILE_PATH = path.join(__dirname, '../video_analysis.log');

export class VideoAnalysisLogger {
  private static writeLog(jobId: string, stage: string, type: 'INFO' | 'WARN' | 'ERROR', message: string, payload?: any) {
    const timestamp = new Date().toISOString();
    const payloadStr = payload ? `\nPayload: ${JSON.stringify(payload, null, 2)}` : '';
    const logEntry = `[${timestamp}] [Job: ${jobId}] [Stage: ${stage}] [${type}] ${message}${payloadStr}\n----------------------------------------\n`;
    try {
      fs.appendFileSync(LOG_FILE_PATH, logEntry, 'utf8');
    } catch (err: any) {
      console.error(`Failed to write to video analysis log file: ${err.message}`);
    }
  }

  static info(jobId: string, stage: string, message: string, payload?: any) {
    this.writeLog(jobId, stage, 'INFO', message, payload);
    console.log(`[Job: ${jobId}] [Stage: ${stage}] INFO: ${message}`);
  }

  static warn(jobId: string, stage: string, message: string, payload?: any) {
    this.writeLog(jobId, stage, 'WARN', message, payload);
    console.warn(`[Job: ${jobId}] [Stage: ${stage}] WARN: ${message}`);
  }

  static error(jobId: string, stage: string, message: string, payload?: any) {
    this.writeLog(jobId, stage, 'ERROR', message, payload);
    console.error(`[Job: ${jobId}] [Stage: ${stage}] ERROR: ${message}`);
  }
}

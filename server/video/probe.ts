/**
 * 视频元信息探测（基于 ffprobe）
 *
 * 部署环境需要安装 ffmpeg（含 ffprobe）；路径可用 FFPROBE_PATH 覆盖。
 * 探测失败一律返回 undefined 而不是抛错，不能因为拿不到时长就让整个上传失败。
 */
import { execFile } from 'child_process';

const PROBE_TIMEOUT_MS = 15_000;
let warnedMissing = false;

/** 解析 ffprobe 输出的秒数；非法、非正数返回 undefined；向下取整到整数秒 */
export function parseDurationSeconds(stdout: string): number | undefined {
  const value = Number.parseFloat(String(stdout).trim());
  if (!Number.isFinite(value) || value <= 0) return undefined;
  return Math.floor(value);
}

export function probeVideoDuration(filePath: string): Promise<number | undefined> {
  const bin = process.env.FFPROBE_PATH?.trim() || 'ffprobe';
  const args = [
    '-v', 'error',
    '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1',
    filePath,
  ];

  return new Promise(resolve => {
    execFile(bin, args, { timeout: PROBE_TIMEOUT_MS }, (err, stdout) => {
      if (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          if (!warnedMissing) {
            warnedMissing = true;
            console.warn(`[probe] 未找到 ${bin}，视频时长将留空。请安装 ffmpeg 或设置 FFPROBE_PATH。`);
          }
        } else {
          console.warn(`[probe] ffprobe 失败: ${err.message}`);
        }
        return resolve(undefined);
      }
      resolve(parseDurationSeconds(stdout));
    });
  });
}

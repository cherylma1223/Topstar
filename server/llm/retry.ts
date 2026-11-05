/**
 * 指数退避重试：处理 503/429 等临时性错误
 *
 * 从 routes/v1.ts 原样迁出（PR 1，行为不变）。
 */
export async function withRetry<T>(operation: () => Promise<T>, maxRetries = 3, initialDelay = 1000): Promise<T> {
  let lastError: Error | undefined;
  for (let i = 0; i <= maxRetries; i++) {
    try {
      return await operation();
    } catch (error: any) {
      lastError = error;
      const msg = error?.message || '';
      const isRetryable = msg.includes('503') || msg.includes('429') || msg.includes('overloaded') || msg.includes('UNAVAILABLE');
      if (i < maxRetries && isRetryable) {
        const delay = initialDelay * Math.pow(2, i);
        console.warn(`Gemini API overloaded. Retrying in ${delay}ms... (${i + 1}/${maxRetries})`);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      throw error;
    }
  }
  throw lastError;
}

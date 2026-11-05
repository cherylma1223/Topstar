import 'dotenv/config';
import path from 'path';
import { getVideoStorage, type VideoRef } from '../llm';
import { loadAnalysisKnowledge } from '../videoAnalysis/analysisKnowledgeLoader';
import { classifyTechnique } from '../videoAnalysis/techniqueClassifier';
import { evaluateClassification } from '../videoAnalysis/recognitionDecision';

/**
 * Pass 1.5 单独调试脚本
 *
 * 模型由 video_pass15 能力配置决定，可临时覆盖：
 *   LLM_VIDEO_PASS15_MODELS=gemini-2.5-flash npx tsx scripts/testPass15.ts
 */
async function test() {
  console.log('Loading knowledge...');
  loadAnalysisKnowledge();

  const storage = getVideoStorage();
  const videoPath = path.join(__dirname, '../uploads/f8dd74a1-939b-4b41-b365-e7d58d6c8e02.mov');
  console.log(`Uploading test video to ${storage.name}: ${videoPath}`);

  let video: VideoRef;
  try {
    video = await storage.upload(videoPath, 'video/quicktime');
  } catch (err: any) {
    console.error('Upload failed:', err.message);
    return;
  }

  try {
    console.log('Waiting for video processing...');
    video = await storage.waitReady(video);
    console.log(`Video ready: ${video.uri} (${video.mimeType})`);

    // Dummy segments representing the whole video
    const dummySegments = [{ start: '00:00', end: '00:15', description: 'Test segment' }];

    console.log('Running Pass 1.5 (Classification)...');
    const classResult = await classifyTechnique(video, dummySegments, 'test-job-id');

    console.log('\n=== CLASSIFICATION RESULT ===');
    console.log(JSON.stringify(classResult, null, 2));

    console.log('\n=== DECISION ENGINE ===');
    const decision = evaluateClassification(classResult);
    console.log(JSON.stringify(decision, null, 2));

  } catch (err) {
    console.error('Error during classification:', err);
  } finally {
    console.log(`Cleaning up ${storage.name} file...`);
    await storage.cleanup(video).catch(() => {});
  }
}

test().catch(console.error);

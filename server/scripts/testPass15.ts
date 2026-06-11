import 'dotenv/config';
import path from 'path';
import { getAI } from '../routes/v1';
import { loadAnalysisKnowledge } from '../videoAnalysis/analysisKnowledgeLoader';
import { classifyTechnique } from '../videoAnalysis/techniqueClassifier';
import { evaluateClassification } from '../videoAnalysis/recognitionDecision';

async function test() {
  console.log('Loading knowledge...');
  loadAnalysisKnowledge();

  const ai = getAI();
  const videoPath = path.join(__dirname, '../uploads/f8dd74a1-939b-4b41-b365-e7d58d6c8e02.mov');
  console.log(`Uploading test video: ${videoPath}`);
  
  let uploadResult: any;
  try {
    uploadResult = await ai.files.upload({
      file: videoPath,
      config: { mimeType: 'video/quicktime' },
    });
  } catch (err: any) {
    console.error('Upload failed:', err.message);
    return;
  }

  const geminiFileName: string = uploadResult.name;
  let file = uploadResult;
  let waitMs = 3000;
  
  console.log('Waiting for video processing...');
  while (file.state === 'PROCESSING') {
    await new Promise(r => setTimeout(r, waitMs));
    waitMs = Math.min(waitMs * 1.5, 10000);
    file = await ai.files.get({ name: geminiFileName });
  }

  if (file.state === 'FAILED') {
    console.error('Video processing failed on Gemini side.');
    return;
  }

  const fileData = { fileUri: file.uri as string, mimeType: (file.mimeType || 'video/quicktime') as string };
  console.log(`Video ready: ${fileData.fileUri} (${fileData.mimeType})`);

  // Dummy segments representing the whole video
  const dummySegments = [{ start: '00:00', end: '00:15', description: 'Test segment' }];

  try {
    console.log('Running Pass 1.5 (Classification)...');
    const classResult = await classifyTechnique(fileData, dummySegments, ai, 'gemini-2.5-flash', 'test-job-id');
    
    console.log('\n=== CLASSIFICATION RESULT ===');
    console.log(JSON.stringify(classResult, null, 2));

    console.log('\n=== DECISION ENGINE ===');
    const decision = evaluateClassification(classResult);
    console.log(JSON.stringify(decision, null, 2));

  } catch (err) {
    console.error('Error during classification:', err);
  } finally {
    console.log('Cleaning up Gemini file...');
    await ai.files.delete({ name: geminiFileName }).catch(() => {});
  }
}

test().catch(console.error);

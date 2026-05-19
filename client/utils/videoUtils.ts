/**
 * Utility functions for video processing on the client side.
 */

/**
 * Extracts the first frame (at 0.1s) of a video file and returns it as a Base64 Data URL.
 * @param file The video file to extract the frame from
 * @returns A Promise that resolves to the Base64 data URL of the extracted frame
 */
export const extractFirstFrame = (file: File): Promise<string> => {
  return new Promise((resolve, reject) => {
    const video = document.createElement('video');
    video.preload = 'metadata';
    video.muted = true;
    video.playsInline = true;
    
    // Create an object URL for the file
    const url = URL.createObjectURL(file);
    video.src = url;

    video.onloadedmetadata = () => {
      // Seek to 0.1s to avoid potential blank first frames
      video.currentTime = Math.min(0.1, video.duration || 0);
    };

    video.onseeked = () => {
      try {
        const canvas = document.createElement('canvas');
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        const ctx = canvas.getContext('2d');
        if (ctx) {
          ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
          const dataUrl = canvas.toDataURL('image/jpeg', 0.8);
          resolve(dataUrl);
        } else {
          reject(new Error('Failed to get canvas context'));
        }
      } catch (error) {
        reject(error);
      } finally {
        URL.revokeObjectURL(url);
      }
    };

    video.onerror = (error) => {
      URL.revokeObjectURL(url);
      reject(error);
    };
  });
};

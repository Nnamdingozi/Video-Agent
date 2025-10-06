
// lib/ai/videoAgent.ts
import { ElevenLabsClient } from 'elevenlabs';
import { Readable } from 'stream';
import fetch from 'node-fetch';
import 'dotenv/config';
import ffmpeg from 'fluent-ffmpeg';
import { createRequire } from 'module';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import { SupabaseClient } from '@supabase/supabase-js';

// --- Configuration ---
const huggingFaceToken = process.env.HUGGINGFACE_API_TOKEN!;
const elevenlabs = new ElevenLabsClient({ apiKey: process.env.ELEVENLABS_API_KEY! });// ✅ Use a clear variable name

if (!huggingFaceToken) {
  throw new Error("Missing HUGGINGFACE_API_TOKEN or ELEVENLABS_API_KEY");
}


// ✅ Use createRequire to safely import CommonJS packages in an ESM module

try {
  const require = createRequire(import.meta.url);

  // `require.resolve` gives the path to the main file of the package.
  // For `ffmpeg-static`, this path IS the path to the executable.
  const ffmpegPath = require.resolve('ffmpeg-static');

  // For `ffprobe-static`, we need to find its entry point and then construct
  // the path to the binary relative to it.
  const ffprobePath = require('ffprobe-static').path; // The simpler require pattern works here as it's a property.

  console.log(`[FFMPEG CONFIG] Resolved FFMPEG path: ${ffmpegPath}`);
  console.log(`[FFMPEG CONFIG] Resolved FFPROBE path: ${ffprobePath}`);

  if (!ffmpegPath) throw new Error("ffmpeg-static path could not be resolved.");
  if (!ffprobePath) throw new Error("ffprobe-static path could not be resolved.");
  
  ffmpeg.setFfmpegPath(ffmpegPath);
  ffmpeg.setFfprobePath(ffprobePath);
  
  console.log("[FFMPEG CONFIG] Paths set successfully.");

} catch (error) {
  console.error('[FFMPEG CONFIG] FATAL ERROR setting paths:', error);
  // Throwing here will stop the server from starting if FFmpeg is not found, which is good.
  throw error;
}


// --- Main Function ---
export async function generateVideoAndUpload(
  supabaseAdmin: SupabaseClient, 
  noteId: number, 
  noteText: string, 
  subjectName: string): Promise<string> {

  console.log("--- 🎬 VIDEO AGENT STARTED ---");

const huggingFaceToken = process.env.HUGGINGFACE_API_TOKEN!;
if (!huggingFaceToken) throw new Error("Missing HUGGINGFACE_API_TOKEN");
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-video-'));
  console.log(`[LOG] Created temporary directory: ${tempDir}`);

  try {
    const scenes = noteText.match(/[^.!?]+[.!?]+/g) || [];
    if (scenes.length === 0) throw new Error("Could not break note into scenes.");

    const sceneAssets: { audioPath: string; imagePath: string; duration: number }[] = [];

    for (let i = 0; i < scenes.length; i++) {
      const sceneText = scenes[i].trim();

// --- Generate Audio with ElevenLabs ---
      // --- Audio (ElevenLabs) ---
      const audioPath = path.join(tempDir, `scene_${i}.mp3`);
      try {
        console.log(`   🎤 Calling ElevenLabs SDK with .convertAsStream() for scene: "${sceneText}"`);
        
        // ✅ THE DEFINITIVE FIX: Using the exact pattern that you found works.
        const audioStream = await elevenlabs.textToSpeech.convertAsStream(
          "21m00Tcm4TlvDq8ikWAM", // voice_id
          { 
            text: sceneText, 
            model_id: "eleven_multilingual_v2" 
          }
        );

        const chunks: Buffer[] = [];
        for await (const chunk of audioStream as Readable) {
          chunks.push(chunk);
        }
        const audioBuffer = Buffer.concat(chunks);
        
        if (audioBuffer.length === 0) throw new Error("ElevenLabs SDK returned an empty audio stream.");

        await fs.writeFile(audioPath, audioBuffer);
        console.log(`   ✅ Audio saved to ${audioPath} (${audioBuffer.length} bytes)`);

      } catch (error: any) {
        console.error("   ❌ ERROR during ElevenLabs SDK audio generation:", error);
        if (error.statusCode === 401) {
            throw new Error("ElevenLabs authentication failed (401). Please check the API key on your Render server.");
        }
        throw new Error(`ElevenLabs SDK failed: ${error.message}`);
      }
      // --- Image (Hugging Face) ---
      const imagePath = path.join(tempDir, `scene_${i}.png`);
      try {
        const styleGuide: Record<string, string> = {
          'Biology': 'clear educational diagram style, vibrant colors, labels',
          'Chemistry': 'scientific illustration of molecules and reactions, digital art',
          'Physics': 'clean physics diagram, showing forces and vectors, minimalist',
          'History': 'realistic historical photograph style, black and white, cinematic lighting',
          'Literature': 'dramatic oil painting, expressive, rich colors',
          'Mathematics': 'clear handwritten chalkboard style, showing the steps of the equation',
        };
        const subjectStyle = styleGuide[subjectName] || "simple educational illustration";
        const imagePrompt = `An educational visual for a ${subjectName} tutorial about: "${sceneText}". Style: ${subjectStyle}.`;

        console.log(`   🎨 Calling Hugging Face API with prompt: "${imagePrompt}"`);

        const modelEndpoint = "https://api-inference.huggingface.co/models/stabilityai/stable-diffusion-xl-base-1.0";

        const fetchOptions = {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${huggingFaceToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ inputs: imagePrompt }),
        };

        let response = await fetch(modelEndpoint, fetchOptions);
        if (response.status === 503) {
          console.log("   ⏳ Model is loading, retrying after 20s...");
          await new Promise(resolve => setTimeout(resolve, 20000));
          response = await fetch(modelEndpoint, fetchOptions);
        }

        if (!response.ok) {
          const errorBody = await response.text();
          throw new Error(`Hugging Face API failed with status ${response.status}: ${errorBody}`);
        }

        const imageBuffer = await response.buffer();
        await fs.writeFile(imagePath, imageBuffer);
        console.log(`   ✅ Image saved (${imageBuffer.length} bytes)`);

      } catch (error) {
        console.error("   ❌ ERROR during Hugging Face image generation:", error);
        throw error;
      }



      const duration = await getAudioDuration(audioPath);
      sceneAssets.push({ audioPath, imagePath, duration });
    }

    // --- Assemble video ---
    console.log("\n--- 🎥 ASSEMBLING VIDEO WITH FFMPEG ---");
    const finalVideoPath = path.join(tempDir, "final_video.mp4");

    const imageListPath = path.join(tempDir, "imagelist.txt");
    const imageListContent = sceneAssets.map((a) => `file '${path.resolve(a.imagePath)}'\nduration ${a.duration}`).join("\n");
    await fs.writeFile(imageListPath, imageListContent);

    const audioListPath = path.join(tempDir, "audiolist.txt");
    const audioListContent = sceneAssets.map(a => `file '${path.resolve(a.audioPath)}'`).join("\n");
    await fs.writeFile(audioListPath, audioListContent);

    await new Promise<void>((resolve, reject) => {
      ffmpeg()
        .input(imageListPath)
        // ✅ FIX: Split options into separate strings
        .inputOptions(['-f', 'concat', '-safe', '0'])
        .input(audioListPath)
        .inputOptions(['-f', 'concat', '-safe', '0'])
        .outputOptions(['-c:v', 'libx264', '-c:a', 'aac', '-pix_fmt', 'yuv420p', '-shortest'])
        .on('end', () => resolve())
        .on('error', (err) => reject(err))
        .save(finalVideoPath);
    });

    const videoBuffer = await fs.readFile(finalVideoPath);
    if (videoBuffer.length === 0) throw new Error("FFmpeg produced an empty video file.");

    // ✅ Upload to Supabase and return the public URL
    const publicUrl = await uploadVideoToSupabase(supabaseAdmin, noteId, videoBuffer);
    return publicUrl;

  } finally {
    console.log(`   🗑️ Cleaning up temp directory: ${tempDir}`);
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

// --- Helper: Upload to Supabase Storage ---
async function uploadVideoToSupabase(supabaseAdmin: SupabaseClient, noteId: number, videoBuffer: Buffer): Promise<string> {
  const filePath = `note-videos/${noteId}.mp4`;
  console.log(`[SUPABASE] Uploading video to: ${filePath}`);

  const { error: uploadError } = await supabaseAdmin.storage
    .from('videos')
    .upload(filePath, videoBuffer, { contentType: 'video/mp4', upsert: true });

  if (uploadError) {
    console.error("[SUPABASE] Upload error:", uploadError);
    throw new Error("Failed to upload video to Supabase Storage.");
  }

  const { data } = supabaseAdmin.storage.from('videos').getPublicUrl(filePath);
  console.log(`[SUPABASE] Upload successful. Public URL: ${data.publicUrl}`);
  return data.publicUrl;
}

// --- Helper: Get Audio Duration ---
// ✅ FIX: This function is now correct and uses the configured ffprobe path
function getAudioDuration(filePath: string): Promise<number> {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, metadata) => {
      if (err) return reject(err);
      resolve(metadata.format.duration || 0);
    });
  });
}
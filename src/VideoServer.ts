import 'dotenv/config';
import { ElevenLabsClient } from 'elevenlabs';
import ffmpeg from 'fluent-ffmpeg';
import ffmpegStatic from 'ffmpeg-static';
import ffprobeStatic from 'ffprobe-static';
import ffprobePath from "ffprobe-static";
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import { Readable } from 'stream';
import fetch from 'node-fetch';
import { spawn } from "child_process";
import { createClient } from '@supabase/supabase-js';

// --- Supabase Setup ---
const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY! // use service key here
);

const BUCKET_NAME = "videos"; // ✅ create this bucket in Supabase dashboard

// --- Configuration ---
const elevenlabs = new ElevenLabsClient({ apiKey: process.env.ELEVENLABS_API_KEY! });
const huggingFaceToken = process.env.HUGGINGFACE_API_TOKEN!;

if (!huggingFaceToken) {
  throw new Error("Missing HUGGINGFACE_API_TOKEN environment variable.");
}

// ✅ Force ffmpeg to use portable binaries
ffmpeg.setFfmpegPath(ffmpegStatic!);
ffmpeg.setFfprobePath(ffprobeStatic.path);

console.log("[FFMPEG CONFIG] Using ffmpeg:", ffmpegStatic);
console.log("[FFPROBE CONFIG] Using ffprobe:", ffprobeStatic.path);

// --- Main Function ---
export async function generateVideoFromNote(noteText: string, subjectName: string): Promise<string> {
  console.log("--- 🎬 VIDEO AGENT STARTED ---");

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-video-'));
  console.log(`[LOG] Created temporary directory: ${tempDir}`);

  try {
    const scenes = noteText.match(/[^.!?]+[.!?]+/g) || [];
    if (scenes.length === 0) throw new Error("Could not break note into scenes.");

    const sceneAssets: { audioPath: string; imagePath: string; duration: number }[] = [];

    for (let i = 0; i < scenes.length; i++) {
      const sceneText = scenes[i].trim();
      console.log(`\n--- [SCENE ${i + 1}/${scenes.length}] START ---`);

      // --- Audio (ElevenLabs) ---
      const audioPath = path.join(tempDir, `scene_${i}.mp3`);
      try {
        console.log(`   🎤 Calling ElevenLabs API...`);
        const audioStream = await elevenlabs.textToSpeech.convert(
          "21m00Tcm4TlvDq8ikWAM",
          { text: sceneText, model_id: "eleven_multilingual_v2" }
        );
        const chunks: Buffer[] = [];
        for await (const chunk of audioStream as Readable) chunks.push(chunk);
        await fs.writeFile(audioPath, Buffer.concat(chunks));
        console.log(`   ✅ Audio saved.`);
      } catch (error) {
        console.error("   ❌ ERROR during ElevenLabs audio generation:", error);
        throw error;
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
      if (duration <= 0) throw new Error(`Audio for scene ${i + 1} has zero duration.`);
      console.log(`   ⏱️ Audio duration is ${duration} seconds.`);
      sceneAssets.push({ audioPath, imagePath, duration });
    }

    // --- Assemble video ---
    console.log("\n--- 🎥 ASSEMBLING VIDEO WITH FFMPEG ---");
    const finalVideoPath = path.join(tempDir, "final_video.mp4");

    const imageListPath = path.join(tempDir, "imagelist.txt");
    const imageListContent = sceneAssets.map((a) =>
      `file '${path.resolve(a.imagePath)}'\nduration ${a.duration}`
    ).join("\n");
    await fs.writeFile(imageListPath, imageListContent);

    const audioListPath = path.join(tempDir, "audiolist.txt");
    const audioListContent = sceneAssets.map(a =>
      `file '${path.resolve(a.audioPath)}'`
    ).join("\n");
    await fs.writeFile(audioListPath, audioListContent);

    await new Promise<void>((resolve, reject) => {
      ffmpeg()
        .input(imageListPath)
        .inputOptions(['-f concat', '-safe 0'])
        .input(audioListPath)
        .inputOptions(['-f concat', '-safe 0'])
        .outputOptions(['-c:v libx264', '-c:a aac', '-pix_fmt yuv420p', '-shortest'])
        .on('end', () => resolve())
        .on('error', (err) => reject(err))
        .save(finalVideoPath);
    });

    const videoBuffer = await fs.readFile(finalVideoPath);
    if (videoBuffer.length === 0) throw new Error("FFmpeg produced an empty video file.");

    console.log(`[AGENT] Final video size: ${videoBuffer.length} bytes.`);

    // --- Upload to Supabase Storage ---
    const fileName = `video_${Date.now()}.mp4`;
    const { error: uploadError } = await supabase
      .storage
      .from(BUCKET_NAME)
      .upload(fileName, videoBuffer, {
        contentType: 'video/mp4',
        upsert: true,
      });

    if (uploadError) throw uploadError;

    // ✅ Generate public URL
    const { data: { publicUrl } } = supabase
      .storage
      .from(BUCKET_NAME)
      .getPublicUrl(fileName);

    console.log(`[AGENT] Video uploaded to Supabase: ${publicUrl}`);

    return publicUrl;

  } finally {
    console.log(`   🗑️ Cleaning up temp directory: ${tempDir}`);
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

// --- Helper ---
export async function getAudioDuration(filePath: string): Promise<number> {
  console.log(`[FFPROBE] Checking duration for: ${filePath}`);

  return new Promise((resolve, reject) => {
    const probe = spawn(ffprobePath.path, [
      "-v", "error",
      "-show_entries", "format=duration",
      "-of", "default=noprint_wrappers=1:nokey=1",
      filePath,
    ]);

    let output = "";
    probe.stdout.on("data", (chunk) => {
      output += chunk;
    });

    probe.stderr.on("data", (err) => {
      console.error("[FFPROBE STDERR]:", err.toString());
    });

    probe.on("close", (code) => {
      if (code === 0) {
        const duration = parseFloat(output.trim());
        resolve(isNaN(duration) ? 0 : duration);
      } else {
        reject(new Error(`FFPROBE failed with code ${code}`));
      }
    });
  });
}

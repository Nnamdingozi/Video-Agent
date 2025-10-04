// src/index.ts
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import {generateVideoAndUpload } from './videoAgent.js'
import { createClient } from '@supabase/supabase-js';

const app = express();
const port = process.env.PORT || 3001; // Render/Railway will provide the PORT


// --- Middleware ---
app.use(cors()); // Allow requests from your Next.js app
app.use(express.json());



//supabase client with SERVICE_ROLE_KEY
const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

// --- The API Endpoint ---
app.post('/generate-video', async (req, res) => {
  console.log("--- [WORKER] Received /generate-video request ---");
  try {
    // Basic security: A simple secret key to ensure only your Next.js app can call this
    const authHeader = req.headers['authorization'];
    if (authHeader !== `Bearer ${process.env.WORKER_SECRET_KEY}`) {
      console.error("[WORKER] Unauthorized: Invalid or missing secret key.");
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const { noteId, noteText, subjectName } = req.body;
    if (!noteId || !noteText || !subjectName) {
      return res.status(400).json({ error: 'Missing required parameters.' });
    }

    // 1. Call the video agent to get the video buffer
    const videoBuffer = await generateVideoAndUpload(noteId, noteText, subjectName);

    // 2. Upload the buffer to Supabase Storage
    const filePath = `note-videos/${noteId}.mp4`;
    const { error: uploadError } = await supabaseAdmin.storage
      .from('videos')
      .upload(filePath, videoBuffer, { contentType: 'video/mp4', upsert: true });

    if (uploadError) {
      console.error("[WORKER] Supabase upload error:", uploadError);
      throw uploadError;
    }

    // 3. Get the public URL and return it
    const { data: { publicUrl } } = supabaseAdmin.storage.from('videos').getPublicUrl(filePath);
    console.log(`[WORKER] Success! Returning public URL: ${publicUrl}`);
    res.status(200).json({ status: 'complete', videoUrl: publicUrl });

  } catch (error: any) {
    console.error("[WORKER] FATAL ERROR:", error);
    res.status(500).json({ error: 'Failed to generate video.', details: error.message });
  }
});

app.listen(port, () => {
  console.log(`🚀 AI Video Worker is running on port ${port}`);
});
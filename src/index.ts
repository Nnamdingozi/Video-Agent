// src/index.ts
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { generateVideoAndUpload } from './videoAgent.js';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { Database } from './types/supabaseTypes.js'; // Adjust path to your types file

// --- CLIENT CREATION (The Single /Source of Truth) ---
const supabaseAdmin: SupabaseClient<Database> = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const app = express();
const port = process.env.PORT || 3001;

app.use(cors());
app.use(express.json({ limit: '50mb' })); // Increase body limit for potential large payloads if needed

// --- THE API ENDPOINT ---
app.post('/generate-video', async (req, res) => {
  console.log("--- [WORKER] Received /generate-video request ---");
  try {
    const authHeader = req.headers['authorization'];
    if (authHeader !== `Bearer ${process.env.WORKER_SECRET_KEY}`) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const { noteId, noteText, subjectName } = req.body;
    if (!noteId || !noteText || !subjectName) {
      return res.status(400).json({ error: 'Missing required parameters.' });
    }

    // ✅ THE INJECTION HAPPENS HERE:
    // We call the agent and pass `supabaseAdmin` as the first argument.
    // The agent now has everything it needs to do its job.
    const publicUrl = await generateVideoAndUpload(supabaseAdmin, noteId, noteText, subjectName);

    // The agent has already done the generation AND the upload.
    // All we have to do is forward the final URL to the client.
    console.log(`[WORKER] Agent finished successfully. Returning public URL to client.`);
    res.status(200).json({ status: 'complete', videoUrl: publicUrl });

  } catch (error: any) {
    console.error("[WORKER] A fatal error occurred:", error);
    res.status(500).json({ error: 'Failed to generate video.', details: error.message });
  }
});

app.listen(port, () => {
  console.log(`🚀 AI Video Worker is running on port ${port}`);
});
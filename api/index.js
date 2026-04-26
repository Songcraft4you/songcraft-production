import express from 'express';
import cors from 'cors';
import crypto from 'crypto';
import Anthropic from '@anthropic-ai/sdk';
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
const port = process.env.PORT || 3001;

// Initialize Anthropic client
const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

// Initialize Supabase with Service Role Key (admin access, bypasses RLS)
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Lemon Squeezy Plan Mapping: Variant ID -> plan_level
const PLAN_MAP = {
  '1495187': 1,  // Genesis — Standard Plan
  '1495203': 2,  // Studio Elite Plan
};

// Middleware
app.use(cors());

// IMPORTANT: Raw body needed for Lemon Squeezy signature verification
// Must be registered BEFORE express.json()
app.use('/api/lemon-webhook', express.raw({ type: 'application/json' }));
app.use(express.json());

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ============================================================================
// LEMON SQUEEZY WEBHOOK
// ============================================================================
app.post('/api/lemon-webhook', async (req, res) => {
  try {
    // Verify signature
    const signature = req.headers['x-signature'];
    const rawBody = req.body; // Buffer (raw body)

    if (!signature) {
      console.error('Missing x-signature header');
      return res.status(401).json({ error: 'Missing signature' });
    }

    const hmac = crypto.createHmac('sha256', process.env.LEMON_SQUEEZY_WEBHOOK_SECRET);
    const digest = hmac.update(rawBody).digest('hex');

    const isValid = crypto.timingSafeEqual(
      Buffer.from(digest, 'hex'),
      Buffer.from(signature, 'hex')
    );

    if (!isValid) {
      console.error('Invalid webhook signature');
      return res.status(401).json({ error: 'Invalid signature' });
    }

    // Parse the body
    const event = JSON.parse(rawBody.toString());
    const eventName = event.meta?.event_name;
    const data = event.data?.attributes;

    console.log(`📩 Lemon Squeezy Event: ${eventName}`);

    // --- SUBSCRIPTION CREATED or ORDER CREATED ---
    if (eventName === 'subscription_created' || eventName === 'order_created') {
      const email = data?.user_email;
      const variantId = String(data?.variant_id || data?.first_order_item?.variant_id);
      const lemonSqueezyId = String(event.data?.id);
      const planLevel = PLAN_MAP[variantId];

      if (!email) {
        return res.status(400).json({ error: 'No email in payload' });
      }

      if (planLevel === undefined) {
        console.warn(`⚠️ Unknown variant ID: ${variantId}`);
        return res.status(200).json({ message: 'Unknown variant, skipped.' });
      }

      // Update user profile in Supabase
      const { error: updateError } = await supabase
        .from('profiles')
        .update({ plan_level: planLevel, lemon_squeezy_id: lemonSqueezyId })
        .eq('email', email);

      if (updateError) {
        console.error('Supabase update error:', updateError);
        return res.status(500).json({ error: 'Database update failed' });
      }

      console.log(`✅ User ${email} upgraded to plan_level ${planLevel}`);
      return res.status(200).json({ success: true, email, planLevel });
    }

    // --- SUBSCRIPTION CANCELLED or EXPIRED ---
    if (eventName === 'subscription_cancelled' || eventName === 'subscription_expired') {
      const email = data?.user_email;

      if (!email) {
        return res.status(400).json({ error: 'No email in payload' });
      }

      const { error: downgradeError } = await supabase
        .from('profiles')
        .update({ plan_level: 0, lemon_squeezy_id: null })
        .eq('email', email);

      if (downgradeError) {
        console.error('Supabase downgrade error:', downgradeError);
        return res.status(500).json({ error: 'Database downgrade failed' });
      }

      console.log(`⬇️ User ${email} downgraded to plan_level 0 (Explorer)`);
      return res.status(200).json({ success: true, email, planLevel: 0 });
    }

    // All other events — acknowledge
    return res.status(200).json({ message: `Event ${eventName} acknowledged.` });

  } catch (err) {
    console.error('Webhook handler error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ============================================================================
// SONG IDEAS GENERATION
// ============================================================================
app.post('/api/generate-ideas', async (req, res) => {
  try {
    const { genre, mood, language = 'de' } = req.body;

    if (!genre || !mood) {
      return res.status(400).json({ error: 'genre and mood are required' });
    }

    const prompt = language === 'de'
      ? `Generiere 3 kreative Songideen für das Genre "${genre}" mit der Stimmung "${mood}". 
         Gib für jede Idee einen Titel und eine kurze Beschreibung (1-2 Sätze).
         Format: 
         1. [Titel]: [Beschreibung]
         2. [Titel]: [Beschreibung]
         3. [Titel]: [Beschreibung]`
      : `Generate 3 creative song ideas for the genre "${genre}" with the mood "${mood}".
         Provide a title and brief description (1-2 sentences) for each idea.
         Format:
         1. [Title]: [Description]
         2. [Title]: [Description]
         3. [Title]: [Description]`;

    const message = await anthropic.messages.create({
      model: 'claude-opus-4-1',
      max_tokens: 1024,
      messages: [{ role: 'user', content: prompt }],
    });

    const content = message.content[0].type === 'text' ? message.content[0].text : '';

    res.json({
      success: true,
      ideas: content,
      usage: {
        input_tokens: message.usage.input_tokens,
        output_tokens: message.usage.output_tokens,
      },
    });
  } catch (error) {
    console.error('Error generating ideas:', error);
    res.status(500).json({ error: 'Failed to generate ideas', details: error.message });
  }
});

// ============================================================================
// LYRICS GENERATION
// ============================================================================
app.post('/api/generate-lyrics', async (req, res) => {
  try {
    const { title, genre, mood, theme, language = 'de' } = req.body;

    if (!title || !genre || !mood) {
      return res.status(400).json({ error: 'title, genre, and mood are required' });
    }

    const prompt = language === 'de'
      ? `Schreibe Songtext für einen Song mit dem Titel "${title}".
         Genre: ${genre}
         Stimmung: ${mood}
         ${theme ? `Thema: ${theme}` : ''}
         Der Song sollte Verse, Chorus und Bridge haben.
         Gib nur den Songtext aus, ohne weitere Erklärungen.`
      : `Write song lyrics for a song titled "${title}".
         Genre: ${genre}
         Mood: ${mood}
         ${theme ? `Theme: ${theme}` : ''}
         The song should have verses, chorus, and bridge.
         Provide only the lyrics, without additional explanations.`;

    const message = await anthropic.messages.create({
      model: 'claude-opus-4-1',
      max_tokens: 2048,
      messages: [{ role: 'user', content: prompt }],
    });

    const content = message.content[0].type === 'text' ? message.content[0].text : '';

    res.json({
      success: true,
      lyrics: content,
      usage: {
        input_tokens: message.usage.input_tokens,
        output_tokens: message.usage.output_tokens,
      },
    });
  } catch (error) {
    console.error('Error generating lyrics:', error);
    res.status(500).json({ error: 'Failed to generate lyrics', details: error.message });
  }
});

// ============================================================================
// GENERIC GENERATE (Anthropic Proxy for tool.html)
// ============================================================================
app.post('/api/generate', async (req, res) => {
  try {
    const { model, max_tokens, messages } = req.body;

    if (!messages || !Array.isArray(messages)) {
      return res.status(400).json({ error: 'messages array is required' });
    }

    const message = await anthropic.messages.create({
      model: model || 'claude-opus-4-1',
      max_tokens: max_tokens || 8000,
      messages,
    });

    const content = message.content.map(c => c.text || '').join('');

    res.json({
      success: true,
      content: [{ type: 'text', text: content }],
      usage: {
        input_tokens: message.usage.input_tokens,
        output_tokens: message.usage.output_tokens,
      },
    });
  } catch (error) {
    console.error('Error in generate endpoint:', error);
    res.status(500).json({ error: 'Failed to generate', details: error.message });
  }
});

// ============================================================================
// GENERIC MESSAGE
// ============================================================================
app.post('/api/message', async (req, res) => {
  try {
    const { messages, systemPrompt, maxTokens = 2048 } = req.body;

    if (!messages || !Array.isArray(messages)) {
      return res.status(400).json({ error: 'messages array is required' });
    }

    const messageParams = {
      model: 'claude-opus-4-1',
      max_tokens: maxTokens,
      messages,
    };

    if (systemPrompt) {
      messageParams.system = systemPrompt;
    }

    const message = await anthropic.messages.create(messageParams);
    const content = message.content[0].type === 'text' ? message.content[0].text : '';

    res.json({
      success: true,
      content,
      usage: {
        input_tokens: message.usage.input_tokens,
        output_tokens: message.usage.output_tokens,
      },
    });
  } catch (error) {
    console.error('Error in message endpoint:', error);
    res.status(500).json({ error: 'Failed to process message', details: error.message });
  }
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Endpoint not found' });
});

// Error handler
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error', details: err.message });
});

app.listen(port, () => {
  console.log(`SongCraft Backend running on port ${port}`);

  // ============================================================================
  // SUPABASE KEEP-ALIVE PING
  // Verhindert automatisches Pausieren des Free-Tier Projekts
  // Sendet alle 4 Tage einen Ping an Supabase
  // ============================================================================
  const SUPABASE_PING_URL = process.env.SUPABASE_URL;
  const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || 'sb_publishable_u-kXysGRx4PYl9Abr2ZZmw_zg9W7XnIqMvhJLFpRoYbDsECeTuKAZGd';
  const FOUR_DAYS_MS = 4 * 24 * 60 * 60 * 1000; // 4 Tage in Millisekunden

  async function pingSupabase() {
    const timestamp = new Date().toISOString();
    try {
      const response = await fetch(`${SUPABASE_PING_URL}/rest/v1/`, {
        method: 'GET',
        headers: {
          'apikey': SUPABASE_ANON_KEY,
          'Authorization': `Bearer ${SUPABASE_ANON_KEY}`
        }
      });
      console.log(`[${timestamp}] ✅ Supabase Keep-Alive Ping: Status ${response.status}`);
    } catch (error) {
      console.error(`[${timestamp}] ❌ Supabase Ping Fehler:`, error.message);
    }
  }

  // Sofort beim Start pingen
  pingSupabase();

  // Dann alle 4 Tage wiederholen
  setInterval(pingSupabase, FOUR_DAYS_MS);
  console.log('✅ Supabase Keep-Alive Ping aktiviert (alle 4 Tage)');
});

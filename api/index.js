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
// Lazy initialization to avoid crash if env vars not set at startup
function getSupabase() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set');
  }
  return createClient(url, key);
}

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
      const supabase = getSupabase();
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

      const supabase = getSupabase();
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
// AUTH HELPER — Verifies Supabase JWT and returns user profile
// ============================================================================
async function verifyAndGetProfile(req) {
  const authHeader = req.headers['authorization'];
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return { error: 'UNAUTHORIZED', message: 'Kein Login-Token gefunden. Bitte einloggen.' };
  }
  const token = authHeader.slice(7);
  const supabase = getSupabase();

  // Verify the JWT with Supabase
  const { data: { user }, error: authError } = await supabase.auth.getUser(token);
  if (authError || !user) {
    return { error: 'UNAUTHORIZED', message: 'Ungültiger oder abgelaufener Login. Bitte neu einloggen.' };
  }

  // Fetch user profile (plan_level, free_credits_used)
  const { data: profile, error: profileError } = await supabase
    .from('profiles')
    .select('plan_level, free_credits_used, email')
    .eq('id', user.id)
    .single();

  if (profileError || !profile) {
    // Profile might not exist yet — create it with defaults
    const { data: newProfile, error: insertError } = await supabase
      .from('profiles')
      .insert({ id: user.id, email: user.email, plan_level: 0, free_credits_used: 0 })
      .select('plan_level, free_credits_used, email')
      .single();
    if (insertError) {
      return { error: 'DB_ERROR', message: 'Datenbankfehler beim Laden des Profils.' };
    }
    return { user, profile: newProfile };
  }

  return { user, profile };
}

// ============================================================================
// PLAN CHECK HELPER — Returns error if user is not allowed to generate
// Level 0 (Explorer): 1 free generation, then blocked
// Level 1+ (paid): unlimited
// ============================================================================
const FREE_GENERATION_LIMIT = 1;

async function checkAndConsumeCredit(userId, profile) {
  const supabase = getSupabase();
  const planLevel = profile.plan_level || 0;
  const creditsUsed = profile.free_credits_used || 0;

  // Paid plans — always allowed
  if (planLevel >= 1) {
    return { allowed: true };
  }

  // Explorer (Level 0) — check free credit
  if (creditsUsed >= FREE_GENERATION_LIMIT) {
    return {
      allowed: false,
      error: 'NO_CREDITS',
      message: `Dein kostenloses Kontingent ist aufgebraucht. Upgrade auf Genesis oder Studio Elite um weiter zu generieren.`,
      upgradeUrl: 'https://songcraft4you.com/pricing'
    };
  }

  // Consume the free credit
  const { error: updateError } = await supabase
    .from('profiles')
    .update({ free_credits_used: creditsUsed + 1 })
    .eq('id', userId);

  if (updateError) {
    console.error('Credit update error:', updateError);
    // Allow anyway to not block the user on DB errors
  }

  return { allowed: true, creditsRemaining: FREE_GENERATION_LIMIT - creditsUsed - 1 };
}

// ============================================================================
// GENERIC GENERATE (Anthropic Proxy for tool.html) — with Auth + Plan Check
// Uses internal Anthropic streaming to avoid Railway's 30s idle timeout
// ============================================================================
app.post('/api/generate', async (req, res) => {
  try {
    const { model, max_tokens, messages } = req.body;

    if (!messages || !Array.isArray(messages)) {
      return res.status(400).json({ error: 'messages array is required' });
    }

    // —— AUTH CHECK ——
    const authResult = await verifyAndGetProfile(req);
    if (authResult.error) {
      return res.status(401).json({ error: authResult.error, message: authResult.message });
    }
    const { user, profile } = authResult;

    // —— PLAN CHECK ——
    const creditResult = await checkAndConsumeCredit(user.id, profile);
    if (!creditResult.allowed) {
      return res.status(403).json({
        error: creditResult.error,
        message: creditResult.message,
        upgradeUrl: creditResult.upgradeUrl
      });
    }

    const planLevel = profile.plan_level || 0;
    console.log(`✅ Generate: user=${profile.email}, plan=${planLevel}, creditsRemaining=${creditResult.creditsRemaining ?? 'unlimited'}`);

    // ============================================================
    // ROUTING WEICHE: Plan-Level bestimmt die Engine
    // Level 0 (Explorer):     Haiku + Haiku  (Recursive Light)
    // Level 1 (Genesis):      Sonnet One-Shot (High Quality)
    // Level 2 (Studio Elite): Haiku + Sonnet  (Full Recursive DNA)
    // ============================================================

    // Helper: run a single Anthropic call with internal streaming
    async function runClaude(mdl, maxTok, msgs) {
      let text = '';
      let inTok = 0, outTok = 0;
      const stream = await anthropic.messages.create({
        model: mdl,
        max_tokens: maxTok,
        messages: msgs,
        stream: true,
      });
      for await (const ev of stream) {
        if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta') text += ev.delta.text;
        if (ev.type === 'message_start' && ev.message?.usage) inTok = ev.message.usage.input_tokens || 0;
        if (ev.type === 'message_delta' && ev.usage) outTok = ev.usage.output_tokens || 0;
      }
      return { text, inTok, outTok };
    }

    // Helper: extract content between tags, fallback to full text
    function extractTag(text, tag) {
      const m = text.match(new RegExp(`<${tag}>([\\s\\S]*?)<\/${tag}>`, 'i'));
      return m ? m[1].trim() : text.trim();
    }

    let finalText = '';
    let totalIn = 0, totalOut = 0;
    let engineLog = '';

    if (planLevel === 1) {
      // ── GENESIS: One-Shot mit Sonnet ──────────────────────────
      const r = await runClaude('claude-sonnet-4-5', max_tokens || 4000, messages);
      finalText = r.text;
      totalIn = r.inTok; totalOut = r.outTok;
      engineLog = 'Genesis One-Shot Engine (Claude Sonnet)';

    } else if (planLevel >= 2) {
      // ── STUDIO ELITE: Full Recursive DNA (Haiku → Sonnet) ────
      // STEP 1+2: DRAFT + AUDIT via Haiku
      const draftPrompt = [
        ...messages,
        { role: 'assistant', content: '' }
      ];
      // Remove empty assistant message, just use original messages for draft
      const draft = await runClaude('claude-haiku-4-5', 3000, messages);
      totalIn += draft.inTok; totalOut += draft.outTok;
      const draftText = draft.text;

      // 2.5s pause to avoid rate limit
      await new Promise(r => setTimeout(r, 2500));

      // STEP 2: AUDIT — Haiku als feindseliger Kritiker
      const auditMessages = [
        {
          role: 'user',
          content: `Du bist ein gnadenloser Musik-Kritiker. Analysiere diesen Song-Entwurf und finde EXAKT 3 Schwachstellen. Sei scharf und präzise. Gib einen Score von 1-10 (ein guter Auditor gibt nie über 5).

Entwurf:
${draftText}

Format:
<audit>
Schwachstelle 1: [Beschreibung]
Schwachstelle 2: [Beschreibung]
Schwachstelle 3: [Beschreibung]
Score: [X]/10
</audit>`
        }
      ];
      const audit = await runClaude('claude-haiku-4-5', 1000, auditMessages);
      totalIn += audit.inTok; totalOut += audit.outTok;
      const auditText = extractTag(audit.text, 'audit');

      // 2.5s pause
      await new Promise(r => setTimeout(r, 2500));

      // STEP 3+4: REFINEMENT + BLUEPRINT via Sonnet
      const originalUserMsg = messages[messages.length - 1]?.content || '';
      const refinementMessages = [
        {
          role: 'user',
          content: `Du bist ein Elite-Song-Engineer. Du erhältst einen Roh-Entwurf und einen Kritik-Bericht.

Original-Anfrage: ${originalUserMsg}

Roh-Entwurf:
${draftText}

Kritik-Bericht (3 Schwachstellen die du eliminieren MUSST):
${auditText}

Deine Aufgabe:
1. Rekonstruiere den Song komplett neu
2. Eliminiere alle 3 Schwachstellen
3. Injiziere Resonanz-Engineering (Vocal Fry, Micro-Tremolo, Solfeggio-Frequenzen wie 528Hz, 432Hz)
4. Gib das Ergebnis in <output> Tags aus
5. Gib eine kurze Engineering-Zusammenfassung in <engineering_log> Tags aus (was wurde verbessert)

Liefere ein produktionsfertiges Ergebnis.`
        }
      ];
      const refined = await runClaude('claude-sonnet-4-5', max_tokens || 4000, refinementMessages);
      totalIn += refined.inTok; totalOut += refined.outTok;

      finalText = extractTag(refined.text, 'output') || refined.text;
      engineLog = extractTag(refined.text, 'engineering_log') || `3 Schwachstellen eliminiert. Solfeggio-Frequenzen kalibriert.`;

    } else {
      // ── EXPLORER: Recursive Light (Haiku + Haiku) ────────────
      const draft = await runClaude('claude-haiku-4-5', 2000, messages);
      totalIn += draft.inTok; totalOut += draft.outTok;
      const draftText = draft.text;

      // 2.5s pause
      await new Promise(r => setTimeout(r, 2500));

      // Light Audit + Refinement in einem Haiku-Call
      const refineMessages = [
        {
          role: 'user',
          content: `Verbessere diesen Song-Entwurf. Finde die 2 größten Schwächen und eliminiere sie. Gib nur das verbesserte Ergebnis aus.

Entwurf:
${draftText}`
        }
      ];
      const refined = await runClaude('claude-haiku-4-5', 2000, refineMessages);
      totalIn += refined.inTok; totalOut += refined.outTok;
      finalText = refined.text;
      engineLog = 'Explorer Recursive Light Engine';
    }

    // Return standard JSON response
    res.json({
      success: true,
      content: [{ type: 'text', text: finalText }],
      engineering_log: engineLog,
      plan_level: planLevel,
      usage: { input_tokens: totalIn, output_tokens: totalOut },
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

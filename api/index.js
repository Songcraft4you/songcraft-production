import express from 'express';
import cors from 'cors';
import Anthropic from '@anthropic-ai/sdk';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
const port = process.env.PORT || 3001;

// Initialize Anthropic client
const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

// Middleware
app.use(cors());
app.use(express.json());

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Song ideas generation endpoint
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
      messages: [
        {
          role: 'user',
          content: prompt,
        },
      ],
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
    res.status(500).json({
      error: 'Failed to generate ideas',
      details: error.message,
    });
  }
});

// Lyrics generation endpoint
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
         
         Der Song sollte:
         - Verse, Chorus und Bridge haben
         - Emotional und authentisch sein
         - Zum Genre und zur Stimmung passen
         
         Gib nur den Songtext aus, ohne weitere Erklärungen.`
      : `Write song lyrics for a song titled "${title}".
         Genre: ${genre}
         Mood: ${mood}
         ${theme ? `Theme: ${theme}` : ''}
         
         The song should:
         - Have verses, chorus, and bridge
         - Be emotional and authentic
         - Match the genre and mood
         
         Provide only the lyrics, without additional explanations.`;

    const message = await anthropic.messages.create({
      model: 'claude-opus-4-1',
      max_tokens: 2048,
      messages: [
        {
          role: 'user',
          content: prompt,
        },
      ],
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
    res.status(500).json({
      error: 'Failed to generate lyrics',
      details: error.message,
    });
  }
});

// Generic message endpoint for future extensibility
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
    res.status(500).json({
      error: 'Failed to process message',
      details: error.message,
    });
  }
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Endpoint not found' });
});

// Error handler
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({
    error: 'Internal server error',
    details: err.message,
  });
});

app.listen(port, () => {
  console.log(`SongCraft Backend running on port ${port}`);
});

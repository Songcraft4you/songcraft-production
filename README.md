# SongCraft4You Backend API

Clean, production-ready Node.js backend for SongCraft4You. Provides AI-powered song generation via Anthropic Claude API.

## Architecture

```
Frontend (Netlify) → Backend API (Railway) → Anthropic Claude API
```

## Setup

### 1. Install Dependencies
```bash
npm install
```

### 2. Configure Environment
Create `.env` file:
```env
ANTHROPIC_API_KEY=sk-ant-api03-...
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_ANON_KEY=your-anon-key
PORT=3001
NODE_ENV=production
```

### 3. Run Locally
```bash
npm run dev
```

### 4. Deploy to Railway
```bash
# Railway will auto-detect Node.js and run: npm start
# Environment variables are set in Railway dashboard
```

## API Endpoints

### Health Check
```
GET /health
```
Response: `{ status: "ok", timestamp: "..." }`

### Generate Song Ideas
```
POST /api/generate-ideas
Content-Type: application/json

{
  "genre": "Pop",
  "mood": "Happy",
  "language": "de" // or "en"
}
```

Response:
```json
{
  "success": true,
  "ideas": "1. Title: Description\n2. Title: Description\n3. Title: Description",
  "usage": {
    "input_tokens": 150,
    "output_tokens": 250
  }
}
```

### Generate Lyrics
```
POST /api/generate-lyrics
Content-Type: application/json

{
  "title": "Song Title",
  "genre": "Pop",
  "mood": "Happy",
  "theme": "Love", // optional
  "language": "de" // or "en"
}
```

Response:
```json
{
  "success": true,
  "lyrics": "Verse 1:\n...\n\nChorus:\n...",
  "usage": {
    "input_tokens": 200,
    "output_tokens": 800
  }
}
```

### Generic Message Endpoint
```
POST /api/message
Content-Type: application/json

{
  "messages": [
    { "role": "user", "content": "Your message" }
  ],
  "systemPrompt": "Optional system prompt",
  "maxTokens": 2048
}
```

## Error Handling

All errors return JSON with status code and message:
```json
{
  "error": "Error description",
  "details": "Additional error info"
}
```

## CORS

CORS is enabled for all origins. Restrict in production if needed.

## Security Notes

- Never commit `.env` file
- Keep `ANTHROPIC_API_KEY` secret
- Use environment variables for all sensitive data
- Validate all incoming requests

## Deployment

### Railway
1. Connect GitHub repository
2. Set environment variables in Railway dashboard
3. Railway auto-deploys on push to main
4. Get your Railway URL from dashboard

## Development

### Local Testing
```bash
curl -X POST http://localhost:3001/api/generate-ideas \
  -H "Content-Type: application/json" \
  -d '{"genre":"Pop","mood":"Happy","language":"de"}'
```

### Logs
Check Railway dashboard for production logs.

## License

Proprietary - SongCraft4You

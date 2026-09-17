# HomeoHelp — Deployment Guide

## Project Structure
```
homeohelp/
├── api/
│   └── chat.js          ← Serverless backend (Groq key lives here)
├── data/
│   └── remedies.json    ← 931 SBL remedy profiles (pre-built from CSV)
├── public/
│   └── index.html       ← Frontend (no API key, calls /api/chat)
├── vercel.json          ← Vercel routing config
├── package.json
└── README.md
```

## Deploy to Vercel (free, ~3 minutes)

### Step 1 — Push to GitHub
1. Create a new repo at github.com (name it `homeohelp`)
2. Upload all files from this folder into the repo
   - Keep the folder structure exactly as shown above

### Step 2 — Connect to Vercel
1. Go to vercel.com → Sign up free with GitHub
2. Click "Add New Project" → Import your `homeohelp` GitHub repo
3. Vercel auto-detects the config — just click **Deploy**

### Step 3 — Add your Groq API key (the only secret)
1. In Vercel dashboard → Your project → **Settings** → **Environment Variables**
2. Add:
   - Name: `GROQ_API_KEY`
   - Value: `gsk_xxxxxxxxxxxxxxxxxxxx` (your key from console.groq.com)
   - Environment: Production, Preview, Development ✓ all three
3. Click Save → then go to **Deployments** → click the 3 dots → **Redeploy**

That's it. Your app is live at `https://homeohelp.vercel.app` (or your custom domain).

---

## How it works

```
User types symptom
    ↓
Browser → POST /api/chat (no API key in browser)
    ↓
Vercel serverless function (api/chat.js)
    ├─ Phase 1: Sends conversation to Groq for symptom questioning
    │   └─ If LLM signals READY_FOR_REMEDIES → Phase 2
    └─ Phase 2: Searches remedies.json by keywords
               Sends matched profiles to Groq for ranking
                   ↓
Browser ← Scored remedy list
```

## Get your free Groq API key
1. Go to console.groq.com
2. Sign up (free, no credit card)
3. Keys → Create API Key → copy it
4. Free tier: 14,400 requests/day, 30/min — plenty for a personal app

## Local development (optional)
```bash
npm i -g vercel
vercel dev
# Add GROQ_API_KEY to .env.local
```


## Account system

The project now includes a Supabase Auth account layer. See `ACCOUNT_SETUP.md` for setup and environment variables. The existing chat API is intentionally left unchanged in this first account-system stage.

# AI CSV Intake Assistant

## Files
- public/index.html - website UI
- api/chat.js - secure Vercel serverless AI route
- data/sbl_indications.csv - put your CSV here

## Expected CSV columns
The code works best with:
product_name, indications, url

## Vercel environment variables
GROQ_API_KEY=your_key
Optional:
GROQ_MODEL=openai/gpt-oss-20b

## Deploy
1. Put your CSV in data/sbl_indications.csv
2. Import the folder into GitHub.
3. Import the repository into Vercel.
4. Add GROQ_API_KEY under Project Settings > Environment Variables.
5. Redeploy.

## Important
This implementation is an educational database-narrowing assistant. It should not diagnose or prescribe.

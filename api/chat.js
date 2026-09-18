// api/chat.js — HomeoHelp backend
// Runs on Vercel serverless. GROQ_API_KEY is a server env variable — never sent to browser.

const path = require("path");
const fs   = require("fs");


async function getAuthenticatedUser(req) {
  const authHeader = req.headers?.authorization || req.headers?.Authorization || "";
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  if (!match) return null;

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseAnonKey = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_PUBLISHABLE_KEY;
  if (!supabaseUrl || !supabaseAnonKey) return null;

  const response = await fetch(`${supabaseUrl.replace(/\/$/, "")}/auth/v1/user`, {
    method: "GET",
    headers: {
      "apikey": supabaseAnonKey,
      "Authorization": `Bearer ${match[1]}`
    }
  });

  if (!response.ok) return null;
  return response.json();
}


const AUTHORIZED_EMAILS = [
  "karanramnani201@gmail.com",
  "kashish_ramnani@yahoo.com",
  "davidwaller743@gmail.com"
];


const CHAT_MODELS = new Set([
  // Groq via OpenAI-compat (verified working)
  "openai/gpt-oss-20b",
  // Llama 4 on Groq
  "meta-llama/llama-4-maverick-17b-128e-instruct",
  "meta-llama/llama-4-scout-17b-16e-instruct",
  // Other Groq models
  "moonshotai/kimi-k2-instruct",
  "qwen-qwq-32b",
  "llama-3.3-70b-versatile",
]);


// ─── Load remedy database once (cold-start cache) ───────────────────────────
let REMEDIES = null;

function getRemedies() {
  if (REMEDIES) return REMEDIES;

  const file = path.join(process.cwd(), "data", "remedies.json");
  REMEDIES = JSON.parse(fs.readFileSync(file, "utf8"));

  return REMEDIES;
}


// ─── Keyword search ──────────────────────────────────────────────────────────
function searchRemedies(keywords, topN = 20) {
  const remedies = getRemedies();

  const kws = keywords
    .toLowerCase()
    .split(/[\s,;]+/)
    .filter(k => k.length > 2);

  if (kws.length === 0) return [];

  const scored = remedies.map(r => {
    const text = r.indications.toLowerCase();
    let score = 0;

    for (const kw of kws) {
      let idx = 0;

      while ((idx = text.indexOf(kw, idx)) !== -1) {
        score++;
        idx += kw.length;
      }
    }

    return { ...r, score };
  });

  return scored
    .filter(r => r.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, topN);
}


// ─── Format matched remedies for the LLM prompt ──────────────────────────────
function formatRemediesForPrompt(remedies) {
  if (!remedies.length) {
    return "No remedies matched for these keywords.";
  }

  return remedies
    .map((r, i) =>
      `[${i + 1}] ${r.name} (${r.latin || "—"})\n${r.indications.trim().slice(0, 300)}`
    )
    .join("\n\n---\n\n");
}


function compactMessages(messages, maxMessages = 10) {
  return messages.slice(-maxMessages).map(message => ({
    role: message.role,
    content: String(message.content || "").slice(0, 900)
  }));
}


// ─── Detect if the LLM has signalled it's ready to rank remedies ─────────────
function parseReadySignal(text) {
  const m = text.match(/READY_FOR_REMEDIES:\s*(.+)/i);

  if (m) {
    return m[1].trim();
  }

  return null;
}


// ─── Call Groq ────────────────────────────────────────────────────────────────
async function callGroq(messages, model, maxTokens = 1200) {
  const apiKey = process.env.GROQ_API_KEY;

  if (!apiKey) {
    throw new Error("GROQ_API_KEY is not configured on the server.");
  }

  const isGptOss = model.startsWith("openai/gpt-oss-");

  const requestBody = isGptOss
    ? {
        model,
        messages,
        max_completion_tokens: maxTokens,
        reasoning_effort: "medium",
        include_reasoning: false
      }
    : {
        model,
        temperature: 0.55,
        max_tokens: maxTokens,
        messages
      };

  const res = await fetch(
    "https://api.groq.com/openai/v1/chat/completions",
    {
      method: "POST",

      headers: {
        "Authorization": "Bearer " + apiKey,
        "Content-Type": "application/json"
      },

      body: JSON.stringify(requestBody)
    }
  );

  const data = await res.json().catch(() => ({}));

  if (!res.ok) {
    const msg =
      data?.error?.message ||
      data?.error?.code ||
      `Groq error ${res.status} — model: ${model}`;

    throw new Error(msg);
  }

  return data?.choices?.[0]?.message?.content?.trim() || "";
}


// ─── System prompts ───────────────────────────────────────────────────────────
const SYSTEM_BASE = `You are an intelligent, context-aware Homeopathy Information Assistant designed for educational use. Your job is to understand the user's symptoms, organize the symptom picture, ask relevant follow-up questions, and compare traditional homeopathic remedy profiles. Always remember and use information already given in the conversation; never repeat questions, restart the questionnaire, assume symptoms, or introduce unrelated symptoms.

IMPORTANT — HOW TO ASK QUESTIONS: Always format your follow-up questions as a numbered list. Never ask more than 3 questions at a time. Only ask questions that meaningfully clarify the complaint or distinguish remedy profiles. Example format:
1. Where exactly is the pain located?
2. Does anything make it better or worse?
3. When did it start?

Focus on the main complaint, exact location, onset, duration, sensation, severity, causes, better/worse factors, associated symptoms, and relevant general symptoms when appropriate. Do not use a generic questionnaire or ask about things such as thirst, appetite, sleep, temperature, cravings, or spasms unless they are directly relevant to the current complaint. Do not jump to a remedy based on one symptom. Once enough information is available, summarize the symptom pattern and compare the most relevant traditional homeopathic remedies. Provide up to 10–15 genuinely relevant remedies when possible, without adding unrelated remedies just to reach the number. Rank them by how closely their traditional profiles match the user's described symptoms and give each an overall symptom-match score out of 10. You may also give specific scores for individual symptoms, such as "Back pain: 9/10" or "Stiffness: 8/10," when useful. For every remedy, briefly explain the matching symptoms and any important symptoms that are missing or unclear. After the comparison, identify the one or two key symptoms that would best distinguish the leading remedy profiles and ask a follow-up question only if necessary. Scores represent traditional symptom-profile similarity, not guaranteed medical effectiveness. Be natural, concise, logical, conversational, and context-aware. Avoid repetitive disclaimers, robotic responses, random remedy lists, and false certainty. Your priority is to build an accurate symptom picture first, then provide a clear, detailed, and logically explained comparison of traditional remedy profiles.`;


const SYSTEM_PHASE1 = `${SYSTEM_BASE}

At this stage, focus only on understanding the symptom picture. Do not list remedies yet. When enough information is available to meaningfully rank remedies, output EXACTLY this format on its own line and nothing before or after:

READY_FOR_REMEDIES: <comma-separated keywords from the symptoms>

This signals the system to search the remedy database.`;


const SYSTEM_PHASE2 = `${SYSTEM_BASE}

The system has searched the SBL remedy database and provided relevant remedy profiles below. Use only those profiles and do not invent remedies. Briefly summarize the key symptom picture, then list up to 10–15 genuinely relevant remedies ranked by traditional symptom match, following the scoring and explanation format described above. Fewer strong matches are better than random or weak additions.`;


// ─── Main handler ─────────────────────────────────────────────────────────────
module.exports = async function handler(req, res) {

  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader(
    "Access-Control-Allow-Methods",
    "POST, OPTIONS"
  );
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization"
  );

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({
      error: "Method not allowed"
    });
  }


  // ── Authenticate user ──
  let user;

  try {
    user = await getAuthenticatedUser(req);

  } catch (error) {
    console.error(
      "Supabase auth check failed:",
      error.message
    );

    return res.status(401).json({
      error: "Please sign in again."
    });
  }


  if (!user) {
    return res.status(401).json({
      error: "Please sign in to use HomeoHelp."
    });
  }


  // ── Authorized email access ──
  const userEmail =
    String(user.email || "")
      .trim()
      .toLowerCase();


  if (!AUTHORIZED_EMAILS.includes(userEmail)) {
    return res.status(402).json({
      error: "Subscription required.",
      code: "SUBSCRIPTION_REQUIRED"
    });
  }


  // ── Parse request ──
  let body;

  try {
    body =
      typeof req.body === "string"
        ? JSON.parse(req.body)
        : req.body;

  } catch {
    return res.status(400).json({
      error: "Invalid JSON body"
    });
  }


  const {
    messages = [],
    model = "meta-llama/llama-4-maverick-17b-128e-instruct"
  } = body;


  const selectedModel =
    CHAT_MODELS.has(model)
      ? model
      : "meta-llama/llama-4-maverick-17b-128e-instruct";


  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({
      error: "messages array is required"
    });
  }


  try {

    // ── PHASE 1: symptom gathering ──
    const phase1Messages = [
      {
        role: "system",
        content: SYSTEM_PHASE1
      },

      ...compactMessages(messages)
    ];


    const phase1Reply =
      await callGroq(
        phase1Messages,
        selectedModel,
        1500
      );


    // ── Check if LLM wants to move to remedy ranking ──
    const readyKeywords =
      parseReadySignal(phase1Reply);


    if (!readyKeywords) {

      return res.status(200).json({
        reply: phase1Reply,
        phase: "questioning"
      });
    }


    // ── PHASE 2: search remedy database ──
    const matched =
      searchRemedies(
        readyKeywords,
        6
      );


    const remedyBlock =
      formatRemediesForPrompt(matched);


    const phase2Messages = [

      {
        role: "system",
        content: SYSTEM_PHASE2
      },

      ...compactMessages(messages),

      {
        role: "user",
        content:
          `Based on our conversation, here are the relevant remedy profiles from the SBL database:

${remedyBlock}

Please now summarize the symptoms and rank the matching remedies as instructed.`
      }

    ];


    const phase2Reply =
      await callGroq(
        phase2Messages,
        selectedModel,
        3200
      );


    return res.status(200).json({

      reply: phase2Reply,

      phase: "remedies",

      matchedCount: matched.length,

      keywords: readyKeywords

    });


  } catch (err) {

    console.error(
      "HomeoHelp API error:",
      err.message
    );

    return res.status(500).json({
      error:
        err.message ||
        "Internal server error"
    });
  }
};
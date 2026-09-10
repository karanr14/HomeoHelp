import fs from "node:fs";


// ==========================================
// CONFIGURATION
// ==========================================

const MODEL =
  process.env.GROQ_MODEL ||
  "openai/gpt-oss-20b";


const CSV_PATH = new URL(
  "./sbl_indications.csv",
  import.meta.url
);


// ==========================================
// CSV PARSER
// Handles:
// - commas inside quotes
// - multiple lines inside quotes
// - double quotes
// ==========================================

function parseCSV(text) {

  const rows = [];

  let row = [];
  let field = "";
  let inQuotes = false;


  for (let i = 0; i < text.length; i++) {

    const char = text[i];
    const next = text[i + 1];


    if (char === '"') {

      if (inQuotes && next === '"') {

        field += '"';
        i++;

      } else {

        inQuotes = !inQuotes;

      }

    }


    else if (
      char === "," &&
      !inQuotes
    ) {

      row.push(field.trim());

      field = "";

    }


    else if (
      (char === "\n" || char === "\r") &&
      !inQuotes
    ) {

      if (
        char === "\r" &&
        next === "\n"
      ) {

        i++;

      }


      row.push(field.trim());

      field = "";


      if (
        row.some(
          value => value !== ""
        )
      ) {

        rows.push(row);

      }


      row = [];

    }


    else {

      field += char;

    }

  }


  row.push(field.trim());


  if (
    row.some(
      value => value !== ""
    )
  ) {

    rows.push(row);

  }


  const headers = rows.shift();


  return rows.map(row => {

    const obj = {};


    headers.forEach(
      (header, index) => {

        obj[header.trim()] =
          row[index] || "";

      }
    );


    return obj;

  });

}


// ==========================================
// NORMALIZE TEXT
// ==========================================

function normalize(text) {

  return (text || "")

    .toLowerCase()

    .replace(/[^a-z0-9\s]/g, " ")

    .replace(/\s+/g, " ")

    .trim();

}


// ==========================================
// STOP WORDS
//
// These words should NOT influence
// medicine searching
// ==========================================

const STOP_WORDS = new Set([

  "i",
  "me",
  "my",
  "have",
  "has",
  "had",
  "the",
  "a",
  "an",
  "and",
  "or",
  "but",
  "with",
  "for",
  "from",
  "this",
  "that",
  "there",
  "here",
  "very",
  "really",
  "please",
  "help",
  "need",
  "want",
  "feel",
  "feeling",
  "been",
  "just",
  "also",
  "some",
  "what",
  "when",
  "where",
  "which"

]);


// ==========================================
// GET IMPORTANT WORDS
// ==========================================

function getKeywords(text) {

  return normalize(text)

    .split(" ")

    .filter(word =>

      word.length >= 3 &&

      !STOP_WORDS.has(word)

    );

}


// ==========================================
// SYMPTOM GROUPS
//
// These help connect similar terms.
//
// Example:
//
// toothache
// tooth pain
// dental pain
// teeth
//
// ==========================================

const SYMPTOM_GROUPS = [

  {

    name: "tooth_dental",

    terms: [

      "toothache",
      "tooth ache",
      "tooth pain",
      "dental pain",
      "tooth",
      "teeth",
      "gum pain",
      "gums",
      "dental"

    ]

  },


  {

    name: "headache",

    terms: [

      "headache",
      "head pain",
      "pain in head",
      "migraine",
      "head ache"

    ]

  },


  {

    name: "ear",

    terms: [

      "earache",
      "ear pain",
      "ears",
      "ear"

    ]

  },


  {

    name: "stomach",

    terms: [

      "stomach pain",
      "stomach ache",
      "abdominal pain",
      "abdomen pain",
      "belly pain",
      "gastric"

    ]

  },


  {

    name: "cold",

    terms: [

      "common cold",
      "cold",
      "runny nose",
      "blocked nose",
      "sneezing",
      "nasal"

    ]

  },


  {

    name: "cough",

    terms: [

      "cough",
      "dry cough",
      "wet cough",
      "productive cough"

    ]

  },


  {

    name: "fever",

    terms: [

      "fever",
      "high temperature",
      "temperature",
      "febrile"

    ]

  },


  {

    name: "throat",

    terms: [

      "sore throat",
      "throat pain",
      "throat",
      "tonsils",
      "tonsillitis"

    ]

  },


  {

    name: "joint",

    terms: [

      "joint pain",
      "joint",
      "arthritis",
      "knee pain",
      "muscle pain"

    ]

  },


  {

    name: "skin",

    terms: [

      "skin",
      "rash",
      "itching",
      "itchy",
      "eruption",
      "acne"

    ]

  }

];


// ==========================================
// FIND SYMPTOM GROUPS
// ==========================================

function detectSymptomGroups(text) {

  const normalized = normalize(text);

  const found = [];


  for (const group of SYMPTOM_GROUPS) {

    for (const term of group.terms) {

      if (
        normalized.includes(
          normalize(term)
        )
      ) {

        found.push(group);

        break;

      }

    }

  }


  return found;

}


// ==========================================
// SCORE ONE MEDICINE
// ==========================================

function scoreMedicine(
  medicine,
  rootQuery,
  answers
) {

  const text = normalize(

    medicine.product_name +

    " " +

    medicine.indications

  );


  const root = normalize(
    rootQuery
  );


  let score = 0;


  // ========================================
  // 1. DETECT MAIN SYMPTOM GROUP
  // ========================================

  const groups =

    detectSymptomGroups(root);


  for (const group of groups) {

    for (const term of group.terms) {

      const normalizedTerm =

        normalize(term);


      if (
        text.includes(
          normalizedTerm
        )
      ) {

        // STRONG SCORE

        score += 20;

      }

    }

  }


  // ========================================
  // 2. EXACT ROOT QUERY
  // ========================================

  if (
    root.length >= 4 &&
    text.includes(root)
  ) {

    score += 50;

  }


  // ========================================
  // 3. IMPORTANT KEYWORDS
  // ========================================

  const keywords =

    getKeywords(rootQuery);


  for (const keyword of keywords) {

    if (
      text.includes(keyword)
    ) {

      score += 5;

    }

  }


  // ========================================
  // 4. PREVIOUS ANSWERS
  //
  // Lower score because answers should
  // refine, not completely replace
  // the main symptom
  // ========================================

  for (const answer of answers) {

    const answerKeywords =

      getKeywords(answer);


    for (
      const keyword of answerKeywords
    ) {

      if (
        text.includes(keyword)
      ) {

        score += 2;

      }

    }

  }


  return score;

}


// ==========================================
// SMART RANKING
// ==========================================

function rankMedicines(
  rows,
  rootQuery,
  answers
) {

  const groups =

    detectSymptomGroups(
      rootQuery
    );


  const scored = rows

    .map(medicine => {

      return {

        ...medicine,

        _score:

          scoreMedicine(

            medicine,

            rootQuery,

            answers

          )

      };

    })


    .filter(

      medicine =>
        medicine._score > 0

    );


  // ========================================
  // IMPORTANT DOMAIN FILTER
  //
  // If user says TOOTHACHE,
  // strongly prefer records that
  // actually contain dental terms.
  // ========================================

  if (
    groups.length > 0
  ) {

    const domainMatches =

      scored.filter(medicine => {

        const text = normalize(

          medicine.indications

        );


        return groups.some(group =>

          group.terms.some(term =>

            text.includes(
              normalize(term)
            )

          )

        );

      });


    // USE DOMAIN MATCHES
    // ONLY IF WE FOUND SOME

    if (
      domainMatches.length > 0
    ) {

      return domainMatches

        .sort(

          (a, b) =>
            b._score -
            a._score

        )

        .slice(0, 12);

    }

  }


  return scored

    .sort(

      (a, b) =>
        b._score -
        a._score

    )

    .slice(0, 12);

}


// ==========================================
// CREATE SMALL CANDIDATE DATA
//
// We do NOT send the whole CSV
// to the AI.
// ==========================================

function makeCandidates(
  candidates
) {

  return candidates

    .slice(0, 6)

    .map(item => ({

      medicine:

        item.product_name,


      indications:

        (item.indications || "")

          .replace(/\s+/g, " ")

          .slice(0, 500)

    }));

}


// ==========================================
// ASK AI
// ==========================================

async function askAI(
  rootQuery,
  message,
  answers,
  candidates
) {


  const compactCandidates =

    makeCandidates(
      candidates
    );


  const prompt = `You are an intelligent DATABASE NARROWING assistant.

IMPORTANT:

You are NOT a doctor.

Do NOT diagnose.

Do NOT prescribe.

Do NOT recommend which medicine to take.

Your ONLY task is to help narrow records in a medicine indication database.

MAIN USER SYMPTOM:

${rootQuery}

LATEST USER ANSWER:

${message}

ALL PREVIOUS ANSWERS:

${answers.slice(-5).join(" | ")}

CANDIDATE DATABASE RECORDS:

${JSON.stringify(compactCandidates)}

YOUR JOB:

First understand the MAIN USER SYMPTOM.

The main symptom is always the most important context.

Ask ONE useful follow-up question that separates the candidate records.

The question MUST:

1. Be related to the MAIN USER SYMPTOM.

2. Be based on real differences between the candidate indications.

3. Help eliminate multiple candidates.

4. NOT ask about an unrelated body area.

5. NOT ask whether a medicine treats something.

BAD EXAMPLE:

"Does the medicine treat spasms?"

BAD EXAMPLE:

For toothache:
"Do you have pain around your temples?"

GOOD EXAMPLE:

For toothache:
Ask about a characteristic that actually separates the tooth-related candidate records.

The USER should describe symptoms.

Never ask the user about medicines.

Return ONLY valid JSON.

Use exactly this format:

{
  "action": "question",
  "question": "your question",
  "options": [
    "Option 1",
    "Option 2",
    "Not sure"
  ]
}

OR:

{
  "action": "results",
  "question": "",
  "options": []
}`;


  const response = await fetch(

    "https://api.groq.com/openai/v1/chat/completions",

    {

      method: "POST",


      headers: {

        "Content-Type":

          "application/json",


        "Authorization":

          "Bearer " +

          process.env.GROQ_API_KEY

      },


      body: JSON.stringify({

        model: MODEL,


        reasoning_effort:

          "low",


        include_reasoning:

          false,


        temperature:

          0.3,


        max_completion_tokens:

          500,


        messages: [

          {

            role:

              "system",


            content:

              "Return valid JSON only. Do not return explanations."

          },


          {

            role:

              "user",


            content:

              prompt

          }

        ]

      })

    }

  );


  // ========================================
  // CHECK ERROR
  // ========================================

  if (!response.ok) {

    const errorText =

      await response.text();


    throw new Error(

      "AI provider error: " +

      errorText

    );

  }


  // ========================================
  // GET RESPONSE
  // ========================================

  const data =

    await response.json();


  let content =

    data
      ?.choices?.[0]
      ?.message
      ?.content;


  // ========================================
  // FALLBACK IF EMPTY
  // ========================================

  if (!content) {

    console.log(

      "FULL AI RESPONSE:",

      JSON.stringify(data)

    );


    throw new Error(

      "AI returned an empty response"

    );

  }


  // ========================================
  // CLEAN MARKDOWN
  // ========================================

  content = content

    .replace(/```json/gi, "")

    .replace(/```/g, "")

    .trim();


  // ========================================
  // EXTRACT JSON
  // ========================================

  const start =

    content.indexOf("{");


  const end =

    content.lastIndexOf("}");


  if (
    start === -1 ||
    end === -1
  ) {

    throw new Error(

      "AI returned invalid JSON"

    );

  }


  const jsonText =

    content.slice(

      start,

      end + 1

    );


  return JSON.parse(
    jsonText
  );

}


// ==========================================
// MAIN API HANDLER
// ==========================================

export default async function handler(
  req,
  res
) {


  if (
    req.method !== "POST"
  ) {

    return res.status(405).json({

      error:

        "POST only"

    });

  }


  try {


    // ======================================
    // CHECK API KEY
    // ======================================

    if (
      !process.env.GROQ_API_KEY
    ) {

      throw new Error(

        "Missing GROQ_API_KEY environment variable"

      );

    }


    // ======================================
    // GET USER DATA
    // ======================================

    const {

      message,


      state = {

        answers: [],

        turn: 0

      }

    } = req.body || {};


    if (!message) {

      throw new Error(

        "Missing message"

      );

    }


    // ======================================
    // READ CSV
    // ======================================

    const csvText =

      fs.readFileSync(

        CSV_PATH,

        "utf8"

      );


    const rows =

      parseCSV(
        csvText
      );


    // ======================================
    // MAIN SYMPTOM
    // ======================================

    const rootQuery =

      state.rootQuery ||

      message;


    // ======================================
    // SAVE ANSWERS
    // ======================================

    const answers = [

      ...(state.answers || []),

      message

    ];


    // ======================================
    // SMART SEARCH
    // ======================================

    const candidates =

      rankMedicines(

        rows,

        rootQuery,

        answers

      );


    // ======================================
    // NO RESULTS
    // ======================================

    if (
      candidates.length === 0
    ) {

      return res.status(200).json({

        type:

          "results",


        results: [],


        state: {

          rootQuery,

          answers,

          turn:

            state.turn + 1

        }

      });

    }


    // ======================================
    // ASK AI
    // ======================================

    const ai =

      await askAI(

        rootQuery,

        message,

        answers,

        candidates

      );


    // ======================================
    // NEW STATE
    // ======================================

    const newState = {

      rootQuery,

      answers,

      turn:

        state.turn + 1

    };


    // ======================================
    // RESULTS
    // ======================================

    if (
      ai.action === "results"
    ) {

      return res.status(200).json({

        type:

          "results",


        results:

          candidates.slice(0, 5),


        state:

          newState

      });

    }


    // ======================================
    // QUESTION
    // ======================================

    return res.status(200).json({

      type:

        "question",


      question:

        ai.question ||

        "Could you describe the symptom in a little more detail?",


      options:

        Array.isArray(
          ai.options
        )

          ? ai.options

          : [

              "Yes",

              "No",

              "Not sure"

            ],


      state:

        newState

    });


  }


  // ========================================
  // ERROR
  // ========================================

  catch (error) {


    console.error(

      "SERVER ERROR:",

      error

    );


    return res.status(500).json({

      error:

        error.message ||

        "Server error"

    });

  }

}
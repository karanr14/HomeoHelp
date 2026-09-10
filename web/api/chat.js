import fs from "node:fs";

const MODEL = process.env.GROQ_MODEL || "openai/gpt-oss-20b";

const CSV_PATH = new URL("./sbl_indications.csv", import.meta.url);


// ===============================
// READ CSV
// ===============================

function parseCSV(text) {
  const lines = text.trim().split(/\r?\n/);
  const headers = split(lines.shift());

  return lines.map((line) => {
    const cells = split(line);
    const obj = {};

    headers.forEach((header, index) => {
      obj[header.trim()] = cells[index] ?? "";
    });

    return obj;
  });
}


// ===============================
// SPLIT CSV LINE
// ===============================

function split(line) {
  let result = [];
  let current = "";
  let quoted = false;

  for (let i = 0; i < line.length; i++) {
    const character = line[i];

    if (character === '"') {
      quoted = !quoted;
    }

    else if (character === "," && !quoted) {
      result.push(
        current
          .replace(/^"|"$/g, "")
          .replace(/""/g, '"')
      );

      current = "";
    }

    else {
      current += character;
    }
  }

  result.push(
    current
      .replace(/^"|"$/g, "")
      .replace(/""/g, '"')
  );

  return result;
}


// ===============================
// GET WORDS FROM TEXT
// ===============================

function words(text) {

  return [
    ...new Set(
      (text || "")
        .toLowerCase()
        .match(/[a-z]{3,}/g) || []
    )
  ];

}


// ===============================
// RANK CSV RECORDS
// ===============================

function rank(rows, query, answers = []) {

  const terms = words(
    query + " " + answers.join(" ")
  );

  return rows
    .map((row) => {

      const text = Object.values(row)
        .join(" ")
        .toLowerCase();

      let score = 0;

      terms.forEach((term) => {

        if (text.includes(term)) {
          score += 1;
        }

      });

      return {
        ...row,
        _score: score
      };

    })

    .filter((item) => item._score > 0)

    .sort(
      (a, b) => b._score - a._score
    )

    .slice(0, 12);

}


// ===============================
// CLEAN AI JSON
// ===============================

function cleanJSON(text) {

  return text
    .replace(/```json/g, "")
    .replace(/```/g, "")
    .trim();

}


// ===============================
// ASK AI FOR NEXT QUESTION
// ===============================

async function askAI(
  message,
  state,
  candidates
) {

  const prompt = `You are an educational dataset narrowing assistant.

You are NOT a doctor.

Do NOT:
- diagnose
- prescribe
- recommend treatment
- claim a dataset entry is medically suitable

Your only task is to help narrow DATABASE ENTRIES using the user's words and the supplied candidate records.

USER MESSAGE:

${message}


PREVIOUS ANSWERS:

${(state.answers || []).join(" | ") || "none"}


CANDIDATE RECORDS:

${JSON.stringify(
  candidates.map((item) => ({
    product_name: item.product_name,
    indications: item.indications
  }))
)}


TASK:

Ask exactly ONE short and neutral follow-up question.

The question should help separate the remaining candidate records.

Only ask about characteristics that are represented in the candidate records.

Do not ask for information already given.

Prefer a question that can eliminate several candidates.

Return ONLY valid JSON.

If you need another question, return:

{
  "action": "question",
  "question": "your question here",
  "options": [
    "Option 1",
    "Option 2",
    "Not sure"
  ]
}

If the candidates are sufficiently narrowed, return:

{
  "action": "results"
}

Do not return markdown.

Do not return explanations.

Do not return anything except JSON.`;



  const res = await fetch(

    "https://api.groq.com/openai/v1/chat/completions",

    {

      method: "POST",


      headers: {

        "Content-Type": "application/json",

        "Authorization":
          "Bearer " + process.env.GROQ_API_KEY

      },


      body: JSON.stringify({

        model: MODEL,


        temperature: 0.2,


        max_completion_tokens: 500,


        reasoning_effort: "low",


        reasoning_format: "hidden",


        response_format: {
          type: "json_object"
        },


        messages: [

          {

            role: "user",

            content: prompt

          }

        ]

      })

    }

  );


  // CHECK IF GROQ RETURNED AN ERROR

  if (!res.ok) {

    throw new Error(
      "AI provider error: " + await res.text()
    );

  }


  // GET AI RESPONSE

  const data = await res.json();


  // CONVERT AI RESPONSE TO JSON

  return JSON.parse(

    cleanJSON(
      data.choices[0].message.content
    )

  );

}


// ===============================
// MAIN API
// ===============================

export default async function handler(
  req,
  res
) {


  // ONLY ALLOW POST

  if (req.method !== "POST") {

    return res.status(405).json({
      error: "POST only"
    });

  }


  try {


    // CHECK API KEY

    if (!process.env.GROQ_API_KEY) {

      throw new Error(
        "Missing GROQ_API_KEY environment variable"
      );

    }


    // GET USER DATA

    const {

      message,

      state = {
        history: [],
        answers: [],
        turn: 0
      }

    } = req.body || {};


    // CHECK MESSAGE

    if (!message) {

      throw new Error(
        "Missing message"
      );

    }


    // READ CSV

    const csvText = fs.readFileSync(
      CSV_PATH,
      "utf8"
    );


    const rows = parseCSV(
      csvText
    );


    // SAVE ANSWERS

    const answers = [

      ...(state.answers || []),

      message

    ];


    // FIRST USER MESSAGE

    const rootQuery =
      state.rootQuery || message;


    // FIND CANDIDATES

    const candidates = rank(

      rows,

      rootQuery,

      answers

    ).slice(0, 10);


    // NO RESULTS

    if (!candidates.length) {

      return res.status(200).json({

        type: "results",

        results: [],

        state: {

          rootQuery,

          answers,

          turn: state.turn + 1

        }

      });

    }


    // STOP AFTER 5 QUESTIONS
    // OR WHEN ONLY FEW RESULTS REMAIN

    if (

      state.turn >= 5 ||

      candidates.length <= 3

    ) {

      return res.status(200).json({

        type: "results",

        results:
          candidates.slice(0, 5),

        state: {

          rootQuery,

          answers,

          turn: state.turn + 1

        }

      });

    }


    // ASK AI

    const ai = await askAI(

      message,

      {
        ...state,
        answers
      },

      candidates

    );


    // NEW STATE

    const newState = {

      rootQuery,

      answers,

      turn: state.turn + 1

    };


    // AI WANTS RESULTS

    if (ai.action === "results") {

      return res.status(200).json({

        type: "results",

        results:
          candidates.slice(0, 5),

        state: newState

      });

    }


    // RETURN QUESTION

    return res.status(200).json({

      type: "question",

      question: ai.question,

      options:

        ai.options ||

        [
          "Yes",
          "No",
          "Not sure"
        ],

      state: newState

    });


  }


  // ERROR

  catch (error) {

    console.error(error);

    return res.status(500).json({

      error:
        error.message ||
        "Server error"

    });

  }

}
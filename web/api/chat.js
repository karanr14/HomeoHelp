import fs from "node:fs";

const MODEL = process.env.GROQ_MODEL || "openai/gpt-oss-20b";

// CSV FILE IS IN THE SAME FOLDER AS chat.js
const CSV_PATH = new URL("./sbl_indications.csv", import.meta.url);


// ==========================================
// PROPER CSV PARSER
// SUPPORTS:
// - Commas inside quotes
// - Multiple lines inside quotes
// - Double quotes inside text
// ==========================================

function parseCSV(text) {

  const rows = [];

  let row = [];
  let field = "";

  let inQuotes = false;


  for (let i = 0; i < text.length; i++) {

    const char = text[i];
    const nextChar = text[i + 1];


    // HANDLE QUOTES

    if (char === '"') {

      // DOUBLE QUOTE INSIDE QUOTED TEXT
      // Example: "He said ""hello"""

      if (inQuotes && nextChar === '"') {

        field += '"';
        i++;

      } else {

        inQuotes = !inQuotes;

      }

    }


    // COMMA = NEXT COLUMN
    else if (char === "," && !inQuotes) {

      row.push(field.trim());
      field = "";

    }


    // NEW LINE = NEXT ROW
    // ONLY WHEN NOT INSIDE QUOTES

    else if (
      (char === "\n" || char === "\r") &&
      !inQuotes
    ) {

      // HANDLE WINDOWS \r\n

      if (
        char === "\r" &&
        nextChar === "\n"
      ) {

        i++;

      }


      row.push(field.trim());

      field = "";


      // ADD ROW IF NOT EMPTY

      if (
        row.some(
          value => value !== ""
        )
      ) {

        rows.push(row);

      }


      row = [];

    }


    // NORMAL CHARACTER

    else {

      field += char;

    }

  }


  // ADD LAST FIELD

  row.push(field.trim());


  // ADD LAST ROW

  if (
    row.some(
      value => value !== ""
    )
  ) {

    rows.push(row);

  }


  // GET HEADERS

  const headers = rows.shift();


  // CONVERT ROWS TO OBJECTS

  return rows.map((row) => {

    const obj = {};


    headers.forEach(
      (header, index) => {

        obj[header.trim()] =
          row[index] ?? "";

      }
    );


    return obj;

  });

}


// ==========================================
// GET SEARCH WORDS
// ==========================================

function words(text) {

  return [

    ...new Set(

      (text || "")

        .toLowerCase()

        .match(/[a-z]{3,}/g)

      || []

    )

  ];

}


// ==========================================
// RANK MEDICINE RECORDS
// ==========================================

function rank(
  rows,
  query,
  answers = []
) {

  const terms = words(

    query + " " + answers.join(" ")

  );


  return rows

    .map((row) => {


      // SEARCH MAINLY IN INDICATIONS

      const text = (

        (row.product_name || "") +

        " " +

        (row.indications || "")

      ).toLowerCase();


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


    // REMOVE ZERO SCORE RESULTS

    .filter(

      item => item._score > 0

    )


    // HIGHEST SCORE FIRST

    .sort(

      (a, b) =>

        b._score - a._score

    )


    // KEEP TOP 12

    .slice(0, 12);

}


// ==========================================
// CLEAN AI JSON
// ==========================================

function cleanJSON(text) {

  return text

    .replace(/```json/g, "")

    .replace(/```/g, "")

    .trim();

}


// ==========================================
// ASK GROQ AI
// ==========================================

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
- claim a medicine is medically suitable

Your only task is to narrow DATABASE ENTRIES.

The database contains medicine names and their associated indications.

USER MESSAGE:

${message}


PREVIOUS ANSWERS:

${(state.answers || []).join(" | ") || "none"}


CANDIDATE MEDICINES:

${JSON.stringify(

  candidates.map((item) => ({

    medicine_name: item.product_name,

    indications: item.indications

  }))

)}


TASK:

Ask exactly ONE short and neutral follow-up question.

The question should help separate the remaining medicine records.

Only ask about characteristics represented in the candidate records.

Do not ask for information already provided.

Prefer a question that can eliminate several candidates.

Return ONLY valid JSON.

If another question is needed:

{
  "action": "question",
  "question": "your question here",
  "options": [
    "Option 1",
    "Option 2",
    "Not sure"
  ]
}

If sufficiently narrowed:

{
  "action": "results"
}

Do not return markdown.

Do not return explanations.

Return JSON only.`;


  const res = await fetch(

    "https://api.groq.com/openai/v1/chat/completions",

    {

      method: "POST",


      headers: {

        "Content-Type": "application/json",

        "Authorization":

          "Bearer " +

          process.env.GROQ_API_KEY

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


  // CHECK GROQ ERROR

  if (!res.ok) {

    throw new Error(

      "AI provider error: " +

      await res.text()

    );

  }


  // GET AI RESPONSE

  const data = await res.json();


  // PARSE AI JSON

  return JSON.parse(

    cleanJSON(

      data.choices[0].message.content

    )

  );

}


// ==========================================
// MAIN API
// ==========================================

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


    // ======================================
    // READ CSV
    // ======================================

    const csvText = fs.readFileSync(

      CSV_PATH,

      "utf8"

    );


    const rows = parseCSV(

      csvText

    );


    // ======================================
    // SAVE USER ANSWERS
    // ======================================

    const answers = [

      ...(state.answers || []),

      message

    ];


    // ORIGINAL USER QUESTION

    const rootQuery =

      state.rootQuery || message;


    // ======================================
    // FIND MATCHING MEDICINES
    // ======================================

    const candidates = rank(

      rows,

      rootQuery,

      answers

    ).slice(0, 10);


    // ======================================
    // NO MATCHES
    // ======================================

    if (!candidates.length) {

      return res.status(200).json({

        type: "results",

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
    // STOP AFTER 5 QUESTIONS
    // ======================================

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

          turn:

            state.turn + 1

        }

      });

    }


    // ======================================
    // ASK AI NEXT QUESTION
    // ======================================

    const ai = await askAI(

      message,

      {

        ...state,

        answers

      },

      candidates

    );


    // ======================================
    // SAVE NEW STATE
    // ======================================

    const newState = {

      rootQuery,

      answers,

      turn:

        state.turn + 1

    };


    // ======================================
    // AI WANTS TO SHOW RESULTS
    // ======================================

    if (ai.action === "results") {

      return res.status(200).json({

        type: "results",

        results:

          candidates.slice(0, 5),

        state:

          newState

      });

    }


    // ======================================
    // RETURN AI QUESTION
    // ======================================

    return res.status(200).json({

      type: "question",

      question:

        ai.question,


      options:

        ai.options ||

        [

          "Yes",

          "No",

          "Not sure"

        ],


      state:

        newState

    });


  }


  // ========================================
  // HANDLE ERRORS
  // ========================================

  catch (error) {


    console.error(error);


    return res.status(500).json({

      error:

        error.message ||

        "Server error"

    });

  }

}
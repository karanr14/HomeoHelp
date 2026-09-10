import fs from "node:fs";


// ==========================================
// AI MODEL
// Lightweight and fast model
// ==========================================

const MODEL =
  process.env.GROQ_MODEL ||
  "openai/gpt-oss-20b";


// ==========================================
// CSV FILE
// ==========================================

const CSV_PATH = new URL(
  "./sbl_indications.csv",
  import.meta.url
);


// ==========================================
// CSV PARSER
// Supports:
// - commas
// - quoted text
// - multi-line indications
// ==========================================

function parseCSV(text) {

  const rows = [];

  let row = [];
  let field = "";
  let inQuotes = false;


  for (let i = 0; i < text.length; i++) {

    const char = text[i];
    const nextChar = text[i + 1];


    if (char === '"') {

      if (inQuotes && nextChar === '"') {

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
        nextChar === "\n"
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


  // ADD FINAL FIELD

  row.push(field.trim());


  // ADD FINAL ROW

  if (
    row.some(
      value => value !== ""
    )
  ) {
    rows.push(row);
  }


  // HEADERS

  const headers = rows.shift();


  // CREATE OBJECTS

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
// EXTRACT SEARCH WORDS
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
// RANK MEDICINES
// ==========================================

function rank(
  rows,
  query,
  answers = []
) {

  const terms = words(

    query + " " +
    answers.join(" ")

  );


  return rows

    .map((row) => {

      const text = (

        row.product_name +

        " " +

        row.indications

      ).toLowerCase();


      let score = 0;


      terms.forEach((term) => {

        if (
          text.includes(term)
        ) {

          score++;

        }

      });


      return {

        ...row,

        _score: score

      };

    })


    .filter(

      item =>
        item._score > 0

    )


    .sort(

      (a, b) =>
        b._score - a._score

    )


    .slice(0, 10);

}


// ==========================================
// CLEAN AI RESPONSE
// ==========================================

function cleanJSON(text) {

  return text

    .replace(/```json/g, "")

    .replace(/```/g, "")

    .trim();

}


// ==========================================
// ASK AI
// TOKEN-OPTIMIZED VERSION
// ==========================================

async function askAI(
  message,
  state,
  candidates
) {


  // ONLY SEND 6 CANDIDATES
  // AND LIMIT INDICATION TEXT

  const compactCandidates =

    candidates

      .slice(0, 6)

      .map((item) => ({

        name:
          item.product_name,

        indications:

          (item.indications || "")

            .replace(/\s+/g, " ")

            .slice(0, 350)

      }));


  const prompt = `You narrow database records.

You are NOT a doctor.
Do not diagnose or recommend treatment.

User:
${message}

Previous answers:
${(state.answers || []).slice(-4).join(" | ") || "None"}

Candidates:
${JSON.stringify(compactCandidates)}

Ask ONE short question that best separates these candidates.

Return JSON only:

{
  "action":"question",
  "question":"...",
  "options":["...","...","Not sure"]
}

Or:

{
  "action":"results"
}`;


  const res = await fetch(

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


        temperature: 0.3,


        // VERY LOW OUTPUT
        // We only need one question

        max_tokens: 180,


        response_format: {

          type:
            "json_object"

        },


        messages: [

          {

            role: "system",

            content:
              "Return valid JSON only."

          },


          {

            role: "user",

            content:
              prompt

          }

        ]

      })

    }

  );


  // CHECK ERROR

  if (!res.ok) {

    const errorText =
      await res.text();


    throw new Error(

      "AI provider error: " +
      errorText

    );

  }


  const data =
    await res.json();


  return JSON.parse(

    cleanJSON(

      data.choices[0]
        .message
        .content

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


  if (
    req.method !== "POST"
  ) {

    return res.status(405).json({

      error:
        "POST only"

    });

  }


  try {


    // CHECK API KEY

    if (
      !process.env.GROQ_API_KEY
    ) {

      throw new Error(

        "Missing GROQ_API_KEY environment variable"

      );

    }


    // GET REQUEST DATA

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


    // READ CSV

    const csvText =
      fs.readFileSync(

        CSV_PATH,

        "utf8"

      );


    const rows =
      parseCSV(csvText);


    // SAVE ANSWER

    const answers = [

      ...(state.answers || []),

      message

    ];


    // ORIGINAL QUESTION

    const rootQuery =

      state.rootQuery ||

      message;


    // FIND MATCHES

    const candidates = rank(

      rows,

      rootQuery,

      answers

    );


    // NO RESULTS

    if (
      !candidates.length
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


    // STOP AFTER 5 QUESTIONS
    // OR 3 CANDIDATES

    if (

      state.turn >= 5 ||

      candidates.length <= 3

    ) {

      return res.status(200).json({

        type:
          "results",

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


    // ASK AI

    const ai =

      await askAI(

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

      turn:
        state.turn + 1

    };


    // SHOW RESULTS

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


    // SHOW QUESTION

    return res.status(200).json({

      type:
        "question",

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


  catch (error) {


    console.error(error);


    return res.status(500).json({

      error:

        error.message ||

        "Server error"

    });

  }

}
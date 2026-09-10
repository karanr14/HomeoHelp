import fs from "node:fs";


// ==========================================
// AI MODEL
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
// Supports commas and multi-line fields
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


    else if (char === "," && !inQuotes) {

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
        row.some(value => value !== "")
      ) {
        rows.push(row);
      }


      row = [];

    }


    else {

      field += char;

    }

  }


  // Add final field

  row.push(field.trim());


  // Add final row

  if (
    row.some(value => value !== "")
  ) {
    rows.push(row);
  }


  // Get headers

  const headers = rows.shift();


  // Convert rows into objects

  return rows.map((row) => {

    const obj = {};

    headers.forEach((header, index) => {

      obj[header.trim()] =
        row[index] ?? "";

    });

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

      const searchableText = (

        (row.product_name || "") +

        " " +

        (row.indications || "")

      ).toLowerCase();


      let score = 0;


      terms.forEach((term) => {

        if (
          searchableText.includes(term)
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
      item => item._score > 0
    )


    .sort(
      (a, b) =>
        b._score - a._score
    )


    .slice(0, 10);

}


// ==========================================
// EXTRACT JSON FROM AI RESPONSE
// ==========================================

function extractJSON(text) {

  // Remove markdown if AI uses it

  text = text
    .replace(/```json/gi, "")
    .replace(/```/g, "")
    .trim();


  // Find JSON object

  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");


  if (
    start === -1 ||
    end === -1
  ) {

    throw new Error(
      "AI did not return a valid response"
    );

  }


  const jsonText = text.slice(
    start,
    end + 1
  );


  return JSON.parse(jsonText);

}


// ==========================================
// ASK AI
// NO STRICT JSON MODE
// ==========================================

async function askAI(
  message,
  state,
  candidates
) {


  // Send only 5 candidates
  // Keep token usage low

  const compactCandidates =

    candidates

      .slice(0, 5)

      .map((item) => ({

        medicine:
          item.product_name,

        indications:

          (item.indications || "")

            .replace(/\s+/g, " ")

            .slice(0, 250)

      }));


  const prompt = `
You are a database narrowing assistant.

You are NOT a doctor.
Do not diagnose.
Do not prescribe.
Do not recommend treatment.

Your task is ONLY to narrow database records.

USER MESSAGE:
${message}

PREVIOUS ANSWERS:
${(state.answers || [])
  .slice(-4)
  .join(" | ") || "None"}

CANDIDATES:
${JSON.stringify(compactCandidates)}

Ask exactly ONE short question that helps separate the candidates.

Only ask about characteristics found in the candidate indications.

Do not ask for information already given.

Your entire response MUST be exactly one JSON object.

If you need another question:

{
  "action": "question",
  "question": "short question",
  "options": [
    "Option 1",
    "Option 2",
    "Not sure"
  ]
}

If no more question is needed:

{
  "action": "results"
}
`;


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


        temperature: 0.2,


        max_completion_tokens: 300,


        messages: [

          {

            role: "system",

            content:
              "Return only a JSON object. No explanation."

          },


          {

            role: "user",

            content: prompt

          }

        ]

      })

    }

  );


  // Check AI provider error

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


  const aiText =
    data.choices?.[0]
      ?.message
      ?.content;


  if (!aiText) {

    throw new Error(
      "AI returned an empty response"
    );

  }


  return extractJSON(aiText);

}


// ==========================================
// MAIN API
// ==========================================

export default async function handler(
  req,
  res
) {


  // Only allow POST

  if (
    req.method !== "POST"
  ) {

    return res.status(405).json({

      error: "POST only"

    });

  }


  try {


    // Check API key

    if (
      !process.env.GROQ_API_KEY
    ) {

      throw new Error(

        "Missing GROQ_API_KEY environment variable"

      );

    }


    // Get user data

    const {

      message,

      state = {

        answers: [],

        turn: 0

      }

    } = req.body || {};


    // Check message

    if (!message) {

      throw new Error(
        "Missing message"
      );

    }


    // Read CSV

    const csvText =
      fs.readFileSync(

        CSV_PATH,

        "utf8"

      );


    const rows =
      parseCSV(csvText);


    // Save answers

    const answers = [

      ...(state.answers || []),

      message

    ];


    // Original user message

    const rootQuery =

      state.rootQuery ||

      message;


    // Find candidates

    const candidates = rank(

      rows,

      rootQuery,

      answers

    );


    // No matches

    if (
      candidates.length === 0
    ) {

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


    // Stop after 5 questions
    // or when only 3 candidates remain

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


    // Ask AI

    const ai =
      await askAI(

        message,

        {

          ...state,

          answers

        },

        candidates

      );


    // Save state

    const newState = {

      rootQuery,

      answers,

      turn:
        state.turn + 1

    };


    // AI wants results

    if (
      ai.action === "results"
    ) {

      return res.status(200).json({

        type: "results",

        results:

          candidates.slice(0, 5),

        state:
          newState

      });

    }


    // Return AI question

    return res.status(200).json({

      type: "question",

      question:

        ai.question ||
        "Could you provide a little more detail?",


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


  // Handle errors

  catch (error) {


    console.error(error);


    return res.status(500).json({

      error:

        error.message ||

        "Server error"

    });

  }

}
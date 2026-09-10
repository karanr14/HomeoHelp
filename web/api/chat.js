import fs from "node:fs";


// ==========================================
// AI MODEL
// ==========================================

const MODEL =
  process.env.GROQ_MODEL ||
  "openai/gpt-oss-20b";


// ==========================================
// CSV LOCATION
// ==========================================

const CSV_PATH = new URL(
  "./sbl_indications.csv",
  import.meta.url
);


// ==========================================
// CSV PARSER
// Supports:
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
    const nextChar = text[i + 1];


    // QUOTES

    if (char === '"') {

      if (
        inQuotes &&
        nextChar === '"'
      ) {

        field += '"';
        i++;

      } else {

        inQuotes = !inQuotes;

      }

    }


    // COMMA = NEXT COLUMN

    else if (
      char === "," &&
      !inQuotes
    ) {

      row.push(field.trim());

      field = "";

    }


    // NEW LINE = NEXT ROW
    // Only when NOT inside quotes

    else if (
      (char === "\n" || char === "\r") &&
      !inQuotes
    ) {

      // Windows line ending

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


    // NORMAL CHARACTER

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


  // GET HEADERS

  const headers = rows.shift();


  // CONVERT TO OBJECTS

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
// RANK DATABASE RECORDS
// ==========================================

function rank(
  rows,
  query,
  answers = []
) {

  const terms = words(

    query +
    " " +
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
// ASK GROQ AI
// ==========================================

async function askAI(
  message,
  state,
  candidates
) {


  // ========================================
  // KEEP REQUEST SMALL
  // Only send 4 candidates
  // Only send first 200 characters
  // ========================================

  const compactCandidates =

    candidates

      .slice(0, 4)

      .map((item) => ({

        medicine_name:

          item.product_name || "",


        indications:

          (item.indications || "")

            .replace(/\s+/g, " ")

            .slice(0, 200)

      }));


  // ========================================
  // SHORT PROMPT
  // ========================================

  const prompt = `You are a database narrowing assistant.

You are NOT a doctor.

Do not diagnose.
Do not prescribe.
Do not recommend treatment.

Your ONLY job is to narrow database records.

User message:
${message}

Previous answers:
${(state.answers || [])
  .slice(-3)
  .join(" | ") || "None"}

Candidate records:
${JSON.stringify(compactCandidates)}

Ask exactly ONE short neutral question that best separates the candidate records.

Only ask about information represented in the candidate records.

Do not ask something already answered.

If the records are sufficiently narrowed, choose "results".

For "results", use an empty question and empty options.`;


  // ========================================
  // CALL GROQ
  // ========================================

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


        // LOW REASONING

        reasoning_effort: "low",


        // IMPORTANT:
        // Prevent reasoning from taking
        // over the response

        include_reasoning: false,


        temperature: 0.3,


        // Enough room for
        // one question

        max_completion_tokens: 500,


        // ==================================
        // STRICT JSON SCHEMA
        // ==================================

        response_format: {

          type: "json_schema",


          json_schema: {

            name:
              "dataset_narrowing_response",


            strict: true,


            schema: {

              type: "object",


              properties: {

                action: {

                  type: "string",


                  enum: [

                    "question",

                    "results"

                  ]

                },


                question: {

                  type: "string"

                },


                options: {

                  type: "array",


                  items: {

                    type: "string"

                  }

                }

              },


              required: [

                "action",

                "question",

                "options"

              ],


              additionalProperties:

                false

            }

          }

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


  // ========================================
  // CHECK GROQ ERROR
  // ========================================

  if (!res.ok) {

    const errorText =
      await res.text();


    console.error(
      "GROQ ERROR:",
      errorText
    );


    throw new Error(

      "AI provider error: " +
      errorText

    );

  }


  // ========================================
  // GET RESPONSE
  // ========================================

  const data =
    await res.json();


  console.log(
    "GROQ RESPONSE:",
    JSON.stringify(data)
  );


  const content =

    data
      ?.choices?.[0]
      ?.message
      ?.content;


  // ========================================
  // CHECK CONTENT
  // ========================================

  if (!content) {

    throw new Error(

      "AI returned an empty response"

    );

  }


  // ========================================
  // PARSE JSON
  // ========================================

  try {

    return JSON.parse(content);

  }

  catch (error) {

    console.error(
      "JSON PARSE ERROR:",
      content
    );


    throw new Error(

      "AI returned invalid JSON"

    );

  }

}


// ==========================================
// MAIN API
// ==========================================

export default async function handler(
  req,
  res
) {


  // ONLY POST ALLOWED

  if (
    req.method !== "POST"
  ) {

    return res.status(405).json({

      error: "POST only"

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


    // CHECK MESSAGE

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
    // SAVE ANSWERS
    // ======================================

    const answers = [

      ...(state.answers || []),

      message

    ];


    // ======================================
    // ORIGINAL USER QUERY
    // ======================================

    const rootQuery =

      state.rootQuery ||

      message;


    // ======================================
    // FIND CANDIDATES
    // ======================================

    const candidates =

      rank(

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
    // OR WHEN ONLY 3 REMAIN
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
    // ASK AI
    // ======================================

    const ai =

      await askAI(

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
    // SHOW RESULTS
    // ======================================

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


    // ======================================
    // SHOW QUESTION
    // ======================================

    return res.status(200).json({

      type: "question",


      question:

        ai.question ||

        "Could you provide a little more detail?",


      options:

        ai.options?.length

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
  // ERROR HANDLING
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
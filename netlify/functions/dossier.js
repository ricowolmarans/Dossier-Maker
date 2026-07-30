const { Groq } = require("groq-sdk");

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  try {
    const body = JSON.parse(event.body);
    const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

    // --- ACTION 1: Chat Message ---
    if (body.action === "chat") {
      const chatCompletion = await groq.chat.completions.create({
        messages: [
          {
            role: "system",
            content: "You are an intelligence analyst helper. Answer the user's question concisely using the provided dossier context."
          },
          {
            role: "user",
            content: `DOSSIER CONTEXT:\n${body.context}\n\nUSER QUESTION:\n${body.question}`
          }
        ],
        model: "llama-3.3-70b-versatile"
      });

      return {
        statusCode: 200,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reply: chatCompletion.choices[0]?.message?.content })
      };
    }

    // --- ACTION 2: Generate Initial Dossier ---
    const { target, type } = body;
    let rawData = { target, type };

    if (type === "username") {
      const res = await fetch(`https://api.github.com/users/${target}`);
      if (res.ok) rawData.github = await res.json();
    } else if (type === "domain") {
      const res = await fetch(`https://archive.org/wayback/available?url=${target}`);
      if (res.ok) rawData.wayback = await res.json();
    } else if (type === "email" || type === "phone") {
      // Formatted structured placeholder for email/phone target synthesis
      rawData.identifier = target;
      rawData.vector = type;
    }

    const prompt = `
    You are an elite intelligence analyst creating a classified target dossier for a target with vector "${type}" and value "${target}".
    Data available: ${JSON.stringify(rawData, null, 2)}

    Format the brief as follows:
    1. TARGET IDENTIFICATION
    2. KEY INTELLIGENCE SUMMARY (3-4 concise points)
    3. EXPOSURE & RISK ASSESSMENT
    `;

    const chatCompletion = await groq.chat.completions.create({
      messages: [{ role: "user", content: prompt }],
      model: "llama-3.3-70b-versatile"
    });

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        report: chatCompletion.choices[0]?.message?.content || "No intelligence produced."
      })
    };
  } catch (error) {
    return {
      statusCode: 500,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: error.message })
    };
  }
};

const { Groq } = require("groq-sdk");

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  try {
    const { target, type } = JSON.parse(event.body);
    let rawData = {};

    // 1. Fetch OSINT Data
    if (type === "username") {
      const userRes = await fetch(`https://api.github.com/users/${target}`);
      if (!userRes.ok) throw new Error("GitHub target not found.");
      const userData = await userRes.json();

      const reposRes = await fetch(userData.repos_url);
      const reposData = reposRes.ok ? await reposRes.json() : [];

      rawData = {
        type: "username",
        target: target,
        name: userData.name,
        bio: userData.bio,
        location: userData.location,
        followers: userData.followers,
        public_repos: userData.public_repos,
        repos: Array.isArray(reposData) ? reposData.slice(0, 5).map(r => r.name) : []
      };
    } else if (type === "domain") {
      const waybackRes = await fetch(`https://archive.org/wayback/available?url=${target}`);
      const waybackData = await waybackRes.json();
      const snapshot = waybackData.archived_snapshots?.closest;

      rawData = {
        type: "domain",
        target: target,
        is_archived: snapshot ? snapshot.available : false,
        latest_snapshot: snapshot ? snapshot.timestamp : null,
        url: snapshot ? snapshot.url : null
      };
    }

    // 2. Synthesize Intelligence via Groq AI
    const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
    const prompt = `
    You are an elite intelligence analyst creating a classified target dossier.
    Synthesize this target data into a structured report:
    ${JSON.stringify(rawData, null, 2)}

    Include:
    1. TARGET IDENTIFICATION
    2. KEY INTELLIGENCE SUMMARY (3-4 bullets)
    3. KNOWN ASSETS & TIMELINES
    4. THREAT / EXPOSURE RATING (Low/Medium/High with reasoning)
    `;

const chatCompletion = await groq.chat.completions.create({
  messages: [{ role: "user", content: prompt }],
  model: "llama-3.3-70b-versatile",
});

    const report = chatCompletion.choices[0]?.message?.content || "No intel generated.";

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rawData, report }),
    };
  } catch (error) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: error.message }),
    };
  }
};

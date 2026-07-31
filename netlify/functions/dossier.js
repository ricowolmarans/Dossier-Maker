const { Groq } = require("groq-sdk");

async function fetchLiveWebsite(domain) {
  try {
    const url = domain.startsWith("http") ? domain : `https://${domain}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9"
      }
    });

    clearTimeout(timeout);

    if (!response.ok) {
      return { status: response.status, error: `HTTP ${response.status}` };
    }

    const html = await response.text();
    const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
    const metaDescMatch = html.match(/<meta[^>]*name=["']description["'][^>]*content=["']([^"']+)["']/i);

    let cleanText = html
      .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, " ")
      .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim();

    return {
      status: response.status,
      title: titleMatch ? titleMatch[1].trim() : "No Title",
      description: metaDescMatch ? metaDescMatch[1].trim() : "No Meta Description",
      scraped_sample: cleanText.substring(0, 2000)
    };
  } catch (err) {
    return { error: `Live scrape failed: ${err.message}` };
  }
}

// Helper: Tavily Web Search API Integration
async function searchTavily(query) {
  const apiKey = process.env.TAVILY_API_KEY;
  if (!apiKey) return { note: "TAVILY_API_KEY is not configured." };

  try {
    const res = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_key: apiKey,
        query: query,
        search_depth: "basic",
        include_answer: true,
        max_results: 5
      })
    });

    if (!res.ok) return { error: `Tavily API returned status ${res.status}` };
    const data = await res.json();


    return {
      tavily_answer: data.answer || null,
      web_results: data.results ? data.results.map(r => ({
        title: r.title,
        url: r.url,
        snippet: r.content
      })) : []
    };
  } catch (err) {
    return { error: `Tavily search failed: ${err.message}` };
  }
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  try {
    const body = JSON.parse(event.body);
    const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

    // --- ACTION 1: Chat Follow-up ---
    if (body.action === "chat") {
      const chatCompletion = await groq.chat.completions.create({
        messages: [
          { role: "system", content: "You are an elite counter-intelligence analyst. Answer follow-up queries using the target dossier context." },
          { role: "user", content: `DOSSIER CONTEXT:\n${body.context}\n\nUSER QUESTION:\n${body.question}` }
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
    let rawData = { target, type, timestamp: new Date().toISOString() };

    // Formulate a Tavily search query based on target vector
    let tavilyQuery = `${target} OSINT public profile footprint`;
    if (type === "username") tavilyQuery = `"${target}" github twitter profile bio background`;
    else if (type === "domain") tavilyQuery = `site:${target} OR "${target}" company background infrastructure`;
    else if (type === "email") tavilyQuery = `"${target}" email breach presence profile`;

    // Always trigger Tavily search alongside domain/username specific APIs
    const tavilyPromise = searchTavily(tavilyQuery);

    if (type === "username") {
      const [tavilyRes, userRes, reposRes, eventsRes] = await Promise.allSettled([
        tavilyPromise,
        fetch(`https://api.github.com/users/${target}`),
        fetch(`https://api.github.com/users/${target}/repos?sort=updated&per_page=5`),
        fetch(`https://api.github.com/users/${target}/events/public?per_page=5`)
      ]);

      rawData.tavily_search = tavilyRes.status === "fulfilled" ? tavilyRes.value : null;
      rawData.github_profile = userRes.status === "fulfilled" && userRes.value.ok ? await userRes.value.json() : null;
      rawData.repositories = reposRes.status === "fulfilled" && reposRes.value.ok ? await reposRes.value.json() : [];
      rawData.recent_events = eventsRes.status === "fulfilled" && eventsRes.value.ok ? await eventsRes.value.json() : [];

      } else if (type === "domain") {
      const [tavilyRes, liveScrape, waybackRes, dnsRes] = await Promise.allSettled([
        tavilyPromise,
        fetchLiveWebsite(target),
        fetch(`https://archive.org/wayback/available?url=${target}`),
        fetch(`https://cloudflare-dns.com/dns-query?name=${target}&type=A`, { headers: { 'Accept': 'application/dns-json' } })
      ]);

      rawData.tavily_search = tavilyRes.status === "fulfilled" ? tavilyRes.value : null;
      rawData.live_website = liveScrape.status === "fulfilled" ? liveScrape.value : null;
      rawData.wayback_archive = waybackRes.status === "fulfilled" && waybackRes.value.ok ? await waybackRes.value.json() : null;
      rawData.dns_records = dnsRes.status === "fulfilled" && dnsRes.value.ok ? await dnsRes.value.json() : null;

    } else if (type === "ip") {
      const [tavilyRes, geoRes] = await Promise.allSettled([
        tavilyPromise,
        fetch(`http://ip-api.com/json/${target}?fields=status,country,city,isp,org,as,query,proxy,hosting`)
      ]);

      rawData.tavily_search = tavilyRes.status === "fulfilled" ? tavilyRes.value : null;
      rawData.ip_geo = geoRes.status === "fulfilled" && geoRes.value.ok ? await geoRes.value.json() : null;

    } else {
      // Email or Phone lookup fallback using Tavily
      const tavilyRes = await tavilyPromise;
      rawData.tavily_search = tavilyRes;
    }

    // AI Brief Synthesis
    const prompt = `
    You are an elite counter-intelligence analyst writing a classified target dossier.
    Synthesize all multi-source OSINT telemetry (including web search indexing via Tavily, APIs, and live site scraping) into a structured report.

    RAW OSINT TELEMETRY:
    ${JSON.stringify(rawData, null, 2)}

    REQUIRED FORMAT:
    1. TARGET IDENTIFICATION & OVERVIEW (Target vector, primary handle/identifier, summary status)
    2. WEB FOOTPRINT & RECONNAISSANCE (Insights from Tavily web search, social links, public occurrences)
    3. INFRASTRUCTURE & TECHNICAL ANALYSIS (Live web scrape summaries, IP/DNS info, repository metadata)
    4. DETECTED ASSETS & EXPOSURE VECTORS (Known public links, open ports, disposable status)
    5. THREAT & RISK ASSESSMENT MATRIX (Rating: CRITICAL / HIGH / MEDIUM / LOW with clear justification)
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

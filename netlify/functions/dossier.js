const { Groq } = require("groq-sdk");

// Helper function to scrape and clean live website content
async function fetchLiveWebsite(domain) {
  try {
    const url = domain.startsWith("http") ? domain : `https://${domain}`;
    
    // Set 5-second timeout to prevent serverless function hangs
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        // Pretend to be a browser to avoid 403 blocks
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9"
      }
    });

    clearTimeout(timeout);

    if (!response.ok) {
      return { status: response.status, error: `HTTP ${response.status} ${response.statusText}` };
    }

    const html = await response.text();

    // 1. Extract Meta Details
    const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
    const metaDescMatch = html.match(/<meta[^>]*name=["']description["'][^>]*content=["']([^"']+)["']/i);
    const ogTitleMatch = html.match(/<meta[^>]*property=["']og:title["'][^>]*content=["']([^"']+)["']/i);

    const title = titleMatch ? titleMatch[1].trim() : (ogTitleMatch ? ogTitleMatch[1].trim() : "No Title");
    const description = metaDescMatch ? metaDescMatch[1].trim() : "No Meta Description";

    // 2. Strip scripts, styles, HTML tags to leave clean text
    let cleanText = html
      .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, " ")
      .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, " ")
      .replace(/<noscript\b[^<]*(?:(?!<\/noscript>)<[^<]*)*<\/noscript>/gi, " ")
      .replace(/<[^>]+>/g, " ")  // Remove HTML tags
      .replace(/\s+/g, " ")       // Collapse whitespace
      .trim();

    // 3. Truncate text (first 2500 chars) to stay within AI context limits
    const textSnippet = cleanText.substring(0, 2500);

    return {
      status: response.status,
      title,
      description,
      scraped_content_sample: textSnippet
    };

  } catch (err) {
    return { error: `Failed to scrape live content: ${err.message}` };
  }
}

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
          { role: "system", content: "You are an elite intelligence analyst helper. Answer the user's question concisely using the provided target dossier as factual background." },
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

    if (type === "username") {
      const [userRes, reposRes, orgsRes, eventsRes] = await Promise.allSettled([
        fetch(`https://api.github.com/users/${target}`),
        fetch(`https://api.github.com/users/${target}/repos?sort=updated&per_page=5`),
        fetch(`https://api.github.com/users/${target}/orgs`),
        fetch(`https://api.github.com/users/${target}/events/public?per_page=5`)
      ]);

      rawData.github_profile = userRes.status === "fulfilled" && userRes.value.ok ? await userRes.value.json() : null;
      rawData.repositories = reposRes.status === "fulfilled" && reposRes.value.ok ? await reposRes.value.json() : [];
      rawData.organizations = orgsRes.status === "fulfilled" && orgsRes.value.ok ? await orgsRes.value.json() : [];
      rawData.recent_events = eventsRes.status === "fulfilled" && eventsRes.value.ok ? await eventsRes.value.json() : [];

    } else if (type === "domain") {
      // Parallel execution: Live Scrape + Wayback + DNS + WHOIS
      const [liveScrape, waybackRes, dnsRes, rdapRes] = await Promise.allSettled([
        fetchLiveWebsite(target),
        fetch(`https://archive.org/wayback/available?url=${target}`),
        fetch(`https://cloudflare-dns.com/dns-query?name=${target}&type=A`, { headers: { 'Accept': 'application/dns-json' } }),
        fetch(`https://rdap.org/domain/${target}`)
      ]);

      rawData.live_website_content = liveScrape.status === "fulfilled" ? liveScrape.value : null;
      rawData.wayback_archive = waybackRes.status === "fulfilled" && waybackRes.value.ok ? await waybackRes.value.json() : null;
      rawData.dns_records = dnsRes.status === "fulfilled" && dnsRes.value.ok ? await dnsRes.value.json() : null;
      rawData.rdap_whois = rdapRes.status === "fulfilled" && rdapRes.value.ok ? await rdapRes.value.json() : null;

    } else if (type === "ip") {
      const [geoRes, dnsPtrRes] = await Promise.allSettled([
        fetch(`http://ip-api.com/json/${target}?fields=status,message,country,countryCode,regionName,city,zip,lat,lon,timezone,isp,org,as,query,proxy,hosting`),
        fetch(`https://cloudflare-dns.com/dns-query?name=${target}&type=PTR`, { headers: { 'Accept': 'application/dns-json' } })
      ]);

      rawData.ip_geo = geoRes.status === "fulfilled" && geoRes.value.ok ? await geoRes.value.json() : null;
      rawData.reverse_dns = dnsPtrRes.status === "fulfilled" && dnsPtrRes.value.ok ? await dnsPtrRes.value.json() : null;

    } else if (type === "email") {
      const domain = target.split("@")[1] || "";
      const [disposableRes, mxDnsRes] = await Promise.allSettled([
        fetch(`https://raw.githubusercontent.com/disposable-email-domains/disposable-email-domains/master/disposable_email_blocklist.conf`),
        domain ? fetch(`https://cloudflare-dns.com/dns-query?name=${domain}&type=MX`, { headers: { 'Accept': 'application/dns-json' } }) : Promise.resolve(null)
      ]);

      let isDisposable = false;
      if (disposableRes.status === "fulfilled" && disposableRes.value.ok) {
        const text = await disposableRes.value.text();
        isDisposable = text.includes(domain.toLowerCase());
      }

      rawData.email_analysis = {
        email: target,
        domain: domain,
        is_disposable: isDisposable,
        mx_records: mxDnsRes.status === "fulfilled" && mxDnsRes.value?.ok ? await mxDnsRes.value.json() : null
      };

    } else if (type === "phone") {
      const cleanedPhone = target.replace(/[^0-9+]/g, '');
      rawData.phone_analysis = {
        input: target,
        cleaned: cleanedPhone,
        has_country_code: cleanedPhone.startsWith("+"),
        digit_count: cleanedPhone.replace("+", "").length
      };
    }

    // AI Prompt Instructions for Content Analysis
    const prompt = `
    You are an elite counter-intelligence analyst writing a classified target dossier.
    Synthesize all provided multi-source OSINT telemetry into a comprehensive brief.

    RAW TELEMETRY DATA:
    ${JSON.stringify(rawData, null, 2)}

    YOU MUST STRUCTURALLY COVER:
    1. TARGET IDENTIFICATION & OVERVIEW (Vector, primary handle/identifier, active status)
    2. LIVE WEBSITE & CONTENT ANALYSIS (If domain: summarize purpose, key text, meta tags, visible business model/stack based on scraped_content_sample)
    3. NETWORK & INFRASTRUCTURE ANALYSIS (IPs, DNS, Hosting, Domain history, or Account statistics)
    4. DETECTED ASSETS & VULNERABILITIES / EXPOSURES (Public repos, exposure vectors, disposable email status, open proxies)
    5. RECENT ACTIVITY TIMELINE (Event timestamps, account creation dates, DNS modified timelines)
    6. THREAT & RISK ASSESSMENT MATRIX (Rating: CRITICAL / HIGH / MEDIUM / LOW with deep justification)
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

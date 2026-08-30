import type { NextApiRequest, NextApiResponse } from "next";
import { getVerses, allKJVVersesFlat } from "../../utils/kjv";

type Body = {
  book: string;
  chapter: string | number;
  verses: string; // e.g., "16" or "16-18" or "16,18"
  style?: "expository" | "topical" | "evangelistic" | "lecture";
  tone?: "formal" | "conversational" | "revival";
  length?: "short" | "medium" | "long";
  title?: string;
};

function buildSystemPrompt() {
  return `You are an assistant that writes sermons and lectures in an Independent Baptist style. RULES:\n- Do NOT quote or write any Bible text except via the exact placeholders provided (placeholders look like {{VERSE_Book_Chapter_Verse}}).\n- Wherever scripture should appear, insert only the appropriate placeholder token (e.g., {{VERSE_John_3_16}}). Do NOT expand these placeholders into verse text.\n- Use conservative Independent Baptist doctrine and tone as requested by the user.\n- Structure the sermon: Introduction, Exposition, Application, Invitation/Conclusion.\n- If the user asked for expository style, proceed verse-by-verse.`;
}

async function callOpenAI(payload: any) {
  const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
  if (!OPENAI_API_KEY) throw new Error("OpenAI API key not configured.");

  // Use global fetch if available (Node 18+ / Next). Otherwise, fall back to node-fetch.
  // node-fetch v2 is a CommonJS module so we require it here if needed.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fetchImpl: any = (globalThis as any).fetch ? (globalThis as any).fetch : (await import('node-fetch')).default || (await import('node-fetch'));

  const response = await fetchImpl("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${OPENAI_API_KEY}`
    },
    body: JSON.stringify(payload)
  });

  return response;
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") return res.status(405).end();
  const body = req.body as Body;
  const { book, chapter, verses, style = "expository", tone = "formal", length = "medium", title } = body;

  if (!book || !chapter || !verses) return res.status(400).json({ error: "Missing book, chapter, or verses" });

  const verseObjs = getVerses(book, chapter, verses);
  if (!verseObjs || verseObjs.length === 0) return res.status(400).json({ error: "No verses found in local KJV DB. Add them to data/kjv.json or use the sample." });

  const placeholders = verseObjs.map(v => v.placeholder).join(" ");

  const baseUserPrompt = `Write a sermon manuscript in Independent Baptist ${style} style, tone: ${tone}, length: ${length}.\nSermon title: ${title || `${book} ${chapter}:${verses}`}\n\nUse the placeholders ${placeholders} wherever you would quote the Bible. Do NOT write any scripture other than those placeholders. Do not include any other Bible text or paraphrase scripture. After writing, leave the placeholder(s) exactly as shown.`;

  const messagesTemplate = [{ role: "system", content: buildSystemPrompt() }];

  // Retry loop: up to 3 attempts with decreasing temperature
  let lastRawContent: string | null = null;
  const temps = [0.6, 0.3, 0.0];
  for (let attempt = 1; attempt <= 3; attempt++) {
    const temp = temps[Math.min(attempt - 1, temps.length - 1)];
    let userPrompt = baseUserPrompt;
    if (attempt > 1) {
      userPrompt += `\n\nIMPORTANT: This is a retry (attempt ${attempt}). You MUST include each placeholder exactly as shown in the output. If you cannot, respond only with the single token: PLACEHOLDERS_MISSING`;
    }

    const messages = messagesTemplate.concat([{ role: "user", content: userPrompt }]);

    const payload = {
      model: process.env.OPENAI_MODEL || "gpt-4",
      messages,
      max_tokens: 2000,
      temperature: temp
    };

    let response;
    try {
      response = await callOpenAI(payload);
    } catch (err) {
      console.error("OpenAI request failed", err);
      return res.status(500).json({ error: "OpenAI request failed", details: String(err) });
    }

    if (!response.ok) {
      const errText = await response.text();
      console.error("OpenAI API error", errText);
      return res.status(500).json({ error: "OpenAI API error", details: errText });
    }

    const result = await response.json();
    const content = result.choices?.[0]?.message?.content as string | undefined;
    lastRawContent = content || null;
    if (!content) {
      // retry
      continue;
    }

    // If model returned the special failure token, stop and return error
    if (content.trim() === "PLACEHOLDERS_MISSING") {
      return res.status(500).json({ error: "Model reported it could not include placeholders." });
    }

    // Verify all placeholders present
    let allPresent = true;
    for (const v of verseObjs) {
      if (!content.includes(v.placeholder)) {
        allPresent = false;
        break;
      }
    }

    if (!allPresent) {
      // try again (loop will continue). If last attempt, return error with raw content.
      if (attempt === 3) {
        return res.status(400).json({ error: "Model did not include all scripture placeholders after retries.", raw: content });
      }
      continue;
    }

    // Substitute placeholders with exact KJV text
    let final = content;
    for (const v of verseObjs) {
      const replacement = `"${v.text}" (${book} ${v.chapter}:${v.verse})`;
      final = final.split(v.placeholder).join(replacement);
    }

    // Post-check: ensure any quoted blocks match KJV DB
    const quotedRegex = /"([^\"]{20,1000})"/g;
    const kjvFlat = allKJVVersesFlat();
    let match: RegExpExecArray | null;
    while ((match = quotedRegex.exec(final)) !== null) {
      const q = match[1].trim();
      const found = kjvFlat.includes(q);
      if (!found) {
        return res.status(500).json({ error: "Post-check failed: a quoted block does not exactly match KJV content.", offending: q });
      }
    }

    return res.status(200).json({ sermon: final });
  }

  return res.status(500).json({ error: "Generation failed", raw: lastRawContent });
}

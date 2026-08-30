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

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") return res.status(405).end();
  const body = req.body as Body;
  const { book, chapter, verses, style = "expository", tone = "formal", length = "medium", title } = body;

  if (!book || !chapter || !verses) return res.status(400).json({ error: "Missing book, chapter, or verses" });

  const verseObjs = getVerses(book, chapter, verses);
  if (!verseObjs || verseObjs.length === 0) return res.status(400).json({ error: "No verses found in local KJV DB. Add them to data/kjv.json or use the sample." });

  const placeholders = verseObjs.map(v => v.placeholder).join(" ");

  const userPrompt = `Write a sermon manuscript in Independent Baptist ${style} style, tone: ${tone}, length: ${length}.\nSermon title: ${title || `${book} ${chapter}:${verses}`}\n\nUse the placeholders ${placeholders} wherever you would quote the Bible. Do NOT write any scripture other than those placeholders. Do not include any other Bible text or paraphrase scripture. After writing, leave the placeholder(s) exactly as shown.`;

  const messages = [
    { role: "system", content: buildSystemPrompt() },
    { role: "user", content: userPrompt }
  ];

  const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
  const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4";

  if (!OPENAI_API_KEY) return res.status(500).json({ error: "OpenAI API key not configured." });

  let response;
  try {
    response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        messages,
        max_tokens: 2000,
        temperature: 0.6
      })
    });
  } catch (err) {
    console.error("OpenAI fetch error", err);
    return res.status(500).json({ error: "OpenAI request failed", details: String(err) });
  }

  if (!response.ok) {
    const errText = await response.text();
    return res.status(500).json({ error: "OpenAI API error", details: errText });
  }

  const result = await response.json();
  const content = result.choices?.[0]?.message?.content;
  if (!content) return res.status(500).json({ error: "No content from model." });

  // Verify all placeholders present
  for (const v of verseObjs) {
    if (!content.includes(v.placeholder)) {
      return res.status(400).json({ error: "Model did not include all scripture placeholders. Regenerate with stricter instructions.", raw: content });
    }
  }

  // Substitute placeholders with exact KJV text
  let final = content;
  for (const v of verseObjs) {
    // Insert verse in quotes and include reference after (e.g., "For God..." (John 3:16))
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

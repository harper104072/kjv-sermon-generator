import fs from "fs";
import path from "path";
import kjvData from "../data/kjv.sample.json";

type KjvData = Record<string, Record<string, Record<string, string>>>;

let _kjv: KjvData = kjvData as KjvData;

// If a full data/kjv.json exists, prefer it (read synchronously at startup)
try {
  const kjvPath = path.join(process.cwd(), "data", "kjv.json");
  if (fs.existsSync(kjvPath)) {
    const raw = fs.readFileSync(kjvPath, { encoding: "utf8" });
    const full = JSON.parse(raw) as KjvData;
    if (full && Object.keys(full).length > Object.keys(_kjv).length) {
      _kjv = full;
    }
  }
} catch (e) {
  // ignore - use sample
}

function normalizeBookKey(book: string): string | null {
  const keys = Object.keys(_kjv);
  const b = book.trim().toLowerCase();
  for (const k of keys) {
    if (k.toLowerCase() === b) return k;
  }
  // try simple conversions (e.g., 1 John, 1John => 1 John)
  for (const k of keys) {
    if (k.replace(/\s+/g, "").toLowerCase() === b.replace(/\s+/g, "")) return k;
  }
  return null;
}

export function getVerse(book: string, chapter: string | number, verse: string | number): string | null {
  const bookKey = normalizeBookKey(book);
  if (!bookKey) return null;
  const c = String(chapter);
  const v = String(verse);
  const chap = (_kjv as any)[bookKey][c];
  if (!chap) return null;
  return chap[v] || null;
}

export function makePlaceholder(book: string, chapter: string | number, verse: string | number) {
  const b = String(book).replace(/\s+/g, "_");
  return `{{VERSE_${b}_${chapter}_${verse}}}`;
}

// Accepts verseSpec like "16", "16-18", "16,18", or combinations
export function getVerses(book: string, chapter: string | number, verseSpec: string) {
  const verses: { chapter: number; verse: number; text: string; placeholder: string }[] = [];
  const parts = verseSpec.split(",");
  for (const p of parts) {
    const part = p.trim();
    if (part.length === 0) continue;
    if (part.includes("-")) {
      const [aStr, bStr] = part.split("-").map(x => x.trim());
      const a = parseInt(aStr, 10);
      const b = parseInt(bStr, 10);
      if (Number.isNaN(a) || Number.isNaN(b)) continue;
      for (let v = a; v <= b; v++) {
        const text = getVerse(book, chapter, v);
        if (text) verses.push({ chapter: Number(chapter), verse: v, text, placeholder: makePlaceholder(book, chapter, v) });
      }
    } else {
      const v = parseInt(part, 10);
      if (Number.isNaN(v)) continue;
      const text = getVerse(book, chapter, v);
      if (text) verses.push({ chapter: Number(chapter), verse: v, text, placeholder: makePlaceholder(book, chapter, v) });
    }
  }
  return verses;
}

export function allKJVVersesFlat(): string[] {
  const list: string[] = [];
  for (const bk of Object.keys(_kjv)) {
    const chapters = (_kjv as any)[bk];
    for (const ch of Object.keys(chapters)) {
      for (const vs of Object.keys(chapters[ch])) {
        list.push((chapters as any)[ch][vs]);
      }
    }
  }
  return list;
}

import fs from "fs";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

const data = new Uint8Array(fs.readFileSync("./public/1763452042.pdf"));
const pdf = await getDocument({ data, disableWorker: true }).promise;

function groupRowsIntoLines(rows) {
  const lines = [];
  for (const row of rows) {
    const lastLine = lines[lines.length - 1];
    if (!lastLine || Math.abs(lastLine.y - row.y) > 2)
      lines.push({ y: row.y, chunks: [row] });
    else lastLine.chunks.push(row);
  }
  return lines.map((line) => {
    const chunks = line.chunks.sort((a, b) => a.x - b.x);
    return { text: chunks.map((entry) => entry.str).join(" "), chunks };
  });
}

function buildLinesFromItems(items, pageWidth) {
  const rows = [...items]
    .filter((item) => item.str?.trim())
    .map((item) => ({
      x: item.transform[4],
      y: item.transform[5],
      str: item.str.trim(),
    }))
    .sort((left, right) => {
      if (Math.abs(right.y - left.y) > 2) return right.y - left.y;
      return left.x - right.x;
    });

  const midpoint = pageWidth / 2;
  const centerBand = pageWidth * 0.08;
  const leftRows = [];
  const rightRows = [];
  for (const row of rows) {
    if (row.x < midpoint - centerBand) leftRows.push(row);
    else if (row.x > midpoint + centerBand) rightRows.push(row);
    else if (row.x <= midpoint) leftRows.push(row);
    else rightRows.push(row);
  }

  return [...groupRowsIntoLines(leftRows), ...groupRowsIntoLines(rightRows)];
}

function parseAnswerPairs(text) {
  return [
    ...text.matchAll(/(?:^|[\s,;|])(\d{1,3})\s*[).:-]?\s*([A-Da-d])/g),
  ].map((m) => Number(m[1]));
}

function countAnswerPairs(text) {
  return [
    ...text.matchAll(
      /(?:^|[\s,;|])(\d{1,3})\s*[).:-]?\s*([A-Da-d])(?:\s+\d{1,3}%?)?/g,
    ),
  ].length;
}

function countPercentAnswerPairs(text) {
  return [...text.matchAll(/(?:^|[\s,;|])(\d{1,3})\s+[A-Da-d]\s+\d{1,3}%/g)]
    .length;
}

const pageTexts = [];
const allLines = [];
for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
  const page = await pdf.getPage(pageNumber);
  const content = await page.getTextContent();
  const pageWidth = page.getViewport({ scale: 1 }).width;
  const lines = buildLinesFromItems(content.items, pageWidth);
  allLines.push(lines);
  pageTexts.push(lines.map((line) => line.text).join("\n"));
}

const pageStats = pageTexts.map((text, index) => ({
  page: index + 1,
  pairCount: countAnswerPairs(text),
  percentPairCount: countPercentAnswerPairs(text),
}));

console.log(
  "Page stats:",
  pageStats
    .map(
      (s) => `p${s.page}: pairs=${s.pairCount}, pctPairs=${s.percentPairCount}`,
    )
    .join(" | "),
);

const detectedByOld = pageStats
  .filter((s) => s.pairCount >= 20)
  .map((s) => s.page);
const detectedByPct = pageStats
  .filter((s) => s.percentPairCount >= 20)
  .map((s) => s.page);
console.log("oldAnswerPages", detectedByOld.join(","));
console.log("pctAnswerPages", detectedByPct.join(","));

const answerPages = detectedByPct.length
  ? detectedByPct.map((p) => p - 1)
  : [pageTexts.length - 1];
const answerText = answerPages.map((idx) => pageTexts[idx]).join("\n");
const answerNumbers = [...new Set(parseAnswerPairs(answerText))].sort(
  (a, b) => a - b,
);
console.log(
  "answerCount",
  answerNumbers.length,
  "min",
  answerNumbers[0],
  "max",
  answerNumbers[answerNumbers.length - 1],
);

const questionLines = allLines
  .filter((_, idx) => !answerPages.includes(idx))
  .flat();
const starts = questionLines
  .map((line, index) => {
    const match = line.text.match(/^\s*(\d{1,3})\s*\.\s+/);
    if (!match) {
      return null;
    }
    return { index, number: Number(match[1]) };
  })
  .filter(Boolean);
const uniqueStarts = [...new Set(starts.map((entry) => entry.number))].sort(
  (a, b) => a - b,
);
console.log(
  "questionStartCount",
  uniqueStarts.length,
  "min",
  uniqueStarts[0],
  "max",
  uniqueStarts[uniqueStarts.length - 1],
);

const missingStartVsAnswer = answerNumbers.filter(
  (n) => !uniqueStarts.includes(n),
);
console.log("missingStartVsAnswer", missingStartVsAnswer.join(","));

function canParseOptions(blockText) {
  const normalized = blockText
    .replace(/^\s*\d{1,3}\s*\.\s+/, "")
    .replace(/\s+([A-Da-d]\s*\))/g, "\n$1");
  const markers = [...normalized.matchAll(/(?:^|\n)\s*([A-Da-d])\s*\)\s*/g)];

  const needed = ["A", "B", "C", "D"];
  let markerStart = 0;
  for (const neededLabel of needed) {
    const nextMarker = markers.find(
      (marker) =>
        (marker.index ?? 0) >= markerStart &&
        marker[1].toUpperCase() === neededLabel,
    );
    if (!nextMarker) {
      return false;
    }
    markerStart = (nextMarker.index ?? 0) + nextMarker[0].length;
  }

  return true;
}

const failed = [];
for (let index = 0; index < starts.length; index += 1) {
  const current = starts[index];
  const next = starts[index + 1];
  const blockText = questionLines
    .slice(current.index, next ? next.index : questionLines.length)
    .map((line) => line.text)
    .join("\n");

  if (!canParseOptions(blockText)) {
    failed.push({
      number: current.number,
      sample: blockText.slice(0, 320).replace(/\s+/g, " "),
    });
  }
}

console.log("failedParseCount", failed.length);
console.log("failedNumbers", failed.map((entry) => entry.number).join(","));
for (const failedEntry of failed.slice(0, 12)) {
  console.log(`FAILED ${failedEntry.number}: ${failedEntry.sample}`);
}

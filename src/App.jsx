import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { GlobalWorkerOptions, getDocument } from "pdfjs-dist";
import pdfWorker from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import "./App.css";

GlobalWorkerOptions.workerSrc = pdfWorker;

const REFERENCE_FILE_NAME = "1763452042.pdf";
const OPTION_LABEL_MAP = {
  A: "A",
  B: "B",
  C: "C",
  D: "D",
  a: "A",
  b: "B",
  c: "C",
  d: "D",
};

const ENGLISH_REGEX = /[A-Za-z]/;
const REQUIRED_OPTION_ORDER = ["A", "B", "C", "D"];

function normalizeOptionLabel(value) {
  return OPTION_LABEL_MAP[value] ?? null;
}

function countEnglishChars(text) {
  if (!text) {
    return 0;
  }

  return (text.match(ENGLISH_REGEX) ?? []).length;
}

function normalizeEnglishSpacing(text) {
  if (!text) {
    return "";
  }

  return text.replace(/\s+/g, " ").trim();
}

function stripHindiChars(text) {
  return text.replace(/[\u0900-\u097F]/g, " ").replace(/[/|•]/g, " ");
}

function stripTrailingPdfArtifacts(text) {
  if (!text) {
    return "";
  }

  return text
    .replace(/https?:\S*/gi, " ")
    .replace(/\bCorrect\s*Answer\b[\s\S]*$/i, " ")
    .replace(
      /\b(Answer\s*%|Correct\s*%|Q\.?\s*No|Skipped|TTA)\b[\s\S]*$/i,
      " ",
    );
}

function pickEnglishText(text) {
  const normalizedText = text.replace(/\s*\/\s*/g, " /").trim();
  if (!normalizedText) {
    return "";
  }

  const segments = normalizedText
    .split(/\s\/\s|\||•/)
    .map((segment) => segment.trim())
    .filter(Boolean);

  if (segments.length) {
    const bestSegment = segments
      .map((segment) => ({
        segment,
        score: countEnglishChars(segment),
      }))
      .sort((left, right) => right.score - left.score)[0];

    if (bestSegment?.score > 0) {
      return normalizeEnglishSpacing(
        stripTrailingPdfArtifacts(stripHindiChars(bestSegment.segment)),
      );
    }
  }

  const stripped = stripTrailingPdfArtifacts(stripHindiChars(normalizedText));

  return normalizeEnglishSpacing(stripped);
}

function cleanQuestionPromptText(text) {
  const normalized = normalizeEnglishSpacing(text);
  if (!normalized) {
    return "";
  }

  const collapseDuplicateColons = (value) =>
    value
      .replace(/[:：]\s*[:：]+/g, ":")
      .replace(/\s{2,}/g, " ")
      .trim();

  const firstQuestionMarkIndex = normalized.indexOf("?");
  if (firstQuestionMarkIndex === -1) {
    const firstColonMatchIndex = normalized.search(/[:：]/);
    if (firstColonMatchIndex !== -1) {
      return collapseDuplicateColons(
        normalized.slice(0, firstColonMatchIndex + 1),
      );
    }

    return collapseDuplicateColons(normalized);
  }

  return collapseDuplicateColons(
    normalized.slice(0, firstQuestionMarkIndex + 1),
  );
}

function isBoldFont(fontName) {
  return /bold|black|semibold/i.test(fontName ?? "");
}

function groupRowsIntoLines(rows) {
  const lines = [];
  for (const row of rows) {
    const lastLine = lines[lines.length - 1];
    if (!lastLine || Math.abs(lastLine.y - row.y) > 2) {
      lines.push({ y: row.y, chunks: [row] });
      continue;
    }
    lastLine.chunks.push(row);
  }

  return lines.map((line) => {
    const chunks = line.chunks.sort((a, b) => a.x - b.x);
    return {
      text: chunks.map((entry) => entry.str).join(" "),
      chunks,
    };
  });
}

function buildLinesFromItems(items, pageWidth) {
  const rows = [...items]
    .filter((item) => item.str?.trim())
    .map((item) => ({
      x: item.transform[4],
      y: item.transform[5],
      str: item.str.trim(),
      fontName: item.fontName ?? "",
    }))
    .sort((left, right) => {
      if (Math.abs(right.y - left.y) > 2) {
        return right.y - left.y;
      }
      return left.x - right.x;
    });

  if (!rows.length) {
    return [];
  }

  const midpoint = pageWidth / 2;
  const centerBand = pageWidth * 0.08;

  const leftRows = [];
  const rightRows = [];
  for (const row of rows) {
    if (row.x < midpoint - centerBand) {
      leftRows.push(row);
      continue;
    }

    if (row.x > midpoint + centerBand) {
      rightRows.push(row);
      continue;
    }

    if (row.x <= midpoint) {
      leftRows.push(row);
    } else {
      rightRows.push(row);
    }
  }

  const leftLines = groupRowsIntoLines(leftRows);
  const rightLines = groupRowsIntoLines(rightRows);

  if (!rightLines.length) {
    return leftLines;
  }

  if (!leftLines.length) {
    return rightLines;
  }

  return [...leftLines, ...rightLines];
}

function buildTextFromItems(items, pageWidth) {
  return buildLinesFromItems(items, pageWidth)
    .map((line) => line.text)
    .join("\n");
}

function buildRawTextFromItems(items) {
  return items
    .map((item) => item.str?.trim())
    .filter(Boolean)
    .join(" ");
}

function parseAnswerPairs(text) {
  const answerMap = {};
  const strictRegex = /(?:^|[\s,;|])(\d{1,3})\s*([A-Da-d])\s*\d{1,3}\s*%/g;
  let match = strictRegex.exec(text);

  while (match) {
    const questionNumber = Number(match[1]);
    const answerLabel = normalizeOptionLabel(match[2]);
    if (answerLabel) {
      answerMap[questionNumber] = answerLabel;
    }
    match = strictRegex.exec(text);
  }

  if (!Object.keys(answerMap).length) {
    const fallbackRegex = /(?:^|[\s,;|])(\d{1,3})\s*[).:-]?\s*([A-Da-d])/g;
    match = fallbackRegex.exec(text);

    while (match) {
      const questionNumber = Number(match[1]);
      const answerLabel = normalizeOptionLabel(match[2]);
      if (answerLabel) {
        answerMap[questionNumber] = answerLabel;
      }
      match = fallbackRegex.exec(text);
    }
  }

  return answerMap;
}

function countAnswerPairs(text) {
  const regex =
    /(?:^|[\s,;|])(\d{1,3})\s*[).:-]?\s*([A-Da-d])(?:\s+\d{1,3}%?)?/g;
  return [...text.matchAll(regex)].length;
}

function countPercentAnswerPairs(text) {
  const regex = /(?:^|[\s,;|])(\d{1,3})\s*([A-Da-d])\s*\d(?:\s*\d){0,2}\s*%/g;
  return [...text.matchAll(regex)].length;
}

function detectAnswerPageIndexes(rawPageTexts) {
  const pageStats = rawPageTexts.map((text, index) => ({
    index,
    percentCount: countPercentAnswerPairs(text),
  }));

  const percentIndexes = pageStats
    .map((entry) => ({
      index: entry.index,
      pairCount: entry.percentCount,
    }))
    .filter((entry) => entry.pairCount >= 30)
    .map((entry) => entry.index);

  if (percentIndexes.length) {
    return percentIndexes;
  }

  const sortedByPercent = [...pageStats]
    .sort((left, right) => right.percentCount - left.percentCount)
    .filter((entry) => entry.percentCount > 0)
    .slice(0, 3)
    .map((entry) => entry.index);

  if (sortedByPercent.length) {
    return sortedByPercent;
  }

  const indexes = rawPageTexts
    .map((text, index) => ({
      index,
      pairCount: countAnswerPairs(text),
    }))
    .filter((entry) => entry.pairCount >= 80)
    .map((entry) => entry.index);

  if (indexes.length) {
    return indexes;
  }

  return [rawPageTexts.length - 1];
}

function parseAnswerKeyFromPages(pageTexts, answerPageIndexes) {
  const merged = answerPageIndexes.map((index) => pageTexts[index]).join("\n");
  return parseAnswerPairs(merged);
}

function parseQuestionBlock(questionNumber, blockLines, answerMap) {
  const cleanedLines = blockLines
    .map((line) => line.text.trim())
    .filter(Boolean);

  if (!cleanedLines.length) {
    return null;
  }

  const withoutNumber = cleanedLines
    .map((line, index) =>
      index === 0 ? line.replace(/^\s*\d{1,3}\s*\.\s+/, "").trim() : line,
    )
    .join("\n")
    .replace(/\s+([A-Da-d]\s*\))/g, "\n$1");

  const optionRegex = /(?:^|\n)\s*([A-Da-d])\s*\)\s*/g;
  const markers = [...withoutNumber.matchAll(optionRegex)];
  if (!markers.length) {
    return null;
  }

  const orderedMarkers = [];
  let searchStartIndex = 0;
  for (const requiredLabel of REQUIRED_OPTION_ORDER) {
    const nextMarker = markers.find((marker) => {
      if ((marker.index ?? 0) < searchStartIndex) {
        return false;
      }
      const foundLabel = normalizeOptionLabel(marker[1]);
      return foundLabel === requiredLabel;
    });

    if (!nextMarker) {
      return null;
    }

    orderedMarkers.push(nextMarker);
    searchStartIndex = (nextMarker.index ?? 0) + nextMarker[0].length;
  }

  const prompt = withoutNumber
    .slice(0, orderedMarkers[0].index)
    .replace(/\s+/g, " ")
    .trim();
  const options = orderedMarkers.map((marker, index) => {
    const optionStart = marker.index + marker[0].length;
    const optionEnd =
      index + 1 < orderedMarkers.length
        ? orderedMarkers[index + 1].index
        : withoutNumber.length;
    const optionText = withoutNumber
      .slice(optionStart, optionEnd)
      .replace(/\s+/g, " ")
      .trim();

    return {
      label: REQUIRED_OPTION_ORDER[index],
      text: optionText,
    };
  });

  if (!prompt || options.some((option) => !option.text)) {
    return null;
  }

  return {
    number: questionNumber,
    prompt,
    options,
    correct: answerMap[questionNumber] ?? null,
  };
}

function getQuestionStartFromLine(line, requireBold) {
  const match = line.text.match(/^\s*(\d{1,3})\s*\.\s+/);
  if (!match) {
    return null;
  }

  if (requireBold) {
    const hasBoldNumber = line.chunks.some(
      (chunk) => /\d+\.?/.test(chunk.str) && isBoldFont(chunk.fontName),
    );

    if (!hasBoldNumber) {
      return null;
    }
  }

  return {
    number: Number(match[1]),
  };
}

function parseQuestions(
  questionPageLines,
  answerMap,
  requireBoldStarts = true,
) {
  const lines = questionPageLines.flat();
  const startCandidates = lines
    .map((line, index) => {
      const start = getQuestionStartFromLine(line, requireBoldStarts);
      if (!start) {
        return null;
      }
      return {
        index,
        number: start.number,
      };
    })
    .filter(Boolean);

  if (!startCandidates.length) {
    return [];
  }

  const orderedCandidates = [...startCandidates].sort(
    (left, right) => left.index - right.index,
  );
  const numbers = [...new Set(orderedCandidates.map((entry) => entry.number))];
  const minNumber = Math.min(...numbers);
  const maxNumber = Math.max(...numbers);

  const byNumber = new Map();
  for (const candidate of orderedCandidates) {
    const list = byNumber.get(candidate.number) ?? [];
    list.push(candidate);
    byNumber.set(candidate.number, list);
  }

  const sequentialStarts = [];
  let previousIndex = -1;
  for (
    let questionNumber = minNumber;
    questionNumber <= maxNumber;
    questionNumber += 1
  ) {
    const occurrences = byNumber.get(questionNumber) ?? [];
    const nextOccurrence = occurrences.find(
      (occurrence) => occurrence.index > previousIndex,
    );
    if (!nextOccurrence) {
      continue;
    }

    sequentialStarts.push(nextOccurrence);
    previousIndex = nextOccurrence.index;
  }

  const starts =
    sequentialStarts.length >=
    Math.max(20, Math.floor(orderedCandidates.length * 0.6))
      ? sequentialStarts
      : orderedCandidates;

  const parsed = [];
  for (let index = 0; index < starts.length; index += 1) {
    const current = starts[index];
    const next = starts[index + 1];
    const blockLines = lines.slice(
      current.index,
      next ? next.index : lines.length,
    );
    if (!blockLines.length) {
      continue;
    }

    const parsedQuestion = parseQuestionBlock(
      current.number,
      blockLines,
      answerMap,
    );

    if (parsedQuestion) {
      parsed.push(parsedQuestion);
    }
  }

  return parsed;
}

function parseQuestionsFromText(questionPagesText, answerMap) {
  const text = questionPagesText.join("\n");
  const markers = [...text.matchAll(/(?:^|\n)\s*(\d{1,3})\s*\.\s+/g)];
  if (!markers.length) {
    return [];
  }

  const parsed = [];
  for (let index = 0; index < markers.length; index += 1) {
    const current = markers[index];
    const next = markers[index + 1];
    const questionNumber = Number(current[1]);
    const blockStart = current.index;
    const blockEnd = next ? next.index : text.length;
    const blockText = text.slice(blockStart, blockEnd).trim();
    const parsedQuestion = parseQuestionBlock(
      questionNumber,
      [{ text: blockText }],
      answerMap,
    );

    if (parsedQuestion) {
      parsed.push(parsedQuestion);
    }
  }

  return parsed;
}

function parseQuestionBlockFromRawText(
  questionNumber,
  rawBlockText,
  answerMap,
) {
  const withoutNumber = rawBlockText
    .replace(new RegExp(`^\\s*${questionNumber}\\s*\\.\\s+`), "")
    .replace(/\s+([A-Da-d]\s*\))/g, "\n$1")
    .trim();

  const optionRegex = /([A-Da-d])\s*\)\s*/g;
  const markers = [...withoutNumber.matchAll(optionRegex)];
  if (!markers.length) {
    return null;
  }

  const orderedMarkers = [];
  let searchStartIndex = 0;
  for (const requiredLabel of REQUIRED_OPTION_ORDER) {
    const nextMarker = markers.find((marker) => {
      if ((marker.index ?? 0) < searchStartIndex) {
        return false;
      }
      const foundLabel = normalizeOptionLabel(marker[1]);
      return foundLabel === requiredLabel;
    });

    if (!nextMarker) {
      return null;
    }

    orderedMarkers.push(nextMarker);
    searchStartIndex = (nextMarker.index ?? 0) + nextMarker[0].length;
  }

  const prompt = withoutNumber
    .slice(0, orderedMarkers[0].index)
    .replace(/\s+/g, " ")
    .trim();
  const options = orderedMarkers.map((marker, index) => {
    const optionStart = marker.index + marker[0].length;
    const optionEnd =
      index + 1 < orderedMarkers.length
        ? orderedMarkers[index + 1].index
        : withoutNumber.length;

    return {
      label: REQUIRED_OPTION_ORDER[index],
      text: withoutNumber
        .slice(optionStart, optionEnd)
        .replace(/\s+/g, " ")
        .trim(),
    };
  });

  if (!prompt || options.some((option) => !option.text)) {
    return null;
  }

  return {
    number: questionNumber,
    prompt,
    options,
    correct: answerMap[questionNumber] ?? null,
  };
}

function recoverMissingQuestionsByNumber(
  questionPagesText,
  answerMap,
  existingQuestions,
) {
  const fullText = questionPagesText.join("\n");
  const existingNumbers = new Set(
    existingQuestions.map((question) => question.number),
  );
  const orderedAnswerNumbers = Object.keys(answerMap)
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value))
    .sort((left, right) => left - right);

  const recovered = [];
  for (let index = 0; index < orderedAnswerNumbers.length; index += 1) {
    const questionNumber = orderedAnswerNumbers[index];
    if (existingNumbers.has(questionNumber)) {
      continue;
    }

    const startRegex = new RegExp(
      `(?:^|\\s)(${questionNumber})\\s*\\.\\s+`,
      "g",
    );
    const startMatch = startRegex.exec(fullText);
    if (!startMatch) {
      continue;
    }

    const startIndex =
      startMatch.index + (startMatch[0].startsWith(" ") ? 1 : 0);
    let endIndex = fullText.length;

    for (
      let nextIndex = index + 1;
      nextIndex < orderedAnswerNumbers.length;
      nextIndex += 1
    ) {
      const nextQuestionNumber = orderedAnswerNumbers[nextIndex];
      const nextRegex = new RegExp(
        `(?:^|\\s)(${nextQuestionNumber})\\s*\\.\\s+`,
        "g",
      );
      nextRegex.lastIndex = startIndex + 1;
      const nextMatch = nextRegex.exec(fullText);
      if (nextMatch) {
        endIndex = nextMatch.index + (nextMatch[0].startsWith(" ") ? 1 : 0);
        break;
      }
    }

    const blockText = fullText.slice(startIndex, endIndex).trim();
    const recoveredQuestion = parseQuestionBlockFromRawText(
      questionNumber,
      blockText,
      answerMap,
    );

    if (recoveredQuestion) {
      recovered.push(recoveredQuestion);
    }
  }

  return recovered;
}

function App() {
  const INITIAL_JUMP_VISIBLE = 25;
  const QUESTION_TIME_LIMIT_SECONDS = 60;
  const [questions, setQuestions] = useState([]);
  const [selectedAnswers, setSelectedAnswers] = useState({});
  const [currentIndex, setCurrentIndex] = useState(0);
  const [isLoading, setIsLoading] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [reviewMode, setReviewMode] = useState("immediate");
  const [isTestCompleted, setIsTestCompleted] = useState(false);
  const [showAllJumps, setShowAllJumps] = useState(false);
  const [timeSpentByQuestion, setTimeSpentByQuestion] = useState({});
  const [timerNow, setTimerNow] = useState(Date.now());
  const [completedElapsedSeconds, setCompletedElapsedSeconds] = useState(null);
  const activeQuestionRef = useRef(null);
  const activeQuestionStartRef = useRef(null);
  const testStartRef = useRef(null);

  const score = useMemo(() => {
    return questions.reduce((total, question) => {
      if (
        selectedAnswers[question.number] &&
        selectedAnswers[question.number] === question.correct
      ) {
        return total + 1;
      }
      return total;
    }, 0);
  }, [questions, selectedAnswers]);

  const answeredCount = useMemo(() => {
    return questions.reduce((total, question) => {
      return selectedAnswers[question.number] ? total + 1 : total;
    }, 0);
  }, [questions, selectedAnswers]);

  const currentQuestion = questions[currentIndex] ?? null;

  const canRevealAnswers =
    reviewMode === "immediate" || (reviewMode === "end" && isTestCompleted);
  const canRevealCurrentQuestionAnswers =
    !!currentQuestion &&
    ((reviewMode === "immediate" &&
      !!selectedAnswers[currentQuestion.number]) ||
      (reviewMode === "end" && isTestCompleted));

  const recordActiveQuestionTime = () => {
    const activeQuestionNumber = activeQuestionRef.current;
    const activeStartMs = activeQuestionStartRef.current;

    if (activeQuestionNumber == null || activeStartMs == null) {
      return;
    }

    const elapsedSeconds = Math.floor((Date.now() - activeStartMs) / 1000);
    if (elapsedSeconds <= 0) {
      return;
    }

    setTimeSpentByQuestion((previous) => {
      const alreadySpent = previous[activeQuestionNumber] ?? 0;
      const updated = alreadySpent + elapsedSeconds;

      return {
        ...previous,
        [activeQuestionNumber]: updated,
      };
    });

    activeQuestionStartRef.current = Date.now();
  };

  const formatSeconds = (totalSeconds) => {
    const bounded = Math.max(0, totalSeconds);
    const minutes = Math.floor(bounded / 60)
      .toString()
      .padStart(2, "0");
    const seconds = (bounded % 60).toString().padStart(2, "0");
    return `${minutes}:${seconds}`;
  };

  const getQuestionTimeSpent = (questionNumber) => {
    const stored = timeSpentByQuestion[questionNumber] ?? 0;
    const isActiveQuestion =
      !isTestCompleted &&
      activeQuestionRef.current === questionNumber &&
      activeQuestionStartRef.current != null;

    if (!isActiveQuestion) {
      return stored;
    }

    const liveElapsed = Math.floor(
      (timerNow - activeQuestionStartRef.current) / 1000,
    );
    return stored + Math.max(0, liveElapsed);
  };

  const getTotalElapsedSeconds = () => {
    if (!testStartRef.current) {
      return 0;
    }

    return Math.max(0, Math.floor((Date.now() - testStartRef.current) / 1000));
  };

  const navigateToQuestion = (nextIndex) => {
    recordActiveQuestionTime();
    setCurrentIndex(nextIndex);
  };

  const resetQuizProgress = useCallback(() => {
    setSelectedAnswers({});
    setCurrentIndex(0);
    setIsTestCompleted(false);
    setShowAllJumps(false);
    setTimeSpentByQuestion({});
    setCompletedElapsedSeconds(null);
    activeQuestionRef.current = null;
    activeQuestionStartRef.current = null;
    testStartRef.current = Date.now();
    setTimerNow(Date.now());
  }, []);

  const loadQuizFromPdf = useCallback(
    async (blob) => {
      setIsLoading(true);
      setLoadError("");

      try {
        const data = new Uint8Array(await blob.arrayBuffer());
        const loadingTask = getDocument({ data });
        const pdf = await loadingTask.promise;

        if (pdf.numPages < 2) {
          throw new Error("PDF must have questions and answers pages.");
        }

        const pageTexts = [];
        const rawPageTexts = [];
        const allPageLines = [];
        for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
          const page = await pdf.getPage(pageNumber);
          const content = await page.getTextContent();
          const pageWidth = page.getViewport({ scale: 1 }).width;
          pageTexts.push(buildTextFromItems(content.items, pageWidth));
          rawPageTexts.push(buildRawTextFromItems(content.items));
          allPageLines.push(buildLinesFromItems(content.items, pageWidth));
        }

        const answerPageIndexes = detectAnswerPageIndexes(rawPageTexts);
        const answerMap = parseAnswerKeyFromPages(
          rawPageTexts,
          answerPageIndexes,
        );
        const questionPageLines = allPageLines;
        const questionPagesText = pageTexts;
        const parsedFromBold = parseQuestions(
          questionPageLines,
          answerMap,
          true,
        );
        const parsedWithoutBold = parseQuestions(
          questionPageLines,
          answerMap,
          false,
        );

        const mergedByNumber = new Map(
          parsedFromBold.map((question) => [question.number, question]),
        );
        for (const question of parsedWithoutBold) {
          if (!mergedByNumber.has(question.number)) {
            mergedByNumber.set(question.number, question);
          }
        }

        let parsedQuestions = [...mergedByNumber.values()].sort(
          (left, right) => left.number - right.number,
        );

        const expectedCount = Object.keys(answerMap).length;
        if (expectedCount && parsedQuestions.length < expectedCount) {
          const parsedFromText = parseQuestionsFromText(
            questionPagesText,
            answerMap,
          );
          if (parsedFromText.length) {
            const mergedByNumber = new Map(
              parsedQuestions.map((question) => [question.number, question]),
            );
            for (const question of parsedFromText) {
              if (!mergedByNumber.has(question.number)) {
                mergedByNumber.set(question.number, question);
              }
            }

            parsedQuestions = [...mergedByNumber.values()].sort(
              (left, right) => left.number - right.number,
            );
          }

          if (parsedQuestions.length < expectedCount) {
            const recoveredQuestions = recoverMissingQuestionsByNumber(
              questionPagesText,
              answerMap,
              parsedQuestions,
            );

            if (recoveredQuestions.length) {
              const mergedByNumber = new Map(
                parsedQuestions.map((question) => [question.number, question]),
              );
              for (const question of recoveredQuestions) {
                if (!mergedByNumber.has(question.number)) {
                  mergedByNumber.set(question.number, question);
                }
              }

              parsedQuestions = [...mergedByNumber.values()].sort(
                (left, right) => left.number - right.number,
              );
            }
          }
        }

        if (!parsedQuestions.length) {
          throw new Error(
            "No questions were parsed from the PDF. Please verify the question format.",
          );
        }

        if (!Object.keys(answerMap).length) {
          throw new Error(
            "No answer key was detected. Please upload a PDF that includes answer mappings like 1 A, 2 B, etc.",
          );
        }

        setQuestions(parsedQuestions);
        resetQuizProgress();
      } catch (error) {
        setQuestions([]);
        setLoadError(
          error instanceof Error ? error.message : "Failed to parse PDF.",
        );
      } finally {
        setIsLoading(false);
      }
    },
    [resetQuizProgress],
  );

  const handleReferenceLoad = useCallback(async () => {
    try {
      setLoadError("");
      const referencePdfPath = `${import.meta.env.BASE_URL}${REFERENCE_FILE_NAME}`;
      const response = await fetch(referencePdfPath);
      if (!response.ok) {
        throw new Error(
          `Reference PDF not found in public/${REFERENCE_FILE_NAME}.`,
        );
      }
      const blob = await response.blob();
      await loadQuizFromPdf(blob);
    } catch (error) {
      setLoadError(
        error instanceof Error
          ? error.message
          : "Could not load reference PDF.",
      );
    }
  }, [loadQuizFromPdf]);

  useEffect(() => {
    handleReferenceLoad();
  }, [handleReferenceLoad]);

  const handleOptionChange = (questionNumber, optionLabel) => {
    setSelectedAnswers((previous) => ({
      ...previous,
      [questionNumber]: optionLabel,
    }));
  };

  const handleModeChange = (mode) => {
    recordActiveQuestionTime();
    setReviewMode(mode);
    setIsTestCompleted(false);
  };

  const handleCompleteTest = () => {
    recordActiveQuestionTime();
    setCompletedElapsedSeconds(getTotalElapsedSeconds());
    setIsTestCompleted(true);
  };

  useEffect(() => {
    if (!currentQuestion || isTestCompleted) {
      activeQuestionRef.current = null;
      activeQuestionStartRef.current = null;
      return;
    }

    recordActiveQuestionTime();
    activeQuestionRef.current = currentQuestion.number;
    activeQuestionStartRef.current = Date.now();
    setTimerNow(Date.now());
  }, [currentQuestion, isTestCompleted]);

  useEffect(() => {
    if (!questions.length || isTestCompleted) {
      return undefined;
    }

    const intervalId = setInterval(() => {
      setTimerNow(Date.now());
    }, 1000);

    return () => clearInterval(intervalId);
  }, [questions.length, isTestCompleted]);

  useEffect(() => {
    return () => {
      recordActiveQuestionTime();
    };
  }, []);

  const currentQuestionTimeSpent = currentQuestion
    ? getQuestionTimeSpent(currentQuestion.number)
    : 0;
  const totalAllocatedSeconds = questions.length * QUESTION_TIME_LIMIT_SECONDS;
  const totalElapsedSeconds = isTestCompleted
    ? (completedElapsedSeconds ?? getTotalElapsedSeconds())
    : getTotalElapsedSeconds();
  const totalTimeLeftSeconds = Math.max(
    0,
    totalAllocatedSeconds - totalElapsedSeconds,
  );
  const showEndModeReviewPage = reviewMode === "end" && isTestCompleted;

  return (
    <div className="app-shell">
      <h1>PDF Quiz Application</h1>
      <p className="hint">
        English-only quiz extracted from {REFERENCE_FILE_NAME}
      </p>

      <section className="controls">
        <div className="controls-layout">
          <div className="controls-main">
            <div
              className="mode-switches"
              role="radiogroup"
              aria-label="Answer reveal mode"
            >
              <label className="mode-option">
                <input
                  type="radio"
                  name="review-mode"
                  value="immediate"
                  checked={reviewMode === "immediate"}
                  onChange={() => handleModeChange("immediate")}
                  disabled={isLoading || !questions.length}
                />
                Show answers immediately
              </label>
              <label className="mode-option">
                <input
                  type="radio"
                  name="review-mode"
                  value="end"
                  checked={reviewMode === "end"}
                  onChange={() => handleModeChange("end")}
                  disabled={isLoading || !questions.length}
                />
                Show answers at end of test
              </label>
            </div>

            <div className="buttons-row">
              <button
                type="button"
                onClick={handleReferenceLoad}
                disabled={isLoading}
              >
                {isLoading ? "Loading..." : "Reload Questions"}
              </button>
            </div>
          </div>

          <div className="controls-status">
            <div className="controls-timer">
              <p className="timer-label">Overall Test Timer</p>
              <p className="timer-line">
                Time left: {formatSeconds(totalTimeLeftSeconds)} /{" "}
                {formatSeconds(totalAllocatedSeconds)}
              </p>
            </div>

            <div className="controls-summary">
              <p className="timer-label">Progress</p>
              <p className="score-line timer-summary">
                Answered: {answeredCount} / {questions.length}
                {canRevealAnswers
                  ? ` • Correct: ${score} / ${questions.length}`
                  : ""}
              </p>
            </div>
          </div>
        </div>

        {loadError ? <p className="error-text">{loadError}</p> : null}
      </section>

      {currentQuestion ? (
        <section className="quiz-card">
          {showEndModeReviewPage ? (
            <div className="review-list">
              {questions.map((question, index) => {
                const selected = selectedAnswers[question.number] ?? null;
                const isCorrectSelection =
                  selected && selected === question.correct;

                return (
                  <article key={question.number} className="review-item">
                    <p className="question-index">
                      Question {index + 1} / {questions.length}
                    </p>
                    <h2>
                      {question.number}.{" "}
                      {cleanQuestionPromptText(
                        pickEnglishText(question.prompt),
                      )}
                    </h2>

                    <div className="options-list">
                      {question.options.map((option) => {
                        const isCorrectOption =
                          question.correct === option.label;
                        const isSelectedOption = selected === option.label;
                        const reviewClass = isCorrectOption
                          ? "correct"
                          : isSelectedOption
                            ? "incorrect"
                            : "";

                        return (
                          <label
                            key={option.label}
                            className={`option-item ${reviewClass}`.trim()}
                          >
                            <input
                              type="radio"
                              name={`review-question-${question.number}`}
                              checked={isSelectedOption}
                              disabled
                              readOnly
                            />
                            <span>{pickEnglishText(option.text)}</span>
                          </label>
                        );
                      })}
                    </div>

                    <p className="answer-meta">
                      Selected answer: {selected ?? "Not answered"} | Correct
                      answer: {question.correct ?? "N/A"} | Time taken:{" "}
                      {formatSeconds(getQuestionTimeSpent(question.number))}
                      {selected
                        ? isCorrectSelection
                          ? " (Correct)"
                          : " (Incorrect)"
                        : ""}
                    </p>
                  </article>
                );
              })}
            </div>
          ) : (
            <div className="quiz-layout">
              <div className="quiz-main">
                <p className="question-index">
                  Question {currentIndex + 1} / {questions.length}
                </p>
                <h2>
                  {currentQuestion.number}.{" "}
                  {cleanQuestionPromptText(
                    pickEnglishText(currentQuestion.prompt),
                  )}
                </h2>

                <div className="options-list">
                  {currentQuestion.options.map((option) => {
                    const isCorrect = currentQuestion.correct === option.label;
                    const isSelected =
                      selectedAnswers[currentQuestion.number] === option.label;
                    const reviewClass = canRevealCurrentQuestionAnswers
                      ? isCorrect
                        ? "correct"
                        : isSelected
                          ? "incorrect"
                          : ""
                      : "";

                    return (
                      <label
                        key={option.label}
                        className={`option-item ${reviewClass}`.trim()}
                      >
                        <input
                          type="radio"
                          name={`question-${currentQuestion.number}`}
                          checked={isSelected}
                          disabled={isTestCompleted}
                          onChange={() =>
                            handleOptionChange(
                              currentQuestion.number,
                              option.label,
                            )
                          }
                        />
                        <span>{pickEnglishText(option.text)}</span>
                      </label>
                    );
                  })}
                </div>

                {canRevealCurrentQuestionAnswers ? (
                  <p className="answer-meta">
                    Selected answer:{" "}
                    {selectedAnswers[currentQuestion.number] ?? "Not answered"}{" "}
                    | Correct answer: {currentQuestion.correct ?? "N/A"} | Time
                    taken:{" "}
                    {formatSeconds(
                      getQuestionTimeSpent(currentQuestion.number),
                    )}
                  </p>
                ) : null}

                {!canRevealCurrentQuestionAnswers ? (
                  <p className="hint">
                    Time spent on this question:{" "}
                    {formatSeconds(currentQuestionTimeSpent)}
                  </p>
                ) : null}

                <div className="buttons-row">
                  <button
                    type="button"
                    onClick={() =>
                      navigateToQuestion(Math.max(currentIndex - 1, 0))
                    }
                    disabled={currentIndex === 0}
                  >
                    Previous
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      navigateToQuestion(
                        Math.min(
                          currentIndex + 1,
                          Math.max(questions.length - 1, 0),
                        ),
                      )
                    }
                    disabled={currentIndex === questions.length - 1}
                  >
                    Next
                  </button>
                  {reviewMode === "end" ? (
                    <button type="button" onClick={handleCompleteTest}>
                      Complete Test
                    </button>
                  ) : null}
                </div>

                {totalTimeLeftSeconds <= 0 && !isTestCompleted ? (
                  <p className="hint">Overall test time is up.</p>
                ) : null}
              </div>

              <aside className="jump-sidebar">
                <p className="jump-title">Question Map</p>
                <div className="jump-grid">
                  {(showAllJumps
                    ? questions
                    : questions.slice(0, INITIAL_JUMP_VISIBLE)
                  ).map((question, visibleIndex) => {
                    const sourceIndex = visibleIndex;
                    const selected = selectedAnswers[question.number];
                    const isCurrent = sourceIndex === currentIndex;
                    const isCorrect = selected
                      ? selected === question.correct
                      : false;

                    const stateClass = !selected
                      ? ""
                      : canRevealAnswers
                        ? isCorrect
                          ? "is-correct"
                          : "is-incorrect"
                        : "is-answered";

                    return (
                      <button
                        key={question.number}
                        type="button"
                        className={`jump-btn ${isCurrent ? "is-current" : ""} ${stateClass}`.trim()}
                        onClick={() => navigateToQuestion(sourceIndex)}
                      >
                        {sourceIndex + 1}
                      </button>
                    );
                  })}
                </div>

                {questions.length > INITIAL_JUMP_VISIBLE ? (
                  <button
                    type="button"
                    className="view-more-btn"
                    onClick={() => setShowAllJumps((previous) => !previous)}
                  >
                    {showAllJumps ? "View less" : "View more"}
                  </button>
                ) : null}
              </aside>
            </div>
          )}
        </section>
      ) : (
        <p className="hint">
          {isLoading
            ? `Loading questions from ${REFERENCE_FILE_NAME}...`
            : `Preparing questions from ${REFERENCE_FILE_NAME}...`}
        </p>
      )}
    </div>
  );
}

export default App;

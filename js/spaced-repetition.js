/**
 * @module spaced-repetition
 * @description SM-2 spaced-repetition algorithm for the Wayground quiz app.
 *
 * Quality rating scale (0–5):
 *   0 = complete blackout / timeout
 *   1 = wrong answer
 *   2 = wrong but recognised answer after reveal
 *   3 = correct with difficulty (slow)
 *   4 = correct with reasonable recall
 *   5 = perfect — fast and correct
 *
 * Core SM-2 update rules:
 *   If quality >= 3 (correct):
 *     repetitions++
 *     interval = rep==1 ? 1 : rep==2 ? 6 : prev_interval * easeFactor
 *   Else (wrong):
 *     repetitions = 0, interval = 1
 *
 *   easeFactor = max(1.3, EF + (0.1 - (5 - q) * (0.08 + (5 - q) * 0.02)))
 *   nextReview  = Date.now() + interval days
 */

import { GameState } from './state.js';
import { hashQuestion, deepClone } from './utils.js';
import { saveSpacedRepData, loadSpacedRepData } from './storage.js';
import { showModal, switchScreen } from './ui.js';

/* ------------------------------------------------------------------ */
/*  Constants                                                         */
/* ------------------------------------------------------------------ */

/** Minimum ease factor allowed by the SM-2 algorithm. */
const MIN_EASE_FACTOR = 1.3;

/** Default ease factor for new cards. */
const DEFAULT_EASE_FACTOR = 2.5;

/** Milliseconds in one day. */
const MS_PER_DAY = 86_400_000;

/** Threshold ratios for quality calculation. */
const FAST_THRESHOLD = 0.7;
const MEDIUM_THRESHOLD = 0.3;

/* ------------------------------------------------------------------ */
/*  Public API                                                        */
/* ------------------------------------------------------------------ */

/**
 * Initialise the spaced-repetition subsystem by loading persisted
 * review data from storage into GameState.spacedRepData.
 */
export function initSpacedRepetition() {
  const stored = loadSpacedRepData();
  GameState.spacedRepData = stored && typeof stored === 'object' ? stored : {};
}

/**
 * Update a card's SM-2 review data after the player answers it.
 *
 * @param {object} question   - The question object.
 * @param {string} topicName  - Topic this card belongs to.
 * @param {number} quality    - SM-2 quality rating (0–5).
 */
export function updateCardReview(question, topicName, quality) {
  if (!question || typeof topicName !== 'string') return;

  const qHash = hashQuestion(question);
  if (!qHash) return;

  if (!GameState.spacedRepData) {
    GameState.spacedRepData = {};
  }

  const key = buildKey(topicName, qHash);
  const card = GameState.spacedRepData[key] || createDefaultCard(topicName);

  /* Clamp quality to 0–5 */
  const q = Math.max(0, Math.min(5, Math.round(quality)));

  /* Update ease factor first (applied regardless of correctness) */
  card.easeFactor = Math.max(
    MIN_EASE_FACTOR,
    card.easeFactor + (0.1 - (5 - q) * (0.08 + (5 - q) * 0.02))
  );

  if (q >= 3) {
    /* Correct answer */
    card.repetitions += 1;

    if (card.repetitions === 1) {
      card.interval = 1;
    } else if (card.repetitions === 2) {
      card.interval = 6;
    } else {
      card.interval = Math.round(card.interval * card.easeFactor);
    }
  } else {
    /* Wrong answer — reset */
    card.repetitions = 0;
    card.interval = 1;
  }

  card.nextReview = Date.now() + card.interval * MS_PER_DAY;
  card.lastReview = Date.now();
  card.totalReviews = (card.totalReviews || 0) + 1;

  GameState.spacedRepData[key] = card;
  saveSpacedRepData(GameState.spacedRepData);
}

/**
 * Return an array of question objects from a topic that are due for
 * review (nextReview <= now) or have never been reviewed.
 *
 * @param {string} topicName - Topic key in GameState.globalDatabase.
 * @returns {Array<object>} Due question objects (deep-cloned).
 */
export function getDueCards(topicName) {
  const topicQuestions = GameState.globalDatabase[topicName];
  if (!topicQuestions || topicQuestions.length === 0) return [];

  const now = Date.now();
  const dueCards = [];

  for (const q of topicQuestions) {
    const qHash = hashQuestion(q);
    const key = buildKey(topicName, qHash);
    const card = GameState.spacedRepData ? GameState.spacedRepData[key] : null;

    if (!card || card.nextReview <= now) {
      dueCards.push(deepClone(q));
    }
  }

  return dueCards;
}

/**
 * Return the count of cards due for review in a given topic.
 *
 * @param {string} topicName - Topic key in GameState.globalDatabase.
 * @returns {number} Number of due cards.
 */
export function getDueCardCount(topicName) {
  const topicQuestions = GameState.globalDatabase[topicName];
  if (!topicQuestions || topicQuestions.length === 0) return 0;

  const now = Date.now();
  let count = 0;

  for (const q of topicQuestions) {
    const qHash = hashQuestion(q);
    const key = buildKey(topicName, qHash);
    const card = GameState.spacedRepData ? GameState.spacedRepData[key] : null;

    if (!card || card.nextReview <= now) {
      count += 1;
    }
  }

  return count;
}

/**
 * Start a spaced-repetition practice session for a topic.
 * Only includes cards that are currently due for review.
 * If none are due, shows an informational modal instead.
 *
 * @param {string} topicName - Topic key in GameState.globalDatabase.
 */
export function startSpacedRepSession(topicName) {
  const dueCards = getDueCards(topicName);

  if (dueCards.length === 0) {
    showModal('Thông báo', 'Chưa có thẻ nào cần ôn lại! Hãy quay lại sau.');
    return;
  }

  /* Import dynamically-resolved to avoid circular deps at load time */
  import('./game.js').then(({ startSinglePractice }) => {
    /* Override the global database temporarily with due cards */
    const originalQuestions = GameState.globalDatabase[topicName];
    GameState.globalDatabase[topicName] = dueCards;

    /* Start a regular single practice with the due subset */
    startSinglePractice(topicName);

    /* Restore original questions so subsequent sessions see the full set */
    GameState.globalDatabase[topicName] = originalQuestions;
  }).catch((err) => {
    console.error('[SpacedRep] Failed to start session:', err);
    showModal('Lỗi', 'Không thể bắt đầu phiên ôn tập.');
  });
}

/**
 * Map an answer result to an SM-2 quality score (0–5).
 *
 * @param {boolean} isCorrect  - Whether the answer was correct.
 * @param {number}  timeLeftMs - Milliseconds remaining when answered.
 * @param {number}  totalTimeMs - Total time allowed (ms).
 * @returns {number} Quality score 0–5.
 */
export function calculateQuality(isCorrect, timeLeftMs, totalTimeMs) {
  /* Timeout (no answer given) */
  if (timeLeftMs <= 0 && !isCorrect) return 0;

  /* Wrong answer */
  if (!isCorrect) return 1;

  /* Correct answer — grade by speed */
  const safeTotal = totalTimeMs > 0 ? totalTimeMs : 1;
  const ratio = timeLeftMs / safeTotal;

  if (ratio >= FAST_THRESHOLD) return 5;   // fast
  if (ratio >= MEDIUM_THRESHOLD) return 4; // medium
  return 3;                                 // slow
}

/* ------------------------------------------------------------------ */
/*  Private helpers                                                   */
/* ------------------------------------------------------------------ */

/**
 * Build a storage key for a card's review data.
 *
 * @param {string} topicName - Topic name.
 * @param {string} qHash    - Question hash.
 * @returns {string}
 * @private
 */
function buildKey(topicName, qHash) {
  return `${topicName}::${qHash}`;
}

/**
 * Create a default SM-2 card record for a new card.
 *
 * @param {string} topicName - Associated topic name.
 * @returns {object} Default card data.
 * @private
 */
function createDefaultCard(topicName) {
  return {
    topic: topicName,
    repetitions: 0,
    interval: 1,
    easeFactor: DEFAULT_EASE_FACTOR,
    nextReview: 0,
    lastReview: 0,
    totalReviews: 0,
  };
}

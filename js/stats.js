/**
 * @module stats
 * @description Long-term statistics tracking for the Wayground quiz app.
 *
 * Persisted data structure:
 * ```
 * {
 *   totalQuestionsAnswered: number,
 *   totalCorrect: number,
 *   totalWrong: number,
 *   bestStreak: number,
 *   totalSessionsCompleted: number,
 *   dailyData: {
 *     '2026-06-30': { answered: 10, correct: 8, sessions: 2 },
 *     ...
 *   },
 *   topicData: {
 *     'Probability': { answered: 20, correct: 15, lastPlayed: '2026-06-30' },
 *     ...
 *   }
 * }
 * ```
 */

import { saveStats, loadStats } from './storage.js';

/* ------------------------------------------------------------------ */
/*  Constants                                                         */
/* ------------------------------------------------------------------ */

/** Day name abbreviations (Mon–Sun) used for weekly chart labels. */
const DAY_LABELS = ['CN', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7'];

/* ------------------------------------------------------------------ */
/*  Module-level reference                                            */
/* ------------------------------------------------------------------ */

/**
 * Cached stats object that mirrors what is in storage.
 * This avoids repeated JSON parse calls during a single session.
 * @type {object}
 */
let _stats = null;

/* ------------------------------------------------------------------ */
/*  Public API                                                        */
/* ------------------------------------------------------------------ */

/**
 * Initialise the stats subsystem by loading persisted data from
 * storage.  Returns the stats object for immediate use.
 *
 * @returns {object} The current stats data.
 */
export function initStats() {
  const stored = loadStats();
  _stats = isValidStats(stored) ? stored : createDefaultStats();
  return _stats;
}

/**
 * Record the result of a completed quiz session.
 *
 * @param {string} topicName - The topic that was played.
 * @param {number} correct   - Number of correct answers.
 * @param {number} wrong     - Number of wrong answers.
 * @param {number} streak    - Longest streak achieved this session.
 */
export function recordSessionResult(topicName, correct, wrong, streak) {
  ensureStatsLoaded();

  const answered = (correct || 0) + (wrong || 0);

  /* Global counters */
  _stats.totalQuestionsAnswered += answered;
  _stats.totalCorrect += correct || 0;
  _stats.totalWrong += wrong || 0;
  _stats.totalSessionsCompleted += 1;

  if ((streak || 0) > _stats.bestStreak) {
    _stats.bestStreak = streak;
  }

  /* Daily data */
  const today = getTodayKey();
  if (!_stats.dailyData[today]) {
    _stats.dailyData[today] = { answered: 0, correct: 0, sessions: 0 };
  }
  _stats.dailyData[today].answered += answered;
  _stats.dailyData[today].correct += correct || 0;
  _stats.dailyData[today].sessions += 1;

  /* Topic data */
  if (topicName) {
    if (!_stats.topicData[topicName]) {
      _stats.topicData[topicName] = { answered: 0, correct: 0, lastPlayed: '' };
    }
    _stats.topicData[topicName].answered += answered;
    _stats.topicData[topicName].correct += correct || 0;
    _stats.topicData[topicName].lastPlayed = today;
  }

  /* Persist */
  saveStats(_stats);
}

/**
 * Return the last 7 days of daily data for rendering a bar chart.
 *
 * @returns {Array<{day: string, date: string, answered: number, correct: number}>}
 *   Sorted oldest → newest.
 */
export function getWeeklyChartData() {
  ensureStatsLoaded();

  const result = [];
  const now = new Date();

  for (let i = 6; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    const key = formatDateKey(d);
    const dayLabel = DAY_LABELS[d.getDay()];

    const entry = _stats.dailyData[key] || { answered: 0, correct: 0 };
    result.push({
      day: dayLabel,
      date: key,
      answered: entry.answered,
      correct: entry.correct,
    });
  }

  return result;
}

/**
 * Return the weakest topics ranked by accuracy (ascending).
 *
 * @param {number} [limit=3] - Maximum number of topics to return.
 * @returns {Array<{topic: string, accuracy: number, answered: number}>}
 */
export function getWeakestTopics(limit = 3) {
  ensureStatsLoaded();

  const topics = Object.entries(_stats.topicData)
    .filter(([, data]) => data.answered > 0)
    .map(([topic, data]) => ({
      topic,
      accuracy: Math.round((data.correct / data.answered) * 100),
      answered: data.answered,
    }))
    .sort((a, b) => a.accuracy - b.accuracy);

  return topics.slice(0, Math.max(1, limit));
}

/**
 * Return a high-level overview of the player's statistics.
 *
 * @returns {{
 *   totalQuestions: number,
 *   overallAccuracy: number,
 *   bestStreak: number,
 *   sessionsCompleted: number
 * }}
 */
export function getOverviewStats() {
  ensureStatsLoaded();

  const accuracy =
    _stats.totalQuestionsAnswered > 0
      ? Math.round((_stats.totalCorrect / _stats.totalQuestionsAnswered) * 100)
      : 0;

  return {
    totalQuestions: _stats.totalQuestionsAnswered,
    overallAccuracy: accuracy,
    bestStreak: _stats.bestStreak,
    sessionsCompleted: _stats.totalSessionsCompleted,
  };
}

/* ------------------------------------------------------------------ */
/*  Private helpers                                                   */
/* ------------------------------------------------------------------ */

/**
 * Make sure _stats is populated (lazy-load if needed).
 * @private
 */
function ensureStatsLoaded() {
  if (!_stats) {
    initStats();
  }
}

/**
 * Create a blank stats structure.
 * @returns {object}
 * @private
 */
function createDefaultStats() {
  return {
    totalQuestionsAnswered: 0,
    totalCorrect: 0,
    totalWrong: 0,
    bestStreak: 0,
    totalSessionsCompleted: 0,
    dailyData: {},
    topicData: {},
  };
}

/**
 * Validate that a stored value looks like a valid stats object.
 *
 * @param {*} obj - Value loaded from storage.
 * @returns {boolean}
 * @private
 */
function isValidStats(obj) {
  return (
    obj != null &&
    typeof obj === 'object' &&
    typeof obj.totalQuestionsAnswered === 'number' &&
    typeof obj.dailyData === 'object' &&
    typeof obj.topicData === 'object'
  );
}

/**
 * Get today's date key in YYYY-MM-DD format.
 * @returns {string}
 * @private
 */
function getTodayKey() {
  return formatDateKey(new Date());
}

/**
 * Format a Date object as a YYYY-MM-DD string.
 *
 * @param {Date} date
 * @returns {string}
 * @private
 */
function formatDateKey(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

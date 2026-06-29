/**
 * @module game
 * @description Single practice, exam mode, and mistake review game logic
 * for the Wayground quiz application. Manages round flow, scoring,
 * timer mechanics, and result computation.
 */

import { GameState, resetRoundState } from './state.js';
import {
  escapeHtml,
  shuffleArray,
  deepClone,
  hashQuestion,
  createElement,
  setTextContent,
} from './utils.js';
import { ensureAudioContext, playSound } from './audio.js';
import { saveLogs, loadLogs, saveSpacedRepData } from './storage.js';
import {
  $,
  switchScreen,
  showModal,
  hideModal,
  updateTimerBar,
  resetAnswerOptions,
  showCorrectAnswer,
  showMemeFeedback,
  hideMemeFeedback,
  renderMistakeReview,
  renderLeaderboard,
} from './ui.js';
import { updateCardReview, calculateQuality } from './spaced-repetition.js';
import { recordSessionResult } from './stats.js';

/* ------------------------------------------------------------------ */
/*  Constants                                                         */
/* ------------------------------------------------------------------ */

/** Base score awarded for a correct answer. */
const BASE_SCORE = 600;

/** Maximum speed bonus added on top of base score. */
const MAX_SPEED_BONUS = 400;

/** Bonus score per consecutive streak. */
const STREAK_BONUS = 50;

/** Delay (ms) before auto-advancing to the next round after answering. */
const ADVANCE_DELAY_MS = 600;

/** Delay (ms) before auto-advancing after a timeout. */
const TIMEOUT_ADVANCE_DELAY_MS = 800;

/** Number of seconds at which the tick sound starts playing. */
const TICK_SOUND_THRESHOLD_SEC = 3;

/** Maximum number of recent activity log entries to keep. */
const MAX_LOG_ENTRIES = 10;

/* ------------------------------------------------------------------ */
/*  Public API                                                        */
/* ------------------------------------------------------------------ */

/**
 * Start a single practice session for a given topic.
 * Loads questions from the global database, optionally shuffles them,
 * resets round state, and begins the first round.
 *
 * @param {string} topicName - The topic key in GameState.globalDatabase.
 */
export function startSinglePractice(topicName) {
  const topicQuestions = GameState.globalDatabase[topicName];
  if (!topicQuestions || topicQuestions.length === 0) {
    showModal('Lỗi', 'Không tìm thấy câu hỏi cho chủ đề này.');
    return;
  }

  GameState.gameMode = 'single';
  GameState.activeTopicPlayingName = topicName;

  const cloned = deepClone(topicQuestions);
  const shouldShuffle = getShufflePreference();

  if (shouldShuffle) {
    shuffleArray(cloned);
    cloned.forEach(shuffleQuestionOptions);
  }

  GameState.questions = cloned;
  resetRoundState();
  switchScreen(null, 'game-screen');
  executeNewRound(0);
}

/**
 * Start an exam session limited to N questions from a topic.
 *
 * @param {string} topicName    - The topic key in GameState.globalDatabase.
 * @param {number} questionLimit - Maximum number of questions for the exam.
 */
export function startExamMode(topicName, questionLimit) {
  const topicQuestions = GameState.globalDatabase[topicName];
  if (!topicQuestions || topicQuestions.length === 0) {
    showModal('Lỗi', 'Không tìm thấy câu hỏi cho chủ đề này.');
    return;
  }

  GameState.gameMode = 'exam';
  GameState.activeTopicPlayingName = topicName;

  const cloned = deepClone(topicQuestions);
  shuffleArray(cloned);
  cloned.forEach(shuffleQuestionOptions);

  const limit = Math.min(
    Math.max(1, Math.floor(questionLimit) || cloned.length),
    cloned.length
  );
  GameState.questions = cloned.slice(0, limit);
  GameState.examQuestionLimit = limit;

  resetRoundState();
  switchScreen(null, 'game-screen');
  executeNewRound(0);
}

/**
 * Start a review session using only previously-wrong questions.
 * If there are no mistakes to review, a modal is shown instead.
 */
export function startMistakeReview() {
  if (!GameState.wrongQuestionsLog || GameState.wrongQuestionsLog.length === 0) {
    showModal('Thông báo', 'Không có câu sai nào để ôn lại!');
    return;
  }

  GameState.gameMode = 'single';
  GameState.activeTopicPlayingName = 'Ôn lại câu sai';

  const cloned = deepClone(GameState.wrongQuestionsLog);
  shuffleArray(cloned);

  GameState.questions = cloned;
  resetRoundState();
  switchScreen(null, 'game-screen');
  executeNewRound(0);
}

/**
 * Execute (display) a new round at the given question index.
 * Resets answer state, renders the question, and starts the timer.
 *
 * @param {number} idx - Zero-based question index.
 */
export function executeNewRound(idx) {
  if (idx < 0 || idx >= GameState.questions.length) {
    showResults();
    return;
  }

  GameState.currentIdx = idx;
  GameState.canAnswer = true;
  GameState.currentElapsedMs = 0;

  hideMemeFeedback();
  hidePauseOverlay();

  const q = GameState.questions[idx];
  if (!q) {
    showResults();
    return;
  }

  /* Update question counter */
  const counterEl = $('question-counter');
  if (counterEl) {
    setTextContent(
      counterEl,
      `${idx + 1} / ${GameState.questions.length}`
    );
  }

  /* Update question text */
  const questionTextEl = $('question-text');
  if (questionTextEl) {
    setTextContent(questionTextEl, q.question);
  }

  /* Render answer options */
  resetAnswerOptions(q.options);

  /* Start timer */
  runSingleTimer();

  ensureAudioContext();
}

/**
 * Handle the player clicking an answer option.
 *
 * @param {number} chosenIdx - Zero-based index of the chosen option.
 */
export function handleOptionClick(chosenIdx) {
  if (!GameState.canAnswer || GameState.isPaused) return;

  GameState.canAnswer = false;
  stopTimer();

  const q = GameState.questions[GameState.currentIdx];
  if (!q) return;

  const isCorrect = chosenIdx === q.correct;
  const timeLimitMs = GameState.TIME_LIMIT_PER_QUESTION_SEC * 1000;
  const timeLeftMs = Math.max(0, timeLimitMs - GameState.currentElapsedMs);

  if (isCorrect) {
    /* Scoring: base + speed bonus + streak bonus */
    const speedRatio = timeLeftMs / timeLimitMs;
    const speedBonus = Math.round(MAX_SPEED_BONUS * speedRatio);
    const streakBonus = GameState.currentStreak * STREAK_BONUS;
    const roundScore = BASE_SCORE + speedBonus + streakBonus;

    GameState.playerScore += roundScore;
    GameState.currentStreak += 1;
    GameState.correctAnswersCount += 1;
    GameState.totalCoins = (GameState.totalCoins || 0) + Math.round(roundScore / 100);

    playSound('correct');
  } else {
    GameState.currentStreak = 0;
    GameState.wrongAnswersCount += 1;

    logWrongQuestion(q);
    playSound('wrong');
  }

  /* Visual feedback */
  showCorrectAnswer(q.correct, chosenIdx);
  showMemeFeedback(isCorrect);

  /* Update score display */
  const scoreEl = $('player-score');
  if (scoreEl) {
    setTextContent(scoreEl, String(GameState.playerScore));
  }
  const streakEl = $('current-streak');
  if (streakEl) {
    setTextContent(streakEl, String(GameState.currentStreak));
  }

  /* Spaced-repetition quality update */
  const quality = calculateQuality(isCorrect, timeLeftMs, timeLimitMs);
  updateCardReview(q, GameState.activeTopicPlayingName, quality);

  /* Auto-advance for single / exam modes */
  if (GameState.gameMode === 'single' || GameState.gameMode === 'exam') {
    setTimeout(() => jumpToNextRound(), ADVANCE_DELAY_MS);
  }
}

/**
 * Toggle the pause state. Only works in single or exam mode.
 */
export function togglePause() {
  if (GameState.gameMode !== 'single' && GameState.gameMode !== 'exam') return;

  GameState.isPaused = !GameState.isPaused;

  if (GameState.isPaused) {
    stopTimer();
    showPauseOverlay();
    playSound('pause');
  } else {
    hidePauseOverlay();
    runSingleTimer();
  }
}

/**
 * Handle the case when the question timer expires.
 * Marks the question as wrong and auto-advances.
 */
export function handleTimeout() {
  if (!GameState.canAnswer) return;

  GameState.canAnswer = false;
  stopTimer();

  const q = GameState.questions[GameState.currentIdx];
  if (q) {
    GameState.wrongAnswersCount += 1;
    GameState.currentStreak = 0;

    logWrongQuestion(q);
    showCorrectAnswer(q.correct, -1);

    /* Spaced-repetition: quality 0 for timeout */
    updateCardReview(q, GameState.activeTopicPlayingName, 0);
  }

  showMemeFeedback(false);
  playSound('timeout');

  setTimeout(() => jumpToNextRound(), TIMEOUT_ADVANCE_DELAY_MS);
}

/**
 * Advance to the next round or show results if all questions are done.
 */
export function jumpToNextRound() {
  hideMemeFeedback();

  const nextIdx = GameState.currentIdx + 1;
  if (nextIdx >= GameState.questions.length) {
    showResults();
  } else {
    executeNewRound(nextIdx);
  }
}

/**
 * Calculate and display the final results screen.
 * Persists session data to recent logs and long-term stats.
 */
export function showResults() {
  stopTimer();

  const totalQuestions = GameState.questions.length;
  const correct = GameState.correctAnswersCount;
  const wrong = GameState.wrongAnswersCount;
  const accuracy =
    totalQuestions > 0 ? Math.round((correct / totalQuestions) * 100) : 0;

  /* Update result screen elements */
  const resultScoreEl = $('result-score');
  if (resultScoreEl) setTextContent(resultScoreEl, String(GameState.playerScore));

  const resultCorrectEl = $('result-correct');
  if (resultCorrectEl) setTextContent(resultCorrectEl, String(correct));

  const resultWrongEl = $('result-wrong');
  if (resultWrongEl) setTextContent(resultWrongEl, String(wrong));

  const resultAccuracyEl = $('result-accuracy');
  if (resultAccuracyEl) setTextContent(resultAccuracyEl, `${accuracy}%`);

  const resultTotalEl = $('result-total');
  if (resultTotalEl) setTextContent(resultTotalEl, String(totalQuestions));

  const resultStreakEl = $('result-streak');
  if (resultStreakEl) setTextContent(resultStreakEl, String(GameState.currentStreak));

  /* Render mistake review list */
  renderMistakeReview(GameState.wrongQuestionsLog);

  /* Persist to recent logs (keep last MAX_LOG_ENTRIES) */
  const logs = loadLogs() || [];
  logs.unshift({
    topic: GameState.activeTopicPlayingName || 'Unknown',
    mode: GameState.gameMode || 'single',
    score: GameState.playerScore,
    correct,
    wrong,
    total: totalQuestions,
    accuracy,
    date: new Date().toISOString(),
  });

  if (logs.length > MAX_LOG_ENTRIES) {
    logs.length = MAX_LOG_ENTRIES;
  }
  saveLogs(logs);

  /* Record to long-term stats */
  recordSessionResult(
    GameState.activeTopicPlayingName,
    correct,
    wrong,
    GameState.currentStreak
  );

  /* Switch to result screen */
  switchScreen(null, 'result-screen');
  playSound('result');
}

/* ------------------------------------------------------------------ */
/*  Timer internals                                                   */
/* ------------------------------------------------------------------ */

/**
 * Start the single-player timer using requestAnimationFrame for
 * smooth bar animation and setInterval for second-precision logic.
 * @private
 */
function runSingleTimer() {
  stopTimer();

  const timeLimitMs = GameState.TIME_LIMIT_PER_QUESTION_SEC * 1000;
  let startTimestamp = performance.now();
  let lastTickSecond = -1;

  /* Interval for second-precision logic (tick sounds) */
  GameState.timerInterval = setInterval(() => {
    if (GameState.isPaused) return;

    const elapsedSec = Math.floor(GameState.currentElapsedMs / 1000);
    const remainingSec = GameState.TIME_LIMIT_PER_QUESTION_SEC - elapsedSec;

    /* Play tick sound in last few seconds */
    if (
      remainingSec > 0 &&
      remainingSec <= TICK_SOUND_THRESHOLD_SEC &&
      remainingSec !== lastTickSecond
    ) {
      lastTickSecond = remainingSec;
      playSound('tick');
    }
  }, 1000);

  /* requestAnimationFrame for smooth visual bar updates */
  function animateTimer(now) {
    if (GameState.isPaused) {
      startTimestamp = now - GameState.currentElapsedMs;
      GameState.timerAnimationFrame = requestAnimationFrame(animateTimer);
      return;
    }

    GameState.currentElapsedMs = now - startTimestamp;

    if (GameState.currentElapsedMs >= timeLimitMs) {
      GameState.currentElapsedMs = timeLimitMs;
      updateTimerBar(0);
      stopTimer();
      handleTimeout();
      return;
    }

    const progress = 1 - GameState.currentElapsedMs / timeLimitMs;
    updateTimerBar(progress);

    GameState.timerAnimationFrame = requestAnimationFrame(animateTimer);
  }

  GameState.timerAnimationFrame = requestAnimationFrame(animateTimer);
}

/**
 * Stop all active timers (interval and animation frame).
 * @private
 */
function stopTimer() {
  if (GameState.timerInterval != null) {
    clearInterval(GameState.timerInterval);
    GameState.timerInterval = null;
  }
  if (GameState.timerAnimationFrame != null) {
    cancelAnimationFrame(GameState.timerAnimationFrame);
    GameState.timerAnimationFrame = null;
  }
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                           */
/* ------------------------------------------------------------------ */

/**
 * Read the shuffle preference from the UI toggle.
 * @returns {boolean}
 * @private
 */
function getShufflePreference() {
  const toggle = $('shuffle-toggle');
  return toggle ? toggle.checked : true;
}

/**
 * Shuffle the options array of a question while keeping
 * the `correct` index pointing to the right answer.
 *
 * @param {object} question - Question object with `options` and `correct`.
 * @private
 */
function shuffleQuestionOptions(question) {
  if (!question || !Array.isArray(question.options)) return;

  const correctText = question.options[question.correct];
  shuffleArray(question.options);
  question.correct = question.options.indexOf(correctText);
}

/**
 * Log a wrong question to GameState.wrongQuestionsLog,
 * avoiding duplicates by question hash.
 *
 * @param {object} question - The question that was answered incorrectly.
 * @private
 */
function logWrongQuestion(question) {
  if (!question) return;

  if (!GameState.wrongQuestionsLog) {
    GameState.wrongQuestionsLog = [];
  }

  const hash = hashQuestion(question);
  const alreadyLogged = GameState.wrongQuestionsLog.some(
    (q) => hashQuestion(q) === hash
  );

  if (!alreadyLogged) {
    GameState.wrongQuestionsLog.push(deepClone(question));
  }
}

/**
 * Show the pause overlay element.
 * @private
 */
function showPauseOverlay() {
  const overlay = $('pause-overlay');
  if (overlay) overlay.classList.remove('hidden');
}

/**
 * Hide the pause overlay element.
 * @private
 */
function hidePauseOverlay() {
  const overlay = $('pause-overlay');
  if (overlay) overlay.classList.add('hidden');
}

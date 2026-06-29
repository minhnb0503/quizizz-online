/**
 * @module state
 * @description Centralized state management for Wayground quiz application.
 * Replaces all global variables with a single observable state object.
 * All modules import GameState from here — no globals needed.
 */

// ─── Default Values (used by reset functions) ──────────────────────────────

/** @type {string} Default player display name */
const DEFAULT_NAME = 'Người_Ôn_Tập';

/** @type {number} Default per-question time limit in seconds */
const DEFAULT_TIME_LIMIT_SEC = 15;

/** @type {number} Default answer reveal window in seconds */
const DEFAULT_ANSWER_WINDOW_SEC = 4;

/** @type {number} Default starting coins for new users */
const DEFAULT_STARTING_COINS = 500;

/** @type {number} Default exam mode question limit */
const DEFAULT_EXAM_LIMIT = 20;


// ─── State Object ──────────────────────────────────────────────────────────

/**
 * Central application state. Every module reads/writes this single object.
 *
 * Organized into logical groups:
 *   - Game mode & control flags
 *   - Player identity & scoring
 *   - Question data & navigation
 *   - Multiplayer / MQTT
 *   - Audio subsystem
 *   - Timer references
 *   - Configuration / settings
 *   - Spaced repetition data
 *   - Exam mode
 *   - Economy (coins)
 *
 * @type {Object}
 */
export const GameState = {
  // ── Game Mode & Control ────────────────────────────────────────────────
  /** @type {'single'|'multi'|'flashcard'|'exam'} Current game mode */
  gameMode: 'single',
  /** @type {boolean} Whether this client is the multiplayer host */
  isHost: false,
  /** @type {boolean} Whether the game is currently paused */
  isPaused: false,
  /** @type {boolean} Whether the player is allowed to submit an answer right now */
  canAnswer: false,
  /** @type {boolean} Whether the flashcard is showing its back face */
  isFlashcardFlipped: false,

  // ── Player ─────────────────────────────────────────────────────────────
  /** @type {string} Display name of the local player */
  myName: DEFAULT_NAME,
  /** @type {number} Accumulated score for the current round */
  playerScore: 0,
  /** @type {number} Current consecutive-correct-answer streak */
  currentStreak: 0,
  /** @type {number} Total correct answers in the current round */
  correctAnswersCount: 0,
  /** @type {number} Total wrong answers in the current round */
  wrongAnswersCount: 0,

  // ── Questions ──────────────────────────────────────────────────────────
  /**
   * Full question database keyed by topic name.
   * @type {Object<string, Array<{question: string, options: string[], correct: number, explanation?: string}>>}
   */
  globalDatabase: {},
  /**
   * Questions for the current active round (shuffled subset).
   * @type {Array<{question: string, options: string[], correct: number, explanation?: string}>}
   */
  questions: [],
  /** @type {number} Index of the current question within `questions` */
  currentIdx: 0,
  /** @type {string} Name/key of the topic currently being played */
  activeTopicPlayingName: '',
  /**
   * Log of incorrectly-answered questions in this round.
   * @type {Array<{question: string, options: string[], correct: number, chosen: number, explanation?: string}>}
   */
  wrongQuestionsLog: [],

  // ── Multiplayer ────────────────────────────────────────────────────────
  /** @type {string} Current room code (6-digit string) */
  roomCode: '',
  /**
   * Connected players in a multiplayer session.
   * @type {Object<string, {score: number}>}
   */
  networkPlayers: {},
  /** @type {object|null} Active MQTT client instance */
  mqttClient: null,

  // ── Audio ──────────────────────────────────────────────────────────────
  /** @type {boolean} Whether all sound effects are muted */
  audioMuted: false,
  /** @type {AudioContext|null} Web Audio API context */
  audioCtx: null,

  // ── Timer ──────────────────────────────────────────────────────────────
  /** @type {number} Elapsed milliseconds for the current question timer */
  currentElapsedMs: 0,
  /** @type {number|null} setInterval ID for the main question timer */
  timerInterval: null,
  /** @type {number|null} setInterval ID for the host-broadcast timer */
  hostTimerInterval: null,
  /** @type {number|null} requestAnimationFrame ID for smooth timer-bar updates */
  timerAnimationFrame: null,

  // ── Settings ───────────────────────────────────────────────────────────
  /** @type {number} Seconds allowed per question */
  TIME_LIMIT_PER_QUESTION_SEC: DEFAULT_TIME_LIMIT_SEC,
  /** @type {number} Seconds the correct answer is shown after answering */
  SHOW_ANSWER_WINDOW_SEC: DEFAULT_ANSWER_WINDOW_SEC,

  // ── Spaced Repetition ──────────────────────────────────────────────────
  /**
   * Spaced repetition metadata keyed by `topic::questionHash`.
   * @type {Object<string, {interval: number, easeFactor: number, repetitions: number, nextReview: number}>}
   */
  spacedRepData: {},

  // ── Exam Mode ──────────────────────────────────────────────────────────
  /** @type {number} Maximum questions in an exam session */
  examQuestionLimit: DEFAULT_EXAM_LIMIT,

  // ── Economy ────────────────────────────────────────────────────────────
  /** @type {number} Virtual currency balance */
  totalCoins: DEFAULT_STARTING_COINS
};


// ─── Reset Helpers ─────────────────────────────────────────────────────────

/**
 * Reset only the per-round transient state.
 * Call this between rounds or when starting a new game within the same session.
 * Preserves: database, settings, name, coins, spaced rep data, MQTT connection.
 */
export function resetRoundState() {
  GameState.playerScore = 0;
  GameState.currentStreak = 0;
  GameState.correctAnswersCount = 0;
  GameState.wrongAnswersCount = 0;

  GameState.questions = [];
  GameState.currentIdx = 0;
  GameState.activeTopicPlayingName = '';
  GameState.wrongQuestionsLog = [];

  GameState.canAnswer = false;
  GameState.isPaused = false;
  GameState.isFlashcardFlipped = false;

  GameState.currentElapsedMs = 0;

  // Clear any running timers to prevent leaks
  if (GameState.timerInterval !== null) {
    clearInterval(GameState.timerInterval);
    GameState.timerInterval = null;
  }
  if (GameState.hostTimerInterval !== null) {
    clearInterval(GameState.hostTimerInterval);
    GameState.hostTimerInterval = null;
  }
  if (GameState.timerAnimationFrame !== null) {
    cancelAnimationFrame(GameState.timerAnimationFrame);
    GameState.timerAnimationFrame = null;
  }
}

/**
 * Full state reset — returns everything to factory defaults.
 * Use when the user explicitly wants to start completely fresh,
 * or during development/testing teardown.
 *
 * Note: This does NOT clear localStorage. Use storage.js functions for that.
 */
export function resetAllState() {
  // Round state first (also clears timers)
  resetRoundState();

  // Game mode
  GameState.gameMode = 'single';
  GameState.isHost = false;

  // Player identity
  GameState.myName = DEFAULT_NAME;

  // Database
  GameState.globalDatabase = {};

  // Multiplayer
  GameState.roomCode = '';
  GameState.networkPlayers = {};
  if (GameState.mqttClient !== null) {
    try {
      GameState.mqttClient.end(true);
    } catch (_) {
      // Swallow — client may already be disconnected
    }
    GameState.mqttClient = null;
  }

  // Audio — close existing context to free hardware
  if (GameState.audioCtx !== null) {
    try {
      GameState.audioCtx.close();
    } catch (_) {
      // Swallow
    }
    GameState.audioCtx = null;
  }
  GameState.audioMuted = false;

  // Settings
  GameState.TIME_LIMIT_PER_QUESTION_SEC = DEFAULT_TIME_LIMIT_SEC;
  GameState.SHOW_ANSWER_WINDOW_SEC = DEFAULT_ANSWER_WINDOW_SEC;

  // Spaced rep
  GameState.spacedRepData = {};

  // Exam
  GameState.examQuestionLimit = DEFAULT_EXAM_LIMIT;

  // Economy
  GameState.totalCoins = DEFAULT_STARTING_COINS;
}

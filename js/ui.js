/**
 * @module ui
 * @description DOM manipulation and rendering helpers for Wayground.
 *
 * Design rules:
 *   1. User-generated content is ALWAYS set via `textContent` — never `innerHTML`.
 *   2. Structural HTML that contains no user data may use `innerHTML` with escapeHtml().
 *   3. Animations are driven by CSS classes, not inline styles.
 *   4. DOM references are cached where practical.
 */

import { escapeHtml, createElement, setTextContent } from './utils.js';


// ─── DOM Cache ─────────────────────────────────────────────────────────────

/**
 * Cached DOM element references. Populated lazily on first access.
 * @type {Map<string, HTMLElement>}
 */
const _cache = new Map();

/**
 * Get a DOM element by its `id` attribute. Results are cached.
 *
 * @param {string} id — Element ID (without `#`).
 * @returns {HTMLElement|null}
 */
export function $(id) {
  if (_cache.has(id)) return _cache.get(id);
  const el = document.getElementById(id);
  if (el) _cache.set(id, el);
  return el;
}

/**
 * Invalidate the entire DOM cache.
 * Call after large-scale DOM mutations if IDs have been added/removed.
 */
export function clearCache() {
  _cache.clear();
}


// ─── Screen Management ────────────────────────────────────────────────────

/** CSS class applied to visible screens */
const SCREEN_ACTIVE_CLASS = 'active';
/** CSS class applied during screen entry animation */
const SCREEN_ENTER_CLASS = 'screen-enter';

/**
 * List of all screen IDs
 */
const ALL_SCREENS = [
  'dashboard-screen',
  'setup-screen',
  'lobby-screen',
  'game-screen',
  'flashcard-screen',
  'result-screen'
];

/**
 * Transition from one screen to another.
 *
 * @param {string} oldId
 * @param {string} newId
 */
export function switchScreen(oldId, newId) {
  const oldEl = oldId ? $(oldId) : null;
  const newEl = newId ? $(newId) : null;

  if (oldEl) {
    oldEl.classList.add('hidden');
  }

  if (newEl) {
    newEl.classList.remove('hidden');
    newEl.classList.remove(SCREEN_ENTER_CLASS);
    void newEl.offsetWidth;
    newEl.classList.add(SCREEN_ENTER_CLASS);
  }
}

/**
 * Hide every screen element.
 */
export function hideAllScreens() {
  ALL_SCREENS.forEach(id => {
    const el = $(id);
    if (el) el.classList.add('hidden');
  });
}

/**
 * Show a specific screen by ID.
 *
 * @param {string} id
 */
export function showScreen(id) {
  const el = $(id);
  if (!el) return;
  el.classList.remove('hidden');
  el.classList.remove(SCREEN_ENTER_CLASS);
  void el.offsetWidth;
  el.classList.add(SCREEN_ENTER_CLASS);
}


// ─── Custom Modal ──────────────────────────────────────────────────────────

/** @type {Function|null} Resolve function for the current modal promise */
let _modalResolve = null;
/** @type {Function|null} onClose callback for the current modal */
let _modalOnClose = null;

/**
 * Display a custom modal dialog (replaces `alert()` / `confirm()`).
 *
 * @param {Object} opts
 * @param {string} [opts.emoji='']        — Decorative emoji displayed above the title.
 * @param {string} [opts.title='']        — Modal title text.
 * @param {string} [opts.message='']      — Modal body message.
 * @param {Array<{text: string, className?: string, onClick?: Function}>} [opts.buttons]
 *   Button definitions. If omitted a single "OK" button is shown.
 * @param {Function} [opts.onClose]       — Called when the modal is dismissed (any button).
 * @returns {Promise<number>} Resolves with the zero-based index of the button clicked.
 *
 * @example
 * const choice = await showModal({
 *   emoji: '🎉',
 *   title: 'Round Complete!',
 *   message: 'You scored 800 points.',
 *   buttons: [
 *     { text: 'Review Mistakes', className: 'btn-secondary' },
 *     { text: 'Continue', className: 'btn-primary' }
 *   ]
 * });
 */
export function showModal({ emoji = '', title = '', message = '', buttons, onClose } = {}) {
  const modal = $('custom-modal');
  if (!modal) {
    console.warn('[ui] #custom-modal element not found in DOM.');
    return Promise.resolve(-1);
  }

  // Resolve any previously open modal
  if (_modalResolve) {
    _modalResolve(-1);
    _modalResolve = null;
  }

  // Build content
  const emojiEl = modal.querySelector('.modal-emoji') || modal.querySelector('#modal-emoji');
  const titleEl = modal.querySelector('.modal-title') || modal.querySelector('#modal-title');
  const messageEl = modal.querySelector('.modal-message') || modal.querySelector('#modal-message');
  const buttonsContainer = modal.querySelector('.modal-actions') || modal.querySelector('#modal-actions');

  if (emojiEl) emojiEl.textContent = emoji;
  if (titleEl) titleEl.textContent = title;
  if (messageEl) messageEl.textContent = message;

  // Build buttons
  const btnDefs = Array.isArray(buttons) && buttons.length > 0
    ? buttons
    : [{ text: 'OK', className: 'btn-primary' }];

  if (buttonsContainer) {
    buttonsContainer.innerHTML = ''; // safe — we're clearing, not inserting user data
    btnDefs.forEach((def, idx) => {
      const btn = createElement('button', def.className || 'btn-primary');
      btn.textContent = def.text;
      btn.addEventListener('click', () => {
        if (typeof def.onClick === 'function') def.onClick();
        _dismissModal(idx);
      });
      buttonsContainer.appendChild(btn);
    });
  }

  _modalOnClose = typeof onClose === 'function' ? onClose : null;

  // Show
  modal.classList.remove('hidden');

  return new Promise((resolve) => {
    _modalResolve = resolve;
  });
}

/**
 * Hide the custom modal.
 */
export function hideModal() {
  const modal = $('custom-modal');
  if (modal) {
    modal.classList.add('hidden');
  }
  if (_modalResolve) {
    _modalResolve(-1);
    _modalResolve = null;
  }
}

/**
 * Internal: dismiss modal and fire callbacks.
 * @param {number} buttonIndex
 */
function _dismissModal(buttonIndex) {
  const modal = $('custom-modal');
  if (modal) modal.classList.add('hidden');

  if (_modalResolve) {
    _modalResolve(buttonIndex);
    _modalResolve = null;
  }
  if (_modalOnClose) {
    _modalOnClose();
    _modalOnClose = null;
  }
}


// ─── Timer Bar ─────────────────────────────────────────────────────────────

/**
 * Update the visual width of the timer progress bar.
 *
 * @param {number} percentage — Value from 0 (empty) to 100 (full).
 */
export function updateTimerBar(percentage) {
  const bar = $('timer-bar');
  if (!bar) return;

  const clamped = Math.max(0, Math.min(100, percentage));
  bar.style.width = `${clamped}%`;

  // Apply urgency classes for visual feedback
  bar.classList.toggle('timer-warning', clamped <= 40 && clamped > 15);
  bar.classList.toggle('timer-critical', clamped <= 15);
}


// ─── Leaderboard ───────────────────────────────────────────────────────────

/**
 * Render a sorted leaderboard of players.
 *
 * @param {Object<string, {score: number}>} players — Player map from GameState.
 * @param {string} myName — Local player's name (highlighted in the list).
 */
export function renderLeaderboard(players, myName) {
  const container = $('leaderboard-container');
  if (!container) return;
  container.innerHTML = '';

  // Sort descending by score
  const sorted = Object.entries(players)
    .map(([name, data]) => ({ name, score: data.score || 0 }))
    .sort((a, b) => b.score - a.score);

  const medals = ['🥇', '🥈', '🥉'];

  sorted.forEach((player, idx) => {
    const row = createElement('div', 'leaderboard-row');
    if (player.name === myName) row.classList.add('leaderboard-row--me');

    const rankEl = createElement('span', 'leaderboard-rank');
    rankEl.textContent = idx < 3 ? medals[idx] : `#${idx + 1}`;

    const nameEl = createElement('span', 'leaderboard-name');
    nameEl.textContent = player.name;

    const scoreEl = createElement('span', 'leaderboard-score');
    scoreEl.textContent = String(player.score);

    row.appendChild(rankEl);
    row.appendChild(nameEl);
    row.appendChild(scoreEl);
    container.appendChild(row);
  });

  if (sorted.length === 0) {
    const empty = createElement('div', 'leaderboard-empty');
    empty.textContent = 'Chưa có người chơi';
    container.appendChild(empty);
  }
}


// ─── Lobby Player List ─────────────────────────────────────────────────────

/**
 * Render the player list in the multiplayer lobby.
 *
 * @param {Object<string, {score: number}>} players
 */
export function renderLobbyPlayers(players) {
  const container = $('lobby-player-list');
  if (!container) return;
  container.innerHTML = '';

  const names = Object.keys(players);
  names.forEach((name, idx) => {
    const item = createElement('div', 'lobby-player-item');

    const numEl = createElement('span', 'lobby-player-number');
    numEl.textContent = `${idx + 1}.`;

    const nameEl = createElement('span', 'lobby-player-name');
    nameEl.textContent = name;

    item.appendChild(numEl);
    item.appendChild(nameEl);
    container.appendChild(item);
  });

  if (names.length === 0) {
    const empty = createElement('div', 'lobby-empty');
    empty.textContent = 'Đang chờ người chơi...';
    container.appendChild(empty);
  }
}


// ─── Recent Activity ───────────────────────────────────────────────────────

/**
 * Render recent activity log entries.
 *
 * @param {Array<{time: string, message: string, type?: string}>} logs
 */
export function renderRecentActivity(logs) {
  const container = $('recent-activity-container');
  if (!container) return;
  container.innerHTML = '';

  if (!Array.isArray(logs) || logs.length === 0) {
    const empty = createElement('div', 'activity-empty');
    empty.textContent = 'Chưa có hoạt động nào gần đây.';
    container.appendChild(empty);
    return;
  }

  // Show most recent first
  const items = logs.slice().reverse();
  items.forEach((log) => {
    const card = createElement('div', 'activity-card');
    if (log.type) card.classList.add(`activity-card--${log.type}`);

    const timeEl = createElement('span', 'activity-time');
    timeEl.textContent = log.time || '';

    const msgEl = createElement('span', 'activity-message');
    msgEl.textContent = log.message || '';

    card.appendChild(timeEl);
    card.appendChild(msgEl);
    container.appendChild(card);
  });
}


// ─── Mistake Review ────────────────────────────────────────────────────────

/**
 * Render mistake review cards after a round.
 * Uses only `textContent` for all user-sourced data.
 *
 * @param {Array<{question: string, options: string[], correct: number, chosen: number, explanation?: string}>} wrongLog
 */
export function renderMistakeReview(wrongLog) {
  const container = $('mistake-list-container');
  if (!container) return;
  container.innerHTML = '';

  if (!Array.isArray(wrongLog) || wrongLog.length === 0) {
    const empty = createElement('div', 'mistake-empty');
    empty.textContent = 'Không có câu sai! Tuyệt vời! 🎉';
    container.appendChild(empty);
    return;
  }

  wrongLog.forEach((item, idx) => {
    const card = createElement('div', 'mistake-card');

    // Question number + text
    const header = createElement('div', 'mistake-header');
    const numberEl = createElement('span', 'mistake-number');
    numberEl.textContent = `Câu ${idx + 1}:`;
    const qTextEl = createElement('span', 'mistake-question');
    qTextEl.textContent = item.question;
    header.appendChild(numberEl);
    header.appendChild(qTextEl);
    card.appendChild(header);

    // Options list — highlight correct and wrong
    if (Array.isArray(item.options)) {
      const optionsList = createElement('div', 'mistake-options');
      item.options.forEach((opt, optIdx) => {
        const optEl = createElement('div', 'mistake-option');

        if (optIdx === item.correct) {
          optEl.classList.add('mistake-option--correct');
        }
        if (optIdx === item.chosen && item.chosen !== item.correct) {
          optEl.classList.add('mistake-option--wrong');
        }

        const label = createElement('span', 'mistake-option-label');
        label.textContent = String.fromCharCode(65 + optIdx) + '.'; // A. B. C. D.

        const text = createElement('span', 'mistake-option-text');
        text.textContent = opt;

        optEl.appendChild(label);
        optEl.appendChild(text);
        optionsList.appendChild(optEl);
      });
      card.appendChild(optionsList);
    }

    // Explanation (if provided)
    if (item.explanation) {
      const explanation = createElement('div', 'mistake-explanation');
      const explIcon = createElement('span', 'mistake-explanation-icon');
      explIcon.textContent = '💡';
      const explText = createElement('span', 'mistake-explanation-text');
      explText.textContent = item.explanation;
      explanation.appendChild(explIcon);
      explanation.appendChild(explText);
      card.appendChild(explanation);
    }

    container.appendChild(card);
  });
}


// ─── Topic Cards ───────────────────────────────────────────────────────────

/**
 * Render topic sections in the topics zone.
 * Each topic gets a heading + a row of action cards (practice, flashcard, multiplayer, exam, spaced rep).
 *
 * @param {Object<string, Array>} database — The global question database.
 * @param {Object} callbacks — Action handlers.
 * @param {Function} callbacks.onPractice   — `(topicName: string) => void`
 * @param {Function} callbacks.onFlashcard  — `(topicName: string) => void`
 * @param {Function} callbacks.onMultiplayer — `(topicName: string) => void`
 * @param {Function} callbacks.onExam       — `(topicName: string) => void`
 * @param {Function} callbacks.onSpacedRep  — `(topicName: string) => void`
 */
export function renderTopicCards(database, callbacks) {
  const container = $('dynamic-topics-zone');
  if (!container) return;
  container.innerHTML = '';

  const topics = Object.keys(database);
  if (topics.length === 0) {
    const empty = createElement('div', 'topics-empty');
    empty.textContent = 'Chưa có chủ đề nào. Hãy nhập dữ liệu câu hỏi!';
    container.appendChild(empty);
    return;
  }

  /** Card definitions: emoji, label, callback key, CSS modifier */
  const cardDefs = [
    { emoji: '📝', label: 'Luyện tập', key: 'onPractice', mod: 'practice' },
    { emoji: '🃏', label: 'Flashcard', key: 'onFlashcard', mod: 'flashcard' },
    { emoji: '🌐', label: 'Online', key: 'onMultiplayer', mod: 'multiplayer' },
    { emoji: '📋', label: 'Kiểm tra', key: 'onExam', mod: 'exam' },
    { emoji: '🧠', label: 'Spaced Rep', key: 'onSpacedRep', mod: 'spaced' }
  ];

  topics.forEach((topicName) => {
    const questions = database[topicName];
    const count = Array.isArray(questions) ? questions.length : 0;

    // Topic section wrapper
    const section = createElement('div', 'topic-section');

    // Topic header
    const header = createElement('div', 'topic-header');
    const titleEl = createElement('h3', 'topic-title');
    titleEl.textContent = topicName;
    const countEl = createElement('span', 'topic-count');
    countEl.textContent = `${count} câu hỏi`;
    header.appendChild(titleEl);
    header.appendChild(countEl);
    section.appendChild(header);

    // Action cards row
    const cardsRow = createElement('div', 'topic-cards-row');

    cardDefs.forEach((def) => {
      const card = createElement('button', `topic-card topic-card--${def.mod}`);
      card.type = 'button';

      const emojiEl = createElement('span', 'topic-card-emoji');
      emojiEl.textContent = def.emoji;

      const labelEl = createElement('span', 'topic-card-label');
      labelEl.textContent = def.label;

      card.appendChild(emojiEl);
      card.appendChild(labelEl);

      // Attach handler
      const handler = callbacks[def.key];
      if (typeof handler === 'function') {
        card.addEventListener('click', () => handler(topicName));
      }

      cardsRow.appendChild(card);
    });

    section.appendChild(cardsRow);
    container.appendChild(section);
  });
}


// ─── Answer Options ────────────────────────────────────────────────────────

/** @type {string[]} IDs of the four answer option buttons */
const OPTION_IDS = ['option-a', 'option-b', 'option-c', 'option-d'];

/**
 * Reset answer option buttons to their default state for a new question.
 *
 * @param {{question: string, options: string[], correct: number}} question
 */
export function resetAnswerOptions(question) {
  if (!question || !Array.isArray(question.options)) return;

  OPTION_IDS.forEach((id, idx) => {
    const btn = $(id);
    if (!btn) return;

    // Reset visual state
    btn.classList.remove('option-correct', 'option-wrong', 'option-disabled');
    btn.disabled = false;

    // Set option text safely
    const textEl = btn.querySelector('.option-text') || btn;
    textEl.textContent = idx < question.options.length ? question.options[idx] : '';
  });
}

/**
 * Visually highlight the correct and (optionally) the wrong answer.
 *
 * @param {number} correctIdx — Index (0–3) of the correct answer.
 * @param {number} chosenIdx  — Index the player chose (-1 if timeout).
 * @param {boolean} isCorrect — Whether the player's choice was correct.
 */
export function showCorrectAnswer(correctIdx, chosenIdx, isCorrect) {
  OPTION_IDS.forEach((id, idx) => {
    const btn = $(id);
    if (!btn) return;

    btn.disabled = true;
    btn.classList.add('option-disabled');

    if (idx === correctIdx) {
      btn.classList.add('option-correct');
    }
    if (idx === chosenIdx && !isCorrect) {
      btn.classList.add('option-wrong');
    }
  });
}


// ─── Meme Feedback Overlay ─────────────────────────────────────────────────

/** Random positive feedback messages */
const MEME_CORRECT = [
  '🔥 Quá đỉnh!', '✨ Chính xác!', '💪 Giỏi lắm!', '🎯 Chuẩn bài!',
  '⚡ Nhanh quá!', '🏆 Xuất sắc!', '🌟 Tuyệt vời!', '🚀 Siêu phàm!'
];

/** Random negative feedback messages */
const MEME_WRONG = [
  '😅 Sai rồi!', '💔 Tiếc quá!', '🤔 Xem lại nhé!', '📚 Cố lên!',
  '😬 Gần đúng!', '🫠 Ôi không!', '😤 Lần sau nhé!', '🧐 Hãy thử lại!'
];

/** Timeout feedback messages */
const MEME_TIMEOUT = [
  '⏰ Hết giờ!', '⌛ Chậm quá!', '🐢 Nhanh lên!', '😴 Thức dậy đi!'
];

/**
 * Pick a random element from an array.
 * @template T
 * @param {T[]} arr
 * @returns {T}
 */
function _randomFrom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

/**
 * Show the meme/feedback overlay after answering.
 *
 * @param {boolean} isCorrect     — Was the answer correct?
 * @param {number} points         — Points earned/lost.
 * @param {boolean} [isTimeout=false]    — Was this a timeout?
 * @param {boolean} [isMultiplayer=false] — Show multiplayer-specific info?
 */
export function showMemeFeedback(isCorrect, points, isTimeout, isMultiplayer) {
  const overlay = $('meme-feedback-overlay');
  if (!overlay) return;

  // Pick message
  let feedbackText;
  if (isTimeout) {
    feedbackText = _randomFrom(MEME_TIMEOUT);
  } else if (isCorrect) {
    feedbackText = _randomFrom(MEME_CORRECT);
  } else {
    feedbackText = _randomFrom(MEME_WRONG);
  }

  // Clear previous content
  overlay.innerHTML = '';

  // Feedback emoji + text
  const msgEl = createElement('div', 'meme-text');
  msgEl.textContent = feedbackText;
  overlay.appendChild(msgEl);

  // Points display
  if (typeof points === 'number' && points !== 0) {
    const pointsEl = createElement('div', 'meme-points');
    const prefix = points > 0 ? '+' : '';
    pointsEl.textContent = `${prefix}${points} điểm`;
    pointsEl.classList.add(points > 0 ? 'meme-points--positive' : 'meme-points--negative');
    overlay.appendChild(pointsEl);
  }

  // Multiplayer indicator
  if (isMultiplayer) {
    const mpEl = createElement('div', 'meme-multiplayer-hint');
    mpEl.textContent = '⚔️ Đang thi đấu trực tuyến';
    overlay.appendChild(mpEl);
  }

  // Apply visual class based on result
  overlay.classList.remove('meme--correct', 'meme--wrong', 'meme--timeout');
  if (isTimeout) {
    overlay.classList.add('meme--timeout');
  } else {
    overlay.classList.add(isCorrect ? 'meme--correct' : 'meme--wrong');
  }

  overlay.classList.add(SCREEN_ACTIVE_CLASS);
}

/**
 * Hide the meme/feedback overlay.
 */
export function hideMemeFeedback() {
  const overlay = $('meme-feedback-overlay');
  if (!overlay) return;
  overlay.classList.remove(SCREEN_ACTIVE_CLASS);
}


// ─── Stats Dashboard ───────────────────────────────────────────────────────

/**
 * Render the statistics dashboard section.
 *
 * @param {Object} stats
 * @param {number} [stats.totalGames=0]        — Total games played.
 * @param {number} [stats.totalCorrect=0]      — Total correct answers across all games.
 * @param {number} [stats.totalWrong=0]        — Total wrong answers across all games.
 * @param {number} [stats.totalQuestions=0]     — Total questions attempted.
 * @param {number} [stats.bestStreak=0]         — Longest consecutive correct streak.
 * @param {number} [stats.avgAccuracy=0]        — Average accuracy (0–1).
 * @param {string} [stats.lastPlayedTopic='']   — Name of the last played topic.
 * @param {string} [stats.lastPlayedTime='']    — Formatted time of last play.
 */
export function renderStatsDashboard(stats) {
  const container = $('stats-dashboard-container');
  if (!container) return;
  container.innerHTML = '';

  const s = stats || {};
  const totalGames = s.totalGames || 0;
  const totalCorrect = s.totalCorrect || 0;
  const totalWrong = s.totalWrong || 0;
  const totalQuestions = s.totalQuestions || 0;
  const bestStreak = s.bestStreak || 0;
  const avgAccuracy = s.avgAccuracy || 0;
  const lastTopic = s.lastPlayedTopic || '—';
  const lastTime = s.lastPlayedTime || '—';

  /** Stat card definitions */
  const cards = [
    { emoji: '🎮', label: 'Số trận', value: String(totalGames) },
    { emoji: '✅', label: 'Đúng', value: String(totalCorrect) },
    { emoji: '❌', label: 'Sai', value: String(totalWrong) },
    { emoji: '📊', label: 'Tổng câu hỏi', value: String(totalQuestions) },
    { emoji: '🔥', label: 'Streak tốt nhất', value: String(bestStreak) },
    { emoji: '🎯', label: 'Độ chính xác', value: `${Math.round(avgAccuracy * 100)}%` },
    { emoji: '📚', label: 'Chủ đề gần nhất', value: lastTopic },
    { emoji: '🕐', label: 'Lần chơi cuối', value: lastTime }
  ];

  const grid = createElement('div', 'stats-grid');

  cards.forEach((cardDef) => {
    const card = createElement('div', 'stats-card');

    const emojiEl = createElement('span', 'stats-card-emoji');
    emojiEl.textContent = cardDef.emoji;

    const valueEl = createElement('div', 'stats-card-value');
    valueEl.textContent = cardDef.value;

    const labelEl = createElement('div', 'stats-card-label');
    labelEl.textContent = cardDef.label;

    card.appendChild(emojiEl);
    card.appendChild(valueEl);
    card.appendChild(labelEl);
    grid.appendChild(card);
  });

  container.appendChild(grid);
}


// ─── Single Player Side Panel Metrics ──────────────────────────────────────

/**
 * Update the metrics displayed on the single-player side panel.
 *
 * @param {number} idx     — Current question index (0-based).
 * @param {number} total   — Total questions in this round.
 * @param {number} correct — Correct answers so far.
 * @param {number} wrong   — Wrong answers so far.
 */
export function updateSinglePanelMetrics(idx, total, correct, wrong) {
  setTextContent('panel-question-number', `${idx + 1} / ${total}`);
  setTextContent('panel-correct-count', String(correct));
  setTextContent('panel-wrong-count', String(wrong));

  // Accuracy percentage
  const attempted = correct + wrong;
  const accuracy = attempted > 0 ? Math.round((correct / attempted) * 100) : 0;
  setTextContent('panel-accuracy', `${accuracy}%`);
}

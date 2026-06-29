/**
 * @module app
 * @description Main orchestrator for the Wayground quiz application.
 * This is the ONLY module that handles DOMContentLoaded and binds
 * all event listeners. It wires together game, flashcard, network,
 * spaced-repetition, and stats modules with the core UI/storage layer.
 */

import { GameState, resetRoundState } from './state.js';
import { escapeHtml, shuffleArray, debounce, setTextContent } from './utils.js';
import { ensureAudioContext, playSound, toggleMute } from './audio.js';
import {
  saveDatabase,
  loadDatabase,
  saveLogs,
  loadLogs,
  exportAllData,
  importAllData,
  triggerDownload,
} from './storage.js';
import {
  $,
  switchScreen,
  hideAllScreens,
  showScreen,
  showModal,
  hideModal,
  renderRecentActivity,
  renderTopicCards,
  renderStatsDashboard,
  updateSinglePanelMetrics,
} from './ui.js';
import {
  startSinglePractice,
  startExamMode,
  startMistakeReview,
  handleOptionClick,
  togglePause,
  executeNewRound,
  showResults,
} from './game.js';
import { startFlashcardRound, flipCard, nextCard } from './flashcard.js';
import {
  joinRoomAsPlayer,
  hostRoom,
  broadcastStartGame,
  disconnectNetwork,
} from './network.js';
import {
  initSpacedRepetition,
  startSpacedRepSession,
  getDueCardCount,
} from './spaced-repetition.js';
import {
  initStats,
  getWeeklyChartData,
  getOverviewStats,
  getWeakestTopics,
} from './stats.js';

/* ------------------------------------------------------------------ */
/*  Constants                                                         */
/* ------------------------------------------------------------------ */

/** Number of answer options in the game UI. */
const NUM_OPTIONS = 4;

/** Debounce delay for search input (ms). */
const SEARCH_DEBOUNCE_MS = 300;

/** Minimum tokens per quiz data line (topic + question + 4 options + correct). */
const MIN_TOKENS_PER_LINE = 7;

/** AI prompt template for generating quiz content. */
const AI_PROMPT_TEXT = `Hãy tạo bộ câu hỏi trắc nghiệm cho chủ đề "[TÊN CHỦ ĐỀ]". 

Mỗi câu hỏi gồm 1 dòng, các trường phân tách bằng dấu "|":
Tên chủ đề|Câu hỏi|Đáp án A|Đáp án B|Đáp án C|Đáp án D|Chỉ số đáp án đúng (0-3)

Ví dụ:
Toán học|2 + 2 = ?|3|4|5|6|1

Lưu ý:
- Chỉ số đáp án đúng bắt đầu từ 0 (A=0, B=1, C=2, D=3)
- Mỗi câu hỏi trên 1 dòng riêng
- Không thêm tiêu đề hay giải thích
- Tạo ít nhất 20 câu hỏi`;

/* ------------------------------------------------------------------ */
/*  Bootstrap                                                         */
/* ------------------------------------------------------------------ */

document.addEventListener('DOMContentLoaded', init);

/**
 * Application entry point. Loads persisted data, initialises sub-systems,
 * binds event listeners, and renders the dashboard.
 * @private
 */
function init() {
  try {
    /* Load persisted database */
    const savedDb = loadDatabase();
    if (savedDb && typeof savedDb === 'object') {
      // Handle corrupted nested db if it exists (legacy bug)
      let actualDb = savedDb.db || savedDb;
      while (actualDb && actualDb.db) {
        actualDb = actualDb.db;
      }
      
      // Clean up ghost keys if any
      delete actualDb.rawText;
      delete actualDb.db;
      
      GameState.globalDatabase = actualDb;
    }

    /* Load wrong-questions log */
    const savedLogs = loadLogs();
    if (Array.isArray(savedLogs)) {
      /* loadLogs returns recent activity — wrongQuestionsLog is separate */
    }

    /* Initialise sub-systems */
    initSpacedRepetition();
    initStats();

    /* Bind all event listeners */
    bindEvents();
    setupSearch();
    setupKeyboardShortcuts();

    /* Render initial dashboard */
    renderDashboard();

    /* Show dashboard screen */
    hideAllScreens();
    showScreen('dashboard-screen');
  } catch (err) {
    console.error('[App] Initialisation failed:', err);
  }
}

/* ------------------------------------------------------------------ */
/*  Data processing                                                   */
/* ------------------------------------------------------------------ */

/**
 * Read the setup textarea, parse quiz data, build the global database,
 * persist it, and navigate to the dashboard.
 * @private
 */
function processAndLoadDatabase() {
  const textarea = $('bulk-input');
  if (!textarea) {
    showModal({ title: 'Lỗi', message: 'Không tìm thấy ô nhập liệu.' });
    return;
  }

  const rawText = textarea.value.trim();
  if (rawText.length === 0) {
    showModal({ title: 'Lỗi', message: 'Vui lòng dán dữ liệu câu hỏi vào ô nhập liệu.' });
    return;
  }

  const parsed = parseQuizData(rawText);
  const topicNames = Object.keys(parsed);

  if (topicNames.length === 0) {
    showModal({ title: 'Lỗi', message: 'Không thể phân tích dữ liệu. Hãy kiểm tra định dạng.' });
    return;
  }

  /* Merge into existing database (additive) */
  for (const topic of topicNames) {
    GameState.globalDatabase[topic] = parsed[topic];
  }

  saveDatabase(GameState.globalDatabase, rawText);
  renderDashboard();
  switchScreen(null, 'dashboard-screen');

  const totalQuestions = topicNames.reduce(
    (sum, t) => sum + parsed[t].length,
    0
  );
  showModal({
    title: 'Thành công!',
    message: `Đã tải ${totalQuestions} câu hỏi từ ${topicNames.length} chủ đề.`
  });
}

/**
 * Parse raw pipe- or tab-separated text into a database structure.
 *
 * Expected line format (7+ tokens):
 *   TopicName | Question | OptionA | OptionB | OptionC | OptionD | CorrectIdx
 *
 * @param {string} rawText - Multi-line raw quiz data.
 * @returns {Object<string, Array<{question:string, options:string[], correct:number}>>}
 * @private
 */
function parseQuizData(rawText) {
  const db = {};
  const lines = rawText.split('\n');

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line.length === 0) continue;

    /* Support both pipe and tab separators */
    const separator = line.includes('|') ? '|' : '\t';
    const tokens = line.split(separator).map((t) => t.trim());

    if (tokens.length < MIN_TOKENS_PER_LINE) continue;

    const topicName = tokens[0];
    const question = tokens[1];
    const options = [tokens[2], tokens[3], tokens[4], tokens[5]];
    const correctIdx = parseInt(tokens[6], 10);

    /* Validate */
    if (
      !topicName ||
      !question ||
      options.some((o) => !o) ||
      isNaN(correctIdx) ||
      correctIdx < 0 ||
      correctIdx > 3
    ) {
      continue;
    }

    if (!db[topicName]) {
      db[topicName] = [];
    }

    db[topicName].push({ question, options, correct: correctIdx });
  }

  return db;
}

/* ------------------------------------------------------------------ */
/*  Dashboard rendering                                               */
/* ------------------------------------------------------------------ */

/**
 * Re-render the entire dashboard: topic cards, recent activity,
 * stats, coins, and topic count.
 * @private
 */
function renderDashboard() {
  /* Topic cards with action callbacks */
  const topicActions = {
    onPractice: (topicName) => startSinglePractice(topicName),
    onExam: (topicName) => {
      const questions = GameState.globalDatabase[topicName];
      const limit = questions ? Math.min(questions.length, GameState.examQuestionLimit || 20) : 10;
      startExamMode(topicName, limit);
    },
    onFlashcard: (topicName) => startFlashcardRound(topicName),
    onMultiplayer: (topicName) => hostRoom(topicName),
    onSpacedRep: (topicName) => startSpacedRepSession(topicName),
    getDueCount: (topicName) => getDueCardCount(topicName),
  };

  renderTopicCards(GameState.globalDatabase, topicActions);

  /* Recent activity */
  const logs = loadLogs() || [];
  renderRecentActivity(logs);

  /* Stats dashboard */
  const overview = getOverviewStats();
  const weeklyData = getWeeklyChartData();
  const weakTopics = getWeakestTopics(3);
  renderStatsDashboard(overview, weeklyData, weakTopics);

  /* Coins display */
  const coinsEl = $('coins-display');
  if (coinsEl) {
    setTextContent(coinsEl, String(GameState.totalCoins || 0));
  }

  /* Topic count badge */
  const topicCountEl = $('topic-count');
  if (topicCountEl) {
    const count = Object.keys(GameState.globalDatabase || {}).length;
    setTextContent(topicCountEl, String(count));
  }

  /* Total questions badge */
  const totalQEl = $('total-questions-count');
  if (totalQEl) {
    const total = Object.values(GameState.globalDatabase || {}).reduce(
      (sum, arr) => sum + (Array.isArray(arr) ? arr.length : 0),
      0
    );
    setTextContent(totalQEl, String(total));
  }
}

/* ------------------------------------------------------------------ */
/*  Navigation                                                        */
/* ------------------------------------------------------------------ */

/**
 * Navigate back to the dashboard. Cleans up timers, network
 * connections, and re-renders the dashboard view.
 * @private
 */
function backToDashboard() {
  /* Clean up active timers */
  if (GameState.timerInterval != null) {
    clearInterval(GameState.timerInterval);
    GameState.timerInterval = null;
  }
  if (GameState.timerAnimationFrame != null) {
    cancelAnimationFrame(GameState.timerAnimationFrame);
    GameState.timerAnimationFrame = null;
  }
  if (GameState.hostTimerInterval != null) {
    clearInterval(GameState.hostTimerInterval);
    GameState.hostTimerInterval = null;
  }

  /* Disconnect multiplayer if active */
  disconnectNetwork();

  /* Reset game state flags */
  GameState.isPaused = false;
  GameState.canAnswer = false;

  /* Navigate */
  hideAllScreens();
  showScreen('dashboard-screen');
  renderDashboard();
}

/* ------------------------------------------------------------------ */
/*  AI Prompt                                                         */
/* ------------------------------------------------------------------ */

/**
 * Copy the AI quiz-generation prompt to the clipboard.
 * Falls back to a textarea-based approach for older browsers.
 * @private
 */
function copyAiPrompt() {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard
      .writeText(AI_PROMPT_TEXT)
      .then(() => showCopyFeedback(true))
      .catch(() => fallbackCopy(AI_PROMPT_TEXT));
  } else {
    fallbackCopy(AI_PROMPT_TEXT);
  }
}

/**
 * Fallback clipboard copy using a temporary textarea.
 * @param {string} text
 * @private
 */
function fallbackCopy(text) {
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  textarea.select();

  try {
    const ok = document.execCommand('copy');
    showCopyFeedback(ok);
  } catch {
    showCopyFeedback(false);
  }

  document.body.removeChild(textarea);
}

/**
 * Show visual feedback after a copy operation.
 * @param {boolean} success
 * @private
 */
function showCopyFeedback(success) {
  const btn = $('copy-prompt-btn');
  if (!btn) return;

  const originalText = btn.textContent;
  setTextContent(btn, success ? '✅ Đã copy!' : '❌ Thất bại');
  btn.disabled = true;

  setTimeout(() => {
    setTextContent(btn, originalText);
    btn.disabled = false;
  }, 2000);
}

/* ------------------------------------------------------------------ */
/*  Export / Import                                                    */
/* ------------------------------------------------------------------ */

/**
 * Export all app data as a downloadable JSON file.
 * @private
 */
function handleExport() {
  try {
    const data = exportAllData();
    const json = JSON.stringify(data, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const filename = `wayground-backup-${new Date().toISOString().slice(0, 10)}.json`;
    triggerDownload(blob, filename);
  } catch (err) {
    console.error('[App] Export failed:', err);
    showModal({ title: 'Lỗi', message: 'Xuất dữ liệu thất bại.' });
  }
}

/**
 * Import app data from a user-selected JSON file.
 * @param {Event} event - The file input change event.
 * @private
 */
function handleImport(event) {
  const file = event && event.target && event.target.files && event.target.files[0];
  if (!file) return;

  const reader = new FileReader();

  reader.onload = (e) => {
    try {
      const text = e.target.result;
      const data = JSON.parse(text);
      importAllData(data);

      /* Reload database into GameState */
      const reloaded = loadDatabase();
      if (reloaded && typeof reloaded === 'object') {
        let actualDb = reloaded.db || reloaded;
        while (actualDb && actualDb.db) {
          actualDb = actualDb.db;
        }
        delete actualDb.rawText;
        delete actualDb.db;
        GameState.globalDatabase = actualDb;
      }

      initSpacedRepetition();
      initStats();
      renderDashboard();

      showModal({ title: 'Thành công', message: 'Đã nhập dữ liệu thành công!' });
    } catch (err) {
      console.error('[App] Import failed:', err);
      showModal({ title: 'Lỗi', message: 'File không hợp lệ hoặc bị hỏng.' });
    }
  };

  reader.onerror = () => {
    showModal({ title: 'Lỗi', message: 'Không thể đọc file.' });
  };

  reader.readAsText(file);

  /* Reset the file input so the same file can be re-selected */
  if (event.target) {
    event.target.value = '';
  }
}

/* ------------------------------------------------------------------ */
/*  Search                                                            */
/* ------------------------------------------------------------------ */

/**
 * Set up debounced search for both desktop and mobile search inputs.
 * Filters topic cards by matching the data-topic-name attribute.
 * @private
 */
function setupSearch() {
  const searchHandler = debounce((query) => {
    filterTopicCards(query);
  }, SEARCH_DEBOUNCE_MS);

  const desktopSearch = $('search-input');
  const mobileSearch = $('search-input-mobile');

  if (desktopSearch) {
    desktopSearch.addEventListener('input', (e) => {
      searchHandler(e.target.value);
      /* Sync to mobile input if present */
      if (mobileSearch) mobileSearch.value = e.target.value;
    });
  }

  if (mobileSearch) {
    mobileSearch.addEventListener('input', (e) => {
      searchHandler(e.target.value);
      /* Sync to desktop input if present */
      if (desktopSearch) desktopSearch.value = e.target.value;
    });
  }
}

/**
 * Filter visible topic cards by a search query string.
 *
 * @param {string} query - Search term.
 * @private
 */
function filterTopicCards(query) {
  const normalised = (query || '').toLowerCase().trim();
  const cards = document.querySelectorAll('.topic-row-card');

  for (const card of cards) {
    const topicName = (card.dataset.topicName || '').toLowerCase();
    if (normalised === '' || topicName.includes(normalised)) {
      card.style.display = '';
    } else {
      card.style.display = 'none';
    }
  }
}

/* ------------------------------------------------------------------ */
/*  Keyboard shortcuts                                                */
/* ------------------------------------------------------------------ */

/**
 * Register global keyboard shortcuts for game, flashcard, and general use.
 * @private
 */
function setupKeyboardShortcuts() {
  document.addEventListener('keydown', (e) => {
    /* Ignore if user is typing in an input or textarea */
    const tag = e.target.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

    const key = e.key.toLowerCase();

    /* Determine which screen is currently visible */
    const gameScreen = $('game-screen');
    const flashcardScreen = $('flashcard-screen');
    const isGameVisible = gameScreen && !gameScreen.classList.contains('hidden');
    const isFlashcardVisible = flashcardScreen && !flashcardScreen.classList.contains('hidden');

    /* === Game screen shortcuts === */
    if (isGameVisible) {
      /* Answer selection: 1-4 or a-d */
      if (['1', '2', '3', '4'].includes(key)) {
        e.preventDefault();
        handleOptionClick(parseInt(key, 10) - 1);
        return;
      }
      if (['a', 'b', 'c', 'd'].includes(key)) {
        e.preventDefault();
        handleOptionClick('abcd'.indexOf(key));
        return;
      }

      /* Pause: p or Space (single/exam only) */
      if (key === 'p' || (key === ' ' && !e.shiftKey)) {
        e.preventDefault();
        togglePause();
        return;
      }

      /* Exit: Escape */
      if (key === 'escape') {
        e.preventDefault();
        confirmExit();
        return;
      }
    }

    /* === Flashcard screen shortcuts === */
    if (isFlashcardVisible) {
      /* Flip: Space or Enter */
      if (key === ' ' || key === 'enter') {
        e.preventDefault();
        flipCard();
        return;
      }

      /* Next card: ArrowRight or n */
      if (key === 'arrowright' || key === 'n') {
        e.preventDefault();
        nextCard();
        return;
      }

      /* Exit: Escape */
      if (key === 'escape') {
        e.preventDefault();
        backToDashboard();
        return;
      }
    }

    /* === Global shortcuts === */

    /* Toggle mute: m */
    if (key === 'm') {
      const muted = toggleMute();
      const muteBtn = $('mute-btn');
      if (muteBtn) {
        setTextContent(muteBtn, muted ? '❌' : '🔊');
      }
    }
  });
}

/**
 * Show a confirmation modal before exiting the game.
 * @private
 */
function confirmExit() {
  const modalBody = document.createElement('div');

  const message = document.createElement('p');
  setTextContent(message, 'Bạn có chắc muốn thoát? Tiến trình sẽ không được lưu.');
  modalBody.appendChild(message);

  const btnGroup = document.createElement('div');
  btnGroup.className = 'modal-btn-group';

  const btnCancel = document.createElement('button');
  btnCancel.className = 'btn btn-secondary';
  setTextContent(btnCancel, 'Ở lại');
  btnCancel.addEventListener('click', () => hideModal());
  btnGroup.appendChild(btnCancel);

  const btnExit = document.createElement('button');
  btnExit.className = 'btn btn-danger';
  setTextContent(btnExit, 'Thoát');
  btnExit.addEventListener('click', () => {
    hideModal();
    backToDashboard();
  });
  btnGroup.appendChild(btnExit);

  modalBody.appendChild(btnGroup);
  showModal('Xác nhận thoát', modalBody);
}

/* ------------------------------------------------------------------ */
/*  Event binding                                                     */
/* ------------------------------------------------------------------ */

/**
 * Bind all DOM event listeners. Called once during initialisation.
 * @private
 */
function bindEvents() {
  /* === Navigation === */
  safeAddListener('nav-logo-home', 'click', backToDashboard);
  safeAddListener('btn-go-to-setup', 'click', () =>
    switchScreen('dashboard-screen', 'setup-screen')
  );
  safeAddListener('btn-setup-cancel', 'click', backToDashboard);
  safeAddListener('btn-setup-save', 'click', processAndLoadDatabase);

  /* === Multiplayer === */
  safeAddListener('btn-join-room-trigger', 'click', () => {
    const codeEl = $('input-room-code');
    const nickEl = $('player-nickname');
    const code = codeEl ? codeEl.value.trim() : '';
    const nick = nickEl ? nickEl.value.trim() || 'Thành_Viên_Mới' : 'Thành_Viên_Mới';
    joinRoomAsPlayer(code, nick);
  });
  safeAddListener('btn-host-start', 'click', broadcastStartGame);
  safeAddListener('btn-lobby-exit', 'click', backToDashboard);

  /* === Game controls === */
  safeAddListener('pause-btn', 'click', togglePause);
  safeAddListener('btn-pause-resume', 'click', togglePause);
  safeAddListener('btn-pause-exit', 'click', backToDashboard);
  safeAddListener('btn-game-exit', 'click', backToDashboard);

  for (let i = 0; i < NUM_OPTIONS; i++) {
    safeAddListener(`opt-${i}`, 'click', () => handleOptionClick(i));
  }

  /* === Flashcard === */
  safeAddListener('flashcard-trigger-inner', 'click', flipCard);
  safeAddListener('btn-flashcard-next', 'click', nextCard);
  safeAddListener('btn-flashcard-home-exit', 'click', backToDashboard);

  /* === Result === */
  safeAddListener('btn-result-home', 'click', backToDashboard);
  safeAddListener('btn-result-reload', 'click', () => location.reload());
  safeAddListener('btn-review-mistakes', 'click', startMistakeReview);

  /* === Audio === */
  safeAddListener('mute-btn', 'click', () => {
    const muted = toggleMute();
    const muteBtn = $('mute-btn');
    if (muteBtn) {
      setTextContent(muteBtn, muted ? '❌' : '🔊');
    }
  });

  /* === AI Prompt === */
  safeAddListener('copy-prompt-btn', 'click', copyAiPrompt);

  /* === Export / Import === */
  safeAddListener('btn-export-json', 'click', handleExport);
  safeAddListener('btn-import-json', 'click', () => {
    const fileInput = $('import-file-input');
    if (fileInput) fileInput.click();
  });
  safeAddListener('import-file-input', 'change', handleImport);

  /* === First interaction — init audio context === */
  document.addEventListener(
    'click',
    () => {
      ensureAudioContext();
    },
    { once: true }
  );
}

/* ------------------------------------------------------------------ */
/*  Utility                                                           */
/* ------------------------------------------------------------------ */

/**
 * Safely add an event listener to a DOM element found by id.
 * Silently skips if the element does not exist.
 *
 * @param {string}   elementId  - The DOM element ID.
 * @param {string}   event      - Event name (e.g. 'click').
 * @param {Function} handler    - Event handler function.
 * @private
 */
function safeAddListener(elementId, event, handler) {
  const el = $(elementId);
  if (el) {
    el.addEventListener(event, handler);
  } else {
    console.warn(`[App] Element #${elementId} not found — skipping listener.`);
  }
}

// ===== 공통 상수 =====
const API_BASE = "/mahjong_rating";
const START_SCORE = (window.GAME_CONFIG && window.GAME_CONFIG.start_score) ? Number(window.GAME_CONFIG.start_score) : 25000;
const RETURN_SCORE = (window.GAME_CONFIG && window.GAME_CONFIG.return_score) ? Number(window.GAME_CONFIG.return_score) : 30000;
const UMA_VALUES = (window.GAME_CONFIG && window.GAME_CONFIG.uma) ? window.GAME_CONFIG.uma : [15, 5, -5, -15];
const OKA_TO_1ST = (window.GAME_CONFIG && window.GAME_CONFIG.oka !== undefined) ? Number(window.GAME_CONFIG.oka) : 20;

// 전체 게임 / 플레이어 요약 캐시 (통계 화면용)
let ALL_GAMES = [];
let PLAYER_SUMMARY = [];       // ✅ 개인 레이팅 표(4국 이상) 전용
let PLAYER_SUMMARY_ALL = [];   // ✅ 게임 기준 전체 플레이어(필터 전)
let STATS_PLAYER_LIST = [];    // ✅ 플레이어 기록 셀렉트 전용(뱃지 포함)

let ALL_BADGES = [];

let RANKING_VIEW_MODE = "pt"; // "pt" | "season"
let TOURNAMENT_STATS = {};    // { [name]: { games, sumPosPt } }
let SEASON_SUMMARY = [];      // 시즌 pt용 표 데이터

let ARCHIVE_VIEW_MODE = "ranking"; // "ranking" | "stats"

const PAGINATION_STATE = {};
const PAGE_SIZE = 10;

function renderPaginationControls(tbodyId, totalItems, onPageChange) {
  const tbody = document.getElementById(tbodyId);
  if (!tbody) return;
  const table = tbody.closest('table');
  if (!table) return;

  let container = table.nextElementSibling;
  if (!container || !container.classList.contains('pagination-controls')) {
    container = document.createElement('div');
    container.className = 'pagination-controls';
    container.style.display = 'flex';
    container.style.justifyContent = 'center';
    container.style.alignItems = 'center';
    container.style.marginTop = '15px';
    container.style.marginBottom = '15px';
    container.style.gap = '15px';
    table.parentNode.insertBefore(container, table.nextSibling);
  }

  const totalPages = Math.max(1, Math.ceil(totalItems / PAGE_SIZE));
  let currentPage = PAGINATION_STATE[tbodyId] || 1;
  if (currentPage > totalPages) currentPage = totalPages;
  PAGINATION_STATE[tbodyId] = currentPage;

  if (totalItems === 0) {
    container.style.display = 'none';
    return;
  }
  container.style.display = 'flex';

  container.innerHTML = `
    <button class="page-btn prev-btn" ${currentPage === 1 ? 'disabled' : ''} style="cursor:pointer; padding: 4px 12px; border: 1px solid #ddd; background: #fff; border-radius: 4px;">&lt;</button>
    <span style="font-size:14px; font-weight:bold; min-width: 40px; text-align: center;">${currentPage} / ${totalPages}</span>
    <button class="page-btn next-btn" ${currentPage === totalPages ? 'disabled' : ''} style="cursor:pointer; padding: 4px 12px; border: 1px solid #ddd; background: #fff; border-radius: 4px;">&gt;</button>
  `;

  container.querySelector('.prev-btn').addEventListener('click', () => {
    if (currentPage > 1) {
      PAGINATION_STATE[tbodyId] = currentPage - 1;
      onPageChange();
    }
  });

  container.querySelector('.next-btn').addEventListener('click', () => {
    if (currentPage < totalPages) {
      PAGINATION_STATE[tbodyId] = currentPage + 1;
      onPageChange();
    }
  });
}
let archiveStatsChart = null; // 아카이브 플레이어 기록용 차트


// ===== 개인 레이팅(전체 등수) 정렬 상태 =====
let RANKING_SORT = { key: "total_pt", dir: "desc" }; // 기본: 총 pt 내림차순

// ===== 아카이브 캐시 / 정렬 상태 =====
let ARCHIVES = [];
let CURRENT_ARCHIVE_GAMES = [];
let ARCHIVE_PLAYER_SUMMARY = [];
let ARCHIVE_RANKING_SORT = { key: "total_pt", dir: "desc" }; // 아카이브 전체등수 정렬

// ===== 대회 전용 =====
let TOURNAMENT_GAMES = [];

let STATS_BADGE_ONLY_START = -1; // ✅ 셀렉트에서 "뱃지만 보유" 구역 시작 인덱스

const SEASON_YEAR2 = 25;  // 2025 -> 25
const SEASON_FROM = 1;
const SEASON_TO = 6;
let SEASON_TOURNAMENT_STATS = null; // { [name]: { joinCount, ptSum } }


// ======================= 유틸리티 함수 =======================

// pt 계산
function calcPts(scores) {
  const order = scores
    .map((s, i) => ({ s, i }))
    .sort((a, b) => b.s - a.s)
    .map((o) => o.i);

  const uma = [0, 0, 0, 0];
  order.forEach((idx, rank) => {
    uma[idx] = UMA_VALUES[rank] + (rank === 0 ? OKA_TO_1ST : 0);
  });

  return scores.map((s, i) => {
    const base = (s - RETURN_SCORE) / 1000.0;
    return +(base + uma[i]).toFixed(1);
  });
}

// 시간 포맷 (UTC -> KST)
function formatKoreanTime(isoString) {
  if (!isoString) return "";
  const parts = isoString.split(/[T ]/);
  if (parts.length < 2) return isoString;

  const [datePart, timePart] = parts;
  const [year, month, day] = datePart.split("-").map(Number);
  const [hour, minute] = timePart.split(":").map(Number);

  if ([year, month, day, hour, minute].some(Number.isNaN)) return isoString;

  const utcDate = new Date(Date.UTC(year, month - 1, day, hour, minute));
  const kstDate = new Date(utcDate.getTime() + 9 * 60 * 60 * 1000);

  const y = kstDate.getUTCFullYear();
  const m = String(kstDate.getUTCMonth() + 1).padStart(2, "0");
  const d = String(kstDate.getUTCDate()).padStart(2, "0");
  const hh = String(kstDate.getUTCHours()).padStart(2, "0");
  const mm = String(kstDate.getUTCMinutes()).padStart(2, "0");

  return `${y}-${m}-${d} ${hh}:${mm}`;
}

// 등수 분포 바 생성
function createRankDistBar(rankCounts, games) {
  const total = games || 1;
  const bar = document.createElement("div");
  bar.className = "rank-dist-bar";

  for (let i = 0; i < 4; i++) {
    const count = rankCounts[i] || 0;
    const percentage = total > 0 ? (count * 100) / total : 0;

    const seg = document.createElement("div");
    seg.className = `rank-seg rank-seg${i + 1}`;
    seg.style.width = percentage.toFixed(1) + "%";

    const span = document.createElement("span");
    // 모바일 등에서 너비가 너무 좁으면 텍스트(%) 숨기기 (12% 미만)
    if (percentage >= 12) {
      span.textContent = `${percentage.toFixed(0)}%`;
    } else {
      span.textContent = "";
    }
    // 툴팁 추가 (길게 누르거나 호버 시 확인 가능)
    seg.title = `${i + 1}등: ${count}회 (${percentage.toFixed(1)}%)`;

    seg.appendChild(span);
    bar.appendChild(seg);
  }
  return bar;
}

// fetch 래퍼
async function fetchJSON(url, options = {}) {
  const res = await fetch(url, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try {
      const d = await res.json();
      if (d && d.error) msg += ` - ${d.error}`;
    } catch (_) { }
    throw new Error(msg);
  }
  try {
    return await res.json();
  } catch (_) {
    return null;
  }
}

// 정렬 화살표 업데이트
// 정렬 화살표 업데이트 (삭제됨)
function updateSortIndicatorsForTable(tableId, sortState) {
  // 사용자가 화살표 표시를 원하지 않으므로 빈 함수로 둡니다.
}

// 플레이어 목록 정렬
function sortPlayersByState(list, sortState) {
  const key = sortState.key;
  const dir = sortState.dir === "desc" ? -1 : 1;

  const arr = [...(list || [])];
  arr.sort((a, b) => {
    const av = Number(a[key] ?? 0);
    const bv = Number(b[key] ?? 0);
    if (av === bv) return String(a.name).localeCompare(String(b.name), "ko");
    return (av - bv) * dir;
  });
  return arr;
}

// 시즌 pt 계산 (공통)
function calculateSeasonScore(totalPt, games, tJoin, tSum) {
  const totalPtScore = 500 * (2 / Math.PI) * Math.atan(totalPt / 250);
  const gamesScore = 200 * (1 - Math.pow(0.95, games));
  const tournamentScore = (Math.min(tJoin, 3) * 50) + 150 * (1 - Math.pow(0.995, Math.max(tSum, 0)));
  const sum = totalPtScore + gamesScore + tournamentScore;
  return { totalPtScore, gamesScore, tournamentScore, sum };
}


// ======================= 공통 렌더링 함수 =======================

function renderGameList(tbodyId, allGames, options = {}) {
  const tbody = document.getElementById(tbodyId);
  if (!tbody) return;

  tbody.innerHTML = "";
  if (!allGames || allGames.length === 0) {
    tbody.innerHTML = '<tr><td colspan="7" class="ranking-placeholder">기록 없음</td></tr>';
    renderPaginationControls(tbodyId, 0, () => {});
    return;
  }

  if (!PAGINATION_STATE[tbodyId]) PAGINATION_STATE[tbodyId] = 1;
  let currentPage = PAGINATION_STATE[tbodyId];
  const totalPages = Math.ceil(allGames.length / PAGE_SIZE);
  if (currentPage > totalPages) currentPage = totalPages;
  PAGINATION_STATE[tbodyId] = currentPage;

  const startIndex = (currentPage - 1) * PAGE_SIZE;
  const pageGames = allGames.slice(startIndex, startIndex + PAGE_SIZE);

  pageGames.forEach((g, idxOnPage) => {
    const scores = [
      Number(g.player1_score), Number(g.player2_score),
      Number(g.player3_score), Number(g.player4_score),
    ];
    const names = [
      g.player1_name, g.player2_name,
      g.player3_name, g.player4_name,
    ].map((n) => (n || "").trim());

    const pts = calcPts(scores);

    const order = scores.map((s, i) => ({ s, i })).sort((a, b) => b.s - a.s);
    const ranks = [0, 0, 0, 0];
    order.forEach((o, idx) => (ranks[o.i] = idx + 1));

    const tr = document.createElement("tr");
    tr.className = ""

    const isTournament = Boolean(g.is_tournament_flag);
    const tournamentBadge = isTournament ? ' <span style="color:#e67e22;font-size:0.85em;font-weight:bold;">[대회]</span>' : '';
    const indexStr = options.useIndexNumbering
      ? `<span style="color:#888;">#${allGames.length - (startIndex + idxOnPage)}</span>`
      : `<span style="color:#888;">#${g.id}</span>`;

    tr.innerHTML = `
      <td>${indexStr}${tournamentBadge}</td>
      <td>${formatKoreanTime(g.created_at)}</td>
      <td></td><td></td><td></td><td></td>
      <td></td>
    `;

    // P1~P4
    for (let i = 0; i < 4; i++) {
      const td = tr.children[2 + i];
      const name = names[i] || "";
      const score = scores[i];
      const pt = pts[i];

      td.innerHTML = `<strong>${name}</strong><br>${score} (${pt})`;
      if (ranks[i] === 1) td.classList.add("winner-cell");
    }

    // Delete Button
    const tdDel = tr.children[6];
    if (options.onDelete) {
      const btn = document.createElement("button");
      btn.textContent = "삭제";
      btn.addEventListener("click", () => options.onDelete(g.id));
      tdDel.appendChild(btn);
    }

    tbody.appendChild(tr);
  });

  renderPaginationControls(tbodyId, allGames.length, () => {
    renderGameList(tbodyId, allGames, options);
  });
}

function renderPlayerGameRecords(tbodyId, gameRecords) {
  const tbody = document.getElementById(tbodyId);
  if (!tbody) return;
  tbody.innerHTML = "";

  if (!gameRecords || gameRecords.length === 0) {
     tbody.innerHTML = '<tr><td colspan="5" class="ranking-placeholder">기록 없음</td></tr>';
     renderPaginationControls(tbodyId, 0, () => {});
     return;
  }

  if (!PAGINATION_STATE[tbodyId]) PAGINATION_STATE[tbodyId] = 1;
  let currentPage = PAGINATION_STATE[tbodyId];
  const totalPages = Math.ceil(gameRecords.length / PAGE_SIZE);
  if (currentPage > totalPages) currentPage = totalPages;
  PAGINATION_STATE[tbodyId] = currentPage;

  const startIndex = (currentPage - 1) * PAGE_SIZE;
  const pageRecords = gameRecords.slice(startIndex, startIndex + PAGE_SIZE);

  pageRecords.forEach((rec) => {
    const tr = document.createElement("tr");
    tr.className = "";
    const tdTime = document.createElement("td");
    tdTime.className = "col-time-hide";
    tdTime.textContent = formatKoreanTime(rec.created_at);
    tr.appendChild(tdTime);

    rec.names.forEach((n, i) => {
      const td = document.createElement("td");
      td.innerHTML = `<strong>${n}</strong><br>${rec.scores[i]} (${rec.pts[i].toFixed(1)})`;
      const isWinner = rec.ranks[i] === 1;
      const isMyPlayer = i === rec.myIndex;

      if (isWinner) {
        td.classList.add("winner-cell");
      } else if (isMyPlayer) {
        td.classList.add("my-player-cell");
      }
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  });

  renderPaginationControls(tbodyId, gameRecords.length, () => {
    renderPlayerGameRecords(tbodyId, gameRecords);
  });
}

// 2. 게임 리스트로부터 플레이어 통계 집계
function calculateStatsFromGames(games) {
  const playerStats = {};

  games.forEach((g) => {
    const scores = [
      Number(g.player1_score), Number(g.player2_score),
      Number(g.player3_score), Number(g.player4_score),
    ];
    const names = [
      g.player1_name, g.player2_name,
      g.player3_name, g.player4_name,
    ].map((n) => (n || "").trim());

    const pts = calcPts(scores);

    const order = scores.map((s, i) => ({ s, i })).sort((a, b) => b.s - a.s);
    const ranks = [0, 0, 0, 0];
    order.forEach((o, idx) => (ranks[o.i] = idx + 1));

    for (let i = 0; i < 4; i++) {
      const name = names[i];
      if (!name) continue;
      if (!playerStats[name]) {
        playerStats[name] = { games: 0, total_pt: 0, rankCounts: [0, 0, 0, 0] };
      }
      playerStats[name].games += 1;
      playerStats[name].total_pt += pts[i];
      playerStats[name].rankCounts[ranks[i] - 1] += 1;
    }
  });

  return Object.entries(playerStats).map(([name, st]) => {
    const games = st.games;
    const total_pt_raw = st.total_pt;
    const total_pt = +total_pt_raw.toFixed(1);
    const avg_pt = games > 0 ? total_pt_raw / games : 0;
    const c1 = st.rankCounts[0];
    const c2 = st.rankCounts[1];
    const yonde = games > 0 ? ((c1 + c2) * 100) / games : 0;

    return {
      name,
      games,
      total_pt,
      avg_pt: +avg_pt.toFixed(1),
      yonde_rate: +yonde.toFixed(1),
      rankCounts: st.rankCounts,
    };
  });
}


// 3. 랭킹 테이블 렌더링
function renderRankingTable(tbodyId, players, sortState, tableIdForIndicators, emptyMsg = "통계 없음") {
  const tbody = document.getElementById(tbodyId);
  if (!tbody) return;

  const sorted = sortPlayersByState(players, sortState);

  tbody.innerHTML = "";
  if (!sorted.length) {
    tbody.innerHTML = `<tr><td colspan="7" class="ranking-placeholder">${emptyMsg}</td></tr>`;
    return;
  }

  sorted.forEach((p, idx) => {
    const tr = document.createElement("tr");
    tr.className = ""
    tr.innerHTML = `
      <td>${idx + 1}</td>
      <td>${p.name}</td>
      <td>${p.games}</td>
      <td>${Number(p.total_pt).toFixed(1)}</td>
      <td>${Number(p.avg_pt).toFixed(1)}</td>
      <td>${Number(p.yonde_rate).toFixed(1)}%</td>
      <td></td>
    `;
    tr.children[6].appendChild(createRankDistBar(p.rankCounts, p.games));
    tbody.appendChild(tr);
  });

  if (tableIdForIndicators) {
    updateSortIndicatorsForTable(tableIdForIndicators, sortState);
  }
}


// ======================= 앱 초기화 =======================

document.addEventListener("DOMContentLoaded", () => {
  setupViewSwitch();

  setupPersonalForm();
  setupRankingSort();
  setupRankingTitleToggle();

  setupStatsView();

  setupArchiveView();
  setupArchiveRankingSort();

  setupTournamentForm();

  setupAdminView();
  setupChartFilters(); // Added chart filters setup
  setupMobileSwipe(); // 모바일 스와이프

  loadGamesAndRanking(); // 개인전 데이터 로드
  reloadBadgeList();
  reloadArchiveList();
});


// ======================= View Switch =======================
function setupViewSwitch() {
  const views = {
    personal: document.getElementById("personal-view"),
    stats: document.getElementById("stats-view"),
    archive: document.getElementById("archive-view"),
    tournament: document.getElementById("tournament-view"),
    admin: document.getElementById("admin-view"),
  };
  const buttons = document.querySelectorAll(".view-switch-btn");

  // 탭 순서 (버튼 순서와 동일)
  const viewOrder = ["personal", "stats", "tournament", "archive", "admin"];
  let currentView = "personal";

  buttons.forEach((btn) => {
    btn.addEventListener("click", () => {
      const target = btn.dataset.view;
      if (target === currentView) return;

      // 방향 결정
      const fromIdx = viewOrder.indexOf(currentView);
      const toIdx = viewOrder.indexOf(target);
      const slideClass = toIdx > fromIdx ? "view-slide-right" : "view-slide-left";

      buttons.forEach(b => b.classList.remove("active"));
      btn.classList.add("active");

      // 현재 뷰 숨기기
      if (views[currentView]) views[currentView].style.display = "none";

      // 새 뷰 표시 + 슬라이드 클래스 적용
      const nextEl = views[target];
      if (nextEl) {
        nextEl.style.display = "block";
        nextEl.classList.remove("view-slide-right", "view-slide-left");
        // 강제 reflow 후 클래스 적용 (애니메이션 재시작)
        void nextEl.offsetWidth;
        nextEl.classList.add(slideClass);
        // 애니메이션 끝나면 클래스 제거
        nextEl.addEventListener("animationend", () => {
          nextEl.classList.remove("view-slide-right", "view-slide-left");
        }, { once: true });
      }

      currentView = target;

      // 모바일: 해당 뷰 스와이프 초기화
      setTimeout(() => { if (typeof setupMobileSwipe === 'function') setupMobileSwipe(); }, 50);

      if (target === "stats") updateStatsPlayerSelect();
      if (target === "archive") reloadArchiveList();
      if (target === "tournament") loadTournamentGamesAndRanking();
      if (target === "admin") {
        reloadBadgeList();
        reloadArchiveList();
      }
    });
  });

  // Default view
  if (views.personal) views.personal.style.display = "block";
}


// ======================= 개인 레이팅 =======================

function setupRankingSort() {
  const table = document.getElementById("ranking-table");
  if (!table) return;
  const headers = table.querySelectorAll("th.sortable[data-sort-key]");
  headers.forEach((th) => {
    th.addEventListener("click", () => {
      const key = th.dataset.sortKey;
      if (RANKING_SORT.key === key) {
        RANKING_SORT.dir = RANKING_SORT.dir === "desc" ? "asc" : "desc";
      } else {
        RANKING_SORT.key = key;
        RANKING_SORT.dir = "desc";
      }
      renderMainRanking(); // render function
    });
  });
}

function renderMainRanking() {
  const ptWrap = document.getElementById("ranking-pt-wrap");
  const popWrap = document.getElementById("ranking-population-wrap");

  // Visibility Toggle
  if (ptWrap) ptWrap.style.display = "block";
  if (popWrap) popWrap.style.display = "none";

  // Content Rendering
  renderRankingTable("ranking-tbody", PLAYER_SUMMARY, RANKING_SORT, "ranking-table", "통계 없음");
}

function setupPersonalForm() {
  const form = document.getElementById("game-form");
  if (!form) return;

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    const p1 = (fd.get("player1_name") || "").trim();
    const p2 = (fd.get("player2_name") || "").trim();
    const p3 = (fd.get("player3_name") || "").trim();
    const p4 = (fd.get("player4_name") || "").trim();
    const s1 = parseInt(fd.get("player1_score"), 10);
    const s2 = parseInt(fd.get("player2_score"), 10);
    const s3 = parseInt(fd.get("player3_score"), 10);
    const s4 = parseInt(fd.get("player4_score"), 10);

    if ([s1, s2, s3, s4].some(Number.isNaN)) return alert("pt는 숫자여야 합니다.");
    const targetSum = START_SCORE * 4;
    if (s1 + s2 + s3 + s4 !== targetSum) return alert(`합 ${targetSum}이(가) 아닙니다. (현재: ${s1 + s2 + s3 + s4})`);

    const payload = {
      player1_name: p1, player2_name: p2, player3_name: p3, player4_name: p4,
      player1_score: s1, player2_score: s2, player3_score: s3, player4_score: s4,
    };

    try {
      await fetchJSON(`${API_BASE}/api/games`, { method: "POST", body: JSON.stringify(payload) });
      form.reset();
      await loadGamesAndRanking();
    } catch (err) {
      console.error(err);
      alert("저장 실패: " + err.message);
    }
  });
}

async function loadGamesAndRanking() {
  let games = [];
  try {
    games = await fetchJSON(`${API_BASE}/api/games`);
  } catch (err) {
    console.error(err);
    return;
  }
  // 최신순 정렬
  games = (games || []).slice().sort((a, b) => (b.id || 0) - (a.id || 0));
  ALL_GAMES = games;

  // 1. 대국 기록 렌더링
  renderGameList("games-tbody", games, {
    onDelete: (id) => {
      showConfirm("이 대국을 삭제할까요?", async () => {
        try {
          await fetchJSON(`${API_BASE}/api/games/${id}`, { method: "DELETE" });
          await loadGamesAndRanking();
        } catch (e) { console.error(e); alert("삭제 실패"); }
      });
    }
  });

  // 2. 플레이어 통계 계산
  const players = calculateStatsFromGames(games);
  PLAYER_SUMMARY_ALL = players;
  PLAYER_SUMMARY = players.filter((p) => (p.games || 0) >= 4); // 4국 이상

  // 3. 대회 데이터 로드 (시즌 pt용)
  try {
    const tg = await fetchJSON(`${API_BASE}/api/tournament_games`);
    TOURNAMENT_GAMES = tg || [];
  } catch (e) { console.warn(e); TOURNAMENT_GAMES = []; }

  // 4. 시즌 pt 계산
  SEASON_SUMMARY = await buildSeasonSummary(PLAYER_SUMMARY_ALL);

  // 5. 랭킹 렌더링
  renderMainRanking();

  // 6. 통계 셀렉트 업데이트
  // updateStatsPlayerSelect(); // (renderMainRanking나 rebuildStatsPlayerList에서 호출됨)
  await rebuildStatsPlayerList();
}


// ======================= 플레이어 기록 =======================

function setupStatsView() {
  const select = document.getElementById("stats-player-select");
  if (select) {
    select.addEventListener("change", () => renderStatsForPlayer(select.value));
  }
}

async function rebuildStatsPlayerList() {
  const map = new Map();
  (PLAYER_SUMMARY_ALL || []).forEach((p) => {
    if (!p?.name) return;
    map.set(p.name, { name: p.name, games: p.games || 0, total_pt: Number(p.total_pt || 0) });
  });

  try {
    const allPB = await fetchJSON(`${API_BASE}/api/player_badges`);
    (allPB || []).forEach((pb) => {
      const n = (pb.player_name || "").trim();
      if (!n) return;
      if (!map.has(n)) map.set(n, { name: n, games: 0, total_pt: 0 });
    });
  } catch (e) { console.warn("Failed to load badges:", e); }

  const all = Array.from(map.values());
  const withGames = all.filter(p => p.games > 0).sort((a, b) => b.total_pt - a.total_pt || b.games - a.games || String(a.name).localeCompare(String(b.name)));
  const badgeOnly = all.filter(p => p.games === 0).sort((a, b) => String(a.name).localeCompare(String(b.name)));

  STATS_PLAYER_LIST = [...withGames, ...badgeOnly];
  updateStatsPlayerSelect();
}

function updateStatsPlayerSelect() {
  const select = document.getElementById("stats-player-select");
  if (!select) return;
  const prev = select.value;
  select.innerHTML = '<option value="">플레이어를 선택하세요</option>';

  const list = STATS_PLAYER_LIST.length ? STATS_PLAYER_LIST : (PLAYER_SUMMARY_ALL || []);

  list.forEach(p => {
    const opt = document.createElement("option");
    opt.value = p.name;
    if (p.games > 0) opt.textContent = `${p.name} (${p.games}국, ${p.total_pt.toFixed(1)}pt)`;
    else opt.textContent = `${p.name}`;
    select.appendChild(opt);
  });

  if (prev && list.some(p => p.name === prev)) {
    select.value = prev;
    renderStatsForPlayer(prev);
  } else {
    renderStatsForPlayer("");
  }
}

function computePlayerDetailStats(playerName, games) {
  let totalGames = 0, totalPt = 0, rankCounts = [0, 0, 0, 0];
  let tobiCount = 0, maxScore = null;
  const recent = [], coMap = {}, gameRecords = [];

  games.forEach((g) => {
    const scores = [Number(g.player1_score), Number(g.player2_score), Number(g.player3_score), Number(g.player4_score)];
    const names = [g.player1_name, g.player2_name, g.player3_name, g.player4_name].map(n => (n || "").trim());
    const idx = names.indexOf(playerName);
    if (idx === -1) return;

    const pts = calcPts(scores);
    const order = scores.map((s, i) => ({ s, i })).sort((a, b) => b.s - a.s);
    const ranks = [0, 0, 0, 0];
    order.forEach((o, pos) => ranks[o.i] = pos + 1);

    const myRank = ranks[idx];
    totalGames++;
    totalPt += pts[idx];
    rankCounts[myRank - 1]++;
    if (scores[idx] < 0) tobiCount++;
    if (maxScore === null || scores[idx] > maxScore) maxScore = scores[idx];

    recent.push({ created_at: g.created_at, rank: myRank });

    names.forEach((n, j) => {
      if (j === idx || !n) return;
      if (!coMap[n]) coMap[n] = { games: 0, my_rank_sum: 0, co_rank_sum: 0 };
      coMap[n].games++;
      coMap[n].my_rank_sum += myRank;
      coMap[n].co_rank_sum += ranks[j];
    });

    gameRecords.push({ id: g.id, created_at: g.created_at, names, scores, pts, ranks, myIndex: idx });
  });

  const coPlayers = Object.entries(coMap).map(([n, st]) => ({
    name: n, games: st.games, my_avg_rank: st.my_rank_sum / st.games, co_avg_rank: st.co_rank_sum / st.games
  })).sort((a, b) => b.games - a.games || String(a.name).localeCompare(String(b.name)));

  const avg_rank = totalGames > 0 ? (rankCounts[0] * 1 + rankCounts[1] * 2 + rankCounts[2] * 3 + rankCounts[3] * 4) / totalGames : 0;

  return {
    games: totalGames, total_pt: totalPt, rankCounts,
    yonde_rate: totalGames > 0 ? (rankCounts[0] + rankCounts[1]) * 100 / totalGames : 0,
    avg_rank: avg_rank,
    recent: recent.reverse(), // 최신순
    coPlayers,
    tobi_count: tobiCount,
    tobi_rate: totalGames > 0 ? tobiCount * 100 / totalGames : 0,
    max_score: maxScore ?? 0,
    gameRecords // 최신순
  };
}

function renderStatsForPlayer(name) {
  const summaryDiv = document.getElementById("stats-summary");
  const rankSection = document.getElementById("stats-rank-section");
  const gamesSection = document.getElementById("stats-games-section");
  const dailySection = document.getElementById("stats-daily-section");
  const coSection = document.getElementById("stats-co-section");

  const distDiv = document.getElementById("stats-rank-dist");
  const coTbody = document.getElementById("stats-co-tbody");
  const playerGamesTbody = document.getElementById("stats-player-games-tbody");
  const chartHint = document.getElementById("chart-hint");

  if (!summaryDiv) return;

  if (!name) {
    summaryDiv.innerHTML = '';
    if (rankSection) rankSection.style.display = "none";
    if (gamesSection) gamesSection.style.display = "none";
    if (dailySection) dailySection.style.display = "none";
    if (coSection) coSection.style.display = "none";

    distDiv.innerHTML = "";
    coTbody.innerHTML = '<tr><td colspan="4" class="ranking-placeholder">데이터 없음</td></tr>';
    if (playerGamesTbody) playerGamesTbody.innerHTML = '<tr><td colspan="5" class="ranking-placeholder">데이터 없음</td></tr>';

    // 차트 초기화 및 힌트 표시
    if (typeof statsChart !== 'undefined' && statsChart) {
      statsChart.destroy();
      statsChart = null;
    }
    if (typeof statsGameIdPtChart !== 'undefined' && statsGameIdPtChart) {
      statsGameIdPtChart.destroy();
      statsGameIdPtChart = null;
    }
    if (chartHint) chartHint.style.display = "block";

    loadPlayerBadgesForStats("");
    return;
  }

  // Show sections
  if (rankSection) rankSection.style.display = "block";
  if (gamesSection) gamesSection.style.display = "block";
  if (dailySection) dailySection.style.display = "block";
  if (coSection) coSection.style.display = "block";

  if (chartHint) chartHint.style.display = "none";

  renderHistoryGraph(name, "week"); // Render graph (default: 1 week)

  // 하위 차트(등수 및 pt 추이) - 버튼 초기화 후 기본 10국으로 렌더
  document.querySelectorAll('.combined-filter-btn').forEach(b => b.classList.remove('active'));
  const defaultCombinedBtn = document.querySelector('.combined-filter-btn[data-limit="10"]');
  if (defaultCombinedBtn) defaultCombinedBtn.classList.add('active');
  renderRecentRankTrend(name, 10);
  renderGameIdPtChart(name, 10);

  const detail = computePlayerDetailStats(name, ALL_GAMES);

  // Summary
  summaryDiv.innerHTML = `
        <div class="stats-summary-main">
          <div><span class="stats-label">플레이어</span> <span class="stats-value">${name}</span></div>
          <div><span class="stats-label">대국 수</span> <span class="stats-value">${detail.games}</span></div>
          <div><span class="stats-label">총 pt</span> <span class="stats-value">${detail.total_pt.toFixed(1)}</span></div>
          <div><span class="stats-label">연대율</span> <span class="stats-value">${detail.yonde_rate.toFixed(1)}%</span></div>
          <div><span class="stats-label">토비율</span> <span class="stats-value">${detail.tobi_rate.toFixed(1)}% (${detail.tobi_count}회)</span></div>
          <div><span class="stats-label">최다 pt</span> <span class="stats-value">${detail.max_score}</span></div>
        </div>
    `;

  // Distribution
  distDiv.innerHTML = "";
  distDiv.appendChild(createRankDistBar(detail.rankCounts, detail.games));

  const avgRankSpan = document.getElementById("stats-avg-rank");
  if (avgRankSpan) {
    avgRankSpan.textContent = detail.games > 0 ? `평균 등수: ${detail.avg_rank.toFixed(2)}` : "평균 등수: -";
  }

  // Co-Players
  coTbody.innerHTML = "";
  if (detail.coPlayers.length) {
    detail.coPlayers.forEach((c, ci) => {
      const tr = document.createElement("tr");
      tr.className = ""
      tr.innerHTML = `<td>${c.name}</td><td>${c.games}</td><td>${c.my_avg_rank.toFixed(2)}</td><td>${c.co_avg_rank.toFixed(2)}</td>`;
      coTbody.appendChild(tr);
    });
  } else {
    coTbody.innerHTML = '<tr><td colspan="4" class="ranking-placeholder">데이터 없음</td></tr>';
  }

  // Game Records
  if (playerGamesTbody) {
      PAGINATION_STATE["stats-player-games-tbody"] = 1; // reset page on load
      renderPlayerGameRecords("stats-player-games-tbody", detail.gameRecords);
  }

  loadPlayerBadgesForStats(name);
}

async function loadPlayerBadgesForStats(name) {
  const container = document.getElementById("stats-badges");
  if (!container) return;
  container.innerHTML = "";
  if (!name) {
    container.innerHTML = '';
    return;
  }
  try {
    const badges = await fetchJSON(`${API_BASE}/api/player_badges/by_player/${encodeURIComponent(name)}`);
    if (!badges || !badges.length) {
      container.innerHTML = '<p class="hint-text">보유 뱃지 없음</p>';
      return;
    }
    const list = document.createElement("div");
    list.className = "badge-list-inner";
    badges.forEach(b => {
      const chip = document.createElement("div");
      chip.className = `badge-chip badge-grade-${b.grade || "기타"}`;
      const main = document.createElement("div");
      main.className = "badge-main";
      main.textContent = b.name;
      chip.appendChild(main);
      if (b.description) {
        const desc = document.createElement("div");
        desc.className = "badge-desc";
        desc.textContent = b.description;
        chip.appendChild(desc);
      }
      list.appendChild(chip);
    });
    container.appendChild(list);
  } catch (e) {
    console.error(e);
    container.innerHTML = '<p class="hint-text">로드 실패</p>';
  }
}


// ======================= 아카이브 =======================

function setupArchiveView() {
  const asel = document.getElementById("archive-select");
  if (asel) asel.addEventListener("change", () => loadArchiveGames(asel.value));

  // 아카이브 제목 클릭 토글
  setupArchiveRankingTitleToggle();

  // 아카이브 플레이어 기록 플레이어 선택
  const psel = document.getElementById("archive-stats-player-select");
  if (psel) psel.addEventListener("change", () => renderArchiveStatsForPlayer(psel.value));
}

// 아카이브 제목 클릭 토글
function setupArchiveRankingTitleToggle() {
  const title = document.getElementById("archive-ranking-title");
  if (!title) return;

  title.style.cursor = "pointer";
  title.addEventListener("click", () => {
    ARCHIVE_VIEW_MODE = ARCHIVE_VIEW_MODE === "ranking" ? "stats" : "ranking";
    renderArchiveView();
  });
}

// ======================= 팀 관리 로직 =======================
// script_team.js 로 이동됨


// 아카이브 뷰 렌더링 (랭킹 또는 플레이어 기록)
function renderArchiveView() {
  const rankingWrap = document.getElementById("archive-ranking-wrap");
  const statsWrap = document.getElementById("archive-stats-wrap");
  const title = document.getElementById("archive-ranking-title");

  if (ARCHIVE_VIEW_MODE === "ranking") {
    if (rankingWrap) rankingWrap.style.display = "block";
    if (statsWrap) statsWrap.style.display = "none";
    if (title) title.textContent = "전체 등수";
  } else {
    if (rankingWrap) rankingWrap.style.display = "none";
    if (statsWrap) statsWrap.style.display = "block";
    if (title) title.textContent = "플레이어 기록";
    updateArchiveStatsPlayerSelect();
  }
}

// 아카이브 플레이어 기록 플레이어 선택 업데이트
function updateArchiveStatsPlayerSelect() {
  const select = document.getElementById("archive-stats-player-select");
  if (!select) return;

  const prev = select.value;
  select.innerHTML = '<option value="">플레이어를 선택하세요</option>';

  const sorted = [...ARCHIVE_PLAYER_SUMMARY].sort((a, b) => b.total_pt - a.total_pt);

  sorted.forEach(p => {
    const opt = document.createElement("option");
    opt.value = p.name;
    opt.textContent = `${p.name} (${p.games}국, ${p.total_pt.toFixed(1)}pt)`;
    select.appendChild(opt);
  });

  if (prev && sorted.some(p => p.name === prev)) {
    select.value = prev;
    renderArchiveStatsForPlayer(prev);
  } else {
    renderArchiveStatsForPlayer("");
  }
}

// 아카이브 그래프 렌더링
let archiveRankTrendChart = null;
function renderArchiveRecentRankTrend(targetName, limit = 10) {
  const ctx = document.getElementById("archive-stats-rank-trend-chart");
  if (!ctx) return;

  let all = [...CURRENT_ARCHIVE_GAMES];
  all.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

  const myGames = [];
  for (const g of all) {
    const names = [g.player1_name, g.player2_name, g.player3_name, g.player4_name].map(n => (n || "").trim());
    const idx = names.indexOf(targetName);
    if (idx !== -1) {
      const scores = [g.player1_score, g.player2_score, g.player3_score, g.player4_score].map(Number);
      const order = scores.map((s, i) => ({ s, i })).sort((a, b) => b.s - a.s);
      const ranks = [0, 0, 0, 0];
      order.forEach((o, pos) => ranks[o.i] = pos + 1);

      myGames.push({
        id: g.id,
        rank: ranks[idx],
        score: scores[idx],
        date: g.created_at
      });
    }
    if (limit > 0 && myGames.length >= limit) break;
  }

  if (myGames.length === 0) {
    if (archiveRankTrendChart) { archiveRankTrendChart.destroy(); archiveRankTrendChart = null; }
    return;
  }

  const chartData = myGames.reverse();
  const totalRank = chartData.reduce((sum, g) => sum + g.rank, 0);
  const avgRank = totalRank / chartData.length;

  const labels = chartData.map((_, i) => i + 1);
  const ranks = chartData.map(g => g.rank);
  const avgData = Array(chartData.length).fill(avgRank);

  const pointColors = ranks.map(r => {
    if (r === 1) return '#4dd2a6';
    if (r === 2) return '#4f9cff';
    if (r === 3) return '#d9d9d9';
    return '#ff6b81';
  });

  const pointStyles = chartData.map(g => {
    if (g.score < 0) return 'crossRot';
    if (g.rank === 1 && g.score >= 50000) return 'rectRot';
    return 'circle';
  });

  if (archiveRankTrendChart) archiveRankTrendChart.destroy();

  archiveRankTrendChart = new Chart(ctx, {
    type: 'line',
    data: {
      labels: labels,
      datasets: [
        {
          label: '등수', data: ranks, borderColor: '#333', borderWidth: 2,
          pointBackgroundColor: pointColors, pointBorderColor: '#000', pointBorderWidth: chartData.map(g => g.score < 0 ? 3 : 2),
          pointRadius: 6, pointHoverRadius: 8, pointStyle: pointStyles, fill: false, tension: 0, yAxisID: 'y'
        },
        {
          label: `평균 등수 (${avgRank.toFixed(2)})`, data: avgData, borderColor: '#bbb', borderWidth: 2,
          borderDash: [5, 5], pointRadius: 0, fill: false, yAxisID: 'y'
        }
      ]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      layout: { padding: { top: 20, bottom: 20, right: 20 } },
      interaction: { mode: 'index', intersect: false },
      plugins: { legend: { display: false }, tooltip: { enabled: false } },
      scales: {
        y: {
          display: true, reverse: true, min: 0.5, max: 4.5,
          title: { display: true, text: '등수', color: '#666', font: { size: 12, weight: 'bold' } },
          ticks: {
            display: true, color: '#666', font: { size: 12 }, padding: 10,
            callback: function (value) { if (Number.isInteger(value)) return value; return null; }
          },
          grid: { display: true, drawBorder: false, color: '#bbb', lineWidth: 1 }, border: { display: true }
        },
        x: { display: false }
      }
    }
  });

  document.querySelectorAll('.archive-combined-filter-btn').forEach(btn => {
    if (Number(btn.dataset.limit) === limit) btn.classList.add('active');
    else btn.classList.remove('active');
  });
}

let archiveGameIdPtChart = null;
function renderArchiveGameIdPtChart(targetName, limit = 10) {
  const canvas = document.getElementById("archive-stats-gameid-pt-chart");
  if (!canvas) return;

  if (archiveGameIdPtChart) { archiveGameIdPtChart.destroy(); archiveGameIdPtChart = null; }
  if (!targetName || !CURRENT_ARCHIVE_GAMES || CURRENT_ARCHIVE_GAMES.length === 0) return;

  const myGames = CURRENT_ARCHIVE_GAMES.filter(g => {
    const names = [g.player1_name, g.player2_name, g.player3_name, g.player4_name].map(n => (n || "").trim());
    return names.includes(targetName);
  }).slice().reverse();

  if (myGames.length === 0) return;

  const sliced = (limit > 0) ? myGames.slice(-limit) : myGames;
  const labels = [];
  const cumPtData = [];

  let allCum = 0;
  const cumByGame = new Map();
  myGames.forEach(g => {
    const scores = [Number(g.player1_score), Number(g.player2_score), Number(g.player3_score), Number(g.player4_score)];
    const names = [g.player1_name, g.player2_name, g.player3_name, g.player4_name].map(n => (n || "").trim());
    const idx = names.indexOf(targetName);
    if (idx === -1) return;
    const pts = calcPts(scores);
    allCum = +(allCum + pts[idx]).toFixed(1);
    cumByGame.set(g.id, allCum);
  });

  sliced.forEach(g => {
    const names = [g.player1_name, g.player2_name, g.player3_name, g.player4_name].map(n => (n || "").trim());
    const idx = names.indexOf(targetName);
    if (idx === -1) return;
    labels.push(g.id);
    cumPtData.push(cumByGame.get(g.id) ?? 0);
  });

  archiveGameIdPtChart = new Chart(canvas, {
    type: 'line',
    data: {
      labels,
      datasets: [{
        label: '누적 pt', data: cumPtData, borderColor: '#f5a623', backgroundColor: 'rgba(245,166,35,0.12)',
        pointRadius: 3, pointBackgroundColor: '#f5a623', borderWidth: 2, tension: 0.1, fill: false
      }]
    },
    options: {
      responsive: true, animation: false, interaction: { mode: 'index', intersect: false },
      plugins: { legend: { display: false }, tooltip: { callbacks: { title: (items) => `게임 #${items[0].label}` } } },
      scales: {
        x: { title: { display: true, text: '게임 ID', font: { size: 11 } }, ticks: { font: { size: 10 } } },
        y: { title: { display: true, text: '누적 pt', font: { size: 11 } }, ticks: { font: { size: 10 } }, grid: { color: 'rgba(0,0,0,0.06)' } }
      }
    }
  });
}

function calculateArchiveDailyHistory(targetName) {
  let all = [...CURRENT_ARCHIVE_GAMES].sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
  let stats = {};
  let history = [];
  let currentDate = null;

  all.forEach(game => {
    const d = new Date(game.created_at);
    const dateStr = d.toISOString().split('T')[0];
    if (currentDate && currentDate !== dateStr) snapshotArchive(history, currentDate, stats, targetName);
    currentDate = dateStr;

    const scores = [Number(game.player1_score), Number(game.player2_score), Number(game.player3_score), Number(game.player4_score)];
    const names = [game.player1_name, game.player2_name, game.player3_name, game.player4_name].map(n => (n || "").trim());
    const pts = calcPts(scores);

    names.forEach((name, idx) => {
      if (!name) return;
      if (!stats[name]) stats[name] = { total_pt: 0, games: 0 };
      stats[name].total_pt += pts[idx];
      stats[name].games += 1;
    });
  });

  if (currentDate) snapshotArchive(history, currentDate, stats, targetName);
  return history;
}

function snapshotArchive(history, date, stats, targetName) {
  if (!stats[targetName]) return;
  let players = Object.keys(stats);
  players.sort((a, b) => stats[b].total_pt - stats[a].total_pt);
  let ptRank = players.indexOf(targetName) + 1;

  history.push({
    date: date, total_pt: stats[targetName].total_pt, pt_rank: ptRank, total_players: players.length
  });
}


function renderArchiveHistoryGraph(name, range = "week") {
  const ctx = document.getElementById("archive-stats-daily-chart");
  if (!ctx) return;

  const fullHistory = calculateArchiveDailyHistory(name);
  let referenceDate = new Date();
  if (fullHistory.length > 0) referenceDate = new Date(fullHistory[fullHistory.length - 1].date);

  let startDate = new Date(referenceDate);
  if (range === 'week') startDate.setDate(startDate.getDate() - 6);
  else if (range === 'month') startDate.setDate(startDate.getDate() - 29);
  else if (fullHistory.length > 0) startDate = new Date(fullHistory[0].date);

  let data = [];
  let currentDate = new Date(startDate);
  let lastState = null;
  const startStr = startDate.toISOString().split('T')[0];

  for (let h of fullHistory) {
    if (h.date < startStr) lastState = h;
    else break;
  }

  while (currentDate <= referenceDate) {
    const dateStr = currentDate.toISOString().split('T')[0];
    const match = fullHistory.find(h => h.date === dateStr);
    if (match) lastState = match;
    if (lastState) data.push({ ...lastState, date: dateStr });
    currentDate.setDate(currentDate.getDate() + 1);
  }

  let maxRank = 10;
  if (data.length > 0) maxRank = Math.max(...data.map(h => h.total_players || 10));

  if (archiveStatsChart) archiveStatsChart.destroy();

  archiveStatsChart = new Chart(ctx, {
    type: 'line',
    data: {
      labels: data.map(h => h.date.slice(5)),
      datasets: [
        { label: '총 pt', data: data.map(h => h.total_pt), borderColor: '#4f9cff', backgroundColor: '#4f9cff', yAxisID: 'y', tension: 0.1, pointRadius: 3 }
      ]
    },
    options: {
      responsive: true, maintainAspectRatio: false, interaction: { mode: 'index', intersect: false },
      plugins: { legend: { display: false } },
      scales: {
        y: { type: 'linear', display: true, position: 'left', title: { display: true, text: 'pt' } }
      }
    }
  });

  document.querySelectorAll('.archive-chart-filter-btn').forEach(btn => {
    if (btn.dataset.range === range) btn.classList.add('active');
    else btn.classList.remove('active');
  });
}

function setupArchiveRankingSort() {
  const table = document.getElementById("archive-ranking-table");
  if (!table) return;
  table.querySelectorAll("th.sortable[data-sort-key]").forEach(th => {
    th.addEventListener("click", () => {
      const key = th.dataset.sortKey;
      if (ARCHIVE_RANKING_SORT.key === key) ARCHIVE_RANKING_SORT.dir = (ARCHIVE_RANKING_SORT.dir === "desc" ? "asc" : "desc");
      else { ARCHIVE_RANKING_SORT.key = key; ARCHIVE_RANKING_SORT.dir = "desc"; }

      renderRankingTable("archive-ranking-tbody", ARCHIVE_PLAYER_SUMMARY, ARCHIVE_RANKING_SORT, "archive-ranking-table", "통계 없음");
    });
  });
}

function updateArchivePlayerSelect() {
  const select = document.getElementById("archive-player-select");
  if (!select) return;
  const prev = select.value;
  select.innerHTML = '<option value="">플레이어를 선택하세요</option>';

  // Sort logic same as original: Total Pt Desc
  const sorted = [...ARCHIVE_PLAYER_SUMMARY].sort((a, b) => b.total_pt - a.total_pt);

  sorted.forEach(p => {
    const opt = document.createElement("option");
    opt.value = p.name;
    opt.textContent = `${p.name} (${p.games}국, ${p.total_pt.toFixed(1)}pt)`;
    select.appendChild(opt);
  });

  if (prev && sorted.some(p => p.name === prev)) {
    select.value = prev;
    renderArchiveStatsForPlayer(prev);
  } else {
    renderArchiveStatsForPlayer("");
  }
}

async function reloadArchiveList() {
  let archives = [];
  try { archives = await fetchJSON(`${API_BASE}/api/archives`); } catch (e) { console.error(e); }
  ARCHIVES = archives || [];

  // Admin List
  const tbody = document.getElementById("archive-list-tbody");
  if (tbody) {
    tbody.innerHTML = "";
    if (!ARCHIVES.length) tbody.innerHTML = '<tr><td colspan="4" class="ranking-placeholder">아카이브 없음</td></tr>';
    else {
      ARCHIVES.forEach((a, ai) => {
        const tr = document.createElement("tr");
        tr.className = ""
        tr.innerHTML = `<td>${a.name}</td><td>${formatKoreanTime(a.created_at)}</td><td>${a.game_count || 0}</td><td></td>`;
        const btn = document.createElement("button");
        btn.textContent = "삭제";
        btn.onclick = () => {
          showConfirm("삭제합니까?", async () => {
            try { await fetchJSON(`${API_BASE}/api/archives/${a.id}`, { method: "DELETE" }); reloadArchiveList(); }
            catch (e) { alert("실패"); }
          });
        };
        tr.children[3].appendChild(btn);
        tbody.appendChild(tr);
      });
    }
  }

  // Dropdown
  const sel = document.getElementById("archive-select");
  if (sel) {
    const prev = sel.value;
    sel.innerHTML = '<option value="">아카이브를 선택하세요</option>';
    ARCHIVES.forEach(a => {
      const opt = document.createElement("option");
      opt.value = a.id;
      opt.textContent = a.name;
      sel.appendChild(opt);
    });
    if (prev && ARCHIVES.some(a => String(a.id) === String(prev))) {
      sel.value = prev;
      loadArchiveGames(prev);
    } else {
      loadArchiveGames("");
    }
  }
}

async function loadArchiveGames(id) {
  if (!id) {
    renderGameList("archive-games-tbody", [], { useIndexNumbering: true });
    renderRankingTable("archive-ranking-tbody", [], ARCHIVE_RANKING_SORT, "archive-ranking-table", "아카이브 없음");
    CURRENT_ARCHIVE_GAMES = [];
    ARCHIVE_PLAYER_SUMMARY = [];
    ARCHIVE_VIEW_MODE = "ranking"; // 초기화
    renderArchiveView();
    return;
  }

  try {
    let games = await fetchJSON(`${API_BASE}/api/archives/${id}/games`);
    games = (games || []).slice().sort((a, b) => (b.id || 0) - (a.id || 0));
    CURRENT_ARCHIVE_GAMES = games;

    // 1. Render Games (with index-based numbering)
    renderGameList("archive-games-tbody", games, { useIndexNumbering: true });

    // 2. Calc Stats
    ARCHIVE_PLAYER_SUMMARY = calculateStatsFromGames(games);

    // 3. Render Ranking
    renderRankingTable("archive-ranking-tbody", ARCHIVE_PLAYER_SUMMARY, ARCHIVE_RANKING_SORT, "archive-ranking-table", "데이터 없음");

    // 4. Render View (ranking or stats)
    renderArchiveView();

  } catch (e) {
    console.error(e);
    alert("아카이브 로드 실패");
  }
}

function renderArchiveStatsForPlayer(name) {
  const summaryDiv = document.getElementById("archive-stats-summary");
  const rankSection = document.getElementById("archive-stats-rank-section");
  const gamesSection = document.getElementById("archive-stats-games-section");
  const dailySection = document.getElementById("archive-stats-daily-section");
  const coSection = document.getElementById("archive-stats-co-section");

  const distDiv = document.getElementById("archive-stats-rank-dist");
  const coTbody = document.getElementById("archive-stats-co-tbody");
  const playerGamesTbody = document.getElementById("archive-stats-player-games-tbody");
  const chartHint = document.getElementById("archive-chart-hint");

  if (!summaryDiv) return;

  if (!name) {
    summaryDiv.innerHTML = '';
    if (rankSection) rankSection.style.display = "none";
    if (gamesSection) gamesSection.style.display = "none";
    if (dailySection) dailySection.style.display = "none";
    if (coSection) coSection.style.display = "none";

    if (distDiv) distDiv.innerHTML = "";
    if (coTbody) coTbody.innerHTML = '<tr><td colspan="4" class="ranking-placeholder">데이터 없음</td></tr>';
    if (playerGamesTbody) playerGamesTbody.innerHTML = '<tr><td colspan="5" class="ranking-placeholder">데이터 없음</td></tr>';

    // 차트 초기화 및 힌트 표시
    if (archiveStatsChart) { archiveStatsChart.destroy(); archiveStatsChart = null; }
    if (archiveRankTrendChart) { archiveRankTrendChart.destroy(); archiveRankTrendChart = null; }
    if (archiveGameIdPtChart) { archiveGameIdPtChart.destroy(); archiveGameIdPtChart = null; }
    if (chartHint) chartHint.style.display = "block";

    return;
  }

  // Show sections
  if (rankSection) rankSection.style.display = "block";
  if (gamesSection) gamesSection.style.display = "block";
  if (dailySection) dailySection.style.display = "block";
  if (coSection) coSection.style.display = "block";

  // Hide chart hint
  if (chartHint) chartHint.style.display = "none";

  // Render graph (전체 데이터)
  renderArchiveHistoryGraph(name, "week");

  // 하위 차트(등수 및 pt 추이) - 버튼 초기화 후 기본 10국으로 렌더
  document.querySelectorAll('.archive-combined-filter-btn').forEach(b => b.classList.remove('active'));
  const defaultArchiveCombinedBtn = document.querySelector('.archive-combined-filter-btn[data-limit="10"]');
  if (defaultArchiveCombinedBtn) defaultArchiveCombinedBtn.classList.add('active');
  renderArchiveRecentRankTrend(name, 10);
  renderArchiveGameIdPtChart(name, 10);

  const detail = computePlayerDetailStats(name, CURRENT_ARCHIVE_GAMES);

  // Summary
  summaryDiv.innerHTML = `
    <div class="stats-summary-main">
      <div><span class="stats-label">플레이어</span> <span class="stats-value">${name}</span></div>
      <div><span class="stats-label">대국 수</span> <span class="stats-value">${detail.games}</span></div>
      <div><span class="stats-label">총 pt</span> <span class="stats-value">${detail.total_pt.toFixed(1)}</span></div>
      <div><span class="stats-label">연대율</span> <span class="stats-value">${detail.yonde_rate.toFixed(1)}%</span></div>
      <div><span class="stats-label">토비율</span> <span class="stats-value">${detail.tobi_rate.toFixed(1)}% (${detail.tobi_count}회)</span></div>
      <div><span class="stats-label">최다 pt</span> <span class="stats-value">${detail.max_score}</span></div>
    </div>
  `;

  // Distribution
  if (distDiv) {
    distDiv.innerHTML = "";
    distDiv.appendChild(createRankDistBar(detail.rankCounts, detail.games));
  }

  const archiveAvgRankSpan = document.getElementById("archive-stats-avg-rank");
  if (archiveAvgRankSpan) {
    archiveAvgRankSpan.textContent = detail.games > 0 ? `평균 등수: ${detail.avg_rank.toFixed(2)}` : "평균 등수: -";
  }

  // Co-Players
  if (coTbody) {
    coTbody.innerHTML = "";
    if (detail.coPlayers.length) {
      detail.coPlayers.forEach((c, ci) => {
        const tr = document.createElement("tr");
        tr.className = ""
        tr.innerHTML = `<td>${c.name}</td><td>${c.games}</td><td>${c.my_avg_rank.toFixed(2)}</td><td>${c.co_avg_rank.toFixed(2)}</td>`;
        coTbody.appendChild(tr);
      });
    } else {
      coTbody.innerHTML = '<tr><td colspan="4" class="ranking-placeholder">데이터 없음</td></tr>';
    }
  }

  // Game Records
  if (playerGamesTbody) {
    playerGamesTbody.innerHTML = "";
    if (detail.gameRecords.length) {
      detail.gameRecords.forEach((rec, ri) => {
        const tr = document.createElement("tr");
        tr.className = ""
        const tdTime = document.createElement("td");
        tdTime.textContent = formatKoreanTime(rec.created_at);
        tr.appendChild(tdTime);
        rec.names.forEach((n, i) => {
          const td = document.createElement("td");
          td.innerHTML = `<strong>${n}</strong><br>${rec.scores[i]} (${rec.pts[i].toFixed(1)})`;
          const isWinner = rec.ranks[i] === 1;
          const isMyPlayer = i === rec.myIndex;
          if (isWinner) {
            td.classList.add("winner-cell");
          } else if (isMyPlayer) {
            td.classList.add("my-player-cell");
          }
          tr.appendChild(td);
        });
        playerGamesTbody.appendChild(tr);
      });
    } else {
      playerGamesTbody.innerHTML = '<tr><td colspan="5" class="ranking-placeholder">기록 없음</td></tr>';
    }
  }
}


// ======================= 대회 전용 =======================

function setupTournamentForm() {
  // Similar to personal form
  const form = document.getElementById("tournament-game-form");
  if (!form) return;
  form.addEventListener("submit", async e => {
    e.preventDefault();
    const fd = new FormData(form);
    const p1 = (fd.get("player1_name") || "").trim();
    const p2 = (fd.get("player2_name") || "").trim();
    const p3 = (fd.get("player3_name") || "").trim();
    const p4 = (fd.get("player4_name") || "").trim();
    const s1 = parseInt(fd.get("player1_score"), 10);
    const s2 = parseInt(fd.get("player2_score"), 10);
    const s3 = parseInt(fd.get("player3_score"), 10);
    const s4 = parseInt(fd.get("player4_score"), 10);

    const targetSum = START_SCORE * 4;
    if ([s1, s2, s3, s4].some(Number.isNaN) || (s1 + s2 + s3 + s4 !== targetSum)) return alert("pt 합계 오류");

    try {
      await fetchJSON(`${API_BASE}/api/tournament_games`, {
        method: "POST",
        body: JSON.stringify({ player1_name: p1, player2_name: p2, player3_name: p3, player4_name: p4, player1_score: s1, player2_score: s2, player3_score: s3, player4_score: s4 })
      });
      form.reset();
      loadTournamentGamesAndRanking();
    } catch (e) { console.error(e); alert("실패"); }
  });
}

async function loadTournamentGamesAndRanking() {
  let games = [];
  try { games = await fetchJSON(`${API_BASE}/api/tournament_games`); } catch (e) { console.error(e); }
  games = (games || []).slice().sort((a, b) => (b.id || 0) - (a.id || 0));
  TOURNAMENT_GAMES = games;

  renderGameList("tournament-games-tbody", games, {
    onDelete: (id) => {
      showConfirm("삭제?", async () => {
        await fetchJSON(`${API_BASE}/api/tournament_games/${id}`, { method: "DELETE" });
        loadTournamentGamesAndRanking();
      });
    }
  });

  const players = calculateStatsFromGames(games);
  players.sort((a, b) => b.total_pt - a.total_pt); // 대회는 기본 pt순

  renderRankingTable("tournament-ranking-tbody", players, { key: "total_pt", dir: "desc" }, null); // No clickable sort required in original but clean
}


// ======================= 시즌 pt 관련 =======================

function setupRankingTitleToggle() {
  const title = document.getElementById("ranking-title");
  if (title) {
    title.addEventListener("click", () => {
      RANKING_VIEW_MODE = (RANKING_VIEW_MODE === "pt" ? "season" : "pt");
      renderMainRanking();
    });
  }
}

function renderMainRanking() {
  const ptWrap = document.getElementById("ranking-pt-wrap");
  const seasonWrap = document.getElementById("ranking-season-wrap");
  const title = document.getElementById("ranking-title");
  const legend = document.querySelector(".rank-legend");

  // Title Update
  if (title) {
    title.textContent = RANKING_VIEW_MODE === "season" ? "시즌 pt" : "전체 등수";
  }

  // Legend Toggle
  if (legend) legend.style.display = "";

  // Visibility Toggle
  if (ptWrap) ptWrap.style.display = RANKING_VIEW_MODE === "season" ? "none" : "block";
  if (seasonWrap) seasonWrap.style.display = RANKING_VIEW_MODE === "season" ? "block" : "none";

  // Content Rendering
  if (RANKING_VIEW_MODE === "season") {
    renderSeasonRankingTable();
  } else {
    renderRankingTable("ranking-tbody", PLAYER_SUMMARY, RANKING_SORT, "ranking-table", "통계 없음");
  }
}

async function buildSeasonSummary(playersAll) {
  // Need archive stats
  const seasonT = await loadSeasonTournamentStats(); // helper
  return playersAll.filter(p => p.games >= 4).map(p => {
    const totalPt = p.total_pt;
    const games = p.games;
    const t = seasonT?.[p.name] || { joinCount: 0, ptSum: 0 };

    // Formula (Use Helper)
    const scores = calculateSeasonScore(totalPt, games, t.joinCount, t.ptSum);

    return {
      name: p.name,
      total_pt_score: scores.totalPtScore,
      games_score: scores.gamesScore,
      tournament_score: scores.tournamentScore,
      season_score: scores.sum
    };
  }).sort((a, b) => b.season_score - a.season_score);
}


async function loadSeasonTournamentStats() {
  if (SEASON_TOURNAMENT_STATS) return SEASON_TOURNAMENT_STATS;

  // Fetch archives, filter by MONTHLY TOURNAMENT pattern
  let archives = [];
  try { archives = await fetchJSON(`${API_BASE}/api/archives`); } catch (e) { return {}; }

  // Pattern: "YYYY MM월" or "YY MM월" matching SEASON_YEAR2
  // Minimal pattern check:
  const target = archives.filter(a => {
    const s = (a.name || "");
    if (!s.includes("대회")) return false;
    const m = s.match(/(?:20)?(\d{2})\s*[-년]?\s*(\d{1,2})\s*월/);
    if (!m) return false;
    return Number(m[1]) === SEASON_YEAR2 && Number(m[2]) >= SEASON_FROM && Number(m[2]) <= SEASON_TO;
  });

  const map = {}; // name -> { joined: Set, ptSum: 0 }

  for (const a of target) {
    let games = [];
    try { games = await fetchJSON(`${API_BASE}/api/archives/${a.id}/games`); } catch (e) { continue; }

    const appeared = new Set();
    games.forEach(g => {
      const scores = [g.player1_score, g.player2_score, g.player3_score, g.player4_score].map(Number);
      const names = [g.player1_name, g.player2_name, g.player3_name, g.player4_name].map(n => (n || "").trim());
      const pts = calcPts(scores);

      names.forEach((n, i) => {
        if (!n) return;
        appeared.add(n);
        if (!map[n]) map[n] = { joined: new Set(), ptSum: 0 };
        map[n].ptSum += Math.max(pts[i], 0); // Only positive
      });
    });

    appeared.forEach(n => {
      if (map[n]) map[n].joined.add(a.id);
    });
  }

  const out = {};
  Object.keys(map).forEach(n => {
    out[n] = { joinCount: map[n].joined.size, ptSum: map[n].ptSum };
  });
  SEASON_TOURNAMENT_STATS = out;
  return out;
}

function renderSeasonRankingTable() {
  const tbody = document.getElementById("season-ranking-tbody");
  if (!tbody) return;
  const data = SEASON_SUMMARY || [];
  tbody.innerHTML = "";
  if (!data.length) { tbody.innerHTML = '<tr><td colspan="6" class="ranking-placeholder">통계 없음</td></tr>'; return; }

  data.forEach((p, idx) => {
    const tr = document.createElement("tr");
    tr.className = ""
    tr.innerHTML = `
            <td>${idx + 1}</td>
            <td>${p.name}</td>
            <td>${p.total_pt_score.toFixed(1)}</td>
            <td>${p.games_score.toFixed(1)}</td>
            <td>${p.tournament_score.toFixed(1)}</td>
            <td><strong>${p.season_score.toFixed(1)}</strong></td>
        `;
    tbody.appendChild(tr);
  });
}


// ======================= 관리자 =======================

function setupAdminView() {


  // 초기화
  const rsb = document.getElementById("reset-games-btn");
  if (rsb) {
    rsb.addEventListener("click", () => {
      showConfirm("정말 개인전 기록을 초기화하시겠습니까?", async () => {
        await fetchJSON(`${API_BASE}/api/admin/reset_games`, { method: "POST" });
        loadGamesAndRanking();
      });
    });
  }

  const rstb = document.getElementById("reset-tournament-btn");
  if (rstb) {
    rstb.addEventListener("click", () => {
      showConfirm("정말 대회 기록을 초기화하시겠습니까?", async () => {
        await fetchJSON(`${API_BASE}/api/admin/reset_tournament`, { method: "POST" });
        loadTournamentGamesAndRanking();
      });
    });
  }
}

async function reloadBadgeList() {
  let badges = [];
  try { badges = await fetchJSON(`${API_BASE}/api/badges`); } catch (e) { }
  ALL_BADGES = badges;

  // List
  const tbody = document.getElementById("badge-list-tbody");
  if (tbody) {
    tbody.innerHTML = "";
    if (badges.length === 0) {
      tbody.innerHTML = '<tr><td colspan="4" class="ranking-placeholder">뱃지 없음</td></tr>';
      return;
    }

    const groups = {};
    badges.forEach(b => {
      const groupKey = Math.floor(b.code / 100) * 100;
      if (!groups[groupKey]) groups[groupKey] = [];
      groups[groupKey].push(b);
    });

    const sortedGroups = Object.keys(groups).map(Number).sort((a, b) => a - b);

    sortedGroups.forEach(groupStart => {
      const groupEnd = groupStart + 99;
      const groupBadges = groups[groupStart];
      
      const headerTr = document.createElement("tr");
      headerTr.style.cursor = "pointer";
      headerTr.innerHTML = `
        <td colspan="4" style="text-align: left; font-weight: 600; padding: 12px 16px; background-color: rgba(0,0,0,0.03);">
          <span class="toggle-icon" style="display:inline-block; width:20px; text-align:center;">▶</span>
          ${groupStart} ~ ${groupEnd} <span style="font-size:0.9em; color:#666; margin-left:8px;">(${groupBadges.length}개)</span>
        </td>
      `;
      tbody.appendChild(headerTr);

      const rows = [];
      groupBadges.forEach(b => {
        const tr = document.createElement("tr");
        tr.style.display = 'none';
        tr.innerHTML = `<td>${b.code}</td><td>${b.name}</td><td>${b.grade}</td><td>${b.description || ""}</td>`;
        tbody.appendChild(tr);
        rows.push(tr);
      });

      let isOpen = false;
      headerTr.onclick = () => {
        isOpen = !isOpen;
        headerTr.querySelector('.toggle-icon').textContent = isOpen ? '▼' : '▶';
        rows.forEach(r => r.style.display = isOpen ? '' : 'none');
      };
    });
  }


}



// ==========================================
// 그래프 관련 로직 (Daily Stats Graph)
// ==========================================

let statsChart = null; // Chart.js instance

// 날짜별 이력 계산
// Returns: { dates: [], totalPts: [], seasonScores: [], totalPtRanks: [], seasonScoreRanks: [] }
function calculateDailyHistory(targetName) {
  // 1. 모든 게임(일반 + 대회)을 시간순 정렬
  let all = [...ALL_GAMES, ...TOURNAMENT_GAMES];
  all.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));

  // 플레이어별 상태 추적
  let stats = {};

  // 날짜별 스냅샷
  let history = [];

  // 헬퍼: 현재 상태에서 시즌 스코어 계산
  const getSeasonScore = (s) => {
    if (!s) return 0;
    const tJoin = s.tournament ? s.tournament.join : 0;
    const tSum = s.tournament ? s.tournament.sum : 0;
    return calculateSeasonScore(s.total_pt, s.games, tJoin, tSum).sum;
  };

  // 게임 순회
  let currentDate = null;

  all.forEach(game => {
    // 날짜 체크 (YYYY-MM-DD)
    const d = new Date(game.created_at);
    const dateStr = d.toISOString().split('T')[0];

    if (currentDate && currentDate !== dateStr) {
      // 날짜가 바뀌기 직전 스냅샷 저장
      snapshot(history, currentDate, stats, targetName, getSeasonScore);
    }
    currentDate = dateStr;

    // 게임 반영
    const scores = [
      Number(game.player1_score), Number(game.player2_score),
      Number(game.player3_score), Number(game.player4_score),
    ];
    const names = [
      game.player1_name, game.player2_name,
      game.player3_name, game.player4_name,
    ].map((n) => (n || "").trim());

    // pt 계산
    const pts = calcPts(scores);

    names.forEach((name, idx) => {
      if (!name) return;
      if (!stats[name]) stats[name] = { total_pt: 0, games: 0, tournament: { join: 0, sum: 0 } };

      const pt = pts[idx];

      if (game.is_tournament_flag) {
        stats[name].tournament.join += 1;
        stats[name].tournament.sum += pt;
      } else {
        stats[name].total_pt += pt;
        stats[name].games += 1;
      }
    });
  });

  // 마지막 날짜 스냅샷
  if (currentDate) {
    snapshot(history, currentDate, stats, targetName, getSeasonScore);
  }

  return history;
}

// 스냅샷 저장 헬퍼
function snapshot(history, date, stats, targetName, scoreFn) {
  if (!stats[targetName]) {
    // 아직 데뷔 전이면 0으로라도 기록? 아니면 기록 없음?
    // 그래프 연결을 위해 0으로 기록하는게 나을 수 있음.
    // 하지만 여기선 데뷔 이후부터만 표시하도록 함.
    return;
  }

  // 전체 플레이어 랭킹 산출
  let players = Object.keys(stats);

  // 1. Total PT Rank
  players.sort((a, b) => stats[b].total_pt - stats[a].total_pt);
  let ptRank = players.indexOf(targetName) + 1;

  // 2. Season Score Rank
  players.sort((a, b) => scoreFn(stats[b]) - scoreFn(stats[a]));
  let seasonRank = players.indexOf(targetName) + 1;

  history.push({
    date: date,
    total_pt: stats[targetName].total_pt,
    season_score: scoreFn(stats[targetName]),
    pt_rank: ptRank,
    season_rank: seasonRank,
    total_players: players.length // 전체 플레이어 수 저장
  });
}

function renderHistoryGraph(targetName, range) {
  const ctx = document.getElementById("stats-daily-chart");
  if (!ctx) return;

  // 대회 게임 식별용 플래그 마킹
  TOURNAMENT_GAMES.forEach(g => g.is_tournament_flag = true);
  ALL_GAMES.forEach(g => g.is_tournament_flag = false);

  const fullHistory = calculateDailyHistory(targetName);

  // 기간 필터링
  let data = fullHistory;

  // 기준 날짜를 마지막 플레이 날짜로 설정 (데이터가 없으면 오늘 기준)
  let referenceDate = new Date();
  if (fullHistory.length > 0) {
    referenceDate = new Date(fullHistory[fullHistory.length - 1].date);
  }

  // 시작 날짜 계산
  let startDate = new Date(referenceDate);
  if (range === 'week') {
    startDate.setDate(startDate.getDate() - 6); // 7일간 (오늘 포함)
  } else if (range === 'month') {
    startDate.setDate(startDate.getDate() - 29); // 30일간
  } else {
    // 'all': 첫 기록 날짜부터
    if (fullHistory.length > 0) {
      startDate = new Date(fullHistory[0].date);
    }
  }

  // 날짜 간격 메우기 (Gap Filling)
  data = [];
  let currentDate = new Date(startDate);

  // 시작일 이전의 가장 최근 상태 찾기
  // (범위 시작일 전의 마지막 기록을 초기값으로 사용)
  let lastState = null;
  const startStr = startDate.toISOString().split('T')[0];

  // fullHistory는 날짜순 정렬되어 있다고 가정
  for (let h of fullHistory) {
    if (h.date < startStr) lastState = h;
    else break;
  }

  // 기준일까지 하루씩 증가
  while (currentDate <= referenceDate) {
    const dateStr = currentDate.toISOString().split('T')[0];

    // 해당 날짜에 기록이 있는지 확인
    const match = fullHistory.find(h => h.date === dateStr);

    if (match) {
      lastState = match;
    }

    // 상태가 있으면 기록 (없으면, 즉 데뷔 전이면 null 채우거나 스킵)
    // 여기서는 null을 넣으면 그래프가 끊김. 
    // 그냥 lastState가 있을 때만 push? 
    // 데뷔 전 날짜는 표시 안하는게 맞음.
    if (lastState) {
      // date만 현재 날짜로 바꿔서 push (참조 끊기 위해 spread 사용)
      data.push({ ...lastState, date: dateStr });
    }

    currentDate.setDate(currentDate.getDate() + 1);
  }

  // y1 축 범위 설정을 위한 최대 등수 계산 (해당 기간 내 최대 참여 인원수)
  let maxRank = 10;
  if (data.length > 0) {
    // total_players 중 최댓값을 Y축 max로 설정
    maxRank = Math.max(...data.map(h => h.total_players || 10));
    // 여유 공간 조금? (정수 단위이므로 딱 맞춰도 됨)
  }

  if (statsChart) {
    statsChart.destroy();
  }

  statsChart = new Chart(ctx, {
    type: 'line',
    data: {
      labels: data.map(h => h.date.slice(5)), // MM-DD
      datasets: [
        {
          label: '총 pt',
          data: data.map(h => h.total_pt),
          borderColor: '#4f9cff',
          backgroundColor: '#4f9cff',
          yAxisID: 'y',
          tension: 0.1,
          pointRadius: 3
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: {
        mode: 'index',
        intersect: false,
      },
      plugins: {
        legend: { display: false }
      },
      scales: {
        y: {
          type: 'linear',
          display: true,
          position: 'left',
          title: { display: true, text: 'pt' }
        }
      }
    }
  });

  // 버튼 활성화 상태 업데이트
  document.querySelectorAll('.chart-filter-btn').forEach(btn => {
    if (btn.dataset.range === range) btn.classList.add('active');
    else btn.classList.remove('active');
  });
}

// ======================= 게임 ID별 pt 차트 =======================

let statsGameIdPtChart = null;

function renderGameIdPtChart(targetName, limit = 10) {
  const canvas = document.getElementById("stats-gameid-pt-chart");
  if (!canvas) return;

  if (statsGameIdPtChart) {
    statsGameIdPtChart.destroy();
    statsGameIdPtChart = null;
  }

  if (!targetName || !ALL_GAMES || ALL_GAMES.length === 0) return;

  // 해당 플레이어가 참가한 게임만 시간순(ID 오름차순)으로 추출
  const myGames = ALL_GAMES
    .filter(g => {
      const names = [g.player1_name, g.player2_name, g.player3_name, g.player4_name]
        .map(n => (n || "").trim());
      return names.includes(targetName);
    })
    .slice() // ALL_GAMES는 내림차순이므로 복사 후 역순
    .reverse();

  if (myGames.length === 0) return;

  // limit=0이면 전체, 아니면 최근 N국
  const sliced = (limit > 0) ? myGames.slice(-limit) : myGames;

  const labels = [];     // 게임 ID
  const ptData = [];     // 각 게임 pt
  const cumPtData = [];  // 누적 pt
  let cumPt = 0;

  // 누적 pt는 전체 기준으로 먼저 계산 후, sliced 범위만 표시
  let allCum = 0;
  const cumByGame = new Map();
  myGames.forEach(g => {
    const scores = [
      Number(g.player1_score), Number(g.player2_score),
      Number(g.player3_score), Number(g.player4_score)
    ];
    const names = [g.player1_name, g.player2_name, g.player3_name, g.player4_name]
      .map(n => (n || "").trim());
    const idx = names.indexOf(targetName);
    if (idx === -1) return;
    const pts = calcPts(scores);
    allCum = +(allCum + pts[idx]).toFixed(1);
    cumByGame.set(g.id, allCum);
  });

  sliced.forEach(g => {
    const scores = [
      Number(g.player1_score), Number(g.player2_score),
      Number(g.player3_score), Number(g.player4_score)
    ];
    const names = [g.player1_name, g.player2_name, g.player3_name, g.player4_name]
      .map(n => (n || "").trim());
    const idx = names.indexOf(targetName);
    if (idx === -1) return;

    labels.push(g.id);
    cumPtData.push(cumByGame.get(g.id) ?? 0);
  });

  statsGameIdPtChart = new Chart(canvas, {
    type: 'line',
    data: {
      labels,
      datasets: [
        {
          label: '누적 pt',
          data: cumPtData,
          borderColor: '#f5a623',
          backgroundColor: 'rgba(245,166,35,0.12)',
          pointRadius: 3,
          pointBackgroundColor: '#f5a623',
          borderWidth: 2,
          tension: 0.1,
          fill: false
        }
      ]
    },
    options: {
      responsive: true,
      animation: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            title: (items) => `게임 #${items[0].label}`
          }
        }
      },
      scales: {
        x: {
          title: { display: true, text: '게임 ID', font: { size: 11 } },
          ticks: { font: { size: 10 } }
        },
        y: {
          title: { display: true, text: '누적 pt', font: { size: 11 } },
          ticks: { font: { size: 10 } },
          grid: { color: 'rgba(0,0,0,0.06)' }
        }
      }
    }

  });
}


function setupChartFilters() {
  document.querySelectorAll('.chart-filter-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const range = e.target.dataset.range;
      const select = document.getElementById("stats-player-select");
      if (select && select.value) {
        renderHistoryGraph(select.value, range);
      }
    });
  });

  document.querySelectorAll('.combined-filter-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const limit = Number(e.target.dataset.limit);
      const select = document.getElementById("stats-player-select");
      document.querySelectorAll('.combined-filter-btn').forEach(b => b.classList.remove('active'));
      e.target.classList.add('active');
      if (select && select.value) {
        renderRecentRankTrend(select.value, limit);
        renderGameIdPtChart(select.value, limit);
      }
    });
  });

  document.querySelectorAll('.archive-chart-filter-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const range = e.target.dataset.range;
      const select = document.getElementById("archive-stats-player-select");
      if (select && select.value) {
        renderArchiveHistoryGraph(select.value, range);
      }
    });
  });

  document.querySelectorAll('.archive-combined-filter-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const limit = Number(e.target.dataset.limit);
      const select = document.getElementById("archive-stats-player-select");
      document.querySelectorAll('.archive-combined-filter-btn').forEach(b => b.classList.remove('active'));
      e.target.classList.add('active');
      if (select && select.value) {
        renderArchiveRecentRankTrend(select.value, limit);
        renderArchiveGameIdPtChart(select.value, limit);
      }
    });
  });
}



// 전체 플레이어 pt 그래프 렌더링


// ==========================================
// 최근 등수 추이 그래프 (10/20/50국)
// ==========================================

let rankTrendChart = null;

function renderRecentRankTrend(targetName, limit = 10) {
  const ctx = document.getElementById("stats-rank-trend-chart");
  if (!ctx) return;

  // 플레이어 게임 데이터 추출 (최신순)
  let all = [...ALL_GAMES, ...TOURNAMENT_GAMES];
  all.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

  const myGames = [];
  for (const g of all) {
    const names = [g.player1_name, g.player2_name, g.player3_name, g.player4_name].map(n => (n || "").trim());
    const idx = names.indexOf(targetName);
    if (idx !== -1) {
      const scores = [g.player1_score, g.player2_score, g.player3_score, g.player4_score].map(Number);
      const order = scores.map((s, i) => ({ s, i })).sort((a, b) => b.s - a.s);
      const ranks = [0, 0, 0, 0];
      order.forEach((o, pos) => ranks[o.i] = pos + 1);

      myGames.push({
        id: g.id,
        rank: ranks[idx],
        score: scores[idx],
        date: g.created_at
      });
    }
    if (limit > 0 && myGames.length >= limit) break;
  }

  if (myGames.length === 0) {
    if (rankTrendChart) {
      rankTrendChart.destroy();
      rankTrendChart = null;
    }
    return;
  }

  const chartData = myGames.reverse();
  const totalRank = chartData.reduce((sum, g) => sum + g.rank, 0);
  const avgRank = totalRank / chartData.length;

  const labels = chartData.map((_, i) => i + 1);
  const ranks = chartData.map(g => g.rank);
  const avgData = Array(chartData.length).fill(avgRank);

  const pointColors = ranks.map(r => {
    if (r === 1) return '#4dd2a6'; // 초록 (1등)
    if (r === 2) return '#4f9cff'; // 파랑 (2등)
    if (r === 3) return '#d9d9d9'; // 회색 (3등)
    return '#ff6b81'; // 빨강 (4등)
  });

  const pointStyles = chartData.map(g => {
    if (g.score < 0) return 'crossRot'; // 토비 (0점 미만)
    if (g.rank === 1 && g.score >= 50000) return 'rectRot'; // 1등 50000점 이상
    return 'circle'; // 기본 동그라미
  });

  if (rankTrendChart) {
    rankTrendChart.destroy();
  }

  rankTrendChart = new Chart(ctx, {
    type: 'line',
    data: {
      labels: labels,
      datasets: [
        {
          label: '등수',
          data: ranks,
          borderColor: '#333',
          borderWidth: 2,
          pointBackgroundColor: pointColors,
          pointBorderColor: '#000',
          pointBorderWidth: chartData.map(g => g.score < 0 ? 3 : 2),
          pointRadius: 6,
          pointHoverRadius: 8,
          pointStyle: pointStyles,
          fill: false,
          tension: 0,
          yAxisID: 'y'
        },
        {
          label: `평균 등수 (${avgRank.toFixed(2)})`,
          data: avgData,
          borderColor: '#bbb',
          borderWidth: 2,
          borderDash: [5, 5],
          pointRadius: 0,
          fill: false,
          yAxisID: 'y'
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      layout: {
        padding: {
          top: 20,
          bottom: 20,
          right: 20
        }
      },
      interaction: {
        mode: 'index',
        intersect: false,
      },
      plugins: {
        legend: {
          display: false
        },
        tooltip: {
          enabled: false
        }
      },
      scales: {
        y: {
          display: true,
          reverse: true,
          min: 0.5,
          max: 4.5,
          title: {
            display: true,
            text: '등수',
            color: '#666',
            font: {
              size: 12,
              weight: 'bold'
            }
          },
          ticks: {
            display: true,
            color: '#666',
            font: {
              size: 12,
            },
            padding: 10,
            callback: function (value) {
              if (Number.isInteger(value)) return value;
              return null;
            }
          },
          grid: {
            display: true,
            drawBorder: false,
            color: '#bbb',
            lineWidth: 1
          },
          border: {
            display: true
          }
        },
        x: {
          display: false
        }
      }
    }
  });

  // Note: active toggle is handled in setupChartFilters's click event listener 
  // but we should keep it in sync here if this function is called directly
  document.querySelectorAll('.combined-filter-btn').forEach(btn => {
    if (Number(btn.dataset.limit) === limit) btn.classList.add('active');
    else btn.classList.remove('active');
  });
}

// ======================= 모바일 풀스크린 패널 슬라이드 =======================

function setupMobileSwipe() {
  if (window.innerWidth > 700) return;

  document.querySelectorAll('.view').forEach(view => {
    const layout = view.querySelector('.main-layout');
    if (!layout) return;

    // 이미 초기화됐으면 스킵
    if (layout.dataset.mobileInit === '1') return;
    layout.dataset.mobileInit = '1';

    const leftPanel = layout.querySelector('.left-panel');
    const rightPanel = layout.querySelector('.right-panel');
    if (!leftPanel || !rightPanel) return;

    // 도트 인디케이터 생성
    const tabs = document.createElement('div');
    tabs.className = 'mobile-panel-tabs';
    tabs.innerHTML =
      '<div class="mobile-panel-tab active" data-idx="0"></div>' +
      '<div class="mobile-panel-tab"         data-idx="1"></div>';
    layout.insertBefore(tabs, layout.firstChild);

    // track으로 감싸기
    const track = document.createElement('div');
    track.className = 'mobile-track';
    track.appendChild(leftPanel);
    track.appendChild(rightPanel);
    layout.appendChild(track);

    let currentIdx = 0;

    function goTo(idx) {
      currentIdx = idx;
      track.style.transform = 'translateX(-' + (idx * 100) + '%)';
      tabs.querySelectorAll('.mobile-panel-tab').forEach((t, i) => {
        t.classList.toggle('active', i === idx);
      });
    }

    // 탭 클릭
    tabs.querySelectorAll('.mobile-panel-tab').forEach((tab, i) => {
      tab.addEventListener('click', () => goTo(i));
    });

    // 터치 스와이프
    let touchStartX = 0, touchStartY = 0;

    layout.addEventListener('touchstart', e => {
      touchStartX = e.touches[0].clientX;
      touchStartY = e.touches[0].clientY;
    }, { passive: true });

    layout.addEventListener('touchend', e => {
      const dx = e.changedTouches[0].clientX - touchStartX;
      const dy = e.changedTouches[0].clientY - touchStartY;
      if (Math.abs(dx) < 40 || Math.abs(dx) < Math.abs(dy)) return;
      if (dx < 0) goTo(Math.min(currentIdx + 1, 1));
      else goTo(Math.max(currentIdx - 1, 0));
    }, { passive: true });

    goTo(0);
  });
}

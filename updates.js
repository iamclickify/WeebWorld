// === updates.js (WeebWorld Weekly Schedule & Resilient Fetching) ===
const apiUrl = "https://api.jikan.moe/v4/seasons/now";
const CACHE_KEY = "jikan_season_now_cache_v1";
const CACHE_TTL = 10 * 60 * 1000; // 10 minutes

let currentView = "live"; // "live" or "calendar"
let selectedDay = "monday";
let currentPage = 1;
let currentData = [];
let filteredData = [];
let recentlyViewed = JSON.parse(localStorage.getItem("recentlyViewed") || "[]");
let favorites = JSON.parse(localStorage.getItem("favorites") || "[]");
let watchlist = JSON.parse(localStorage.getItem("watchlist") || "[]");

// DOM Elements
const animeCards = document.getElementById("anime-cards");
const genreSelect = document.getElementById("genre-select");
const statusSelect = document.getElementById("status-select");
const seasonSelect = document.getElementById("season-select");
const yearSelect = document.getElementById("year-select");
const sortSelect = document.getElementById("sort-select");
const searchInput = document.getElementById("search-input");
const searchButton = document.getElementById("search-button");
const clearFiltersBtn = document.getElementById("clear-filters");
const clearSearchBtn = document.getElementById("clear-search");
const pagination = document.getElementById("pagination");
const resultsInfo = document.getElementById("results-info");
const loadingSpinner = document.getElementById("loading-spinner");
const noResults = document.getElementById("no-results");
const modal = document.getElementById("anime-modal");
const closeModal = document.getElementById("close-modal");

const viewNowBtn = document.getElementById("view-now");
const viewScheduleBtn = document.getElementById("view-schedule");
const daySelector = document.getElementById("day-selector");
const searchContainer = document.getElementById("search-container");
const searchFiltersContainer = document.getElementById("search-filters-container");

// Accessibility upgrades
if (resultsInfo) resultsInfo.setAttribute("aria-live", "polite");
if (modal) {
  modal.setAttribute("role", "dialog");
  modal.setAttribute("aria-modal", "true");
  modal.setAttribute("aria-labelledby", "modal-title");
}

let previouslyFocusedEl = null;
let trapFocusHandler = null;

// Utilities
function showLoading() {
  loadingSpinner?.classList.remove("hidden");
  animeCards?.classList.add("hidden");
  noResults?.classList.add("hidden");
}
function hideLoading() {
  loadingSpinner?.classList.add("hidden");
  animeCards?.classList.remove("hidden");
}
function scrollToGridTop() {
  try {
    const top = (animeCards?.offsetTop || 0) - 80;
    window.scrollTo({ top: top < 0 ? 0 : top, behavior: "smooth" });
  } catch {}
}

// Debounce utility
function debounce(fn, delay = 400) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), delay);
  };
}

// Persist filters
function saveFilters() {
  const filters = {
    genre: genreSelect?.value ?? "all",
    status: statusSelect?.value ?? "",
    season: seasonSelect?.value ?? "",
    year: yearSelect?.value ?? "",
    sort: sortSelect?.value ?? "default",
    search: searchInput?.value ?? "",
  };
  localStorage.setItem("filters_updates", JSON.stringify(filters));
}
function loadFilters() {
  const saved = JSON.parse(localStorage.getItem("filters_updates") || "{}");
  if (saved.genre && genreSelect) genreSelect.value = saved.genre;
  if (saved.status && statusSelect) statusSelect.value = saved.status;
  if (saved.season && seasonSelect) seasonSelect.value = saved.season;
  if (saved.year && yearSelect) yearSelect.value = saved.year;
  if (saved.sort && sortSelect) sortSelect.value = saved.sort;
  if (typeof saved.search === "string" && searchInput) searchInput.value = saved.search;
}

// Update results info
function updateResultsInfo() {
  const total = filteredData.length;
  const startIndex = (currentPage - 1) * 9 + 1;
  const endIndex = Math.min(currentPage * 9, total);
  if (total === 0) {
    resultsInfo.textContent = "No anime found";
  } else {
    resultsInfo.textContent = `Showing ${startIndex}-${endIndex} of ${total} anime`;
  }
}

// Timezone formatter helper
function formatBroadcastTime(broadcast) {
  if (!broadcast || !broadcast.time || !broadcast.day) {
    return { jst: "N/A", local: "N/A" };
  }

  const jstString = `${broadcast.day} at ${broadcast.time} (JST)`;

  try {
    const daysMap = {
      "Sundays": 0, "Mondays": 1, "Tuesdays": 2, "Wednesdays": 3,
      "Thursdays": 4, "Fridays": 5, "Saturdays": 6,
      "Sunday": 0, "Monday": 1, "Tuesday": 2, "Wednesday": 3,
      "Thursday": 4, "Friday": 5, "Saturday": 6
    };

    const broadcastDayStr = broadcast.day.trim();
    const dayIndex = daysMap[broadcastDayStr];

    if (dayIndex === undefined) {
      return { jst: jstString, local: jstString };
    }

    const [hours, minutes] = broadcast.time.split(":").map(Number);

    const baseDate = new Date();
    let utcHour = hours - 9;
    let utcDayDiff = 0;
    if (utcHour < 0) {
      utcHour += 24;
      utcDayDiff = -1;
    }

    const currentDay = baseDate.getDay();
    let dayDiff = dayIndex - currentDay;
    baseDate.setDate(baseDate.getDate() + dayDiff + utcDayDiff);
    baseDate.setUTCHours(utcHour, minutes, 0, 0);

    const localDay = baseDate.getDay();
    const localHour = String(baseDate.getHours()).padStart(2, '0');
    const localMinute = String(baseDate.getMinutes()).padStart(2, '0');

    const dayNames = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
    const localDayStr = dayNames[localDay];

    let tzName = "";
    try {
      tzName = " " + Intl.DateTimeFormat().resolvedOptions().timeZone;
      const parts = tzName.split('/');
      if (parts.length > 1) {
        tzName = " (" + parts[parts.length - 1].replace('_', ' ') + ")";
      }
    } catch (e) {}

    const localString = `${localDayStr}s at ${localHour}:${localMinute}${tzName}`;
    return { jst: jstString, local: localString };

  } catch (err) {
    console.error("Timezone conversion failed", err);
    return { jst: jstString, local: jstString };
  }
}

// === Jikan API Fetch Manager with Queueing, Caching, and 429 Resiliency ===
const JikanFetchManager = {
  cache: new Map(),
  queue: [],
  isProcessing: false,
  lastRequestTime: 0,
  minRequestGap: 350,

  async fetch(url, options = {}) {
    const cached = this.cache.get(url);
    if (cached && (Date.now() - cached.timestamp < CACHE_TTL)) {
      return cached.data;
    }
    return new Promise((resolve, reject) => {
      this.queue.push({ url, options, resolve, reject, retries: 0 });
      this.processQueue();
    });
  },

  async processQueue() {
    if (this.isProcessing || this.queue.length === 0) return;
    this.isProcessing = true;

    while (this.queue.length > 0) {
      const request = this.queue[0];
      const now = Date.now();
      const timeSinceLast = now - this.lastRequestTime;
      const delay = Math.max(0, this.minRequestGap - timeSinceLast);

      if (delay > 0) {
        await new Promise(resolve => setTimeout(resolve, delay));
      }

      this.lastRequestTime = Date.now();

      try {
        const response = await fetch(request.url, request.options);
        
        if (response.status === 429) {
          const backoff = Math.pow(2, request.retries) * 1500;
          console.warn(`Jikan API 429 Rate Limit hit. Retrying in ${backoff}ms...`);
          
          if (request.retries >= 3) {
            this.queue.shift();
            request.reject(new Error("API Error 429: Rate Limit Exceeded after retries"));
          } else {
            request.retries++;
            await new Promise(resolve => setTimeout(resolve, backoff));
          }
          continue;
        }

        if (!response.ok) {
          throw new Error(`API Error: ${response.status} ${response.statusText}`);
        }

        const data = await response.json();
        
        if (data && data.data) {
          this.cache.set(request.url, {
            data: data,
            timestamp: Date.now()
          });
        }

        this.queue.shift();
        request.resolve(data);

      } catch (error) {
        console.error("Fetch failed for url:", request.url, error);
        this.queue.shift();
        request.reject(error);
      }
    }
    this.isProcessing = false;
  }
};

// Modal helpers
function setUpFavButton(anime) {
  const titleEl = document.getElementById("modal-title");
  let favBtn = document.getElementById("modal-fav-btn");
  if (!favBtn && titleEl && titleEl.parentNode) {
    favBtn = document.createElement("button");
    favBtn.id = "modal-fav-btn";
    favBtn.type = "button";
    favBtn.className =
      "ml-3 px-3 py-1 rounded bg-pink-600 hover:bg-pink-700 text-white text-xs font-semibold";
    titleEl.parentNode.insertBefore(favBtn, titleEl.nextSibling);
  }
  if (!favBtn) return;

  const isFav = favorites.some((f) => f.mal_id === anime.mal_id);
  favBtn.textContent = isFav ? "♥ Favorited" : "♡ Favorite";
  favBtn.setAttribute("aria-pressed", String(isFav));
  favBtn.onclick = () => {
    toggleFavorite(anime);
    setUpFavButton(anime);
  };
}

function trapFocus(container) {
  const focusable = container.querySelectorAll(
    'a[href], button, textarea, input, select, [tabindex]:not([tabindex="-1"])'
  );
  const elements = Array.from(focusable).filter((el) => !el.hasAttribute("disabled"));
  if (!elements.length) return;
  const firstEl = elements[0];
  const lastEl = elements[elements.length - 1];

  trapFocusHandler = (e) => {
    if (e.key !== "Tab") return;
    if (e.shiftKey && document.activeElement === firstEl) {
      e.preventDefault();
      lastEl.focus();
    } else if (!e.shiftKey && document.activeElement === lastEl) {
      e.preventDefault();
      firstEl.focus();
    }
  };
  document.addEventListener("keydown", trapFocusHandler);
  firstEl.focus();
}

function isValidUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function safeSetHref(el, href) {
  if (!el) return;
  if (isValidUrl(href)) {
    el.href = href;
    el.target = "_blank";
    el.rel = "noopener noreferrer";
  } else {
    el.href = "#";
    el.removeAttribute("target");
    el.removeAttribute("rel");
  }
}

function openModal(anime) {
  addToRecentlyViewed(anime);

  document.getElementById("modal-title").textContent = anime.title || "Untitled";
  document.getElementById("modal-title-english").textContent =
    anime.title_english || anime.title_synonyms?.[0] || "";
  document.getElementById("modal-synopsis").textContent =
    anime.synopsis || "No synopsis available.";

  const imgEl = document.getElementById("modal-image");
  const imageUrl = anime.images?.jpg?.large_image_url || anime.images?.jpg?.image_url || "";
  if (isValidUrl(imageUrl)) {
    imgEl.src = imageUrl;
  } else {
    imgEl.removeAttribute("src");
  }
  imgEl.alt = anime.title || "Anime poster";

  document.getElementById("modal-episodes").textContent = anime.episodes || "N/A";
  document.getElementById("modal-score").textContent = anime.score ? `${anime.score}/10` : "N/A";
  document.getElementById("modal-status").textContent = anime.status || "N/A";
  document.getElementById("modal-duration").textContent = anime.duration || "N/A";
  document.getElementById("modal-rating").textContent = anime.rating || "N/A";

  const airedText = anime.aired?.string || (anime.year ? `${anime.year}` : "N/A");
  document.getElementById("modal-aired").textContent = airedText;

  const genresContainer = document.getElementById("modal-genres");
  genresContainer.innerHTML = "";
  if (Array.isArray(anime.genres) && anime.genres.length) {
    anime.genres.forEach((genre) => {
      const genreTag = document.createElement("span");
      genreTag.className = "bg-blue-600 text-white px-3 py-1 rounded-full text-xs";
      genreTag.textContent = genre.name || "Unknown";
      genresContainer.appendChild(genreTag);
    });
  } else {
    const span = document.createElement("span");
    span.className = "text-zinc-400";
    span.textContent = "No genres available";
    genresContainer.appendChild(span);
  }

  const studiosContainer = document.getElementById("modal-studios");
  studiosContainer.textContent = Array.isArray(anime.studios) && anime.studios.length
    ? anime.studios.map((s) => s.name).join(", ")
    : "No studio info";

  const producersContainer = document.getElementById("modal-producers");
  producersContainer.textContent = Array.isArray(anime.producers) && anime.producers.length
    ? anime.producers.slice(0, 3).map((p) => p.name).join(", ")
    : "No producer info";

  const malLink = document.getElementById("modal-mal-link");
  safeSetHref(malLink, anime.url || "");

  const trailerLink = document.getElementById("modal-trailer-link");
  if (anime.trailer?.url && isValidUrl(anime.trailer.url)) {
    safeSetHref(trailerLink, anime.trailer.url);
    trailerLink.classList.remove("hidden");
  } else if (trailerLink) {
    trailerLink.classList.add("hidden");
  }

  setUpFavButton(anime);
  setUpWatchlistButton(anime);
  updateWatchlistTrackerUI(anime);

  previouslyFocusedEl = document.activeElement;
  modal.classList.remove("hidden");
  modal.style.display = "flex";
  setTimeout(() => {
    modal.querySelector("div")?.classList.add("animate-modalOpen");
  }, 10);
  document.body.style.overflow = "hidden";

  const content = modal.querySelector("div");
  if (content) trapFocus(content);
}

function closeModalFn() {
  modal.querySelector("div")?.classList.remove("animate-modalOpen");
  setTimeout(() => {
    modal.classList.add("hidden");
    modal.style.display = "none";
    document.body.style.overflow = "auto";
    if (trapFocusHandler) document.removeEventListener("keydown", trapFocusHandler);
    trapFocusHandler = null;
    previouslyFocusedEl?.focus?.();
  }, 300);
}

async function openModalById(id) {
  showLoading();
  try {
    const data = await JikanFetchManager.fetch(`https://api.jikan.moe/v4/anime/${id}`);
    if (data && data.data) {
      openModal(data.data);
    }
  } catch (err) {
    console.error("Failed to load anime details", err);
  } finally {
    hideLoading();
  }
}

// Favorites
function toggleFavorite(anime) {
  const exists = favorites.some((f) => f.mal_id === anime.mal_id);
  if (exists) {
    favorites = favorites.filter((f) => f.mal_id !== anime.mal_id);
  } else {
    favorites.push({
      mal_id: anime.mal_id,
      title: anime.title,
      image: anime.images?.webp?.large_image_url || anime.images?.jpg?.large_image_url,
      score: anime.score,
    });
  }
  localStorage.setItem("favorites", JSON.stringify(favorites));
}

// Watchlist Utilities
function setUpWatchlistButton(anime) {
  const watchBtn = document.getElementById("modal-watchlist-btn");
  if (!watchBtn) return;
  
  const isWatch = watchlist.some((w) => w.mal_id === anime.mal_id);
  watchBtn.textContent = isWatch ? "✓ In Watchlist" : "+ Watchlist";
  watchBtn.className = `px-4 py-2 rounded-lg text-sm font-semibold transition-colors border cursor-pointer ${
    isWatch 
      ? "bg-blue-600 border-blue-500 text-white hover:bg-blue-700" 
      : "bg-zinc-800 border-zinc-700 text-zinc-300 hover:text-white hover:bg-zinc-700"
  }`;
  
  watchBtn.onclick = () => {
    toggleWatchlist(anime);
    setUpWatchlistButton(anime);
    updateWatchlistTrackerUI(anime);
  };
}

function toggleWatchlist(anime) {
  const exists = watchlist.some((w) => w.mal_id === anime.mal_id);
  if (exists) {
    watchlist = watchlist.filter((w) => w.mal_id !== anime.mal_id);
  } else {
    watchlist.push({
      mal_id: anime.mal_id,
      title: anime.title,
      image: anime.images?.webp?.large_image_url || anime.images?.jpg?.large_image_url || anime.image,
      score: anime.score,
      watched_episodes: 0,
      status: 'Plan to Watch',
      total_episodes: anime.episodes || '?'
    });
  }
  localStorage.setItem("watchlist", JSON.stringify(watchlist));
  renderWatchlist();
}

function renderWatchlist() {
  const container = document.getElementById("watchlist");
  const section = document.getElementById("watchlist-section");
  if (!container || !section) return;

  if (watchlist.length === 0) {
    section.classList.add("hidden");
    return;
  }

  section.classList.remove("hidden");
  container.innerHTML = "";

  watchlist.forEach((anime) => {
    const watched = anime.watched_episodes || 0;
    const total = anime.total_episodes || '?';
    const status = anime.status || 'Plan to Watch';
    
    let progressPercent = 0;
    if (typeof total === 'number' && total > 0) {
      progressPercent = Math.min(100, Math.round((watched / total) * 100));
    } else if (status === 'Completed') {
      progressPercent = 100;
    }
    
    let statusClass = "text-zinc-400 bg-zinc-500/10";
    if (status === 'Watching') statusClass = "text-blue-400 bg-blue-500/10";
    else if (status === 'Completed') statusClass = "text-green-400 bg-green-500/10";

    const card = document.createElement("div");
    card.className =
      "flex flex-col bg-zinc-800 rounded-lg p-3 hover:bg-zinc-700 transition-colors w-full cursor-pointer relative group";

    card.innerHTML = `
      <div class="relative aspect-[3/4] rounded mb-2 overflow-hidden">
        <img src="${anime.image || ''}" class="w-full h-full object-cover" loading="lazy">
        <div class="absolute top-1 left-1 px-1.5 py-0.5 rounded text-[8px] font-black uppercase tracking-wider ${statusClass}">
          ${status}
        </div>
      </div>
      <p class="text-xs text-white font-medium truncate mb-1">${anime.title}</p>
      <div class="flex justify-between items-center text-[10px] text-zinc-400 mb-1">
        <span>Ep ${watched} / ${total}</span>
        <span>${progressPercent}%</span>
      </div>
      <div class="w-full bg-zinc-900 h-1 rounded overflow-hidden">
        <div class="bg-blue-500 h-full rounded transition-all duration-300" style="width: ${progressPercent}%"></div>
      </div>
    `;

    card.addEventListener("click", () => {
      const fullAnime = currentData.find((a) => a.mal_id === anime.mal_id);
      if (fullAnime) {
        openModal(fullAnime);
      } else {
        openModalById(anime.mal_id);
      }
    });
    container.appendChild(card);
  });
}

function updateWatchlistTrackerUI(anime) {
  const trackerDiv = document.getElementById("modal-watchlist-tracker");
  if (!trackerDiv) return;

  const item = watchlist.find((w) => w.mal_id === anime.mal_id);
  if (!item) {
    trackerDiv.classList.add("hidden");
    trackerDiv.innerHTML = "";
    return;
  }

  trackerDiv.classList.remove("hidden");
  const watched = item.watched_episodes || 0;
  const total = item.total_episodes || '?';
  const status = item.status || 'Plan to Watch';

  trackerDiv.innerHTML = `
    <div class="flex flex-col md:flex-row md:items-center justify-between gap-4">
      <div class="flex-grow">
        <h4 class="text-xs font-bold text-blue-400 mb-2 uppercase tracking-wider font-sans">Watch Progress Tracker</h4>
        <div class="flex items-center gap-4 flex-wrap">
          <div class="flex flex-col">
            <label class="text-[9px] text-zinc-400 font-semibold mb-1 uppercase font-sans">Status</label>
            <select id="tracker-status" class="bg-zinc-900 border border-zinc-700 text-white text-xs p-2 rounded focus:outline-none focus:ring-1 focus:ring-blue-400 cursor-pointer">
              <option value="Plan to Watch" ${status === 'Plan to Watch' ? 'selected' : ''}>Plan to Watch</option>
              <option value="Watching" ${status === 'Watching' ? 'selected' : ''}>Watching</option>
              <option value="Completed" ${status === 'Completed' ? 'selected' : ''}>Completed</option>
            </select>
          </div>
          <div class="flex flex-col">
            <label class="text-[9px] text-zinc-400 font-semibold mb-1 uppercase font-sans">Episodes Watched</label>
            <div class="flex items-center gap-1">
              <button id="tracker-dec" class="w-8 h-8 rounded bg-zinc-900 hover:bg-zinc-700 text-white flex items-center justify-center font-bold cursor-pointer border border-zinc-700">-</button>
              <input type="number" id="tracker-watched" value="${watched}" min="0" max="${typeof total === 'number' ? total : ''}" class="w-12 h-8 text-center bg-zinc-900 border border-zinc-700 rounded text-xs font-bold [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none text-white">
              <span class="text-zinc-400 font-bold text-xs ml-1">/ ${total}</span>
              <button id="tracker-inc" class="w-8 h-8 rounded bg-zinc-900 hover:bg-zinc-700 text-white flex items-center justify-center font-bold cursor-pointer border border-zinc-700">+</button>
            </div>
          </div>
        </div>
      </div>
    </div>
  `;

  const statusSelect = document.getElementById("tracker-status");
  const watchedInput = document.getElementById("tracker-watched");
  const decBtn = document.getElementById("tracker-dec");
  const incBtn = document.getElementById("tracker-inc");

  const saveTrackerData = () => {
    let newWatched = parseInt(watchedInput.value) || 0;
    if (newWatched < 0) newWatched = 0;
    if (typeof total === 'number' && newWatched > total) newWatched = total;

    watchedInput.value = newWatched;
    item.watched_episodes = newWatched;

    if (typeof total === 'number' && newWatched === total) {
      statusSelect.value = "Completed";
    }

    item.status = statusSelect.value;

    localStorage.setItem("watchlist", JSON.stringify(watchlist));
    renderWatchlist();
  };

  statusSelect.onchange = saveTrackerData;
  watchedInput.onchange = saveTrackerData;

  decBtn.onclick = () => {
    let val = parseInt(watchedInput.value) || 0;
    if (val > 0) {
      watchedInput.value = val - 1;
      saveTrackerData();
    }
  };

  incBtn.onclick = () => {
    let val = parseInt(watchedInput.value) || 0;
    if (typeof total === 'number') {
      if (val < total) {
        watchedInput.value = val + 1;
        saveTrackerData();
      }
    } else {
      watchedInput.value = val + 1;
      saveTrackerData();
    }
  };
}

// Recently viewed
function addToRecentlyViewed(anime) {
  recentlyViewed = recentlyViewed.filter((item) => item.mal_id !== anime.mal_id);
  recentlyViewed.unshift({
    mal_id: anime.mal_id,
    title: anime.title,
    image: anime.images?.webp?.large_image_url || anime.images?.jpg?.large_image_url,
    score: anime.score,
  });
  recentlyViewed = recentlyViewed.slice(0, 10);
  localStorage.setItem("recentlyViewed", JSON.stringify(recentlyViewed));
  renderRecentlyViewed();
}

function renderRecentlyViewed() {
  const container = document.getElementById("recently-viewed");
  const section = document.getElementById("recently-viewed-section");
  if (!container || !section) return;

  if (recentlyViewed.length === 0) {
    section.classList.add("hidden");
    return;
  }

  section.classList.remove("hidden");
  container.innerHTML = "";

  recentlyViewed.forEach((anime) => {
    const card = document.createElement("div");
    card.className =
      "flex-shrink-0 bg-zinc-800 rounded-lg p-2 cursor-pointer hover:bg-zinc-700 transition-colors w-32";

    const img = document.createElement("img");
    img.src = anime.image || "";
    img.alt = anime.title || "Poster";
    img.loading = "lazy";
    img.className = "w-full h-20 object-cover rounded mb-2";

    const title = document.createElement("p");
    title.className = "text-xs text-white font-medium truncate";
    title.textContent = anime.title;

    const score = document.createElement("p");
    score.className = "text-xs text-zinc-400";
    score.textContent = anime.score ? `⭐ ${anime.score}` : "No score";

    card.appendChild(img);
    card.appendChild(title);
    card.appendChild(score);

    card.addEventListener("click", () => {
      const fullAnime = currentData.find((a) => a.mal_id === anime.mal_id);
      if (fullAnime) {
        openModal(fullAnime);
      } else {
        openModalById(anime.mal_id);
      }
    });
    container.appendChild(card);
  });
}

// Data Fetching

async function fetchAnime() {
  try {
    showLoading();
    const cachedRaw = sessionStorage.getItem(CACHE_KEY);
    if (cachedRaw) {
      const cached = JSON.parse(cachedRaw);
      if (Date.now() - cached.time < CACHE_TTL && Array.isArray(cached.data)) {
        currentData = cached.data;
        applyFilters();
        renderRecentlyViewed();
        hideLoading();
        return;
      }
    }

    const data = await JikanFetchManager.fetch(apiUrl);
    currentData = data.data || [];

    sessionStorage.setItem(
      CACHE_KEY,
      JSON.stringify({ time: Date.now(), data: currentData })
    );

    applyFilters();
    renderRecentlyViewed();
  } catch (error) {
    hideLoading();
    if (animeCards) {
      animeCards.innerHTML = "";
      const container = document.createElement("div");
      container.className = "text-center py-10 text-zinc-300";

      const msg = document.createElement("p");
      msg.className = "text-red-500 mb-4";
      msg.textContent = `⚠️ Failed to load anime data. Please try again.`;

      const retryBtn = document.createElement("button");
      retryBtn.id = "retry-fetch";
      retryBtn.className = "px-4 py-2 bg-blue-500 text-white rounded hover:bg-blue-600";
      retryBtn.textContent = "Retry";
      retryBtn.addEventListener("click", fetchAnime);

      container.appendChild(msg);
      container.appendChild(retryBtn);
      animeCards.appendChild(container);
    }
  } finally {
    hideLoading();
  }
}

async function fetchSchedule(day) {
  try {
    showLoading();
    currentPage = 1;
    
    const url = `https://api.jikan.moe/v4/schedules?filter=${day}&sfw=true`;
    const data = await JikanFetchManager.fetch(url);
    
    currentData = data.data || [];
    filteredData = [...currentData];
    
    renderAnime();
    renderPagination();
    updateResultsInfo();
    renderRecentlyViewed();
  } catch (err) {
    console.error("Weekly schedule fetch failed", err);
    if (animeCards) {
      animeCards.innerHTML = "";
      const container = document.createElement("div");
      container.className = "text-center py-10 text-zinc-300";
      const msg = document.createElement("p");
      msg.className = "text-red-500 mb-4";
      msg.textContent = `⚠️ Failed to load schedule data. Please try again.`;
      const retryBtn = document.createElement("button");
      retryBtn.className = "px-4 py-2 bg-blue-500 text-white rounded hover:bg-blue-600";
      retryBtn.textContent = "Retry";
      retryBtn.addEventListener("click", () => fetchSchedule(selectedDay));
      container.appendChild(msg);
      container.appendChild(retryBtn);
      animeCards.appendChild(container);
    }
  } finally {
    hideLoading();
  }
}

// Filters + sort + search
function applyFilters() {
  if (currentView === "calendar") {
    // Under calendar mode we display scheduling data without standard filters
    return;
  }
  const selectedGenre = genreSelect?.value ?? "all";
  const selectedStatus = statusSelect?.value ?? "";
  const selectedSeason = seasonSelect?.value ?? "";
  const selectedYear = yearSelect?.value ?? "";
  const selectedSort = sortSelect?.value ?? "default";
  const searchText = (searchInput?.value || "").toLowerCase();

  filteredData = (currentData || []).filter((anime) => {
    const matchesGenre =
      selectedGenre === "all" || (anime.genres || []).some((g) => g.mal_id == selectedGenre);

    const matchesStatus =
      selectedStatus === "" ||
      (selectedStatus === "airing" && anime.airing) ||
      (selectedStatus === "upcoming" && anime.status === "Not yet aired") ||
      (selectedStatus === "completed" && anime.status === "Finished Airing");

    const matchesSeason = selectedSeason === "" || anime.season === selectedSeason;
    const matchesYear = selectedYear === "" || anime.year == selectedYear;

    const title = (anime.title || "").toLowerCase();
    const titleEn = (anime.title_english || "").toLowerCase();
    const matchesSearch = title.includes(searchText) || titleEn.includes(searchText);

    return matchesGenre && matchesStatus && matchesSeason && matchesYear && matchesSearch;
  });

  if (selectedSort !== "default") {
    filteredData.sort((a, b) => {
      switch (selectedSort) {
        case "title":
          return (a.title || "").localeCompare(b.title || "");
        case "score":
          return (b.score || 0) - (a.score || 0);
        case "episodes":
          return (b.episodes || 0) - (a.episodes || 0);
        case "year":
          return (b.year || 0) - (a.year || 0);
        default:
          return 0;
      }
    });
  }

  hideLoading();
  renderAnime();
  renderPagination();
  updateResultsInfo();
  saveFilters();
}

function renderAnime() {
  if (!animeCards) return;
  animeCards.innerHTML = "";
  const startIndex = (currentPage - 1) * 9;
  const pageData = filteredData.slice(startIndex, startIndex + 9);

  if (pageData.length === 0) {
    noResults?.classList.remove("hidden");
    animeCards?.classList.add("hidden");
    return;
  }

  noResults?.classList.add("hidden");
  animeCards?.classList.remove("hidden");

  pageData.forEach((anime) => {
    const card = document.createElement("div");
    card.className =
      "bg-zinc-800 p-4 rounded-xl shadow-lg hover:shadow-blue-400 hover:scale-105 transition-all duration-300 cursor-pointer relative";

    const imgWrapper = document.createElement("div");
    imgWrapper.className = "relative";

    const img = document.createElement("img");
    img.src = anime.images?.webp?.large_image_url || anime.images?.jpg?.large_image_url || "";
    img.alt = anime.title || "Poster";
    img.loading = "lazy";
    img.className = "w-full h-60 object-cover rounded mb-3 transition-opacity duration-300";
    img.style.opacity = "0";
    img.addEventListener("load", () => { img.style.opacity = "1"; });

    const scoreBadge = document.createElement("div");
    scoreBadge.className = "absolute top-2 right-2 bg-black bg-opacity-70 text-white px-2 py-1 rounded text-xs";
    scoreBadge.textContent = anime.score ? `⭐ ${anime.score}` : "No score";

    imgWrapper.appendChild(img);
    imgWrapper.appendChild(scoreBadge);

    const titleEl = document.createElement("h3");
    titleEl.className = "text-lg font-bold text-blue-400 mb-1 line-clamp-2";
    titleEl.textContent = anime.title || "Untitled";

    const eps = document.createElement("p");
    eps.className = "text-sm text-zinc-400";
    eps.textContent = `Episodes: ${anime.episodes ?? "N/A"}`;

    const status = document.createElement("p");
    status.className = "text-sm text-zinc-400 mb-2";
    status.textContent = `Status: ${anime.status || "N/A"}`;

    card.appendChild(imgWrapper);
    card.appendChild(titleEl);
    card.appendChild(eps);
    card.appendChild(status);

    // Render airing broadcast times under calendar view
    if (currentView === "calendar" && anime.broadcast) {
      const broadcastTime = formatBroadcastTime(anime.broadcast);
      
      const broadcastDiv = document.createElement("div");
      broadcastDiv.className = "mt-2 pt-2 border-t border-zinc-700 text-xs text-zinc-400 space-y-1";
      
      const jstP = document.createElement("p");
      jstP.textContent = `🇯🇵 JST: ${broadcastTime.jst}`;
      
      const localP = document.createElement("p");
      localP.className = "text-blue-400 font-medium";
      localP.textContent = `⏰ Local: ${broadcastTime.local}`;
      
      broadcastDiv.appendChild(jstP);
      broadcastDiv.appendChild(localP);
      card.appendChild(broadcastDiv);
    }

    card.addEventListener("click", () => openModal(anime));
    animeCards.appendChild(card);
  });
}

function renderPagination() {
  if (!pagination) return;
  pagination.innerHTML = "";
  const totalPages = Math.ceil(filteredData.length / 9);
  if (totalPages <= 1) return;

  if (currentPage > 1) {
    const prevBtn = document.createElement("button");
    prevBtn.textContent = "← Previous";
    prevBtn.className =
      "px-4 py-2 bg-zinc-700 text-zinc-300 hover:bg-blue-400 rounded-md transition-colors cursor-pointer border-none";
    prevBtn.addEventListener("click", () => {
      currentPage--;
      renderAnime();
      renderPagination();
      updateResultsInfo();
      scrollToGridTop();
    });
    pagination.appendChild(prevBtn);
  }

  const startPage = Math.max(1, currentPage - 2);
  const endPage = Math.min(totalPages, startPage + 4);

  for (let i = startPage; i <= endPage; i++) {
    const btn = document.createElement("button");
    btn.textContent = i;
    btn.className = `px-3 py-2 rounded-md transition-colors cursor-pointer border-none ${
      i === currentPage ? "bg-blue-500 text-white" : "bg-zinc-700 text-zinc-300 hover:bg-blue-400"
    }`;
    btn.addEventListener("click", () => {
      currentPage = i;
      renderAnime();
      renderPagination();
      updateResultsInfo();
      scrollToGridTop();
    });
    pagination.appendChild(btn);
  }

  if (currentPage < totalPages) {
    const nextBtn = document.createElement("button");
    nextBtn.textContent = "Next →";
    nextBtn.className =
      "px-4 py-2 bg-zinc-700 text-zinc-300 hover:bg-blue-400 rounded-md transition-colors cursor-pointer border-none";
    nextBtn.addEventListener("click", () => {
      currentPage++;
      renderAnime();
      renderPagination();
      updateResultsInfo();
      scrollToGridTop();
    });
    pagination.appendChild(nextBtn);
  }
}

// Clear filters
function clearAllFilters() {
  if (genreSelect) genreSelect.value = "all";
  if (statusSelect) statusSelect.value = "";
  if (seasonSelect) seasonSelect.value = "";
  if (yearSelect) yearSelect.value = "";
  if (sortSelect) sortSelect.value = "default";
  if (searchInput) searchInput.value = "";
  currentPage = 1;
  applyFilters();
}

// Event Listeners
genreSelect?.addEventListener("change", () => { currentPage = 1; applyFilters(); });
statusSelect?.addEventListener("change", () => { currentPage = 1; applyFilters(); });
seasonSelect?.addEventListener("change", () => { currentPage = 1; applyFilters(); });
yearSelect?.addEventListener("change", () => { currentPage = 1; applyFilters(); });
sortSelect?.addEventListener("change", () => { currentPage = 1; applyFilters(); });

searchButton?.addEventListener("click", () => { currentPage = 1; applyFilters(); });
searchInput?.addEventListener("keydown", (e) => {
  if (e.key === "Enter") { currentPage = 1; applyFilters(); }
});
const debouncedSearch = debounce(() => { currentPage = 1; applyFilters(); }, 400);
searchInput?.addEventListener("input", debouncedSearch);

clearFiltersBtn?.addEventListener("click", clearAllFilters);
clearSearchBtn?.addEventListener("click", clearAllFilters);
closeModal?.addEventListener("click", closeModalFn);
modal?.addEventListener("click", (e) => { if (e.target === modal) closeModalFn(); });
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !modal.classList.contains("hidden")) closeModalFn();
});

// View switching logic
viewNowBtn?.addEventListener("click", () => {
  if (currentView === "live") return;
  currentView = "live";
  
  viewNowBtn.className = "px-5 py-2.5 bg-blue-600 text-white rounded-xl font-bold transition-all hover:scale-105 cursor-pointer border-none";
  viewScheduleBtn.className = "px-5 py-2.5 bg-zinc-800 text-gray-300 hover:text-white rounded-xl font-bold transition-all hover:scale-105 cursor-pointer border border-zinc-700";
  
  searchContainer?.classList.remove("hidden");
  searchFiltersContainer?.classList.remove("hidden");
  daySelector?.classList.add("hidden");

  fetchAnime();
});

viewScheduleBtn?.addEventListener("click", () => {
  if (currentView === "calendar") return;
  currentView = "calendar";

  viewScheduleBtn.className = "px-5 py-2.5 bg-blue-600 text-white rounded-xl font-bold transition-all hover:scale-105 cursor-pointer border-none";
  viewNowBtn.className = "px-5 py-2.5 bg-zinc-800 text-gray-300 hover:text-white rounded-xl font-bold transition-all hover:scale-105 cursor-pointer border border-zinc-700";

  searchContainer?.classList.add("hidden");
  searchFiltersContainer?.classList.add("hidden");
  daySelector?.classList.remove("hidden");

  const dayNames = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
  const today = dayNames[new Date().getDay()];
  
  const dayButtons = document.querySelectorAll(".day-btn");
  dayButtons.forEach(btn => {
    if (btn.getAttribute("data-day") === today) {
      btn.classList.add("bg-blue-600", "text-white");
      btn.classList.remove("bg-zinc-800", "text-gray-300");
      selectedDay = today;
    } else {
      btn.classList.remove("bg-blue-600", "text-white");
      btn.classList.add("bg-zinc-800", "text-gray-300");
    }
  });

  fetchSchedule(selectedDay);
});

document.querySelectorAll(".day-btn").forEach(btn => {
  btn.addEventListener("click", (e) => {
    const clickedDay = e.target.getAttribute("data-day");
    if (selectedDay === clickedDay) return;
    
    selectedDay = clickedDay;
    
    document.querySelectorAll(".day-btn").forEach(b => {
      b.classList.remove("bg-blue-600", "text-white");
      b.classList.add("bg-zinc-800", "text-gray-300");
    });
    e.target.classList.add("bg-blue-600", "text-white");
    e.target.classList.remove("bg-zinc-800", "text-gray-300");

    fetchSchedule(selectedDay);
  });
});

// --- Watchlist Import/Export Logic ---
document.getElementById("export-watchlist")?.addEventListener("click", () => {
  if (watchlist.length === 0) {
    alert("Your watchlist is empty!");
    return;
  }
  const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(watchlist, null, 2));
  const downloadAnchor = document.createElement('a');
  downloadAnchor.setAttribute("href", dataStr);
  downloadAnchor.setAttribute("download", "weebworld-watchlist.json");
  document.body.appendChild(downloadAnchor);
  downloadAnchor.click();
  downloadAnchor.remove();
});

const importFile = document.getElementById("import-file");
document.getElementById("import-watchlist")?.addEventListener("click", () => {
  importFile?.click();
});

importFile?.addEventListener("change", (e) => {
  const file = e.target.files[0];
  if (!file) return;
  
  const reader = new FileReader();
  reader.onload = (event) => {
    try {
      const imported = JSON.parse(event.target.result);
      if (Array.isArray(imported)) {
        const isValid = imported.every(item => item && item.mal_id && item.title);
        if (isValid) {
          watchlist = imported;
          localStorage.setItem("watchlist", JSON.stringify(watchlist));
          renderWatchlist();
          alert("Watchlist imported successfully!");
        } else {
          alert("Invalid file format. Ensure it contains a valid watchlist.");
        }
      } else {
        alert("Invalid file format. Watchlist must be a JSON array.");
      }
    } catch (err) {
      alert("Failed to parse JSON file.");
      console.error(err);
    }
  };
  reader.readAsText(file);
});

// Initialize
loadFilters();
fetchAnime();
renderWatchlist();

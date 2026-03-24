// ─────────────────────────────────────────────────────────────
//  Spotify Chords Board  ·  app.js
// ─────────────────────────────────────────────────────────────

// ── CONFIGURACIÓN — edita estos dos valores ──────────────────
const HARDCODED_CLIENT_ID  = "e15aaea6bb3349d2a828a01b208ab014";
const HARDCODED_WORKER_URL = "https://test.millervicente.workers.dev";
const APP_VERSION = "v20.2";
// ─────────────────────────────────────────────────────────────

const STORAGE_KEYS = {
  settings:   "spotify-chords.settings.v5",
  tokens:     "spotify-chords.tokens.v5",
  stats:      "spotify-chords.stats.v1",
  fontSize:   "spotify-chords.fontsize.v1",
  instrument: "spotify-chords.instrument.v1",
};

const SPOTIFY_SCOPES = ["user-read-currently-playing", "user-read-playback-state"];

const state = {
  settings: {
    clientId:    HARDCODED_CLIENT_ID,
    redirectUri: "",
    workerUrl:   HARDCODED_WORKER_URL
  },
  tokens: null,
  currentTrack: null,
  authTone: "muted",   authText: "Sin conectar",
  playbackTone: "muted", playbackText: "Esperando",
  lyricsTone: "muted", lyricsText: "Esperando",
  lyricsBody: "",
  lyricsSourceUrl: "",
  chordsTone: "muted", chordsText: "Esperando",
  chordsData: null,
  lastTrackKey: "",
  lastSyncAt: 0,
  pollTimer: null,
  progressTimer: null,
  scroll: { speed: 1.0, userPaused: true, syncMode: false, bpmMode: false, _rafId: null, _lastTime: null, _acc: 0 },
  transpose: 0,
  enharmonic: false,
  // New features
  bpm: null,
  detectedKey: null,
  prevIsPlaying: null,
  chordFontSize: 13,
  instrument: "guitar",
  shareMode: false,
  room: { code: null, isHost: false, pollTimer: null },
  prefetchedKey: null,   // key of the track whose chords are prefetched
  syncedLyrics: [],      // [{timeMs, text}] from lrclib synced lyrics
  rttSamples: [],        // last N RTT measurements (ms) for latency compensation
};

// In-memory prefetch cache: trackKey → { sources, detectedKey }
// Kept small (max 3 entries) — only next song matters
const prefetchCache = new Map();
const PREFETCH_MAX  = 3;

const el = {};

// Settings panel open/close (gear button)
function openSettings() {
  document.getElementById("settings-panel").classList.add("open");
  document.getElementById("settings-overlay").style.display = "block";
  renderStats();
}
function closeSettings() {
  document.getElementById("settings-panel").classList.remove("open");
  document.getElementById("settings-overlay").style.display = "none";
}

document.addEventListener("DOMContentLoaded", boot);

async function boot() {
  cacheElements();
  const verEl = document.getElementById("app-version");
  if (verEl) verEl.textContent = APP_VERSION;
  bindEvents();
  hydrateState();
  loadUserPrefs();
  renderAll();
  const isRoomGuest = await checkRoomGuestMode();
  if (!isRoomGuest) await checkShareMode();
  await maybeFinishSpotifyLogin();
  if (state.tokens && !state.shareMode) startSpotifyPolling();
  else startProgressLoop();
}

// ─── DOM Cache ────────────────────────────────────────────────
function cacheElements() {
  const ids = [
    "spotify-client-id", "worker-url", "redirect-uri",
    "scroll-controls", "scroll-toggle", "scroll-slower", "scroll-faster", "scroll-speed-label",
    "source-switcher", "transpose-down", "transpose-up", "transpose-label",
    "copy-url-btn", "connect-btn", "disconnect-btn",
    "auth-status-pill", "auth-helper",
    "playback-pill", "cover-art",
    "track-kicker", "track-title", "track-artist", "track-album",
    "progress-left", "progress-right", "progress-fill",
    "sync-label", "spotify-link",
    "chords-pill", "chords-key-badge", "chords-chips-row",
    "chords-sections", "chords-status-text", "enharmonic-btn",
  ];
  ids.forEach(id => {
    const camel = id.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    el[camel] = document.getElementById(id);
  });
}

function bindEvents() {
  el.spotifyClientId.addEventListener("input", () => {
    state.settings.clientId = el.spotifyClientId.value.trim();
    saveSettings();
  });

  el.workerUrl.addEventListener("input", () => {
    state.settings.workerUrl = el.workerUrl.value.trim().replace(/\/+$/, "");
    saveSettings();
  });

  // Teleprompter controls
  el.scrollToggle?.addEventListener("click", () => {
    state.scroll.userPaused = !state.scroll.userPaused;
    if (!state.scroll.userPaused) {
      state.scroll._expectedY = window.scrollY;
      state.scroll._lastTime  = null;
    }
    updateScrollUI();
  });
  el.scrollSlower?.addEventListener("click", () => {
    state.scroll.speed = Math.max(0.25, +(state.scroll.speed - 0.25).toFixed(2));
    state.scroll.userPaused = false;
    updateScrollUI();
  });
  el.scrollFaster?.addEventListener("click", () => {
    state.scroll.speed = Math.min(4, +(state.scroll.speed + 0.25).toFixed(2));
    state.scroll.userPaused = false;
    updateScrollUI();
  });

  // Song-sync scroll button
  document.getElementById("sync-scroll-btn")?.addEventListener("click", () => {
    state.scroll.syncMode   = !state.scroll.syncMode;
    state.scroll.bpmMode    = false; // mutual exclusion
    state.scroll.userPaused = false;
    state.scroll._lastTime  = null;
    updateScrollUI();
  });

  // BPM scroll button
  document.getElementById("bpm-scroll-btn")?.addEventListener("click", () => {
    state.scroll.bpmMode    = !state.scroll.bpmMode;
    state.scroll.syncMode   = false; // mutual exclusion
    state.scroll.userPaused = false;
    state.scroll._lastTime  = null;
    updateScrollUI();
  });
  // Transpose controls
  el.transposeDown?.addEventListener("click", () => {
    state.transpose = (state.transpose - 1);
    renderChords();
    if (el.transposeLabel) el.transposeLabel.textContent = (state.transpose > 0 ? "+" : "") + state.transpose;
  });
  el.transposeUp?.addEventListener("click", () => {
    state.transpose = (state.transpose + 1);
    renderChords();
    if (el.transposeLabel) el.transposeLabel.textContent = (state.transpose > 0 ? "+" : "") + state.transpose;
  });

  // Enharmonic conversion toggle: ♭↔♯ (Bb family always kept)
  el.enharmonicBtn?.addEventListener("click", () => {
    // cycle: off → flat→sharp → sharp→flat → off
    const modes = [null, "flat2sharp", "sharp2flat"];
    const cur = modes.indexOf(state.enharmonic);
    state.enharmonic = modes[(cur + 1) % modes.length];
    if (el.enharmonicBtn) {
      el.enharmonicBtn.classList.toggle("active", !!state.enharmonic);
      el.enharmonicBtn.textContent =
        state.enharmonic === "flat2sharp" ? "♭→♯" :
        state.enharmonic === "sharp2flat" ? "♯→♭" : "♭↔♯";
    }
    renderChords();
  });

  // Source switcher delegation
  el.sourceSwitcher?.addEventListener("click", e => {
    const btn = e.target.closest("[data-src-idx]");
    if (!btn) return;
    const idx = parseInt(btn.dataset.srcIdx, 10);
    if (!isNaN(idx) && state.chordsSources[idx]) {
      state.chordsSourceIdx = idx;
      state.chordsData = state.chordsSources[idx];
      renderChords();
      renderSourceSwitcher();
      const cc = document.querySelector('.chords-card');
      if (cc) window.scrollTo({ top: cc.getBoundingClientRect().top + window.scrollY - 8, behavior: "smooth" });
      else window.scrollTo({ top: 0, behavior: "smooth" });
    }
  });

  el.redirectUri.addEventListener("input", () => {
    state.settings.redirectUri = el.redirectUri.value.trim();
    saveSettings();
  });
  el.copyUrlBtn.addEventListener("click", copyRedirectUri);
  el.connectBtn.addEventListener("click", startSpotifyLogin);
  el.disconnectBtn.addEventListener("click", disconnectSpotify);

  // JS-driven sticky for scroll-controls + FAB visibility
  const fab = document.getElementById("scroll-top-fab");

  window.addEventListener("scroll", () => {
    if (fab) fab.classList.toggle("visible", window.scrollY > 300);
  }, { passive: true });

  if (fab) {
    fab.addEventListener("click", () => {
      state.scroll.userPaused = true;
      updateScrollUI();
      window.scrollTo({ top: 0, behavior: "smooth" });
    });
  }
}

function hydrateState() {
  // Always use hardcoded credentials — never overwrite from localStorage
  state.settings.clientId  = HARDCODED_CLIENT_ID;
  state.settings.workerUrl = HARDCODED_WORKER_URL;
  try {
    const t = JSON.parse(localStorage.getItem(STORAGE_KEYS.tokens) || "null");
    if (t && t.accessToken) {
      state.tokens = t;
      setAuthStatus("live", "Spotify autorizado");
    }
  } catch (_) {}
}

function saveSettings() {
  localStorage.setItem(STORAGE_KEYS.settings, JSON.stringify(state.settings));
}

// ─── Spotify Auth ─────────────────────────────────────────────
async function copyRedirectUri() {
  const uri = getRedirectUri();
  if (!uri) { setAuthStatus("warn", "Publica el sitio primero."); renderSetup(); return; }
  try {
    await navigator.clipboard.writeText(uri);
    setAuthStatus("live", "Redirect URI copiada");
  } catch (_) {
    setAuthStatus("warn", "No pude copiarla; cópiala manualmente.");
  }
  renderSetup();
}

async function startSpotifyLogin() {
  // Read directly from DOM — avoids stale state if user pasted without triggering input event
  const clientId = (el.spotifyClientId.value || state.settings.clientId || "").trim();
  const manualUri = (el.redirectUri.value || state.settings.redirectUri || "").trim();

  // Persist whatever is in the fields right now
  if (clientId) { state.settings.clientId = clientId; saveSettings(); }
  if (manualUri) { state.settings.redirectUri = manualUri; saveSettings(); }

  const redirectUri = manualUri || getRedirectUri();

  if (!clientId) {
    alert("⚠️ Falta el Client ID de Spotify. Pégalo en el campo antes de conectar.");
    return;
  }
  if (!redirectUri) {
    alert("⚠️ Falta la Redirect URI. Escríbela manualmente en el campo (ej: https://tu-usuario.github.io/tu-repo/).");
    return;
  }

  const verifier = randomString(96);
  const challenge = await pkceChallengeFromVerifier(verifier);
  const authState = randomString(24);
  sessionStorage.setItem("spotify-chords.verifier", verifier);
  sessionStorage.setItem("spotify-chords.state", authState);

  const params = new URLSearchParams({
    client_id: clientId,
    response_type: "code",
    redirect_uri: redirectUri,
    scope: SPOTIFY_SCOPES.join(" "),
    code_challenge_method: "S256",
    code_challenge: challenge,
    state: authState
  });
  window.location.href = `https://accounts.spotify.com/authorize?${params.toString()}`;
}

async function maybeFinishSpotifyLogin() {
  const url = new URL(window.location.href);
  const code = url.searchParams.get("code");
  const incomingState = url.searchParams.get("state");
  const error = url.searchParams.get("error");
  if (!code && !error) return;

  if (error) { setAuthStatus("error", `Spotify devolvió: ${error}`); cleanupUrl(); renderAll(); return; }

  const expectedState = sessionStorage.getItem("spotify-chords.state");
  const verifier = sessionStorage.getItem("spotify-chords.verifier");
  if (!expectedState || !verifier || incomingState !== expectedState) {
    setAuthStatus("error", "No pude validar el regreso desde Spotify."); cleanupUrl(); renderAll(); return;
  }

  try {
    const response = await fetch("https://accounts.spotify.com/api/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: state.settings.clientId.trim(),
        code, redirect_uri: getRedirectUri(), code_verifier: verifier
      })
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error_description || payload.error || "No pude obtener el token.");
    state.tokens = {
      accessToken: payload.access_token,
      refreshToken: payload.refresh_token,
      expiresAt: Date.now() + ((payload.expires_in || 3600) * 1000) - 60000
    };
    persistTokens();
    setAuthStatus("live", "Spotify conectado");
  } catch (e) {
    setAuthStatus("error", e.message || "Falló la autenticación con Spotify.");
  } finally {
    cleanupUrl();
    sessionStorage.removeItem("spotify-chords.state");
    sessionStorage.removeItem("spotify-chords.verifier");
    renderAll();
  }
}

async function refreshSpotifyToken() {
  if (!state.tokens || !state.tokens.refreshToken) { disconnectSpotify(); return false; }
  try {
    const response = await fetch("https://accounts.spotify.com/api/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: state.settings.clientId.trim(),
        refresh_token: state.tokens.refreshToken
      })
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error_description || payload.error || "No pude refrescar el token.");
    state.tokens = {
      accessToken: payload.access_token,
      refreshToken: payload.refresh_token || state.tokens.refreshToken,
      expiresAt: Date.now() + ((payload.expires_in || 3600) * 1000) - 60000
    };
    persistTokens();
    return true;
  } catch (e) {
    setAuthStatus("error", e.message || "Sesión de Spotify inválida.");
    disconnectSpotify();
    return false;
  }
}

async function ensureFreshSpotifyToken() {
  if (!state.tokens) return false;
  if (Date.now() < (state.tokens.expiresAt || 0)) return true;
  return refreshSpotifyToken();
}

function disconnectSpotify() {
  stopSpotifyPolling();
  localStorage.removeItem(STORAGE_KEYS.tokens);
  state.tokens = null;
  state.currentTrack = null;
  state.lastTrackKey = "";
  state.lastSyncAt = 0;
  resetLyrics("muted", "Esperando", "La letra aparecerá aquí cuando Spotify reporte una canción activa.");
  resetChords();
  state.syncedLyrics = [];
  state.rttSamples = [];
  setAuthStatus("muted", "Sin conectar");
  setPlaybackStatus("muted", "Esperando");
  renderAll();
}

// ─── Spotify Polling ──────────────────────────────────────────
function startSpotifyPolling() {
  stopSpotifyPolling();
  fetchSpotifyPlayback();
  state.pollTimer = window.setInterval(fetchSpotifyPlayback, 1500);
  startProgressLoop();
}

function stopSpotifyPolling() {
  if (state.pollTimer) { window.clearInterval(state.pollTimer); state.pollTimer = null; }
}

async function fetchSpotifyPlayback() {
  if (!(await ensureFreshSpotifyToken())) { renderAll(); return; }

  try {
    const fetchStart = performance.now();
    const response = await fetch("https://api.spotify.com/v1/me/player", {
      headers: { Authorization: `Bearer ${state.tokens.accessToken}` }
    });
    // Measure RTT for latency compensation
    const rtt = performance.now() - fetchStart;
    state.rttSamples.push(rtt);
    if (state.rttSamples.length > 6) state.rttSamples.shift();

    if (response.status === 204) {
      state.currentTrack = null;
      state.lastTrackKey = "";
      state.lastSyncAt = 0;
      resetLyrics("warn", "Sin letra", "Spotify conectado, pero no hay reproducción activa.");
      resetChords();
      setAuthStatus("live", "Spotify conectado");
      setPlaybackStatus("warn", "Sin reproducción activa");
      renderAll();
      return;
    }

    if (response.status === 401) {
      const refreshed = await refreshSpotifyToken();
      if (refreshed) fetchSpotifyPlayback();
      return;
    }

    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error?.message || "Spotify no devolvió datos.");

    if (!payload.item || payload.currently_playing_type !== "track") {
      state.currentTrack = null;
      state.lastTrackKey = "";
      state.lastSyncAt = 0;
      resetLyrics("warn", "Sin letra", "La reproducción actual no es una canción compatible.");
      resetChords();
      setAuthStatus("live", "Spotify conectado");
      setPlaybackStatus("warn", "No es una canción");
      renderAll();
      return;
    }

    const nextTrack = {
      id:          payload.item.id,
      name:        payload.item.name,
      artists:     payload.item.artists.map(a => a.name),
      album:       payload.item.album.name,
      image:       payload.item.album.images?.[0]?.url || "",
      durationMs:  payload.item.duration_ms,
      progressMs:  payload.progress_ms || 0,
      isPlaying:   Boolean(payload.is_playing),
      spotifyUrl:  payload.item.external_urls?.spotify || ""
    };

    const nextKey = buildTrackLookupKey(nextTrack);
    const trackChanged = nextKey !== state.lastTrackKey;

    state.currentTrack = nextTrack;
    state.lastSyncAt = Date.now();
    setAuthStatus("live", "Spotify conectado");
    setPlaybackStatus(nextTrack.isPlaying ? "live" : "warn", nextTrack.isPlaying ? "Reproduciendo" : "En pausa");

    // Auto-pause/resume scroll when Spotify pauses or resumes
    // IMPORTANT: snapshot _wasAutoPlaying BEFORE mutating userPaused
    if (nextTrack.isPlaying && !state.scroll.userPaused) {
      state.scroll._wasAutoPlaying = true;
    }

    if (state.prevIsPlaying !== null) {
      if (state.prevIsPlaying && !nextTrack.isPlaying) {
        // Song just paused → pause scroll
        state.scroll.userPaused = true;
        updateScrollUI();
      } else if (!state.prevIsPlaying && nextTrack.isPlaying && state.scroll._wasAutoPlaying) {
        // Song just resumed → resume scroll (only if it was active before)
        state.scroll.userPaused = false;
        state.scroll._lastTime  = null;
        updateScrollUI();
      }
    }
    state.prevIsPlaying = nextTrack.isPlaying;

    renderAll();

    // Broadcast to live room if hosting
    if (state.room.isHost && state.room.code) {
      broadcastRoom(nextTrack).catch(() => {});
    }

    if (trackChanged) {
      state.lastTrackKey = nextKey;
      await loadTrackResources(nextTrack, nextKey);
    }
  } catch (e) {
    setPlaybackStatus("error", e.message || "No pude leer la pista actual.");
    renderAll();
  }
}

async function loadTrackResources(track, trackKey) {
  // Prevent browser scroll-restoration from fighting us
  if ("scrollRestoration" in history) history.scrollRestoration = "manual";

  // Scroll to the chords section (not top of page) so user sees chords immediately
  function scrollToChordsCard() {
    const chordsCard = document.querySelector('.chords-card');
    if (chordsCard) {
      const y = chordsCard.getBoundingClientRect().top + window.scrollY - 8;
      window.scrollTo({ top: y, behavior: "instant" });
    } else {
      window.scrollTo({ top: 0, behavior: "instant" });
    }
  }
  scrollToChordsCard();
  setTimeout(scrollToChordsCard, 50);
  setTimeout(scrollToChordsCard, 300);

  if (el.chordsSections) el.chordsSections.scrollTop = 0;
  state.scroll.userPaused = true;
  // syncMode persists across songs — recalibrate _acc and _lastTime
  state.scroll._acc       = 0;
  state.scroll._lastTime  = null;
  state.scroll._wasAutoPlaying = false;
  state.enharmonic   = false;
  state.bpm          = null;
  state.detectedKey  = null;
  state.syncedLyrics = [];   // reset until lrclib responds
  if (el.enharmonicBtn) el.enharmonicBtn.classList.remove("active");
  updateKeyBadge();
  showScrollControls(false);
  updateScrollUI();

  // Lyrics
  resetLyrics("warn", "Buscando…", "Buscando letra automáticamente…");
  renderLyrics();

  // Chords — start immediately in parallel
  resetChords("warn", "Buscando acordes…");
  renderChords();

  const [lyrics] = await Promise.all([
    fetchLyricsForTrack(track),
    fetchChordsForTrack(track, trackKey)
  ]);

  if (trackKey !== state.lastTrackKey) return;

  if (lyrics) {
    state.lyricsTone = "live";
    state.lyricsText = "Encontrada";
    state.lyricsBody = lyrics;
  } else {
    state.lyricsTone = "warn";
    state.lyricsText = "No encontrada";
    state.lyricsBody = "No pude conseguir letra automática. Usa el botón de búsqueda.";
  }

  const searchPlan = buildSearchPlan(track);
  state.lyricsSourceUrl = searchPlan.googleLyricsUrl;
  renderLyrics();

  // Update badge & scroll UI to reflect LRC availability
  updateKeyBadge();
  updateScrollUI();
}

// ─── Lyrics ───────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────
//  LYRICS  (lrclib only, parallel + 4s timeout)
// ─────────────────────────────────────────────────────────────

async function fetchWithTimeout(url, options = {}, ms = 4000) {
  const ctrl = new AbortController();
  const tid  = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, { ...options, signal: ctrl.signal });
    return res;
  } finally {
    clearTimeout(tid);
  }
}

async function fetchJsonTimeout(url, ms = 4000) {
  try {
    const res = await fetchWithTimeout(url, { headers: { Accept: "application/json" } }, ms);
    if (!res.ok) return null;
    return res.json();
  } catch (_) { return null; }
}

async function fetchLyricsForTrack(track) {
  const title  = cleanTrackLookupText(track.name);
  const artist = track.artists[0] || "";
  const dur    = track.durationMs ? Math.round(track.durationMs / 1000) : "";

  // Build both URLs and race them with a 4s timeout each
  const exactParams = new URLSearchParams({ track_name: title, artist_name: artist });
  if (track.album) exactParams.set("album_name", track.album);
  if (dur) exactParams.set("duration", String(dur));

  const searchParams = new URLSearchParams({ track_name: title, artist_name: artist });

  const [exact, searchResults] = await Promise.all([
    fetchJsonTimeout(`https://lrclib.net/api/get?${exactParams}`, 4000),
    fetchJsonTimeout(`https://lrclib.net/api/search?${searchParams}`, 4000)
  ]);

  // ── Extract synced lyrics for LRC-based scroll sync ──
  let syncedRaw = extractSyncedLyricsRaw(exact);
  if (!syncedRaw && Array.isArray(searchResults)) {
    for (const item of searchResults) {
      syncedRaw = extractSyncedLyricsRaw(item);
      if (syncedRaw) break;
    }
  }
  state.syncedLyrics = parseLRC(syncedRaw);
  if (state.syncedLyrics.length) {
    console.log("[LRC] parsed", state.syncedLyrics.length, "synced lines");
  }

  // ── Extract plain text lyrics ──
  const fromExact = extractLyricsText(exact);
  if (fromExact) return fromExact;

  if (Array.isArray(searchResults)) {
    for (const item of searchResults) {
      const candidate = extractLyricsText(item);
      if (candidate) return candidate;
    }
  }
  return "";
}

// ─────────────────────────────────────────────────────────────
//  CHORDS  — scraping via Cloudflare Worker (sin IA, sin tokens)
//
//  Worker actúa como proxy CORS → raspa Cifraclub, E-Chords, Chordie
//  100% gratis, 100k requests/día, sin límites de tokens
// ─────────────────────────────────────────────────────────────

function proxyUrl(targetUrl) {
  const base = state.settings.workerUrl.trim();
  if (!base) throw new Error("Configura la URL del Worker en Setup");
  return `${base}/?url=${encodeURIComponent(targetUrl)}`;
}

// ── Strategy 1: Cifraclub ─────────────────────────────────────
async function fetchChordsViaCifraclub(title, artist) {
  const q = encodeURIComponent(`${artist} ${title}`);

  const searchHtml = await fetchHtmlViaWorker(
    `https://www.cifraclub.com/busca/?q=${q}`
  );
  if (!searchHtml) throw new Error("Cifraclub: sin respuesta en búsqueda");

  // Cifraclub is Next.js — results are in __NEXT_DATA__ JSON
  const nextDataMatch = searchHtml.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  let songUrl = null;

  if (nextDataMatch) {
    try {
      const nextData = JSON.parse(nextDataMatch[1]);
      const pageProps = nextData?.props?.pageProps || {};
      console.log("[Cifraclub] nextData keys:", Object.keys(pageProps));

      // Try all known result locations
      const candidates = [
        pageProps.result, pageProps.results,
        pageProps.data?.result, pageProps.data?.results,
        pageProps.searchResults, pageProps.cifras,
      ];
      const results = candidates.find(c => Array.isArray(c) && c.length > 0);

      if (results) {
        const first = results[0];
        console.log("[Cifraclub] first result:", JSON.stringify(first).slice(0, 300));
        const artistSlug = first?.artist?.url || first?.artistUrl || first?.artist_url || first?.artist?.slug;
        const songSlug   = first?.url || first?.song_url || first?.cifra_url || first?.slug;
        if (artistSlug && songSlug && artistSlug !== "undefined" && songSlug !== "undefined") {
          songUrl = `https://www.cifraclub.com/${artistSlug}/${songSlug}/`;
          console.log("[Cifraclub] URL from JSON:", songUrl);
        }
      }
    } catch (e) {
      console.error("[Cifraclub] JSON parse error:", e.message);
    }
  }

  // Fallback: build slug from artist/title (removes accents for reliability)
  if (!songUrl) {
    const toSlug = s => s.toLowerCase()
      .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
      // Remove feat/ft only as standalone words (not inside other words like "left", "after")
      .replace(/\s*[\(\[]\s*(?:feat|ft|with|prod)\.?\s[^\)]*[\)\]]/gi, "")
      .replace(/\s+(?:feat|ft)\.?\s+.*/gi, "")
      .replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    songUrl = `https://www.cifraclub.com/${toSlug(artist)}/${toSlug(title)}/`;
    console.log("[Cifraclub] using slug fallback:", songUrl);
  }

  const songHtml = await fetchHtmlViaWorker(songUrl + "?tabs=false&instrument=keyboard#tabs=false&instrument=keyboard");
  if (!songHtml || songHtml.length < 1000) throw new Error("Cifraclub: página de canción vacía");

  const result = parseCifraclubPage(songHtml, title, artist);
  if (!result) throw new Error("Cifraclub: no se encontraron acordes en la página");
  result.url = songUrl;
  return result;
}

async function fetchHtmlViaWorker(targetUrl) {
  try {
    const proxied = proxyUrl(targetUrl);
    console.log("[Worker] fetching:", targetUrl);
    const res = await fetchWithTimeout(proxied, {}, 10000);
    console.log("[Worker] status:", res.status, "for", targetUrl);
    if (!res.ok) return null;
    const html = await res.text();
    console.log("[Worker] html length:", html.length, "for", targetUrl);
    return html;
  } catch (e) {
    console.error("[Worker] error:", e.message, "for", targetUrl);
    return null;
  }
}

function parseCifraclubPage(html, title, artist) {
  // ── Detect capo and tuning from visible HTML text ──
  // Cifraclub renders lines like:
  //   "Tono: E (forma de los acordes en el tono de C)"  → auto-transpose
  //   "Capo en el 6º traste"                            → +6 semitones
  //   "Afinación: D G C F A D"                          → note for display
  let semitones = 0;
  let capoInfo  = "";

  // Look for "Capo en el Nº traste", "Capo on Nth fret", "Cejilla: 1er traste"
  const capoMatch = html.match(/[Cc]ejilla[:\s]+(\d+)/i)
                 || html.match(/[Cc]apo\s+(?:en\s+el\s+)?(\d+)[ºª°]?\s*(?:traste|fret)/i)
                 || html.match(/[Cc]apo[:\s]+(\d+)/i);
  if (capoMatch) {
    semitones = parseInt(capoMatch[1], 10);
    capoInfo  = `Cejilla ${capoMatch[1]}`;
    console.log("[Cifraclub] capo detected:", semitones, "semitones");
  }

  // Also check "Tono: X (forma en el tono de Y)" — X is real key, Y is chord shapes key
  // The difference tells us how many semitones the chords are transposed
  if (!semitones) {
    const tonoMatch = html.match(/[Tt]ono[:\s]+([A-G][#b]?m?)\s*\(forma\s+de\s+los\s+acordes\s+en\s+el\s+tono\s+de\s+([A-G][#b]?m?)\)/i)
                   || html.match(/[Tt]ono[:\s]+([A-G][#b]?m?)\s*\(chord\s+shapes?\s+in\s+(?:the\s+key\s+of\s+)?([A-G][#b]?m?)\)/i);
    if (tonoMatch) {
      const realKey   = tonoMatch[1];
      const shapeKey  = tonoMatch[2];
      const realIdx   = NOTES_SHARP.indexOf(realKey.replace("m",""))  !== -1
                        ? NOTES_SHARP.indexOf(realKey.replace("m",""))
                        : NOTES_FLAT.indexOf(realKey.replace("m",""));
      const shapeIdx  = NOTES_SHARP.indexOf(shapeKey.replace("m","")) !== -1
                        ? NOTES_SHARP.indexOf(shapeKey.replace("m",""))
                        : NOTES_FLAT.indexOf(shapeKey.replace("m",""));
      if (realIdx !== -1 && shapeIdx !== -1) {
        semitones = ((realIdx - shapeIdx) + 12) % 12;
        capoInfo  = `Tono: ${realKey}`;
        console.log("[Cifraclub] tone mismatch detected:", shapeKey, "→", realKey, "=", semitones, "semitones");
      }
    }
  }

  // ── Parse the <pre> tag (guitar chord shapes) ──
  const clean = html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "");

  const preMatch = clean.match(/<pre[^>]*>([\s\S]*?)<\/pre>/i);
  console.log("[Cifraclub] pre tag found:", !!preMatch, "semitones:", semitones);
  if (!preMatch) {
    console.log("[Cifraclub] html sample:", clean.slice(0, 500));
    return null;
  }

  const raw = preMatch[1];
  const chordPattern = /<b>([A-G][#b]?(?:m(?:aj)?|dim|aug|sus[24]?|add)?(?:[0-9])?(?:\/[A-G][#b]?)?)<\/b>/g;
  const allChords = [...raw.matchAll(chordPattern)].map(m => m[1]);
  console.log("[Cifraclub] chords found:", allChords.length, "transpose:", semitones);
  if (allChords.length < 2) return null;

  // ── Convert to plain text, applying detected transposition ──
  let sheetText = raw
    .replace(/<b>([^<]+)<\/b>/g, (_, chord) => transposeChord(chord, semitones))
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&").replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&#[0-9]+;/g, "")
    .trim();

  // Decode any remaining HTML entities (tildes, ñ, etc.)
  sheetText = decodeHtmlEntities(sheetText);

  // Prepend capo/tone info if found
  if (capoInfo) sheetText = `[${capoInfo} — acordes transpuestos automáticamente]\n\n` + sheetText;

  return { type: "text", content: sheetText, source: "Cifraclub", url: "" };
}

// ── Chord transposition engine ────────────────────────────────
const NOTES_SHARP = ["C","C#","D","D#","E","F","F#","G","G#","A","A#","B"];
const NOTES_FLAT  = ["C","Db","D","Eb","E","F","Gb","G","Ab","A","Bb","B"];

// Convert flat enharmonics to sharps — keeps Bb family untouched
function flatToSharpText(text) {
  // Convert ALL flat roots to sharp equivalents (total conversion, no exceptions)
  const map = { "Bb":"A#","Eb":"D#","Ab":"G#","Db":"C#","Gb":"F#","Cb":"B","Fb":"E" };
  // Match root + optional suffix + optional slash bass (also convert bass note)
  return text.replace(/\b(Bb|Eb|Ab|Db|Gb|Cb|Fb)((?:maj|ma|M|min|m|dim|aug|sus[24]?|add)?(?:[0-9]{1,2})?(?:[#b][0-9]+)*)?(?:\/(Bb|Eb|Ab|Db|Gb|Cb|Fb|[A-G][#b]?))?/g,
    (match, root, suffix, bass) => {
      let result = (map[root] || root) + (suffix || '');
      if (bass) result += '/' + (map[bass] || bass);
      return result;
    }
  );
}

// Convert ALL sharps to flats (total conversion, no exceptions)
function sharpToFlatText(text) {
  const map = { "C#":"Db","D#":"Eb","F#":"Gb","G#":"Ab","A#":"Bb" };
  return text.replace(/\b([A-G]#)((?:maj|ma|M|min|m|dim|aug|sus[24]?|add)?(?:[0-9]{1,2})?(?:[#b][0-9]+)*)?(?:\/([A-G]#|[A-G][#b]?))?/g,
    (match, root, suffix, bass) => {
      let result = (map[root] || root) + (suffix || '');
      if (bass) result += '/' + (map[bass] || bass);
      return result;
    }
  );
}

function transposeChord(chord, semitones) {
  if (!semitones) return chord;
  return chord.replace(/[A-G][#b]?/g, note => {
    const arr    = note.includes("b") ? NOTES_FLAT : NOTES_SHARP;
    const idx    = arr.indexOf(note);
    if (idx === -1) return note;
    const newIdx = ((idx + semitones) % 12 + 12) % 12;
    return arr[newIdx];
  });
}

// Wrap chord tokens in <span class="chord"> — ONLY on chord-dominant lines
function highlightChords(safeText) {
  return safeText.split("\n").map(line => {
    if (/^\s*[\[—(]/.test(line)) return line;
    const stripped = line.replace(/<[^>]*>/g, "");
    const tokens = stripped.trim().split(/\s+/).filter(Boolean);
    if (tokens.length === 0) return line;
    const isChord = t => {
      const c = t.replace(/&[a-z0-9#]+;/gi,"").replace(/<[^>]*>/g,"").replace(/[()[\]]/g,"");
      return c.length > 0 && c.length <= 12 && MASTER_CHORD_RE.test(c);
    };
    const chordCount = tokens.filter(isChord).length;
    if (chordCount === 0 || chordCount / tokens.length < 0.45) return line;
    return line.replace(
      new RegExp('(?<![A-Za-z])(' + MASTER_CHORD_INLINE.source + ')(?![A-Za-z0-9])', 'g'),
      (match, chord) => /^[A-G]/.test(chord) ? `<span class="chord">${chord}</span>` : match
    );
  }).join("\n");
}
// Replaces chord tokens (A-G + optional # or b + optional suffix)
// without touching lyric words that start with those letters
function applyTransposeToSheet(text, semitones) {
  if (!semitones) return text;
  return text.split("\n").map(line => {
    const tokens = line.trim().split(/(\s+)/);
    const wordTokens = tokens.filter(t => t.trim());
    if (wordTokens.length === 0) return line;
    const chordCount = wordTokens.filter(t => MASTER_CHORD_RE.test(t.trim())).length;
    if (chordCount / wordTokens.length >= 0.5) {
      return tokens.map(t =>
        MASTER_CHORD_RE.test(t.trim()) ? transposeChord(t.trim(), semitones) + (t.endsWith(" ") ? " " : "") : t
      ).join("");
    }
    return line;
  }).join("\n");
}

function buildSectionsFromChordSheet(lines, title, artist) {
  const sectionKeywords = /^(intro|vers[oa]|coro|chorus|bridge|puente|outro|refr[aá]n|pr[eé]-?coro|solo|instrumental)/i;
  const sections = [];
  let current = { name: "Intro", lines: [] };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    // New section header
    if (sectionKeywords.test(line) && line.length < 30) {
      if (current.lines.length) sections.push(current);
      current = { name: capitalize(line), lines: [] };
      continue;
    }

    // Chord line: contains [CHORD] tokens
    const hasChords = /\[[A-G][#b]?[^\]]*\]/.test(line);
    if (hasChords) {
      // Extract chords in order
      const chords = [...line.matchAll(/\[([^\]]+)\]/g)].map(m => m[1]);
      // Next non-empty line is the lyric
      let lyric = "";
      let j = i + 1;
      while (j < lines.length && !lines[j].trim()) j++;
      if (j < lines.length && !/\[[A-G]/.test(lines[j])) {
        lyric = lines[j].trim();
        i = j; // skip lyric line
      }
      current.lines.push({ text: lyric || "♩", chords: padChords(chords) });
    } else {
      // Pure lyric line with no chords above
      current.lines.push({ text: line, chords: [] });
    }

    if (current.lines.length >= 8) {
      sections.push(current);
      current = { name: `Sección ${sections.length + 1}`, lines: [] };
    }
  }
  if (current.lines.length) sections.push(current);

  return sections.length
    ? sections
    : [{ name: "Canción", lines: [{ text: `${title} — ${artist}`, chords: [] }] }];
}

function padChords(chords) {
  const out = chords.slice(0, 4);
  while (out.length < 4) out.push("");
  return out;
}

function capitalize(s) {
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}

function guessKey(chords) {
  const first = (chords || [])[0] || "C";
  return first.match(/^[A-G][#b]?m?/)?.[0] || first;
}

// ── Strategy 2: E-Chords via Worker ──────────────────────────
async function fetchChordsViaEChords(title, artist) {
  const q = encodeURIComponent(`${artist} ${title}`);
  const searchHtml = await fetchHtmlViaWorker(`https://www.e-chords.com/search-all/${q}`);
  if (!searchHtml) throw new Error("E-Chords: sin respuesta");

  // e-chords search results — try multiple patterns
  const linkMatch = searchHtml.match(/href="(https?:\/\/www\.e-chords\.com\/(?:chords|tabs)\/[^"]+)"/i)
                 || searchHtml.match(/href="(\/(?:chords|tabs)\/[^"? ]+)"/i);
  console.log("[E-Chords] link found:", linkMatch?.[1]);
  if (!linkMatch) throw new Error("E-Chords: canción no encontrada");

  const pageUrl = linkMatch[1].startsWith("http") ? linkMatch[1] : "https://www.e-chords.com" + linkMatch[1];
  const pageHtml = await fetchHtmlViaWorker(pageUrl);
  if (!pageHtml) throw new Error("E-Chords: sin respuesta en página");

  console.log("[E-Chords] page html length:", pageHtml.length);

  const matches = [...pageHtml.matchAll(/\[([A-G][#b]?(?:m(?:aj)?|dim|aug|sus)?[0-9]?)\]/g)];
  console.log("[E-Chords] chords found:", matches.length);
  if (matches.length < 2) throw new Error("E-Chords: sin acordes");

  const uniqueChords = [...new Set(matches.map(m => m[1]))].slice(0, 10);
  const preMatch = pageHtml.match(/<pre[^>]*id="core"[^>]*>([\s\S]*?)<\/pre>/i)
                || pageHtml.match(/<pre[^>]*>([\s\S]*?)<\/pre>/i);
  console.log("[E-Chords] pre found:", !!preMatch);
  const rawText = preMatch
    ? preMatch[1].replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&nbsp;/g, " ")
    : "";

  const sheetText = decodeHtmlEntities(rawText.trim());
  if (!sheetText) throw new Error("E-Chords: contenido vacío");
  return { type: "text", content: sheetText, source: "E-Chords", url: pageUrl };
}

// ── Ultimate Guitar scrape ────────────────────────────────────
async function fetchChordsViaUltimateGuitar(title, artist) {
  const q = encodeURIComponent(`${artist} ${title}`);
  const searchHtml = await fetchHtmlViaWorker(
    `https://es.ultimate-guitar.com/search.php?search_type=title&value=${q}`
  );
  if (!searchHtml) throw new Error("UG: sin respuesta");

  // UG stores data in a div with data-content JSON
  const dataMatch = searchHtml.match(/class="js-store"[^>]*data-content="([^"]+)"/);
  if (!dataMatch) throw new Error("UG: no data-content");

  const json = JSON.parse(dataMatch[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&'));
  const results = json?.store?.page?.data?.results || [];
  console.log("[UG] results count:", results.length);

  const badVersions = /live|acoustic|acústic|en\s*vivo|unplugged|demo|rehearsal|karaoke|remix|cover/i;

  // Normalize for fuzzy title matching (strip feat, punctuation, extra spaces)
  function normTitle(s) {
    return (s || "").toLowerCase()
      .replace(/\(feat\.?.*?\)/gi, "").replace(/\(ft\.?.*?\)/gi, "")
      .replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
  }
  const normSearchTitle  = normTitle(title);
  const normSearchArtist = normTitle(artist).split(" ")[0]; // first word of artist

  const chordResults = results.filter(r => r.type === "Chords");

  // Score each result: title match + artist match + not bad version
  function score(r) {
    const t = normTitle(r.song_name);
    const a = normTitle(r.artist_name);
    let s = 0;
    if (t === normSearchTitle)                            s += 10; // exact title
    else if (t.includes(normSearchTitle) || normSearchTitle.includes(t)) s += 5;
    if (a.includes(normSearchArtist))                     s += 4;
    if (!badVersions.test(r.song_name || ""))             s += 2;
    if (r.rating >= 4)                                    s += 1;
    return s;
  }

  const chord = chordResults
    .map(r => ({ r, s: score(r) }))
    .sort((a, b) => b.s - a.s)[0]?.r;

  if (!chord?.tab_url) throw new Error("UG: sin acordes");
  console.log("[UG] selected:", chord.song_name, "by", chord.artist_name, "score:", score(chord));

  const pageHtml = await fetchHtmlViaWorker(chord.tab_url);
  if (!pageHtml) throw new Error("UG: sin respuesta en página");

  const result = parseUltimateGuitarPage(pageHtml, title, artist);
  result.url = chord.tab_url;
  return result;
}

function parseUltimateGuitarPage(html, title, artist) {
  const dataMatch = html.match(/class="js-store"[^>]*data-content="([^"]+)"/);
  if (!dataMatch) throw new Error("UG: no data en página");

  let json;
  try {
    const raw = dataMatch[1]
      .replace(/&quot;/g, '"')
      .replace(/&amp;/g, '&')
      .replace(/&#039;/g, "'")
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>');
    json = JSON.parse(raw);
  } catch(e) { throw new Error("UG: JSON inválido - " + e.message); }

  const content = json?.store?.page?.data?.tab_view?.wiki_tab?.content
               || json?.store?.page?.data?.tab?.content
               || json?.store?.page?.data?.tab_view?.tab?.content;
  if (!content) {
    console.log("[UG] available keys:", JSON.stringify(Object.keys(json?.store?.page?.data || {})));
    throw new Error("UG: sin contenido de acordes");
  }
  console.log("[UG] raw content sample:", content.slice(0, 300));

  // ── Detect capo — check JSON metadata first (most reliable) ──
  let ugSemitones = 0;
  let capoLabel = "";

  // 1. Check UG JSON fields: tab_view.meta.capo, tab.capo, etc.
  const tabData  = json?.store?.page?.data?.tab_view?.tab
                || json?.store?.page?.data?.tab;
  const metaData = json?.store?.page?.data?.tab_view?.meta
                || json?.store?.page?.data?.meta;

  const jsonCapo = tabData?.capo ?? metaData?.capo ?? null;
  if (jsonCapo && parseInt(jsonCapo) > 0) {
    ugSemitones = parseInt(jsonCapo);
    capoLabel = `Cejilla ${ugSemitones}`;
    console.log("[UG] capo from JSON field:", ugSemitones);
  }

  // 2. Search the full HTML for "Cejilla:2o traste" or "Capo: 2nd fret"
  if (!ugSemitones) {
    const capoInHtml = html.match(/[Cc]ejilla[:\s]*(\d+)[oa°º]?\s*(?:traste)?/i)
                    || html.match(/[Cc]apo\s+[Oo][Nn]\s+(\d+)/i)
                    || html.match(/[Cc]apo[:\s]+(\d+)(?:st|nd|rd|th)?\s*(?:fret)?/i)
                    || html.match(/"capo"\s*:\s*"?(\d+)"?/i);
    if (capoInHtml && parseInt(capoInHtml[1]) > 0) {
      ugSemitones = parseInt(capoInHtml[1]);
      capoLabel = `Cejilla ${ugSemitones}`;
      console.log("[UG] capo from HTML:", ugSemitones);
    }
  }

  // 3. Fallback: search inside tab content text itself
  if (!ugSemitones) {
    const capoInContent = content.match(/[Cc]apo\s+[Oo][Nn]\s+(\d+)/i)
                       || content.match(/[Cc]apo[:\s]+(\d+)(?:st|nd|rd|th)?/i)
                       || content.match(/[Cc]ejilla[:\s]+(\d+)/i);
    if (capoInContent && parseInt(capoInContent[1]) > 0) {
      ugSemitones = parseInt(capoInContent[1]);
      capoLabel = `Cejilla ${ugSemitones}`;
      console.log("[UG] capo from content text:", ugSemitones);
    }
  }

  const sectionMap = {
    verse: "── Verso", chorus: "── Coro", bridge: "── Puente",
    intro: "── Intro", outro: "── Outro", "pre-chorus": "── Pre-Coro",
    interlude: "── Interludio", solo: "── Solo",
  };

  let text = content
    // 1. Strip tab diagram blocks first
    .replace(/\[tab]([\s\S]*?)\[\/tab]/gi, (_, inner) => {
      return inner.split("\n")
        .filter(l => !/^\s*[eEbBgGdDaA]\|/.test(l) && !/^[-|]+$/.test(l.trim()))
        .join("\n");
    })
    // 2. Unwrap chord markers
    .replace(/\[ch]([^\[]*?)\[\/ch]/gi, "$1")
    // 3. Now replace section markers (tab/ch are already gone)
    .replace(/\[([a-z_\- ]+?)(?::\s*[^\]]*)?]/gi, (_, tag) => {
      const key = tag.toLowerCase().trim();
      return "\n" + (sectionMap[key] || ("── " + tag)) + " ──\n";
    })
    // 4. Remove any remaining unknown tags
    .replace(/\[[^\]]*]/gi, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  // Decode any remaining HTML entities (tildes, ñ, etc.)
  text = decodeHtmlEntities(text);

  // (capo already detected above)

  if (ugSemitones) {
    const lines = text.split("\n");
    const transposed = lines.map(line => {
      if (/^[A-G][#b]?[\w\/]*\s*-\s*[x\d]+/i.test(line.trim())) return line;
      return applyTransposeToSheet(line, ugSemitones);
    });
    text = transposed.join("\n");
    text = `[${capoLabel} — acordes transpuestos automáticamente]\n\n` + text;
  } else {
    text = `[Sin cejilla]\n\n` + text;
  }

  if (!text || text.length < 20) throw new Error("UG: contenido vacío");
  return { type: "text", content: text, source: "Ultimate Guitar" };
}


// ── Main orchestrator ─────────────────────────────────────────
async function fetchChordsForTrack(track, trackKey) {
  const title  = cleanTrackLookupText(track.name);
  const artist = track.artists[0] || "";

  // ── Prefetch cache hit? ───────────────────────────────────
  if (prefetchCache.has(trackKey)) {
    const cached = prefetchCache.get(trackKey);
    prefetchCache.delete(trackKey); // consume it
    console.log("[prefetch] cache hit →", track.name);

    state.chordsTone     = "live";
    state.chordsText     = "Encontrados";
    state.chordsData     = cached.sources[0];
    state.chordsSources  = cached.sources;
    state.chordsSourceIdx = 0;
    state.transpose      = 0;
    if (el.transposeLabel) el.transposeLabel.textContent = "0";
    showScrollControls(true);
    state.detectedKey = cached.detectedKey;
    updateKeyBadge();
    if (state.currentTrack?.id && state.tokens) {
      fetchAudioFeatures(state.currentTrack.id).catch(() => {});
    }
    if (state.currentTrack) recordStats(state.currentTrack, state.detectedKey);
    if (state.scroll.syncMode) {
      setTimeout(() => {
        state.scroll.userPaused = false;
        state.scroll._acc = 0; state.scroll._lastTime = null;
        updateScrollUI();
      }, 800);
    }
    renderChords();
    renderSourceSwitcher();
    return;
  }
  // ─────────────────────────────────────────────────────────

  state.chordsTone = "warn";
  state.chordsText = "Buscando…";
  state.chordsData = null;
  state.chordsSources = [];
  state.chordsSourceIdx = 0;
  state.transpose = 0;
  if (el.transposeLabel) el.transposeLabel.textContent = '0';
  if (el.chordsStatusText) el.chordsStatusText.textContent = "Buscando acordes…";
  renderChords();

  if (!state.settings.workerUrl) {
    state.chordsTone = "warn";
    state.chordsText = "Sin Worker";
    if (el.chordsStatusText) el.chordsStatusText.textContent = "⚙️ Configura la URL de tu Cloudflare Worker en Setup para obtener acordes automáticamente.";
    renderChords();
    return;
  }

  const sources = [
    { name: "Cifraclub",       fn: () => fetchChordsViaCifraclub(title, artist) },
    { name: "Ultimate Guitar", fn: () => fetchChordsViaUltimateGuitar(title, artist) },
    { name: "E-Chords",        fn: () => fetchChordsViaEChords(title, artist) },
  ];

  const found = [];
  for (const src of sources) {
    if (trackKey !== state.lastTrackKey) return;
    try {
      if (el.chordsStatusText) el.chordsStatusText.textContent = `Buscando en ${src.name}…`;
      const result = await src.fn();
      if (result) {
        result.source = result.source || src.name;
        found.push(result);
        console.log(`✓ ${src.name}`);
      }
    } catch (e) { console.log(`✗ ${src.name}: ${e.message}`); }
  }

  if (trackKey !== state.lastTrackKey) return;

  if (found.length > 0) {
    state.chordsTone   = "live";
    state.chordsText   = "Encontrados";
    state.chordsData   = found[0];
    state.chordsSources = found;
    state.chordsSourceIdx = 0;
    showScrollControls(true);

    // Detect key from chords
    state.detectedKey = detectKeyFromSheet(found[0].content || "");
    updateKeyBadge();

    // Fetch BPM from Spotify Audio Features
    if (state.currentTrack?.id && state.tokens) {
      fetchAudioFeatures(state.currentTrack.id).catch(() => {});
    }

    // Record stats
    if (state.currentTrack) recordStats(state.currentTrack, state.detectedKey);

    // If sync mode is on, auto-resume scroll after DOM renders the chords
    if (state.scroll.syncMode) {
      setTimeout(() => {
        state.scroll.userPaused = false;
        state.scroll._acc       = 0;
        state.scroll._lastTime  = null;
        updateScrollUI();
      }, 800);
    }

    // Kick off prefetch for next song (non-blocking, after a short delay
    // so the current song's network requests finish first)
    setTimeout(() => prefetchNextTrack(), 3000);

  } else {
    state.chordsTone = "warn";
    state.chordsText = "No encontrados";
    state.chordsData = null;
    state.chordsSources = [];
    showScrollControls(false);
    if (el.chordsStatusText) {
      el.chordsStatusText.textContent = "No encontrado automáticamente — usa los links de búsqueda abajo.";
    }
  }

  renderChords();
  renderSourceSwitcher();
}

function parseChordJSON(raw) {
  // Try direct
  try { return JSON.parse(raw.trim()); } catch (_) {}
  // Strip code fences
  const stripped = raw.replace(/```json\s*/gi, "").replace(/```/g, "").trim();
  try { return JSON.parse(stripped); } catch (_) {}
  // Find first { ... }
  const s = raw.indexOf("{"), e = raw.lastIndexOf("}");
  if (s !== -1 && e > s) {
    try { return JSON.parse(raw.slice(s, e + 1)); } catch (_) {}
  }
  return null;
}

// ─── Progress ─────────────────────────────────────────────────
function startProgressLoop() {
  if (state.progressTimer) window.clearInterval(state.progressTimer);
  state.progressTimer = window.setInterval(() => {
    updateProgressDisplay();
    renderSyncLabel();
    highlightActiveLine();
  }, 400);
  startTeleprompterLoop();
}

// ─── Teleprompter — free scroll + song-sync mode ─────────────
function startTeleprompterLoop() {
  if (state.scroll._rafId) cancelAnimationFrame(state.scroll._rafId);
  state.scroll._lastTime = null;
  state.scroll._acc      = 0;

  function tick(now) {
    state.scroll._rafId = requestAnimationFrame(tick);

    if (state.scroll.userPaused) {
      state.scroll._lastTime = null;
      return;
    }

    if (!state.scroll._lastTime) { state.scroll._lastTime = now; return; }
    const dt = Math.min(now - state.scroll._lastTime, 100) / 1000;
    state.scroll._lastTime = now;

    let pxPerSec;

    if (state.scroll.bpmMode && state.bpm) {
      // BPM-calibrated scroll: proportional to tempo
      const PX_PER_BEAT = 6;
      pxPerSec = (state.bpm / 60) * PX_PER_BEAT * state.scroll.speed;
    } else if (state.scroll.syncMode) {
      // ── Song-sync: LRC-aware if available, else time-proportional ──
      const track = state.currentTrack;
      if (!track || !track.durationMs) {
        pxPerSec = 40 * state.scroll.speed;
      } else {
        const estimatedMs = computeProgressMs();

        // ── LRC-based sync: scroll to the lyric line matching current time ──
        if (state.syncedLyrics.length > 0) {
          // Find current lyric index — the last line whose timeMs <= estimatedMs
          // Apply lookahead: scroll slightly early so the line is visible before it's sung
          const avgRtt = state.rttSamples.length
            ? state.rttSamples.reduce((a, b) => a + b, 0) / state.rttSamples.length : 0;
          const lookaheadMs = avgRtt / 2 + 300; // RTT/2 + animation buffer
          const lookupMs = estimatedMs + lookaheadMs;

          let lrcIdx = -1;
          for (let i = state.syncedLyrics.length - 1; i >= 0; i--) {
            if (state.syncedLyrics[i].timeMs <= lookupMs) { lrcIdx = i; break; }
          }

          // Map LRC line index to scroll position WITHIN the chords card
          if (lrcIdx >= 0) {
            const chordsCard = document.querySelector('.chords-card');
            const chordSheet = document.querySelector('.chord-sheet');
            if (chordsCard && chordSheet) {
              const cardTop = chordsCard.getBoundingClientRect().top + window.scrollY - 8;
              const sheetHeight = chordSheet.scrollHeight;
              const ratio = lrcIdx / Math.max(state.syncedLyrics.length - 1, 1);
              const targetY = cardTop + (sheetHeight * ratio);
              const currentY = window.scrollY;
              const diff = targetY - currentY;

              pxPerSec = (diff * 2.5) * state.scroll.speed;
              pxPerSec = Math.max(-150, Math.min(150, pxPerSec));
            } else {
              pxPerSec = 0;
            }
          } else {
            pxPerSec = 0;
          }
        } else {
          // ── Fallback: time-proportional (original behavior) ──
          const scrollable = document.documentElement.scrollHeight - window.innerHeight;
          const currentScroll = window.scrollY;
          const remaining = scrollable - currentScroll;
          const msRemaining = Math.max(track.durationMs - estimatedMs, 1000);
          const secRemaining = msRemaining / 1000;
          pxPerSec = remaining > 0 ? (remaining / secRemaining) : 0;
          pxPerSec *= state.scroll.speed;
        }
      }
    } else {
      pxPerSec = 40 * state.scroll.speed;
    }

    state.scroll._acc += pxPerSec * dt;
    const step = Math.trunc(state.scroll._acc);
    if (step === 0) return;
    state.scroll._acc -= step;
    window.scrollBy({ top: step, behavior: "instant" });
  }

  requestAnimationFrame(tick);
}

function updateScrollUI() {
  if (!el.scrollToggle) return;
  const paused = state.scroll.userPaused;
  const sync   = state.scroll.syncMode;

  el.scrollToggle.textContent = paused ? "▶ Auto" : "■ Auto";
  el.scrollToggle.classList.toggle("paused", paused);

  // Sync button state
  const syncBtn = document.getElementById("sync-scroll-btn");
  if (syncBtn) {
    syncBtn.classList.toggle("active", sync);
    const hasLRC = state.syncedLyrics && state.syncedLyrics.length > 0;
    syncBtn.classList.toggle("lrc-active", sync && hasLRC);
    if (sync && hasLRC) {
      syncBtn.textContent = "♫ LRC";
      syncBtn.title = "Sync con letras sincronizadas (LRC): ON";
    } else if (sync) {
      syncBtn.textContent = "♫ Sync";
      syncBtn.title = "Sync con duración de canción: ON";
    } else {
      syncBtn.textContent = "♫ Sync";
      syncBtn.title = "Sincronizar con duración de canción";
    }
  }

  // BPM button state
  const bpmBtn = document.getElementById("bpm-scroll-btn");
  if (bpmBtn) {
    bpmBtn.classList.toggle("active", state.scroll.bpmMode);
    const bpmLabel = state.bpm ? `♩${Math.round(state.bpm)}` : "♩BPM";
    bpmBtn.textContent = bpmLabel;
    bpmBtn.style.display = state.bpm ? "inline-flex" : "none";
    // Hide the divider immediately before BPM button when BPM unavailable
    const bpmDiv = bpmBtn.previousElementSibling;
    if (bpmDiv && bpmDiv.classList.contains("ctrl-div")) {
      bpmDiv.style.display = state.bpm ? "" : "none";
    }
  }

  if (el.scrollSpeedLabel) {
    el.scrollSpeedLabel.textContent = state.scroll.speed.toFixed(2).replace(/\.?0+$/, "") + "×";
  }
}

function showScrollControls(visible) {
  // Target the new ctrl-bar element (id="scroll-controls" still works)
  const bar = document.getElementById("scroll-controls");
  if (bar) bar.style.display = visible ? "flex" : "none";
}

// ─── Render ───────────────────────────────────────────────────
function renderAll() {
  renderSetup();
  renderNowPlaying();
  renderLyrics();
  renderChords();
  renderSearchDeck();
}

function renderSetup() {
  if (el.authStatusPill) {
    el.authStatusPill.className   = `status-pill ${pillClassForTone(state.authTone)}`;
    el.authStatusPill.textContent = state.authText;
  }
  if (el.authHelper) {
    el.authHelper.textContent = getRedirectUri()
      ? `Redirect URI: ${getRedirectUri()}`
      : "Publica en GitHub Pages para obtener la Redirect URI.";
  }
}

function renderNowPlaying() {
  const track = state.currentTrack;
  el.playbackPill.className   = `status-pill ${pillClassForTone(state.playbackTone)}`;
  el.playbackPill.textContent = state.playbackText;

  if (!track) {
    el.coverArt.textContent       = "SP";
    el.trackKicker.textContent    = "Conecta Spotify para empezar";
    el.trackTitle.textContent     = "Sin canción activa";
    el.trackArtist.textContent    = "La app detecta automáticamente la pista actual.";
    el.trackAlbum.textContent     = "";
    el.spotifyLink.classList.add("hidden");
    el.progressLeft.textContent   = "0:00";
    el.progressRight.textContent  = "0:00";
    el.progressFill.style.width   = "0%";
    setPageBackground(null);
    document.documentElement.style.removeProperty("--chord-color");
    document.documentElement.style.removeProperty("--chord-stroke");
    renderSyncLabel();
    return;
  }

  el.coverArt.innerHTML = track.image
    ? `<img alt="Portada" src="${escapeHtml(track.image)}">`
    : initialsFromTrack(track);

  // Set background from album art color
  if (track.image) extractAndSetBackground(track.image);
  else setPageBackground(null);

  el.trackKicker.textContent    = track.isPlaying ? "Spotify detectado en tiempo real" : "Spotify detectado, en pausa";
  el.trackTitle.textContent     = track.name;
  el.trackArtist.textContent    = track.artists.join(", ");
  el.trackAlbum.textContent     = track.album;

  if (track.spotifyUrl) {
    el.spotifyLink.href = track.spotifyUrl;
    el.spotifyLink.classList.remove("hidden");
  } else {
    el.spotifyLink.classList.add("hidden");
  }

  updateProgressDisplay();
  renderSyncLabel();
}

function renderLyrics() { /* lyrics section removed */ }

// ─── Chords Render ────────────────────────────────────────────
function renderSourceSwitcher() {
  if (!el.sourceSwitcher) return;
  const sources = state.chordsSources || [];
  if (sources.length === 0) {
    el.sourceSwitcher.style.display = "none";
    el.sourceSwitcher.innerHTML = "";
    return;
  }
  el.sourceSwitcher.style.display = "flex";
  el.sourceSwitcher.innerHTML = sources.map((s, i) =>
    `<button class="source-btn${i === state.chordsSourceIdx ? " active" : ""}" data-src-idx="${i}" data-url="${escapeHtml(s.url || '')}" title="${s.url ? 'Mantén presionado para copiar link' : ''}">
      ${escapeHtml(s.source || "Fuente " + (i+1))}
    </button>`
  ).join("");

  // Long-press to copy URL
  el.sourceSwitcher.querySelectorAll(".source-btn[data-url]").forEach(btn => {
    let pressTimer = null;
    const startPress = () => {
      pressTimer = setTimeout(async () => {
        const url = btn.dataset.url;
        if (!url) return;
        try {
          await navigator.clipboard.writeText(url);
          const orig = btn.textContent.trim();
          btn.textContent = "✓ Copiado";
          setTimeout(() => { btn.textContent = orig; }, 1500);
        } catch(_) {}
      }, 500);
    };
    const cancelPress = () => clearTimeout(pressTimer);
    btn.addEventListener("pointerdown", startPress);
    btn.addEventListener("pointerup",   cancelPress);
    btn.addEventListener("pointerleave",cancelPress);
  });
}

// ── Chord sheet HTML renderer ─────────────────────────────────
// Converts raw chord-over-lyric text into structured HTML where
// chords float above the matching syllable. Lines wrap naturally
// on mobile without ever misaligning chords and lyrics.

// ── Master chord regex — covers all real-world chord types ──────
// Root: A-G + optional # or b
// Quality: maj/ma/M, min/m, dim, aug, sus, add + all extensions (7,9,11,13)
// Alterations: b5 #5 b9 #9 #11 b13 etc. (any number of them)
// Slash: /[A-G][#b]?
const MASTER_CHORD_RE = /^[A-G][#b]?(?:(?:maj|ma|M)(?:7|9|11|13)?|min(?:7|9|11|13)?|m(?:7|9|11|13|6)?|dim(?:7)?|aug(?:7)?|\+|sus(?:2|4)?|add(?:2|4|9|11))?(?:[0-9]{1,2})?(?:\+)?(?:[#b][0-9]+)*(?:\/[A-G][#b]?)?$/;
// Non-anchored version for inline matching (used in token extraction)
const MASTER_CHORD_INLINE = /[A-G][#b]?(?:(?:maj|ma|M)(?:7|9|11|13)?|min(?:7|9|11|13)?|m(?:7|9|11|13|6)?|dim(?:7)?|aug(?:7)?|\+|sus(?:2|4)?|add(?:2|4|9|11))?(?:[0-9]{1,2})?(?:\+)?(?:[#b][0-9]+)*(?:\/[A-G][#b]?)?/g;

function isChordOnlyLine(line) {
  const stripped = line.trim();
  if (!stripped) return false;
  if (/^[\[—(─]/.test(stripped)) return false;
  const tokens = stripped.split(/\s+/).filter(Boolean);
  if (!tokens.length) return false;
  const chordCount = tokens.filter(t => MASTER_CHORD_RE.test(t)).length;
  return chordCount > 0 && chordCount / tokens.length >= 0.5;
}

function parseChordsFromLine(line) {
  const result = [];
  let m;
  const re = new RegExp(MASTER_CHORD_INLINE.source, 'g');
  while ((m = re.exec(line)) !== null) {
    result.push({ pos: m.index, chord: m[0] });
  }
  return result;
}

function buildPairHTML(chordLine, lyricLine) {
  const chords = parseChordsFromLine(chordLine);
  if (!chords.length) return buildLyricLineHTML(lyricLine);

  const lyrics = lyricLine || '';

  // Snap chord positions to word boundaries to avoid splitting words mid-syllable.
  // In monospace sources, chord position N means "N chars in". But in proportional
  // fonts, slicing at exact positions can cut words ("t" / "rack" from "track").
  // Fix: when a chord position falls mid-word, snap back to word start.
  function snapToWordStart(pos) {
    if (pos <= 0) return 0;
    if (pos >= lyrics.length) return lyrics.length;
    // If we're mid-word (current char is non-space AND previous char is non-space),
    // walk back to the start of this word
    if (lyrics[pos] !== ' ' && pos > 0 && lyrics[pos - 1] !== ' ') {
      let p = pos;
      while (p > 0 && lyrics[p - 1] !== ' ') p--;
      return p;
    }
    return pos;
  }

  // Build segments with snapped positions — avoids word splits
  const snapped = chords.map(c => ({ chord: c.chord, pos: snapToWordStart(c.pos) }));

  // Deduplicate: if multiple chords snap to the same position,
  // keep them all but only the first one gets the lyric text
  const segments = [];
  for (let i = 0; i < snapped.length; i++) {
    const start = snapped[i].pos;
    const end   = i + 1 < snapped.length ? snapped[i + 1].pos : lyrics.length;
    const text  = start < end ? lyrics.slice(start, end) : '';
    segments.push({ chord: snapped[i].chord, text });
  }

  // Text before the first chord
  const prefix = lyrics.slice(0, snapped[0].pos);

  let html = '<span class="cs-pair">';
  if (prefix) html += `<span class="cs-word">${escapeHtml(prefix)}</span>`;
  for (const seg of segments) {
    html += `<span class="cs-unit">` +
      `<span class="cs-chord">${escapeHtml(seg.chord)}</span>` +
      `<span class="cs-word">${escapeHtml(seg.text) || '\u00A0'}</span>` +
      `</span>`;
  }
  html += '</span>';
  return html;
}

function buildLyricLineHTML(line) {
  if (!line.trim()) return '<div class="cs-blank"></div>';
  // Section header
  if (/^[\[—(─]/.test(line.trim()) || /^──/.test(line.trim())) {
    return `<div class="cs-section">${escapeHtml(line.trim())}</div>`;
  }
  return `<div class="cs-lyric">${escapeHtml(line)}</div>`;
}

// Detect tablature lines: e|---0---|, B|--3--| , |----|, tuning lines, etc.
function isTabLine(line) {
  const t = line.trim();
  // Standard tab: starts with string letter + pipe
  if (/^[eEbBgGdDaA]\|/.test(t)) return true;
  // Pipe-delimited dashes/numbers (tab without letter prefix)
  if (/^\|[\d\-hpbs\/\\~x\s|]+\|?\s*$/.test(t)) return true;
  // Lines of pure dashes that look like tab continuation
  if (/^[\-|]+$/.test(t) && t.length > 6) return true;
  return false;
}

function buildChordSheetHTML(text) {
  const lines  = text.split('\n');
  let html     = '';
  let i        = 0;

  while (i < lines.length) {
    const line     = lines[i];
    const nextLine = lines[i + 1];

    if (!line.trim()) {
      html += '<div class="cs-blank"></div>';
      i++;
      continue;
    }

    // Skip tablature lines entirely
    if (isTabLine(line)) {
      i++;
      continue;
    }

    // Section header lines
    if (/^[\[—(─]/.test(line.trim()) || /^──/.test(line.trim())) {
      html += `<div class="cs-section">${escapeHtml(line.trim())}</div>`;
      i++;
      continue;
    }

    if (isChordOnlyLine(line)) {
      // Peek ahead: if next non-empty line is a lyric line (not tab), pair them
      if (nextLine !== undefined && !isChordOnlyLine(nextLine) && !isTabLine(nextLine || '') && nextLine.trim()
          && !/^[\[—(─]/.test(nextLine.trim()) && !/^──/.test(nextLine.trim())) {
        html += `<div class="cs-row">${buildPairHTML(line, nextLine)}</div>`;
        i += 2;
      } else {
        // Chord-only line with no paired lyric
        html += `<div class="cs-row cs-chords-only">${buildPairHTML(line, '')}</div>`;
        i++;
      }
    } else {
      html += buildLyricLineHTML(line);
      i++;
    }
  }

  return html;
}

function renderChords() {
  if (!el.chordsPill) return;

  el.chordsPill.className   = `status-pill ${pillClassForTone(state.chordsTone)}`;
  el.chordsPill.textContent = state.chordsText;

  const data = state.chordsData;

  // Always hide the JSON-era elements
  if (el.chordsKeyBadge)  el.chordsKeyBadge.style.display = "none";
  if (el.chordsChipsRow)  el.chordsChipsRow.innerHTML     = "";

  if (!data) {
    if (el.chordsSections) el.chordsSections.innerHTML =
      `<p class="chords-placeholder" id="chords-status-text">${
        state.chordsTone === "warn" && state.chordsText !== "Esperando"
          ? escapeHtml(state.chordsText)
          : "Los acordes aparecerán aquí automáticamente cuando detecte una canción."
      }</p>`;
    return;
  }

  // ── Plain-text chord sheet — structured HTML renderer ──
  if (data.type === "text") {
    if (el.chordsSections) {
      let displayed = state.transpose
        ? applyTransposeToSheet(data.content, state.transpose)
        : data.content;
      if (state.enharmonic === "flat2sharp") displayed = flatToSharpText(displayed);
      else if (state.enharmonic === "sharp2flat") displayed = sharpToFlatText(displayed);
      el.chordsSections.innerHTML = `<div class="chord-sheet">${buildChordSheetHTML(displayed)}</div>`;
      attachChordTapHandlers();
    }
    return;
  }

  // ── Scraped structured data (Chordie / E-Chords) ──
  if (el.chordsSections) {
    el.chordsSections.innerHTML = (data.sections || []).map(sec => `
      <div class="chord-section">
        <span class="section-label-chip">${escapeHtml(sec.name || "")}</span>
        ${(sec.lines || []).map(line => buildLyricLine(line)).join("")}
      </div>
    `).join("");
  }
}

function buildLyricLine(line) {
  const text   = line.text   || "";
  const chords = line.chords || [];
  if (!chords.length) return `<div class="lyric-line"><span class="lyric-text">${escapeHtml(text)}</span></div>`;

  const chunkSize = Math.ceil(text.length / chords.length) || 4;
  let chordsHtml = "", lyricsHtml = "";

  chords.forEach((chord, i) => {
    const chunk = text.slice(i * chunkSize, (i + 1) * chunkSize) || (i === 0 ? text : " ");
    const chordLabel = chord && chord.trim() ? escapeHtml(chord.trim()) : "&nbsp;";
    chordsHtml  += `<span class="line-slot chord-label">${chordLabel}</span>`;
    lyricsHtml  += `<span class="line-slot lyric-word">${escapeHtml(chunk)}</span>`;
  });

  // Any remaining text
  const remaining = text.slice(chords.length * chunkSize);
  if (remaining) lyricsHtml += `<span class="lyric-word">${escapeHtml(remaining)}</span>`;

  return `<div class="lyric-line">
    <div class="chords-row">${chordsHtml}</div>
    <div class="text-row">${lyricsHtml}</div>
  </div>`;
}

function renderSearchDeck() { /* search deck section removed */ }

// ─── Search Plan ──────────────────────────────────────────────
function buildSearchPlan(track) {
  const primaryArtist = track.artists[0] || "";
  const title  = cleanTrackLookupText(track.name);
  const exact  = `"${title}" "${primaryArtist}"`;
  const primary   = `${exact} (site:ultimate-guitar.com OR site:e-chords.com OR site:cifraclub.com OR site:lacuerda.net) chords`;
  const secondary = `${exact} (site:lacuerda.net OR site:cifraclub.com OR site:e-chords.com) acordes`;
  const lyricsQ   = `${exact} lyrics`;
  return {
    primaryQuery:   primary,
    secondaryQuery: secondary,
    ddgChordsUrl:    `https://duckduckgo.com/?q=${encodeURIComponent(primary)}`,
    ddgSpanishUrl:   `https://duckduckgo.com/?q=${encodeURIComponent(secondary)}`,
    googleChordsUrl: `https://www.google.com/search?q=${encodeURIComponent(primary)}`,
    googleLyricsUrl: `https://www.google.com/search?q=${encodeURIComponent(lyricsQ)}`
  };
}

async function copyPrimaryQuery() {
  const track = state.currentTrack;
  if (!track) return;
  try {
    await navigator.clipboard.writeText(buildSearchPlan(track).primaryQuery);
    el.externalCopy.textContent = "Query copiada al portapapeles.";
  } catch (_) {
    el.externalCopy.textContent = "No pude copiar la query.";
  }
}

// ─── Progress ─────────────────────────────────────────────────
function updateProgressDisplay() {
  if (!state.currentTrack) return;
  const progressMs = computeProgressMs();
  const durationMs = state.currentTrack.durationMs || 0;
  const ratio = durationMs ? Math.min(progressMs / durationMs, 1) : 0;
  el.progressLeft.textContent = formatMs(progressMs);
  el.progressRight.textContent = formatMs(durationMs);
  el.progressFill.style.width = `${ratio * 100}%`;
}

function renderSyncLabel() {
  if (!state.lastSyncAt) { el.syncLabel.textContent = "Sin sincronizar"; return; }
  const seconds = Math.max(0, Math.floor((Date.now() - state.lastSyncAt) / 1000));
  const avgRtt = state.rttSamples.length
    ? Math.round(state.rttSamples.reduce((a, b) => a + b, 0) / state.rttSamples.length)
    : 0;
  const rttText = avgRtt ? ` · RTT ${avgRtt}ms` : "";
  el.syncLabel.textContent = `Última lectura hace ${seconds}s${rttText}`;
}

function computeProgressMs() {
  if (!state.currentTrack) return 0;
  const base    = state.currentTrack.progressMs || 0;
  if (!state.currentTrack.isPlaying) return base;
  const elapsed = Math.max(0, Date.now() - state.lastSyncAt);
  // Compensate for network latency: Spotify reported progressMs as of ~RTT/2 ago
  const avgRtt = state.rttSamples.length
    ? state.rttSamples.reduce((a, b) => a + b, 0) / state.rttSamples.length
    : 0;
  const rttCompensation = avgRtt / 2;
  return Math.min(base + elapsed + rttCompensation, state.currentTrack.durationMs || base);
}

// ─── Helpers ──────────────────────────────────────────────────
function resetLyrics(tone, text, body) {
  state.lyricsTone = tone;
  state.lyricsText = text;
  state.lyricsBody = body;
  state.lyricsSourceUrl = "";
}

function resetChords(tone = "muted", text = "Esperando") {
  state.chordsTone = tone;
  state.chordsText = text;
  state.chordsData = null;
}

function getRedirectUri() {
  // Auto-detect from current URL (works when hosted on HTTPS)
  if (window.location.protocol === "https:" || window.location.protocol === "http:") {
    const auto = `${window.location.origin}${window.location.pathname}`;
    // Prefer manually entered value if set and different
    if (state.settings.redirectUri && state.settings.redirectUri !== auto) {
      return state.settings.redirectUri;
    }
    return auto;
  }
  // Fallback: use whatever the user typed manually
  return state.settings.redirectUri || "";
}

function setAuthStatus(tone, text)     { state.authTone = tone;     state.authText = text; }
function setPlaybackStatus(tone, text) { state.playbackTone = tone; state.playbackText = text; }

async function extractAndSetBackground(imageUrl) {
  setPageBackground(imageUrl);

  try {
    const proxied = proxyUrl(imageUrl);
    const res  = await fetch(proxied);
    const blob = await res.blob();
    const dataUrl = await new Promise(resolve => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.readAsDataURL(blob);
    });

    const img = new Image();
    img.onload = () => {
      const SIZE = 100;
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = SIZE;
      const ctx = canvas.getContext("2d");
      ctx.drawImage(img, 0, 0, SIZE, SIZE);
      const data = ctx.getImageData(0, 0, SIZE, SIZE).data;
      const total = SIZE * SIZE;

      // Helper: RGB → HSL (all 0-1)
      function rgbToHsl(r, g, b) {
        const max = Math.max(r,g,b), min = Math.min(r,g,b);
        const l = (max + min) / 2;
        if (max === min) return [0, 0, l];
        const d = max - min;
        const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
        let h = 0;
        if (max === r)      h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
        else if (max === g) h = ((b - r) / d + 2) / 6;
        else                h = ((r - g) / d + 4) / 6;
        return [h * 360, s, l];
      }

      // Helper: HSL → hex (s and l are 0-1, h is 0-360)
      function hslToHex(h, s, l) {
        const c = (1 - Math.abs(2*l - 1)) * s;
        const x = c * (1 - Math.abs((h/60) % 2 - 1));
        const m = l - c/2;
        let r=0,g=0,b=0;
        const h6 = Math.floor(h/60);
        if      (h6===0){r=c;g=x;}
        else if (h6===1){r=x;g=c;}
        else if (h6===2){g=c;b=x;}
        else if (h6===3){g=x;b=c;}
        else if (h6===4){r=x;b=c;}
        else            {r=c;b=x;}
        const toH = v => Math.round((v+m)*255).toString(16).padStart(2,"0");
        return "#" + toH(r) + toH(g) + toH(b);
      }

      // ── Pass 1: measure average luminosity (detect light/dark cover) ──
      let lumSum = 0;
      for (let i = 0; i < data.length; i += 4) {
        lumSum += (data[i]*0.299 + data[i+1]*0.587 + data[i+2]*0.114) / 255;
      }
      const avgLum = lumSum / total;
      const isLightCover = avgLum > 0.62;
      console.log("[BG] avg luminosity:", avgLum.toFixed(2), isLightCover ? "(light cover)" : "(dark cover)");

      // ── Pass 2: hue bucket voting ────────────────────────────────────
      // 36 buckets = 10° each. Score = pixel count, but only colorful pixels vote.
      const BUCKETS = 36;
      const bucketCount = new Float64Array(BUCKETS); // raw pixel count per bucket
      const bucketSatSum = new Float64Array(BUCKETS); // total saturation per bucket

      for (let i = 0; i < data.length; i += 4) {
        const r = data[i]/255, g = data[i+1]/255, b = data[i+2]/255;
        const [h, s, l] = rgbToHsl(r, g, b);

        // Ignore: near-black, near-white, near-gray
        if (l < 0.12 || l > 0.88 || s < 0.20) continue;

        const bucket = Math.floor(h / 10) % BUCKETS;
        bucketCount[bucket]  += 1;
        bucketSatSum[bucket] += s;
      }

      // Score = count^1.5 × avgSaturation — area dominates, saturation breaks ties
      let bestBucket = -1, bestScore = 0;
      let secondBucket = -1, secondScore = 0;

      for (let i = 0; i < BUCKETS; i++) {
        if (bucketCount[i] === 0) continue;
        const avgSat = bucketSatSum[i] / bucketCount[i];
        const score  = Math.pow(bucketCount[i], 1.5) * avgSat;
        if (score > bestScore) {
          secondBucket = bestBucket; secondScore = bestScore;
          bestBucket = i; bestScore = score;
        } else if (score > secondScore) {
          secondBucket = i; secondScore = score;
        }
      }

      if (bestBucket === -1) {
        console.log("[BG] no colorful pixels — keeping default");
        return;
      }

      const primaryHue   = bestBucket * 10 + 5;   // center of winning bucket
      const secondaryHue = secondBucket >= 0 ? secondBucket * 10 + 5 : (primaryHue + 180) % 360;

      console.log("[BG] primary hue:", Math.round(primaryHue) + "°",
                  "secondary:", Math.round(secondaryHue) + "°",
                  "light cover:", isLightCover);

      if (isLightCover) {
        // Light/white cover: white chords with colored stroke
        // Stroke color = secondary hue, vivid and darkened so it reads on white chord text
        const strokeHex = hslToHex(primaryHue, 0.85, 0.40);
        document.documentElement.style.setProperty("--chord-color", "#ffffff");
        document.documentElement.style.setProperty("--chord-stroke", strokeHex);
        console.log("[BG] light cover → white chords, stroke:", strokeHex);
      } else {
        // Dark/normal cover: vivid chord color from primary hue
        // Saturation 88%, lightness 68% — always readable on dark bg
        const chordHex = hslToHex(primaryHue, 0.88, 0.68);
        document.documentElement.style.setProperty("--chord-color", chordHex);
        document.documentElement.style.removeProperty("--chord-stroke");
        console.log("[BG] chord color →", chordHex);
      }
    };
    img.src = dataUrl;
  } catch(e) {
    console.log("[BG] color extract failed:", e.message);
  }
}

function setPageBackground(imageUrl) {
  const bg = document.getElementById("dynamic-bg");
  if (!bg) return;
  if (!imageUrl) {
    bg.style.backgroundImage = "";
    return;
  }
  bg.style.backgroundImage = `url("${imageUrl}")`;
}

function pillClassForTone(tone) {
  if (tone === "live")  return "status-pill-live";
  if (tone === "warn")  return "status-pill-warn";
  if (tone === "error") return "status-pill-error";
  return "status-pill-muted";
}

function persistTokens() { localStorage.setItem(STORAGE_KEYS.tokens, JSON.stringify(state.tokens)); }

function cleanupUrl() {
  const clean = new URL(window.location.href);
  ["code", "state", "error"].forEach(k => clean.searchParams.delete(k));
  window.history.replaceState({}, "", clean.toString());
}

function buildTrackLookupKey(track) {
  return `${normalizeText(track.artists?.[0] || "")}||${normalizeText(cleanTrackLookupText(track.name || ""))}`;
}

function cleanTrackLookupText(value) {
  return (value || "")
    .replace(/\(([^)]*(live|remaster|version|edit|deluxe|mono|stereo)[^)]*)\)/gi, "")
    .replace(/\[([^\]]*(live|remaster|version|edit|deluxe|mono|stereo)[^\]]*)\]/gi, "")
    .trim();
}

function normalizeText(value) {
  return (value || "")
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/\bfeat(?:uring)?\b.*$/gi, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ").trim();
}

function hideSearchLinks() { /* removed */ }

async function fetchJson(url) {
  try {
    const response = await fetch(url, { headers: { Accept: "application/json" } });
    if (!response.ok) return null;
    return response.json();
  } catch (_) { return null; }
}

function extractLyricsText(payload) {
  if (!payload || typeof payload !== "object") return "";
  if (typeof payload.plainLyrics === "string" && payload.plainLyrics.trim()) return payload.plainLyrics.trim();
  if (typeof payload.syncedLyrics === "string" && payload.syncedLyrics.trim()) {
    const stripped = payload.syncedLyrics
      .replace(/\[[0-9:.]+\]/g, "").split("\n")
      .map(l => l.trim()).filter(Boolean).join("\n");
    if (stripped) return stripped;
  }
  return "";
}

// Extract raw synced lyrics string (with timestamps) from lrclib response
function extractSyncedLyricsRaw(payload) {
  if (!payload || typeof payload !== "object") return "";
  if (typeof payload.syncedLyrics === "string" && payload.syncedLyrics.trim()) {
    return payload.syncedLyrics.trim();
  }
  return "";
}

// Parse LRC format "[mm:ss.cc] lyric line" → [{timeMs, text}]
function parseLRC(syncedText) {
  if (!syncedText) return [];
  const lines = [];
  for (const line of syncedText.split('\n')) {
    const m = line.match(/^\[(\d{1,2}):(\d{2})\.(\d{2,3})\]\s*(.*)/);
    if (!m) continue;
    const timeMs = parseInt(m[1]) * 60000 + parseInt(m[2]) * 1000
                 + parseInt(m[3].length === 2 ? m[3] + '0' : m[3]);
    const text = m[4].trim();
    if (text) lines.push({ timeMs, text });
  }
  return lines.sort((a, b) => a.timeMs - b.timeMs);
}

function randomString(length) {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const values = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(values, v => chars[v % chars.length]).join("");
}

async function pkceChallengeFromVerifier(verifier) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function formatMs(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

function initialsFromTrack(track) {
  return (track.name || "SP").split(/\s+/).filter(Boolean)
    .slice(0, 2).map(c => c[0]).join("").toUpperCase() || "SP";
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function decodeHtmlEntities(str) {
  const ta = document.createElement("textarea");
  ta.innerHTML = str;
  return ta.value;
}

// ═══════════════════════════════════════════════════════════════
//  NEW FEATURES
// ═══════════════════════════════════════════════════════════════

// ── 1. Spotify Audio Features (BPM) ──────────────────────────
async function fetchAudioFeatures(trackId) {
  if (!state.tokens?.accessToken || !trackId) return;
  try {
    const res = await fetch(`https://api.spotify.com/v1/audio-features/${trackId}`, {
      headers: { Authorization: `Bearer ${state.tokens.accessToken}` }
    });
    if (!res.ok) return;
    const data = await res.json();
    if (data.tempo) {
      state.bpm = Math.round(data.tempo);
      console.log("[BPM]", state.bpm, "bpm");
      updateScrollUI();
      updateKeyBadge(); // badge also shows BPM
    }
  } catch(e) { console.log("[BPM] error:", e.message); }
}

// ── 2. Key detection ──────────────────────────────────────────
// Krumhansl-Schmuckler simplified: count chord root occurrences,
// match against major/minor key profiles.
const KEY_NAMES_ES = {
  "C":"Do", "C#":"Do#", "Db":"Reb", "D":"Re", "D#":"Re#", "Eb":"Mib",
  "E":"Mi", "F":"Fa", "F#":"Fa#", "Gb":"Solb", "G":"Sol", "G#":"Sol#",
  "Ab":"Lab", "A":"La", "A#":"La#", "Bb":"Sib", "B":"Si"
};
const CHROMA_IDX = { C:0, "C#":1, Db:1, D:2, "D#":3, Eb:3, E:4, F:5,
                     "F#":6, Gb:6, G:7, "G#":8, Ab:8, A:9, "A#":10, Bb:10, B:11 };

// Profiles: degrees present in major and natural minor keys
const MAJOR_SCALE = [0,2,4,5,7,9,11];
const MINOR_SCALE = [0,2,3,5,7,8,10];

function detectKeyFromSheet(text) {
  if (!text) return null;
  const chordRe = /\b([A-G][#b]?)(?:m(?:aj)?|min|dim|aug|sus|add|\d)*/g;
  const roots = {};
  let m;
  while ((m = chordRe.exec(text)) !== null) {
    const r = m[1];
    roots[r] = (roots[r] || 0) + 1;
  }

  let bestKey = null, bestScore = -1, bestMinor = false;

  // Sharp-only root names for all 12 pitches
  const ROOT_NAMES = ["C","C#","D","D#","E","F","F#","G","G#","A","A#","B"];
  for (let root = 0; root < 12; root++) {
    const rootName = ROOT_NAMES[root];

    for (const [scale, minor] of [[MAJOR_SCALE, false], [MINOR_SCALE, true]]) {
      const scalePcs = new Set(scale.map(d => (root + d) % 12));
      let score = 0;
      for (const [r, cnt] of Object.entries(roots)) {
        const pc = CHROMA_IDX[r];
        if (pc !== undefined && scalePcs.has(pc)) score += cnt;
      }
      if (score > bestScore) {
        bestScore = score; bestKey = rootName; bestMinor = minor;
      }
    }
  }

  if (!bestKey) return null;
  const esName = KEY_NAMES_ES[bestKey] || bestKey;
  return { root: bestKey, minor: bestMinor, label: `${esName} ${bestMinor ? "menor" : "mayor"}` };
}

function updateKeyBadge() {
  const badge = document.getElementById("key-badge-inline");
  const shareBtn = document.getElementById("share-btn");
  if (!badge) return;

  const parts = [];
  if (state.detectedKey) parts.push(state.detectedKey.label);
  if (state.bpm) parts.push(`${state.bpm} BPM`);
  if (state.syncedLyrics && state.syncedLyrics.length > 0) parts.push("LRC");

  if (parts.length) {
    badge.textContent = parts.join(" · ");
    badge.style.display = "inline-block";
  } else {
    badge.style.display = "none";
  }

  if (shareBtn) shareBtn.style.display = state.chordsData ? "flex" : "none";
}

// ── 3. Font size ──────────────────────────────────────────────
function loadUserPrefs() {
  try {
    const fs = localStorage.getItem(STORAGE_KEYS.fontSize);
    if (fs) {
      state.chordFontSize = parseInt(fs, 10) || 13;
    }
    const instr = localStorage.getItem(STORAGE_KEYS.instrument);
    if (instr === "piano" || instr === "guitar") state.instrument = instr;
  } catch(_) {}
  applyFontSize();
  applyInstrumentUI();
}

function applyFontSize() {
  document.documentElement.style.setProperty("--chord-font-size", state.chordFontSize + "px");
  const label = document.getElementById("font-size-label");
  if (label) label.textContent = state.chordFontSize + "px";
}

function changeFontSize(delta) {
  state.chordFontSize = Math.max(10, Math.min(24, state.chordFontSize + delta));
  applyFontSize();
  try { localStorage.setItem(STORAGE_KEYS.fontSize, state.chordFontSize); } catch(_) {}
}

function setInstrument(instr) {
  state.instrument = instr;
  applyInstrumentUI();
  try { localStorage.setItem(STORAGE_KEYS.instrument, instr); } catch(_) {}
}

function applyInstrumentUI() {
  const g = document.getElementById("instr-guitar");
  const p = document.getElementById("instr-piano");
  if (g) g.classList.toggle("active", state.instrument === "guitar");
  if (p) p.classList.toggle("active", state.instrument === "piano");
}

// ── 4. Active section highlight ───────────────────────────────
function highlightActiveSection() {
  if (!state.currentTrack || !state.currentTrack.durationMs) return;
  const progressMs = computeProgressMs();
  const ratio = progressMs / state.currentTrack.durationMs;

  const sections = document.querySelectorAll(".cs-section");
  if (!sections.length) return;

  const scrollable = document.documentElement.scrollHeight - window.innerHeight;
  const targetY = scrollable * ratio;

  let active = null;
  for (const sec of sections) {
    const secY = sec.getBoundingClientRect().top + window.scrollY;
    if (secY <= targetY + window.innerHeight * 0.55) active = sec;
  }

  sections.forEach(s => s.classList.remove("cs-active"));
  if (active) active.classList.add("cs-active");
}

// ── Active line highlight — colors the line currently being played ──
// ── Active line highlight — based on song TIME, not scroll position ──
function highlightActiveLine() {
  if (!state.currentTrack || !state.currentTrack.isPlaying || !state.currentTrack.durationMs) {
    // Clear highlight when not playing
    document.querySelectorAll(".cs-line-active").forEach(l => l.classList.remove("cs-line-active"));
    return;
  }

  const lines = document.querySelectorAll(".cs-row, .cs-lyric");
  if (!lines.length) return;

  const progressMs = computeProgressMs();
  let targetIdx = -1;

  if (state.syncedLyrics && state.syncedLyrics.length > 0) {
    // ── LRC mode: match playback time to lyric timestamp ──
    let lrcIdx = 0;
    for (let i = state.syncedLyrics.length - 1; i >= 0; i--) {
      if (state.syncedLyrics[i].timeMs <= progressMs) { lrcIdx = i; break; }
    }
    // Map LRC index → DOM line index proportionally
    const ratio = lrcIdx / Math.max(state.syncedLyrics.length - 1, 1);
    targetIdx = Math.round(ratio * (lines.length - 1));
  } else {
    // ── No LRC: use song progress ratio ──
    const ratio = progressMs / state.currentTrack.durationMs;
    targetIdx = Math.round(ratio * (lines.length - 1));
  }

  targetIdx = Math.max(0, Math.min(targetIdx, lines.length - 1));
  const target = lines[targetIdx];

  if (target && !target.classList.contains("cs-line-active")) {
    lines.forEach(l => l.classList.remove("cs-line-active"));
    target.classList.add("cs-line-active");
  }
}

// ── 5. Chord tap → diagram modal ─────────────────────────────
function attachChordTapHandlers() {
  // Use event delegation on #chords-sections (persistent element) instead
  // of adding a new listener on .chord-sheet (recreated each render).
  const container = document.getElementById("chords-sections");
  if (!container || container._chordTapBound) return;
  container._chordTapBound = true;
  container.addEventListener("click", (e) => {
    const chord = e.target.closest(".cs-chord");
    if (!chord) return;
    const name = chord.textContent.trim();
    if (name) openDiagram(name);
  });
}

function openDiagram(chordName) {
  // Apply current transposition to find the actual chord shown
  const modal   = document.getElementById("diagram-modal");
  const overlay = document.getElementById("diagram-overlay");
  const nameEl  = document.getElementById("diagram-chord-name");
  if (!modal) return;

  nameEl.textContent = chordName;
  renderDiagram(chordName, 0); // start at voicing 0

  modal.classList.add("open");
  overlay.classList.add("open");
}

function closeDiagram() {
  document.getElementById("diagram-modal")?.classList.remove("open");
  document.getElementById("diagram-overlay")?.classList.remove("open");
}

function renderDiagram(chordName, voicingIdx) {
  const content = document.getElementById("diagram-content");
  const tabs    = document.getElementById("diagram-tabs");
  const hint    = document.getElementById("diagram-key-hint");
  if (!content) return;

  if (state.instrument === "piano") {
    const inversions = getPianoInversions(chordName);
    const idx = Math.max(0, Math.min(voicingIdx || 0, inversions.length - 1));
    const inv = inversions[idx];
    content.innerHTML = renderPianoDiagram(inv.notes, inv.bassNote);
    if (tabs) {
      tabs.innerHTML = inversions.length > 1
        ? inversions.map((v,i) => `<button class="diagram-tab${i===idx?" active":""}" onclick="renderDiagram('${chordName}',${i})">${v.label}</button>`).join("")
        : "";
    }
    if (hint) hint.textContent = inv.notes.join(" – ");
    return;
  }

  // Guitar
  const voicings = getGuitarVoicings(chordName);
  if (!voicings.length) {
    content.innerHTML = `<p style="color:var(--text-3);font-size:13px;padding:20px">Sin diagrama para "${chordName}"</p>`;
    if (tabs) tabs.innerHTML = "";
    if (hint) hint.textContent = "";
    return;
  }

  const idx = Math.max(0, Math.min(voicingIdx, voicings.length - 1));
  content.innerHTML = renderGuitarDiagram(voicings[idx]);

  // Voicing tabs if multiple
  if (tabs) {
    tabs.innerHTML = voicings.length > 1
      ? voicings.map((_, i) => `<button class="diagram-tab${i===idx?" active":""}" onclick="renderDiagram('${chordName}',${i})">${i+1}</button>`).join("")
      : "";
  }

  if (hint) hint.textContent = voicings[idx].notes ? voicings[idx].notes.join(" – ") : "";
}

// Guitar diagram SVG renderer
// voicing = { frets:[e,B,G,D,A,E], baseFret, fingers }
// frets: -1=muted, 0=open, 1-5=finger position
function renderGuitarDiagram(v) {
  const SX = 34, SY = 36, COLS = 6, ROWS = 5;
  const W = SX * (COLS - 1), H = SY * ROWS;
  const ox = 20, oy = 40;
  const frets = v.frets;   // [e, B, G, D, A, E(low)]
  const base  = v.baseFret || 1;
  const fingers = v.fingers || [];

  let svg = `<svg width="${W + ox*2}" height="${H + oy + 24}" viewBox="0 0 ${W + ox*2} ${H + oy + 24}">`;

  // Nut (thick bar if base === 1)
  const nutY = oy;
  if (base === 1) {
    svg += `<rect x="${ox}" y="${nutY - 4}" width="${W}" height="6" rx="2" fill="rgba(255,255,255,.8)"/>`;
  } else {
    // Base fret label
    svg += `<text x="${ox - 6}" y="${nutY + SY/2}" font-size="10" fill="rgba(255,255,255,.4)" text-anchor="end" font-family="sans-serif">${base}</text>`;
    svg += `<line x1="${ox}" y1="${nutY}" x2="${ox+W}" y2="${nutY}" stroke="rgba(255,255,255,.25)" stroke-width="1.5"/>`;
  }

  // Fret lines
  for (let r = 1; r <= ROWS; r++) {
    const y = oy + r * SY;
    svg += `<line x1="${ox}" y1="${y}" x2="${ox+W}" y2="${y}" stroke="rgba(255,255,255,.15)" stroke-width="1"/>`;
  }

  // String lines
  for (let c = 0; c < COLS; c++) {
    const x = ox + c * SX;
    svg += `<line x1="${x}" y1="${oy}" x2="${x}" y2="${oy + ROWS*SY}" stroke="rgba(255,255,255,.3)" stroke-width="1"/>`;
  }

  // Dots and mute markers
  for (let c = 0; c < COLS; c++) {
    const strIdx = (COLS - 1) - c; // e=col5, E=col0
    const fret = frets[strIdx];
    const x = ox + c * SX;

    if (fret === -1) {
      // Muted string X
      svg += `<text x="${x}" y="${oy - 8}" font-size="12" fill="rgba(255,100,100,.7)" text-anchor="middle" font-family="sans-serif">✕</text>`;
    } else if (fret === 0) {
      // Open string circle
      svg += `<circle cx="${x}" cy="${oy - 8}" r="5" fill="none" stroke="rgba(255,255,255,.5)" stroke-width="1.5"/>`;
    } else {
      // Fret dot
      const relFret = fret - base + 1;
      const dotY = oy + (relFret - 0.5) * SY;
      svg += `<circle cx="${x}" cy="${dotY}" r="12" fill="var(--chord-color)" opacity="0.9"/>`;
      // Finger number
      const finger = fingers[strIdx];
      if (finger) {
        svg += `<text x="${x}" y="${dotY + 4}" font-size="11" font-weight="700" fill="rgba(0,0,0,.8)" text-anchor="middle" font-family="sans-serif">${finger}</text>`;
      }
    }
  }

  // String name labels at bottom
  const strNames = ["E","A","D","G","B","e"];
  for (let c = 0; c < COLS; c++) {
    const lbl = strNames[c];
    const x   = ox + c * SX;
    svg += `<text x="${x}" y="${oy + ROWS*SY + 16}" font-size="9" fill="rgba(255,255,255,.3)" text-anchor="middle" font-family="sans-serif">${lbl}</text>`;
  }

  svg += "</svg>";
  return svg;
}

// Get chord color from CSS — if white, fall back to green for visibility
function getChordColorForDiagram() {
  const raw = getComputedStyle(document.documentElement)
    .getPropertyValue("--chord-color").trim();
  // White or near-white → use green
  if (!raw || raw === "#ffffff" || raw === "white" || raw === "rgb(255,255,255)") {
    return "#30d158";
  }
  return raw;
}

// Build all inversions of a chord: root, 1st, 2nd (, 3rd for 7ths)
function getPianoInversions(chordName) {
  const notes = getChordNotes(chordName);
  if (!notes.length) return [{ label:"Root", notes, bassNote: notes[0] }];
  const labels = ["Root", "1ª inv", "2ª inv", "3ª inv"];
  return notes.map((_, i) => {
    const rotated = [...notes.slice(i), ...notes.slice(0, i)];
    return { label: labels[i] || `${i}ª`, notes: rotated, bassNote: rotated[0] };
  });
}

// Piano SVG: 2 octaves (C to C, 15 white keys), highlights notes with octave awareness
function renderPianoDiagram(notes, bassNote) {
  const chordColor = getChordColorForDiagram();
  const ALL     = ["C","C#","D","D#","E","F","F#","G","G#","A","A#","B"];
  const WHITE   = ["C","D","E","F","G","A","B"];
  // Black key positions within an octave (0-indexed among white keys)
  const BLACK_AFTER = { "C#": 0, "D#": 1, "F#": 3, "G#": 4, "A#": 5 };

  const WW = 26, WH = 88, BW = 16, BH = 54;
  // 2 full octaves = 14 white keys + 1 closing C = 15 white keys
  const TOTAL_WHITES = 15;
  const svgW = TOTAL_WHITES * WW + 4;
  const svgH = WH + 24;

  // Assign octave to each note intelligently:
  // Bass note → octave 4 (lower), rest → octave 4 or 5 going upward
  function assignOctaves(notes) {
    if (!notes.length) return [];
    const result = [];
    let currentOct = 4;
    let prevIdx = -1;
    for (const n of notes) {
      const idx = ALL.indexOf(n);
      if (idx === -1) { result.push({ n, oct: currentOct }); continue; }
      if (prevIdx !== -1 && idx <= prevIdx) currentOct++; // wrap up
      result.push({ n, oct: currentOct });
      prevIdx = idx;
    }
    return result;
  }

  // Map a note+octave to white-key x position
  function noteToX(n, oct) {
    const octOffset = (oct - 4) * 7; // 7 whites per octave
    const wIdx = WHITE.indexOf(n);
    if (wIdx !== -1) return (octOffset + wIdx) * WW + 2;
    // Black key: find parent white
    const blackParents = { "C#":"C","D#":"D","F#":"F","G#":"G","A#":"A" };
    const parent = blackParents[n];
    const pIdx = WHITE.indexOf(parent);
    return (octOffset + pIdx) * WW + 2 + WW - BW / 2;
  }

  const octaved = assignOctaves(notes);
  const litSet  = new Set(octaved.map(({n, oct}) => `${n}${oct}`));
  const bassKey = octaved.length > 0 ? `${octaved[0].n}${octaved[0].oct}` : null;

  let whites = "", blacks = "", wLabels = "", bLabels = "";

  // Draw all white keys for 2 octaves + closing C
  for (let oct = 4; oct <= 5; oct++) {
    for (let wi = 0; wi < WHITE.length; wi++) {
      if (oct === 6) break;
      const n    = WHITE[wi];
      const key  = `${n}${oct}`;
      const isLit  = litSet.has(key);
      const isBass = key === bassKey;
      const x = ((oct - 4) * 7 + wi) * WW + 2;
      const fill = isLit ? chordColor : "rgba(255,255,255,.93)";
      whites += `<rect x="${x}" y="2" width="${WW-2}" height="${WH}" rx="3"
        fill="${fill}" stroke="rgba(0,0,0,.25)" stroke-width="1"/>`;
      if (isLit) {
        const labelFill = isBass ? "rgba(0,0,0,.9)" : "rgba(0,0,0,.65)";
        const fw = isBass ? "900" : "700";
        wLabels += `<text x="${x + WW/2 - 1}" y="${2 + WH - 9}" font-size="9" font-weight="${fw}"
          fill="${labelFill}" text-anchor="middle" font-family="sans-serif">${n}${isBass ? "*" : ""}</text>`;
      }
    }
  }
  // Closing C5
  const cX = 14 * WW + 2;
  const cKey = "C6";
  const cLit = litSet.has(cKey);
  whites += `<rect x="${cX}" y="2" width="${WW-2}" height="${WH}" rx="3"
    fill="${cLit ? chordColor : "rgba(255,255,255,.93)"}" stroke="rgba(0,0,0,.25)" stroke-width="1"/>`;
  if (cLit) wLabels += `<text x="${cX + WW/2 - 1}" y="${2 + WH - 9}" font-size="9" font-weight="700"
    fill="rgba(0,0,0,.65)" text-anchor="middle" font-family="sans-serif">C</text>`;

  // Draw black keys
  for (let oct = 4; oct <= 5; oct++) {
    const octOffset = (oct - 4) * 7;
    for (const [bn, pos] of Object.entries(BLACK_AFTER)) {
      const key   = `${bn}${oct}`;
      const isLit  = litSet.has(key);
      const isBass = key === bassKey;
      const bx = (octOffset + pos) * WW + 2 + WW - BW / 2;
      // Active black keys: dark fill + colored border (not full color fill)
      const fill   = isLit ? "rgba(40,40,48,.95)" : "rgba(22,22,26,.97)";
      const stroke = isLit ? chordColor : "rgba(255,255,255,.08)";
      const sw     = isLit ? "2.5" : "1";
      blacks += `<rect x="${bx}" y="2" width="${BW}" height="${BH}" rx="3"
        fill="${fill}" stroke="${stroke}" stroke-width="${sw}"/>`;
      if (isLit) {
        const labelFill = isBass ? chordColor : chordColor;
        const fw = isBass ? "900" : "700";
        bLabels += `<text x="${bx + BW/2}" y="${2 + BH - 7}" font-size="8" font-weight="${fw}"
          fill="${labelFill}" text-anchor="middle" font-family="sans-serif">${bn.replace("#","#")}${isBass ? "*" : ""}</text>`;
      }
    }
  }

  // Octave labels at bottom
  let octLabels = "";
  for (let oct = 4; oct <= 5; oct++) {
    const x = ((oct - 4) * 7) * WW + 2 + WW * 3;
    octLabels += `<text x="${x}" y="${svgH - 4}" font-size="8" fill="rgba(255,255,255,.2)"
      text-anchor="middle" font-family="sans-serif">oct ${oct}</text>`;
  }

  return `<svg width="${svgW}" height="${svgH}" viewBox="0 0 ${svgW} ${svgH}" style="max-width:100%">${whites}${blacks}${wLabels}${bLabels}${octLabels}</svg>`;
}

// ── Chord Database ────────────────────────────────────────────
// Format: { frets:[E,A,D,G,B,e], baseFret, fingers:[E,A,D,G,B,e], notes[] }
const GUITAR_CHORDS = {
  "C":   [{ frets:[-1,3,2,0,1,0], baseFret:1, fingers:[0,3,2,0,1,0], notes:["C","E","G"] }],
  "Cm":  [{ frets:[-1,3,5,5,4,3], baseFret:1, fingers:[0,1,3,4,2,1], notes:["C","Eb","G"] }],
  "C#":  [{ frets:[-1,4,6,6,6,4], baseFret:1, fingers:[0,1,3,4,4,1], notes:["C#","F","Ab"] }],
  "Db":  [{ frets:[-1,4,6,6,6,4], baseFret:1, fingers:[0,1,3,4,4,1], notes:["Db","F","Ab"] }],
  "D":   [{ frets:[-1,-1,0,2,3,2], baseFret:1, fingers:[0,0,0,1,3,2], notes:["D","F#","A"] }],
  "Dm":  [{ frets:[-1,-1,0,2,3,1], baseFret:1, fingers:[0,0,0,2,3,1], notes:["D","F","A"] }],
  "D#":  [{ frets:[-1,-1,1,3,4,3], baseFret:1, fingers:[0,0,1,3,4,2], notes:["D#","G","A#"] }],
  "Eb":  [{ frets:[-1,-1,1,3,4,3], baseFret:1, fingers:[0,0,1,3,4,2], notes:["Eb","G","Bb"] }],
  "E":   [{ frets:[0,2,2,1,0,0],  baseFret:1, fingers:[0,2,3,1,0,0], notes:["E","B","E","G#","B","E"] }],
  "Em":  [{ frets:[0,2,2,0,0,0],  baseFret:1, fingers:[0,2,3,0,0,0], notes:["E","B","E","G","B","E"] }],
  "F":   [{ frets:[1,3,3,2,1,1],  baseFret:1, fingers:[1,4,3,2,1,1], notes:["F","C","F","A","C","F"] }],
  "Fm":  [{ frets:[1,3,3,1,1,1],  baseFret:1, fingers:[1,3,4,1,1,1], notes:["F","C","F","Ab","C","F"] }],
  "F#":  [{ frets:[2,4,4,3,2,2],  baseFret:1, fingers:[1,4,3,2,1,1], notes:["F#","C#","F#","A#","C#","F#"] }],
  "Gb":  [{ frets:[2,4,4,3,2,2],  baseFret:1, fingers:[1,4,3,2,1,1], notes:["Gb","Db","Gb","Bb","Db","Gb"] }],
  "G":   [{ frets:[3,2,0,0,0,3],  baseFret:1, fingers:[2,1,0,0,0,3], notes:["G","B","D"] },
           { frets:[3,2,0,0,3,3], baseFret:1, fingers:[2,1,0,0,3,4], notes:["G","B","D"] }],
  "Gm":  [{ frets:[3,5,5,3,3,3],  baseFret:1, fingers:[1,3,4,1,1,1], notes:["G","D","G","Bb","D","G"] }],
  "G#":  [{ frets:[4,6,6,5,4,4],  baseFret:1, fingers:[1,3,4,2,1,1], notes:["G#","Eb","Ab"] }],
  "Ab":  [{ frets:[4,6,6,5,4,4],  baseFret:1, fingers:[1,3,4,2,1,1], notes:["Ab","Eb","Ab"] }],
  "A":   [{ frets:[-1,0,2,2,2,0], baseFret:1, fingers:[0,0,2,3,4,0], notes:["A","E","A","C#","E"] }],
  "Am":  [{ frets:[-1,0,2,2,1,0], baseFret:1, fingers:[0,0,2,3,1,0], notes:["A","E","A","C","E"] }],
  "A#":  [{ frets:[-1,1,3,3,3,1], baseFret:1, fingers:[0,1,3,4,4,1], notes:["A#","F","A#","D","F"] }],
  "Bb":  [{ frets:[-1,1,3,3,3,1], baseFret:1, fingers:[0,1,3,4,4,1], notes:["Bb","F","Bb","D","F"] }],
  "B":   [{ frets:[-1,2,4,4,4,2], baseFret:1, fingers:[0,1,3,4,4,1], notes:["B","F#","B","D#","F#"] }],
  "Bm":  [{ frets:[-1,2,4,4,3,2], baseFret:1, fingers:[0,1,3,4,2,1], notes:["B","F#","B","D","F#"] }],
  // 7ths
  "G7":  [{ frets:[3,2,0,0,0,1],  baseFret:1, fingers:[3,2,0,0,0,1], notes:["G","B","D","F"] }],
  "C7":  [{ frets:[-1,3,2,3,1,0], baseFret:1, fingers:[0,3,2,4,1,0], notes:["C","E","G","Bb"] }],
  "D7":  [{ frets:[-1,-1,0,2,1,2], baseFret:1, fingers:[0,0,0,3,1,2], notes:["D","F#","A","C"] }],
  "E7":  [{ frets:[0,2,0,1,0,0],  baseFret:1, fingers:[0,2,0,1,0,0], notes:["E","B","E","G#","D","E"] }],
  "A7":  [{ frets:[-1,0,2,0,2,0], baseFret:1, fingers:[0,0,2,0,3,0], notes:["A","E","A","C#","G"] }],
  "B7":  [{ frets:[-1,2,1,2,0,2], baseFret:1, fingers:[0,2,1,3,0,4], notes:["B","F#","B","D#","A"] }],
  "F7":  [{ frets:[1,3,1,2,1,1],  baseFret:1, fingers:[1,4,1,2,1,1], notes:["F","C","Eb","A"] }],
  "Am7": [{ frets:[-1,0,2,0,1,0], baseFret:1, fingers:[0,0,2,0,1,0], notes:["A","E","G","C","E"] }],
  "Em7": [{ frets:[0,2,2,0,3,0],  baseFret:1, fingers:[0,2,3,0,4,0], notes:["E","B","E","G","D"] }],
  "Dm7": [{ frets:[-1,-1,0,2,1,1], baseFret:1, fingers:[0,0,0,2,1,1], notes:["D","A","C","F"] }],
  "Cmaj7":[{ frets:[-1,3,2,0,0,0], baseFret:1, fingers:[0,3,2,0,0,0], notes:["C","E","G","B"] }],
  "Fmaj7":[{ frets:[-1,-1,3,2,1,0], baseFret:1, fingers:[0,0,3,2,1,0], notes:["F","A","C","E"] }],
  "Gmaj7":[{ frets:[3,2,0,0,0,2],  baseFret:1, fingers:[3,2,0,0,0,1], notes:["G","B","D","F#"] }],
  "Amaj7":[{ frets:[-1,0,2,1,2,0], baseFret:1, fingers:[0,0,2,1,3,0], notes:["A","E","A","C#","G#"] }],
  "Bm7": [{ frets:[-1,2,4,2,3,2], baseFret:1, fingers:[0,1,3,1,2,1], notes:["B","F#","A","D","F#"] }],
  "Dsus2":[{ frets:[-1,-1,0,2,3,0], baseFret:1, fingers:[0,0,0,1,3,0], notes:["D","A","E"] }],
  "Dsus4":[{ frets:[-1,-1,0,2,3,3], baseFret:1, fingers:[0,0,0,1,3,4], notes:["D","A","G"] }],
  "Asus2":[{ frets:[-1,0,2,2,0,0], baseFret:1, fingers:[0,0,2,3,0,0], notes:["A","E","B"] }],
  "Asus4":[{ frets:[-1,0,2,2,0,0], baseFret:1, fingers:[0,0,2,3,0,0], notes:["A","E","D"] }],
};

function getGuitarVoicings(chordName) {
  // Try exact match first, then normalize
  if (GUITAR_CHORDS[chordName]) return GUITAR_CHORDS[chordName];

  // Normalize Latin-American suffixes: 7M→maj7, Δ→maj7, +→aug, etc.
  const SUFFIX_ALIASES = { "7M":"maj7", "7Ma":"maj7", "7maj":"maj7", "Δ":"maj7", "△":"maj7", "+":"aug", "7+":"aug7" };
  const root = chordName.match(/^[A-G][#b]?/)?.[0] || "";
  let suffix = chordName.slice(root.length);
  suffix = SUFFIX_ALIASES[suffix] || suffix;
  const normalized = root + suffix;
  if (GUITAR_CHORDS[normalized]) return GUITAR_CHORDS[normalized];

  // Try without bass note (e.g. "G/B" → "G")
  const noSlash = normalized.replace(/\/.*$/, "");
  if (GUITAR_CHORDS[noSlash]) return GUITAR_CHORDS[noSlash];
  // Normalize enharmonics
  const enharmonics = { "Db":"C#","Eb":"D#","Gb":"F#","Ab":"G#","Bb":"A#" };
  const rev = Object.fromEntries(Object.entries(enharmonics).map(([a,b])=>[b,a]));
  const rootClean = noSlash.match(/^[A-G][#b]?/)?.[0] || "";
  const suffixClean = noSlash.slice(rootClean.length);
  const altRoot = enharmonics[rootClean] || rev[rootClean] || "";
  if (altRoot && GUITAR_CHORDS[altRoot + suffixClean]) return GUITAR_CHORDS[altRoot + suffixClean];
  return [];
}

function getChordNotes(chordName) {
  const voicings = getGuitarVoicings(chordName);
  if (voicings.length) return voicings[0].notes || [];
  // Fallback: compute intervals from chord name
  const root = chordName.match(/^[A-G][#b]?/)?.[0] || "C";
  let suffix = chordName.slice(root.length);
  // Normalize Latin-American suffixes
  const SUFFIX_ALIASES = { "7M":"maj7", "7Ma":"maj7", "7maj":"maj7", "Δ":"maj7", "△":"maj7", "+":"aug", "7+":"aug7" };
  suffix = SUFFIX_ALIASES[suffix] || suffix;
  // Resolve flat roots to sharp equivalent for CHROMA_IDX lookup
  const FLAT_TO_SHARP = { Cb:"B", Db:"C#", Eb:"D#", Fb:"E", Gb:"F#", Ab:"G#", Bb:"A#" };
  const resolvedRoot = FLAT_TO_SHARP[root] || root;
  const ri = CHROMA_IDX[resolvedRoot] ?? 0;
  const ALL = ["C","C#","D","D#","E","F","F#","G","G#","A","A#","B"];
  const isMinor = suffix.startsWith("m") && !suffix.startsWith("maj");
  const isAug = suffix.includes("aug") || suffix === "+";
  const isDim = suffix.includes("dim");
  let intervals = [0, isMinor ? 3 : 4, isDim ? 6 : (isAug ? 8 : 7)];
  if (suffix.includes("maj7"))                     intervals.push(11);
  else if (suffix.includes("7") || suffix.includes("dom")) intervals.push(10);
  if (suffix.includes("9"))  intervals.push(14);
  if (suffix.includes("add9")) intervals.push(14);
  return intervals.map(i => ALL[(ri + i) % 12]);
}

// ── 6. QR / Share ─────────────────────────────────────────────
function buildShareUrl() {
  const track = state.currentTrack;
  if (!track) return null;
  const key = `${track.artists[0] || ""}||${track.name}`;
  const url = new URL(window.location.href);
  url.search = "";
  url.searchParams.set("view", encodeURIComponent(key));
  return url.toString();
}

function showQR() {
  const url = buildShareUrl();
  if (!url) return;

  const modal   = document.getElementById("qr-modal");
  const overlay = document.getElementById("qr-overlay");
  const canvas  = document.getElementById("qr-canvas");
  const lbl     = document.getElementById("qr-song-label");

  canvas.innerHTML = "";
  try {
    if (typeof QRCode === "undefined") throw new Error("QRCode library not loaded");
    new QRCode(canvas, { text: url, width: 200, height: 200, colorDark:"#000", colorLight:"#fff", correctLevel: QRCode.CorrectLevel.M });
  } catch(e) {
    // Fallback: show the raw URL so user can copy it manually
    canvas.innerHTML = `<div style="padding:12px;font-size:11px;word-break:break-all;color:#333;max-width:200px">${url}</div>`;
  }
  if (lbl && state.currentTrack) lbl.textContent = `${state.currentTrack.name} — ${state.currentTrack.artists[0]}`;

  modal.classList.add("open");
  overlay.classList.add("open");
}

function closeQR() {
  document.getElementById("qr-modal")?.classList.remove("open");
  document.getElementById("qr-overlay")?.classList.remove("open");
}

async function copyShareUrl() {
  const url = buildShareUrl();
  if (!url) return;
  try {
    await navigator.clipboard.writeText(url);
    const btn = document.querySelector("#qr-modal .button-secondary");
    if (btn) { btn.textContent = "¡Copiado!"; setTimeout(() => btn.textContent = "Copiar enlace", 2000); }
  } catch(_) {}
}

// Share mode: load chords from URL ?view=artist||song without Spotify
async function checkShareMode() {
  const params = new URLSearchParams(window.location.search);
  const viewParam = params.get("view");
  if (!viewParam) return;

  const decoded = decodeURIComponent(viewParam);
  const [artist, ...titleParts] = decoded.split("||");
  const title = titleParts.join("||");
  if (!artist || !title) return;

  state.shareMode = true;
  state.currentTrack = { id: null, name: title, artists: [artist], album: "", image: "", durationMs: 0, progressMs: 0, isPlaying: false, spotifyUrl: "" };
  state.lastTrackKey = buildTrackLookupKey(state.currentTrack);

  // Show a share banner
  const kicker = document.getElementById("track-kicker");
  if (kicker) kicker.textContent = "👥 Modo vista compartida";
  const titleEl = document.getElementById("track-title");
  const artistEl = document.getElementById("track-artist");
  if (titleEl) titleEl.textContent = title;
  if (artistEl) artistEl.textContent = artist;

  setPlaybackStatus("warn", "Vista compartida");
  showScrollControls(true);

  resetChords("warn", "Cargando…");
  renderAll();

  await fetchChordsForTrack(state.currentTrack, state.lastTrackKey);
  renderAll();
}


// ═══════════════════════════════════════════════════════════════
//  LIVE SESSION — room-based sharing via Cloudflare Worker
// ═══════════════════════════════════════════════════════════════

function generateRoomCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no confusable chars
  return Array.from(crypto.getRandomValues(new Uint8Array(6)))
    .map(b => chars[b % chars.length]).join("");
}

function getRoomUrl(code) {
  const base = state.settings.workerUrl;
  return `${base}/?room=${encodeURIComponent(code)}`;
}

// Host: POST current track to room
async function broadcastRoom(track) {
  if (!state.room.code || !state.settings.workerUrl) return;
  const payload = {
    id:         track.id,
    name:       track.name,
    artists:    track.artists,
    album:      track.album,
    image:      track.image,
    durationMs: track.durationMs,
    progressMs: track.progressMs,
    isPlaying:  track.isPlaying,
    spotifyUrl: track.spotifyUrl,
    sentAt:     Date.now(),
  };
  try {
    await fetch(getRoomUrl(state.room.code), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch(_) {}
}

// Guest: start polling room
function startRoomGuestPolling(code) {
  stopRoomPolling();
  state.room.code    = code;
  state.room.isHost  = false;
  state.room.pollTimer = window.setInterval(() => pollRoomAsGuest(), 2000);
  pollRoomAsGuest(); // immediate first poll
}

function stopRoomPolling() {
  if (state.room.pollTimer) { window.clearInterval(state.room.pollTimer); state.room.pollTimer = null; }
}

async function pollRoomAsGuest() {
  if (!state.room.code || !state.settings.workerUrl) return;
  try {
    const res  = await fetch(getRoomUrl(state.room.code));
    if (!res.ok) return;
    const data = await res.json();
    if (!data || !data.name) return;

    // Adjust progressMs for network latency
    if (data.isPlaying && data.sentAt) {
      const lag = Date.now() - data.sentAt;
      data.progressMs = Math.min((data.progressMs || 0) + lag, data.durationMs || 0);
    }

    const nextKey = buildTrackLookupKey(data);
    if (nextKey === state.lastTrackKey) {
      // Same song — just update progress
      if (state.currentTrack) {
        state.currentTrack.progressMs = data.progressMs;
        state.currentTrack.isPlaying  = data.isPlaying;
        state.lastSyncAt = Date.now();
      }
      return;
    }

    // New song!
    state.currentTrack = data;
    state.lastSyncAt   = Date.now();
    setPlaybackStatus(data.isPlaying ? "live" : "warn",
      data.isPlaying ? "En vivo 👥" : "En pausa 👥");
    renderAll();
    state.lastTrackKey = nextKey;
    await loadTrackResources(data, nextKey);
  } catch(_) {}
}

// UI helpers
function startRoom() {
  const code = generateRoomCode();
  state.room.code   = code;
  state.room.isHost = true;
  stopRoomPolling(); // host doesn't poll
  updateRoomUI();
  showRoomModal();
}

function joinRoom() {
  const input = document.getElementById("room-code-input");
  const code  = (input?.value || "").trim().toUpperCase();
  if (code.length < 4) { alert("Escribe el código de sala"); return; }
  state.shareMode = true;
  state.room.code = code;
  state.room.isHost = false;
  updateRoomUI();
  startRoomGuestPolling(code);
  closeQR();
}

function leaveRoom() {
  stopRoomPolling();
  state.room = { code: null, isHost: false, pollTimer: null };
  state.shareMode = false;
  updateRoomUI();
}

function updateRoomUI() {
  const badge = document.getElementById("room-badge");
  const leaveBtn = document.getElementById("room-leave-btn");
  if (badge) {
    if (state.room.code) {
      badge.textContent = state.room.isHost ? `🎸 Sala: ${state.room.code}` : `👥 Sala: ${state.room.code}`;
      badge.style.display = "inline-block";
    } else {
      badge.style.display = "none";
    }
  }
  if (leaveBtn) leaveBtn.style.display = state.room.code ? "block" : "none";
}

function showRoomModal() {
  // Switch to "live" tab in the QR modal and show room code + QR
  const modal   = document.getElementById("qr-modal");
  const overlay = document.getElementById("qr-overlay");
  if (!modal) return;

  // Build live room QR
  const guestUrl = new URL(window.location.href);
  guestUrl.search = "";
  guestUrl.searchParams.set("room", state.room.code);
  const url = guestUrl.toString();

  const canvas = document.getElementById("qr-canvas");
  const lbl    = document.getElementById("qr-song-label");
  canvas.innerHTML = "";
  try {
    if (typeof QRCode === "undefined") throw new Error();
    new QRCode(canvas, { text: url, width: 200, height: 200, colorDark:"#000", colorLight:"#fff", correctLevel: QRCode.CorrectLevel.M });
  } catch(_) {
    canvas.innerHTML = `<div style="padding:12px;font-size:11px;word-break:break-all;color:#333">${url}</div>`;
  }
  if (lbl) lbl.textContent = `Código: ${state.room.code}`;

  // Update modal title
  const title = modal.querySelector(".settings-header span");
  if (title) title.textContent = "Sala en vivo";

  modal.classList.add("open");
  overlay.classList.add("open");
}

// Check if opening as a room guest (?room=CODE in URL)
async function checkRoomGuestMode() {
  const params = new URLSearchParams(window.location.search);
  const roomCode = params.get("room");
  if (!roomCode) return false;

  state.shareMode = true;
  state.room.code = roomCode.toUpperCase();
  state.room.isHost = false;
  updateRoomUI();

  setPlaybackStatus("warn", "Conectando a sala…");
  renderAll();

  // Clean URL
  const clean = new URL(window.location.href);
  clean.searchParams.delete("room");
  history.replaceState({}, "", clean.toString());

  startRoomGuestPolling(state.room.code);
  return true;
}


// QR modal tab switching
function switchQRTab(tab) {
  document.getElementById("qr-tab-static").classList.toggle("active", tab === "static");
  document.getElementById("qr-tab-live").classList.toggle("active",   tab === "live");
  document.getElementById("qr-panel-static").style.display = tab === "static" ? "block" : "none";
  document.getElementById("qr-panel-live").style.display   = tab === "live"   ? "block" : "none";

  if (tab === "live" && state.room.isHost && state.room.code) {
    // Already hosting — show host panel
    document.getElementById("live-host-panel").style.display = "block";
    document.getElementById("live-join-panel").style.display = "none";
    renderLiveQR();
  } else if (tab === "live") {
    document.getElementById("live-host-panel").style.display = "none";
    document.getElementById("live-join-panel").style.display = "block";
  }
}

function renderLiveQR() {
  if (!state.room.code) return;
  const guestUrl = new URL(window.location.href);
  guestUrl.search = "";
  guestUrl.searchParams.set("room", state.room.code);
  const url = guestUrl.toString();
  const canvas = document.getElementById("qr-canvas-live");
  const lbl    = document.getElementById("live-room-label");
  if (!canvas) return;
  canvas.innerHTML = "";
  try {
    if (typeof QRCode === "undefined") throw new Error();
    new QRCode(canvas, { text: url, width: 180, height: 180, colorDark:"#000", colorLight:"#fff", correctLevel: QRCode.CorrectLevel.M });
  } catch(_) {
    canvas.innerHTML = `<div style="padding:10px;font-size:10px;word-break:break-all;color:#333">${url}</div>`;
  }
  if (lbl) lbl.textContent = `Código: ${state.room.code}`;
}

// Override showQR to also init the static panel
const _origShowQR = showQR;
function showQR() {
  // Build static QR
  const url = buildShareUrl();
  const modal   = document.getElementById("qr-modal");
  const overlay = document.getElementById("qr-overlay");
  const canvas  = document.getElementById("qr-canvas");
  const lbl     = document.getElementById("qr-song-label");
  if (!modal) return;
  canvas.innerHTML = "";
  try {
    if (typeof QRCode === "undefined") throw new Error();
    new QRCode(canvas, { text: url || window.location.href, width: 180, height: 180, colorDark:"#000", colorLight:"#fff", correctLevel: QRCode.CorrectLevel.M });
  } catch(_) {
    canvas.innerHTML = `<div style="padding:10px;font-size:10px;word-break:break-all;color:#333">${url}</div>`;
  }
  if (lbl && state.currentTrack) lbl.textContent = `${state.currentTrack.name} — ${state.currentTrack.artists[0]}`;
  // Default to live tab if already hosting
  switchQRTab(state.room.isHost ? "live" : "static");
  modal.classList.add("open");
  overlay.classList.add("open");
}

async function copyRoomUrl() {
  if (!state.room.code) return;
  const guestUrl = new URL(window.location.href);
  guestUrl.search = "";
  guestUrl.searchParams.set("room", state.room.code);
  try {
    await navigator.clipboard.writeText(guestUrl.toString());
    const btn = document.querySelector("#qr-panel-live .button-secondary");
    if (btn) { btn.textContent = "¡Copiado!"; setTimeout(() => btn.textContent = "Copiar enlace sala", 2000); }
  } catch(_) {}
}

// ─── Prefetch next track ──────────────────────────────────────
async function prefetchNextTrack() {
  if (!state.tokens?.accessToken || !state.settings.workerUrl) return;
  if (state.shareMode) return;

  try {
    const res = await fetch("https://api.spotify.com/v1/me/player/queue", {
      headers: { Authorization: `Bearer ${state.tokens.accessToken}` }
    });
    if (!res.ok) return;
    const data = await res.json();

    // queue[0] is the next track (index 0 of the upcoming queue)
    const next = data.queue?.[0];
    if (!next || next.type !== "track") return;

    const nextTrack = {
      id:         next.id,
      name:       next.name,
      artists:    next.artists.map(a => a.name),
      album:      next.album?.name || "",
      image:      next.album?.images?.[0]?.url || "",
      durationMs: next.duration_ms,
    };
    const nextKey = buildTrackLookupKey(nextTrack);

    // Skip if already cached, already playing, or same as current
    if (prefetchCache.has(nextKey))          return;
    if (nextKey === state.lastTrackKey)      return;

    console.log("[prefetch] fetching chords for →", nextTrack.name);
    await prefetchChordsBackground(nextTrack, nextKey);

  } catch(e) {
    console.log("[prefetch] error:", e.message);
  }
}

async function prefetchChordsBackground(track, trackKey) {
  const title  = cleanTrackLookupText(track.name);
  const artist = track.artists[0] || "";

  const sources = [
    { name: "Cifraclub",       fn: () => fetchChordsViaCifraclub(title, artist) },
    { name: "Ultimate Guitar", fn: () => fetchChordsViaUltimateGuitar(title, artist) },
    { name: "E-Chords",        fn: () => fetchChordsViaEChords(title, artist) },
  ];

  const found = [];
  for (const src of sources) {
    // Abort if the song we're prefetching is now playing (user skipped fast)
    if (trackKey === state.lastTrackKey) return;
    try {
      const result = await src.fn();
      if (result) {
        result.source = result.source || src.name;
        found.push(result);
      }
    } catch(_) {}
  }

  if (!found.length) {
    console.log("[prefetch] no results for", track.name);
    return;
  }

  const detectedKey = detectKeyFromSheet(found[0].content || "");

  // Evict oldest entry if cache is full
  if (prefetchCache.size >= PREFETCH_MAX) {
    prefetchCache.delete(prefetchCache.keys().next().value);
  }

  prefetchCache.set(trackKey, { sources: found, detectedKey });
  console.log("[prefetch] cached", track.name, "(" + found.length + " sources)");
}

// ── 7. Usage stats ────────────────────────────────────────────
function loadStats() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEYS.stats) || "{}");
  } catch(_) { return {}; }
}

function saveStats(stats) {
  try { localStorage.setItem(STORAGE_KEYS.stats, JSON.stringify(stats)); } catch(_) {}
}

function recordStats(track, detectedKey) {
  const stats = loadStats();
  stats.total = (stats.total || 0) + 1;

  // Artists
  const artist = track.artists[0] || "Desconocido";
  stats.artists = stats.artists || {};
  stats.artists[artist] = (stats.artists[artist] || 0) + 1;

  // Keys
  if (detectedKey) {
    stats.keys = stats.keys || {};
    stats.keys[detectedKey.label] = (stats.keys[detectedKey.label] || 0) + 1;
  }

  // Songs
  const songKey = `${track.name} — ${artist}`;
  stats.songs = stats.songs || {};
  stats.songs[songKey] = (stats.songs[songKey] || 0) + 1;

  // BPM range (bucket by 10)
  if (state.bpm) {
    const bucket = Math.round(state.bpm / 10) * 10;
    const bpmLabel = `~${bucket} BPM`;
    stats.bpms = stats.bpms || {};
    stats.bpms[bpmLabel] = (stats.bpms[bpmLabel] || 0) + 1;
  }

  saveStats(stats);
}

function renderStats() {
  const el = document.getElementById("stats-display");
  if (!el) return;
  const stats = loadStats();

  if (!stats.total) {
    el.innerHTML = `<p style="color:var(--text-3);font-size:12px;grid-column:span 2">Sin estadísticas aún — toca algunas canciones.</p>`;
    return;
  }

  const topArtist    = Object.entries(stats.artists || {}).sort((a,b) => b[1]-a[1])[0];
  const topKey       = Object.entries(stats.keys    || {}).sort((a,b) => b[1]-a[1])[0];
  const uniqueArtists = Object.keys(stats.artists || {}).length;

  const topSong = Object.entries(stats.songs || {}).sort((a,b)=>b[1]-a[1])[0];
  const topBpm  = Object.entries(stats.bpms  || {}).sort((a,b)=>b[1]-a[1])[0];

  el.innerHTML = `
    <div class="stat-item">
      <span class="stat-value">${stats.total}</span>
      <span class="stat-label">Canciones</span>
    </div>
    <div class="stat-item">
      <span class="stat-value">${uniqueArtists}</span>
      <span class="stat-label">Artistas únicos</span>
    </div>
    ${topArtist ? `
    <div class="stat-item" style="grid-column:span 2">
      <span class="stat-value" style="font-size:13px;line-height:1.3">${topArtist[0]}</span>
      <span class="stat-label">Artista favorito (${topArtist[1]}×)</span>
    </div>` : ""}
    ${topSong ? `
    <div class="stat-item" style="grid-column:span 2">
      <span class="stat-value" style="font-size:12px;line-height:1.3">${topSong[0]}</span>
      <span class="stat-label">Canción más escuchada (${topSong[1]}×)</span>
    </div>` : ""}
    ${topKey ? `
    <div class="stat-item">
      <span class="stat-value" style="font-size:13px">${topKey[0]}</span>
      <span class="stat-label">Tonalidad fav.</span>
    </div>` : ""}
    ${topBpm ? `
    <div class="stat-item">
      <span class="stat-value" style="font-size:13px">${topBpm[0]}</span>
      <span class="stat-label">BPM favorito</span>
    </div>` : ""}
  `;
}

// openSettings refreshes stats — patched directly in the original function

// ═══════════════════════════════════════════════════════════════
//  ROADMAP — Multi-instrument tab views (not yet implemented)
// ═══════════════════════════════════════════════════════════════
//
//  Planned: swipeable horizontal panels in the chords card:
//
//  [Acordes] → swipe → [Tabs Guitarra] → swipe → [Tabs Bajo]
//
//  Panel 1 — Acordes (current implementation)
//    - Chord sheet con letras y acordes alineados
//    - Source switcher (Cifraclub / UG / E-Chords)
//    - Transpose, enharmonic, font size
//
//  Panel 2 — Tabs Guitarra
//    - Tablatura estándar de 6 cuerdas (e B G D A E)
//    - Scrape de tabs de Ultimate Guitar (type:"Tab" en lugar de "Chords")
//    - Renderizar con fuente monoespaciada, scroll horizontal si necesario
//    - Highlight de posición actual si sync mode está activo
//
//  Panel 3 — Tabs Bajo
//    - Tablatura de 4 cuerdas (G D A E)
//    - Scrape de bass tabs de Ultimate Guitar (type:"Bass Tab")
//    - Misma lógica de render que tabs guitarra
//
//  Diagramas mejorados (todos los instrumentos):
//    - Guitarra: expandir GUITAR_CHORDS con más voicings (barre, drop-D, etc.)
//    - Piano: ya implementado con inversiones
//    - Bajo: nuevo — diagrama de mástil de 4 cuerdas, posiciones de raíz + escala
//
//  Implementación UI:
//    - CSS scroll-snap horizontal dentro de .chords-card
//    - Dots indicator debajo (• • •) mostrando panel activo
//    - Swipe nativo con touch events o CSS scroll-snap-type: x mandatory
//    - Cada panel mantiene su propio estado de fuente independiente
//    - El source switcher se adapta al panel activo (chords vs tabs vs bass)
//
// ═══════════════════════════════════════════════════════════════

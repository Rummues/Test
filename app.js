// ─────────────────────────────────────────────────────────────
//  Spotify Chords Board  ·  app.js
// ─────────────────────────────────────────────────────────────

const STORAGE_KEYS = {
  settings: "spotify-chords.settings.v5",
  tokens:   "spotify-chords.tokens.v5"
};

const SPOTIFY_SCOPES = ["user-read-currently-playing", "user-read-playback-state"];

const state = {
  settings: { clientId: "", geminiKey: "" },
  tokens: null,
  currentTrack: null,
  authTone: "muted",   authText: "Sin conectar",
  playbackTone: "muted", playbackText: "Esperando",
  lyricsTone: "muted", lyricsText: "Esperando",
  lyricsBody: "La letra aparecerá aquí cuando Spotify reporte una canción activa.",
  lyricsSourceUrl: "",
  chordsTone: "muted", chordsText: "Esperando",
  chordsData: null,
  lastTrackKey: "",
  lastSyncAt: 0,
  pollTimer: null,
  progressTimer: null
};

const el = {};

document.addEventListener("DOMContentLoaded", boot);

async function boot() {
  cacheElements();
  bindEvents();
  hydrateState();
  renderAll();
  await maybeFinishSpotifyLogin();
  if (state.tokens) startSpotifyPolling();
  else startProgressLoop();
}

// ─── DOM Cache ────────────────────────────────────────────────
function cacheElements() {
  const ids = [
    "spotify-client-id", "gemini-key", "redirect-uri",
    "copy-url-btn", "connect-btn", "disconnect-btn",
    "auth-status-pill", "auth-helper",
    "playback-pill", "cover-art",
    "track-kicker", "track-title", "track-artist", "track-album",
    "progress-left", "progress-right", "progress-fill",
    "sync-label", "spotify-link",
    "lyrics-pill", "lyrics-copy", "lyrics-view", "lyrics-source-link",
    "chords-pill", "chords-key-badge", "chords-chips-row",
    "chords-sections", "chords-status-text",
    "match-pill", "match-box",
    "query-primary", "query-secondary", "chords-view",
    "external-pill", "external-copy",
    "ddg-chords-link", "ddg-spanish-link",
    "google-chords-link", "google-lyrics-link", "copy-query-btn"
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
  el.geminiKey.addEventListener("input", () => {
    state.settings.geminiKey = el.geminiKey.value.trim();
    saveSettings();
  });
  el.copyUrlBtn.addEventListener("click", copyRedirectUri);
  el.connectBtn.addEventListener("click", startSpotifyLogin);
  el.disconnectBtn.addEventListener("click", disconnectSpotify);
  el.copyQueryBtn.addEventListener("click", copyPrimaryQuery);
}

function hydrateState() {
  try {
    const s = JSON.parse(localStorage.getItem(STORAGE_KEYS.settings) || "null");
    if (s) {
      if (typeof s.clientId === "string") state.settings.clientId = s.clientId;
      if (typeof s.geminiKey === "string") state.settings.geminiKey = s.geminiKey;
    }
  } catch (_) {}
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
  const clientId = state.settings.clientId.trim();
  const redirectUri = getRedirectUri();
  if (!clientId) { setAuthStatus("error", "Falta el Client ID de Spotify."); renderSetup(); return; }
  if (!redirectUri) { setAuthStatus("warn", "Necesitas abrir esta app desde una URL HTTPS publicada."); renderSetup(); return; }

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
  setAuthStatus("muted", "Sin conectar");
  setPlaybackStatus("muted", "Esperando");
  renderAll();
}

// ─── Spotify Polling ──────────────────────────────────────────
function startSpotifyPolling() {
  stopSpotifyPolling();
  fetchSpotifyPlayback();
  state.pollTimer = window.setInterval(fetchSpotifyPlayback, 4000);
  startProgressLoop();
}

function stopSpotifyPolling() {
  if (state.pollTimer) { window.clearInterval(state.pollTimer); state.pollTimer = null; }
}

async function fetchSpotifyPlayback() {
  if (!(await ensureFreshSpotifyToken())) { renderAll(); return; }

  try {
    const response = await fetch("https://api.spotify.com/v1/me/player", {
      headers: { Authorization: `Bearer ${state.tokens.accessToken}` }
    });

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
    renderAll();

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
}

// ─── Lyrics ───────────────────────────────────────────────────
async function fetchLyricsForTrack(track) {
  return (await fetchLyricsFromLrclib(track)) || (await fetchLyricsFromLyricsOvh(track)) || "";
}

async function fetchLyricsFromLrclib(track) {
  const primaryArtist = track.artists[0] || "";
  const durationSeconds = track.durationMs ? Math.round(track.durationMs / 1000) : "";
  const title = cleanTrackLookupText(track.name);
  const getParams = new URLSearchParams({ track_name: title, artist_name: primaryArtist });
  if (track.album) getParams.set("album_name", track.album);
  if (durationSeconds) getParams.set("duration", String(durationSeconds));

  const exact = await fetchJson(`https://lrclib.net/api/get?${getParams.toString()}`);
  const exactLyrics = extractLyricsText(exact);
  if (exactLyrics) return exactLyrics;

  const searchParams = new URLSearchParams({ track_name: title, artist_name: primaryArtist });
  const results = await fetchJson(`https://lrclib.net/api/search?${searchParams.toString()}`);
  if (Array.isArray(results)) {
    for (const item of results) {
      const candidate = extractLyricsText(item);
      if (candidate) return candidate;
    }
  }
  return "";
}

async function fetchLyricsFromLyricsOvh(track) {
  const artist = encodeURIComponent(track.artists[0] || "");
  const title = encodeURIComponent(cleanTrackLookupText(track.name));
  const payload = await fetchJson(`https://api.lyrics.ovh/v1/${artist}/${title}`);
  return (payload && typeof payload.lyrics === "string" && payload.lyrics.trim()) ? payload.lyrics.trim() : "";
}

// ─── Chords via Anthropic API ─────────────────────────────────
// ─── Chord prompt (shared) ────────────────────────────────────
function buildChordPrompt(title, artist) {
  return (
    `Give me the real chords for "${title}" by "${artist}".\n\n` +
    `Reply with ONLY valid JSON, no markdown fences, no extra text:\n` +
    `{"key":"G","tempo":"moderado","chords":["G","Em","C","D"],` +
    `"sections":[` +
      `{"name":"Verso","lines":[` +
        `{"text":"First real lyrics line","chords":["G","","Em",""]},` +
        `{"text":"Second real lyrics line","chords":["C","","D",""]}]},` +
      `{"name":"Coro","lines":[` +
        `{"text":"First chorus line","chords":["C","","G",""]},` +
        `{"text":"Second chorus line","chords":["D","","Em",""]}]}],` +
    `"progression":{"Verso":"G - Em - C - D","Coro":"C - G - D - Em"}}\n\n` +
    `IMPORTANT: Use the REAL chords of this specific song. Include real lyrics. ` +
    `At least Verso + Coro. Each line exactly 4 chords (empty string for silent beats). ` +
    `key = actual key of the song.`
  );
}

// ─── Strategy 1: Gemini free API ─────────────────────────────
async function fetchChordsViaGemini(title, artist, geminiKey) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${geminiKey}`;
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: buildChordPrompt(title, artist) }] }],
      generationConfig: { temperature: 0.2, maxOutputTokens: 2000 }
    })
  });
  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(err?.error?.message || `Gemini HTTP ${response.status}`);
  }
  const data = await response.json();
  const raw = data?.candidates?.[0]?.content?.parts?.[0]?.text || "";
  if (!raw) throw new Error("Gemini devolvió respuesta vacía.");
  return parseChordJSON(raw);
}

// ─── Strategy 2: Scrape chord sites via CORS proxy ────────────
async function fetchChordsViaScrape(title, artist) {
  // Try multiple sources in order
  const sources = [
    () => scrapeEChords(title, artist),
    () => scrapeCifraclub(title, artist),
  ];
  for (const src of sources) {
    try {
      const result = await src();
      if (result) return result;
    } catch (_) {}
  }
  return null;
}

async function scrapeEChords(title, artist) {
  const q   = encodeURIComponent(`${artist} ${title}`);
  const url = `https://www.e-chords.com/search-all/${q}`;
  const proxy = `https://api.allorigins.win/get?url=${encodeURIComponent(url)}`;
  const res  = await fetch(proxy);
  if (!res.ok) return null;
  const { contents } = await res.json();
  // Find first chord page link
  const match = contents.match(/href="(https:\/\/www\.e-chords\.com\/chords\/[^"]+)"/);
  if (!match) return null;

  // Fetch the chord page
  const pageProxy = `https://api.allorigins.win/get?url=${encodeURIComponent(match[1])}`;
  const pageRes = await fetch(pageProxy);
  if (!pageRes.ok) return null;
  const { contents: pageHtml } = await pageRes.json();
  return parseEChordsHtml(pageHtml, title, artist);
}

function parseEChordsHtml(html, title, artist) {
  // Extract chord tokens like [Am] [F] etc from the pre/chord block
  const chordMatches = [...html.matchAll(/\[([A-G][#b]?(?:m|maj|min|dim|aug|sus|add)?[0-9]?)\]/g)];
  if (chordMatches.length < 3) return null;
  const uniqueChords = [...new Set(chordMatches.map(m => m[1]))].slice(0, 8);

  // Extract lyrics lines (strip HTML tags)
  const bodyMatch = html.match(/<pre[^>]*id="core"[^>]*>([\s\S]*?)<\/pre>/i) ||
                    html.match(/<pre[^>]*>([\s\S]*?)<\/pre>/i);
  const rawText = bodyMatch
    ? bodyMatch[1].replace(/<[^>]+>/g, "").replace(/&amp;/g,"&").replace(/&nbsp;/g," ")
    : "";

  const lines = rawText.split("\n").filter(l => l.trim()).slice(0, 20);
  // Build sections from lines
  const sections = buildSectionsFromLines(lines, title);

  return {
    key: guessKey(uniqueChords),
    tempo: "—",
    chords: uniqueChords,
    sections,
    progression: { "Canción": uniqueChords.join(" - ") }
  };
}

async function scrapeCifraclub(title, artist) {
  const q = encodeURIComponent(`${artist} ${title} site:cifraclub.com`);
  // Use Google's cache-friendly search to find the page URL first
  const searchUrl = `https://www.cifraclub.com.br/busca/?q=${encodeURIComponent(title + " " + artist)}`;
  const proxy = `https://api.allorigins.win/get?url=${encodeURIComponent(searchUrl)}`;
  const res = await fetch(proxy);
  if (!res.ok) return null;
  const { contents } = await res.json();
  const match = contents.match(/href="(\/[^"]+\/[^"]+\/)"[^>]*class="[^"]*gs-title/);
  if (!match) return null;

  const pageUrl = "https://www.cifraclub.com.br" + match[1];
  const pageProxy = `https://api.allorigins.win/get?url=${encodeURIComponent(pageUrl)}`;
  const pageRes = await fetch(pageProxy);
  if (!pageRes.ok) return null;
  const { contents: pageHtml } = await pageRes.json();
  return parseCifraclubHtml(pageHtml, title, artist);
}

function parseCifraclubHtml(html, title, artist) {
  const chordMatches = [...html.matchAll(/class="[^"]*chord[^"]*"[^>]*>([A-G][#b]?(?:m|maj|min|dim|aug|sus)?[0-9]?)</g)];
  if (chordMatches.length < 3) return null;
  const uniqueChords = [...new Set(chordMatches.map(m => m[1]))].slice(0, 8);

  return {
    key: guessKey(uniqueChords),
    tempo: "—",
    chords: uniqueChords,
    sections: [{ name: "Canción", lines: [{ text: `${title} — ${artist}`, chords: uniqueChords.slice(0,4) }] }],
    progression: { "Canción": uniqueChords.join(" - ") }
  };
}

function buildSectionsFromLines(lines, title) {
  // Simple heuristic: group lines into sections of 4
  const sections = [];
  const sectionNames = ["Intro", "Verso", "Pre-Coro", "Coro", "Puente"];
  let si = 0;
  for (let i = 0; i < lines.length; i += 4) {
    const chunk = lines.slice(i, i + 4);
    if (chunk.length === 0) continue;
    sections.push({
      name: sectionNames[si++] || `Sección ${si}`,
      lines: chunk.map(text => ({ text: text.slice(0,50), chords: ["", "", "", ""] }))
    });
    if (si >= sectionNames.length) break;
  }
  return sections.length ? sections : [{ name: "Canción", lines: [{ text: title, chords: [] }] }];
}

function guessKey(chords) {
  // Very simple: take root of first chord
  const first = chords[0] || "C";
  return first.match(/^[A-G][#b]?m?/)?.[0] || first;
}

// ─── Main entry: try Gemini first, then scraping ──────────────
async function fetchChordsForTrack(track, trackKey) {
  const title  = cleanTrackLookupText(track.name);
  const artist = track.artists[0] || "";
  const geminiKey = state.settings.geminiKey.trim();

  // Show loading
  state.chordsTone = "warn";
  state.chordsText = "Buscando…";
  state.chordsData = null;
  if (el.chordsStatusText) el.chordsStatusText.textContent = "Buscando acordes…";
  renderChords();

  let chordData = null;
  let errorMsg  = "";

  // ── Strategy 1: Gemini (if key provided) ──
  if (geminiKey) {
    try {
      chordData = await fetchChordsViaGemini(title, artist, geminiKey);
    } catch (e) {
      errorMsg = `Gemini: ${e.message}`;
    }
  }

  if (trackKey !== state.lastTrackKey) return;

  // ── Strategy 2: Scrape chord sites ──
  if (!chordData) {
    if (el.chordsStatusText) el.chordsStatusText.textContent = geminiKey
      ? "Gemini falló, intentando scraping…"
      : "Buscando en sitios de acordes…";
    try {
      chordData = await fetchChordsViaScrape(title, artist);
    } catch (e) {
      errorMsg += ` | Scrape: ${e.message}`;
    }
  }

  if (trackKey !== state.lastTrackKey) return;

  if (chordData) {
    state.chordsTone = "live";
    state.chordsText = "Encontrados";
    state.chordsData = chordData;
  } else {
    state.chordsTone = "warn";
    state.chordsText = "No encontrados";
    state.chordsData = null;
    if (el.chordsStatusText) {
      el.chordsStatusText.textContent =
        (geminiKey ? "" : "Agrega una Gemini API key (gratis) para mejores resultados. ") +
        "No se encontraron acordes automáticamente. Usa los links de búsqueda abajo." +
        (errorMsg ? `\nDetalle: ${errorMsg}` : "");
    }
  }

  renderChords();
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
  }, 500);
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
  el.spotifyClientId.value = state.settings.clientId;
  el.geminiKey.value       = state.settings.geminiKey;
  el.redirectUri.value     = getRedirectUri();
  el.authStatusPill.className   = `status-pill ${pillClassForTone(state.authTone)}`;
  el.authStatusPill.textContent = state.authText;
  el.authHelper.textContent = getRedirectUri()
    ? "Usa exactamente esta Redirect URI en Spotify. Si cambias el nombre del repo, actualiza también esa URL."
    : "Cuando publiques en GitHub Pages, aquí aparecerá la URL exacta para registrar en Spotify.";
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
    renderSyncLabel();
    return;
  }

  el.coverArt.innerHTML = track.image
    ? `<img alt="Portada" src="${escapeHtml(track.image)}">`
    : initialsFromTrack(track);

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

function renderLyrics() {
  el.lyricsPill.className   = `status-pill ${pillClassForTone(state.lyricsTone)}`;
  el.lyricsPill.textContent = state.lyricsText;
  el.lyricsView.textContent = state.lyricsBody;

  if (!state.currentTrack) {
    el.lyricsCopy.textContent = "Cuando cambie la canción, la app intentará conseguir la letra automáticamente.";
    el.lyricsSourceLink.classList.add("hidden");
    return;
  }

  el.lyricsCopy.textContent = state.lyricsTone === "live"
    ? "Letra obtenida automáticamente."
    : state.lyricsTone === "warn"
      ? "No se encontró letra automática. Usa la búsqueda externa."
      : "Buscando letra…";

  if (state.lyricsSourceUrl) {
    el.lyricsSourceLink.href = state.lyricsSourceUrl;
    el.lyricsSourceLink.classList.remove("hidden");
  } else {
    el.lyricsSourceLink.classList.add("hidden");
  }
}

// ─── Chords Render ────────────────────────────────────────────
function renderChords() {
  if (!el.chordsPill) return;

  el.chordsPill.className   = `status-pill ${pillClassForTone(state.chordsTone)}`;
  el.chordsPill.textContent = state.chordsText;

  const data = state.chordsData;

  if (!data) {
    el.chordsKeyBadge.style.display = "none";
    el.chordsChipsRow.innerHTML     = "";
    el.chordsSections.innerHTML     = el.chordsStatusText
      ? ""
      : "<p style='color:var(--muted);font-size:14px'>Los acordes aparecerán aquí automáticamente.</p>";
    return;
  }

  // Key badge
  el.chordsKeyBadge.style.display = "inline-flex";
  el.chordsKeyBadge.querySelector(".chords-key-val").textContent   = data.key   || "?";
  el.chordsKeyBadge.querySelector(".chords-tempo-val").textContent = data.tempo || "";

  // Chord chips
  el.chordsChipsRow.innerHTML = (data.chords || []).map(chord =>
    `<span class="chord-chip">${escapeHtml(chord)}</span>`
  ).join("");

  // Sections with lyrics+chords
  el.chordsSections.innerHTML = (data.sections || []).map(sec => `
    <div class="chord-section">
      <span class="section-label-chip">${escapeHtml(sec.name || "")}</span>
      ${(sec.lines || []).map(line => buildLyricLine(line)).join("")}
    </div>
  `).join("");
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

function renderSearchDeck() {
  const track = state.currentTrack;
  if (!track) {
    el.matchPill.className   = "status-pill status-pill-muted";
    el.matchPill.textContent = "Inactivo";
    el.matchBox.textContent  = "Cuando cambie la canción, prepararé consultas exactas para acordes.";
    el.queryPrimary.textContent   = "Esperando una canción activa.";
    el.querySecondary.textContent = "Aparecerá una variante para buscar cifras y acordes.";
    el.chordsView.textContent     = "Búsquedas dirigidas aparecerán aquí.";
    el.externalPill.className     = "status-pill status-pill-muted";
    el.externalPill.textContent   = "Inactivo";
    el.externalCopy.textContent   = "Sin iframes frágiles. Solo enlaces exactos orientados a resultados.";
    hideSearchLinks();
    return;
  }

  const plan = buildSearchPlan(track);
  el.matchPill.className   = "status-pill status-pill-live";
  el.matchPill.textContent = "Listo";
  el.matchBox.textContent  = `Búsquedas para "${track.name}" de ${track.artists[0] || "artista desconocido"}.`;
  el.queryPrimary.textContent   = plan.primaryQuery;
  el.querySecondary.textContent = plan.secondaryQuery;
  el.chordsView.textContent     = `Ataque 1: DuckDuckGo — sitios grandes de acordes.\nAtaque 2: variante hispana para cifras.\nAtaque 3: Google como respaldo.`;
  el.externalPill.className     = "status-pill status-pill-live";
  el.externalPill.textContent   = "Armado";
  el.externalCopy.textContent   = "Estos enlaces usan el título limpio y artista principal.";

  el.ddgChordsLink.href    = plan.ddgChordsUrl;
  el.ddgSpanishLink.href   = plan.ddgSpanishUrl;
  el.googleChordsLink.href = plan.googleChordsUrl;
  el.googleLyricsLink.href = plan.googleLyricsUrl;

  [el.ddgChordsLink, el.ddgSpanishLink, el.googleChordsLink, el.googleLyricsLink, el.copyQueryBtn]
    .forEach(e => e.classList.remove("hidden"));
}

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
  el.syncLabel.textContent = `Última lectura hace ${seconds}s`;
}

function computeProgressMs() {
  if (!state.currentTrack) return 0;
  const base    = state.currentTrack.progressMs || 0;
  if (!state.currentTrack.isPlaying) return base;
  const elapsed = Math.max(0, Date.now() - state.lastSyncAt);
  return Math.min(base + elapsed, state.currentTrack.durationMs || base);
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
  if (window.location.protocol === "https:" || window.location.protocol === "http:") {
    return `${window.location.origin}${window.location.pathname}`;
  }
  return "";
}

function setAuthStatus(tone, text)     { state.authTone = tone;     state.authText = text; }
function setPlaybackStatus(tone, text) { state.playbackTone = tone; state.playbackText = text; }

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

function hideSearchLinks() {
  [el.ddgChordsLink, el.ddgSpanishLink, el.googleChordsLink, el.googleLyricsLink, el.copyQueryBtn]
    .forEach(e => e?.classList.add("hidden"));
}

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

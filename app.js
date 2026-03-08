// ─────────────────────────────────────────────────────────────
//  Spotify Chords Board  ·  app.js
// ─────────────────────────────────────────────────────────────

const STORAGE_KEYS = {
  settings: "spotify-chords.settings.v5",
  tokens:   "spotify-chords.tokens.v5"
};

const SPOTIFY_SCOPES = ["user-read-currently-playing", "user-read-playback-state"];

const state = {
  settings: { clientId: "", redirectUri: "", workerUrl: "" },
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
    "spotify-client-id", "worker-url", "redirect-uri",
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

  el.workerUrl.addEventListener("input", () => {
    state.settings.workerUrl = el.workerUrl.value.trim().replace(/\/+$/, "");
    saveSettings();
  });
  el.redirectUri.addEventListener("input", () => {
    state.settings.redirectUri = el.redirectUri.value.trim();
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
      if (typeof s.redirectUri === "string") state.settings.redirectUri = s.redirectUri;
      if (typeof s.workerUrl === "string") state.settings.workerUrl = s.workerUrl;
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
      // Results are usually at props.pageProps.result or similar
      const results = nextData?.props?.pageProps?.result
                   || nextData?.props?.pageProps?.results
                   || nextData?.props?.pageProps?.data?.result;
      console.log("[Cifraclub] nextData keys:", Object.keys(nextData?.props?.pageProps || {}));
      if (Array.isArray(results) && results.length > 0) {
        const first = results[0];
        const artistSlug = first.artist?.url || first.artistUrl || first.artist_url;
        const songSlug   = first.url || first.song_url || first.cifra_url;
        console.log("[Cifraclub] first result:", JSON.stringify(first).slice(0, 200));
        if (artistSlug && songSlug) {
          songUrl = `https://www.cifraclub.com/${artistSlug}/${songSlug}/`;
        }
      }
    } catch (e) {
      console.error("[Cifraclub] JSON parse error:", e.message);
    }
  }

  // Fallback: try direct URL guess artist/song slug
  if (!songUrl) {
    const artistSlug = artist.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    const titleSlug  = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    songUrl = `https://www.cifraclub.com/${artistSlug}/${titleSlug}/`;
    console.log("[Cifraclub] using slug fallback:", songUrl);
  }

  const songHtml = await fetchHtmlViaWorker(songUrl + "?tabs=false&instrument=keyboard");
  if (!songHtml || songHtml.length < 1000) throw new Error("Cifraclub: página de canción vacía");

  return parseCifraclubPage(songHtml, title, artist);
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
  const clean = html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "");

  const preMatch = clean.match(/<pre[^>]*>([\s\S]*?)<\/pre>/i);
  console.log("[Cifraclub] pre tag found:", !!preMatch, "html length:", clean.length);
  if (!preMatch) {
    console.log("[Cifraclub] html sample:", clean.slice(0, 1000));
    return null;
  }

  const raw = preMatch[1];
  console.log("[Cifraclub] pre content length:", raw.length, "sample:", raw.slice(0, 200));

  const chordPattern = /<b>([A-G][#b]?(?:m(?:aj)?|dim|aug|sus[24]?|add)?(?:[0-9])?(?:\/[A-G][#b]?)?)<\/b>/g;
  const allChords = [...raw.matchAll(chordPattern)].map(m => m[1]);
  console.log("[Cifraclub] chords found:", allChords.length, allChords.slice(0, 10));
  if (allChords.length < 2) {
    console.log("[Cifraclub] raw pre sample:", raw.slice(0, 500));
    return null;
  }

  // Convert to plain text chord sheet preserving spacing
  // <b>Am</b> → Am, keeping original spaces for alignment
  const sheetText = raw
    .replace(/<b>([^<]+)<\/b>/g, "$1")   // unwrap chords, keep text
    .replace(/<[^>]+>/g, "")             // strip remaining tags
    .replace(/&amp;/g, "&").replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&#[0-9]+;/g, "")
    .trim();

  // Return as plain text — rendered in <pre> with monospace font
  return { type: "text", content: sheetText };
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

  // e-chords search results have links like /chords/artist/song or /tabs/artist/song
  const linkMatch = searchHtml.match(/href="(https?:\/\/www\.e-chords\.com\/(?:chords|tabs)\/[^"]+)"/i)
                 || searchHtml.match(/href="(\/(?:chords|tabs)\/[^"]+)"/i);
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

  const sheetText = rawText.trim();
  if (!sheetText) throw new Error("E-Chords: contenido vacío");
  return { type: "text", content: sheetText };
}

// ── Main orchestrator ─────────────────────────────────────────
async function fetchChordsForTrack(track, trackKey) {
  const title  = cleanTrackLookupText(track.name);
  const artist = track.artists[0] || "";

  state.chordsTone = "warn";
  state.chordsText = "Buscando…";
  state.chordsData = null;
  if (el.chordsStatusText) el.chordsStatusText.textContent = "Buscando acordes…";
  renderChords();

  if (!state.settings.workerUrl) {
    state.chordsTone = "warn";
    state.chordsText = "Sin Worker";
    if (el.chordsStatusText) el.chordsStatusText.textContent = "⚙️ Configura la URL de tu Cloudflare Worker en Setup para obtener acordes automáticamente.";
    renderChords();
    return;
  }

  let chordData = null;
  const log = [];

  // 1 · Cifraclub (mejor base de datos, especialmente español/latino)
  try {
    if (el.chordsStatusText) el.chordsStatusText.textContent = "Buscando en Cifraclub…";
    chordData = await fetchChordsViaCifraclub(title, artist);
    if (chordData) log.push("✓ Cifraclub");
    else log.push("✗ Cifraclub: no encontrado");
  } catch (e) { log.push(`✗ Cifraclub: ${e.message}`); }

  if (trackKey !== state.lastTrackKey) return;

  // 2 · E-Chords (fallback, fuerte en pop/rock inglés)
  if (!chordData) {
    try {
      if (el.chordsStatusText) el.chordsStatusText.textContent = "Buscando en E-Chords…";
      chordData = await fetchChordsViaEChords(title, artist);
      if (chordData) log.push("✓ E-Chords");
      else log.push("✗ E-Chords: no encontrado");
    } catch (e) { log.push(`✗ E-Chords: ${e.message}`); }
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
        "No encontrado automáticamente — usa los links de búsqueda abajo. " + log.join(" · ");
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
  el.spotifyClientId.value  = state.settings.clientId;
  if (el.workerUrl) el.workerUrl.value = state.settings.workerUrl || "";
  el.redirectUri.value     = getRedirectUri() || state.settings.redirectUri;
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

  // ── Plain-text chord sheet from Groq ──
  if (data.type === "text") {
    if (el.chordsSections) {
      el.chordsSections.innerHTML = `<pre class="chord-sheet-pre">${escapeHtml(data.content)}</pre>`;
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

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
  progressTimer: null,
  scroll: { speed: 1.0, userPaused: true, _rafId: null, _lastTime: null, _expectedY: null },
  transpose: 0,
  enharmonic: false
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
      window.scrollTo({ top: 0, behavior: "smooth" });
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
  const placeholder = document.getElementById("scroll-controls-placeholder");

  window.addEventListener("scroll", () => {
    // FAB
    if (fab) fab.classList.toggle("visible", window.scrollY > 300);

    // Sticky scroll-controls
    const ctrl = el.scrollControls;
    if (!ctrl || ctrl.style.display === "none") return;

    if (ctrl.classList.contains("is-pinned")) {
      // Already pinned — unpin if we've scrolled back above origin
      const originTop = parseFloat(placeholder.dataset.originTop || "0");
      if (window.scrollY < originTop - 8) {
        ctrl.classList.remove("is-pinned");
        placeholder.style.display = "none";
      }
    } else {
      // Not pinned — pin if top of element has reached viewport top
      const rect = ctrl.getBoundingClientRect();
      if (rect.top <= 8) {
        // Save origin position and height for placeholder
        placeholder.dataset.originTop = String(window.scrollY + rect.top);
        placeholder.style.display = "block";
        placeholder.style.height  = ctrl.offsetHeight + "px";
        ctrl.classList.add("is-pinned");
      }
    }
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
  // On new song: scroll to chords card (not hard top), reset teleprompter
  setTimeout(() => {
    const target = el.chordsSections?.closest?.(".card") || document.querySelector(".chords-card");
    if (target) target.scrollIntoView({ behavior: "smooth", block: "start" });
  }, 200);
  if (el.chordsSections) el.chordsSections.scrollTop = 0;
  state.scroll.userPaused = true;
  state.scroll._acc       = 0;
  state.scroll._lastTime  = null;
  state.enharmonic = false;
  if (el.enharmonicBtn) el.enharmonicBtn.classList.remove("active");
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

  // Look for "Capo en el Nº traste" or "Capo on Nth fret"
  const capoMatch = html.match(/[Cc]apo\s+(?:en\s+el\s+)?(\d+)[ºª°]?\s*(?:traste|fret)/i)
                 || html.match(/[Cc]apo[:\s]+(\d+)/i);
  if (capoMatch) {
    semitones = parseInt(capoMatch[1], 10);
    capoInfo  = `Capo ${capoMatch[1]}`;
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

  // Prepend capo/tone info if found
  if (capoInfo) sheetText = `[${capoInfo} — acordes transpuestos automáticamente]\n\n` + sheetText;

  return { type: "text", content: sheetText, source: "Cifraclub", url: "" };
}

// ── Chord transposition engine ────────────────────────────────
const NOTES_SHARP = ["C","C#","D","D#","E","F","F#","G","G#","A","A#","B"];
const NOTES_FLAT  = ["C","Db","D","Eb","E","F","Gb","G","Ab","A","Bb","B"];

// Convert flat enharmonics to sharps — keeps Bb family untouched
function flatToSharpText(text) {
  // Replace flat roots (not Bb) and keep chord suffix: Abm→G#m, Ebm7→D#m7, etc.
  const map = { "Eb":"D#","Ab":"G#","Db":"C#","Gb":"F#","Cb":"B","Fb":"E" };
  return text.replace(/\b(Eb|Ab|Db|Gb|Cb|Fb)((?:maj|min|m|dim|aug|sus[24]?|add)?[0-9]?(?:\/[A-G][#b]?)?)/g,
    (_, root, suffix) => (map[root] || root) + suffix
  );
}

// Convert sharps to flats: C#m→Dbm, G#m7→Abm7, A#→Bb, etc.
function sharpToFlatText(text) {
  const map = { "C#":"Db","D#":"Eb","F#":"Gb","G#":"Ab","A#":"Bb" };
  return text.replace(/\b([A-G]#)((?:maj|min|m|dim|aug|sus[24]?|add)?[0-9]?(?:\/[A-G][#b]?)?)/g,
    (_, root, suffix) => (map[root] || root) + suffix
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

// Wrap chord tokens in <span class="chord"> for color highlighting
// Only applied after escapeHtml so we work on the safe string
function highlightChords(safeText) {
  // Chord pattern as a word: A-G + optional #/b + optional suffix + optional /bass
  // Must be surrounded by spaces, line start/end, or punctuation — not inside words
  return safeText.replace(
    /(?<![A-Za-z])([A-G][#b]?(?:maj|min|m|dim|aug|sus[24]?|add)?[0-9]?(?:\/[A-G][#b]?)?)(?![A-Za-z])/g,
    '<span class="chord">$1</span>'
  );
}
// Replaces chord tokens (A-G + optional # or b + optional suffix)
// without touching lyric words that start with those letters
function applyTransposeToSheet(text, semitones) {
  if (!semitones) return text;
  const chordToken = /^[A-G][#b]?(?:m(?:aj)?|dim|aug|sus[24]?|add)?[0-9]?(?:\/[A-G][#b]?)?$/;
  return text.split("\n").map(line => {
    const tokens = line.trim().split(/(\s+)/);
    const wordTokens = tokens.filter(t => t.trim());
    if (wordTokens.length === 0) return line;
    const chordCount = wordTokens.filter(t => chordToken.test(t)).length;
    if (chordCount / wordTokens.length >= 0.5) {
      return tokens.map(t =>
        chordToken.test(t.trim()) ? transposeChord(t.trim(), semitones) + (t.endsWith(" ") ? " " : "") : t
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

  const sheetText = rawText.trim();
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

  // Detect capo from content header lines like "Capo 1st fret" or "Capo: 2"
  let ugSemitones = 0;
  const capoLine = text.match(/[Cc]apo[:\s]+(\d+)(?:st|nd|rd|th)?\s*(?:fret|traste)?/i);
  if (capoLine) {
    ugSemitones = parseInt(capoLine[1], 10);
    console.log("[UG] capo detected:", ugSemitones);
  }
  // Also detect "Tuning: E A D G B E  Capo: 1st fret" format
  const tuningCapo = text.match(/[Cc]apo[:\s]+(\d+)/i);
  if (!ugSemitones && tuningCapo) {
    ugSemitones = parseInt(tuningCapo[1], 10);
    console.log("[UG] tuning-line capo detected:", ugSemitones);
  }

  if (ugSemitones) {
    // Strip chord diagram lines (X - XXXXXX) before transposing
    const lines = text.split("\n");
    const transposed = lines.map(line => {
      // Diagram lines: "Am - x02210" or "G   - 32000x" — skip transposing those
      if (/^[A-G][#b]?[\w\/]*\s*-\s*[x\d]+/i.test(line.trim())) return line;
      return applyTransposeToSheet(line, ugSemitones);
    });
    text = transposed.join("\n");
    text = `[Capo ${ugSemitones} — acordes transpuestos automáticamente]\n\n` + text;
  }

  if (!text || text.length < 20) throw new Error("UG: contenido vacío");
  return { type: "text", content: text, source: "Ultimate Guitar" };
}


// ── Main orchestrator ─────────────────────────────────────────
async function fetchChordsForTrack(track, trackKey) {
  const title  = cleanTrackLookupText(track.name);
  const artist = track.artists[0] || "";

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
  }, 500);
  startTeleprompterLoop();
}

// ─── Teleprompter — free scroll (constant px/sec, toggle on/off) ─
function startTeleprompterLoop() {
  if (state.scroll._rafId) cancelAnimationFrame(state.scroll._rafId);
  state.scroll._lastTime  = null;
  state.scroll._acc       = 0;   // sub-pixel accumulator for smoothness

  function tick(now) {
    state.scroll._rafId = requestAnimationFrame(tick);

    if (state.scroll.userPaused) {
      state.scroll._lastTime = null;
      return;
    }

    if (!state.scroll._lastTime) { state.scroll._lastTime = now; return; }
    const dt = Math.min(now - state.scroll._lastTime, 100) / 1000;
    state.scroll._lastTime = now;

    // Accumulate fractional pixels so low speeds don't jitter
    state.scroll._acc += 40 * state.scroll.speed * dt;
    const step = Math.floor(state.scroll._acc);
    if (step < 1) return;                 // wait until we have ≥1 full pixel
    state.scroll._acc -= step;

    window.scrollBy({ top: step, behavior: "instant" });
  }

  requestAnimationFrame(tick);
}

function updateScrollUI() {
  if (!el.scrollToggle) return;
  const paused = state.scroll.userPaused;
  el.scrollToggle.textContent = paused ? "▶ Auto" : "⏸ Auto";
  el.scrollToggle.classList.toggle("paused", paused);
  if (el.scrollSpeedLabel) {
    el.scrollSpeedLabel.textContent = state.scroll.speed.toFixed(2).replace(/\.?0+$/, "") + "×";
  }
}

function showScrollControls(visible) {
  if (el.scrollControls) {
    el.scrollControls.style.display = visible ? "flex" : "none";
    if (!visible) {
      el.scrollControls.classList.remove("is-pinned");
      const ph = document.getElementById("scroll-controls-placeholder");
      if (ph) ph.style.display = "none";
    }
  }
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

  // ── Plain-text chord sheet ──
  if (data.type === "text") {
    if (el.chordsSections) {
      let displayed = state.transpose
        ? applyTransposeToSheet(data.content, state.transpose)
        : data.content;
      if (state.enharmonic === "flat2sharp") displayed = flatToSharpText(displayed);
      else if (state.enharmonic === "sharp2flat") displayed = sharpToFlatText(displayed);
      el.chordsSections.innerHTML = `<pre class="chord-sheet-pre">${highlightChords(escapeHtml(displayed))}</pre>`;
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

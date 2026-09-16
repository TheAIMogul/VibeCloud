import React, { useState, useEffect, useRef, useCallback } from 'react';
import { createRoot } from 'react-dom/client';
import {
  Settings,
  Send,
  Download,
  Loader2,
  RefreshCcw,
  ShieldCheck,
  Save,
  Undo,
  ShieldAlert,
  Activity,
  Music2,
  TreePalm,
  Zap,
  Play,
  Pause,
  Repeat,
  SkipForward,
  SkipBack,
  ListMusic,
  ChevronDown,
  ChevronUp,
  ExternalLink,
  Moon,
  Sun,
  Volume2,
  VolumeX,
  CheckSquare,
  Square,
  Bell,
  BellOff,
  Smartphone,
} from 'lucide-react';
import { GoogleGenAI } from "@google/genai";
import type Hls from 'hls.js';
import type { ErrorData } from 'hls.js';
// @ts-ignore
import ID3Writer from 'https://esm.sh/browser-id3-writer@4.4.0';

// --- Constants ---
// client_id is injected server-side by the Worker (SOUNDCLOUD_CLIENT_ID secret),
// so it is intentionally empty here and never shipped in the client bundle.
const KNOWN_GOOD_CLIENT_ID = '';
const TARGET_USER_ID = '5402929';
// Pushbullet is handled server-side by the Worker (PUSHBULLET_TOKEN secret). This
// default is empty; a user may still set their own token in Settings (sent to the
// Worker as a per-request override).
const DEFAULT_PB_ACCESS_TOKEN = '';
const SC_API_BASE = 'https://api-v2.soundcloud.com';
const PLACEHOLDER_IMG = 'https://placehold.co/400x400/13172A/787E91?text=%E2%99%AA';
const LIKES_PER_PAGE = 24;
const NEXT_TRACK_PREFETCH_SECONDS = 15;

// --- Streaming playback ---
// Playback streams SoundCloud's HLS through hls.js instead of downloading the whole
// file first. Even the light build (no DRM, subtitles or alternate audio, which these
// audio-only streams never use) is ~386 KB minified, so it loads on demand and is
// warmed shortly after launch rather than shipped in the main bundle.
let hlsModulePromise: Promise<typeof Hls> | null = null;
const loadHls = (): Promise<typeof Hls> => {
  hlsModulePromise ??= import('hls.js/light')
    .then((m) => m.default as unknown as typeof Hls)
    .catch((err) => {
      hlsModulePromise = null; // let a later play retry, e.g. after coming back online
      throw err;
    });
  return hlsModulePromise;
};

// Start from the tiny first chunk (~2 s of audio), then buffer far ahead so a song
// that has started keeps playing through a dropped signal. backBufferLength caps
// memory on hour-long mixes.
const HLS_CONFIG = {
  maxBufferLength: 300,
  maxMaxBufferLength: 600,
  backBufferLength: 90,
};

// SoundCloud's signed playlist links expire ~5 minutes after issue (chunk links last
// ~2 hours). A link prepared ahead of time but older than this is resolved again.
const STREAM_URL_MAX_AGE_MS = 4 * 60 * 1000;

// --- Networking Layer ---
// The Cloudflare Worker hosts /proxy (with server-side client_id injection) and
// the /api/pb/* endpoints. In production we hit it same-origin (empty base). In
// `vite dev` we point at the deployed Worker, since the old local Node cors-proxy
// can't inject the client_id or hold the Pushbullet secret. All Worker routes are
// CORS-enabled, so cross-origin dev calls work.
// @ts-ignore - import.meta.env is provided by Vite at build time
const IS_DEV = Boolean(import.meta.env?.DEV);
const CORS_PROXY_BASE = IS_DEV
  ? 'https://vibecloud.theaimogul.com'
  : '';
const PROXY_GATES = [
  { name: 'VibeProxy', fn: (url: string) => `${CORS_PROXY_BASE}/proxy?url=${encodeURIComponent(url)}` },
];

// --- Types ---
interface Secrets { pbAccessToken: string; }
interface LogEntry {
  id: string;
  message: string;
  type: 'info' | 'success' | 'error' | 'process' | 'warning' | 'network';
  timestamp: string;
}
interface SCTrack {
  id: number;
  title: string;
  permalink_url: string;
  artwork_url: string;
  user: { username: string; };
}
interface PlayerState {
  track: SCTrack | null;
  streamUrl: string | null;
  blobUrl: string | null;
  taggedBlob: Blob | null;
  fileName: string;
  // Only a deliberate play request (tapping a track, auto-advance) sets this.
  // Downloads load the track into the player without hijacking playback.
  autoPlay: boolean;
}
interface StreamPlaybackPrepared {
  playerTrack: SCTrack;
  fileName: string;
  // Signed HLS playlist link; goes stale per STREAM_URL_MAX_AGE_MS.
  streamUrl: string;
  preparedAt: number;
}
type PlayTrackOptions = {
  clearLogs?: boolean;
};
type FeedType = 'likes' | 'reposts';
const FEED_LABELS: Record<FeedType, string> = {
  likes: 'Liked Tracks',
  reposts: 'Reposted Tracks',
};
const isStandardFeedLabel = (label: string) =>
  Object.values(FEED_LABELS).includes(label as any);

// Normalize SoundCloud collection items into SCTracks. Likes wrap as
// { kind:'like', track }; reposts wrap as { type:'track-repost', track } or
// { type:'playlist-repost', playlist:{ tracks:[...] } }. Pagination responses
// have the same envelope, so the same extractor handles both pages.
const extractTracks = (collection: any[], type: FeedType): SCTrack[] => {
  if (!Array.isArray(collection)) return [];
  if (type === 'likes') {
    return collection.map((i: any) => i?.track).filter(Boolean);
  }
  return collection.flatMap((i: any) => {
    if (!i) return [];
    if (i.track) return [i.track]; // track-repost
    if (i.playlist?.tracks?.length) {
      // playlist-repost: SC inlines full track data for small playlists.
      // Filter out stub tracks (id-only objects without a title).
      return i.playlist.tracks.filter((t: any) => t?.title);
    }
    return [];
  });
};

// --- PWA / notifications ---
// Notifications are deliberately routed through the service worker rather than
// `new Notification()`: Android Chrome throws on the page-level constructor and
// only accepts ServiceWorkerRegistration.showNotification().
const NOTIFY_PREF_KEY = 'vibecloud-notify';

const isStandalone = () =>
  typeof window !== 'undefined' &&
  (window.matchMedia?.('(display-mode: standalone)').matches ||
    (window.navigator as any).standalone === true);

const isIOS = () =>
  typeof navigator !== 'undefined' &&
  (/iPad|iPhone|iPod/.test(navigator.userAgent) ||
    // iPadOS 13+ reports as Mac; the touch check disambiguates.
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1));

// iOS only exposes the Notification API to Home Screen installs (16.4+), so a
// browser-tab visit there genuinely cannot notify — say so rather than fail mute.
const notificationsSupported = () =>
  typeof window !== 'undefined' &&
  'Notification' in window &&
  'serviceWorker' in navigator;

const registerServiceWorker = async () => {
  if (typeof window === 'undefined' || !('serviceWorker' in navigator)) return;
  try {
    const reg = await navigator.serviceWorker.register('/sw.js', { scope: '/' });
    // Activate a waiting update straight away; the shell is network-first, so
    // there's no half-updated state to guard against.
    reg.addEventListener('updatefound', () => {
      const sw = reg.installing;
      sw?.addEventListener('statechange', () => {
        if (sw.state === 'installed' && navigator.serviceWorker.controller) {
          sw.postMessage({ type: 'SKIP_WAITING' });
        }
      });
    });
  } catch {
    // A failed registration costs the offline shell, not the app.
  }
};

const EMPTY_PLAYER_STATE: PlayerState = {
  track: null,
  streamUrl: null,
  blobUrl: null,
  taggedBlob: null,
  fileName: '',
  autoPlay: false,
};

// --- Feed cache ---
// Blob URLs and OAuth-signed stream data can't survive a reload, but the track
// list can. Cache the trimmed SCTrack shape (not the raw SC payload) so stale
// `track_authorization` values never come back from storage — a cached track
// always re-resolves and gets a fresh token before playback.
const FEED_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const FEED_CACHE_MAX_TRACKS = 600;
const feedCacheKey = (type: FeedType) => `vibecloud-feed-${type}`;

interface FeedCache {
  tracks: SCTrack[];
  nextHref: string | null;
  scrollTop: number;
  savedAt: number;
}

const trimTrack = (t: any): SCTrack => ({
  id: t.id,
  title: t.title,
  permalink_url: t.permalink_url,
  artwork_url: t.artwork_url || PLACEHOLDER_IMG,
  user: { username: t.user?.username || 'SoundCloud User' },
});

const readFeedCache = (type: FeedType): FeedCache | null => {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(feedCacheKey(type));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as FeedCache;
    if (!Array.isArray(parsed.tracks) || parsed.tracks.length === 0) return null;
    if (Date.now() - (parsed.savedAt || 0) > FEED_CACHE_TTL_MS) return null;
    return parsed;
  } catch {
    return null;
  }
};

const writeFeedCache = (
  type: FeedType,
  tracks: SCTrack[],
  nextHref: string | null,
  scrollTop: number,
) => {
  if (typeof window === 'undefined') return;
  try {
    const payload: FeedCache = {
      tracks: tracks.slice(0, FEED_CACHE_MAX_TRACKS).map(trimTrack),
      nextHref,
      scrollTop,
      savedAt: Date.now(),
    };
    window.localStorage.setItem(feedCacheKey(type), JSON.stringify(payload));
  } catch {
    // Quota exceeded or storage disabled — caching is a nicety, never fatal.
  }
};

const getStoredPlayerState = (): PlayerState => {
  if (typeof window === 'undefined') return EMPTY_PLAYER_STATE;

  const raw = window.localStorage.getItem('vibecloud-player');
  if (!raw) return EMPTY_PLAYER_STATE;

  try {
    const parsed = JSON.parse(raw) as Partial<PlayerState>;
    if (!parsed.track) return EMPTY_PLAYER_STATE;

    return {
      ...EMPTY_PLAYER_STATE,
      track: parsed.track,
      fileName: parsed.fileName ?? '',
      autoPlay: false,
    };
  } catch {
    return EMPTY_PLAYER_STATE;
  }
};

const App: React.FC = () => {
  const [url, setUrl] = useState('');
  const [isProcessing, setIsProcessing] = useState(false);
  const [isFetchingLikes, setIsFetchingLikes] = useState(false);
  const [showConfig, setShowConfig] = useState(false);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [likes, setLikes] = useState<SCTrack[]>([]);
  const [hasCloudKey, setHasCloudKey] = useState(false);
  const [activeTrackId, setActiveTrackId] = useState<number | null>(null);
  const [feedLabel, setFeedLabel] = useState('Liked Tracks');
  const [feedType, setFeedType] = useState<FeedType>(() => {
    if (typeof window === 'undefined') return 'likes';
    const saved = window.localStorage.getItem('vibecloud-feed-type');
    return saved === 'reposts' ? 'reposts' : 'likes';
  });
  const [consoleOpen, setConsoleOpen] = useState(false);
  const [theme, setTheme] = useState<'dark' | 'light'>(() => {
    if (typeof window === 'undefined') return 'dark';
    const savedTheme = window.localStorage.getItem('vibecloud-theme');
    return savedTheme === 'light' ? 'light' : 'dark';
  });

  // Infinite scroll
  const [nextHref, setNextHref] = useState<string | null>(null);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const feedScrollRef = useRef<HTMLDivElement>(null);
  const isLoadingMoreRef = useRef(false);
  // Scroll offset restored from cache, applied once the feed has rendered.
  const pendingScrollRestoreRef = useRef<number | null>(null);
  // Latest values for the debounced scroll writer, so it never re-registers.
  const likesRef = useRef<SCTrack[]>([]);
  const nextHrefRef = useRef<string | null>(null);
  const feedTypeRef = useRef<FeedType>('likes');

  // PWA / notifications
  const [notifyEnabled, setNotifyEnabled] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    return window.localStorage.getItem(NOTIFY_PREF_KEY) === '1';
  });
  const [notifyPermission, setNotifyPermission] = useState<NotificationPermission | 'unsupported'>(
    () => (notificationsSupported() ? Notification.permission : 'unsupported'),
  );
  const [installPrompt, setInstallPrompt] = useState<any>(null);
  // Read inside async download flows, where React state would be a stale closure.
  const notifyEnabledRef = useRef(notifyEnabled);

  // Multi-select
  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [bulkProgress, setBulkProgress] = useState<{ done: number; total: number } | null>(null);
  const cancelBulkRef = useRef(false);

  // Audio player state
  const [player, setPlayer] = useState<PlayerState>(() => getStoredPlayerState());
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [isRepeat, setIsRepeat] = useState(false);
  const [volume, setVolume] = useState<number>(() => {
    if (typeof window === 'undefined') return 0.8;
    const saved = window.localStorage.getItem('vibecloud-volume');
    return saved !== null ? parseFloat(saved) : 0.8;
  });
  const [isMuted, setIsMuted] = useState(false);
  const [prevVolume, setPrevVolume] = useState(0.8);
  const [isPrefetchingNext, setIsPrefetchingNext] = useState(false);
  const [isSkippingNext, setIsSkippingNext] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const prefetchedNextRef = useRef<StreamPlaybackPrepared | null>(null);
  const prefetchInFlightTrackIdRef = useRef<number | null>(null);
  const prefetchTriggeredForTrackIdRef = useRef<number | null>(null);
  const currentTrackIdRef = useRef<number | null>(null);
  // Where to pick up when a source is swapped mid-song (refreshed link, buffering
  // fallback). Tied to a track so it can never leak into a different song.
  const resumeAtRef = useRef<{ trackId: number; position: number } | null>(null);
  // Recovery attempts for the current track, so a persistently failing stream
  // can't loop between refresh and failure.
  const streamRecoveryRef = useRef({ trackId: null as number | null, refreshes: 0, mediaRecoveries: 0 });

  const [secrets, setSecrets] = useState<Secrets>(() => {
    const savedPb = localStorage.getItem('pb_access_token');
    return { pbAccessToken: savedPb !== null ? savedPb : DEFAULT_PB_ACCESS_TOKEN };
  });
  const [tempSecrets, setTempSecrets] = useState<Secrets>(secrets);
  const logEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setTempSecrets(secrets);
    localStorage.setItem('pb_access_token', secrets.pbAccessToken);
  }, [secrets]);

  useEffect(() => {
    void registerServiceWorker();
    // Fetch the streaming engine in the background so the first tap doesn't wait on it.
    const warmHls = window.setTimeout(() => { void loadHls().catch(() => {}); }, 1500);
    // Chrome fires this instead of showing its own install UI; stash it so the
    // Install button can replay it later from a user gesture.
    const onBeforeInstall = (e: Event) => {
      e.preventDefault();
      setInstallPrompt(e);
    };
    const onInstalled = () => {
      setInstallPrompt(null);
      addLog('VibeCloud installed', 'success');
    };
    window.addEventListener('beforeinstallprompt', onBeforeInstall);
    window.addEventListener('appinstalled', onInstalled);
    return () => {
      window.clearTimeout(warmHls);
      window.removeEventListener('beforeinstallprompt', onBeforeInstall);
      window.removeEventListener('appinstalled', onInstalled);
    };
  }, []);

  useEffect(() => {
    checkKeyStatus();
    // Restore the cached feed instead of refetching page 1 — this is what keeps
    // a deep scroll position usable after a reload.
    const cached = readFeedCache(feedType);
    if (cached) {
      setLikes(cached.tracks);
      setNextHref(cached.nextHref);
      setFeedLabel(FEED_LABELS[feedType]);
      pendingScrollRestoreRef.current = cached.scrollTop;
      addLog(`${cached.tracks.length} tracks from cache`, "info");
    } else {
      void fetchFeed(feedType);
    }
  }, []);

  useEffect(() => {
    if (typeof window !== 'undefined') {
      window.localStorage.setItem('vibecloud-feed-type', feedType);
    }
  }, [feedType]);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('vibecloud-theme', theme);
    const themeColorMeta = document.querySelector('meta[name="theme-color"]');
    if (themeColorMeta) {
      themeColorMeta.setAttribute('content', theme === 'light' ? '#F8F9FC' : '#13172A');
    }
  }, [theme]);

  useEffect(() => {
    currentTrackIdRef.current = player.track?.id ?? null;
  }, [player.track?.id]);

  useEffect(() => { notifyEnabledRef.current = notifyEnabled; }, [notifyEnabled]);
  useEffect(() => { likesRef.current = likes; }, [likes]);
  useEffect(() => { nextHrefRef.current = nextHref; }, [nextHref]);
  useEffect(() => { feedTypeRef.current = feedType; }, [feedType]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.volume = isMuted ? 0 : volume;
  }, [volume, isMuted]);

  useEffect(() => {
    if (typeof window !== 'undefined') {
      window.localStorage.setItem('vibecloud-volume', volume.toString());
    }
  }, [volume]);

  useEffect(() => {
    if (typeof window === 'undefined') return;

    if (!player.track) {
      window.localStorage.removeItem('vibecloud-player');
      return;
    }

    window.localStorage.setItem('vibecloud-player', JSON.stringify({
      track: player.track,
      fileName: player.fileName,
    }));
  }, [player.track, player.fileName]);

  // Audio player effects — auto-advance to next song
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    const onTime = () => setCurrentTime(audio.currentTime);
    const onDur = () => setDuration(audio.duration);
    const onEnd = () => {
      if (isRepeat) {
        audio.currentTime = 0;
        audio.play();
      } else {
        // Auto-advance to next track
        void playNextTrack('auto');
      }
    };
    audio.addEventListener('timeupdate', onTime);
    audio.addEventListener('loadedmetadata', onDur);
    // Streams can learn their full length after metadata arrives.
    audio.addEventListener('durationchange', onDur);
    audio.addEventListener('ended', onEnd);
    return () => {
      audio.removeEventListener('timeupdate', onTime);
      audio.removeEventListener('loadedmetadata', onDur);
      audio.removeEventListener('durationchange', onDur);
      audio.removeEventListener('ended', onEnd);
    };
  }, [isRepeat, likes, player.track]);

  // The single owner of the <audio> element's source. Blob URLs (a finished download,
  // or the buffering fallback) are assigned directly. Streams go through hls.js
  // wherever MediaSource exists, or straight to the element on browsers that play
  // HLS natively without it (older iPhones). Playback only starts if the source came
  // from an explicit play request, so a download never hijacks what's playing.
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    const { streamUrl, blobUrl, autoPlay, track } = player;
    if (!streamUrl && !blobUrl) return;

    const resume = resumeAtRef.current;
    resumeAtRef.current = null;
    const resumeAt = resume && resume.trackId === track?.id ? resume.position : null;

    let disposed = false;
    let hls: Hls | null = null;
    const start = () => {
      if (disposed || !autoPlay) return;
      audio.play().then(() => setIsPlaying(true)).catch(() => {});
    };
    const seekOnceLoaded = () => {
      if (!resumeAt) return;
      // Guarded: if the source changes before metadata arrives, this listener
      // would otherwise fire on the next song and seek it.
      audio.addEventListener('loadedmetadata', () => { if (!disposed) audio.currentTime = resumeAt; }, { once: true });
    };

    if (blobUrl) {
      audio.src = blobUrl;
      seekOnceLoaded();
      audio.load();
      start();
      return () => { disposed = true; };
    }

    // Silence the previous song right away rather than letting it run on while the
    // stream spins up.
    audio.removeAttribute('src');
    audio.load();

    void (async () => {
      let HlsCtor: typeof Hls | null = null;
      try { HlsCtor = await loadHls(); } catch { /* no engine: try native HLS below */ }
      if (disposed || !track) return;

      if (HlsCtor?.isSupported()) {
        const instance = new HlsCtor({ ...HLS_CONFIG, startPosition: resumeAt ?? -1 });
        hls = instance;
        let recovering = false;
        instance.on(HlsCtor.Events.MANIFEST_PARSED, start);
        instance.on(HlsCtor.Events.ERROR, (_event, data) => {
          if (disposed || recovering) return;
          // An expired signature never heals on retry, so don't wait out hls.js's
          // backoff (six retries, ~30 s of silence) before refreshing the link.
          const status = data.response?.code ?? 0;
          const expired = data.type === HlsCtor!.ErrorTypes.NETWORK_ERROR && [401, 403, 410].includes(status);
          if (!data.fatal && !expired) return;
          recovering = true; // one recovery at a time; retries keep erroring meanwhile
          void recoverStream(instance, HlsCtor!, data, track).finally(() => { recovering = false; });
        });
        instance.loadSource(streamUrl!);
        instance.attachMedia(audio);
      } else if (audio.canPlayType('application/vnd.apple.mpegurl')) {
        audio.src = streamUrl!;
        seekOnceLoaded();
        audio.addEventListener('error', () => {
          if (!disposed) void bufferInsteadOfStream(track, audio.currentTime);
        }, { once: true });
        audio.load();
        start();
      } else {
        void bufferInsteadOfStream(track, resumeAt ?? 0);
      }
    })();

    return () => {
      disposed = true;
      hls?.destroy();
    };
  }, [player.streamUrl, player.blobUrl]);

  // Infinite scroll — preload at 70%, and remember where we were.
  useEffect(() => {
    const el = feedScrollRef.current;
    if (!el) return;
    let scrollSaveTimer: number | undefined;
    const onScroll = () => {
      const scrollPercent = (el.scrollTop + el.clientHeight) / el.scrollHeight;
      if (scrollPercent >= 0.7 && nextHref && !isLoadingMoreRef.current && !isFetchingLikes) {
        loadMore();
      }
      window.clearTimeout(scrollSaveTimer);
      scrollSaveTimer = window.setTimeout(() => {
        if (likesRef.current.length > 0) {
          writeFeedCache(feedTypeRef.current, likesRef.current, nextHrefRef.current, el.scrollTop);
        }
      }, 250);
    };
    el.addEventListener('scroll', onScroll);
    return () => {
      window.clearTimeout(scrollSaveTimer);
      el.removeEventListener('scroll', onScroll);
    };
  }, [nextHref, isFetchingLikes]);

  // Apply a restored scroll offset once the cached rows are actually in the DOM.
  // Card heights settle over a few frames (artwork, fonts), so the container can
  // still be too short to seek into on the first frame — retry until it fits.
  useEffect(() => {
    const target = pendingScrollRestoreRef.current;
    if (target == null || target <= 0 || likes.length === 0) return;
    const el = feedScrollRef.current;
    if (!el) return;

    // Timer-based rather than requestAnimationFrame: rAF is throttled to zero in
    // background/offscreen tabs, which is exactly when a restore gets queued.
    let attempts = 0;
    let timer = 0;
    const attempt = () => {
      const maxScroll = el.scrollHeight - el.clientHeight;
      if (maxScroll >= target || attempts++ > 20) {
        el.scrollTop = Math.min(target, Math.max(maxScroll, 0));
        pendingScrollRestoreRef.current = null;
        return;
      }
      timer = window.setTimeout(attempt, 50);
    };
    attempt();
    return () => window.clearTimeout(timer);
  }, [likes.length]);

  // Persist whenever the loaded set changes (new page, feed switch, refresh),
  // preserving wherever the user currently is. Skipped while a restore is still
  // pending — at that moment scrollTop is 0 and writing it would erase the very
  // offset we're about to seek back to.
  useEffect(() => {
    if (likes.length === 0 || pendingScrollRestoreRef.current != null) return;
    writeFeedCache(feedType, likes, nextHref, feedScrollRef.current?.scrollTop ?? 0);
  }, [likes, nextHref, feedType]);

  const checkKeyStatus = async () => {
    // @ts-ignore
    if (window.aistudio && typeof window.aistudio.hasSelectedApiKey === 'function') {
      // @ts-ignore
      const hasKey = await window.aistudio.hasSelectedApiKey();
      setHasCloudKey(hasKey);
    }
  };

  const handleConnectCloud = async () => {
    // @ts-ignore
    if (window.aistudio && typeof window.aistudio.openSelectKey === 'function') {
      // @ts-ignore
      await window.aistudio.openSelectKey();
      setHasCloudKey(true);
    }
  };

  const handleSaveConfig = () => { setSecrets(tempSecrets); addLog("Config saved", "success"); };
  const handleReset = () => { setSecrets({ pbAccessToken: DEFAULT_PB_ACCESS_TOKEN }); addLog("Config reset", "info"); };

  const addLog = (message: string, type: LogEntry['type'] = 'info') => {
    setLogs(prev => [...prev, {
      id: Math.random().toString(36).substr(2, 9),
      message,
      type,
      timestamp: new Date().toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })
    }]);
  };

  const toggleTheme = () => setTheme(prev => prev === 'dark' ? 'light' : 'dark');

  const robustFetch = async (targetUrl: string): Promise<Response> => {
    for (let i = 0; i < PROXY_GATES.length; i++) {
      const proxyUrl = PROXY_GATES[i].fn(targetUrl);
      addLog(`Gate ${i + 1}...`, 'network');
      try {
        const res = await fetch(proxyUrl);
        if (res.ok) { addLog(`Gate ${i + 1}: OK`, 'network'); return res; }
        addLog(`Gate ${i + 1}: ${res.status}`, 'warning');
      } catch (e: any) {
        addLog(`Gate ${i + 1}: ${e.message}`, 'warning');
      }
    }
    throw new Error("All Proxy Gates Failed");
  };

  useEffect(() => { logEndRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [logs]);

  const buildFeedUrl = (type: FeedType): string => {
    const base = `${SC_API_BASE}/${type === 'likes'
      ? `users/${TARGET_USER_ID}/track_likes`
      : `stream/users/${TARGET_USER_ID}/reposts`}`;
    const offset = type === 'likes' ? '&offset=0' : '';
    return `${base}?client_id=${KNOWN_GOOD_CLIENT_ID}&limit=${LIKES_PER_PAGE}${offset}&linked_partitioning=1&app_version=1783486051&app_locale=en`;
  };

  const fetchFeed = async (type: FeedType) => {
    setIsFetchingLikes(true);
    addLog(`Syncing ${type === 'likes' ? 'likes' : 'reposts'}...`, "network");
    try {
      const res = await robustFetch(buildFeedUrl(type));
      const data = await res.json();
      const tracks = extractTracks(data.collection, type);
      setLikes(tracks);
      setNextHref(data.next_href || null);
      setFeedLabel(FEED_LABELS[type]);
      // A refresh replaces the list with page 1; don't strand the user mid-scroll.
      pendingScrollRestoreRef.current = null;
      feedScrollRef.current?.scrollTo({ top: 0 });
      addLog(`${tracks.length} tracks synced`, "success");
    } catch (error: any) {
      addLog(`Feed sync: ${error.message}`, "warning");
    } finally {
      setIsFetchingLikes(false);
    }
  };

  const switchFeed = (next: FeedType) => {
    if (next === feedType || isFetchingLikes) return;
    setFeedType(next);
    setLikes([]);
    setNextHref(null);
    setSelectedIds(new Set());

    // Each feed keeps its own cached page set and scroll offset, so flipping
    // tabs restores that feed where you left it rather than refetching page 1.
    const cached = readFeedCache(next);
    if (cached) {
      setLikes(cached.tracks);
      setNextHref(cached.nextHref);
      setFeedLabel(FEED_LABELS[next]);
      pendingScrollRestoreRef.current = cached.scrollTop;
      addLog(`${cached.tracks.length} tracks from cache`, "info");
      return;
    }

    feedScrollRef.current?.scrollTo({ top: 0, behavior: 'smooth' });
    void fetchFeed(next);
  };

  // Infinite scroll — load more. Snapshot feedType so a mid-flight switch
  // doesn't apply the wrong extractor to in-flight pagination data.
  const loadMore = async () => {
    if (!nextHref || isLoadingMoreRef.current) return;
    isLoadingMoreRef.current = true;
    setIsLoadingMore(true);
    const typeAtRequest = feedType;
    try {
      const res = await robustFetch(`${nextHref}&client_id=${KNOWN_GOOD_CLIENT_ID}`);
      const data = await res.json();
      // Bail if user switched feeds while this was in flight — extracted
      // tracks would belong to the old feed and confuse the visible list.
      if (typeAtRequest !== feedType) {
        addLog(`Load more: feed switched, discarding`, "info");
        return;
      }
      const newTracks = extractTracks(data.collection || [], typeAtRequest);
      setLikes(prev => [...prev, ...newTracks]);
      setNextHref(data.next_href || null);
      addLog(`+${newTracks.length} tracks loaded`, "info");
    } catch (e: any) {
      addLog(`Load more: ${e.message}`, "warning");
    } finally {
      isLoadingMoreRef.current = false;
      setIsLoadingMore(false);
    }
  };

  // --- Playlist Support ---
  const resolvePlaylist = async (playlistUrl: string) => {
    setIsFetchingLikes(true);
    setLogs([]);
    addLog("Resolving playlist...", "network");
    try {
      const resolveUrl = `${SC_API_BASE}/resolve?url=${encodeURIComponent(playlistUrl)}&client_id=${KNOWN_GOOD_CLIENT_ID}`;
      const res = await robustFetch(resolveUrl);
      if (!res.ok) throw new Error(`Resolve failed (${res.status})`);
      const data = await res.json();

      if (data.kind === 'playlist' || data.tracks) {
        const tracks: SCTrack[] = (data.tracks || []).filter((t: any) => t && t.title);
        setLikes(tracks);
        setNextHref(null);
        setFeedLabel(data.title || 'Playlist');
        setUrl('');
        addLog(`Playlist "${data.title}" loaded: ${tracks.length} tracks`, "success");
      } else if (data.kind === 'track') {
        await playTrackInline(data);
      } else {
        addLog("Unrecognized URL type", "warning");
      }
    } catch (error: any) {
      addLog(`Playlist resolve: ${error.message}`, "error");
    } finally {
      setIsFetchingLikes(false);
    }
  };

  // --- Direct SoundCloud Stream Engine ---
  const resolveTrackData = async (trackUrl: string): Promise<any> => {
    const resolveUrl = `${SC_API_BASE}/resolve?url=${encodeURIComponent(trackUrl)}&client_id=${KNOWN_GOOD_CLIENT_ID}`;
    addLog(`Resolving...`, "network");
    const res = await robustFetch(resolveUrl);
    if (!res.ok) throw new Error(`Resolve failed (${res.status})`);
    return res.json();
  };

  const resolveStreamUrl = async (trackData: any): Promise<string> => {
    const transcodings = trackData?.media?.transcodings || [];
    const hlsMp3 = transcodings.find((t: any) => t.format?.protocol === 'hls' && t.format?.mime_type === 'audio/mpeg');
    const hlsAac = transcodings.find((t: any) => t.format?.protocol === 'hls' && t.format?.mime_type?.includes('audio/mp4'));
    const transcoding = hlsMp3 || hlsAac;
    if (!transcoding) throw new Error("No downloadable stream");
    const trackAuth = trackData?.track_authorization || '';
    const streamApiUrl = `${transcoding.url}?client_id=${KNOWN_GOOD_CLIENT_ID}&track_authorization=${trackAuth}`;
    addLog(`Stream (${transcoding.preset})`, "network");
    const streamRes = await robustFetch(streamApiUrl);
    if (!streamRes.ok) throw new Error(`Stream failed (${streamRes.status})`);
    const streamData = await streamRes.json();
    if (!streamData.url) throw new Error("No stream URL");
    return streamData.url;
  };

  const fetchHlsAsBlob = async (playlistUrl: string): Promise<Blob> => {
    const manifestRes = await fetch(playlistUrl);
    if (!manifestRes.ok) throw new Error(`Manifest failed (${manifestRes.status})`);
    const manifest = await manifestRes.text();
    const lines = manifest.split('\n');

    const initLine = lines.find(l => l.includes('#EXT-X-MAP:'));
    let initUrl: string | null = null;
    if (initLine) {
      const match = initLine.match(/URI="([^"]+)"/);
      if (match) initUrl = match[1];
    }

    const segmentUrls = lines.filter(l => l.trim().startsWith('https://'));
    if (segmentUrls.length === 0) throw new Error("No segments in manifest");
    addLog(`${segmentUrls.length} segments`, "info");

    const batchSize = 6;
    const buffers: ArrayBuffer[] = [];

    // Every piece must arrive intact: stitching an error response into the audio
    // would produce a corrupt file that still looks like a successful download.
    const fetchPart = async (url: string) => {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`Audio chunk failed (${res.status})`);
      return res.arrayBuffer();
    };

    if (initUrl) buffers.push(await fetchPart(initUrl));

    for (let i = 0; i < segmentUrls.length; i += batchSize) {
      const batch = segmentUrls.slice(i, i + batchSize);
      buffers.push(...await Promise.all(batch.map(fetchPart)));
    }

    const isMp3 = playlistUrl.includes('.mp3') || manifest.includes('audio/mpeg');
    return new Blob(buffers, { type: isMp3 ? 'audio/mpeg' : 'audio/mp4' });
  };

  const toFileName = (title: string) => `${title.replace(/[^a-z0-9 ]/gi, '').trim() || 'Track'}.mp3`;

  const toPlayerTrack = (trackData: any, targetUrl: string): SCTrack => {
    const trackTitle = trackData?.title || "Extracted Audio";
    const artistName = trackData?.user?.username || "SoundCloud User";
    return {
      id: trackData?.id || Date.now(),
      title: trackTitle,
      permalink_url: targetUrl,
      artwork_url: trackData?.artwork_url || PLACEHOLDER_IMG,
      user: { username: artistName },
    };
  };

  // Fire a system notification only when the user has actually switched away —
  // if they're watching the console, the log line already told them.
  const notifyIfHidden = async (title: string, body: string, tag = 'vibecloud-download') => {
    if (!notifyEnabledRef.current) return;
    if (typeof document === 'undefined' || document.visibilityState !== 'hidden') return;
    if (!notificationsSupported() || Notification.permission !== 'granted') return;
    try {
      const reg = await navigator.serviceWorker.ready;
      // Ask the SW to raise it — the page-level constructor is unavailable on
      // Android Chrome, and this keeps one code path across platforms.
      reg.active?.postMessage({ type: 'NOTIFY', title, body, tag });
    } catch {
      // Notification failure must never take a completed download down with it.
    }
  };

  const enableNotifications = async () => {
    if (!notificationsSupported()) {
      addLog(
        isIOS() && !isStandalone()
          ? 'iOS: add VibeCloud to your Home Screen first, then enable notifications'
          : 'Notifications not supported on this browser',
        'warning',
      );
      return;
    }
    if (notifyEnabled) {
      setNotifyEnabled(false);
      window.localStorage.setItem(NOTIFY_PREF_KEY, '0');
      addLog('Download notifications off', 'info');
      return;
    }
    // Must be called from a user gesture, which is why this lives on a button.
    const result = await Notification.requestPermission();
    setNotifyPermission(result);
    if (result === 'granted') {
      setNotifyEnabled(true);
      window.localStorage.setItem(NOTIFY_PREF_KEY, '1');
      addLog('Download notifications on', 'success');
    } else {
      addLog(`Notification permission ${result}`, 'warning');
    }
  };

  const handleInstall = async () => {
    if (!installPrompt) return;
    installPrompt.prompt();
    const { outcome } = await installPrompt.userChoice;
    addLog(outcome === 'accepted' ? 'Installing VibeCloud...' : 'Install dismissed', 'info');
    setInstallPrompt(null);
  };

  const triggerBlobDownload = (blob: Blob, downloadName: string) => {
    const downloadUrl = window.URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = downloadUrl;
    link.setAttribute('download', downloadName);
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => window.URL.revokeObjectURL(downloadUrl), 1000);
  };

  const revokePlayerBlobIfAny = () => {
    if (player.blobUrl) window.URL.revokeObjectURL(player.blobUrl);
  };

  // Resolve just enough to start streaming: the track's transcodings (when the feed
  // copy lacks them) and a signed HLS playlist link. No audio is fetched here — the
  // player pulls chunks as it plays.
  const prepareStreamPlayback = async (track: Partial<SCTrack> | any, silent = false): Promise<StreamPlaybackPrepared> => {
    const targetUrl = track?.permalink_url;
    if (!targetUrl) throw new Error("Invalid URL");

    let fullTrackData: any = track;
    if (!track?.media?.transcodings) {
      fullTrackData = await resolveTrackData(targetUrl);
      if (!silent) addLog(`"${fullTrackData.title}" - ${fullTrackData.user?.username}`, "success");
    }

    const streamUrl = await resolveStreamUrl(fullTrackData);
    const playerTrack = toPlayerTrack(fullTrackData, targetUrl);
    return { playerTrack, streamUrl, fileName: toFileName(playerTrack.title), preparedAt: Date.now() };
  };

  const applyStreamPlayback = (prepared: StreamPlaybackPrepared) => {
    revokePlayerBlobIfAny();
    // A fresh play gets a fresh recovery budget, even when replaying the same song.
    Object.assign(streamRecoveryRef.current, { trackId: prepared.playerTrack.id, refreshes: 0, mediaRecoveries: 0 });
    setPlayer({
      track: prepared.playerTrack,
      streamUrl: prepared.streamUrl,
      blobUrl: null,
      taggedBlob: null,
      fileName: prepared.fileName,
      autoPlay: true,
    });
  };

  // Last resort when a stream can't play or be recovered: fetch the whole file up
  // front — the pre-streaming behaviour — and resume from the same spot.
  const bufferInsteadOfStream = async (track: SCTrack, position: number) => {
    addLog('Streaming failed, buffering full track...', 'warning');
    try {
      // A bare permalink forces a fresh resolve, so no expired token is reused.
      const fresh = await prepareStreamPlayback({ permalink_url: track.permalink_url }, true);
      const blob = await fetchHlsAsBlob(fresh.streamUrl);
      const blobUrl = window.URL.createObjectURL(blob);
      if (currentTrackIdRef.current !== track.id) {
        window.URL.revokeObjectURL(blobUrl); // user moved on while this was buffering
        return;
      }
      resumeAtRef.current = { trackId: track.id, position };
      setPlayer(prev => prev.track?.id === track.id
        ? { ...prev, streamUrl: null, blobUrl, autoPlay: true }
        : prev);
      addLog('Playing buffered copy', 'success');
    } catch (error: any) {
      addLog(`${error.message}`, 'error');
    }
  };

  const recoverStream = async (hls: Hls, HlsCtor: typeof Hls, data: ErrorData, track: SCTrack) => {
    const audio = audioRef.current;
    const position = audio?.currentTime ?? 0;
    const attempts = streamRecoveryRef.current;
    if (attempts.trackId !== track.id) {
      Object.assign(attempts, { trackId: track.id, refreshes: 0, mediaRecoveries: 0 });
    }

    // A decode hiccup: hls.js can usually rebuild the media pipeline in place.
    if (data.type === HlsCtor.ErrorTypes.MEDIA_ERROR && attempts.mediaRecoveries < 1) {
      attempts.mediaRecoveries++;
      hls.recoverMediaError();
      return;
    }

    // Signed links expired — typically resuming after a long pause. Get fresh ones
    // and carry on from the same spot.
    const status = data.response?.code ?? 0;
    if (data.type === HlsCtor.ErrorTypes.NETWORK_ERROR && [401, 403, 410].includes(status) && attempts.refreshes < 2) {
      attempts.refreshes++;
      addLog('Stream link expired, refreshing...', 'network');
      try {
        const fresh = await prepareStreamPlayback({ permalink_url: track.permalink_url }, true);
        if (currentTrackIdRef.current !== track.id) return;
        resumeAtRef.current = { trackId: track.id, position };
        setPlayer(prev => prev.track?.id === track.id
          ? { ...prev, streamUrl: fresh.streamUrl, blobUrl: null, autoPlay: true }
          : prev);
        return;
      } catch {
        // Couldn't refresh — fall through to buffering the whole file.
      }
    }

    await bufferInsteadOfStream(track, position);
  };

  const prepareTaggedBlobPlayback = async (track: Partial<SCTrack> | any) => {
    const targetUrl = track?.permalink_url;
    if (!targetUrl) throw new Error("Invalid URL");

    let fullTrackData: any = track;
    if (!track?.media?.transcodings) {
      fullTrackData = await resolveTrackData(targetUrl);
      addLog(`"${fullTrackData.title}" - ${fullTrackData.user?.username}`, "success");
    }

    const playlistUrl = await resolveStreamUrl(fullTrackData);
    addLog("Stream acquired", "success");
    addLog("Buffering...", "process");

    const audioBlob = await fetchHlsAsBlob(playlistUrl);
    const audioBuffer = await audioBlob.arrayBuffer();
    addLog(`${(audioBuffer.byteLength / 1024 / 1024).toFixed(1)} MB`, "info");

    const trackTitle = fullTrackData?.title || track?.title || "Extracted Audio";
    const artistName = fullTrackData?.user?.username || track?.user?.username || "SoundCloud User";
    const artUrl = fullTrackData?.artwork_url || track?.artwork_url;
    let artworkBuffer: ArrayBuffer | null = null;

    if (artUrl) {
      try {
        const artRes = await fetch(artUrl.replace('-large', '-t500x500'));
        if (artRes.ok) artworkBuffer = await artRes.arrayBuffer();
      } catch (e) {}
    }

    const fileName = toFileName(trackTitle);
    addLog("Tagging...", "process");
    const writer = new ID3Writer(audioBuffer);
    writer.setFrame('TIT2', trackTitle).setFrame('TPE1', [artistName]);
    if (artworkBuffer) {
      writer.setFrame('APIC', { type: 3, data: artworkBuffer, description: 'Cover', useUnicodeEncoding: false });
    }
    writer.addTag();
    const taggedBlob = writer.getBlob();
    const blobUrl = window.URL.createObjectURL(taggedBlob);
    const playerTrack = toPlayerTrack(fullTrackData, targetUrl);

    return { playerTrack, fileName, taggedBlob, blobUrl };
  };

  const getNextTrackFrom = (current: SCTrack | null): SCTrack | null => {
    if (!current || likes.length === 0) return null;
    const currentIdx = likes.findIndex(t => t.id === current.id);
    if (currentIdx === -1 || currentIdx >= likes.length - 1) return null;
    return likes[currentIdx + 1];
  };

  // Play a track inline (tap title/artwork → stream to player)
  const playTrackInline = async (track: Partial<SCTrack> | any, options: PlayTrackOptions = {}) => {
    if (isProcessing) return;
    setIsProcessing(true);
    if (options.clearLogs !== false) {
      setLogs([]);
    }
    if (track.id) setActiveTrackId(track.id);
    addLog(`Loading...`, "info");

    try {
      const streamPrepared = await prepareStreamPlayback(track);
      applyStreamPlayback(streamPrepared);
      addLog(`Streaming now`, "success");
    } catch (streamError: any) {
      addLog(`Stream failed, using fallback buffering...`, "warning");
      try {
        const fallbackPrepared = await prepareTaggedBlobPlayback(track);
        revokePlayerBlobIfAny();
        setPlayer({
          track: fallbackPrepared.playerTrack,
          streamUrl: null,
          blobUrl: fallbackPrepared.blobUrl,
          taggedBlob: fallbackPrepared.taggedBlob,
          fileName: fallbackPrepared.fileName,
          autoPlay: true,
        });
        addLog(`Now playing (fallback)`, "success");
      } catch (fallbackError: any) {
        addLog(`${fallbackError.message}`, "error");
      }
    } finally {
      setIsProcessing(false);
      setActiveTrackId(null);
    }
  };

  const prefetchNextTrack = async (currentTrackId: number, nextTrack: SCTrack) => {
    if (prefetchInFlightTrackIdRef.current === nextTrack.id) return;
    if (prefetchedNextRef.current?.playerTrack.id === nextTrack.id) return;

    prefetchInFlightTrackIdRef.current = nextTrack.id;
    setIsPrefetchingNext(true);
    try {
      const prepared = await prepareStreamPlayback(nextTrack, true);
      if (currentTrackIdRef.current !== currentTrackId) return;
      prefetchedNextRef.current = prepared;
      addLog(`Next ready`, "network");
    } catch (error: any) {
      if (currentTrackIdRef.current === currentTrackId) {
        addLog(`Next prefetch failed`, "warning");
      }
    } finally {
      if (prefetchInFlightTrackIdRef.current === nextTrack.id) {
        prefetchInFlightTrackIdRef.current = null;
      }
      if (currentTrackIdRef.current === currentTrackId) {
        setIsPrefetchingNext(false);
      }
    }
  };

  // Auto-advance: play next track in the list
  const playNextTrack = async (trigger: 'auto' | 'manual' = 'auto') => {
    if (trigger === 'manual') {
      if (isSkippingNext) return;
      setIsSkippingNext(true);
    }

    try {
      if (!player.track || likes.length === 0) {
        setIsPlaying(false);
        return;
      }

      const nextTrack = getNextTrackFrom(player.track);
      if (!nextTrack) {
        setIsPlaying(false);
        return;
      }

      const prefetched = prefetchedNextRef.current;
      if (prefetched?.playerTrack.id === nextTrack.id && Date.now() - prefetched.preparedAt < STREAM_URL_MAX_AGE_MS) {
        applyStreamPlayback(prefetched);
        prefetchedNextRef.current = null;
        prefetchTriggeredForTrackIdRef.current = null;
        addLog(`Next track instant`, "success");
        return;
      }

      await playTrackInline(nextTrack, { clearLogs: false });
    } finally {
      if (trigger === 'manual') {
        setIsSkippingNext(false);
      }
    }
  };

  useEffect(() => {
    if (isRepeat || !player.track || !duration || duration <= 0) return;
    const remaining = duration - currentTime;
    if (remaining > NEXT_TRACK_PREFETCH_SECONDS) return;
    if (prefetchTriggeredForTrackIdRef.current === player.track.id) return;

    const nextTrack = getNextTrackFrom(player.track);
    if (!nextTrack) return;

    prefetchTriggeredForTrackIdRef.current = player.track.id;
    void prefetchNextTrack(player.track.id, nextTrack);
  }, [currentTime, duration, isRepeat, likes, player.track]);

  useEffect(() => {
    prefetchedNextRef.current = null;
    prefetchInFlightTrackIdRef.current = null;
    prefetchTriggeredForTrackIdRef.current = null;
    setIsPrefetchingNext(false);
  }, [player.track?.id]);

  const runExtraction = async (track: Partial<SCTrack> | string, mode: 'push' | 'download') => {
    if (isProcessing) return;
    setIsProcessing(true);
    setLogs([]);
    if (typeof track !== 'string' && track.id) setActiveTrackId(track.id);
    addLog(`Starting...`, "info");

    try {
      const targetUrl = typeof track === 'string' ? track : track.permalink_url;
      if (!targetUrl) throw new Error("Invalid URL");

      let trackData: any = typeof track === 'string' ? null : track;
      let fullTrackData: any = null;

      try {
        fullTrackData = await resolveTrackData(targetUrl);
        addLog(`"${fullTrackData.title}" - ${fullTrackData.user?.username}`, "success");
        if (!trackData) trackData = fullTrackData;
      } catch (e: any) {
        addLog(`Resolve: ${e.message}`, "warning");
        if (!trackData) throw new Error("Cannot resolve track");
      }

      const resolvedData = fullTrackData || trackData;
      const playlistUrl = await resolveStreamUrl(resolvedData);
      addLog("Stream acquired", "success");

      const trackTitle = fullTrackData?.title || trackData?.title || "Extracted Audio";
      const artistName = fullTrackData?.user?.username || trackData?.user?.username || "SoundCloud User";
      const artUrl = fullTrackData?.artwork_url || trackData?.artwork_url;

      addLog("Downloading...", "process");
      const [audioBlob, artRes] = await Promise.all([
        fetchHlsAsBlob(playlistUrl),
        artUrl ? fetch(artUrl.replace('-large', '-t500x500')).catch(() => null) : Promise.resolve(null)
      ]);

      const audioBuffer = await audioBlob.arrayBuffer();
      addLog(`${(audioBuffer.byteLength / 1024 / 1024).toFixed(1)} MB`, "info");

      let artworkBuffer: ArrayBuffer | null = null;
      if (artRes?.ok) {
        artworkBuffer = await artRes.arrayBuffer();
      }

      const fileName = `${trackTitle.replace(/[^a-z0-9 ]/gi, '').trim() || 'Track'}.mp3`;
      addLog("Tagging...", "process");
      const writer = new ID3Writer(audioBuffer);
      writer.setFrame('TIT2', trackTitle).setFrame('TPE1', [artistName]);
      if (artworkBuffer) {
        writer.setFrame('APIC', { type: 3, data: artworkBuffer, description: 'Cover', useUnicodeEncoding: false });
      }
      writer.addTag();
      const taggedBlob = writer.getBlob();
      const playerTrack: SCTrack = {
        id: fullTrackData?.id || trackData?.id || Date.now(),
        title: trackTitle,
        permalink_url: targetUrl,
        artwork_url: artUrl || PLACEHOLDER_IMG,
        user: { username: artistName },
      };
      // Cue the finished track in the player (so it's one tap from playing, with
      // no second download) but never start it — the user asked to download, not
      // to listen. Skip entirely while something else is actively playing.
      const audio = audioRef.current;
      const hasActiveSource = Boolean(player.streamUrl || player.blobUrl);
      const isActivelyPlaying = Boolean(audio && !audio.paused && hasActiveSource);

      if (!isActivelyPlaying) {
        if (player.blobUrl) window.URL.revokeObjectURL(player.blobUrl);
        const blobUrl = window.URL.createObjectURL(taggedBlob);
        setPlayer({ track: playerTrack, streamUrl: null, blobUrl, taggedBlob, fileName, autoPlay: false });
      }

      if (mode === 'download') {
        triggerBlobDownload(taggedBlob, fileName);
        addLog(`Saved ${fileName}`, "success");
        void notifyIfHidden('Download complete', `${trackTitle} — ${artistName}`, `dl-${playerTrack.id}`);
      } else {
        // Push mode — the Pushbullet token lives server-side (Worker secret). An
        // optional per-user token from Settings is passed through as an override.
        addLog("Pushing to Pushbullet...", "process");
        const pbToken = secrets.pbAccessToken || undefined;
        const pbJson = (path: string, payload: Record<string, unknown>) =>
          fetch(`${CORS_PROXY_BASE}/api/pb/${path}`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ...payload, token: pbToken }),
          });

        try {
          const uploadReq = await pbJson('upload-request', { file_name: fileName, file_type: 'audio/mpeg' });

          if (uploadReq.status === 401 || uploadReq.status === 403) {
            throw new Error("Pushbullet token invalid or expired. Go to Settings and enter a valid token from pushbullet.com/#settings/account");
          }
          if (!uploadReq.ok) throw new Error(`Pushbullet error (${uploadReq.status})`);

          const uploadSlot = await uploadReq.json();
          const formData = new FormData();
          formData.append('file', taggedBlob, fileName);
          await fetch(uploadSlot.upload_url, { method: 'POST', body: formData });

          let vibeSummary = `Fresh drop: ${trackTitle}`;
          try {
            const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
            const geminiResponse = await ai.models.generateContent({
              model: 'gemini-3-flash-preview',
              contents: `Track: "${trackTitle}" by "${artistName}". One sentence vibe check with emojis.`,
            });
            vibeSummary = geminiResponse.text || vibeSummary;
          } catch (e) {}

          await pbJson('push', { file_name: fileName, file_type: 'audio/mpeg', file_url: uploadSlot.file_url, body: vibeSummary });
          addLog("Pushed!", "success");
          void notifyIfHidden('Pushed to your devices', `${trackTitle} — ${artistName}`, `push-${playerTrack.id}`);
        } catch (pushErr: any) {
          addLog(pushErr.message, "error");
          triggerBlobDownload(taggedBlob, fileName);
          addLog(`Saved locally as fallback: ${fileName}`, "warning");
        }
      }
    } catch (error: any) {
      addLog(`${error.message}`, "error");
    } finally {
      setIsProcessing(false);
      setActiveTrackId(null);
    }
  };

  // --- Multi-select ---
  const toggleSelectMode = () => {
    setSelectMode(prev => {
      if (prev) setSelectedIds(new Set());
      return !prev;
    });
  };

  const toggleSelected = (trackId: number) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(trackId)) next.delete(trackId);
      else next.add(trackId);
      return next;
    });
  };

  const selectAllVisible = () => setSelectedIds(new Set(likes.map(t => t.id)));
  const clearSelection = () => setSelectedIds(new Set());

  // Download the selected tracks one at a time. Sequential on purpose: each
  // track pulls dozens of HLS segments, and browsers throttle (or silently drop)
  // a burst of simultaneous downloads.
  const downloadSelected = async () => {
    if (isProcessing || selectedIds.size === 0) return;
    const queue = likes.filter(t => selectedIds.has(t.id));
    if (queue.length === 0) return;

    cancelBulkRef.current = false;
    setIsProcessing(true);
    setLogs([]);
    setBulkProgress({ done: 0, total: queue.length });
    addLog(`Batch: ${queue.length} track${queue.length === 1 ? '' : 's'}`, "info");

    let succeeded = 0;
    let failed = 0;

    for (let i = 0; i < queue.length; i++) {
      if (cancelBulkRef.current) {
        addLog(`Cancelled after ${i} of ${queue.length}`, "warning");
        break;
      }
      const track = queue[i];
      setActiveTrackId(track.id);
      addLog(`[${i + 1}/${queue.length}] ${track.title}`, "process");
      try {
        const prepared = await prepareTaggedBlobPlayback(track);
        // This path only saves the file — release the playback URL it created.
        window.URL.revokeObjectURL(prepared.blobUrl);
        triggerBlobDownload(prepared.taggedBlob, prepared.fileName);
        addLog(`Saved ${prepared.fileName}`, "success");
        succeeded++;
        setSelectedIds(prev => {
          const next = new Set(prev);
          next.delete(track.id);
          return next;
        });
      } catch (e: any) {
        failed++;
        addLog(`${track.title}: ${e.message}`, "error");
      }
      setBulkProgress({ done: i + 1, total: queue.length });
    }

    addLog(`Batch done — ${succeeded} saved${failed ? `, ${failed} failed` : ''}`, failed ? "warning" : "success");
    // One summary rather than N notifications — a batch of 20 shouldn't bury
    // the notification shade.
    if (succeeded > 0) {
      void notifyIfHidden(
        `${succeeded} download${succeeded === 1 ? '' : 's'} complete`,
        failed ? `${failed} failed — check the console` : 'All tracks saved',
        'vibecloud-batch',
      );
    }
    setBulkProgress(null);
    setActiveTrackId(null);
    setIsProcessing(false);
  };

  // --- URL handler (playlist vs track) ---
  const handleUrlSubmit = async () => {
    if (!url) return;
    const isPlaylist = url.includes('/sets/');
    if (isPlaylist) {
      await resolvePlaylist(url);
    } else {
      await runExtraction(url, 'download');
    }
  };

  // --- Player controls ---
  const togglePlay = () => {
    const audio = audioRef.current;
    if (!audio || (!player.streamUrl && !player.blobUrl)) return;
    if (isPlaying) { audio.pause(); setIsPlaying(false); }
    else { audio.play(); setIsPlaying(true); }
  };

  const handleSeek = (e: React.ChangeEvent<HTMLInputElement>) => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.currentTime = parseFloat(e.target.value);
    setCurrentTime(audio.currentTime);
  };

  const handleVolumeChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = parseFloat(e.target.value);
    setVolume(val);
    if (val > 0) {
      setIsMuted(false);
    }
  };

  const toggleMute = () => {
    if (isMuted) {
      setIsMuted(false);
    } else {
      setPrevVolume(volume);
      setIsMuted(true);
    }
  };

  const downloadCurrent = async () => {
    if (player.blobUrl && player.fileName) {
      const link = document.createElement('a');
      link.href = player.blobUrl;
      link.setAttribute('download', player.fileName);
      document.body.appendChild(link);
      link.click();
      link.remove();
      return;
    }

    if (player.track?.permalink_url) {
      await runExtraction(player.track, 'download');
    }
  };

  const formatTime = (s: number) => {
    if (!s || isNaN(s)) return '0:00';
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    return `${m}:${sec.toString().padStart(2, '0')}`;
  };

  // Memoized log color function
  const logColor = useCallback((type: LogEntry['type']) => {
    switch(type) {
      case 'error': return 'text-red-400';
      case 'success': return 'text-emerald-400';
      case 'warning': return 'text-amber-400';
      case 'process': return 'text-peach';
      case 'network': return 'text-muted';
      default: return 'theme-text-soft';
    }
  }, []);

  // --- Foldable Console Component (iOS glassmorphism when open) ---
  const ConsolePanel = ({ compact = false }: { compact?: boolean }) => (
    <div className="console-glass overflow-hidden" style={{ borderRadius: 16 }}>
      {/* Toggle header — always visible */}
      <button
        onClick={() => setConsoleOpen(!consoleOpen)}
        className="w-full px-3 py-2 flex items-center justify-between cursor-pointer select-none"
        style={{ background: 'transparent' }}
      >
        <span className={`${compact ? 'text-[8px]' : 'text-[10px]'} font-mono text-muted uppercase tracking-widest flex items-center gap-2`}>
          <div className={`w-1.5 h-1.5 rounded-full ${isProcessing ? 'bg-peach pulse-dot' : 'bg-muted/30'}`} />
          engine
          {logs.length > 0 && <span className="text-muted/50 ml-1">{logs.length}</span>}
        </span>
        {consoleOpen
          ? <ChevronUp className="w-3.5 h-3.5 text-muted/60" />
          : <ChevronDown className="w-3.5 h-3.5 text-muted/60" />
        }
      </button>

      {/* Foldable body */}
      {consoleOpen && (
        <div
          className={`${compact ? 'p-2' : 'p-3'} overflow-y-auto font-mono vibe-scroll border-t console-divider`}
          style={{ maxHeight: compact ? 220 : '60vh', paddingBottom: compact ? 12 : 20 }}
        >
          {logs.length === 0 && <span className="text-muted/30 text-[9px]">Waiting...</span>}
          {logs.map(log => (
            <div key={log.id} className={`flex gap-2 ${compact ? 'text-[9px] leading-relaxed' : 'text-[12px] leading-relaxed'}`}>
              <span className="text-muted/30 shrink-0">{log.timestamp}</span>
              <span className={`${logColor(log.type)} whitespace-pre-wrap break-words`}>
                {log.message}
              </span>
            </div>
          ))}
          <div ref={logEndRef} />
        </div>
      )}
    </div>
  );

  const hasPlayerSource = Boolean(player.streamUrl || player.blobUrl);
  const hasTrack = Boolean(player.track);

  return (
    <div className="min-h-screen relative z-10 flex flex-col" style={{ fontFamily: "'Poppins', sans-serif", paddingBottom: 88 }}>
      {/* Hidden audio element */}
      {/* No src prop: the source effect owns it, since hls.js attaches its own. */}
      <audio ref={audioRef} />

      {/* ========== HEADER ========== */}
      <header className="px-5 pt-5 pb-3 lg:px-10 lg:pt-7 fade-up">
        <div className="max-w-7xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-full brand-mark flex items-center justify-center">
              <TreePalm className="w-5 h-5 text-peach" />
            </div>
            <div>
              <h1 className="text-lg font-bold tracking-tight theme-text-primary leading-none">VibeCloud</h1>
              <p className="text-[10px] text-muted font-medium mt-1 max-w-[520px] leading-relaxed">
                SC Music Downloader, a &quot;Micah Berkley&quot; (
                <a
                  href="https://micahberkley.com"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="underline decoration-muted/60 underline-offset-2 hover:text-peach"
                >
                  micahberkley.com
                </a>
                ) project. Use for your videos or projects. Respect the rights of the artist.
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={toggleTheme}
              className={`circle-btn theme-toggle-gold ${theme === 'light' ? 'active' : ''}`}
              title={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}
              aria-label="Toggle theme"
              style={{ width: 40, height: 40 }}
            >
              {theme === 'dark' ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
            </button>
            <button onClick={() => setShowConfig(!showConfig)} className={`circle-btn ${showConfig ? 'active' : ''}`} style={{ width: 44, height: 44 }}>
              <Settings className="w-[18px] h-[18px]" />
            </button>
          </div>
        </div>
      </header>

      {/* ========== CONFIG ========== */}
      {showConfig && (
        <div className="px-5 lg:px-10 mb-3 slide-down">
          <div className="max-w-7xl mx-auto glass-card p-5">
            <label className="text-[10px] font-semibold text-muted uppercase tracking-widest mb-2 block">Pushbullet Token</label>
            <input type="password" value={tempSecrets.pbAccessToken}
              onChange={(e) => setTempSecrets({...tempSecrets, pbAccessToken: e.target.value})}
              className="vibe-input font-mono text-xs mb-4" style={{ borderRadius: 12 }} />
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex gap-3 flex-wrap">
                <button onClick={handleConnectCloud} className="pill-btn text-muted">
                  <ShieldCheck className="w-3.5 h-3.5" /> {hasCloudKey ? 'AI Connected' : 'Connect AI'}
                </button>
                <button onClick={handleReset} className="pill-btn text-muted"><Undo className="w-3.5 h-3.5" /> Reset</button>
              </div>
              <button onClick={handleSaveConfig} className="pill-btn accent"><Save className="w-3.5 h-3.5" /> Save</button>
            </div>

            {/* App / notification settings */}
            <div className="mt-5 pt-4 app-settings-divider">
              <label className="text-[10px] font-semibold text-muted uppercase tracking-widest mb-3 block">App</label>
              <div className="flex flex-wrap items-center gap-3">
                <button
                  onClick={enableNotifications}
                  className={`pill-btn ${notifyEnabled ? 'accent' : 'text-muted'}`}
                  aria-pressed={notifyEnabled}
                >
                  {notifyEnabled
                    ? <><Bell className="w-3.5 h-3.5" /> Notifications On</>
                    : <><BellOff className="w-3.5 h-3.5" /> Notify on Download</>}
                </button>

                {installPrompt && (
                  <button onClick={handleInstall} className="pill-btn accent">
                    <Smartphone className="w-3.5 h-3.5" /> Install App
                  </button>
                )}
                {!installPrompt && isStandalone() && (
                  <span className="text-[10px] text-muted uppercase tracking-widest">Installed</span>
                )}
              </div>

              <p className="text-[11px] text-muted mt-3 leading-relaxed">
                {notifyPermission === 'denied'
                  ? 'Notifications are blocked for this site — re-allow them in your browser settings, then try again.'
                  : isIOS() && !isStandalone()
                    ? 'On iPhone/iPad, add VibeCloud to your Home Screen first — iOS only allows notifications for installed apps.'
                    : 'Alerts you when a download finishes while you’re in another app. Note that phones pause background tabs, so a download may not finish until you return.'}
              </p>
            </div>
          </div>
        </div>
      )}

      {/* ========== MAIN ========== */}
      <main className="flex-1 px-5 lg:px-10 pb-4">
        <div className="max-w-7xl mx-auto">

          {/* URL Input */}
          <div className="mb-4 fade-up fade-up-1">
            <div className="flex gap-3 items-center">
              <input type="text" placeholder="Paste SoundCloud track or playlist URL..."
                value={url} onChange={(e) => setUrl(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleUrlSubmit()}
                className="vibe-input flex-1" />
              <button onClick={handleUrlSubmit} disabled={!url || isProcessing}
                className={`circle-btn ${url ? 'active' : ''}`} style={{ width: 48, height: 48 }}>
                {isProcessing && !activeTrackId ? <Loader2 className="w-5 h-5 animate-spin text-peach" /> : <Download className="w-5 h-5" />}
              </button>
            </div>
          </div>

          {/* Console — slim full-width collapsible bar above the feed.
              Collapsed by default, so it no longer reserves a wide empty column. */}
          <div className="mb-4 fade-up fade-up-2">
            <div className="hidden lg:flex items-center gap-2 mb-2">
              <Zap className="w-4 h-4 text-peach" />
              <h2 className="text-sm font-semibold theme-text-strong">Console</h2>
              {isProcessing && <div className="w-1.5 h-1.5 rounded-full bg-peach pulse-dot" />}
            </div>
            <ConsolePanel compact />
          </div>

          {/* ===== FEED (full width, responsive columns) ===== */}
          <div className="fade-up fade-up-3">
              <div className="flex items-center justify-between mb-3 gap-2">
                <div className="flex items-center gap-2 min-w-0">
                  <Music2 className="w-4 h-4 text-peach shrink-0" />
                  {isStandardFeedLabel(feedLabel) ? (
                    <div className="feed-pills flex items-center gap-1.5" role="tablist">
                      <button
                        onClick={() => switchFeed('likes')}
                        disabled={isFetchingLikes}
                        className={`pill-btn feed-pill ${feedType === 'likes' ? 'feed-pill-active' : ''}`}
                        role="tab"
                        aria-selected={feedType === 'likes'}
                        aria-pressed={feedType === 'likes'}
                      >
                        Liked
                      </button>
                      <button
                        onClick={() => switchFeed('reposts')}
                        disabled={isFetchingLikes}
                        className={`pill-btn feed-pill ${feedType === 'reposts' ? 'feed-pill-active' : ''}`}
                        role="tab"
                        aria-selected={feedType === 'reposts'}
                        aria-pressed={feedType === 'reposts'}
                      >
                        Reposted
                      </button>
                    </div>
                  ) : (
                    <h2 className="text-sm font-semibold theme-text-strong truncate">{feedLabel}</h2>
                  )}
                  {likes.length > 0 && (
                    <span className="text-[10px] font-medium text-muted count-chip px-2.5 py-0.5 rounded-full shrink-0">{likes.length}</span>
                  )}
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  <button
                    onClick={toggleSelectMode}
                    disabled={isProcessing}
                    className={`circle-btn ${selectMode ? 'active' : ''}`}
                    style={{ width: 34, height: 34 }}
                    title={selectMode ? 'Exit multi-select' : 'Select multiple tracks'}
                    aria-pressed={selectMode}
                  >
                    <CheckSquare className={`w-4 h-4 ${selectMode ? 'text-peach' : 'text-muted'}`} />
                  </button>
                  <button
                    onClick={() => fetchFeed(feedType)}
                    disabled={isFetchingLikes}
                    className="circle-btn" style={{ width: 34, height: 34 }}
                    title="Refresh feed"
                  >
                    {isFetchingLikes ? <Loader2 className="w-4 h-4 animate-spin text-peach" /> : <RefreshCcw className="w-4 h-4 text-muted" />}
                  </button>
                </div>
              </div>

              {/* Bulk action bar — only while multi-select is on */}
              {selectMode && (
                <div className="select-bar mb-3">
                  <span className="text-[11px] font-semibold theme-text-strong shrink-0">
                    {selectedIds.size} selected
                  </span>
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <button onClick={selectAllVisible} disabled={isProcessing || likes.length === 0}
                      className="pill-btn select-bar-btn">
                      All {likes.length}
                    </button>
                    <button onClick={clearSelection} disabled={isProcessing || selectedIds.size === 0}
                      className="pill-btn select-bar-btn">
                      Clear
                    </button>
                  </div>
                  <div className="flex-1" />
                  {bulkProgress ? (
                    <>
                      <span className="text-[11px] font-mono text-muted shrink-0">
                        {bulkProgress.done}/{bulkProgress.total}
                      </span>
                      <button onClick={() => { cancelBulkRef.current = true; }}
                        className="pill-btn select-bar-btn">
                        Cancel
                      </button>
                    </>
                  ) : (
                    <button onClick={downloadSelected}
                      disabled={isProcessing || selectedIds.size === 0}
                      className="pill-btn accent select-bar-btn">
                      <Download className="w-3.5 h-3.5" />
                      Download {selectedIds.size || ''}
                    </button>
                  )}
                </div>
              )}

              {likes.length === 0 && !isFetchingLikes && (
                <div className="glass-card p-8 text-center">
                  <ListMusic className="w-8 h-8 text-muted/40 mx-auto mb-3" />
                  <p className="text-muted text-sm">No tracks</p>
                  <p className="text-muted/60 text-xs mt-1">Paste a track or playlist URL above</p>
                </div>
              )}

              <div ref={feedScrollRef} className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4 gap-3 vibe-scroll" style={{ maxHeight: 'calc(100vh - 280px)', overflowY: 'auto', paddingRight: 4 }}>
                {likes.map(track => {
                  const isCurrentlyPlaying = player.track?.id === track.id;
                  const isSelected = selectedIds.has(track.id);
                  // In select mode the whole card toggles selection instead of playing.
                  const onCardTap = () => selectMode ? toggleSelected(track.id) : playTrackInline(track);
                  return (
                    <div key={track.id}
                      className={`track-card group ${isCurrentlyPlaying ? 'ring-1 ring-peach/30' : ''} ${isSelected ? 'track-card-selected' : ''}`}>
                      <div className="flex gap-3 mb-3 items-center">
                        {selectMode && (
                          <button onClick={() => toggleSelected(track.id)} disabled={isProcessing}
                            className="shrink-0" aria-pressed={isSelected}
                            title={isSelected ? 'Deselect' : 'Select'}>
                            {isSelected
                              ? <CheckSquare className="w-5 h-5 text-peach" />
                              : <Square className="w-5 h-5 text-muted" />}
                          </button>
                        )}
                        {/* Tap artwork → play (or select) */}
                        <button onClick={onCardTap} disabled={isProcessing} className="flex-shrink-0">
                          <img src={track.artwork_url || PLACEHOLDER_IMG}
                            className={`w-12 h-12 rounded-xl object-cover bg-navy-deep cursor-pointer hover:opacity-80 transition-opacity ${isCurrentlyPlaying ? 'ring-2 ring-peach/50' : ''}`} alt="" />
                        </button>
                        {/* Tap title → play (or select) */}
                        <button onClick={onCardTap} disabled={isProcessing}
                          className="flex-1 min-w-0 flex flex-col justify-center text-left cursor-pointer">
                          <div className={`font-semibold text-[13px] truncate transition-colors leading-tight ${isCurrentlyPlaying ? 'text-peach' : 'theme-text-primary group-hover:text-peach'}`}>{track.title}</div>
                          <div className="text-[11px] text-muted truncate mt-0.5">{track.user.username}</div>
                        </button>
                      </div>
                      <div className="flex gap-2 items-center">
                        <button onClick={() => runExtraction(track, 'download')} disabled={isProcessing}
                          className="pill-btn flex-1 justify-center theme-text-strong">
                          {isProcessing && activeTrackId === track.id
                            ? <><Loader2 className="w-3.5 h-3.5 animate-spin text-peach" /> Working</>
                            : <><Download className="w-3.5 h-3.5" /> Download</>}
                        </button>
                        <button onClick={() => runExtraction(track, 'push')} disabled={isProcessing}
                          className="pill-btn accent flex-1 justify-center">
                          <Send className="w-3.5 h-3.5" /> Push
                        </button>
                        {/* Tiny link button → SoundCloud */}
                        <a href={track.permalink_url} target="_blank" rel="noopener noreferrer"
                          className="link-btn" title="Open on SoundCloud">
                          <ExternalLink className="w-2.5 h-2.5" />
                        </a>
                      </div>
                    </div>
                  );
                })}
                {/* Loading more indicator */}
                {isLoadingMore && (
                  <div className="col-span-full flex justify-center py-4">
                    <Loader2 className="w-5 h-5 animate-spin text-peach" />
                  </div>
                )}
              </div>
            </div>
        </div>
      </main>

      {/* ========== STICKY PLAYER FOOTER ========== */}
      <div className="fixed bottom-0 left-0 right-0 z-50 player-shell">
        <div className="max-w-7xl mx-auto px-5 lg:px-10">
          {/* Seek bar — full width thin line */}
          <div className="pt-2 -mx-5 lg:-mx-10 px-5 lg:px-10">
            <input type="range" min={0} max={duration || 0} step={0.1}
              value={currentTime} onChange={handleSeek}
              disabled={!hasPlayerSource}
              className="w-full h-1 appearance-none cursor-pointer rounded-full"
              style={{
                background: `linear-gradient(to right, var(--seek-fill) ${(currentTime / (duration || 1)) * 100}%, var(--seek-empty) ${(currentTime / (duration || 1)) * 100}%)`,
                accentColor: 'var(--seek-fill)',
              }} />
          </div>

          <div className="flex items-center gap-2 py-3">
            {/* Track info — left. The only region allowed to give up width: the
                title truncates before any control can be squeezed. */}
            <div className="flex items-center gap-3 flex-1 min-w-0">
              {hasTrack ? (
                <img
                  src={player.track?.artwork_url || PLACEHOLDER_IMG}
                  className="w-10 h-10 rounded-lg object-cover flex-shrink-0"
                  alt=""
                />
              ) : (
                <div className="w-10 h-10 rounded-lg brand-mark flex items-center justify-center flex-shrink-0">
                  <TreePalm className="w-4 h-4 text-peach" />
                </div>
              )}
              <div className="min-w-0">
                <div className="text-[13px] font-semibold theme-text-primary truncate">{player.track?.title || 'No track loaded'}</div>
                <div className="text-[10px] text-muted truncate">{player.track?.user.username || 'Pick a track to start playback'}</div>
              </div>
            </div>

            {/* Controls — centered */}
            <div className="flex items-center gap-1 justify-center shrink-0">
              <button onClick={() => setIsRepeat(!isRepeat)}
                disabled={!hasPlayerSource}
                className={`circle-btn ${isRepeat ? 'active' : ''}`}
                style={{ width: 36, height: 36 }}>
                <Repeat className="w-4 h-4" />
              </button>

              <button onClick={togglePlay}
                disabled={!hasPlayerSource}
                className="circle-btn active"
                style={{ width: 44, height: 44 }}>
                {isPlaying
                  ? <Pause className="w-5 h-5 text-peach" />
                  : <Play className="w-5 h-5 text-peach" style={{ marginLeft: 2 }} />}
              </button>

              <button
                onClick={() => { void playNextTrack('manual'); }}
                disabled={!hasTrack || isSkippingNext}
                className={`circle-btn ${(isSkippingNext || isPrefetchingNext) ? 'skip-loading' : ''}`}
                style={{ width: 36, height: 36 }}
                title={isPrefetchingNext ? "Preparing next track..." : "Skip to next"}
              >
                {(isSkippingNext || isPrefetchingNext)
                  ? <Loader2 className="w-4 h-4 animate-spin text-peach" />
                  : <SkipForward className="w-4 h-4" />}
              </button>
            </div>

            {/* Time + Volume + Download — right. Never min-w-0 here: squeezed below
                its content with justify-end, this cluster overflows *leftward* over
                the transport controls (the skip/mute overlap on phones). Content-sized
                on phones so the title gets the slack; flex-1 on sm+ to keep the
                transport centered. */}
            <div className="flex items-center gap-3 flex-none sm:flex-1 justify-end">
              <div className="hidden sm:flex text-[10px] font-mono text-muted gap-1">
                <span>{formatTime(currentTime)}</span>
                <span>/</span>
                <span>{formatTime(duration)}</span>
              </div>

              {/* Volume Slider */}
              <div className="flex items-center gap-2">
                <button
                  onClick={toggleMute}
                  className="circle-btn shrink-0"
                  style={{ width: 36, height: 36 }}
                  title={isMuted ? "Unmute" : "Mute"}
                >
                  {isMuted || volume === 0 ? (
                    <VolumeX className="w-4 h-4 text-muted" />
                  ) : (
                    <Volume2 className="w-4 h-4 text-peach" />
                  )}
                </button>
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.01}
                  value={isMuted ? 0 : volume}
                  onChange={handleVolumeChange}
                  // Phones set volume with the hardware buttons; the slider only
                  // earns its 64px on sm+ screens.
                  className="hidden sm:block w-16 h-1 appearance-none cursor-pointer rounded-full"
                  style={{
                    background: `linear-gradient(to right, var(--seek-fill) ${(isMuted ? 0 : volume) * 100}%, var(--seek-empty) ${(isMuted ? 0 : volume) * 100}%)`,
                    accentColor: 'var(--seek-fill)',
                  }}
                />
              </div>

              <button onClick={downloadCurrent}
                disabled={!hasTrack}
                className="circle-btn"
                style={{ width: 36, height: 36 }}>
                <Download className="w-4 h-4" />
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

// HMR-safe root: when Vite re-imports this module, reuse the existing
// React root instead of calling createRoot on the same container twice
// (which logs the "container has already been passed to createRoot" warning
// and can leave the old React tree in place, masking state updates).
const container = document.getElementById('root')!;
const containerWithRoot = container as HTMLElement & { __appRoot?: ReturnType<typeof createRoot> };
const root = containerWithRoot.__appRoot ?? createRoot(container);
containerWithRoot.__appRoot = root;
root.render(<App />);

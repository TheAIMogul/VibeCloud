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
} from 'lucide-react';
import { GoogleGenAI } from "@google/genai";
// @ts-ignore
import ID3Writer from 'https://esm.sh/browser-id3-writer@4.4.0';

// --- Constants ---
const KNOWN_GOOD_CLIENT_ID = 'kJ5grOxsTDFFctYx2ZQdQ7viN7EmoTKn';
const TARGET_USER_ID = '5402929';
const DEFAULT_PB_ACCESS_TOKEN = 'o.KHQsxVhDhVxOGSX1ut8V4tOlDfjXeHSD';
const SC_API_BASE = 'https://api-v2.soundcloud.com';
const PLACEHOLDER_IMG = 'https://placehold.co/400x400/13172A/787E91?text=%E2%99%AA';
const LIKES_PER_PAGE = 24;
const NEXT_TRACK_PREFETCH_SECONDS = 15;

// --- Networking Layer ---
const PROXY_GATES = [
  { name: 'CORSProxy.io', fn: (url: string) => `https://corsproxy.io/?${encodeURIComponent(url)}` },
  { name: 'AllOrigins', fn: (url: string) => `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}` }
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
}
interface StreamPlaybackPrepared {
  playerTrack: SCTrack;
  fileName: string;
  streamUrl: string;
}
type PlayTrackOptions = {
  clearLogs?: boolean;
};

const EMPTY_PLAYER_STATE: PlayerState = {
  track: null,
  streamUrl: null,
  blobUrl: null,
  taggedBlob: null,
  fileName: '',
};

const getStoredPlayerState = (): PlayerState => {
  if (typeof window === 'undefined') return EMPTY_PLAYER_STATE;

  const raw = window.localStorage.getItem('vibecloud-player');
  if (!raw) return EMPTY_PLAYER_STATE;

  try {
    const parsed = JSON.parse(raw) as Partial<PlayerState>;
    const streamUrl = typeof parsed.streamUrl === 'string' && parsed.streamUrl.length > 0 ? parsed.streamUrl : null;
    if (!parsed.track || !streamUrl) return EMPTY_PLAYER_STATE;

    return {
      ...EMPTY_PLAYER_STATE,
      track: parsed.track,
      streamUrl,
      fileName: parsed.fileName ?? '',
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

  // Audio player state
  const [player, setPlayer] = useState<PlayerState>(() => getStoredPlayerState());
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [isRepeat, setIsRepeat] = useState(false);
  const [isPrefetchingNext, setIsPrefetchingNext] = useState(false);
  const [isSkippingNext, setIsSkippingNext] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const prefetchedNextRef = useRef<StreamPlaybackPrepared | null>(null);
  const prefetchInFlightTrackIdRef = useRef<number | null>(null);
  const prefetchTriggeredForTrackIdRef = useRef<number | null>(null);
  const currentTrackIdRef = useRef<number | null>(null);

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

  useEffect(() => { checkKeyStatus(); fetchLikes(); }, []);

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

  useEffect(() => {
    if (typeof window === 'undefined') return;

    if (!player.track || !player.streamUrl) {
      window.localStorage.removeItem('vibecloud-player');
      return;
    }

    window.localStorage.setItem('vibecloud-player', JSON.stringify({
      track: player.track,
      streamUrl: player.streamUrl,
      fileName: player.fileName,
    }));
  }, [player.track, player.streamUrl, player.fileName]);

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
    audio.addEventListener('ended', onEnd);
    return () => {
      audio.removeEventListener('timeupdate', onTime);
      audio.removeEventListener('loadedmetadata', onDur);
      audio.removeEventListener('ended', onEnd);
    };
  }, [isRepeat, likes, player.track]);

  // Auto-play when blobUrl changes
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio || (!player.streamUrl && !player.blobUrl)) return;
    audio.load();
    audio.play().then(() => setIsPlaying(true)).catch(() => {});
  }, [player.streamUrl, player.blobUrl]);

  // Infinite scroll — preload at 70%
  useEffect(() => {
    const el = feedScrollRef.current;
    if (!el) return;
    const onScroll = () => {
      const scrollPercent = (el.scrollTop + el.clientHeight) / el.scrollHeight;
      if (scrollPercent >= 0.7 && nextHref && !isLoadingMoreRef.current && !isFetchingLikes) {
        loadMore();
      }
    };
    el.addEventListener('scroll', onScroll);
    return () => el.removeEventListener('scroll', onScroll);
  }, [nextHref, isFetchingLikes]);

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

  const fetchLikes = async () => {
    setIsFetchingLikes(true);
    addLog("Syncing feed...", "network");
    try {
      const likesUrl = `${SC_API_BASE}/users/${TARGET_USER_ID}/track_likes?client_id=${KNOWN_GOOD_CLIENT_ID}&limit=${LIKES_PER_PAGE}&offset=0&linked_partitioning=1&app_version=1770807155&app_locale=en`;
      const likesRes = await robustFetch(likesUrl);
      const likesData = await likesRes.json();
      const tracks = likesData.collection.map((item: any) => item.track).filter(Boolean);
      setLikes(tracks);
      setNextHref(likesData.next_href || null);
      setFeedLabel('Liked Tracks');
      addLog(`${tracks.length} tracks synced`, "success");
    } catch (error: any) {
      addLog(`Feed sync: ${error.message}`, "warning");
    } finally {
      setIsFetchingLikes(false);
    }
  };

  // Infinite scroll — load more
  const loadMore = async () => {
    if (!nextHref || isLoadingMoreRef.current) return;
    isLoadingMoreRef.current = true;
    setIsLoadingMore(true);
    try {
      const res = await robustFetch(`${nextHref}&client_id=${KNOWN_GOOD_CLIENT_ID}`);
      const data = await res.json();
      const newTracks = (data.collection || []).map((item: any) => item.track || item).filter(Boolean);
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

  const getProgressiveStreamUrl = async (trackData: any): Promise<string> => {
    const transcodings = trackData?.media?.transcodings || [];
    const progressive = transcodings.find((t: any) => t.format?.protocol === 'progressive' && t.format?.mime_type?.includes('audio/mpeg'));
    const hlsMp3 = transcodings.find((t: any) => t.format?.protocol === 'hls' && t.format?.mime_type?.includes('audio/mpeg'));
    const anyProg = transcodings.find((t: any) => t.format?.protocol === 'progressive');
    const transcoding = progressive || hlsMp3 || anyProg;
    if (!transcoding) throw new Error("No downloadable stream");
    const streamApiUrl = `${transcoding.url}?client_id=${KNOWN_GOOD_CLIENT_ID}`;
    addLog(`Stream (${transcoding.preset})`, "network");
    const streamRes = await robustFetch(streamApiUrl);
    if (!streamRes.ok) throw new Error(`Stream failed (${streamRes.status})`);
    const streamData = await streamRes.json();
    if (!streamData.url) throw new Error("No stream URL");
    return streamData.url;
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

  const revokePlayerBlobIfAny = () => {
    if (player.blobUrl) window.URL.revokeObjectURL(player.blobUrl);
  };

  const prepareStreamPlayback = async (track: Partial<SCTrack> | any, silent = false): Promise<StreamPlaybackPrepared> => {
    const targetUrl = track?.permalink_url;
    if (!targetUrl) throw new Error("Invalid URL");

    let fullTrackData: any = track;
    if (!track?.media?.transcodings) {
      fullTrackData = await resolveTrackData(targetUrl);
      if (!silent) addLog(`"${fullTrackData.title}" - ${fullTrackData.user?.username}`, "success");
    }

    const streamUrl = await getProgressiveStreamUrl(fullTrackData);
    const playerTrack = toPlayerTrack(fullTrackData, targetUrl);
    return {
      playerTrack,
      streamUrl,
      fileName: toFileName(playerTrack.title),
    };
  };

  const applyStreamPlayback = (prepared: StreamPlaybackPrepared) => {
    revokePlayerBlobIfAny();
    setPlayer({
      track: prepared.playerTrack,
      streamUrl: prepared.streamUrl,
      blobUrl: null,
      taggedBlob: null,
      fileName: prepared.fileName,
    });
  };

  const prepareTaggedBlobPlayback = async (track: Partial<SCTrack> | any) => {
    const targetUrl = track?.permalink_url;
    if (!targetUrl) throw new Error("Invalid URL");

    let fullTrackData: any = track;
    if (!track?.media?.transcodings) {
      fullTrackData = await resolveTrackData(targetUrl);
      addLog(`"${fullTrackData.title}" - ${fullTrackData.user?.username}`, "success");
    }

    const streamUrl = await getProgressiveStreamUrl(fullTrackData);
    addLog("Stream acquired", "success");
    addLog("Buffering fallback...", "process");

    const fileRes = await fetch(streamUrl);
    if (!fileRes.ok) throw new Error(`Download failed (${fileRes.status})`);
    const audioBuffer = await fileRes.arrayBuffer();
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

      if (prefetchedNextRef.current?.playerTrack.id === nextTrack.id) {
        applyStreamPlayback(prefetchedNextRef.current);
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

      const streamUrl = await getProgressiveStreamUrl(fullTrackData || trackData);
      addLog("Stream acquired", "success");

      const trackTitle = fullTrackData?.title || trackData?.title || "Extracted Audio";
      const artistName = fullTrackData?.user?.username || trackData?.user?.username || "SoundCloud User";
      const artUrl = fullTrackData?.artwork_url || trackData?.artwork_url;

      // Parallel fetch: audio + artwork simultaneously
      addLog("Downloading...", "process");
      const [fileRes, artRes] = await Promise.all([
        fetch(streamUrl),
        artUrl ? fetch(artUrl.replace('-large', '-t500x500')).catch(() => null) : Promise.resolve(null)
      ]);

      if (!fileRes.ok) throw new Error(`Download failed (${fileRes.status})`);
      const audioBuffer = await fileRes.arrayBuffer();
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
      const audio = audioRef.current;
      const hasActiveSource = Boolean(player.streamUrl || player.blobUrl);
      const isActivelyPlaying = Boolean(audio && !audio.paused && hasActiveSource);
      const canUpdatePlayerWithoutInterrupt = !isActivelyPlaying;

      if (canUpdatePlayerWithoutInterrupt) {
        if (player.blobUrl) window.URL.revokeObjectURL(player.blobUrl);
        const blobUrl = window.URL.createObjectURL(taggedBlob);
        setPlayer({ track: playerTrack, streamUrl: null, blobUrl, taggedBlob, fileName });
      }

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

      if (mode === 'download') {
        triggerBlobDownload(taggedBlob, fileName);
        addLog(`Saved ${fileName}`, "success");
      } else {
        // Push mode
        addLog("Pushing to Pushbullet...", "process");
        const pbHeaders = { 'Access-Token': secrets.pbAccessToken, 'Content-Type': 'application/json' };

        try {
          const uploadReq = await fetch('https://api.pushbullet.com/v2/upload-request', {
            method: 'POST', headers: pbHeaders,
            body: JSON.stringify({ file_name: fileName, file_type: 'audio/mpeg' })
          });

          if (uploadReq.status === 401 || uploadReq.status === 403) {
            throw new Error("Pushbullet token invalid or expired. Go to Settings and enter a valid token from pushbullet.com/#settings/account");
          }
          if (!uploadReq.ok) throw new Error(`Pushbullet error (${uploadReq.status})`);

          const uploadSlot = await uploadReq.json();
          const formData = new FormData();
          Object.entries(uploadSlot.data).forEach(([key, value]) => formData.append(key, value as string));
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

          await fetch('https://api.pushbullet.com/v2/pushes', {
            method: 'POST', headers: pbHeaders,
            body: JSON.stringify({ type: 'file', file_name: fileName, file_type: 'audio/mpeg', file_url: uploadSlot.file_url, body: vibeSummary })
          });
          addLog("Pushed!", "success");
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
      <audio ref={audioRef} src={player.streamUrl || player.blobUrl || undefined} />

      {/* ========== HEADER ========== */}
      <header className="px-5 pt-5 pb-3 lg:px-10 lg:pt-7 fade-up">
        <div className="max-w-6xl mx-auto flex items-center justify-between">
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
          <div className="max-w-6xl mx-auto glass-card p-5">
            <label className="text-[10px] font-semibold text-muted uppercase tracking-widest mb-2 block">Pushbullet Token</label>
            <input type="password" value={tempSecrets.pbAccessToken}
              onChange={(e) => setTempSecrets({...tempSecrets, pbAccessToken: e.target.value})}
              className="vibe-input font-mono text-xs mb-4" style={{ borderRadius: 12 }} />
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex gap-3">
                <button onClick={handleConnectCloud} className="pill-btn text-muted">
                  <ShieldCheck className="w-3.5 h-3.5" /> {hasCloudKey ? 'AI Connected' : 'Connect AI'}
                </button>
                <button onClick={handleReset} className="pill-btn text-muted"><Undo className="w-3.5 h-3.5" /> Reset</button>
              </div>
              <button onClick={handleSaveConfig} className="pill-btn accent"><Save className="w-3.5 h-3.5" /> Save</button>
            </div>
          </div>
        </div>
      )}

      {/* ========== MAIN ========== */}
      <main className="flex-1 px-5 lg:px-10 pb-4">
        <div className="max-w-6xl mx-auto">

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

          {/* Mobile console — compact, foldable, right under URL */}
          <div className="lg:hidden mb-4 fade-up fade-up-2">
            <ConsolePanel compact />
          </div>

          {/* Desktop: Console LEFT, Feed RIGHT */}
          <div className="grid grid-cols-1 lg:grid-cols-5 gap-5">

            {/* ===== CONSOLE (Left on desktop, foldable) ===== */}
            <div className="hidden lg:block lg:col-span-2 fade-up fade-up-2">
              <div className="flex items-center gap-2 mb-3">
                <Zap className="w-4 h-4 text-peach" />
                <h2 className="text-sm font-semibold theme-text-strong">Console</h2>
                {isProcessing && <div className="w-1.5 h-1.5 rounded-full bg-peach pulse-dot" />}
              </div>
              <ConsolePanel />
            </div>

            {/* ===== FEED (Right on desktop) ===== */}
            <div className="lg:col-span-3 fade-up fade-up-3">
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-2">
                  <Music2 className="w-4 h-4 text-peach" />
                  <h2 className="text-sm font-semibold theme-text-strong">{feedLabel}</h2>
                  {likes.length > 0 && (
                    <span className="text-[10px] font-medium text-muted count-chip px-2.5 py-0.5 rounded-full">{likes.length}</span>
                  )}
                </div>
                <button onClick={() => fetchLikes()} disabled={isFetchingLikes}
                  className="circle-btn" style={{ width: 34, height: 34 }}>
                  {isFetchingLikes ? <Loader2 className="w-4 h-4 animate-spin text-peach" /> : <RefreshCcw className="w-4 h-4 text-muted" />}
                </button>
              </div>

              {likes.length === 0 && !isFetchingLikes && (
                <div className="glass-card p-8 text-center">
                  <ListMusic className="w-8 h-8 text-muted/40 mx-auto mb-3" />
                  <p className="text-muted text-sm">No tracks</p>
                  <p className="text-muted/60 text-xs mt-1">Paste a track or playlist URL above</p>
                </div>
              )}

              <div ref={feedScrollRef} className="grid grid-cols-1 sm:grid-cols-2 gap-3 vibe-scroll" style={{ maxHeight: 'calc(100vh - 300px)', overflowY: 'auto', paddingRight: 4 }}>
                {likes.map(track => {
                  const isCurrentlyPlaying = player.track?.id === track.id;
                  return (
                    <div key={track.id} className={`track-card group ${isCurrentlyPlaying ? 'ring-1 ring-peach/30' : ''}`}>
                      <div className="flex gap-3 mb-3">
                        {/* Tap artwork → play */}
                        <button onClick={() => playTrackInline(track)} disabled={isProcessing} className="flex-shrink-0">
                          <img src={track.artwork_url || PLACEHOLDER_IMG}
                            className={`w-12 h-12 rounded-xl object-cover bg-navy-deep cursor-pointer hover:opacity-80 transition-opacity ${isCurrentlyPlaying ? 'ring-2 ring-peach/50' : ''}`} alt="" />
                        </button>
                        {/* Tap title → play */}
                        <button onClick={() => playTrackInline(track)} disabled={isProcessing}
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
        </div>
      </main>

      {/* ========== STICKY PLAYER FOOTER ========== */}
      <div className="fixed bottom-0 left-0 right-0 z-50 player-shell">
        <div className="max-w-6xl mx-auto px-5 lg:px-10">
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

          <div className="flex items-center py-3">
            {/* Track info — left */}
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
            <div className="flex items-center gap-1 justify-center">
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

            {/* Time + Download — right */}
            <div className="flex items-center gap-3 flex-1 justify-end min-w-0">
              <div className="hidden sm:flex text-[10px] font-mono text-muted gap-1">
                <span>{formatTime(currentTime)}</span>
                <span>/</span>
                <span>{formatTime(duration)}</span>
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

const root = createRoot(document.getElementById('root')!);
root.render(<App />);

import { getApp, getApps, initializeApp } from 'firebase/app';
import {
  GoogleAuthProvider,
  User,
  getAuth,
  onAuthStateChanged,
  signInWithPopup,
  signOut,
} from 'firebase/auth';
import firebaseConfig from '../../firebase-applet-config.json';
import { isAndroidNativeApp, openExternalBrowserUrl } from '../utils/nativeDownload';

export const SCOPES = [
  'https://www.googleapis.com/auth/youtube.upload',
  'https://www.googleapis.com/auth/youtube.force-ssl',
] as const;

export interface YouTubeChannelInfo {
  id: string;
  title: string;
  thumbnailUrl?: string;
}

export interface YouTubePlaylistItem {
  id: string;
  title: string;
}

export type YouTubePrivacyStatus = 'private' | 'unlisted' | 'public';

export interface YouTubeUploadOptions {
  blob: Blob;
  mimeType: string;
  title: string;
  description: string;
  tags: string[];
  privacyStatus: YouTubePrivacyStatus;
  publishAtIso?: string;
  playlistId?: string;
  pinnedComment?: string;
  onProgress?: (percent: number, stageText: string) => void;
}

export interface YouTubeUploadResult {
  videoId: string;
  videoUrl: string;
  commentPosted: boolean;
  commentNote?: string;
  playlistAdded: boolean;
}

export interface YouTubeSessionState {
  connected: boolean;
  token: string | null;
  channel: YouTubeChannelInfo | null;
  email: string | null;
}

export interface YouTubeOAuthStatus {
  configured: boolean;
  hasClientId: boolean;
  callbackUrl: string;
  requiresBackendUrl?: boolean;
  isNativeWebView?: boolean;
}

export type YouTubeNativeMode = 'web-firebase' | 'native-backend-oauth' | 'standalone-apk';

const ENV_MAP = (import.meta as unknown as { env?: Record<string, string | undefined> }).env ?? {};
const BUILD_API_BASE = (ENV_MAP.VITE_API_BASE_URL || '').trim().replace(/\/$/, '');

function hasRemoteBackend(): boolean {
  return /^https?:\/\/(?!localhost\b|127\.0\.0\.1\b)/i.test(BUILD_API_BASE);
}

export function getYouTubeNativeMode(): YouTubeNativeMode {
  if (!isAndroidNativeApp()) return 'web-firebase';
  return hasRemoteBackend() ? 'native-backend-oauth' : 'standalone-apk';
}

const app = getApps().length > 0 ? getApp() : initializeApp(firebaseConfig);
const auth = getAuth(app);

function buildGoogleProvider(): GoogleAuthProvider {
  const provider = new GoogleAuthProvider();
  for (const scope of SCOPES) {
    provider.addScope(scope);
  }
  provider.setCustomParameters({ prompt: 'select_account' });
  return provider;
}

// Strictly in-memory OAuth access token cache (never stored in localStorage/sessionStorage)
let isSigningIn = false;
let memoryAccessToken: string | null = null;
let memoryTokenExpiresAt = 0;
let memoryChannel: YouTubeChannelInfo | null = null;
let memoryEmail: string | null = null;

type SessionListener = (session: YouTubeSessionState) => void;
const sessionListeners = new Set<SessionListener>();
let authListenerUnsubscribe: (() => void) | null = null;

function clearMemorySession(): void {
  memoryAccessToken = null;
  memoryTokenExpiresAt = 0;
  memoryChannel = null;
  memoryEmail = null;
}

function notifySessionListeners(): void {
  const snapshot = getCachedYouTubeSession();
  sessionListeners.forEach((listener) => {
    try {
      listener(snapshot);
    } catch {
      // ignore subscriber errors
    }
  });
}

function ensureAuthStateSubscription(): void {
  if (authListenerUnsubscribe) return;
  authListenerUnsubscribe = onAuthStateChanged(auth, (user: User | null) => {
    if (user) {
      memoryEmail = user.email || memoryEmail;
      if (memoryAccessToken && Date.now() < memoryTokenExpiresAt - 15_000) {
        notifySessionListeners();
      } else if (!isSigningIn) {
        memoryAccessToken = null;
        memoryTokenExpiresAt = 0;
        memoryChannel = null;
        notifySessionListeners();
      }
    } else {
      if (getYouTubeNativeMode() === 'web-firebase') {
        clearMemorySession();
      }
      notifySessionListeners();
    }
  });
}

export function initYouTubeAuthListener(onChange: SessionListener): () => void {
  ensureAuthStateSubscription();
  sessionListeners.add(onChange);
  onChange(getCachedYouTubeSession());
  return () => {
    sessionListeners.delete(onChange);
  };
}

export function getCachedYouTubeSession(): YouTubeSessionState {
  if (!memoryAccessToken || Date.now() >= memoryTokenExpiresAt - 15_000) {
    return { connected: false, token: null, channel: null, email: memoryEmail };
  }
  return {
    connected: true,
    token: memoryAccessToken,
    channel: memoryChannel,
    email: memoryEmail,
  };
}

export async function disconnectYouTubeSession(): Promise<void> {
  clearMemorySession();
  notifySessionListeners();
  try {
    await signOut(auth);
  } catch {
    // ignore signOut errors after local cache is cleared
  }
}

export async function checkYouTubeOAuthStatus(): Promise<YouTubeOAuthStatus> {
  const mode = getYouTubeNativeMode();
  const hasConfig = Boolean(firebaseConfig?.apiKey && firebaseConfig?.authDomain);
  return {
    configured: mode === 'native-backend-oauth' ? true : hasConfig,
    hasClientId: Boolean(firebaseConfig?.oAuthClientId),
    callbackUrl: '',
    requiresBackendUrl: mode === 'standalone-apk',
    isNativeWebView: isAndroidNativeApp(),
  };
}

function decodeBase64UrlJson<T>(raw: string): T | null {
  try {
    const normalized = raw.replace(/-/g, '+').replace(/_/g, '/');
    const pad = normalized.length % 4 === 0 ? '' : '='.repeat(4 - (normalized.length % 4));
    const binary = atob(normalized + pad);
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
    const text = new TextDecoder().decode(bytes);
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

async function connectViaNativeExternalBrowser(): Promise<{
  accessToken: string;
  channel: YouTubeChannelInfo | null;
  email: string | null;
}> {
  const res = await fetch(
    `${BUILD_API_BASE}/api/youtube/auth-url?appRedirect=${encodeURIComponent('com.shortsquiz.studio0://youtube-auth')}`
  );
  const data = (await res.json()) as { url?: string; error?: string };
  if (!res.ok || !data.url) {
    throw new Error(data.error || 'تعذر تجهيز رابط تسجيل الدخول الخارجي من الخادم.');
  }

  return new Promise((resolve, reject) => {
    const w = window as unknown as {
      __onAndroidYouTubeAuth?: (deepLinkUrl: string) => void;
    };

    const timeoutId = window.setTimeout(() => {
      delete w.__onAndroidYouTubeAuth;
      reject(new Error('انتهت مهلة انتظار العودة من متصفح Google. حاول مرة أخرى.'));
    }, 180_000);

    w.__onAndroidYouTubeAuth = async (deepLinkUrl: string) => {
      window.clearTimeout(timeoutId);
      delete w.__onAndroidYouTubeAuth;
      try {
        const hashIdx = deepLinkUrl.indexOf('#');
        const fragment = hashIdx >= 0 ? deepLinkUrl.slice(hashIdx + 1) : '';
        const params = new URLSearchParams(fragment);
        const payloadRaw = params.get('payload') || '';
        const payload = decodeBase64UrlJson<{
          type?: string;
          accessToken?: string;
          expiresIn?: number;
          channel?: YouTubeChannelInfo | null;
          error?: string;
        }>(payloadRaw);

        if (!payload || payload.type !== 'YOUTUBE_OAUTH_SUCCESS' || !payload.accessToken) {
          reject(new Error(payload?.error || 'لم تكتمل مصادقة Google بنجاح.'));
          return;
        }

        memoryAccessToken = payload.accessToken;
        memoryTokenExpiresAt = Date.now() + (payload.expiresIn ?? 3400) * 1000;
        memoryEmail = null;
        memoryChannel = payload.channel ?? (await fetchYouTubeChannel(payload.accessToken));
        notifySessionListeners();
        resolve({
          accessToken: payload.accessToken,
          channel: memoryChannel,
          email: memoryEmail,
        });
      } catch (err) {
        reject(err instanceof Error ? err : new Error('تعذر قراءة بيانات المصادقة من الرابط.'));
      }
    };

    const opened = openExternalBrowserUrl(data.url!);
    if (!opened) {
      window.clearTimeout(timeoutId);
      delete w.__onAndroidYouTubeAuth;
      reject(new Error('تعذر فتح متصفح النظام لإتمام تسجيل الدخول.'));
    }
  });
}

function mapFirebaseAuthError(err: unknown): string {
  const code =
    typeof err === 'object' && err !== null && 'code' in err
      ? String((err as { code?: unknown }).code || '')
      : '';

  if (code === 'auth/popup-blocked') {
    return 'قام المتصفح بحظر نافذة تسجيل الدخول. اسمح بالنوافذ المنبثقة لهذا الموقع ثم أعد المحاولة.';
  }
  if (code === 'auth/popup-closed-by-user' || code === 'auth/cancelled-popup-request') {
    return 'تم إغلاق نافذة تسجيل الدخول قبل إتمام اختيار الحساب.';
  }
  if (code === 'auth/unauthorized-domain' || code === 'auth/operation-not-supported-in-this-environment') {
    return isAndroidNativeApp()
      ? 'Google تمنع نوافذ Firebase المنبثقة داخل تطبيقات APK المحلية. صدّر الفيديو (يُحفظ تلقائياً في المعرض) واضغط «إرسال لتطبيق YouTube» للنشر فوراً.'
      : 'النطاق الحالي غير مصرح به في Firebase Auth أو لا يدعم النوافذ المنبثقة.';
  }
  if (code === 'auth/network-request-failed') {
    return 'تعذر الاتصال بخوادم Google. تحقق من اتصال الإنترنت وأعد المحاولة.';
  }
  if (err instanceof Error && err.message.trim()) {
    return err.message;
  }
  return 'تعذر إتمام تسجيل الدخول بحساب Google.';
}

export async function connectYouTubeWithPopup(): Promise<{
  accessToken: string;
  channel: YouTubeChannelInfo | null;
  email: string | null;
}> {
  const mode = getYouTubeNativeMode();

  if (mode === 'standalone-apk') {
    throw new Error(
      'تسجيل الدخول عبر Firebase غير مدعوم داخل تطبيق APK المستقل لأن Google تحظر نوافذ OAuth داخل عارض التطبيقات المحلي (localhost). يمكنك تصدير الفيديو الآن وسيُحفظ في المعرض مع زر «إرسال لتطبيق YouTube» المباشر.'
    );
  }

  if (mode === 'native-backend-oauth') {
    isSigningIn = true;
    try {
      return await connectViaNativeExternalBrowser();
    } finally {
      isSigningIn = false;
    }
  }

  ensureAuthStateSubscription();
  isSigningIn = true;
  try {
    const provider = buildGoogleProvider();
    const result = await signInWithPopup(auth, provider);
    const credential = GoogleAuthProvider.credentialFromResult(result);
    if (!credential?.accessToken) {
      throw new Error('لم يتم الحصول على رمز صلاحية YouTube من Google. يرجى الموافقة على صلاحيات يوتيوب والمحاولة مرة أخرى.');
    }

    memoryAccessToken = credential.accessToken;
    memoryTokenExpiresAt = Date.now() + 3400 * 1000;
    memoryEmail = result.user.email || null;
    memoryChannel = null;

    try {
      memoryChannel = await fetchYouTubeChannel(credential.accessToken);
    } catch {
      memoryChannel = null;
    }

    notifySessionListeners();
    return {
      accessToken: credential.accessToken,
      channel: memoryChannel,
      email: memoryEmail,
    };
  } catch (err) {
    throw new Error(mapFirebaseAuthError(err));
  } finally {
    isSigningIn = false;
  }
}

export async function fetchYouTubeChannel(accessToken: string): Promise<YouTubeChannelInfo | null> {
  const res = await fetch(
    'https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true',
    {
      headers: { Authorization: `Bearer ${accessToken}` },
    }
  );
  if (!res.ok) return null;
  const data = (await res.json()) as {
    items?: Array<{
      id?: string;
      snippet?: { title?: string; thumbnails?: { default?: { url?: string } } };
    }>;
  };
  const first = data.items?.[0];
  if (!first?.id) return null;
  return {
    id: first.id,
    title: first.snippet?.title || 'قناتي على YouTube',
    thumbnailUrl: first.snippet?.thumbnails?.default?.url,
  };
}

export async function fetchMyYouTubePlaylists(
  accessToken: string
): Promise<YouTubePlaylistItem[]> {
  try {
    const res = await fetch(
      'https://www.googleapis.com/youtube/v3/playlists?part=snippet&mine=true&maxResults=25',
      {
        headers: { Authorization: `Bearer ${accessToken}` },
      }
    );
    if (!res.ok) return [];
    const data = (await res.json()) as {
      items?: Array<{ id?: string; snippet?: { title?: string } }>;
    };
    return (data.items || [])
      .filter((p) => p.id && p.snippet?.title)
      .map((p) => ({
        id: p.id!,
        title: p.snippet!.title!,
      }));
  } catch {
    return [];
  }
}

export async function uploadVideoToYouTube(
  options: YouTubeUploadOptions
): Promise<YouTubeUploadResult> {
  const session = getCachedYouTubeSession();
  if (!session.connected || !session.token) {
    throw new Error('انتهت جلسة تسجيل الدخول. أعد ربط حساب Google / YouTube أولاً.');
  }
  const accessToken = session.token;
  const {
    blob,
    mimeType,
    title,
    description,
    tags,
    privacyStatus,
    publishAtIso,
    playlistId,
    pinnedComment,
    onProgress,
  } = options;

  onProgress?.(4, 'جارٍ تهيئة جلسة الرفع مع YouTube...');

  const statusPayload: Record<string, unknown> = {
    privacyStatus: publishAtIso ? 'private' : privacyStatus,
    selfDeclaredMadeForKids: false,
  };
  if (publishAtIso) {
    statusPayload.publishAt = publishAtIso;
  }

  const metadataBody = {
    snippet: {
      title: (title || 'تحدي الأسئلة #Shorts').trim().slice(0, 100),
      description: (description || '').trim().slice(0, 4900),
      tags: tags.slice(0, 20),
      categoryId: '27', // Education
      defaultLanguage: 'ar',
    },
    status: statusPayload,
  };

  const cleanMime = mimeType.split(';')[0].trim() || 'video/webm';

  const initRes = await fetch(
    'https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json; charset=UTF-8',
        'X-Upload-Content-Length': String(blob.size),
        'X-Upload-Content-Type': cleanMime,
      },
      body: JSON.stringify(metadataBody),
    }
  );

  if (!initRes.ok) {
    if (initRes.status === 401) {
      clearMemorySession();
      notifySessionListeners();
      throw new Error('انتهت صلاحية جلسة Google. أعد تسجيل الدخول بالضغط على زر ربط الحساب.');
    }
    const errText = await initRes.text();
    let parsedMsg = 'تعذر بدء رفع الفيديو إلى YouTube.';
    try {
      const errJson = JSON.parse(errText) as { error?: { message?: string } };
      if (errJson?.error?.message) {
        parsedMsg = `YouTube API: ${errJson.error.message}`;
      }
    } catch {
      // keep fallback
    }
    throw new Error(parsedMsg);
  }

  const uploadUrl = initRes.headers.get('Location') || initRes.headers.get('location');
  if (!uploadUrl) {
    throw new Error('لم يُرجع YouTube رابط الرفع القابل للاستكمال.');
  }

  const uploadedVideoId = await new Promise<string>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', uploadUrl, true);
    xhr.setRequestHeader('Content-Type', cleanMime);

    xhr.upload.onprogress = (ev) => {
      if (ev.lengthComputable && ev.total > 0) {
        const pct = Math.min(90, Math.max(6, Math.round((ev.loaded / ev.total) * 86) + 4));
        onProgress?.(pct, `جارٍ رفع الفيديو (${Math.round((ev.loaded / ev.total) * 100)}%)...`);
      }
    };

    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          const resJson = JSON.parse(xhr.responseText) as { id?: string };
          if (resJson.id) {
            resolve(resJson.id);
            return;
          }
        } catch {
          // fallthrough
        }
        reject(new Error('تم الرفع لكن تعذر قراءة معرّف الفيديو من استجابة YouTube.'));
      } else {
        reject(new Error(`فشل رفع ملف الفيديو (رمز ${xhr.status}).`));
      }
    };

    xhr.onerror = () => {
      reject(new Error('انقطع الاتصال أثناء رفع الفيديو إلى YouTube.'));
    };

    xhr.send(blob);
  });

  let playlistAdded = false;
  if (playlistId && playlistId.trim()) {
    onProgress?.(93, 'جارٍ إضافة الفيديو لقائمة التشغيل...');
    try {
      const plRes = await fetch(
        'https://www.googleapis.com/youtube/v3/playlistItems?part=snippet',
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            snippet: {
              playlistId: playlistId.trim(),
              resourceId: {
                kind: 'youtube#video',
                videoId: uploadedVideoId,
              },
            },
          }),
        }
      );
      playlistAdded = plRes.ok;
    } catch {
      playlistAdded = false;
    }
  }

  let commentPosted = false;
  let commentNote: string | undefined;
  const cleanComment = (pinnedComment || '').trim();
  if (cleanComment) {
    if (privacyStatus === 'private' || publishAtIso) {
      commentNote =
        'ملاحظة: يوتيوب يمنع إضافة التعليقات على الفيديوهات الخاصة/المجدولة؛ انسخ التعليق وأضفه بعد التبديل لعلني أو غير مدرج.';
    } else {
      onProgress?.(96, 'جارٍ نشر التعليق التفاعلي تحت الفيديو...');
      try {
        const cmRes = await fetch(
          'https://www.googleapis.com/youtube/v3/commentThreads?part=snippet',
          {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${accessToken}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              snippet: {
                videoId: uploadedVideoId,
                topLevelComment: {
                  snippet: {
                    textOriginal: cleanComment,
                  },
                },
              },
            }),
          }
        );
        if (cmRes.ok) {
          commentPosted = true;
          commentNote =
            'تم نشر التعليق تلقائياً! لتثبيته في الأعلى (Pin)، افتح YouTube Studio واضغط تثبيت لأن API يوتيوب لا يتيح التثبيت البرمجي.';
        } else {
          commentNote =
            'تم رفع الفيديو بنجاح، لكن تعذر نشر التعليق التلقائي (ربما الفيديو ما زال قيد المعالجة الأولية في يوتيوب).';
        }
      } catch {
        commentNote = 'تم رفع الفيديو بنجاح، ويمكنك لصق التعليق يدوياً من هنا.';
      }
    }
  }

  onProgress?.(100, 'اكتمل النشر على YouTube!');

  return {
    videoId: uploadedVideoId,
    videoUrl: `https://youtu.be/${uploadedVideoId}`,
    commentPosted,
    commentNote,
    playlistAdded,
  };
}

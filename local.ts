import * as Location from 'expo-location';
import * as TaskManager from 'expo-task-manager';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { addDoc, collection, serverTimestamp } from 'firebase/firestore';
import { db } from '../../shared/firebase';
import { getDistanceMeters } from '../../shared/distance';
import { queueEventLocally } from '../../shared/offlineQueue';
import {
  loadGeofenceFromStorage,
  saveLocationToFirestore,
  getPatientId,
} from './storage';
import { PatientStatus } from '../../shared/types';

const LOCATION_TASK = 'bg-location';

// ─── 정확도 기준 ──────────────────────────────────
const MAX_ACCURACY_FOR_EVENT = 50;
const MAX_ACCURACY_FOR_SAVE = 200;

// ─── 인터벌 ──────────────────────────────────────
const ALERT_COOLDOWN_MS = 5 * 60 * 1000;
const NORMAL_SAVE_INTERVAL_MS = 5 * 60 * 1000;
const OUTSIDE_SAVE_INTERVAL_MS = 30 * 1000;
const LOW_ACC_SAVE_INTERVAL_MS = 5 * 60 * 1000;

// ─── 경계 버퍼 (오탐 감소) ────────────────────────
const BORDER_BUFFER_M = 30;

// ─── 연속 이탈 확인 ───────────────────────────────
const REQUIRED_OUTSIDE_COUNT = 2;
const OUTSIDE_CONFIRM_WINDOW_MS = 20_000;

// ─── 타이머 저장 스로틀 ───────────────────────────
const TIMER_SAVE_THROTTLE_MS = 5_000;
let lastTimerSaveAt = 0;

const TIMER_KEY = 'location_task_timers';

interface TaskTimers {
  lastAlertTime: number;
  lastSavedSafe: number;
  lastSavedOutside: number;
  lastSavedLowAcc: number;
  outsideCount: number;
  lastOutsideCheckAt: number;
}

const DEFAULT_TIMERS: TaskTimers = {
  lastAlertTime: 0,
  lastSavedSafe: 0,
  lastSavedOutside: 0,
  lastSavedLowAcc: 0,
  outsideCount: 0,
  lastOutsideCheckAt: 0,
};

function sameTimers(a: TaskTimers, b: TaskTimers) {
  return (
    a.lastAlertTime === b.lastAlertTime &&
    a.lastSavedSafe === b.lastSavedSafe &&
    a.lastSavedOutside === b.lastSavedOutside &&
    a.lastSavedLowAcc === b.lastSavedLowAcc &&
    a.outsideCount === b.outsideCount &&
    a.lastOutsideCheckAt === b.lastOutsideCheckAt
  );
}

async function loadTimers(): Promise<TaskTimers> {
  try {
    const raw = await AsyncStorage.getItem(TIMER_KEY);
    if (raw) return { ...DEFAULT_TIMERS, ...JSON.parse(raw) };
  } catch {}
  return { ...DEFAULT_TIMERS };
}

async function saveTimers(
  next: TaskTimers,
  prev?: TaskTimers,
  forceWrite = false,
) {
  if (prev && sameTimers(prev, next)) return;

  const now = Date.now();
  if (!forceWrite && now - lastTimerSaveAt < TIMER_SAVE_THROTTLE_MS) return;

  lastTimerSaveAt = now;
  try {
    await AsyncStorage.setItem(TIMER_KEY, JSON.stringify(next));
  } catch {}
}

// ─── 백그라운드 태스크 ────────────────────────────
TaskManager.defineTask(LOCATION_TASK, async ({ data, error }) => {
  if (error) {
    console.warn('[Location Task] 에러:', error.message);
    return;
  }
  if (!data) return;

  const { locations } = data as any;
  if (!Array.isArray(locations) || locations.length === 0) return;

  const coords = locations[0]?.coords;
  if (!coords) return;

  const { latitude: lat, longitude: lng, accuracy } = coords;
  if (typeof lat !== 'number' || typeof lng !== 'number') return;
  if (!isFinite(lat) || !isFinite(lng)) return;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return;

  const acc = typeof accuracy === 'number' ? accuracy : Infinity;
  const timers = await loadTimers();

  if (acc <= MAX_ACCURACY_FOR_EVENT) {
    await handleHighAccuracy(lat, lng, acc, timers);
  } else if (acc <= MAX_ACCURACY_FOR_SAVE) {
    await handleMediumAccuracy(lat, lng, acc, timers);
  } else {
    // 정확도 불량: MVP에선 최소한 low_accuracy로 주기 저장하는 편이 안전하지만
    // 현재는 스킵(원하면 여기서 heartbeat만 찍는 방식으로 강화 가능)
    console.log(`[Location Task] 정확도 불량 (${Math.round(acc)}m) — 스킵`);
  }
});

// ─── 정확도 높음: 이탈 판단 + 저장 ──────────────
async function handleHighAccuracy(
  lat: number,
  lng: number,
  acc: number,
  timers: TaskTimers,
) {
  const geofence = await loadGeofenceFromStorage();
  if (!geofence) {
    await maybeSave(lat, lng, acc, 'no_geofence', timers, 'safe');
    return;
  }

  const distance = getDistanceMeters(
    lat, lng,
    geofence.centerLat, geofence.centerLng,
  );

  const now = Date.now();
  const isOutside = distance > geofence.radiusMeters + BORDER_BUFFER_M;

  if (isOutside) {
    const isNewSequence = now - timers.lastOutsideCheckAt > OUTSIDE_CONFIRM_WINDOW_MS;
    const newCount = isNewSequence ? 1 : timers.outsideCount + 1;

    const next: TaskTimers = {
      ...timers,
      outsideCount: newCount,
      lastOutsideCheckAt: now,
    };

    if (newCount >= REQUIRED_OUTSIDE_COUNT &&
        now - timers.lastAlertTime > ALERT_COOLDOWN_MS) {

      const toSave: TaskTimers = {
        ...next,
        lastAlertTime: now,
        outsideCount: 0,
      };

      // 이벤트 발행 직전 강제 저장 (중복 방지)
      await saveTimers(toSave, timers, true);

      await sendEscapeEvent({
        lat, lng, distance, acc,
        geofenceRadius: geofence.radiusMeters,
      });
    } else {
      await saveTimers(next, timers);
    }

    await maybeSave(lat, lng, acc, 'outside', next, 'outside');
    return;
  }

  // safe 복귀
  if (timers.outsideCount > 0 || timers.lastOutsideCheckAt > 0) {
    await saveTimers(
      { ...timers, outsideCount: 0, lastOutsideCheckAt: 0 },
      timers,
    );
  }

  await maybeSave(lat, lng, acc, 'safe', timers, 'safe');
}

// ─── 정확도 중간: 저장만 ─────────────────────────
async function handleMediumAccuracy(
  lat: number,
  lng: number,
  acc: number,
  timers: TaskTimers,
) {
  await maybeSave(lat, lng, acc, 'low_accuracy', timers, 'lowAcc');
}

type TimerKey = 'safe' | 'outside' | 'lowAcc';

const TIMER_FIELD_MAP: Record<TimerKey, keyof TaskTimers> = {
  safe: 'lastSavedSafe',
  outside: 'lastSavedOutside',
  lowAcc: 'lastSavedLowAcc',
};

const INTERVAL_MAP: Record<TimerKey, number> = {
  safe: NORMAL_SAVE_INTERVAL_MS,
  outside: OUTSIDE_SAVE_INTERVAL_MS,
  lowAcc: LOW_ACC_SAVE_INTERVAL_MS,
};

async function maybeSave(
  lat: number,
  lng: number,
  acc: number,
  status: PatientStatus | string,
  timers: TaskTimers,
  timerKey: TimerKey,
) {
  const field = TIMER_FIELD_MAP[timerKey];
  const intervalMs = INTERVAL_MAP[timerKey];
  const lastSaved = timers[field] as number;

  const now = Date.now();
  if (now - lastSaved < intervalMs) return;

  // ✅ 타이머 갱신은 forceWrite로 확정 저장(스로틀에 의해 write 폭주 방지)
  await saveTimers({ ...timers, [field]: now } as TaskTimers, timers, true);

  await saveLocationToFirestore(lat, lng, status as any, acc);
}

// ─── 이탈 이벤트 전송 ────────────────────────────
async function sendEscapeEvent(payload: {
  lat: number;
  lng: number;
  distance: number;
  acc: number;
  geofenceRadius: number;
}) {
  try {
    const patientId = await getPatientId();
    await addDoc(collection(db, 'escapeEvents'), {
      patientId,
      type: 'geofence',
      lat: payload.lat,
      lng: payload.lng,
      distance: payload.distance,
      accuracy: payload.acc,
      geofenceRadius: payload.geofenceRadius,
      detectedAt: serverTimestamp(),
      confirmed: false,
    });
  } catch (e) {
    console.warn('[sendEscapeEvent] 실패 → 로컬 큐:', e);
    await queueEventLocally(payload);
  }
}

// ─── 위치 수집 주기 15초 ─────────────────────────
export async function startLocationTracking() {
  const { status: fg } = await Location.requestForegroundPermissionsAsync();
  if (fg !== 'granted') return;

  const { status: bg } = await Location.requestBackgroundPermissionsAsync();
  if (bg !== 'granted') return;

  if (await TaskManager.isTaskRegisteredAsync(LOCATION_TASK)) return;

  await Location.startLocationUpdatesAsync(LOCATION_TASK, {
    accuracy: Location.Accuracy.Balanced,
    timeInterval: 15_000,
    distanceInterval: 10,
    foregroundService: {
      notificationTitle: '위치 공유 중',
      notificationBody: '보호자가 현재 위치를 확인하고 있어요',
      notificationColor: '#1A5276',
    },
    pausesUpdatesAutomatically: false,
    showsBackgroundLocationIndicator: true,
  });
}

export async function stopLocationTracking() {
  if (await TaskManager.isTaskRegisteredAsync(LOCATION_TASK)) {
    await Location.stopLocationUpdatesAsync(LOCATION_TASK);
  }
}
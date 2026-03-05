import { Timestamp } from 'firebase/firestore';

export type FirestoreTime =
  | Timestamp
  | number
  | { seconds: number; nanoseconds?: number }
  | null
  | undefined;

export function toEpochMs(value: FirestoreTime): number {
  if (!value) return 0;
  if (typeof value === 'number') return value;
  if (value instanceof Timestamp) return value.toMillis();
  if (typeof (value as any).seconds === 'number') return (value as any).seconds * 1000;
  return 0;
}

export function formatTime(value: FirestoreTime): string {
  const epoch = toEpochMs(value);
  if (!epoch) return '—';
  const diff = Date.now() - epoch;
  if (diff < 0) return '방금 전';
  if (diff < 60_000) return '방금 전';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}분 전`;
  return `${Math.floor(diff / 3_600_000)}시간 전`;
}

export function formatReturnTime(value: FirestoreTime): string {
  const epoch = toEpochMs(value);
  if (!epoch) return '미정';
  return new Date(epoch).toLocaleTimeString('ko-KR', {
    hour: '2-digit',
    minute: '2-digit',
  });
}
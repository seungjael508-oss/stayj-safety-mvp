import * as functions from 'firebase-functions';
import * as admin from 'firebase-admin';
import { EscapeEvent, Caregiver } from '../shared/types';
import { getDistanceMeters } from '../shared/distance';
import { dispatchEmergency } from './emergency.dispatch';

admin.initializeApp();

const DEDUP_WINDOW_MS = 3 * 60 * 1000;

export const confirmEscape = functions.firestore
  .document('escapeEvents/{eventId}')
  .onCreate(async (snap) => {
    const event = snap.data() as EscapeEvent;
    const patientId = event.patientId;

    // ─── 락 기반 중복 방지(레이스 차단) ─────────────────
    const lockId = `${patientId}_${event.type}`;
    const lockRef = admin.firestore().doc(`dedupeLocks/${lockId}`);

    const nowMs = Date.now();
    const cutoffMs = nowMs - DEDUP_WINDOW_MS;

    const locked = await admin.firestore().runTransaction(async (tx) => {
      const lockSnap = await tx.get(lockRef);
      const lastAtMs = lockSnap.exists ? (lockSnap.data()!.lastAtMs ?? 0) : 0;
      if (lastAtMs > cutoffMs) return true;
      tx.set(lockRef, { lastAtMs: nowMs }, { merge: true });
      return false;
    });

    if (locked) {
      console.log(`[confirmEscape] lock dedup 스킵: ${patientId}`);
      return;
    }

    // ─── patient 문서 방어 ───────────────────────────────
    const patientSnap = await admin.firestore()
      .doc(`patients/${patientId}`)
      .get();

    if (!patientSnap.exists) {
      console.warn(`[confirmEscape] 환자 문서 없음: ${patientId}`);
      await snap.ref.update({ confirmed: false, reason: 'no_patient' });
      return;
    }

    const pdata = patientSnap.data()!;
    const currentLoc = pdata.location;
    const geofence = pdata.geofence;

    // ─── 보호자 조회 ─────────────────────────────────────
    const cgSnap = await admin.firestore()
      .collection('caregivers')
      .where('patientId', '==', patientId)
      .limit(1)
      .get();

    if (cgSnap.empty) {
      console.warn(`[confirmEscape] 보호자 없음: ${patientId}`);
      return;
    }

    const caregiver = {
      id: cgSnap.docs[0].id,
      ...cgSnap.docs[0].data(),
    } as Caregiver;

    // ─── 외출모드 만료 자동 해제 ─────────────────────────
    const om = caregiver.outingMode;
    if (om?.active && typeof om.startedAt === 'number' && typeof om.autoExpireMs === 'number') {
      const elapsed = Date.now() - om.startedAt;
      if (elapsed > om.autoExpireMs) {
        await admin.firestore()
          .doc(`caregivers/${caregiver.id}`)
          .update({ 'outingMode.active': false });
        caregiver.outingMode.active = false;
      }
    }

    // ─── SOS는 지오펜스 없어도 즉시 발송 ─────────────────
    if (event.type === 'sos') {
      await dispatchEmergency(caregiver, event, undefined);

      await snap.ref.update({ confirmed: true });

      await admin.firestore().collection('alerts').add({
        patientId,
        type: event.type,
        message: 'SOS 긴급 신호',
        location: {
          lat: typeof currentLoc?.lat === 'number' ? currentLoc.lat : event.lat,
          lng: typeof currentLoc?.lng === 'number' ? currentLoc.lng : event.lng,
        },
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      return;
    }

    // ─── geofence 이벤트는 지오펜스 필요 ────────────────
    if (!geofence) {
      console.warn(`[confirmEscape] 지오펜스 없음: ${patientId}`);
      await snap.ref.update({ confirmed: false, reason: 'no_geofence' });
      return;
    }

    // ─── 서버 거리 재계산 ────────────────────────────────
    const checkLat =
      typeof currentLoc?.lat === 'number' ? currentLoc.lat : event.lat;
    const checkLng =
      typeof currentLoc?.lng === 'number' ? currentLoc.lng : event.lng;

    const serverDistance = getDistanceMeters(
      checkLat, checkLng,
      geofence.centerLat, geofence.centerLng,
    );

    const acc = typeof event.accuracy === 'number' ? event.accuracy : 50;
    const buffer = Math.max(30, Math.min(80, acc));

    if (serverDistance <= geofence.radiusMeters + buffer) {
      console.log(
        `[confirmEscape] 오탐 처리 — server:${Math.round(serverDistance)}m ` +
        `client:${Math.round(event.distance)}m buffer:${buffer}m`,
      );
      await snap.ref.update({ confirmed: false, falseAlarm: true, serverDistance });
      return;
    }

    // ─── 발송 ────────────────────────────────────────────
    await dispatchEmergency(caregiver, event, serverDistance);

    await snap.ref.update({ confirmed: true, serverDistance });

    await admin.firestore().collection('alerts').add({
      patientId,
      type: event.type,
      message: `이탈 감지 (${Math.round(serverDistance)}m)`,
      location: { lat: checkLat, lng: checkLng },
      clientDistance: event.distance,
      serverDistance,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  });
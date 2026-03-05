import * as functions from 'firebase-functions';
import * as admin from 'firebase-admin';
import axios from 'axios';

type SunsetLevel = 'LEVEL_1' | 'LEVEL_2' | 'LEVEL_3';

export const scheduleSunsetMode = functions.pubsub
  .schedule('0 6 * * *')
  .timeZone('Asia/Seoul')
  .onRun(async () => {
    const patients = await admin.firestore().collection('patients').get();
    const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

    for (const patient of patients.docs) {
      const { location } = patient.data();
      if (!location?.lat || !location?.lng) continue;

      try {
        const url =
          `https://api.sunrise-sunset.org/json` +
          `?lat=${location.lat}&lng=${location.lng}&formatted=0`;

        const res = await axios.get(url, { timeout: 5000 });
        const sunsetUTC = new Date(res.data.results.sunset);

        await upsertAlert(patient.id, today, sunsetUTC, -120, 'LEVEL_1');
        await upsertAlert(patient.id, today, sunsetUTC, 0, 'LEVEL_2');
        await upsertAlert(patient.id, today, sunsetUTC, +120, 'LEVEL_3');
      } catch (e) {
        console.warn(`[Sunset] ${patient.id} 조회 실패 (lat:${location.lat}, lng:${location.lng}):`, e);
      }
    }
  });

async function upsertAlert(
  patientId: string,
  date: string,
  sunsetTime: Date,
  offsetMinutes: number,
  level: SunsetLevel,
) {
  const triggerAt = new Date(sunsetTime.getTime() + offsetMinutes * 60 * 1000);
  const docId = `${patientId}_${date}_${level}`;
  const ref = admin.firestore().doc(`scheduledAlerts/${docId}`);

  const existing = await ref.get();
  if (existing.exists && existing.data()?.executed === true) {
    console.log(`[Sunset] ${docId} 이미 실행 완료 — 스킵`);
    return;
  }

  await ref.set(
    {
      patientId,
      level,
      date,
      triggerAt: admin.firestore.Timestamp.fromDate(triggerAt),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true },
  );

  if (!existing.exists) {
    await ref.update({ executed: false });
  }
}
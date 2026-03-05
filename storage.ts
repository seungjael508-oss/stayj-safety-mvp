import { doc, updateDoc, serverTimestamp } from 'firebase/firestore';
// ...

export async function saveLocationToFirestore(
  lat: number,
  lng: number,
  status: PatientStatus,
  accuracy?: number,
) {
  const patientId = await getPatientId();

  await updateDoc(doc(db, 'patients', patientId), {
    location: {
      lat,
      lng,
      accuracy: accuracy ?? null,
      status,
      updatedAt: Date.now(),        // UI용 (오프라인/타임스탬프 혼선 방지)
      updatedAtServer: serverTimestamp(), // 서버 정렬/감사용
    },
  });
}
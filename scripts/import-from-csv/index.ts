/**
 * Import speakers, sessions, and schedule from a CSV.
 *
 * Usage:
 *   npx ts-node-script scripts/import-from-csv path/to/talks.csv [--dry-run] [--replace]
 *
 * CSV columns (one row per talk × speaker):
 *   title, description, stage, day, startTime, endTime,
 *   speakerName, speakerTitle, speakerHeadshotUrl, speakerCompany
 * An optional "Ready for Website?" column restricts the import to rows
 * marked TRUE.
 *
 * Flags:
 *   --dry-run   Preview without writing
 *   --replace   Delete all sessions and schedule docs before writing, so the
 *               CSV becomes the source of truth (speakers are still upserted
 *               in place). Use this for re-imports as the tracker sheet grows.
 *
 * Prerequisite: run
 *   npm run firestore:archive-speakers -- --year <prevYear>
 * before this script to archive last year's speakers (with --clear, or use
 * --replace here, to wipe the sessions and schedule collections).
 */

import { readFileSync } from 'fs';
import { firestore } from '../firebase-config';
import { parseCsv } from './csv';
import { groupTalks } from './grouping';
import { planSpeakers, type CsvSpeaker, type ExistingSpeaker } from './speakers';
import { buildSessions } from './sessions';
import { buildSchedule } from './schedule';

interface Args {
  csvPath: string;
  dryRun: boolean;
  replace: boolean;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes('--dry-run');
  const replace = argv.includes('--replace');
  const positional = argv.filter((a) => !a.startsWith('--'));
  const csvPath = positional[0];
  if (!csvPath) {
    console.error(
      'Usage: npx ts-node-script scripts/import-from-csv <csv-path> [--dry-run] [--replace]',
    );
    process.exit(1);
  }
  return { csvPath, dryRun, replace };
}

async function commitInBatches(
  ops: Array<(batch: FirebaseFirestore.WriteBatch) => void>,
): Promise<void> {
  const CHUNK = 500;
  for (let i = 0; i < ops.length; i += CHUNK) {
    const batch = firestore.batch();
    for (const op of ops.slice(i, i + CHUNK)) op(batch);
    await batch.commit();
  }
}

async function main(): Promise<void> {
  const { csvPath, dryRun, replace } = parseArgs();
  if (dryRun) console.log('=== DRY RUN ===\n');
  if (replace) console.log('=== REPLACE MODE: existing sessions + schedule will be deleted ===\n');

  // 1. Read + parse CSV.
  const raw = readFileSync(csvPath, 'utf8');
  const rows = parseCsv(raw);
  console.log(`Parsed ${rows.length} CSV rows from ${csvPath}`);

  // 2. Group into talks.
  const { talks, warnings: groupingWarnings } = groupTalks(rows);
  for (const w of groupingWarnings) console.warn(`[warn] ${w}`);
  console.log(`Grouped into ${talks.length} talks`);

  // 3. Fetch existing speakers, plan upserts.
  console.log('Fetching existing speakers...');
  const speakersSnap = await firestore.collection('speakers').get();
  const existing: ExistingSpeaker[] = [];
  speakersSnap.forEach((doc) => {
    existing.push({ id: doc.id, data: doc.data() as ExistingSpeaker['data'] });
  });
  console.log(`  Found ${existing.length} existing speakers`);

  const csvSpeakers: CsvSpeaker[] = [];
  for (const t of talks) {
    for (const s of t.speakers) {
      csvSpeakers.push({
        name: s.name,
        title: s.title,
        company: s.company,
        headshotUrl: s.headshotUrl,
      });
    }
  }
  const speakerPlan = planSpeakers(csvSpeakers, existing);
  console.log(
    `  Plan: ${speakerPlan.updates.length} speakers to update, ${speakerPlan.creates.length} new`,
  );

  // Surface active speakers the CSV no longer references (e.g. cancelled
  // talks on a re-import) — they stay active unless handled manually.
  const importedIds = new Set(speakerPlan.resolveByName.values());
  const staleActive = existing.filter((e) => e.data['active'] && !importedIds.has(e.id));
  if (staleActive.length > 0) {
    const action = replace
      ? 'They will stay active — deactivate manually if their talks were cancelled.'
      : 'Did you run firestore:archive-speakers first?';
    console.warn(
      `[warn] ${staleActive.length} active speaker(s) not referenced by this CSV: ` +
        `${staleActive.map((e) => e.id).join(', ')}. ${action}`,
    );
  }

  // Sessions referenced by speaker history (previous years) must be preserved
  // across re-imports — they back the /sessions/<id> links on speaker pages.
  // We never delete these, and never reuse their IDs for new sessions.
  const protectedSessionIds = new Set<string>();
  for (const e of existing) {
    const history = e.data['history'] as
      | Record<string, { talks?: Array<{ sessionId?: string }> }>
      | undefined;
    if (!history) continue;
    for (const snap of Object.values(history)) {
      for (const talk of snap.talks ?? []) {
        if (talk.sessionId) protectedSessionIds.add(talk.sessionId);
      }
    }
  }
  if (protectedSessionIds.size > 0) {
    console.log(
      `  Protecting ${protectedSessionIds.size} archived session(s) referenced by history`,
    );
  }

  // 4. Build sessions.
  console.log('Fetching existing sessions...');
  const sessionsSnap = await firestore.collection('sessions').get();
  // Non-talk logistics items (breaks, ceremony, reception) are marked
  // `logistics: true` and are not produced by the CSV — protect them too so a
  // re-import doesn't wipe them (their schedule placement is managed by hand).
  sessionsSnap.forEach((doc) => {
    if (doc.get('logistics') === true) protectedSessionIds.add(doc.id);
  });
  // In replace mode existing sessions are deleted, so IDs restart; otherwise
  // continue numbering after the highest existing ID.
  const existingSessionIds: string[] = [];
  if (!replace) {
    sessionsSnap.forEach((doc) => existingSessionIds.push(doc.id));
  }
  const { sessions, talkToSessionId } = buildSessions({
    talks,
    existingSessionIds,
    resolveByName: speakerPlan.resolveByName,
    reservedSessionIds: protectedSessionIds,
  });
  console.log(`  Built ${sessions.length} session docs`);

  // 5. Build schedule.
  const days = buildSchedule({ talks, talkToSessionId });
  console.log(`  Built ${days.length} schedule day(s)`);

  // 6. Summary.
  console.log('\nSummary:');
  console.log(
    `  Speakers: ${speakerPlan.creates.length} create, ${speakerPlan.updates.length} update`,
  );
  console.log(`  Sessions: ${sessions.length}`);
  console.log(`  Schedule days: ${days.length}`);
  if (replace) {
    const willDelete = sessionsSnap.docs.filter((doc) => !protectedSessionIds.has(doc.id)).length;
    console.log(
      `  Will delete: ${willDelete} sessions (keeping ${sessionsSnap.size - willDelete} protected) + existing schedule docs`,
    );
  }

  if (dryRun) {
    console.log('\n[dry-run] No writes performed.');
    process.exit(0);
  }

  // 7. Replace: wipe sessions + schedule now that everything built cleanly.
  // Archived sessions referenced by speaker history are preserved.
  if (replace) {
    console.log('\nDeleting existing sessions and schedule...');
    const scheduleSnap = await firestore.collection('schedule').get();
    const sessionDocsToDelete = sessionsSnap.docs.filter((doc) => !protectedSessionIds.has(doc.id));
    const protectedKept = sessionsSnap.size - sessionDocsToDelete.length;
    const deleteOps = [...sessionDocsToDelete, ...scheduleSnap.docs].map(
      (doc) => (b: FirebaseFirestore.WriteBatch) => b.delete(doc.ref),
    );
    await commitInBatches(deleteOps);
    console.log(
      `  Deleted ${sessionDocsToDelete.length} sessions (kept ${protectedKept} protected), ${scheduleSnap.size} schedule docs`,
    );
  }

  // 8. Write.
  console.log('\nWriting speakers...');
  const speakerOps: Array<(b: FirebaseFirestore.WriteBatch) => void> = [];
  for (const u of speakerPlan.updates) {
    speakerOps.push((b) => b.update(firestore.collection('speakers').doc(u.id), u.fields));
  }
  for (const c of speakerPlan.creates) {
    speakerOps.push((b) => b.set(firestore.collection('speakers').doc(c.id), c.doc));
  }
  await commitInBatches(speakerOps);
  console.log(`  Wrote ${speakerOps.length} speaker ops`);

  console.log('Writing sessions...');
  const sessionOps = sessions.map(
    (s) => (b: FirebaseFirestore.WriteBatch) =>
      b.set(firestore.collection('sessions').doc(s.id), s.doc),
  );
  await commitInBatches(sessionOps);
  console.log(`  Wrote ${sessionOps.length} session docs`);

  console.log('Writing schedule...');
  const scheduleOps = days.map(
    (d) => (b: FirebaseFirestore.WriteBatch) =>
      b.set(firestore.collection('schedule').doc(d.date), {
        date: d.date,
        dateReadable: d.dateReadable,
        timeslots: d.timeslots,
        tracks: d.tracks,
      }),
  );
  await commitInBatches(scheduleOps);
  console.log(`  Wrote ${scheduleOps.length} schedule day(s)`);

  // 9. The generate-sessions-speakers-schedule Cloud Function only ever
  // upserts into the generated* collections, so in replace mode prune docs
  // left over from sessions/days that no longer exist.
  if (replace) {
    console.log('Pruning stale generated docs...');
    const newSessionIds = new Set(sessions.map((s) => s.id));
    const newDates = new Set(days.map((d) => d.date));
    const [genSessions, genSchedule] = await Promise.all([
      firestore.collection('generatedSessions').get(),
      firestore.collection('generatedSchedule').get(),
    ]);
    const staleDocs = [
      ...genSessions.docs.filter(
        (doc) => !newSessionIds.has(doc.id) && !protectedSessionIds.has(doc.id),
      ),
      ...genSchedule.docs.filter((doc) => !newDates.has(doc.id)),
    ];
    await commitInBatches(
      staleDocs.map((doc) => (b: FirebaseFirestore.WriteBatch) => b.delete(doc.ref)),
    );
    console.log(`  Deleted ${staleDocs.length} stale generated docs`);
  }

  console.log('\nImport complete.');
  process.exit(0);
}

main().catch((err) => {
  console.error('Import failed:', err);
  process.exit(1);
});

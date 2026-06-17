/**
 * Restore previous-year session docs that are referenced by speaker `history`
 * but missing from the `sessions` collection (e.g. wiped by an earlier
 * `import-from-csv --replace` before that flag learned to preserve them).
 *
 * Reads sessions from a firestore-dump backup file and restores only the IDs
 * that (a) are referenced by some speaker's history and (b) don't currently
 * exist. Idempotent: re-running restores nothing once they're present.
 *
 * Usage:
 *   npx ts-node-script scripts/restore-archived-sessions <backup.json> [--dry-run]
 */

import { readFileSync } from 'fs';
import { resolve } from 'path';
import { firestore } from '../firebase-config';

interface DumpedDoc {
  __data: FirebaseFirestore.DocumentData;
}

async function commitInBatches(
  ops: Array<(b: FirebaseFirestore.WriteBatch) => void>,
): Promise<void> {
  const CHUNK = 500;
  for (let i = 0; i < ops.length; i += CHUNK) {
    const batch = firestore.batch();
    for (const op of ops.slice(i, i + CHUNK)) op(batch);
    await batch.commit();
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes('--dry-run');
  const backupPath = argv.find((a) => !a.startsWith('--'));
  if (!backupPath) {
    console.error(
      'Usage: npx ts-node-script scripts/restore-archived-sessions <backup.json> [--dry-run]',
    );
    process.exit(1);
  }
  if (dryRun) console.log('=== DRY RUN ===\n');

  const backup = JSON.parse(readFileSync(resolve(process.cwd(), backupPath), 'utf8')) as {
    sessions?: Record<string, DumpedDoc>;
  };
  const backupSessions = backup.sessions ?? {};
  console.log(`Backup has ${Object.keys(backupSessions).length} session(s)`);

  // Which session IDs does speaker history reference?
  const referenced = new Set<string>();
  const speakersSnap = await firestore.collection('speakers').get();
  speakersSnap.forEach((doc) => {
    const history = doc.data()['history'] as
      | Record<string, { talks?: Array<{ sessionId?: string }> }>
      | undefined;
    if (!history) return;
    for (const snap of Object.values(history)) {
      for (const talk of snap.talks ?? []) {
        if (talk.sessionId) referenced.add(talk.sessionId);
      }
    }
  });
  console.log(`Speaker history references ${referenced.size} session ID(s)`);

  // Which of those are currently missing?
  const existing = new Set<string>();
  (await firestore.collection('sessions').get()).forEach((d) => existing.add(d.id));

  const toRestore: string[] = [];
  const missingFromBackup: string[] = [];
  for (const id of referenced) {
    if (existing.has(id)) continue;
    if (backupSessions[id]) toRestore.push(id);
    else missingFromBackup.push(id);
  }

  console.log(`\nMissing & restorable from backup: ${toRestore.length}`);
  if (missingFromBackup.length > 0) {
    console.warn(
      `[warn] ${missingFromBackup.length} referenced ID(s) missing AND not in backup: ${missingFromBackup.join(', ')}`,
    );
  }

  if (toRestore.length === 0) {
    console.log('\nNothing to restore.');
    process.exit(0);
  }

  for (const id of toRestore) {
    const title = (backupSessions[id]!.__data['title'] as string) ?? '(untitled)';
    console.log(`  ${id}: ${title}`);
  }

  if (dryRun) {
    console.log('\n[dry-run] No writes performed.');
    process.exit(0);
  }

  await commitInBatches(
    toRestore.map(
      (id) => (b: FirebaseFirestore.WriteBatch) =>
        b.set(firestore.collection('sessions').doc(id), backupSessions[id]!.__data),
    ),
  );
  console.log(`\nRestored ${toRestore.length} session(s).`);
  process.exit(0);
}

main().catch((err) => {
  console.error('Restore failed:', err);
  process.exit(1);
});

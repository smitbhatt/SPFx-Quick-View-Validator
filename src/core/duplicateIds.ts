import { IdReference } from './jsonDocument';

export interface DuplicateIdGroup {
  id: string;
  /** All occurrences of the ID, ordered by document position. */
  occurrences: IdReference[];
}

/** Groups `id` occurrences and returns every group that appears more than once. */
export function findDuplicateIds(ids: IdReference[]): DuplicateIdGroup[] {
  const byValue = new Map<string, IdReference[]>();
  for (const id of ids) {
    const list = byValue.get(id.value);
    if (list) {
      list.push(id);
    } else {
      byValue.set(id.value, [id]);
    }
  }

  const duplicates: DuplicateIdGroup[] = [];
  for (const [value, occurrences] of byValue) {
    if (occurrences.length > 1) {
      occurrences.sort((a, b) => a.offset - b.offset);
      duplicates.push({ id: value, occurrences });
    }
  }
  duplicates.sort((a, b) => a.occurrences[0].offset - b.occurrences[0].offset);
  return duplicates;
}

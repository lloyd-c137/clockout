import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { ScheduleTask } from '../app/src/scheduler.ts';
import {
  calculateInsertionPreview,
  cloneSchedule,
  moveTaskToDay,
  planDay
} from '../app/src/scheduler.ts';

let seed = 0;
function task(title: string, durationSlots: number, options: Partial<ScheduleTask> = {}): ScheduleTask {
  seed += 1;
  return {
    id: title,
    title,
    durationSlots,
    type: 'normal',
    status: 'todo',
    locked: false,
    day: 'today',
    createdAt: seed,
    ...options
  };
}

function ids(schedule: ScheduleTask[], day: 'today' | 'tomorrow' = 'today') {
  return planDay(schedule, day).placements.map((placement) => placement.task.id);
}

// 1. One-slot task inserts before a four-slot task and everything follows once.
const inserted = calculateInsertionPreview([task('A', 4), task('B', 1), task('C', 2)], 'B', 0, 0);
assert.deepEqual(ids(inserted), ['B', 'A', 'C']);

// 2. A four-slot task remains time-contiguous across a row boundary.
const crossRow = planDay([task('lead', 5), task('long', 4)]);
assert.deepEqual(crossRow.placements.find((item) => item.task.id === 'long')?.visibleSlots, [5, 6, 7, 8]);

// 3. Dropping in the past snaps the dragged task to the first future slot.
const pastSchedule = [task('past', 4), task('future-a', 2), task('future-b', 2)];
const pastPreview = calculateInsertionPreview(pastSchedule, 'future-b', 0, 4);
assert.ok((planDay(pastPreview, 'today', 4, 4).placements.find((item) => item.task.id === 'future-b')?.startSlot || 0) >= 4);

// 4. Re-entering the same insertion group produces an identical preview.
assert.deepEqual(
  calculateInsertionPreview(pastSchedule, 'future-b', 5, 4).map((item) => item.id),
  calculateInsertionPreview(pastSchedule, 'future-b', 5, 4).map((item) => item.id)
);

// 5. A drag snapshot is complete and isolated from preview changes.
const snapshot = cloneSchedule(pastSchedule);
const changed = calculateInsertionPreview(snapshot, 'future-b', 4, 4);
assert.deepEqual(snapshot.map((item) => item.id), ['past', 'future-a', 'future-b']);
assert.notStrictEqual(snapshot, changed);

// 6. Capacity overflow is retained and measured instead of discarded.
const overflow = planDay([task('wide-a', 20), task('wide-b', 20)]);
assert.equal(overflow.overflowSlots, 4);
assert.deepEqual(overflow.overflowTaskIds, ['wide-b']);

// 7. Delaying moves only the selected task to tomorrow.
const delayed = moveTaskToDay([task('keep-a', 2), task('delay-me', 3), task('keep-b', 2)], 'delay-me', 'tomorrow');
assert.deepEqual(delayed.filter((item) => item.day === 'today').map((item) => item.id), ['keep-a', 'keep-b']);
assert.deepEqual(delayed.filter((item) => item.day === 'tomorrow').map((item) => item.id), ['delay-me']);

// 8. Locked task keeps its slot while flexible tasks route around it.
const locked = task('meeting', 4, { type: 'meeting', locked: true, fixedStartSlot: 6 });
const lockedPreview = calculateInsertionPreview([task('A2', 4), locked, task('C2', 5)], 'C2', 0, 0);
assert.equal(planDay(lockedPreview).placements.find((item) => item.task.id === 'meeting')?.startSlot, 6);

// 9. A full snapshot restores order, duration and day.
const undoSource = [task('undo-a', 1), task('undo-b', 4, { day: 'tomorrow' })];
const undoSnapshot = cloneSchedule(undoSource);
const mutated = moveTaskToDay(undoSource.map((item) => item.id === 'undo-a' ? { ...item, durationSlots: 3 } : item), 'undo-b', 'today');
assert.notDeepEqual(mutated, undoSnapshot);
assert.deepEqual(cloneSchedule(undoSnapshot), undoSource);

// 10. Three fast reorder calculations never duplicate or lose a task.
let rapid = [task('r1', 1), task('r2', 2), task('r3', 3), task('r4', 4)];
rapid = calculateInsertionPreview(rapid, 'r4', 0, 0);
rapid = calculateInsertionPreview(rapid, 'r1', 8, 0);
rapid = calculateInsertionPreview(rapid, 'r3', 1, 0);
assert.equal(new Set(rapid.map((item) => item.id)).size, 4);
assert.equal(rapid.length, 4);

// 11. The committed task model survives a storage round trip without layout coordinates.
const reopened = JSON.parse(JSON.stringify(rapid)) as ScheduleTask[];
assert.equal(scheduleShape(reopened), scheduleShape(rapid));
assert.ok(reopened.every((item) => !('x' in item) && !('y' in item)));

// 12. Drag visuals use only the requested quiet transform/opacity transition.
const css = readFileSync(new URL('../app/src/styles.css', import.meta.url), 'utf8');
const schedulerCellCss = css.match(/\.task-piece-layer \.board-cell \{([\s\S]*?)\}/)?.[1] || '';
assert.match(schedulerCellCss, /transform 180ms ease, opacity 180ms ease/);
assert.doesNotMatch(schedulerCellCss, /animation|filter|rotate|glow/i);

console.log('scheduler-tests: 12/12 passed');

function scheduleShape(schedule: ScheduleTask[]) {
  return schedule.map((item) => `${item.id}:${item.durationSlots}:${item.day}:${item.status}:${item.locked}`).join('|');
}

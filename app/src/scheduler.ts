export type TaskType = 'normal' | 'meeting' | 'ai' | 'urgent' | 'waiting' | 'temporary';
export type TaskStatus = 'todo' | 'doing' | 'done';
export type TaskDay = 'today' | 'tomorrow';

export type ScheduleTask = {
  id: string;
  title: string;
  durationSlots: number;
  type: TaskType;
  status: TaskStatus;
  locked: boolean;
  day: TaskDay;
  fixedStartSlot?: number;
  actualSlots?: number;
  deadline?: string;
  assignee?: string;
  priority?: number;
  published?: boolean;
  createdAt?: number;
};

export type TaskPlacement = {
  task: ScheduleTask;
  startSlot: number;
  endSlot: number;
  visibleSlots: number[];
  overflowSlots: number;
};

export type DayPlan = {
  placements: TaskPlacement[];
  cellMap: Map<number, { task: ScheduleTask; offset: number }>;
  overflowSlots: number;
  overflowTaskIds: string[];
  totalSlots: number;
};

export const BOARD_SLOTS = 36;

function duration(task: ScheduleTask) {
  return Math.max(1, Math.round(task.durationSlots));
}

function overlaps(start: number, length: number, reserved: Array<{ start: number; end: number }>) {
  const end = start + length;
  return reserved.find((range) => start < range.end && end > range.start);
}

function buildPlan(dayTasks: ScheduleTask[], minimumFlexibleSlot: number): DayPlan {
  const reserved = dayTasks
    .filter((task) => task.locked && Number.isFinite(task.fixedStartSlot))
    .map((task) => ({
      task,
      start: Math.max(0, Math.round(task.fixedStartSlot || 0)),
      end: Math.max(0, Math.round(task.fixedStartSlot || 0)) + duration(task)
    }))
    .sort((a, b) => a.start - b.start);
  const placements: TaskPlacement[] = [];
  let cursor = Math.max(0, minimumFlexibleSlot);

  for (const task of dayTasks) {
    const slots = duration(task);
    let startSlot: number;
    if (task.locked && Number.isFinite(task.fixedStartSlot)) {
      startSlot = Math.max(0, Math.round(task.fixedStartSlot || 0));
    } else {
      startSlot = cursor;
      let collision = overlaps(startSlot, slots, reserved.filter((range) => range.task.id !== task.id));
      while (collision) {
        startSlot = collision.end;
        collision = overlaps(startSlot, slots, reserved.filter((range) => range.task.id !== task.id));
      }
    }
    const endSlot = startSlot + slots;
    const visibleStart = Math.max(0, startSlot);
    const visibleEnd = Math.min(BOARD_SLOTS, endSlot);
    placements.push({
      task,
      startSlot,
      endSlot,
      visibleSlots: Array.from({ length: Math.max(0, visibleEnd - visibleStart) }, (_, index) => visibleStart + index),
      overflowSlots: Math.max(0, endSlot - BOARD_SLOTS)
    });
    cursor = Math.max(cursor, endSlot);
  }

  placements.sort((a, b) => a.startSlot - b.startSlot || (a.task.createdAt || 0) - (b.task.createdAt || 0));
  const cellMap = new Map<number, { task: ScheduleTask; offset: number }>();
  placements.forEach((placement) => {
    placement.visibleSlots.forEach((slot) => cellMap.set(slot, { task: placement.task, offset: slot - placement.startSlot }));
  });
  const overflowTaskIds = placements.filter((placement) => placement.overflowSlots > 0).map((placement) => placement.task.id);
  return {
    placements,
    cellMap,
    overflowSlots: placements.reduce((sum, placement) => sum + placement.overflowSlots, 0),
    overflowTaskIds,
    totalSlots: Math.max(0, ...placements.map((placement) => placement.endSlot))
  };
}

export function planDay(
  schedule: ScheduleTask[],
  day: TaskDay = 'today',
  minimumFlexibleSlot = 0,
  lockBeforeSlot = 0
): DayPlan {
  const dayTasks = schedule.filter((task) => task.day === day && task.status !== 'done');
  if (day !== 'today' || lockBeforeSlot <= 0) return buildPlan(dayTasks, minimumFlexibleSlot);
  const baseline = buildPlan(dayTasks, 0);
  const anchored = dayTasks.map((task) => {
    const placement = baseline.placements.find((item) => item.task.id === task.id);
    if (!placement || placement.startSlot >= lockBeforeSlot) return task;
    return { ...task, locked: true, fixedStartSlot: placement.startSlot };
  });
  return buildPlan(anchored, minimumFlexibleSlot);
}

function replaceDay(schedule: ScheduleTask[], day: TaskDay, reordered: ScheduleTask[]) {
  const ids = new Set(schedule.filter((task) => task.day === day && task.status !== 'done').map((task) => task.id));
  const output: ScheduleTask[] = [];
  let inserted = false;
  schedule.forEach((task) => {
    if (!ids.has(task.id)) {
      output.push(task);
      return;
    }
    if (!inserted) {
      output.push(...reordered);
      inserted = true;
    }
  });
  if (!inserted) output.push(...reordered);
  return output;
}

export function normalizeDayOrder(schedule: ScheduleTask[], day: TaskDay = 'today', currentSlot = 0) {
  const plan = planDay(schedule, day, currentSlot, currentSlot);
  const originals = new Map(schedule.map((task) => [task.id, task]));
  return replaceDay(schedule, day, plan.placements.map((placement) => originals.get(placement.task.id) || placement.task));
}

export function moveTaskToDay(schedule: ScheduleTask[], taskId: string, day: TaskDay) {
  const moved = schedule.map((task) => task.id === taskId ? {
    ...task,
    day,
    fixedStartSlot: day === 'tomorrow' ? undefined : task.fixedStartSlot
  } : task);
  return normalizeDayOrder(moved, day);
}

export function calculateInsertionPreview(
  schedule: ScheduleTask[],
  taskId: string,
  requestedSlot: number,
  currentSlot: number
) {
  const source = schedule.find((task) => task.id === taskId);
  if (!source || source.status === 'done') return schedule;
  const targetSlot = Math.max(Math.min(BOARD_SLOTS, Math.floor(requestedSlot)), Math.max(0, currentSlot));
  const moved = { ...source, day: 'today' as const, fixedStartSlot: source.locked ? source.fixedStartSlot : undefined };
  const without = schedule.filter((task) => task.id !== taskId);
  const today = without.filter((task) => task.day === 'today' && task.status !== 'done');
  const targetPlan = planDay(without, 'today', currentSlot, currentSlot);
  const targetPlacement = targetPlan.placements.find((placement) => targetSlot >= placement.startSlot && targetSlot < placement.endSlot);
  let insertAt = today.length;

  if (targetPlacement) {
    const targetIndex = today.findIndex((task) => task.id === targetPlacement.task.id);
    const midpoint = targetPlacement.startSlot + (targetPlacement.endSlot - targetPlacement.startSlot) / 2;
    insertAt = targetIndex + (targetSlot >= midpoint ? 1 : 0);
  } else {
    const nextPlacement = targetPlan.placements.find((placement) => placement.startSlot >= targetSlot);
    if (nextPlacement) insertAt = today.findIndex((task) => task.id === nextPlacement.task.id);
  }

  const firstFutureIndex = today.findIndex((task) => {
    const placement = targetPlan.placements.find((item) => item.task.id === task.id);
    return placement && placement.startSlot >= currentSlot;
  });
  if (firstFutureIndex >= 0 && targetSlot <= currentSlot) insertAt = firstFutureIndex;
  insertAt = Math.max(0, Math.min(today.length, insertAt));
  today.splice(insertAt, 0, moved);
  return normalizeDayOrder(replaceDay(without, 'today', today), 'today', currentSlot);
}

export function isTaskDraggable(task: ScheduleTask, plan: DayPlan, currentSlot: number) {
  if (task.status === 'done' || task.locked || task.status === 'doing') return false;
  if (task.day === 'tomorrow') return true;
  const placement = plan.placements.find((item) => item.task.id === task.id);
  return Boolean(placement && placement.startSlot >= currentSlot);
}

export function cloneSchedule(schedule: ScheduleTask[]) {
  return schedule.map((task) => ({ ...task }));
}

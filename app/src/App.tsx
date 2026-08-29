import { FormEvent, PointerEvent as ReactPointerEvent, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  BOARD_SLOTS,
  DayPlan,
  ScheduleTask,
  TaskDay,
  TaskType,
  calculateInsertionPreview,
  cloneSchedule,
  isTaskDraggable,
  moveTaskToDay,
  normalizeDayOrder,
  planDay
} from './scheduler';

type Mode = 'mini' | 'board' | 'detail';

type Settings = {
  start: string;
  end: string;
  hourlyWage: number;
  overtimeRate: number;
};

type DragUi = {
  taskId: string;
  active: boolean;
  x: number;
  y: number;
  valid: boolean;
  target: 'board' | 'tomorrow' | null;
  originSlots: number[];
};

type DragRuntime = DragUi & {
  startX: number;
  startY: number;
  snapshot: ScheduleTask[];
  lastSignature: string;
};

type PendingOverflow = {
  snapshot: ScheduleTask[];
  preview: ScheduleTask[];
  taskId: string;
  overflowSlots: number;
};

type UndoRecord = {
  schedule: ScheduleTask[];
  extraComp: number;
};

const STORAGE_KEY = 'clockout.schedule.v8';
const SETTINGS_KEY = 'clockout.settings.v8';
const COMP_KEY = 'clockout.comp.v8';

const TYPE_META: Record<TaskType, { label: string }> = {
  normal: { label: '普通任务' },
  meeting: { label: '会议沟通' },
  ai: { label: 'AI协助' },
  urgent: { label: '紧急任务' },
  waiting: { label: '等待审批' },
  temporary: { label: '临时任务' }
};

const DEFAULT_SETTINGS: Settings = {
  start: '09:00',
  end: '18:00',
  hourlyWage: 60,
  overtimeRate: 1.5
};

const DEFAULT_SCHEDULE: ScheduleTask[] = [
  makeTask('回复客户邮件', 2, 'normal', { deadline: '10:00' }),
  makeTask('产品周会', 4, 'meeting', { deadline: '11:30', locked: true, fixedStartSlot: 4 }),
  makeTask('AI整理访谈', 3, 'ai', { deadline: '14:00' }),
  makeTask('等待预算审批', 2, 'waiting', { deadline: '15:00' }),
  makeTask('修复登录异常', 4, 'urgent', { deadline: '17:00' }),
  makeTask('提交今日小结', 1, 'normal', { deadline: '17:30' }),
  makeTask('准备明日站会', 2, 'meeting', { day: 'tomorrow', deadline: '09:30' })
];

function makeTask(
  title: string,
  durationSlots: number,
  type: TaskType,
  options: Partial<ScheduleTask> = {}
): ScheduleTask {
  return {
    id: 'task-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8),
    title,
    durationSlots: Math.max(1, Math.round(durationSlots)),
    type,
    status: 'todo',
    locked: false,
    day: 'today',
    actualSlots: 0,
    deadline: '17:00',
    createdAt: Date.now() + Math.random(),
    ...options
  };
}

function loadState<T>(key: string, fallback: T): T {
  try {
    const value = localStorage.getItem(key);
    return value ? JSON.parse(value) as T : fallback;
  } catch {
    return fallback;
  }
}

function loadSchedule(): ScheduleTask[] {
  const current = loadState<ScheduleTask[] | null>(STORAGE_KEY, null);
  if (current?.length) return current.map((task) => ({ ...task, durationSlots: Math.max(1, task.durationSlots) }));
  const legacy = loadState<Array<Record<string, unknown>> | null>('clockout.tasks.v7', null);
  if (!legacy?.length) return DEFAULT_SCHEDULE;
  let cursor = 0;
  return legacy.map((item) => {
    const type = item.kind === 'boss' ? 'temporary' : String(item.kind || 'normal') as TaskType;
    const durationSlots = Math.max(1, Math.ceil(Number(item.minutes || 15) / 15));
    const locked = type === 'meeting';
    const task = makeTask(String(item.title || '未命名任务'), durationSlots, type, {
      id: String(item.id || crypto.randomUUID()),
      status: item.completed ? 'done' : 'todo',
      locked,
      fixedStartSlot: locked ? cursor : undefined,
      deadline: String(item.deadline || '17:00'),
      createdAt: Number(item.createdAt || Date.now())
    });
    cursor += durationSlots;
    return task;
  });
}

function clockMinutes(value: string): number {
  const [hours, minutes] = value.split(':').map(Number);
  return hours * 60 + minutes;
}

function currentMinutes(now: Date): number {
  return now.getHours() * 60 + now.getMinutes() + now.getSeconds() / 60;
}

function formatCountdown(totalSeconds: number): string {
  const safe = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const seconds = safe % 60;
  return [hours, minutes, seconds].map((value) => String(value).padStart(2, '0')).join(':');
}

function estimateSlots(title: string): number {
  if (/会议|沟通|同步|电话/.test(title)) return 4;
  if (/邮件|回复|确认|小结/.test(title)) return 2;
  if (/修复|bug|异常|调试/i.test(title)) return 4;
  if (/方案|页面|设计|原型/.test(title)) return 6;
  if (/开发|功能|重构/.test(title)) return 8;
  if (/审批|等待/.test(title)) return 2;
  return 3;
}

function scheduleSignature(schedule: ScheduleTask[]) {
  return schedule.map((task) => `${task.id}:${task.day}:${task.durationSlots}`).join('|');
}

export default function App() {
  const [mode, setMode] = useState<Mode>('mini');
  const [appExited, setAppExited] = useState(false);
  const [committedSchedule, setCommittedSchedule] = useState<ScheduleTask[]>(loadSchedule);
  const [previewSchedule, setPreviewSchedule] = useState<ScheduleTask[] | null>(null);
  const [settings, setSettings] = useState<Settings>(() => loadState(SETTINGS_KEY, DEFAULT_SETTINGS));
  const [extraComp, setExtraComp] = useState<number>(() => loadState(COMP_KEY, 0));
  const [now, setNow] = useState(new Date());
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [showTaskModal, setShowTaskModal] = useState(false);
  const [dragUi, setDragUi] = useState<DragUi | null>(null);
  const [pendingOverflow, setPendingOverflow] = useState<PendingOverflow | null>(null);
  const [undoRecord, setUndoRecord] = useState<UndoRecord | null>(null);
  const [undoMessage, setUndoMessage] = useState('');
  const [completingTaskId, setCompletingTaskId] = useState<string | null>(null);
  const dragRuntime = useRef<DragRuntime | null>(null);
  const committedRef = useRef(committedSchedule);
  const previewRef = useRef<ScheduleTask[] | null>(previewSchedule);
  const extraCompRef = useRef(extraComp);
  const undoTimer = useRef<number | null>(null);
  const hostIsDesktop = Boolean(window.desktopWidget);

  committedRef.current = committedSchedule;
  previewRef.current = previewSchedule;
  extraCompRef.current = extraComp;

  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => localStorage.setItem(STORAGE_KEY, JSON.stringify(committedSchedule)), [committedSchedule]);
  useEffect(() => localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)), [settings]);
  useEffect(() => localStorage.setItem(COMP_KEY, JSON.stringify(extraComp)), [extraComp]);

  const startMinute = clockMinutes(settings.start);
  const endMinute = clockMinutes(settings.end);
  const workDuration = Math.max(1, endMinute - startMinute);
  const minuteNow = currentMinutes(now);
  const progress = Math.max(0, Math.min(1, (minuteNow - startMinute) / workDuration));
  const currentSlot = Math.max(0, Math.min(BOARD_SLOTS, Math.floor((minuteNow - startMinute) / 15)));
  const secondsUntilEnd = Math.max(0, (endMinute - minuteNow) * 60);
  const activeSchedule = previewSchedule || committedSchedule;
  const todayPlan = useMemo(() => planDay(activeSchedule, 'today', currentSlot, currentSlot), [activeSchedule, currentSlot]);
  const committedPlan = useMemo(() => planDay(committedSchedule, 'today', currentSlot, currentSlot), [committedSchedule, currentSlot]);
  const tomorrowPlan = useMemo(() => planDay(activeSchedule, 'tomorrow'), [activeSchedule]);
  const selectedTask = activeSchedule.find((task) => task.id === selectedTaskId) || null;
  const remainingSlots = committedSchedule
    .filter((task) => task.day === 'today' && task.status !== 'done')
    .reduce((sum, task) => sum + task.durationSlots, 0);
  const elapsedPaidMinutes = Math.max(0, Math.min(workDuration, minuteNow - startMinute));
  const todayWage = settings.hourlyWage * elapsedPaidMinutes / 60;
  const overtimeSlots = Math.max(0, committedPlan.totalSlots - BOARD_SLOTS);
  const isOvertime = overtimeSlots > 0;
  const isAlmostOff = secondsUntilEnd > 0 && secondsUntilEnd <= 1800;

  useEffect(() => {
    if (window.desktopWidget) void window.desktopWidget.updateTrayCountdown(secondsUntilEnd);
  }, [secondsUntilEnd]);

  useEffect(() => window.desktopWidget?.onModeChanged((nextMode) => setMode(nextMode)), []);

  function showUndo(message: string, before: UndoRecord) {
    setUndoRecord(before);
    setUndoMessage(message);
    if (undoTimer.current) window.clearTimeout(undoTimer.current);
    undoTimer.current = window.setTimeout(() => {
      setUndoRecord(null);
      setUndoMessage('');
    }, 5000);
  }

  function updatePreview(next: ScheduleTask[] | null) {
    previewRef.current = next;
    setPreviewSchedule(next);
  }

  function commit(nextSchedule: ScheduleTask[], message: string, nextComp = extraCompRef.current, before?: UndoRecord) {
    const previous = before || { schedule: cloneSchedule(committedRef.current), extraComp: extraCompRef.current };
    const normalized = normalizeDayOrder(nextSchedule, 'today', currentSlot);
    setCommittedSchedule(normalized);
    committedRef.current = normalized;
    updatePreview(null);
    setPendingOverflow(null);
    setExtraComp(nextComp);
    extraCompRef.current = nextComp;
    showUndo(message, previous);
  }

  function undo() {
    if (!undoRecord) return;
    setCommittedSchedule(cloneSchedule(undoRecord.schedule));
    committedRef.current = cloneSchedule(undoRecord.schedule);
    setExtraComp(undoRecord.extraComp);
    extraCompRef.current = undoRecord.extraComp;
    updatePreview(null);
    setPendingOverflow(null);
    setUndoRecord(null);
    setUndoMessage('');
    if (undoTimer.current) window.clearTimeout(undoTimer.current);
  }

  function removeDragListeners() {
    window.removeEventListener('pointermove', handleGlobalPointerMove);
    window.removeEventListener('pointerup', handleGlobalPointerUp);
    window.removeEventListener('pointercancel', cancelDrag);
  }

  function clearDrag(keepPreview = false) {
    removeDragListeners();
    dragRuntime.current = null;
    setDragUi(null);
    if (!keepPreview) updatePreview(null);
  }

  function cancelDrag() {
    clearDrag(false);
  }

  function beginTaskPointer(event: ReactPointerEvent, task: ScheduleTask) {
    if (event.button !== 0 || pendingOverflow) return;
    const canDrag = task.day === 'tomorrow'
      ? task.status === 'todo' && !task.locked
      : isTaskDraggable(task, committedPlan, currentSlot);
    if (!canDrag) {
      setSelectedTaskId(task.id);
      return;
    }
    event.preventDefault();
    const originPlacement = committedPlan.placements.find((placement) => placement.task.id === task.id);
    const runtime: DragRuntime = {
      taskId: task.id,
      active: false,
      x: event.clientX,
      y: event.clientY,
      startX: event.clientX,
      startY: event.clientY,
      valid: false,
      target: null,
      originSlots: originPlacement?.visibleSlots || [],
      snapshot: cloneSchedule(committedRef.current),
      lastSignature: ''
    };
    dragRuntime.current = runtime;
    setDragUi(runtime);
    window.addEventListener('pointermove', handleGlobalPointerMove);
    window.addEventListener('pointerup', handleGlobalPointerUp);
    window.addEventListener('pointercancel', cancelDrag);
  }

  function handleGlobalPointerMove(event: PointerEvent) {
    const runtime = dragRuntime.current;
    if (!runtime) return;
    const distance = Math.hypot(event.clientX - runtime.startX, event.clientY - runtime.startY);
    if (!runtime.active && distance <= 5) return;
    runtime.active = true;
    runtime.x = event.clientX;
    runtime.y = event.clientY;
    const element = document.elementFromPoint(event.clientX, event.clientY) as HTMLElement | null;
    const dropZone = element?.closest<HTMLElement>('[data-drop-zone]')?.dataset.dropZone;
    const slotElement = element?.closest<HTMLElement>('[data-slot]');
    let next: ScheduleTask[] | null = null;
    let target: DragUi['target'] = null;

    if (dropZone === 'tomorrow' && runtime.snapshot.find((task) => task.id === runtime.taskId)?.day === 'today') {
      next = moveTaskToDay(runtime.snapshot, runtime.taskId, 'tomorrow');
      target = 'tomorrow';
    } else if (slotElement) {
      const slot = Number(slotElement.dataset.slot || 0);
      next = calculateInsertionPreview(runtime.snapshot, runtime.taskId, slot, currentSlot);
      target = 'board';
    }

    if (next) {
      const signature = scheduleSignature(next);
      if (signature !== runtime.lastSignature) {
        runtime.lastSignature = signature;
        updatePreview(next);
      }
      runtime.valid = true;
      runtime.target = target;
    } else {
      runtime.valid = false;
      runtime.target = null;
    }
    setDragUi({ ...runtime });
  }

  function handleGlobalPointerUp() {
    const runtime = dragRuntime.current;
    if (!runtime) return;
    if (!runtime.active) {
      setSelectedTaskId(runtime.taskId);
      clearDrag(false);
      return;
    }
    if (!runtime.valid || !previewRef.current) {
      clearDrag(false);
      return;
    }
    const next = cloneSchedule(previewRef.current);
    const previewPlan = planDay(next, 'today', currentSlot, currentSlot);
    if (runtime.target === 'tomorrow') {
      commit(next, '已移到明天', extraCompRef.current, { schedule: runtime.snapshot, extraComp: extraCompRef.current });
      clearDrag(true);
      return;
    }
    if (previewPlan.overflowSlots > 0) {
      setPendingOverflow({
        snapshot: runtime.snapshot,
        preview: next,
        taskId: runtime.taskId,
        overflowSlots: previewPlan.overflowSlots
      });
      clearDrag(true);
      return;
    }
    commit(next, '已调整今日安排', extraCompRef.current, { schedule: runtime.snapshot, extraComp: extraCompRef.current });
    clearDrag(true);
  }

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z') {
        event.preventDefault();
        undo();
        return;
      }
      if (event.key !== 'Escape') return;
      if (dragRuntime.current) cancelDrag();
      else if (pendingOverflow) { setPendingOverflow(null); updatePreview(null); }
      else if (showTaskModal) setShowTaskModal(false);
      else if (selectedTaskId) setSelectedTaskId(null);
      else if (mode === 'detail') void switchMode('board');
      else if (mode === 'board') void switchMode('mini');
    };
    const onBlur = () => { if (dragRuntime.current) cancelDrag(); };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('blur', onBlur);
    };
  }, [mode, pendingOverflow, selectedTaskId, showTaskModal, undoRecord]);

  async function switchMode(nextMode: Mode) {
    setSelectedTaskId(null);
    cancelDrag();
    if (window.desktopWidget) await window.desktopWidget.setMode(nextMode);
    setMode(nextMode);
  }

  function quitApp() {
    cancelDrag();
    if (window.desktopWidget) window.desktopWidget.quit();
    else setAppExited(true);
  }

  function addTask(task: ScheduleTask) {
    const before = cloneSchedule(committedRef.current);
    const candidate = normalizeDayOrder([...before, task], 'today', currentSlot);
    const plan = planDay(candidate, 'today', currentSlot, currentSlot);
    if (task.day === 'today' && plan.overflowSlots > 0) {
      updatePreview(candidate);
      setPendingOverflow({ snapshot: before, preview: candidate, taskId: task.id, overflowSlots: plan.overflowSlots });
      return;
    }
    commit(candidate, task.day === 'today' ? '已加入今日安排' : '已加入明日安排');
  }

  function markDone(taskId: string) {
    setCompletingTaskId(taskId);
    window.setTimeout(() => {
      const next = committedRef.current.map((task) => task.id === taskId ? {
        ...task,
        status: 'done' as const,
        actualSlots: task.actualSlots || task.durationSlots
      } : task);
      commit(next, '任务已完成');
      setCompletingTaskId(null);
      setSelectedTaskId(null);
    }, 200);
  }

  function toggleLock(taskId: string) {
    const plan = planDay(committedRef.current, 'today', currentSlot, currentSlot);
    const placement = plan.placements.find((item) => item.task.id === taskId);
    const next = committedRef.current.map((task) => task.id === taskId ? {
      ...task,
      locked: !task.locked,
      fixedStartSlot: task.locked ? undefined : placement?.startSlot
    } : task);
    commit(next, next.find((task) => task.id === taskId)?.locked ? '任务时间已锁定' : '任务时间已解锁');
  }

  function splitTask(taskId: string) {
    const source = committedRef.current.find((task) => task.id === taskId);
    if (!source || source.durationSlots < 2 || source.locked) return;
    const firstSlots = Math.ceil(source.durationSlots / 2);
    const secondSlots = source.durationSlots - firstSlots;
    const first = { ...source, id: source.id + '-a-' + Date.now(), title: source.title + '·准备', durationSlots: firstSlots };
    const second = { ...source, id: source.id + '-b-' + Date.now(), title: source.title + '·执行', durationSlots: Math.max(1, secondSlots) };
    const next = committedRef.current.flatMap((task) => task.id === taskId ? [first, second] : [task]);
    commit(next, '已拆分任务');
  }

  function requestTemporaryTask() {
    addTask(makeTask('老板临时改方案', 3, 'temporary', { deadline: settings.end }));
  }

  function resolveOverflow(action: 'tomorrow' | 'resize' | 'replace' | 'overtime' | 'cancel') {
    if (!pendingOverflow) return;
    const { snapshot, preview, taskId, overflowSlots: exceeded } = pendingOverflow;
    if (action === 'cancel') {
      setPendingOverflow(null);
      updatePreview(null);
      return;
    }
    if (action === 'tomorrow') {
      const next = moveTaskToDay(snapshot, taskId, 'tomorrow');
      commit(next, '已移到明天', extraCompRef.current, { schedule: snapshot, extraComp: extraCompRef.current });
      return;
    }
    if (action === 'resize') {
      const next = preview.map((task) => task.id === taskId ? {
        ...task,
        durationSlots: Math.max(1, task.durationSlots - exceeded)
      } : task);
      commit(next, '已调整任务时长', extraCompRef.current, { schedule: snapshot, extraComp: extraCompRef.current });
      return;
    }
    if (action === 'replace') {
      const plan = planDay(preview, 'today', currentSlot, currentSlot);
      const candidate = [...plan.placements]
        .reverse()
        .map((placement) => placement.task)
        .find((task) => task.id !== taskId && !task.locked && task.status === 'todo');
      if (!candidate) return;
      const next = moveTaskToDay(preview, candidate.id, 'tomorrow');
      if (planDay(next, 'today', currentSlot, currentSlot).overflowSlots > 0) return;
      commit(next, '已替换并延后原任务', extraCompRef.current, { schedule: snapshot, extraComp: extraCompRef.current });
      return;
    }
    const compensation = exceeded * 15 / 60 * settings.hourlyWage * settings.overtimeRate;
    commit(preview, '已确认加班与补偿', extraCompRef.current + compensation, { schedule: snapshot, extraComp: extraCompRef.current });
  }

  const miniWidget = (
    <section className={'mini-clock-shell ' + (isAlmostOff || isOvertime ? 'almost-off' : '')} onDoubleClick={() => void switchMode('board')}>
      <span className="mini-drag-zone drag-surface" aria-hidden="true" />
      <strong>{secondsUntilEnd <= 0 ? '可以走了' : formatCountdown(secondsUntilEnd)}</strong>
      <WindowControls mode="mini" onMini={() => void switchMode('mini')} onBoard={() => void switchMode('board')} onDetail={() => void switchMode('detail')} onQuit={quitApp} />
    </section>
  );

  const boardWidget = (
    <section className="tetris-board-widget">
      <header className="board-widget-top drag-surface">
        <span>WORK BLOCKS</span>
        <WindowControls mode="board" onMini={() => void switchMode('mini')} onBoard={() => void switchMode('board')} onDetail={() => void switchMode('detail')} onQuit={quitApp} />
      </header>
      <div className="board-widget-layout">
        <TaskBoard
          plan={todayPlan}
          currentSlot={currentSlot}
          progress={progress}
          selectedTask={selectedTask}
          completingTaskId={completingTaskId}
          dragUi={dragUi}
          onSelectTask={setSelectedTaskId}
          onDone={markDone}
          onToggleLock={toggleLock}
          onPointerDownTask={beginTaskPointer}
        />
        <aside className="board-score-column">
          <span className="score-label">距离下班</span>
          <strong className="score-countdown">{secondsUntilEnd <= 0 ? '可以走了' : formatCountdown(secondsUntilEnd)}</strong>
          <div className="score-divider" />
          <span className="score-label">今日工资</span>
          <b className="score-wage">¥ {todayWage.toFixed(2)}</b>
          <span className="score-label">额外补偿</span>
          <b className="score-extra">＋¥ {extraComp.toFixed(2)}</b>
          <small>{new Date(now).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })} · 剩余{remainingSlots}格</small>
        </aside>
      </div>
      {pendingOverflow && <OverflowDecision pending={pendingOverflow} onResolve={resolveOverflow} />}
    </section>
  );

  if (appExited) return null;

  return (
    <main className={hostIsDesktop ? 'desktop-host' : 'web-stage'}>
      {mode === 'mini' ? miniWidget : mode === 'board' ? boardWidget : <DetailView
        schedule={activeSchedule}
        committedPlan={committedPlan}
        todayPlan={todayPlan}
        tomorrowPlan={tomorrowPlan}
        currentSlot={currentSlot}
        progress={progress}
        selectedTask={selectedTask}
        completingTaskId={completingTaskId}
        dragUi={dragUi}
        pendingOverflow={pendingOverflow}
        settings={settings}
        extraComp={extraComp}
        todayWage={todayWage}
        remainingSlots={remainingSlots}
        onMini={() => void switchMode('mini')}
        onCollapse={() => void switchMode('board')}
        onQuit={quitApp}
        onAdd={() => setShowTaskModal(true)}
        onTemporary={requestTemporaryTask}
        onSettings={setSettings}
        onSelectTask={setSelectedTaskId}
        onDone={markDone}
        onToggleLock={toggleLock}
        onSplit={splitTask}
        onPointerDownTask={beginTaskPointer}
        onResolveOverflow={resolveOverflow}
      />}
      {dragUi?.active && <DragGhost task={activeSchedule.find((task) => task.id === dragUi.taskId)} x={dragUi.x} y={dragUi.y} valid={dragUi.valid} />}
      {showTaskModal && <TaskModal onClose={() => setShowTaskModal(false)} onAdd={(task) => { addTask(task); setShowTaskModal(false); }} />}
      {undoRecord && <div className="undo-toast"><span>{undoMessage}</span><button type="button" onClick={undo}>撤销</button></div>}
    </main>
  );
}

function TaskBoard(props: {
  plan: DayPlan;
  currentSlot: number;
  progress: number;
  selectedTask: ScheduleTask | null;
  completingTaskId: string | null;
  dragUi: DragUi | null;
  onSelectTask: (id: string | null) => void;
  onDone: (id: string) => void;
  onToggleLock: (id: string) => void;
  onPointerDownTask: (event: ReactPointerEvent, task: ScheduleTask) => void;
}) {
  const pieces = props.plan.placements.flatMap((placement) => placement.visibleSlots.map((slot) => ({
    slot,
    offset: slot - placement.startSlot,
    task: placement.task,
    placement
  })));
  const pieceRefs = useRef(new Map<string, HTMLButtonElement>());
  const previousRects = useRef(new Map<string, DOMRect>());

  useLayoutEffect(() => {
    const nextRects = new Map<string, DOMRect>();
    pieceRefs.current.forEach((element, key) => {
      const next = element.getBoundingClientRect();
      nextRects.set(key, next);
      const previous = previousRects.current.get(key);
      if (!previous || props.dragUi?.taskId === key.split(':')[0]) return;
      const deltaX = previous.left - next.left;
      const deltaY = previous.top - next.top;
      if (Math.abs(deltaX) < 1 && Math.abs(deltaY) < 1) return;
      element.style.transition = 'none';
      element.style.transform = `translate(${deltaX}px, ${deltaY}px)`;
      requestAnimationFrame(() => {
        element.style.transition = 'transform 180ms ease, opacity 180ms ease';
        element.style.transform = '';
      });
    });
    previousRects.current = nextRects;
  }, [props.plan, props.dragUi?.taskId]);

  return <div className="schedule-board-wrap">
    <div className="task-board schedule-board" aria-label="09:00到18:00的36格任务棋盘">
      <div className="board-base-layer">
        {Array.from({ length: BOARD_SLOTS }, (_, slot) => <span
          className={'board-slot-base ' + (slot < props.currentSlot ? 'past-slot' : '')}
          data-slot={slot}
          key={slot}
          aria-hidden="true"
        />)}
      </div>
      <div className="task-piece-layer">
        {pieces.map(({ slot, offset, task, placement }) => {
          const key = `${task.id}:${offset}`;
          const implicitLocked = placement.startSlot < props.currentSlot || task.status === 'doing';
          const isDragging = props.dragUi?.active && props.dragUi.taskId === task.id;
          return <button
            type="button"
            ref={(element) => { if (element) pieceRefs.current.set(key, element); else pieceRefs.current.delete(key); }}
            className={'board-cell filled kind-' + task.type +
              (slot < props.currentSlot ? ' late' : '') +
              (isDragging ? ' dragging-task' : '') +
              (task.id === props.completingTaskId ? ' completing' : '')}
            style={{ gridColumn: slot % 6 + 1, gridRow: Math.floor(slot / 6) + 1 }}
            data-slot={slot}
            data-task-id={task.id}
            key={key}
            onPointerDown={(event) => props.onPointerDownTask(event, task)}
            aria-label={`${task.title}，${task.durationSlots * 15}分钟`}
          >
            <span className="cell-icon"><TaskIcon type={task.type} /></span>
            {(task.locked || implicitLocked) && <span className="lock-mark" aria-hidden="true"><LockIcon /></span>}
            <span className="cell-hover-tip"><strong>{task.title}</strong><b>{task.durationSlots * 15}分钟 · {task.status === 'doing' ? '进行中' : '待开始'}</b></span>
          </button>;
        })}
        {props.dragUi?.active && props.dragUi.originSlots.map((slot) => <span
          className="drag-origin-placeholder"
          style={{ gridColumn: slot % 6 + 1, gridRow: Math.floor(slot / 6) + 1 }}
          key={'origin-' + slot}
        />)}
      </div>
      <div className="elapsed-water" style={{ height: (props.progress * 100) + '%' }} />
      <svg className="water-wave" style={{ top: 'calc(' + (props.progress * 100) + '% - 5px)' }} viewBox="0 0 100 10" preserveAspectRatio="none" aria-hidden="true">
        <path d="M0 5 Q 12.5 1 25 5 T 50 5 T 75 5 T 100 5" />
      </svg>
      <span className="clock-marker" style={{ top: 'calc(' + (props.progress * 100) + '% - 9px)' }} aria-hidden="true"><TaskIcon type="waiting" /></span>
      {props.selectedTask && <div className="task-peek" onPointerDown={(event) => event.stopPropagation()}>
        <span className={'peek-dot kind-' + props.selectedTask.type} />
        <span><strong>{props.selectedTask.title}</strong><small>{props.selectedTask.durationSlots * 15}分钟 · {props.selectedTask.day === 'today' ? '今天' : '明天'}</small></span>
        {props.selectedTask.status !== 'done' && <button type="button" onClick={() => props.onDone(props.selectedTask!.id)}>完成</button>}
        {props.selectedTask.day === 'today' && props.selectedTask.status === 'todo' && <button type="button" onClick={() => props.onToggleLock(props.selectedTask!.id)}>{props.selectedTask.locked ? '解锁' : '锁定'}</button>}
        <button type="button" onClick={() => props.onSelectTask(null)}>×</button>
      </div>}
    </div>
  </div>;
}

function WindowControls(props: {
  mode: Mode;
  onMini: () => void;
  onBoard: () => void;
  onDetail: () => void;
  onQuit: () => void;
}) {
  return <nav className={'window-controls window-controls-' + props.mode} aria-label="窗口大小与退出">
    {props.mode !== 'mini' && <button type="button" className="control-mini" onClick={props.onMini} title="最小倒计时" aria-label="最小倒计时"><i /></button>}
    {props.mode !== 'board' && <button type="button" className="control-board" onClick={props.onBoard} title="任务棋盘" aria-label="任务棋盘"><i /><i /><i /><i /></button>}
    {props.mode !== 'detail' && <button type="button" className="control-detail" onClick={props.onDetail} title="详细工作台" aria-label="详细工作台"><i /></button>}
    <button type="button" className="control-quit" onClick={props.onQuit} title="退出应用" aria-label="退出应用"><i /><i /></button>
  </nav>;
}

function OverflowPreview({ plan }: { plan: DayPlan }) {
  if (plan.overflowSlots <= 0) return null;
  const overflowTasks = plan.placements.filter((placement) => placement.overflowSlots > 0);
  return <div className="overflow-preview" data-testid="overflow-preview">
    <div><strong>超出今日</strong><span>· {plan.overflowSlots * 15}分钟</span></div>
    <div className="overflow-pieces">{overflowTasks.map((placement) => <span className={'kind-' + placement.task.type} key={placement.task.id}>
      {Array.from({ length: placement.overflowSlots }, (_, index) => <i key={index}><TaskIcon type={placement.task.type} /></i>)}
    </span>)}</div>
  </div>;
}

function OverflowDecision(props: { pending: PendingOverflow; onResolve: (action: 'tomorrow' | 'resize' | 'replace' | 'overtime' | 'cancel') => void }) {
  return <aside className="overflow-decision" data-testid="overflow-decision">
    <div><strong>这次调整会超出今日</strong><span>{props.pending.overflowSlots * 15}分钟</span></div>
    <p>正式排期尚未修改，请选择如何处理当前任务。</p>
    <div className="overflow-actions">
      <button type="button" onClick={() => props.onResolve('tomorrow')}>延后到明天</button>
      <button type="button" onClick={() => props.onResolve('resize')}>调整任务时长</button>
      <button type="button" onClick={() => props.onResolve('replace')}>替换其他任务</button>
      <button type="button" onClick={() => props.onResolve('overtime')}>确认加班并计算补偿</button>
      <button type="button" onClick={() => props.onResolve('cancel')}>取消本次调整</button>
    </div>
  </aside>;
}

function DragGhost({ task, x, y, valid }: { task?: ScheduleTask; x: number; y: number; valid: boolean }) {
  if (!task) return null;
  return <div className={'drag-ghost kind-' + task.type + (valid ? '' : ' invalid')} style={{ left: x + 12, top: y + 12 }} aria-hidden="true">
    {Array.from({ length: Math.min(task.durationSlots, 8) }, (_, index) => <i key={index}>{index === 0 ? <TaskIcon type={task.type} /> : null}</i>)}
  </div>;
}

function TaskIcon({ type }: { type: TaskType }) {
  if (type === 'normal') return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 3.5h7l3 3V20H7z"/><path d="M14 3.5V7h3M9.5 11h5M9.5 15h5"/></svg>;
  if (type === 'meeting') return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5h16v11H9l-4 3v-3H4z"/><path d="M8 9h8M8 12h5"/></svg>;
  if (type === 'ai') return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m12 3 1.7 5.3L19 10l-5.3 1.7L12 17l-1.7-5.3L5 10l5.3-1.7z"/><path d="m18.5 15 .7 2.3 2.3.7-2.3.7-.7 2.3-.7-2.3-2.3-.7 2.3-.7z"/></svg>;
  if (type === 'urgent') return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M13 3c1 4-2 5-2 8 0 1.2.8 2 1.8 2 1.7 0 2.7-1.8 2.2-3.5 2.3 1.6 3.5 3.7 3.5 6.2A6.5 6.5 0 0 1 5.5 16c0-3 1.8-5.6 4.8-7.6-.2 2.4.7 3.4 1.4 3.7C11 8.7 15 7 13 3z"/></svg>;
  if (type === 'waiting') return <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8"/><path d="M12 7v5l3 2"/></svg>;
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 16h10l-1.2-2V9a3.8 3.8 0 0 0-7.6 0v5z"/><path d="M10 18.5a2.2 2.2 0 0 0 4 0M12 4V2.5"/></svg>;
}

function LockIcon() {
  return <svg viewBox="0 0 16 16"><rect x="3" y="7" width="10" height="7" rx="2"/><path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2"/></svg>;
}

function OfficeMark() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="3" width="14" height="18" rx="2"/><path d="M12 4v16M8 8l2-2M16 8l-2-2M8 16l2 2M16 16l-2 2"/></svg>;
}

function TaskModal({ onClose, onAdd }: { onClose: () => void; onAdd: (task: ScheduleTask) => void }) {
  const [title, setTitle] = useState('');
  const [durationSlots, setDurationSlots] = useState(3);
  const [type, setType] = useState<TaskType>('normal');
  const [deadline, setDeadline] = useState('17:00');
  const [day, setDay] = useState<TaskDay>('today');
  const touched = useRef(false);

  function onTitle(value: string) {
    setTitle(value);
    if (!touched.current) setDurationSlots(estimateSlots(value));
    if (/会议|沟通/.test(value)) setType('meeting');
    else if (/老板|临时/.test(value)) setType('temporary');
    else if (/AI|整理/.test(value)) setType('ai');
    else if (/急|修复|bug/i.test(value)) setType('urgent');
    else if (/审批|等待/.test(value)) setType('waiting');
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!title.trim()) return;
    onAdd(makeTask(title.trim(), durationSlots, type, { deadline, day }));
  }

  return <div className="modal-shade" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <form className="task-modal" onSubmit={submit}>
      <header><span>AI任务估时</span><button type="button" onClick={onClose}>×</button></header>
      <label>任务内容<input autoFocus value={title} onChange={(event) => onTitle(event.target.value)} placeholder="例如：完成产品演示" /></label>
      <div className="ai-estimate">AI建议 <strong>{estimateSlots(title || '普通任务') * 15}分钟</strong><small>不准确可直接修改</small></div>
      <div className="form-grid">
        <label>预计时长<select value={durationSlots} onChange={(event) => { touched.current = true; setDurationSlots(Number(event.target.value)); }}>
          {Array.from({ length: 12 }, (_, index) => index + 1).map((slots) => <option value={slots} key={slots}>{slots * 15}分钟</option>)}
        </select></label>
        <label>截止时间<input type="time" value={deadline} onChange={(event) => setDeadline(event.target.value)} /></label>
      </div>
      <div className="form-grid">
        <label>任务类型<select value={type} onChange={(event) => setType(event.target.value as TaskType)}>
          {Object.entries(TYPE_META).map(([value, meta]) => <option value={value} key={value}>{meta.label}</option>)}
        </select></label>
        <label>安排日期<select value={day} onChange={(event) => setDay(event.target.value as TaskDay)}><option value="today">今天</option><option value="tomorrow">明天</option></select></label>
      </div>
      <button className="primary-action" type="submit">加入 {durationSlots} 格任务</button>
    </form>
  </div>;
}

function DetailView(props: {
  schedule: ScheduleTask[];
  committedPlan: DayPlan;
  todayPlan: DayPlan;
  tomorrowPlan: DayPlan;
  currentSlot: number;
  progress: number;
  selectedTask: ScheduleTask | null;
  completingTaskId: string | null;
  dragUi: DragUi | null;
  pendingOverflow: PendingOverflow | null;
  settings: Settings;
  extraComp: number;
  todayWage: number;
  remainingSlots: number;
  onMini: () => void;
  onCollapse: () => void;
  onQuit: () => void;
  onAdd: () => void;
  onTemporary: () => void;
  onSettings: (settings: Settings) => void;
  onSelectTask: (id: string | null) => void;
  onDone: (id: string) => void;
  onToggleLock: (id: string) => void;
  onSplit: (id: string) => void;
  onPointerDownTask: (event: ReactPointerEvent, task: ScheduleTask) => void;
  onResolveOverflow: (action: 'tomorrow' | 'resize' | 'replace' | 'overtime' | 'cancel') => void;
}) {
  const todayTasks = props.schedule.filter((task) => task.day === 'today');
  const tomorrowTasks = props.schedule.filter((task) => task.day === 'tomorrow' && task.status !== 'done');
  return <section className="detail-shell">
    <header className="detail-header drag-surface">
      <div className="office-sign"><span><OfficeMark /></span><div><strong>clockout</strong><small>拖动的是完整任务，松手才保存排期</small></div></div>
      <div className="header-actions no-drag"><button type="button" onClick={props.onTemporary}>老板临时加单</button><button type="button" onClick={props.onAdd}>＋新增任务</button><WindowControls mode="detail" onMini={props.onMini} onBoard={props.onCollapse} onDetail={() => {}} onQuit={props.onQuit} /></div>
    </header>
    <div className="detail-grid schedule-detail-grid">
      <section className="pixel-panel ledger schedule-ledger">
        <h2>任务顺序 <b>{props.remainingSlots * 15} MIN</b></h2>
        <p className="ledger-help">按住任务移动超过5px后，整项任务才会被提起。</p>
        <div className="ledger-list">
          <h3>今天</h3>
          {todayTasks.map((task) => <TaskLedgerRow task={task} key={task.id} plan={props.committedPlan} currentSlot={props.currentSlot} onPointerDown={props.onPointerDownTask} onDone={props.onDone} onSplit={props.onSplit} onToggleLock={props.onToggleLock} />)}
          <h3 className="tomorrow-heading">明天 <span>{tomorrowTasks.length}项</span></h3>
          {tomorrowTasks.map((task) => <TaskLedgerRow task={task} key={task.id} plan={props.tomorrowPlan} currentSlot={0} onPointerDown={props.onPointerDownTask} onDone={props.onDone} onSplit={props.onSplit} onToggleLock={props.onToggleLock} />)}
        </div>
      </section>
      <section className="center-column schedule-center-column">
        <div className="pixel-panel detail-board-panel stable-board-panel">
          <div className="panel-title"><h2>09:00—18:00 · 每格15分钟</h2><span>{props.todayPlan.overflowSlots > 0 ? '预览尚未保存' : '正式排期'}</span></div>
          <TaskBoard
            plan={props.todayPlan}
            currentSlot={props.currentSlot}
            progress={props.progress}
            selectedTask={props.selectedTask}
            completingTaskId={props.completingTaskId}
            dragUi={props.dragUi}
            onSelectTask={props.onSelectTask}
            onDone={props.onDone}
            onToggleLock={props.onToggleLock}
            onPointerDownTask={props.onPointerDownTask}
          />
          <OverflowPreview plan={props.todayPlan} />
          <div className={'tomorrow-drop-tray ' + (props.dragUi?.active ? 'ready' : '') + (props.dragUi?.target === 'tomorrow' ? 'hovered' : '')} data-drop-zone="tomorrow">
            <span>放到明天</span><small>拖到这里，今日任务会自动前移补位</small>
          </div>
          {props.pendingOverflow && <OverflowDecision pending={props.pendingOverflow} onResolve={props.onResolveOverflow} />}
        </div>
      </section>
      <aside className="right-column">
        <section className="pixel-panel money-settings">
          <h2>工资与工时</h2>
          <div className="money-row"><span>今日累计</span><strong>¥ {props.todayWage.toFixed(2)}</strong></div>
          <div className="money-row extra"><span>额外补偿</span><strong>＋¥ {props.extraComp.toFixed(2)}</strong></div>
          <label>上班<input type="time" value={props.settings.start} onChange={(event) => props.onSettings({ ...props.settings, start: event.target.value })} /></label>
          <label>下班<input type="time" value={props.settings.end} onChange={(event) => props.onSettings({ ...props.settings, end: event.target.value })} /></label>
          <label>时薪<input type="number" value={props.settings.hourlyWage} onChange={(event) => props.onSettings({ ...props.settings, hourlyWage: Number(event.target.value) })} /></label>
        </section>
        <section className="pixel-panel schedule-rules">
          <h2>排期规则</h2>
          <p><i />过去时段不可放置</p>
          <p><i />锁定任务保持原时间</p>
          <p><i />任务只按顺序连续占格</p>
          <p><i />溢出必须由你确认</p>
        </section>
      </aside>
    </div>
  </section>;
}

function TaskLedgerRow(props: {
  task: ScheduleTask;
  plan: DayPlan;
  currentSlot: number;
  onPointerDown: (event: ReactPointerEvent, task: ScheduleTask) => void;
  onDone: (id: string) => void;
  onSplit: (id: string) => void;
  onToggleLock: (id: string) => void;
}) {
  const draggable = props.task.day === 'tomorrow'
    ? props.task.status === 'todo' && !props.task.locked
    : isTaskDraggable(props.task, props.plan, props.currentSlot);
  return <article
    className={'ledger-row schedule-row kind-' + props.task.type + (props.task.status === 'done' ? ' done' : '') + (!draggable ? ' fixed' : '')}
    data-task-id={props.task.id}
    onPointerDown={(event) => {
      if ((event.target as HTMLElement).closest('button')) return;
      props.onPointerDown(event, props.task);
    }}
  >
    <i><TaskIcon type={props.task.type} /></i>
    <div><strong>{props.task.title}</strong><span>{props.task.durationSlots}格 · {props.task.durationSlots * 15}分钟 · {props.task.deadline}</span></div>
    {props.task.locked && <span className="row-lock"><LockIcon />固定</span>}
    {props.task.status !== 'done' && <div className="row-actions">
      {!props.task.locked && props.task.durationSlots > 1 && <button type="button" onClick={() => props.onSplit(props.task.id)}>拆分</button>}
      {props.task.day === 'today' && <button type="button" onClick={() => props.onToggleLock(props.task.id)}>{props.task.locked ? '解锁' : '锁定'}</button>}
      <button type="button" onClick={() => props.onDone(props.task.id)}>完成</button>
    </div>}
  </article>;
}

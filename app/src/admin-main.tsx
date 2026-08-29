import { StrictMode, useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { AdminView } from './App';
import { ScheduleTask } from './scheduler';
import './styles.css';

type AdminState = {
  confirmedAt: number | null;
  pendingMinutes: number;
  overageAmount: number;
};

function getCurrentSlot() {
  const now = new Date();
  return Math.max(0, Math.min(36, Math.floor((now.getHours() * 60 + now.getMinutes() - 540) / 15)));
}

async function requestTasks() {
  const response = await fetch('/api/tasks', { headers: { Accept: 'application/json' } });
  if (!response.ok) throw new Error(`任务读取失败（${response.status}）`);
  return response.json() as Promise<ScheduleTask[]>;
}

async function requestAdminState() {
  const response = await fetch('/api/admin/state', { headers: { Accept: 'application/json' } });
  if (!response.ok) throw new Error(`管理状态读取失败（${response.status}）`);
  return response.json() as Promise<AdminState>;
}

function AdminApp() {
  const [tasks, setTasks] = useState<ScheduleTask[]>([]);
  const [adminState, setAdminState] = useState<AdminState>({ confirmedAt: null, pendingMinutes: 0, overageAmount: 0 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const tasksRef = useRef(tasks);
  tasksRef.current = tasks;

  const refresh = useCallback(async () => {
    try {
      const [next, state] = await Promise.all([requestTasks(), requestAdminState()]);
      setTasks(next);
      setAdminState(state);
      setError('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '任务读取失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 5000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const saveTasks = useCallback(async (next: ScheduleTask[]) => {
    setTasks(next);
    try {
      const response = await fetch('/api/tasks', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(next)
      });
      if (!response.ok) throw new Error(`任务保存失败（${response.status}）`);
      setTasks(await response.json() as ScheduleTask[]);
      setError('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '任务保存失败');
      void refresh();
    }
  }, [refresh]);

  const confirmTasks = useCallback(async () => {
    try {
      const response = await fetch('/api/admin/confirm', { method: 'POST' });
      if (!response.ok) throw new Error((await response.json() as { error?: string }).error || `确认失败（${response.status}）`);
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '确认失败');
    }
  }, [refresh]);

  const payAndPublish = useCallback(async () => {
    const message = `确认支付 ¥${adminState.overageAmount.toFixed(2)} 超额费用，并发送 ${adminState.pendingMinutes} 分钟任务给员工吗？`;
    if (!window.confirm(message)) return;
    try {
      const response = await fetch('/api/admin/pay-and-publish', { method: 'POST' });
      if (!response.ok) throw new Error((await response.json() as { error?: string }).error || `支付失败（${response.status}）`);
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '支付失败');
    }
  }, [adminState.overageAmount, adminState.pendingMinutes, refresh]);

  if (loading) return <div className="admin-loading"><strong>正在打开管理后台</strong><span>正在连接本机任务数据库</span></div>;

  return <div className="admin-page">
    {error && <div className="admin-error" role="alert"><span>{error}</span><button type="button" onClick={() => void refresh()}>重新读取</button></div>}
    <AdminView
      tasks={tasks}
      currentSlot={getCurrentSlot()}
      confirmedAt={adminState.confirmedAt}
      pendingMinutes={adminState.pendingMinutes}
      overageAmount={adminState.overageAmount}
      onBack={() => window.location.assign('/')}
      onAdd={(task) => void saveTasks([...tasksRef.current, { ...task, published: false }])}
      onUpdate={(task) => void saveTasks(tasksRef.current.map((current) => current.id === task.id ? task : current))}
      onDelete={(taskId) => void saveTasks(tasksRef.current.filter((task) => task.id !== taskId))}
      onConfirm={() => void confirmTasks()}
      onPayAndPublish={() => void payAndPublish()}
    />
  </div>;
}

document.documentElement.classList.add('admin-document');
document.body.classList.add('admin-document-body');

createRoot(document.getElementById('root')!).render(<StrictMode><AdminApp /></StrictMode>);

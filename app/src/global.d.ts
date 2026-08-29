/// <reference types="vite/client" />

export {};

declare global {
  interface Window {
    desktopWidget?: {
      setMode: (mode: 'mini' | 'board' | 'detail') => Promise<boolean>;
      togglePin: () => Promise<boolean>;
      updateTrayCountdown: (seconds: number) => Promise<boolean>;
      onModeChanged: (callback: (mode: 'mini' | 'board' | 'detail') => void) => () => void;
      loadTasks: () => Promise<import('./scheduler').ScheduleTask[]>;
      hasAnyTasks: () => Promise<boolean>;
      saveTasks: (tasks: import('./scheduler').ScheduleTask[]) => Promise<import('./scheduler').ScheduleTask[]>;
      deleteTask: (taskId: string) => Promise<import('./scheduler').ScheduleTask[]>;
      onTasksChanged: (callback: (tasks: import('./scheduler').ScheduleTask[]) => void) => () => void;
      hideFor: (milliseconds: number) => void;
      close: () => void;
      quit: () => void;
    };
  }
}

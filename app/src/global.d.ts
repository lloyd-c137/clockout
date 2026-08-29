/// <reference types="vite/client" />

export {};

declare global {
  type WorkSettings = {
    start: string;
    end: string;
    hourlyWage: number;
    overtimeRate: number;
  };

  interface Window {
    desktopWidget?: {
      setMode: (mode: 'mini' | 'board' | 'detail') => Promise<boolean>;
      togglePin: () => Promise<boolean>;
      updateTrayCountdown: (seconds: number) => Promise<boolean>;
      onModeChanged: (callback: (mode: 'mini' | 'board' | 'detail') => void) => () => void;
      loadTasks: () => Promise<import('./scheduler').ScheduleTask[]>;
      hasAnyTasks: () => Promise<boolean>;
      loadWorkdayControl: () => Promise<{ paidAmount: number }>;
      loadSettings: () => Promise<WorkSettings>;
      saveTasks: (tasks: import('./scheduler').ScheduleTask[]) => Promise<import('./scheduler').ScheduleTask[]>;
      deleteTask: (taskId: string) => Promise<import('./scheduler').ScheduleTask[]>;
      onTasksChanged: (callback: (tasks: import('./scheduler').ScheduleTask[]) => void) => () => void;
      onWorkdayChanged: (callback: (control: { paidAmount: number }) => void) => () => void;
      onSettingsChanged: (callback: (settings: WorkSettings) => void) => () => void;
      hideFor: (milliseconds: number) => void;
      close: () => void;
      quit: () => void;
    };
  }
}

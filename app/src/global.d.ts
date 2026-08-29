/// <reference types="vite/client" />

export {};

declare global {
  interface Window {
    desktopWidget?: {
      setMode: (mode: 'mini' | 'board' | 'detail') => Promise<boolean>;
      togglePin: () => Promise<boolean>;
      updateTrayCountdown: (seconds: number) => Promise<boolean>;
      onModeChanged: (callback: (mode: 'mini' | 'board' | 'detail') => void) => () => void;
      hideFor: (milliseconds: number) => void;
      close: () => void;
      quit: () => void;
    };
  }
}

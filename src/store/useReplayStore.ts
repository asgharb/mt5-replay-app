import { create } from 'zustand';
import { Candle, Timeframe } from '../types/market';
import { findCandleIndexByTime } from '../lib/time/binarySearch';

interface ReplayState {
  datasets: Record<Timeframe, Candle[]>;
  activeSymbol: string;
  activeTimeframe: Timeframe;
  currentTimeSec: number | null;
  isPlaying: boolean;
  isSelectingReplay: boolean;
  replayStartTimeSec: number | null;
  speedMs: number;
  
  // Actions
  setDataset: (tf: Timeframe, candles: Candle[]) => void;
  setActiveSymbol: (symbol: string) => void;
  setActiveTimeframe: (tf: Timeframe) => void;
  setCurrentTimeSec: (timeSec: number | null) => void;
  setIsPlaying: (playing: boolean) => void;
  setIsSelectingReplay: (selecting: boolean) => void;
  setReplayStartTimeSec: (timeSec: number | null) => void;
  setSpeedMs: (speed: number) => void;
  stepForward: () => void;
  stepBackward: () => void;
  getCurrentCandles: () => Candle[];
}

export const useReplayStore = create<ReplayState>((set, get) => ({
  datasets: { M1: [], M5: [], M15: [], H1: [], H4: [] },
  activeSymbol: 'DJIUSD',
  activeTimeframe: 'H1',
  currentTimeSec: null,
  isPlaying: false,
  isSelectingReplay: false,
  replayStartTimeSec: null,
  speedMs: 1000,

  setDataset: (tf, candles) =>
    set((state) => ({
      datasets: { ...state.datasets, [tf]: candles },
    })),

  setActiveSymbol: (symbol) => set((state) => state.activeSymbol === symbol ? state : ({
    activeSymbol: symbol,
    datasets: { M1: [], M5: [], M15: [], H1: [], H4: [] },
    currentTimeSec: null,
    isPlaying: false,
    isSelectingReplay: false,
    replayStartTimeSec: null,
  })),

  setActiveTimeframe: (tf) => set({ activeTimeframe: tf }),
  setCurrentTimeSec: (timeSec) => set({ currentTimeSec: timeSec }),
  setIsPlaying: (playing) => set({ isPlaying: playing }),
  setIsSelectingReplay: (selecting) => {
    const { datasets, activeTimeframe } = get();
    const candles = datasets[activeTimeframe];
    set({
      isSelectingReplay: selecting,
      isPlaying: false,
      replayStartTimeSec: selecting && candles.length ? candles[candles.length - 1].time : null,
    });
  },
  setReplayStartTimeSec: (timeSec) => set({ replayStartTimeSec: timeSec }),
  setSpeedMs: (speed) => set({ speedMs: speed }),

  stepForward: () => {
    const { datasets, activeTimeframe, currentTimeSec } = get();
    const currentList = datasets[activeTimeframe];
    if (!currentList.length) return;

    const idx = currentTimeSec === null ? -1 : findCandleIndexByTime(currentList, currentTimeSec);
    if (idx < currentList.length - 1) {
      set({ currentTimeSec: currentList[idx + 1].time });
    }
  },

  stepBackward: () => {
    const { datasets, activeTimeframe, currentTimeSec } = get();
    const currentList = datasets[activeTimeframe];
    if (!currentList.length) return;

    const idx = currentTimeSec === null ? currentList.length : findCandleIndexByTime(currentList, currentTimeSec);
    if (idx > 0) {
      set({ currentTimeSec: currentList[idx - 1].time });
    }
  },

  getCurrentCandles: () => {
    const { datasets, activeTimeframe, currentTimeSec } = get();
    const currentList = datasets[activeTimeframe];
    if (!currentList.length) return [];

    if (currentTimeSec === null) return currentList;

    const idx = findCandleIndexByTime(currentList, currentTimeSec);
    return currentList.slice(0, idx + 1);
  },
}));

import type { Timeframe } from "./market";

export type ReplayState = {
  activeTimeframe: Timeframe;
  currentIndexByTimeframe: Record<Timeframe, number>;
  isPlaying: boolean;
  speedMs: number;
};

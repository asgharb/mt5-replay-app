export type Timeframe = "M1" | "M5" | "M15" | "H1" | "H4";

export type Candle = {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  tickVolume: number;
  spread: number;
};

export type MarketDataByTimeframe = Record<Timeframe, Candle[]>;

export type SymbolData = {
  symbol: string;
  data: MarketDataByTimeframe;
};

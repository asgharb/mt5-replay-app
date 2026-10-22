import { Candle } from '../../types/market';

export function findCandleIndexByTime(candles: Candle[], targetTimeSec: number): number {
  if (!candles || candles.length === 0) return -1;
  let low = 0;
  let high = candles.length - 1;
  let bestIdx = 0;

  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    if (candles[mid].time <= targetTimeSec) {
      bestIdx = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return bestIdx;
}
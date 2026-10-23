import Papa from 'papaparse';
import { Candle } from '../../types/market';

export function parseCsvCandles(csvContent: string): Candle[] {
  const result = Papa.parse<Record<string, string | number>>(csvContent.trim(), {
    header: true,
    dynamicTyping: true,
    skipEmptyLines: true,
    delimiter: '', // تشخیص خودکار بین Tab یا Comma
  });

  const candles: Candle[] = [];

  for (const row of result.data) {
    const rawDate = row['date'] ?? row['<DATE>'] ?? row['Date'];
    const rawClock = row['<TIME>'] ?? row['Time'] ?? row['time'];
    const rawTime = row['timestamp'] ?? row['time'] ?? row['<TIME>'] ?? row['Time'];
    const open = Number(row['open'] ?? row['<OPEN>'] ?? row['Open']);
    const high = Number(row['high'] ?? row['<HIGH>'] ?? row['High']);
    const low = Number(row['low'] ?? row['<LOW>'] ?? row['Low']);
    const close = Number(row['close'] ?? row['<CLOSE>'] ?? row['Close']);
    const volume = Number(row['tick_volume'] ?? row['tickVolume'] ?? row['<TICKVOL>'] ?? row['Volume'] ?? 0);
    const spread = Number(row['spread'] ?? row['Spread'] ?? 0);

    if (rawTime === undefined || isNaN(open) || isNaN(high) || isNaN(low) || isNaN(close)) {
      continue;
    }

    let timeMs: number;
    if (rawDate !== undefined && rawClock !== undefined) {
      const [year, month, day] = String(rawDate).trim().split(/[.\-/]/).map(Number);
      const [hour = 0, minute = 0, second = 0] = String(rawClock).trim().split(':').map(Number);
      timeMs = [year, month, day, hour, minute, second].every(Number.isFinite)
        ? Date.UTC(year, month - 1, day, hour, minute, second)
        : Number.NaN;
    } else {
      timeMs = Number(rawTime);
      if (isNaN(timeMs)) {
        timeMs = new Date(String(rawTime).replace(/\./g, '-')).getTime();
      }
    }

    if (isNaN(timeMs)) continue;

    const timeSec = Math.floor(timeMs > 1e11 ? timeMs / 1000 : timeMs);

    candles.push({
      time: timeSec,
      open,
      high,
      low,
      close,
      tickVolume: volume,
      spread,
    });
  }

  candles.sort((a, b) => a.time - b.time);

  const uniqueCandles: Candle[] = [];
  for (let i = 0; i < candles.length; i++) {
    if (i === 0 || candles[i].time > uniqueCandles[uniqueCandles.length - 1].time) {
      uniqueCandles.push(candles[i]);
    }
  }

  return uniqueCandles;
}

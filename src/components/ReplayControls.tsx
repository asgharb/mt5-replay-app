'use client';

import { useEffect, useRef, useState } from 'react';
import { useReplayStore } from '../store/useReplayStore';
import { useTradingStore } from '../store/useTradingStore';
import ReplayArchiveManager from './ReplayArchiveManager';
import { parseCsvCandles } from '../lib/csv/parseCsv';
import { Timeframe } from '../types/market';
import { findCandleIndexByTime } from '../lib/time/binarySearch';

const TF_LIST: Timeframe[] = ['M1', 'M5', 'M15', 'H1', 'H4'];
const REPLAY_SPEEDS = [10000, 2000, 1000, 500, 200, 100] as const;
type SymbolFiles = Record<string, Partial<Record<Timeframe, string>>>;

function replayIntervalMs(speedMs: number) {
  return REPLAY_SPEEDS.includes(speedMs as typeof REPLAY_SPEEDS[number]) ? speedMs : 1000;
}

function formatReplayInterval(intervalMs: number) {
  const seconds = intervalMs / 1000;
  if (seconds >= 60) {
    const minutes = seconds / 60;
    return `${Number.isInteger(minutes) ? minutes : minutes.toFixed(1)}m/bar`;
  }
  return `${seconds >= 1 ? Number.isInteger(seconds) ? seconds : seconds.toFixed(1) : seconds.toFixed(2)}s/bar`;
}

export default function ReplayControls() {
  const activeSymbol = useReplayStore((state) => state.activeSymbol);
  const setActiveSymbol = useReplayStore((state) => state.setActiveSymbol);
  const activeTimeframe = useReplayStore((state) => state.activeTimeframe);
  const setActiveTimeframe = useReplayStore((state) => state.setActiveTimeframe);
  const isPlaying = useReplayStore((state) => state.isPlaying);
  const setIsPlaying = useReplayStore((state) => state.setIsPlaying);
  const isSelectingReplay = useReplayStore((state) => state.isSelectingReplay);
  const setIsSelectingReplay = useReplayStore((state) => state.setIsSelectingReplay);
  const speedMs = useReplayStore((state) => state.speedMs);
  const setSpeedMs = useReplayStore((state) => state.setSpeedMs);
  const stepForward = useReplayStore((state) => state.stepForward);
  const stepBackward = useReplayStore((state) => state.stepBackward);
  const setDataset = useReplayStore((state) => state.setDataset);
  const setCurrentTimeSec = useReplayStore((state) => state.setCurrentTimeSec);
  const currentTimeSec = useReplayStore((state) => state.currentTimeSec);
  const datasets = useReplayStore((state) => state.datasets);
  const processCandle = useTradingStore((state) => state.processCandle);
  const defaultLots = useTradingStore((state) => state.defaultLots);
  const defaultStopLossPoints = useTradingStore((state) => state.defaultStopLossPoints);
  const defaultTakeProfitPoints = useTradingStore((state) => state.defaultTakeProfitPoints);
  const openPosition = useTradingStore((state) => state.openPosition);
  const [symbolFiles, setSymbolFiles] = useState<SymbolFiles>({});
  const [availableSymbols, setAvailableSymbols] = useState<string[]>([]);
  const previousTimeRef = useRef<number | null>(null);
  const currentCandles = datasets[activeTimeframe];
  const currentCandleIndex = currentTimeSec === null ? currentCandles.length - 1 : findCandleIndexByTime(currentCandles, currentTimeSec);
  const currentCandle = currentCandleIndex < 0 ? null : currentCandles[currentCandleIndex];

  useEffect(() => {
    let timer: NodeJS.Timeout;
    if (isPlaying) {
      const intervalMs = replayIntervalMs(speedMs);
      timer = setInterval(() => {
        stepForward();
      }, intervalMs);
    }
    return () => clearInterval(timer);
  }, [isPlaying, speedMs, activeTimeframe, stepForward]);

  useEffect(() => {
    const previousTime = previousTimeRef.current;
    previousTimeRef.current = currentTimeSec;
    if (currentTimeSec === null || previousTime === null || currentTimeSec <= previousTime) return;

    const candles = datasets[activeTimeframe];
    const index = findCandleIndexByTime(candles, currentTimeSec);
    if (index >= 0) processCandle(candles[index], currentTimeSec, useReplayStore.getState().activeSymbol);
  }, [activeSymbol, activeTimeframe, currentTimeSec, datasets, processCandle]);

  useEffect(() => {
    let cancelled = false;
    const loadMarketDataManifest = async () => {
      try {
        const manifestResponse = await fetch('/api/market-data', { cache: 'no-store' });
        if (!manifestResponse.ok) throw new Error(`Market-data manifest returned ${manifestResponse.status}`);
        const manifest = await manifestResponse.json() as { symbols?: string[]; files?: SymbolFiles };
        const symbols = manifest.symbols ?? Object.keys(manifest.files ?? {});
        if (cancelled) return;
        setAvailableSymbols(symbols);
        setSymbolFiles(manifest.files ?? {});

        if (symbols.length > 0) {
          const currentSymbol = useReplayStore.getState().activeSymbol;
          const canonicalSymbol = symbols.find((symbol) => symbol.toLowerCase() === currentSymbol.toLowerCase());
          if (canonicalSymbol && canonicalSymbol !== currentSymbol) setActiveSymbol(canonicalSymbol);
          else if (!canonicalSymbol) setActiveSymbol(symbols[0]);
        }
      } catch (error) {
        if (!cancelled) console.error('Could not discover bundled market-data files', error);
      }
    };

    void loadMarketDataManifest();
    return () => { cancelled = true; };
  }, [setActiveSymbol]);

  useEffect(() => {
    const selectedSymbolFiles = Object.entries(symbolFiles)
      .find(([symbol]) => symbol.toLowerCase() === activeSymbol.toLowerCase())?.[1];
    if (!selectedSymbolFiles) return;

    let cancelled = false;
    const loadSelectedSymbol = async () => {
      await Promise.all(TF_LIST.map(async (tf) => {
        if (useReplayStore.getState().datasets[tf].length > 0) return;
        const filePath = selectedSymbolFiles[tf];
        if (!filePath) {
          console.error(`No CSV file was found for ${activeSymbol} ${tf}.`);
          return;
        }

        try {
          const response = await fetch(filePath);
          if (cancelled || useReplayStore.getState().activeSymbol !== activeSymbol) return;
          if (!response.ok) {
            console.error(`Could not load bundled ${activeSymbol} ${tf} market data (${response.status}): ${filePath}`);
            return;
          }

          const candles = parseCsvCandles(await response.text());
          if (cancelled || useReplayStore.getState().activeSymbol !== activeSymbol) return;
          if (candles.length > 0) setDataset(tf, candles);
          else console.error(`The CSV file for ${activeSymbol} ${tf} contains no valid candles: ${filePath}`);
        } catch (error) {
          if (!cancelled) console.error(`Could not load bundled ${activeSymbol} ${tf} market data`, error);
        }
      }));
    };

    void loadSelectedSymbol();
    return () => { cancelled = true; };
  }, [activeSymbol, setDataset, symbolFiles]);

  const placeOrder = (side: 'buy' | 'sell') => {
    if (!currentCandle) return;
    const tradeTimeSec = currentTimeSec ?? currentCandle.time;
    const opened = openPosition(
      side,
      defaultLots,
      defaultStopLossPoints,
      defaultTakeProfitPoints,
      currentCandle,
      tradeTimeSec,
      activeSymbol,
    );
    if (!opened) window.alert('حاشیهٔ آزاد کافی نیست یا حجم معامله معتبر نیست.');
  };

  return (
    <div className="bg-slate-900 border border-slate-800 p-4 rounded-lg flex shrink-0 flex-wrap gap-4 items-center justify-between text-white">
      <div className="flex items-center gap-2 text-xs">
        <button disabled={!currentCandle} onClick={() => placeOrder('sell')}
          className="rounded bg-rose-700 px-4 py-2 font-bold text-white hover:bg-rose-600 disabled:cursor-not-allowed disabled:opacity-40">فروش / Sell</button>
        <button disabled={!currentCandle} onClick={() => placeOrder('buy')}
          className="rounded bg-emerald-700 px-4 py-2 font-bold text-white hover:bg-emerald-600 disabled:cursor-not-allowed disabled:opacity-40">خرید / Buy</button>
        <span className="font-mono text-slate-400">{defaultLots.toFixed(2)} lot</span>
      </div>

      <div className="flex bg-slate-800 p-1 rounded-md border border-slate-700">
        <label className="sr-only" htmlFor="market-symbol">نماد چارت</label>
        <select id="market-symbol" aria-label="نماد چارت" value={activeSymbol}
          onChange={(event) => setActiveSymbol(event.target.value)} disabled={availableSymbols.length === 0}
          className="mr-1 max-w-32 rounded bg-slate-900 px-2 py-1 text-xs font-semibold text-slate-200 disabled:opacity-50">
          {availableSymbols.length === 0 && <option value={activeSymbol}>{activeSymbol || 'No symbols'}</option>}
          {availableSymbols.map((symbol) => <option key={symbol} value={symbol}>{symbol}</option>)}
        </select>
        {TF_LIST.map((tf) => (
          <button
            key={tf}
            onClick={() => setActiveTimeframe(tf)}
            className={activeTimeframe === tf ? 'px-3 py-1 text-xs font-semibold rounded bg-blue-600 text-white' : 'px-3 py-1 text-xs font-semibold rounded text-slate-400 hover:text-white'}
          >
            {tf}
          </button>
        ))}
      </div>

      <div className="flex items-center gap-2">
        <button onClick={stepBackward} className="bg-slate-800 hover:bg-slate-700 px-3 py-1.5 rounded text-sm font-bold">
          ⏮ Prev
        </button>
        <button
          onClick={() => {
            if (isPlaying) setIsPlaying(false);
            else if (isSelectingReplay) setIsSelectingReplay(false);
            else if (currentTimeSec !== null) setIsPlaying(true);
            else setIsSelectingReplay(true);
          }}
          className={isPlaying ? 'bg-amber-600 hover:opacity-90 px-4 py-1.5 rounded text-sm font-bold' : 'bg-emerald-600 hover:opacity-90 px-4 py-1.5 rounded text-sm font-bold'}
        >
          {isPlaying ? 'Pause ⏸' : isSelectingReplay ? 'Cancel' : currentTimeSec !== null ? 'Play ▶' : 'Replay ▶'}
        </button>
        <button onClick={stepForward} className="bg-slate-800 hover:bg-slate-700 px-3 py-1.5 rounded text-sm font-bold">
          Next ⏭
        </button>
        {(isPlaying || isSelectingReplay || currentTimeSec !== null) && (
          <button
            onClick={() => {
              setIsPlaying(false);
              setIsSelectingReplay(false);
              setCurrentTimeSec(null);
            }}
            className="rounded border border-slate-600 px-3 py-1.5 text-xs font-semibold text-slate-300 hover:bg-slate-700 hover:text-white"
          >
            خروج از بک‌تست
          </button>
        )}

        <select
          value={speedMs}
          onChange={(e) => setSpeedMs(Number(e.target.value))}
          className="bg-slate-800 border border-slate-700 text-xs rounded p-1.5 ml-2"
        >
          <option value={10000}>0.1x ({formatReplayInterval(replayIntervalMs(10000))})</option>
          <option value={2000}>0.5x ({formatReplayInterval(replayIntervalMs(2000))})</option>
          <option value={1000}>1.0x ({formatReplayInterval(replayIntervalMs(1000))})</option>
          <option value={500}>2.0x ({formatReplayInterval(replayIntervalMs(500))})</option>
          <option value={200}>5.0x ({formatReplayInterval(replayIntervalMs(200))})</option>
          <option value={100}>10x ({formatReplayInterval(replayIntervalMs(100))})</option>
        </select>
      </div>

      <ReplayArchiveManager />

      <div className="text-xs text-slate-400 font-mono">
        {currentTimeSec !== null
          ? new Date(currentTimeSec * 1000).toISOString().replace('T', ' ').substring(0, 19)
          : datasets[activeTimeframe].length > 0 ? 'Latest data · double click chart to start replay' : 'No Data Loaded'}
      </div>
    </div>
  );
}

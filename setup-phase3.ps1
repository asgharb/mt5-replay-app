Set-ExecutionPolicy -ExecutionPolicy Unrestricted -Scope Process -Force

# 1. DataLoader & Control Panel Component
New-Item -ItemType File -Force -Path "src\components\ReplayControls.tsx"
[System.IO.File]::WriteAllText("$PWD\src\components\ReplayControls.tsx", @"
'use client';

import { useEffect } from 'react';
import { useReplayStore } from '../store/useReplayStore';
import { parseCsvCandles } from '../lib/csv/parseCsv';
import { TimeframeKey } from '../types/market';

const TF_LIST: TimeframeKey[] = ['M1', 'M5', 'M15', 'H1', 'H4'];

export default function ReplayControls() {
  const {
    activeTimeframe,
    setActiveTimeframe,
    isPlaying,
    setIsPlaying,
    speedMs,
    setSpeedMs,
    stepForward,
    stepBackward,
    setDataset,
    currentTimeSec
  } = useReplayStore();

  useEffect(() => {
    let timer: NodeJS.Timeout;
    if (isPlaying) {
      timer = setInterval(() => {
        stepForward();
      }, speedMs);
    }
    return () => clearInterval(timer);
  }, [isPlaying, speedMs, stepForward]);

  const handleFileUpload = (tf: TimeframeKey, e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (event) => {
      const text = event.target?.result as string;
      if (text) {
        const candles = parseCsvCandles(text);
        setDataset(tf, candles);
      }
    };
    reader.readAsText(file);
  };

  return (
    <div className="bg-slate-900 border border-slate-800 p-4 rounded-lg flex flex-wrap gap-4 items-center justify-between text-white mb-4">
      {/* File Upload Inputs */}
      <div className="flex flex-wrap gap-2 items-center text-xs">
        <span className="text-slate-400 font-bold">Upload CSVs:</span>
        {TF_LIST.map((tf) => (
          <label key={tf} className="bg-slate-800 hover:bg-slate-700 px-2 py-1 rounded cursor-pointer border border-slate-700">
            {tf}
            <input type="file" accept=".csv" className="hidden" onChange={(e) => handleFileUpload(tf, e)} />
          </label>
        ))}
      </div>

      {/* Timeframe Switcher */}
      <div className="flex bg-slate-800 p-1 rounded-md border border-slate-700">
        {TF_LIST.map((tf) => (
          <button
            key={tf}
            onClick={() => setActiveTimeframe(tf)}
            className={`px-3 py-1 text-xs font-semibold rounded ${
              activeTimeframe === tf ? 'bg-blue-600 text-white' : 'text-slate-400 hover:text-white'
            }`}
          >
            {tf}
          </button>
        ))}
      </div>

      {/* Replay Controls */}
      <div className="flex items-center gap-2">
        <button onClick={stepBackward} className="bg-slate-800 hover:bg-slate-700 px-3 py-1.5 rounded text-sm font-bold">
          ⏮ Prev
        </button>
        <button
          onClick={() => setIsPlaying(!isPlaying)}
          className={`${isPlaying ? 'bg-amber-600' : 'bg-emerald-600'} hover:opacity-90 px-4 py-1.5 rounded text-sm font-bold`}
        >
          {isPlaying ? 'Pause ⏸' : 'Play ▶'}
        </button>
        <button onClick={stepForward} className="bg-slate-800 hover:bg-slate-700 px-3 py-1.5 rounded text-sm font-bold">
          Next ⏭
        </button>

        <select
          value={speedMs}
          onChange={(e) => setSpeedMs(Number(e.target.value))}
          className="bg-slate-800 border border-slate-700 text-xs rounded p-1.5 ml-2"
        >
          <option value={2000}>0.5x (2s)</option>
          <option value={1000}>1.0x (1s)</option>
          <option value={500}>2.0x (0.5s)</option>
          <option value={200}>5.0x (0.2s)</option>
        </select>
      </div>

      {/* Timestamp Indicator */}
      <div className="text-xs text-slate-400 font-mono">
        {currentTimeSec ? new Date(currentTimeSec * 1000).toISOString().replace('T', ' ').substring(0, 19) : 'No Data Loaded'}
      </div>
    </div>
  );
}
"@, [System.Text.Encoding]::UTF8)

# 2. Main Replay Dashboard Page
New-Item -ItemType File -Force -Path "src\app\page.tsx"
[System.IO.File]::WriteAllText("$PWD\src\app\page.tsx", @"
'use client';

import dynamic from 'next/dynamic';
import ReplayControls from '../components/ReplayControls';

const TradingViewChart = dynamic(() => import('../components/TradingViewChart'), { ssr: false });

export default function Home() {
  return (
    <main className="min-h-screen bg-slate-950 text-slate-100 p-6">
      <header className="mb-6 flex justify-between items-center border-b border-slate-800 pb-4">
        <div>
          <h1 className="text-xl font-bold tracking-tight text-white">MT5 Multi-TF Replay System</h1>
          <p className="text-xs text-slate-400">DJIUSD Backtesting Dashboard</p>
        </div>
      </header>

      <ReplayControls />
      
      <div className="grid grid-cols-1 gap-4">
        <TradingViewChart />
      </div>
    </main>
  );
}
"@, [System.Text.Encoding]::UTF8)

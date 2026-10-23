'use client';

import { ChangeEvent, useEffect, useRef, useState } from 'react';
import { useReplayStore } from '../store/useReplayStore';
import { useTradingStore } from '../store/useTradingStore';
import type { Timeframe } from '../types/market';
import type { PendingOrder, Trade } from '../types/trading';

const STORAGE_KEY = 'mt5-replay-archives-v1';

type ArchiveTradingState = {
  initialCapital: number;
  balance: number;
  defaultLots: number;
  defaultStopLossPoints: number;
  defaultTakeProfitPoints: number;
  leverage: number;
  contractSize: number;
  pointSize: number;
  commissionPerLot: number;
  trades: Trade[];
  pendingOrders: PendingOrder[];
  nextTradeId: number;
  nextPendingOrderId: number;
};

type DataSignature = { count: number; firstTime: number; lastTime: number } | null;

type ReplayArchive = {
  version: 1;
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  activeSymbol?: string;
  activeTimeframe: Timeframe;
  currentTimeSec: number | null;
  replayStartTimeSec: number | null;
  isSelectingReplay: boolean;
  speedMs: number;
  dataSignature: DataSignature;
  trading: ArchiveTradingState;
};

function readArchives(): ReplayArchive[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]');
    return Array.isArray(value) ? value.filter(isReplayArchive).sort((a, b) => b.updatedAt - a.updatedAt) : [];
  } catch {
    return [];
  }
}

function uniqueArchives(archives: ReplayArchive[]) {
  const unique = new Map<string, ReplayArchive>();
  for (const archive of archives) {
    const key = JSON.stringify({
      version: archive.version,
      activeSymbol: archive.activeSymbol ?? 'DJIUSD',
      activeTimeframe: archive.activeTimeframe,
      currentTimeSec: archive.currentTimeSec,
      replayStartTimeSec: archive.replayStartTimeSec,
      isSelectingReplay: archive.isSelectingReplay,
      speedMs: archive.speedMs === 0 ? 1000 : archive.speedMs,
      dataSignature: archive.dataSignature,
      trading: archive.trading,
    });
    const previous = unique.get(key);
    if (!previous || archive.updatedAt > previous.updatedAt) unique.set(key, archive);
  }
  return [...unique.values()].sort((a, b) => b.updatedAt - a.updatedAt);
}

function isReplayArchive(value: unknown): value is ReplayArchive {
  if (!value || typeof value !== 'object') return false;
  const archive = value as Partial<ReplayArchive>;
  const trading = archive.trading;
  const validTimeframes: Timeframe[] = ['M1', 'M5', 'M15', 'H1', 'H4'];
  const numericTradingFields = trading && [
    trading.initialCapital, trading.balance, trading.defaultLots, trading.defaultStopLossPoints,
    trading.defaultTakeProfitPoints, trading.leverage, trading.contractSize, trading.pointSize,
    trading.commissionPerLot, trading.nextTradeId, trading.nextPendingOrderId,
  ];
  return archive.version === 1 && typeof archive.id === 'string' && typeof archive.name === 'string'
    && validTimeframes.includes(archive.activeTimeframe as Timeframe)
    && typeof archive.createdAt === 'number' && Number.isFinite(archive.createdAt)
    && typeof archive.updatedAt === 'number' && Number.isFinite(archive.updatedAt)
    && (archive.activeSymbol === undefined || typeof archive.activeSymbol === 'string')
    && (archive.currentTimeSec === null || (typeof archive.currentTimeSec === 'number' && Number.isFinite(archive.currentTimeSec)))
    && (archive.replayStartTimeSec === null || (typeof archive.replayStartTimeSec === 'number' && Number.isFinite(archive.replayStartTimeSec)))
    && typeof archive.isSelectingReplay === 'boolean' && typeof archive.speedMs === 'number' && Number.isFinite(archive.speedMs)
    && (archive.dataSignature === null || Boolean(archive.dataSignature
      && Number.isFinite(archive.dataSignature.count) && Number.isFinite(archive.dataSignature.firstTime) && Number.isFinite(archive.dataSignature.lastTime)))
    && Boolean(trading && numericTradingFields?.every((field) => typeof field === 'number' && Number.isFinite(field))
      && Array.isArray(trading.trades) && Array.isArray(trading.pendingOrders));
}

function writeArchives(archives: ReplayArchive[]) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(archives));
}

function makeArchiveId() {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function makeSnapshot(id: string, name: string, createdAt: number): ReplayArchive {
  const replay = useReplayStore.getState();
  const account = useTradingStore.getState();
  const candles = replay.datasets[replay.activeTimeframe] ?? [];
  return {
    version: 1,
    id,
    name,
    createdAt,
    updatedAt: Date.now(),
    activeSymbol: replay.activeSymbol,
    activeTimeframe: replay.activeTimeframe,
    currentTimeSec: replay.currentTimeSec,
    replayStartTimeSec: replay.replayStartTimeSec,
    isSelectingReplay: replay.isSelectingReplay,
    speedMs: replay.speedMs,
    dataSignature: candles.length ? {
      count: candles.length,
      firstTime: candles[0].time,
      lastTime: candles[candles.length - 1].time,
    } : null,
    trading: {
      initialCapital: account.initialCapital,
      balance: account.balance,
      defaultLots: account.defaultLots,
      defaultStopLossPoints: account.defaultStopLossPoints,
      defaultTakeProfitPoints: account.defaultTakeProfitPoints,
      leverage: account.leverage,
      contractSize: account.contractSize,
      pointSize: account.pointSize,
      commissionPerLot: account.commissionPerLot,
      trades: account.trades,
      pendingOrders: account.pendingOrders,
      nextTradeId: account.nextTradeId,
      nextPendingOrderId: account.nextPendingOrderId,
    },
  };
}

function hasSameData(archive: ReplayArchive, count: number, firstTime: number, lastTime: number) {
  const signature = archive.dataSignature;
  return !signature || (signature.count === count && signature.firstTime === firstTime && signature.lastTime === lastTime);
}

function formatArchiveTime(timestamp: number) {
  return new Intl.DateTimeFormat('fa-IR', { dateStyle: 'medium', timeStyle: 'short' }).format(timestamp);
}

export default function ReplayArchiveManager() {
  const [archives, setArchives] = useState<ReplayArchive[]>([]);
  const [isOpen, setIsOpen] = useState(false);
  const [notice, setNotice] = useState('');
  const activeArchiveId = useRef<string | null>(null);
  const suppressAutoArchive = useRef(false);
  const lastListRefresh = useRef(0);
  const importInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let saveTimer: number | null = null;
    let lastSaveAt = 0;
    const loadArchivesTimer = window.setTimeout(() => {
      const stored = readArchives();
      const unique = uniqueArchives(stored);
      if (unique.length !== stored.length) writeArchives(unique);
      setArchives(unique);
    }, 0);

    const persistCurrentState = () => {
      const replay = useReplayStore.getState();
      const inReplay = replay.isSelectingReplay || replay.currentTimeSec !== null;
      if (!inReplay) {
        activeArchiveId.current = null;
        suppressAutoArchive.current = false;
        return;
      }
      if (suppressAutoArchive.current) return;

      const stored = uniqueArchives(readArchives());
      const existing = activeArchiveId.current ? stored.find((archive) => archive.id === activeArchiveId.current) : undefined;
      const now = Date.now();
      const id = existing?.id ?? activeArchiveId.current ?? makeArchiveId();
      const name = existing?.name ?? `بک‌تست ${replay.activeTimeframe} · ${formatArchiveTime(now)}`;
      const createdAt = existing?.createdAt ?? now;
      const updated = makeSnapshot(id, name, createdAt);
      const next = [updated, ...stored.filter((archive) => archive.id !== id)].sort((a, b) => b.updatedAt - a.updatedAt);
      try {
        writeArchives(next);
        lastSaveAt = now;
        activeArchiveId.current = id;
        if (now - lastListRefresh.current > 1000) {
          lastListRefresh.current = now;
          setArchives(next);
        }
        setNotice('ذخیرهٔ خودکار فعال است');
      } catch {
        setNotice('فضای ذخیرهٔ مرورگر کافی نیست؛ از آرشیوها خروجی بگیر.');
      }
    };

    const saveCurrentState = () => {
      const replay = useReplayStore.getState();
      if (!replay.isSelectingReplay && replay.currentTimeSec === null) {
        if (saveTimer !== null) window.clearTimeout(saveTimer);
        saveTimer = null;
        activeArchiveId.current = null;
        suppressAutoArchive.current = false;
        return;
      }
      if (suppressAutoArchive.current || saveTimer !== null) return;
      const delay = Math.max(0, 1000 - (Date.now() - lastSaveAt));
      saveTimer = window.setTimeout(() => {
        saveTimer = null;
        persistCurrentState();
      }, delay);
    };

    const flushCurrentState = () => {
      if (saveTimer !== null) window.clearTimeout(saveTimer);
      saveTimer = null;
      persistCurrentState();
    };

    const unsubscribeReplay = useReplayStore.subscribe(saveCurrentState);
    const unsubscribeTrading = useTradingStore.subscribe(saveCurrentState);
    saveCurrentState();
    window.addEventListener('pagehide', flushCurrentState);
    return () => {
      window.clearTimeout(loadArchivesTimer);
      if (saveTimer !== null) window.clearTimeout(saveTimer);
      window.removeEventListener('pagehide', flushCurrentState);
      unsubscribeReplay();
      unsubscribeTrading();
    };
  }, []);

  const continueArchive = (archive: ReplayArchive) => {
    const replay = useReplayStore.getState();
    const archiveSymbol = archive.activeSymbol ?? 'DJIUSD';
    if (archiveSymbol.toLowerCase() !== replay.activeSymbol.toLowerCase()) {
      setNotice(`Ø§Ø¨ØªØ¯Ø§ Ù†Ù…Ø§Ø¯ ${archiveSymbol} Ø±Ø§ Ø§Ø² Ù…Ù†ÙˆÛŒ Ú†Ø§Ø±Øª Ø§Ù†ØªØ®Ø§Ø¨ Ú©Ù†ÛŒØ¯.`);
      return;
    }
    const candles = replay.datasets[archive.activeTimeframe] ?? [];
    if (candles.length === 0) {
      setNotice(`دادهٔ ${archive.activeTimeframe} هنوز بارگذاری نشده است.`);
      return;
    }
    if (!hasSameData(archive, candles.length, candles[0].time, candles[candles.length - 1].time)) {
      setNotice('داده‌های این آرشیو با داده‌های فعلی پروژه تطابق ندارند.');
      return;
    }

    activeArchiveId.current = archive.id;
    suppressAutoArchive.current = false;
    useReplayStore.setState({
      activeTimeframe: archive.activeTimeframe,
      currentTimeSec: archive.currentTimeSec,
      replayStartTimeSec: archive.replayStartTimeSec,
      isSelectingReplay: archive.isSelectingReplay,
      isPlaying: false,
      speedMs: archive.speedMs,
    });
    const closedTradesBySymbol = archive.trading.trades.reduce<Record<string, Trade[]>>((grouped, trade) => {
      if (trade.status !== 'closed') return grouped;
      const symbol = (trade.symbol ?? 'DJIUSD').toLowerCase();
      grouped[symbol] = [...(grouped[symbol] ?? []), trade];
      return grouped;
    }, {});
    useTradingStore.setState({ ...archive.trading, closedTradesBySymbol });
    setNotice('بک‌تست از نقطهٔ ذخیره‌شده ادامه پیدا کرد.');
    setIsOpen(false);
  };

  const deleteArchive = (archive: ReplayArchive) => {
    if (!window.confirm(`آرشیو «${archive.name}» حذف شود؟`)) return;
    const remaining = uniqueArchives(readArchives()).filter((item) => item.id !== archive.id);
    try {
      writeArchives(remaining);
      setArchives(remaining);
      if (activeArchiveId.current === archive.id) {
        activeArchiveId.current = null;
        suppressAutoArchive.current = true;
      }
      setNotice('آرشیو حذف شد.');
    } catch {
      setNotice('حذف آرشیو انجام نشد.');
    }
  };

  const exportArchive = (archive: ReplayArchive) => {
    const blob = new Blob([JSON.stringify(archive, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `replay-${archive.activeTimeframe}-${archive.id.slice(0, 8)}.json`;
    link.click();
    URL.revokeObjectURL(url);
  };

  const importArchive = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    try {
      const parsed: unknown = JSON.parse(await file.text());
      if (!isReplayArchive(parsed)) throw new Error('Invalid archive');
      const now = Date.now();
      const imported: ReplayArchive = {
        ...parsed,
        id: makeArchiveId(),
        name: `${parsed.name} · واردشده`,
        createdAt: now,
        updatedAt: now,
      };
      const next = uniqueArchives([imported, ...readArchives()]);
      writeArchives(next);
      setArchives(next);
      setNotice('آرشیو فایل اضافه شد؛ برای ادامه، دادهٔ بازار متناظر باید در پروژه موجود باشد.');
    } catch {
      setNotice('فایل انتخاب‌شده آرشیو معتبر نیست یا فضای ذخیره کافی نیست.');
    }
  };

  return (
    <div className="relative">
      <button type="button" onClick={() => {
        const stored = readArchives();
        const unique = uniqueArchives(stored);
        if (unique.length !== stored.length) writeArchives(unique);
        setArchives(unique);
        setIsOpen((open) => !open);
      }}
        className="rounded border border-slate-700 bg-slate-800 px-3 py-1.5 text-xs font-semibold text-slate-200 hover:bg-slate-700">
        آرشیو بک‌تست‌ها ({archives.length})
      </button>
      {isOpen && <div dir="rtl" className="absolute left-0 top-full z-50 mt-2 w-[min(24rem,90vw)] rounded-lg border border-slate-700 bg-slate-900 p-3 text-slate-100 shadow-2xl">
        <div className="mb-2 flex items-center justify-between gap-2">
          <h2 className="text-sm font-bold">آرشیوهای محلی</h2>
          <div className="flex items-center gap-2">
            <button type="button" onClick={() => importInputRef.current?.click()} className="rounded border border-slate-700 px-2 py-1 text-[11px] hover:bg-slate-800">واردکردن JSON</button>
            <button type="button" onClick={() => setIsOpen(false)} aria-label="بستن" className="px-2 text-slate-400 hover:text-white">×</button>
          </div>
          <input ref={importInputRef} type="file" accept=".json,application/json" className="hidden" onChange={(event) => void importArchive(event)} />
        </div>
        <p className="mb-3 text-[11px] text-slate-400">ذخیرهٔ خودکار روی همین مرورگر؛ بدون دیتابیس. برای نگهداری فایل JSON خروجی بگیر.</p>
        <div className="max-h-72 space-y-2 overflow-y-auto">
          {archives.map((archive) => {
            const candles = useReplayStore.getState().datasets[archive.activeTimeframe] ?? [];
            const symbolMatches = (archive.activeSymbol ?? 'DJIUSD').toLowerCase() === useReplayStore.getState().activeSymbol.toLowerCase();
            const dataReady = symbolMatches && candles.length > 0;
            const dataMatches = !dataReady || hasSameData(archive, candles.length, candles[0].time, candles[candles.length - 1].time);
            return <article key={archive.id} className="rounded border border-slate-800 bg-slate-950/70 p-2">
              <div className="truncate text-xs font-semibold">{archive.name}</div>
              <div className="mt-1 text-[10px] text-slate-500">{archive.activeSymbol ?? 'DJIUSD'} · {archive.activeTimeframe} · {formatArchiveTime(archive.updatedAt)}</div>
              {!symbolMatches && <div className="mt-1 text-[10px] text-amber-300">Ø¨Ø±Ø§ÛŒ Ø§Ø¯Ø§Ù…Ù‡ØŒ Ù†Ù…Ø§Ø¯ Ù…Ø±Ø¨ÙˆØ· Ø±Ø§ Ø§Ù†ØªØ®Ø§Ø¨ Ú©Ù†ÛŒØ¯.</div>}
              {dataReady && !dataMatches && <div className="mt-1 text-[10px] text-amber-300">دادهٔ بازار با این آرشیو متفاوت است.</div>}
              <div className="mt-2 flex flex-wrap items-center gap-1.5">
                <button type="button" disabled={!dataReady || !dataMatches} onClick={() => continueArchive(archive)}
                  className="rounded bg-emerald-700 px-2 py-1 text-[11px] font-semibold hover:bg-emerald-600 disabled:cursor-not-allowed disabled:opacity-40">ادامه</button>
                <button type="button" onClick={() => exportArchive(archive)} className="rounded border border-slate-700 px-2 py-1 text-[11px] hover:bg-slate-800">خروجی JSON</button>
                <button type="button" onClick={() => deleteArchive(archive)} className="rounded border border-rose-900 px-2 py-1 text-[11px] text-rose-300 hover:bg-rose-950">حذف</button>
              </div>
            </article>;
          })}
          {archives.length === 0 && <p className="rounded border border-dashed border-slate-700 p-3 text-center text-xs text-slate-500">با شروع بک‌تست، آرشیو به‌صورت خودکار ساخته می‌شود.</p>}
        </div>
        {notice && <p role="status" className="mt-2 text-[11px] text-sky-300">{notice}</p>}
      </div>}
    </div>
  );
}

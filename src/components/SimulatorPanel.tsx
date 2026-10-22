'use client';

import { useMemo, useRef, useState } from 'react';
import { useReplayStore } from '../store/useReplayStore';
import { useTradingStore } from '../store/useTradingStore';
import { findCandleIndexByTime } from '../lib/time/binarySearch';
import type { Trade } from '../types/trading';
import type { PendingOrderType } from '../types/trading';

const inputClass = 'w-full rounded border border-slate-700 bg-slate-950 px-2 py-1.5 text-left text-sm text-slate-100 outline-none focus:border-sky-500';
const currencyFormatter = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 });

function localDateKey(timestampSec: number) {
  const date = new Date(timestampSec * 1000);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function formatTradeDate(timestampSec: number) {
  return new Intl.DateTimeFormat('fa-IR', { dateStyle: 'short', timeStyle: 'short' }).format(timestampSec * 1000);
}

function PerformanceMetric({ label, value, tone = 'neutral' }: { label: string; value: string; tone?: 'neutral' | 'positive' | 'negative' }) {
  const toneClass = tone === 'positive' ? 'text-emerald-400' : tone === 'negative' ? 'text-rose-400' : 'text-slate-100';
  return <div className="rounded border border-slate-800 bg-slate-950 px-3 py-2">
    <div className="text-[11px] text-slate-400">{label}</div>
    <div className={`mt-1 font-mono text-sm font-semibold ${toneClass}`}>{value}</div>
  </div>;
}

function floatingProfit(trade: Trade, price: number, spread: number) {
  const exitPrice = trade.side === 'buy' ? price : price + spread * trade.pointSize;
  const movement = trade.side === 'buy' ? exitPrice - trade.entryPrice : trade.entryPrice - exitPrice;
  return movement * trade.contractSize * trade.lots;
}

function riskRewardLabel(risk: number, reward: number) {
  if (!(risk > 0) || !(reward > 0) || !Number.isFinite(risk) || !Number.isFinite(reward)) return '—';
  return `1 : ${(reward / risk).toFixed(2)}`;
}

function tradeRiskReward(trade: Trade) {
  if (trade.stopLoss === null || trade.takeProfit === null) return '—';
  return riskRewardLabel(Math.abs(trade.entryPrice - trade.stopLoss), Math.abs(trade.takeProfit - trade.entryPrice));
}

function formatPrice(price: number | null) {
  return price === null ? '—' : price.toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 3 });
}

export default function SimulatorPanel() {
  const { activeSymbol, activeTimeframe, currentTimeSec, datasets } = useReplayStore();
  const account = useTradingStore();
  const capitalInputRef = useRef<HTMLInputElement>(null);
  const [lotsDraft, setLotsDraft] = useState(String(account.defaultLots));
  const [stopDraft, setStopDraft] = useState(String(account.defaultStopLossPoints));
  const [targetDraft, setTargetDraft] = useState(String(account.defaultTakeProfitPoints));
  const [pendingType, setPendingType] = useState<PendingOrderType>('buy-limit');
  const [pendingEntryDraft, setPendingEntryDraft] = useState('');
  const [notice, setNotice] = useState('');
  const [historyQuery, setHistoryQuery] = useState('');
  const [historySide, setHistorySide] = useState<'all' | 'buy' | 'sell'>('all');
  const [historyResult, setHistoryResult] = useState<'all' | 'win' | 'loss' | 'breakeven'>('all');
  const [historyFrom, setHistoryFrom] = useState('');
  const [historyTo, setHistoryTo] = useState('');

  const candle = useMemo(() => {
    if (currentTimeSec === null) return null;
    const candles = datasets[activeTimeframe];
    const index = currentTimeSec === null ? candles.length - 1 : findCandleIndexByTime(candles, currentTimeSec);
    return index < 0 ? null : candles[index];
  }, [activeTimeframe, currentTimeSec, datasets]);

  const symbolTrades = account.trades.filter((trade) => (trade.symbol ?? 'DJIUSD').toLowerCase() === activeSymbol.toLowerCase());
  const openTrades = symbolTrades.filter((trade) => trade.status === 'open');
  const closedTrades = symbolTrades.filter((trade) => trade.status === 'closed').slice()
    .sort((a, b) => (b.exitTime ?? b.entryTime) - (a.exitTime ?? a.entryTime));
  const symbolPendingOrders = account.pendingOrders.filter((order) => (order.symbol ?? 'DJIUSD').toLowerCase() === activeSymbol.toLowerCase());
  const filteredClosedTrades = (() => {
    const query = historyQuery.trim().toLowerCase();
    return closedTrades.filter((trade) => {
      const profit = trade.realizedProfit ?? 0;
      const closedAt = trade.exitTime ?? trade.entryTime;
      const sideMatches = historySide === 'all' || trade.side === historySide;
      const resultMatches = historyResult === 'all'
        || (historyResult === 'win' && profit > 0)
        || (historyResult === 'loss' && profit < 0)
        || (historyResult === 'breakeven' && profit === 0);
      const date = localDateKey(closedAt);
      const dateMatches = (!historyFrom || date >= historyFrom) && (!historyTo || date <= historyTo);
      const closeReason = trade.closeReason === 'stop-loss' ? 'حدضرر stop loss'
        : trade.closeReason === 'take-profit' ? 'حدسود take profit' : 'بستن دستی manual';
      const searchable = `${trade.id} ${trade.side} ${trade.side === 'buy' ? 'خرید buy' : 'فروش sell'} ${closeReason} ${trade.symbol ?? activeSymbol}`.toLowerCase();
      return sideMatches && resultMatches && dateMatches && (!query || searchable.includes(query));
    });
  })();

  const performance = (() => {
    const chronologicalTrades = closedTrades.slice().sort((a, b) => (a.exitTime ?? a.entryTime) - (b.exitTime ?? b.entryTime));
    let netProfit = 0;
    let grossProfit = 0;
    let grossLoss = 0;
    let wins = 0;
    let losses = 0;
    let breakeven = 0;
    let bestTrade = -Infinity;
    let worstTrade = Infinity;
    let equity = account.initialCapital;
    let peak = equity;
    let maxDrawdown = 0;
    let maxDrawdownPercent = 0;
    const equityCurve = [equity];

    for (const trade of chronologicalTrades) {
      const profit = trade.realizedProfit ?? 0;
      netProfit += profit;
      if (profit > 0) { grossProfit += profit; wins += 1; }
      else if (profit < 0) { grossLoss += Math.abs(profit); losses += 1; }
      else breakeven += 1;
      bestTrade = Math.max(bestTrade, profit);
      worstTrade = Math.min(worstTrade, profit);
      equity += profit;
      equityCurve.push(equity);
      peak = Math.max(peak, equity);
      const drawdown = peak - equity;
      maxDrawdown = Math.max(maxDrawdown, drawdown);
      if (peak > 0) maxDrawdownPercent = Math.max(maxDrawdownPercent, drawdown / peak * 100);
    }

    return {
      count: chronologicalTrades.length,
      netProfit,
      grossProfit,
      grossLoss,
      wins,
      losses,
      breakeven,
      winRate: chronologicalTrades.length ? wins / chronologicalTrades.length * 100 : 0,
      profitFactor: grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : null,
      averageWin: wins ? grossProfit / wins : 0,
      averageLoss: losses ? -grossLoss / losses : 0,
      expectancy: chronologicalTrades.length ? netProfit / chronologicalTrades.length : 0,
      bestTrade: chronologicalTrades.length ? bestTrade : 0,
      worstTrade: chronologicalTrades.length ? worstTrade : 0,
      maxDrawdown,
      maxDrawdownPercent,
      returnPercent: account.initialCapital > 0 ? netProfit / account.initialCapital * 100 : 0,
      equityCurve,
      firstTradeTime: chronologicalTrades[0]?.exitTime ?? null,
      lastTradeTime: chronologicalTrades[chronologicalTrades.length - 1]?.exitTime ?? null,
    };
  })();

  const equityPlot = (() => {
    const curve = performance.equityCurve;
    if (curve.length < 2) return null;
    const sampled = curve.length > 240
      ? Array.from({ length: 240 }, (_, index) => curve[Math.round(index * (curve.length - 1) / 239)])
      : curve;
    const minimum = Math.min(...sampled);
    const maximum = Math.max(...sampled);
    const padding = Math.max((maximum - minimum) * 0.08, Math.abs(maximum || 1) * 0.002);
    const low = minimum - padding;
    const high = maximum + padding;
    const points = sampled.map((value, index) => `${(index / (sampled.length - 1)) * 1000},${140 - ((value - low) / (high - low)) * 128}`).join(' ');
    return { points };
  })();
  const spread = candle ? Math.max(0, candle.spread) : 0;
  const floating = candle
    ? openTrades.reduce((total, trade) => total + floatingProfit(trade, candle.close, spread), 0)
    : 0;
  const usedMargin = candle
    ? openTrades.reduce((total, trade) => {
      const currentPrice = trade.side === 'buy' ? candle.close : candle.close + spread * trade.pointSize;
      return total + trade.lots * trade.contractSize * currentPrice / trade.leverage;
    }, 0)
    : 0;
  const equity = account.balance + floating;
  const freeMargin = equity - usedMargin;
  const defaultRiskReward = riskRewardLabel(Number(stopDraft), Number(targetDraft));

  const resetAccount = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const capital = Number(capitalInputRef.current?.value);
    if (!(capital > 0) || !Number.isFinite(capital)) return;
    if (!window.confirm('با ساخت حساب جدید، همهٔ معاملات باز و تاریخچهٔ فعلی پاک می‌شود. ادامه می‌دهید؟')) return;
    account.resetAccount(capital);
    setNotice('حساب شبیه‌ساز بازنشانی شد.');
  };

  const placePendingOrder = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!candle) return;
    const entryPrice = Number(pendingEntryDraft);
    if (!(entryPrice > 0) || !Number.isFinite(entryPrice)) {
      setNotice('قیمت ورود سفارش را وارد کنید.');
      return;
    }
    const accepted = account.placePendingOrder(
      pendingType,
      account.defaultLots,
      entryPrice,
      account.defaultStopLossPoints,
      account.defaultTakeProfitPoints,
      candle,
      currentTimeSec ?? candle.time,
      activeSymbol,
    );
    if (!accepted) {
      setNotice('قیمت ورود با نوع سفارش انتخاب‌شده هم‌خوانی ندارد.');
      return;
    }
    setNotice('سفارش شرطی ثبت شد.');
    setPendingEntryDraft('');
  };

  const numberSetting = (label: string, value: number, setValue: (value: number) => void, step: string) => (
    <label className="block space-y-1 text-xs text-slate-400">
      <span>{label}</span>
      <input className={inputClass} type="number" min="0" step={step} value={value}
        onChange={(event) => setValue(Math.max(0, Number(event.target.value)))} />
    </label>
  );

  return (
    <section dir="rtl" className="mt-4 space-y-4 rounded-lg border border-slate-800 bg-slate-900 p-4 text-slate-100">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-base font-bold">شبیه‌ساز معاملات</h2>
          <p className="mt-1 text-xs text-slate-400">حساب دمو روی کندل‌های تاریخی · ارز حساب: USD</p>
        </div>
        <form onSubmit={resetAccount} className="flex items-end gap-2">
          <label className="space-y-1 text-xs text-slate-400">
            <span>سرمایهٔ اولیه</span>
            <input ref={capitalInputRef} className={`${inputClass} w-36`} type="number" min="1" step="100" defaultValue={account.initialCapital} />
          </label>
          <button className="rounded border border-slate-700 px-3 py-1.5 text-xs hover:bg-slate-800" type="submit">حساب جدید</button>
        </form>
      </div>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
        {[
          ['بالانس', account.balance],
          ['اکوییتی', equity],
          ['سود/زیان شناور', floating],
          ['مارجین استفاده‌شده', usedMargin],
          ['مارجین آزاد', freeMargin],
          ['سطح مارجین', usedMargin > 0 ? `${(equity / usedMargin * 100).toFixed(1)}%` : '—'],
        ].map(([label, value]) => (
          <div key={String(label)} className="rounded border border-slate-800 bg-slate-950 px-3 py-2">
            <div className="text-xs text-slate-400">{label}</div>
            <div className={`mt-1 font-mono text-sm ${Number(value) < 0 ? 'text-rose-400' : 'text-slate-100'}`}>
              {typeof value === 'string' ? value : `$${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`}
            </div>
          </div>
        ))}
      </div>

      <section className="space-y-3 rounded-lg border border-slate-800 bg-slate-950/60 p-3" aria-labelledby="performance-report-title">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h3 id="performance-report-title" className="text-sm font-semibold">گزارش عملکرد بک‌تست · {activeSymbol}</h3>
            <p className="mt-1 text-[11px] text-slate-500">محاسبه بر اساس معاملات بسته‌شدهٔ این نماد</p>
          </div>
          <span className="rounded bg-slate-900 px-2 py-1 text-[11px] text-slate-400">{performance.count} معامله</span>
        </div>

        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
          <PerformanceMetric label="سود / زیان خالص" value={performance.count ? currencyFormatter.format(performance.netProfit) : '—'} tone={performance.netProfit > 0 ? 'positive' : performance.netProfit < 0 ? 'negative' : 'neutral'} />
          <PerformanceMetric label="نرخ برد" value={performance.count ? `${performance.winRate.toFixed(1)}٪` : '—'} tone={performance.winRate >= 50 && performance.count ? 'positive' : 'neutral'} />
          <PerformanceMetric label="برد / باخت / سر به سر" value={performance.count ? `${performance.wins} / ${performance.losses} / ${performance.breakeven}` : '—'} />
          <PerformanceMetric label="Profit Factor" value={performance.profitFactor === null ? '—' : Number.isFinite(performance.profitFactor) ? performance.profitFactor.toFixed(2) : '∞'} />
          <PerformanceMetric label="امید ریاضی هر معامله" value={performance.count ? currencyFormatter.format(performance.expectancy) : '—'} tone={performance.expectancy > 0 ? 'positive' : performance.expectancy < 0 ? 'negative' : 'neutral'} />
          <PerformanceMetric label="بازده سرمایه" value={performance.count ? `${performance.returnPercent.toFixed(2)}٪` : '—'} tone={performance.returnPercent > 0 ? 'positive' : performance.returnPercent < 0 ? 'negative' : 'neutral'} />
          <PerformanceMetric label="میانگین معاملهٔ سودده" value={performance.wins ? currencyFormatter.format(performance.averageWin) : '—'} tone="positive" />
          <PerformanceMetric label="میانگین معاملهٔ زیان‌ده" value={performance.losses ? currencyFormatter.format(performance.averageLoss) : '—'} tone="negative" />
          <PerformanceMetric label="بهترین معامله" value={performance.count ? currencyFormatter.format(performance.bestTrade) : '—'} tone={!performance.count ? 'neutral' : performance.bestTrade >= 0 ? 'positive' : 'negative'} />
          <PerformanceMetric label="بدترین معامله" value={performance.count ? currencyFormatter.format(performance.worstTrade) : '—'} tone={!performance.count ? 'neutral' : performance.worstTrade < 0 ? 'negative' : 'positive'} />
          <PerformanceMetric label="بیشترین افت سرمایه" value={performance.count ? `${currencyFormatter.format(performance.maxDrawdown)} · ${performance.maxDrawdownPercent.toFixed(2)}٪` : '—'} tone={performance.maxDrawdown > 0 ? 'negative' : 'neutral'} />
        </div>

        <div className="rounded border border-slate-800 bg-slate-950 p-2">
          <div className="mb-1 flex items-center justify-between text-[10px] text-slate-500">
            <span>منحنی سرمایهٔ تحقق‌یافته</span>
            <span>{performance.lastTradeTime ? formatTradeDate(performance.lastTradeTime) : 'پس از بسته‌شدن معامله نمایش داده می‌شود'}</span>
          </div>
          {equityPlot ? <svg role="img" aria-label={`منحنی سرمایه ${activeSymbol}`} viewBox="0 0 1000 150" preserveAspectRatio="none" className="h-32 w-full">
            <line x1="0" y1="12" x2="1000" y2="12" stroke="#1e293b" />
            <line x1="0" y1="76" x2="1000" y2="76" stroke="#1e293b" />
            <line x1="0" y1="140" x2="1000" y2="140" stroke="#1e293b" />
            <polygon points={`0,140 ${equityPlot.points} 1000,140`} fill={performance.netProfit >= 0 ? '#10b981' : '#f43f5e'} opacity="0.10" />
            <polyline points={equityPlot.points} fill="none" stroke={performance.netProfit >= 0 ? '#34d399' : '#fb7185'} strokeWidth="3" vectorEffect="non-scaling-stroke" />
          </svg> : <div className="flex h-24 items-center justify-center text-xs text-slate-500">برای رسم منحنی، ابتدا یک معامله را ببندید.</div>}
          <div className="flex justify-between text-[10px] text-slate-500">
            <span>سرمایهٔ اولیه: {currencyFormatter.format(account.initialCapital)}</span>
            <span>سرمایه پس از معاملات بسته: {currencyFormatter.format(account.initialCapital + performance.netProfit)}</span>
          </div>
        </div>
      </section>

      <div className="grid gap-4 lg:grid-cols-[minmax(250px,0.8fr)_minmax(0,1.2fr)]">
        <div className="space-y-3 rounded border border-slate-800 bg-slate-950 p-3">
          <h3 className="text-sm font-semibold">تنظیمات سفارش · {activeTimeframe}</h3>
          <div className="grid grid-cols-3 gap-2">
            <label className="space-y-1 text-xs text-slate-400">
              <span>حجم (لات)</span>
              <input className={inputClass} type="number" min="0.01" step="0.01" value={lotsDraft}
                onChange={(event) => {
                  setLotsDraft(event.target.value);
                  const value = Number(event.target.value);
                  if (value > 0) account.setDefaultLots(value);
                }} />
            </label>
            <label className="space-y-1 text-xs text-slate-400">
              <span>حدضرر (پوینت)</span>
              <input className={inputClass} type="number" min="0" step="100" value={stopDraft}
                onChange={(event) => {
                  setStopDraft(event.target.value);
                  account.setDefaultStopLossPoints(Math.max(0, Number(event.target.value)));
                }} />
            </label>
            <label className="space-y-1 text-xs text-slate-400">
              <span>حدسود (پوینت)</span>
              <input className={inputClass} type="number" min="0" step="100" value={targetDraft}
                onChange={(event) => {
                  setTargetDraft(event.target.value);
                  account.setDefaultTakeProfitPoints(Math.max(0, Number(event.target.value)));
                }} />
            </label>
          </div>
          <p className="text-[11px] text-slate-500">حجم، حدضرر و حدسود پیش‌فرض برای دکمه‌های خرید و فروش بالای نمودار استفاده می‌شوند. مقدار صفر، سطح را غیرفعال می‌کند.</p>
          <div className="flex items-center justify-between rounded bg-slate-900 px-2 py-1.5 text-xs">
            <span className="text-slate-400">ریسک به ریوارد پیش‌فرض</span>
            <strong className="font-mono text-sky-300">{defaultRiskReward}</strong>
          </div>
          <div className="grid grid-cols-3 gap-2 text-xs">
            <div className="rounded bg-slate-900 px-2 py-1"><div className="text-slate-500">Bid</div><div className="font-mono text-slate-200">{candle ? formatPrice(candle.close) : '—'}</div></div>
            <div className="rounded bg-slate-900 px-2 py-1"><div className="text-slate-500">Ask</div><div className="font-mono text-slate-200">{candle ? formatPrice(candle.close + spread * account.pointSize) : '—'}</div></div>
            <div className="rounded bg-slate-900 px-2 py-1"><div className="text-slate-500">Spread</div><div className="font-mono text-slate-200">{candle ? `${(spread * account.pointSize).toFixed(2)} (${spread} pt)` : '—'}</div></div>
          </div>
          <form onSubmit={placePendingOrder} className="grid grid-cols-[1fr_1fr_auto] items-end gap-2 border-t border-slate-800 pt-3">
            <label className="space-y-1 text-xs text-slate-400">
              <span>نوع سفارش شرطی</span>
              <select className={inputClass} value={pendingType} onChange={(event) => setPendingType(event.target.value as PendingOrderType)}>
                <option value="buy-limit">Buy Limit</option>
                <option value="sell-limit">Sell Limit</option>
                <option value="buy-stop">Buy Stop</option>
                <option value="sell-stop">Sell Stop</option>
              </select>
            </label>
            <label className="space-y-1 text-xs text-slate-400">
              <span>قیمت ورود</span>
              <input className={inputClass} type="number" min="0.00001" step={account.pointSize} placeholder={candle ? candle.close.toFixed(3) : ''}
                value={pendingEntryDraft} onChange={(event) => setPendingEntryDraft(event.target.value)} />
            </label>
            <button disabled={!candle} type="submit" className="rounded bg-sky-700 px-3 py-1.5 text-xs font-semibold text-white hover:bg-sky-600 disabled:opacity-40">ثبت</button>
          </form>
          {notice && <p aria-live="polite" className="text-xs text-sky-300">{notice}</p>}
          <details className="border-t border-slate-800 pt-2">
            <summary className="cursor-pointer text-xs text-slate-400">تنظیمات مشخصات نماد و هزینه‌ها</summary>
            <p className="my-2 text-[11px] leading-5 text-amber-200/80">پارامترهای DJIUSD به بروکر بستگی دارند؛ مقادیر را از مشخصات نماد MT5 خود وارد کنید.</p>
            <div className="grid grid-cols-2 gap-2">
              {numberSetting('لوریج', account.leverage, account.setLeverage, '1')}
              {numberSetting('اندازهٔ قرارداد', account.contractSize, account.setContractSize, '0.1')}
              {numberSetting('اندازهٔ پوینت', account.pointSize, account.setPointSize, '0.01')}
              {numberSetting('کمیسیون هر لات (هر سمت)', account.commissionPerLot, account.setCommissionPerLot, '0.1')}
            </div>
          </details>
        </div>

        <div className="min-w-0 space-y-3">
          <div>
        <h3 className="mb-2 text-sm font-semibold">معاملات باز {activeSymbol} ({openTrades.length})</h3>
            <div className="overflow-x-auto rounded border border-slate-800">
              <table className="w-full min-w-[780px] text-right text-xs">
                <thead className="bg-slate-950 text-slate-400"><tr>
                  <th className="p-2">نوع</th><th className="p-2">حجم</th><th className="p-2">ورود</th><th className="p-2">حدضرر</th><th className="p-2">حدسود</th><th className="p-2">R:R</th><th className="p-2">سود شناور</th><th className="p-2">بستن</th>
                </tr></thead>
                <tbody>
                  {openTrades.map((trade) => (
                    <tr key={trade.id} className="border-t border-slate-800">
                      <td className={`p-2 font-semibold ${trade.side === 'buy' ? 'text-emerald-400' : 'text-rose-400'}`}>{trade.side === 'buy' ? 'خرید' : 'فروش'} #{trade.id}</td>
                      <td className="p-2 font-mono">{trade.lots.toFixed(2)}</td>
                      <td className="p-2 font-mono">{formatPrice(trade.entryPrice)}</td>
                      {(['stopLoss', 'takeProfit'] as const).map((level) => (
                        <td key={level} className="p-2">
                          <input aria-label={`${level === 'stopLoss' ? 'حدضرر' : 'حدسود'} معامله ${trade.id}`}
                            className="w-28 rounded border border-slate-700 bg-slate-950 px-1.5 py-1 font-mono"
                            type="number" step={trade.pointSize} value={trade[level] ?? ''}
                            onChange={(event) => account.updateTradeLevel(trade.id, level, event.target.value === '' ? null : Number(event.target.value))} />
                        </td>
                      ))}
                      <td className="p-2 font-mono text-sky-300">{tradeRiskReward(trade)}</td>
                      <td className={`p-2 font-mono ${candle && floatingProfit(trade, candle.close, spread) >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                        {candle ? `$${floatingProfit(trade, candle.close, spread).toFixed(2)}` : '—'}
                      </td>
                      <td className="p-2"><button disabled={!candle || currentTimeSec === null} onClick={() => candle && currentTimeSec !== null && account.closePosition(trade.id, candle, currentTimeSec)}
                        className="rounded border border-slate-700 px-2 py-1 hover:bg-slate-800 disabled:opacity-40">بستن</button></td>
                    </tr>
                  ))}
                  {openTrades.length === 0 && <tr><td className="p-4 text-center text-slate-500" colSpan={8}>معاملهٔ بازی وجود ندارد.</td></tr>}
                </tbody>
              </table>
            </div>
          </div>
          <div>
          <h3 className="mb-2 text-sm font-semibold">سفارش‌های شرطی {activeSymbol} ({symbolPendingOrders.length})</h3>
            <div className="overflow-x-auto rounded border border-slate-800">
              <table className="w-full min-w-[620px] text-right text-xs">
                <thead className="bg-slate-950 text-slate-400"><tr>
                  <th className="p-2">نوع</th><th className="p-2">حجم</th><th className="p-2">قیمت ورود</th><th className="p-2">حدضرر</th><th className="p-2">حدسود</th><th className="p-2">لغو</th>
                </tr></thead>
                <tbody>
                  {symbolPendingOrders.map((order) => (
                    <tr key={order.id} className="border-t border-slate-800">
                      <td className="p-2 font-semibold text-sky-300">{order.type.replace('-', ' ').toUpperCase()} #{order.id}</td>
                      <td className="p-2 font-mono">{order.lots.toFixed(2)}</td>
                      <td className="p-2 font-mono">{formatPrice(order.entryPrice)}</td>
                      <td className="p-2 font-mono">{formatPrice(order.stopLoss)}</td>
                      <td className="p-2 font-mono">{formatPrice(order.takeProfit)}</td>
                      <td className="p-2"><button onClick={() => account.cancelPendingOrder(order.id)} className="rounded border border-slate-700 px-2 py-1 hover:bg-slate-800">لغو</button></td>
                    </tr>
                  ))}
                  {symbolPendingOrders.length === 0 && <tr><td className="p-4 text-center text-slate-500" colSpan={6}>سفارش شرطی فعالی وجود ندارد.</td></tr>}
                </tbody>
              </table>
            </div>
          </div>
          <div>
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-sm font-semibold">تاریخچهٔ معاملات {activeSymbol} ({filteredClosedTrades.length} از {closedTrades.length})</h3>
              <button type="button" onClick={() => {
                setHistoryQuery(''); setHistorySide('all'); setHistoryResult('all'); setHistoryFrom(''); setHistoryTo('');
              }} className="rounded border border-slate-700 px-2 py-1 text-[11px] text-slate-300 hover:bg-slate-800">پاک کردن فیلترها</button>
            </div>
            <div className="mb-2 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
              <input aria-label="جست‌وجوی تاریخچه معاملات" className={`${inputClass} col-span-2 sm:col-span-1`} type="search"
                placeholder="جست‌وجو: شناسه یا نوع معامله" value={historyQuery} onChange={(event) => setHistoryQuery(event.target.value)} />
              <select aria-label="فیلتر جهت معامله" className={inputClass} value={historySide} onChange={(event) => setHistorySide(event.target.value as typeof historySide)}>
                <option value="all">خرید و فروش</option><option value="buy">فقط خرید</option><option value="sell">فقط فروش</option>
              </select>
              <select aria-label="فیلتر نتیجه معامله" className={inputClass} value={historyResult} onChange={(event) => setHistoryResult(event.target.value as typeof historyResult)}>
                <option value="all">همهٔ نتایج</option><option value="win">سودده</option><option value="loss">زیان‌ده</option><option value="breakeven">سر به سر</option>
              </select>
              <input aria-label="از تاریخ" className={inputClass} type="date" value={historyFrom} onChange={(event) => setHistoryFrom(event.target.value)} />
              <input aria-label="تا تاریخ" className={inputClass} type="date" value={historyTo} onChange={(event) => setHistoryTo(event.target.value)} />
            </div>
            <div className="max-h-72 overflow-auto rounded border border-slate-800">
              {closedTrades.length === 0 ? <p className="p-3 text-xs text-slate-500">هنوز معامله‌ای بسته نشده است.</p>
                : filteredClosedTrades.length === 0 ? <p className="p-3 text-xs text-slate-500">معامله‌ای با این جست‌وجو و فیلترها پیدا نشد.</p>
                  : filteredClosedTrades.map((trade) => (
                    <div key={trade.id} className="grid grid-cols-2 items-center gap-2 border-b border-slate-800 px-3 py-2 text-xs last:border-0 sm:grid-cols-[minmax(0,1.3fr)_minmax(100px,0.8fr)_auto_auto]">
                      <div>
                        <div className={`font-semibold ${trade.side === 'buy' ? 'text-emerald-400' : 'text-rose-400'}`}>
                          {trade.side === 'buy' ? 'خرید' : 'فروش'} #{trade.id} · {trade.closeReason === 'stop-loss' ? 'حدضرر' : trade.closeReason === 'take-profit' ? 'حدسود' : 'بستن دستی'}
                        </div>
                        <time className="mt-0.5 block text-[10px] text-slate-500">{formatTradeDate(trade.exitTime ?? trade.entryTime)}</time>
                      </div>
                      <span className="font-mono text-slate-300">{formatPrice(trade.entryPrice)} ← {formatPrice(trade.exitPrice)}</span>
                      <span className="font-mono text-sky-300">R:R {tradeRiskReward(trade)}</span>
                      <strong className={`text-left font-mono ${(trade.realizedProfit ?? 0) >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>{currencyFormatter.format(trade.realizedProfit ?? 0)}</strong>
                    </div>
                  ))}
            </div>
          </div>
        </div>
      </div>
      <p className="text-[11px] leading-5 text-slate-500">اسپرد از ستون spread فایل CSV محاسبه می‌شود. عبور قیمت بین دو کندل، لغزش قیمت، سواپ و اجرای جزئی سفارش در این نسخه شبیه‌سازی نمی‌شوند.</p>
    </section>
  );
}

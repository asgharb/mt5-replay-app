'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  CandlestickSeries,
  ColorType,
  createChart,
  IChartApi,
  IPriceLine,
  ISeriesApi,
  LineStyle,
  UTCTimestamp,
} from 'lightweight-charts';
import { useReplayStore } from '../store/useReplayStore';
import { useTradingStore } from '../store/useTradingStore';

type DrawingTool = 'cursor' | 'vertical' | 'horizontal' | 'trendline' | 'rectangle' | 'fibonacci';
type DrawingPoint = { x: number; y: number };
type Drawing = { id: number; tool: Exclude<DrawingTool, 'cursor'>; from: DrawingPoint; to: DrawingPoint; color: string };
type SessionRange = { key: string; start: number; end: number };
type ChartDisplaySettings = { upColor: string; downColor: string; showGrid: boolean };

const CHART_SETTINGS_KEY = 'mt5-chart-display-settings-v1';
const REPLAY_CHART_WINDOW_SIZE = 50_000;
const REPLAY_CHART_WINDOW_SHIFT = 2_000;
const DEFAULT_CHART_SETTINGS: ChartDisplaySettings = {
  upColor: '#22c55e',
  downColor: '#ef4444',
  showGrid: true,
};

function tradeRiskReward(entryPrice: number, stopLoss: number | null, takeProfit: number | null) {
  if (stopLoss === null || takeProfit === null) return null;
  const risk = Math.abs(entryPrice - stopLoss);
  const reward = Math.abs(takeProfit - entryPrice);
  if (!(risk > 0) || !(reward > 0) || !Number.isFinite(risk) || !Number.isFinite(reward)) return null;
  return `1 : ${(reward / risk).toFixed(2)}`;
}

function zonedDateParts(timestampSec: number, timeZone: string) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(timestampSec * 1000));
  const values = Object.fromEntries(parts.map((part) => [part.type, Number(part.value)]));
  return { year: values.year, month: values.month, day: values.day, hour: values.hour, minute: values.minute };
}

function newYorkWallTimeToUtc(year: number, month: number, day: number, hour: number, minute: number) {
  const targetAsUtc = Date.UTC(year, month - 1, day, hour, minute);
  let timestamp = targetAsUtc;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const local = zonedDateParts(timestamp / 1000, 'America/New_York');
    const observedAsUtc = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute);
    const correction = targetAsUtc - observedAsUtc;
    timestamp += correction;
    if (correction === 0) break;
  }
  return timestamp / 1000;
}

function sessionRangesForWindow(startSec: number, endSec: number, mode: 'automatic' | 'manual', manualStart: string, manualEnd: string, brokerUtcOffsetHours: number): SessionRange[] {
  const timezone = mode === 'automatic' ? 'America/New_York' : 'UTC';
  const offsetSec = mode === 'manual' ? brokerUtcOffsetHours * 3600 : 0;
  const firstDay = zonedDateParts(startSec + offsetSec, timezone);
  const lastDay = zonedDateParts(endSec + offsetSec, timezone);
  const firstDayUtc = Date.UTC(firstDay.year, firstDay.month - 1, firstDay.day) - 86400000;
  const lastDayUtc = Date.UTC(lastDay.year, lastDay.month - 1, lastDay.day) + 86400000;
  const [startHour, startMinute] = manualStart.split(':').map(Number);
  const [endHour, endMinute] = manualEnd.split(':').map(Number);
  const ranges: SessionRange[] = [];

  for (let dayUtc = firstDayUtc; dayUtc <= lastDayUtc; dayUtc += 86400000) {
    const date = new Date(dayUtc);
    const weekday = date.getUTCDay();
    if (weekday === 0 || weekday === 6) continue;
    const year = date.getUTCFullYear();
    const month = date.getUTCMonth() + 1;
    const day = date.getUTCDate();
    let start: number;
    let end: number;
    if (mode === 'automatic') {
      start = newYorkWallTimeToUtc(year, month, day, 9, 30);
      end = newYorkWallTimeToUtc(year, month, day, 16, 0);
    } else {
      start = (Date.UTC(year, month - 1, day, startHour, startMinute) / 1000) - offsetSec;
      end = (Date.UTC(year, month - 1, day, endHour, endMinute) / 1000) - offsetSec;
      if (end <= start) end += 86400;
    }
    if (end >= startSec && start <= endSec) ranges.push({ key: `${year}-${month}-${day}`, start, end });
  }
  return ranges;
}

function candleIndexAtOrAfter(candles: { time: number }[], timeSec: number, limit = candles.length) {
  let low = 0;
  let high = limit;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (candles[middle].time < timeSec) low = middle + 1;
    else high = middle;
  }
  return Math.max(0, Math.min(limit - 1, low));
}

function candleLowerBound(candles: { time: number }[], timeSec: number) {
  let low = 0;
  let high = candles.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (candles[middle].time < timeSec) low = middle + 1;
    else high = middle;
  }
  return low;
}

function candleCountThrough(candles: { time: number }[], timeSec: number) {
  let low = 0;
  let high = candles.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (candles[middle].time <= timeSec) low = middle + 1;
    else high = middle;
  }
  return low;
}

const DRAWING_TOOLS: { id: DrawingTool; label: string; icon: string }[] = [
  { id: 'cursor', label: 'نشانگر', icon: '↖' },
  { id: 'vertical', label: 'خط عمودی', icon: '↕' },
  { id: 'horizontal', label: 'خط افقی', icon: '↔' },
  { id: 'trendline', label: 'خط مورب', icon: '／' },
  { id: 'rectangle', label: 'مستطیل', icon: '□' },
  { id: 'fibonacci', label: 'فیبوناچی', icon: 'ƒ' },
];

const FIBONACCI_LEVELS = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1];
const DRAWING_COLORS = ['#fbbf24', '#38bdf8', '#34d399', '#fb7185', '#c084fc', '#f8fafc'];

function pointToSegmentDistance(point: DrawingPoint, start: DrawingPoint, end: DrawingPoint) {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const lengthSquared = dx * dx + dy * dy;
  const projection = lengthSquared === 0 ? 0 : Math.max(0, Math.min(1, ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared));
  return Math.hypot(point.x - (start.x + projection * dx), point.y - (start.y + projection * dy));
}

export default function TradingViewChart() {
  const chartContainerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const priceLinesRef = useRef(new Map<string, IPriceLine>());
  const draggedLevelRef = useRef<{ tradeId: number; level: 'stopLoss' | 'takeProfit' } | null>(null);
  const replayDragRef = useRef(false);
  const replayAutoScrollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const replayPointerXRef = useRef<number | null>(null);
  const replayAutoScrollDirectionRef = useRef<-1 | 0 | 1>(0);
  const renderedDataRef = useRef<{ timeframe: string; visibleCount: number; startIndex: number; currentTimeSec: number | null; isSelectingReplay: boolean } | null>(null);
  const drawingIdRef = useRef(1);

  const [tool, setTool] = useState<DrawingTool>('cursor');
  const [drawings, setDrawings] = useState<Drawing[]>([]);
  const [draft, setDraft] = useState<Drawing | null>(null);
  const [drawingMenu, setDrawingMenu] = useState<{ drawingId: number; x: number; y: number } | null>(null);
  const [chartContextMenu, setChartContextMenu] = useState<{ x: number; y: number } | null>(null);
  const [chartSettings, setChartSettings] = useState<ChartDisplaySettings>(DEFAULT_CHART_SETTINGS);
  const [chartSettingsLoaded, setChartSettingsLoaded] = useState(false);
  const [plotSize, setPlotSize] = useState({ width: 0, height: 0 });
  const [visibleLogicalRange, setVisibleLogicalRange] = useState<{ from: number; to: number } | null>(null);
  const [showNewYorkSession, setShowNewYorkSession] = useState(false);
  const [sessionTimeMode, setSessionTimeMode] = useState<'automatic' | 'manual'>('automatic');
  const [manualSessionStart, setManualSessionStart] = useState('16:30');
  const [manualSessionEnd, setManualSessionEnd] = useState('23:00');
  const [brokerUtcOffsetHours, setBrokerUtcOffsetHours] = useState(3);
  const [sessionPriceLines, setSessionPriceLines] = useState<{ key: string; startX: number; startY: number; endX: number; endY: number }[]>([]);

  const { activeSymbol, activeTimeframe, datasets, currentTimeSec, isSelectingReplay, replayStartTimeSec, setIsSelectingReplay, setReplayStartTimeSec, setCurrentTimeSec } = useReplayStore();
  const trades = useTradingStore((state) => state.trades);
  const pendingOrders = useTradingStore((state) => state.pendingOrders);
  const updateTradeLevel = useTradingStore((state) => state.updateTradeLevel);

  useEffect(() => {
    const container = chartContainerRef.current;
    if (!container) return;
    const priceLines = priceLinesRef.current;

    const chart = createChart(container, {
      layout: {
        background: { type: ColorType.Solid, color: '#0f172a' },
        textColor: '#94a3b8',
      },
      grid: {
        vertLines: { color: '#1e293b' },
        horzLines: { color: '#1e293b' },
      },
      timeScale: {
        timeVisible: true,
        secondsVisible: false,
        shiftVisibleRangeOnNewBar: true,
      },
    });

    const candlestickSeries = chart.addSeries(CandlestickSeries, {
      upColor: DEFAULT_CHART_SETTINGS.upColor,
      downColor: DEFAULT_CHART_SETTINGS.downColor,
      borderVisible: false,
      wickUpColor: DEFAULT_CHART_SETTINGS.upColor,
      wickDownColor: DEFAULT_CHART_SETTINGS.downColor,
    });

    chartRef.current = chart;
    seriesRef.current = candlestickSeries;
    const handleVisibleRangeChange = (range: { from: number; to: number } | null) => {
      setVisibleLogicalRange(range);
    };
    chart.timeScale().subscribeVisibleLogicalRangeChange(handleVisibleRangeChange);

    const refreshPlotSize = () => {
      if (!chartContainerRef.current) return;
      const nextSize = {
        width: chart.timeScale().width(),
        height: Math.max(0, chartContainerRef.current.clientHeight - chart.timeScale().height()),
      };
      setPlotSize((previous) => previous.width === nextSize.width && previous.height === nextSize.height ? previous : nextSize);
    };
    const handleResize = () => {
      if (!chartContainerRef.current) return;
      chart.applyOptions({
        width: chartContainerRef.current.clientWidth,
        height: chartContainerRef.current.clientHeight,
      });
      refreshPlotSize();
    };

    window.addEventListener('resize', handleResize);
    const resizeObserver = new ResizeObserver(handleResize);
    resizeObserver.observe(container);
    handleResize();

    return () => {
      resizeObserver.disconnect();
      window.removeEventListener('resize', handleResize);
      chart.timeScale().unsubscribeVisibleLogicalRangeChange(handleVisibleRangeChange);
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
      priceLines.clear();
    };
  }, []);

  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      try {
        const stored = localStorage.getItem(CHART_SETTINGS_KEY);
        if (stored) {
          const parsed = JSON.parse(stored) as Partial<ChartDisplaySettings>;
          setChartSettings({
            upColor: typeof parsed.upColor === 'string' && /^#[0-9a-f]{6}$/i.test(parsed.upColor) ? parsed.upColor : DEFAULT_CHART_SETTINGS.upColor,
            downColor: typeof parsed.downColor === 'string' && /^#[0-9a-f]{6}$/i.test(parsed.downColor) ? parsed.downColor : DEFAULT_CHART_SETTINGS.downColor,
            showGrid: typeof parsed.showGrid === 'boolean' ? parsed.showGrid : DEFAULT_CHART_SETTINGS.showGrid,
          });
        }
      } catch {
        // Ignore invalid local chart preferences and use the defaults.
      }
      setChartSettingsLoaded(true);
    });
    return () => cancelAnimationFrame(frame);
  }, []);

  useEffect(() => {
    if (!chartSettingsLoaded) return;
    try {
      localStorage.setItem(CHART_SETTINGS_KEY, JSON.stringify(chartSettings));
    } catch {
      // Keep the current chart usable if browser storage is unavailable.
    }
    chartRef.current?.applyOptions({
      grid: {
        vertLines: { visible: chartSettings.showGrid },
        horzLines: { visible: chartSettings.showGrid },
      },
    });
    seriesRef.current?.applyOptions({
      upColor: chartSettings.upColor,
      downColor: chartSettings.downColor,
      wickUpColor: chartSettings.upColor,
      wickDownColor: chartSettings.downColor,
    });
  }, [chartSettings, chartSettingsLoaded]);

  useEffect(() => {
    const series = seriesRef.current;
    const chart = chartRef.current;
    if (!series || !chart) return;

    const fullDataset = datasets[activeTimeframe];
    if (!fullDataset?.length) {
      series.setData([]);
      renderedDataRef.current = { timeframe: activeTimeframe, visibleCount: 0, startIndex: 0, currentTimeSec, isSelectingReplay };
      return;
    }

    const visibleCount = isSelectingReplay || currentTimeSec === null
      ? fullDataset.length
      : candleCountThrough(fullDataset, currentTimeSec);
    const replayWindowOffset = Math.max(0, visibleCount - REPLAY_CHART_WINDOW_SIZE);
    const startIndex = currentTimeSec !== null && !isSelectingReplay
      ? Math.floor(replayWindowOffset / REPLAY_CHART_WINDOW_SHIFT) * REPLAY_CHART_WINDOW_SHIFT
      : 0;
    const chartDataCount = visibleCount - startIndex;

    const previous = renderedDataRef.current;
    const previousRange = chart.timeScale().getVisibleLogicalRange();
    const canAppendCandles = previous
      && previous.timeframe === activeTimeframe
      && previous.startIndex === startIndex
      && !previous.isSelectingReplay
      && !isSelectingReplay
      && previous.currentTimeSec !== null
      && currentTimeSec !== null
      && currentTimeSec > previous.currentTimeSec
      && visibleCount > previous.visibleCount;

    if (canAppendCandles && previous) {
      for (let index = previous.visibleCount; index < visibleCount; index += 1) {
        const candle = fullDataset[index];
        series.update({
          time: candle.time as UTCTimestamp,
          open: candle.open,
          high: candle.high,
          low: candle.low,
          close: candle.close,
        });
      }
    } else {
      series.setData(fullDataset.slice(startIndex, visibleCount).map((candle) => ({
        time: candle.time as UTCTimestamp,
        open: candle.open,
        high: candle.high,
        low: candle.low,
        close: candle.close,
      })));
    }

    if (visibleCount > 0) {
      const isNewTimeframe = !previous || previous.timeframe !== activeTimeframe;
      const isInitialDataLoad = previous?.visibleCount !== visibleCount
        && previous?.currentTimeSec === null && currentTimeSec === null;
      const isStartingReplay = previous?.isSelectingReplay === true && !isSelectingReplay;
      const rangeWidth = previousRange ? previousRange.to - previousRange.from : 125;

      if (isNewTimeframe || isInitialDataLoad || !previousRange) {
        chart.timeScale().setVisibleLogicalRange({
          from: Math.max(0, chartDataCount - 120),
          to: chartDataCount + 5,
        });
      } else if (isStartingReplay) {
        const to = chartDataCount + 5;
        chart.timeScale().setVisibleLogicalRange({ from: Math.max(0, to - rangeWidth), to });
      } else if (!canAppendCandles) {
        const startShift = (previous?.startIndex ?? 0) - startIndex;
        chart.timeScale().setVisibleLogicalRange({
          from: Math.max(0, previousRange.from + startShift),
          to: Math.max(1, previousRange.to + startShift),
        });
      }
    }
    renderedDataRef.current = { timeframe: activeTimeframe, visibleCount, startIndex, currentTimeSec, isSelectingReplay };
  }, [activeTimeframe, datasets, currentTimeSec, isSelectingReplay]);

  useEffect(() => {
    const chart = chartRef.current;
    const series = seriesRef.current;
    if (!chart || !series) return;

    const activeKeys = new Set<string>();
    if (currentTimeSec !== null || isSelectingReplay) {
      for (const trade of trades) {
        if (trade.status !== 'open' || (trade.symbol ?? 'DJIUSD').toLowerCase() !== activeSymbol.toLowerCase()) continue;
        const riskReward = tradeRiskReward(trade.entryPrice, trade.stopLoss, trade.takeProfit);
        for (const level of ['entryPrice', 'stopLoss', 'takeProfit'] as const) {
          const price = trade[level];
          const key = `${trade.id}:${level}`;
          if (price === null) continue;
          activeKeys.add(key);

          const options = {
            price,
            color: level === 'entryPrice' ? '#94a3b8' : level === 'stopLoss' ? '#fb7185' : '#34d399',
            lineWidth: 2 as const,
            lineStyle: level === 'entryPrice' ? LineStyle.Dotted : LineStyle.Dashed,
            axisLabelVisible: true,
            title: level === 'takeProfit'
              ? `TP #${trade.id}${riskReward ? ` · R:R ${riskReward}` : ''}`
              : `${level === 'entryPrice' ? 'ENTRY' : 'SL'} #${trade.id}`,
          };
          const existingLine = priceLinesRef.current.get(key);
          if (existingLine) existingLine.applyOptions(options);
          else priceLinesRef.current.set(key, series.createPriceLine(options));
        }
      }

      for (const order of pendingOrders) {
        if ((order.symbol ?? 'DJIUSD').toLowerCase() !== activeSymbol.toLowerCase()) continue;
        const key = `pending:${order.id}:entry`;
        activeKeys.add(key);
        const options = {
          price: order.entryPrice,
          color: '#38bdf8',
          lineWidth: 1 as const,
          lineStyle: LineStyle.Dashed,
          axisLabelVisible: true,
          title: `${order.type.replace('-', ' ').toUpperCase()} #${order.id}`,
        };
        const existingLine = priceLinesRef.current.get(key);
        if (existingLine) existingLine.applyOptions(options);
        else priceLinesRef.current.set(key, series.createPriceLine(options));
      }
    }

    for (const [key, line] of priceLinesRef.current) {
      if (!activeKeys.has(key)) {
        series.removePriceLine(line);
        priceLinesRef.current.delete(key);
      }
    }
  }, [activeSymbol, trades, pendingOrders, currentTimeSec, isSelectingReplay]);

  const pointFromPointer = (event: React.PointerEvent<HTMLDivElement>): DrawingPoint | null => {
    const bounds = event.currentTarget.getBoundingClientRect();
    if (bounds.width === 0 || bounds.height === 0) return null;
    return {
      x: Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width)),
      y: Math.max(0, Math.min(1, (event.clientY - bounds.top) / bounds.height)),
    };
  };

  const handleDrawPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (tool === 'cursor') return;
    const point = pointFromPointer(event);
    if (!point) return;

    const drawing: Drawing = { id: drawingIdRef.current, tool, from: point, to: point, color: '#fbbf24' };
    setDraft(drawing);
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
  };

  const handleDrawPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!draft) return;
    const point = pointFromPointer(event);
    if (point) setDraft({ ...draft, to: point });
  };

  const handleDrawPointerUp = () => {
    if (!draft) return;
    setDrawings((existing) => [...existing, draft]);
    drawingIdRef.current += 1;
    setDraft(null);
    setTool('cursor');
  };

  const handleTradePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (currentTimeSec === null && !isSelectingReplay) return;
    const series = seriesRef.current;
    const container = chartContainerRef.current;
    if (!series || !container) return;

    const bounds = container.getBoundingClientRect();
    const pointerY = event.clientY - bounds.top;
    let closest: { tradeId: number; level: 'stopLoss' | 'takeProfit'; distance: number } | null = null;
    for (const trade of trades) {
      if (trade.status !== 'open') continue;
      for (const level of ['stopLoss', 'takeProfit'] as const) {
        const price = trade[level];
        if (price === null) continue;
        const lineY = series.priceToCoordinate(price);
        if (lineY === null) continue;
        const distance = Math.abs(lineY - pointerY);
        if (distance <= 12 && (!closest || distance < closest.distance)) {
          closest = { tradeId: trade.id, level, distance };
        }
      }
    }

    if (closest) {
      draggedLevelRef.current = { tradeId: closest.tradeId, level: closest.level };
      event.currentTarget.setPointerCapture(event.pointerId);
      event.preventDefault();
    }
  };

  const handleTradePointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const dragged = draggedLevelRef.current;
    const series = seriesRef.current;
    const container = chartContainerRef.current;
    if (!dragged || !series || !container) return;

    const bounds = container.getBoundingClientRect();
    const price = series.coordinateToPrice(event.clientY - bounds.top);
    if (price !== null && Number.isFinite(price)) updateTradeLevel(dragged.tradeId, dragged.level, price);
  };

  const replayTimeFromPointer = (event: React.PointerEvent<HTMLDivElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    const chart = chartRef.current;
    const candles = isSelectingReplay || currentTimeSec === null
      ? datasets[activeTimeframe]
      : datasets[activeTimeframe].filter((candle) => candle.time <= currentTimeSec);
    if (!chart || !candles.length || bounds.width === 0) return null;
    const logicalIndex = chart.timeScale().coordinateToLogical(event.clientX - bounds.left);
    if (logicalIndex === null) return null;
    const chartStartIndex = currentTimeSec !== null && !isSelectingReplay ? renderedDataRef.current?.startIndex ?? 0 : 0;
    const candleIndex = Math.max(0, Math.min(candles.length - 1, chartStartIndex + Math.round(logicalIndex)));
    return candles[candleIndex].time;
  };

  const stopReplayAutoScroll = () => {
    if (replayAutoScrollRef.current !== null) {
      clearInterval(replayAutoScrollRef.current);
      replayAutoScrollRef.current = null;
    }
    replayAutoScrollDirectionRef.current = 0;
  };

  const updateReplayAutoScroll = (localX: number, width: number) => {
    replayPointerXRef.current = localX;
    replayAutoScrollDirectionRef.current = localX < 36 ? -1 : localX > width - 36 ? 1 : 0;
    if (replayAutoScrollDirectionRef.current === 0) {
      stopReplayAutoScroll();
      return;
    }
    if (replayAutoScrollRef.current !== null) return;

    replayAutoScrollRef.current = setInterval(() => {
      const chart = chartRef.current;
      const range = chart?.timeScale().getVisibleLogicalRange();
      const direction = replayAutoScrollDirectionRef.current;
      if (!chart || !range || direction === 0) {
        stopReplayAutoScroll();
        return;
      }
      const shift = direction * 10;
      const from = Math.max(0, range.from + shift);
      if (from === range.from) {
        stopReplayAutoScroll();
        return;
      }
      chart.timeScale().setVisibleLogicalRange({ from, to: from + (range.to - range.from) });
      const x = replayPointerXRef.current;
      const candles = datasets[activeTimeframe];
      const logicalIndex = x === null ? null : chart.timeScale().coordinateToLogical(x);
      if (logicalIndex !== null && candles.length > 0) {
        const candleIndex = Math.max(0, Math.min(candles.length - 1, Math.round(logicalIndex)));
        setReplayStartTimeSec(candles[candleIndex].time);
      }
    }, 80);
  };

  const handleReplayWheel = (event: React.WheelEvent<HTMLDivElement>) => {
    if (!isSelectingReplay) return;
    const chart = chartRef.current;
    const range = chart?.timeScale().getVisibleLogicalRange();
    if (!chart || !range) return;
    event.preventDefault();
    const step = Math.max(10, Math.round((range.to - range.from) * 0.12));
    const shift = event.deltaY > 0 ? -step : step;
    const from = Math.max(0, range.from + shift);
    chart.timeScale().setVisibleLogicalRange({ from, to: from + (range.to - range.from) });
  };

  const handleSurfacePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (isSelectingReplay) {
      replayDragRef.current = true;
      event.currentTarget.setPointerCapture(event.pointerId);
      const bounds = event.currentTarget.getBoundingClientRect();
      updateReplayAutoScroll(event.clientX - bounds.left, bounds.width);
      const time = replayTimeFromPointer(event);
      if (time !== null) setReplayStartTimeSec(time);
      event.preventDefault();
      return;
    }
    handleDrawPointerDown(event);
  };

  const handleSurfacePointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (replayDragRef.current) {
      const bounds = event.currentTarget.getBoundingClientRect();
      updateReplayAutoScroll(event.clientX - bounds.left, bounds.width);
      const time = replayTimeFromPointer(event);
      if (time !== null) setReplayStartTimeSec(time);
      return;
    }
    handleDrawPointerMove(event);
  };

  const handleSurfacePointerUp = () => {
    if (replayDragRef.current) {
      replayDragRef.current = false;
      replayPointerXRef.current = null;
      stopReplayAutoScroll();
      return;
    }
    handleDrawPointerUp();
  };

  const handleReplayDoubleClick = (event: React.MouseEvent<HTMLDivElement>) => {
    if (!isSelectingReplay) return;
    event.stopPropagation();
    const pointerEvent = event as unknown as React.PointerEvent<HTMLDivElement>;
    const time = replayTimeFromPointer(pointerEvent) ?? replayStartTimeSec;
    if (time === null) return;
    setCurrentTimeSec(time);
    setIsSelectingReplay(false);
  };

  const handleDrawingDoubleClick = (event: React.MouseEvent<HTMLDivElement>) => {
    if (isSelectingReplay || drawings.length === 0 || plotSize.width === 0 || plotSize.height === 0) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    const pointer = { x: event.clientX - bounds.left, y: event.clientY - bounds.top };
    const toPixels = (point: DrawingPoint) => ({ x: point.x * plotSize.width, y: point.y * plotSize.height });
    const tolerance = 9;
    let closest: { drawing: Drawing; distance: number } | null = null;

    for (const drawing of drawings) {
      const from = toPixels(drawing.from);
      const to = toPixels(drawing.to);
      let distance: number;
      if (drawing.tool === 'vertical') {
        distance = Math.abs(pointer.x - from.x);
      } else if (drawing.tool === 'horizontal') {
        distance = Math.abs(pointer.y - from.y);
      } else if (drawing.tool === 'trendline') {
        distance = pointToSegmentDistance(pointer, from, to);
      } else if (drawing.tool === 'rectangle') {
        const left = Math.min(from.x, to.x);
        const right = Math.max(from.x, to.x);
        const top = Math.min(from.y, to.y);
        const bottom = Math.max(from.y, to.y);
        if (pointer.x >= left && pointer.x <= right && pointer.y >= top && pointer.y <= bottom) distance = 0;
        else distance = Math.min(
          pointToSegmentDistance(pointer, { x: left, y: top }, { x: right, y: top }),
          pointToSegmentDistance(pointer, { x: right, y: top }, { x: right, y: bottom }),
          pointToSegmentDistance(pointer, { x: right, y: bottom }, { x: left, y: bottom }),
          pointToSegmentDistance(pointer, { x: left, y: bottom }, { x: left, y: top }),
        );
      } else {
        distance = Math.min(...FIBONACCI_LEVELS.map((level) => {
          const y = to.y + (from.y - to.y) * level;
          return pointToSegmentDistance(pointer, { x: Math.min(from.x, to.x), y }, { x: Math.max(from.x, to.x), y });
        }));
      }
      if (distance <= tolerance && (!closest || distance < closest.distance)) closest = { drawing, distance };
    }

    if (!closest) {
      setDrawingMenu(null);
      return;
    }
    const localX = event.clientX - bounds.left;
    const localY = event.clientY - bounds.top;
    setDrawingMenu({
      drawingId: closest.drawing.id,
      x: Math.max(8, Math.min(localX, plotSize.width - 190)),
      y: Math.max(8, Math.min(localY, plotSize.height - 108)),
    });
  };

  const chartCandles = datasets[activeTimeframe];
  const visibleCandleCount = isSelectingReplay || currentTimeSec === null
    ? chartCandles.length
    : candleCountThrough(chartCandles, currentTimeSec);
  const chartStartIndex = currentTimeSec !== null && !isSelectingReplay
    ? Math.floor(Math.max(0, visibleCandleCount - REPLAY_CHART_WINDOW_SIZE) / REPLAY_CHART_WINDOW_SHIFT) * REPLAY_CHART_WINDOW_SHIFT
    : 0;
  const chartVisibleCount = Math.max(0, visibleCandleCount - chartStartIndex);

  const latestCompletedSessionLevels = useMemo(() => {
    if (!showNewYorkSession || visibleCandleCount === 0) return null;
    const lastVisibleTime = chartCandles[visibleCandleCount - 1].time;
    const firstDataTime = chartCandles[0].time;
    let lookbackSeconds = 3 * 86400;

    // Replay advances one candle at a time. Searching from the start of a
    // multi-year CSV on every M1 update makes the session overlay slow down
    // playback, so start near the latest candle and expand only for data gaps.
    while (true) {
      const windowStart = Math.max(firstDataTime, lastVisibleTime - lookbackSeconds);
      const sessions = sessionRangesForWindow(
        windowStart,
        lastVisibleTime,
        sessionTimeMode,
        manualSessionStart,
        manualSessionEnd,
        brokerUtcOffsetHours,
      );
      const session = [...sessions].reverse().find((item) => item.end <= lastVisibleTime);
      if (session) {
        const startIndex = candleLowerBound(chartCandles, session.start);
        const endIndex = candleLowerBound(chartCandles, session.end) - 1;
        if (startIndex < visibleCandleCount && endIndex >= startIndex) {
          const startCandle = chartCandles[startIndex];
          const endCandle = chartCandles[endIndex];
          return {
            key: session.key,
            startIndex,
            startPrice: startCandle.open,
            endIndex,
            endPrice: endCandle.close,
          };
        }
      }

      if (windowStart <= firstDataTime) return null;
      lookbackSeconds *= 2;
    }
  }, [showNewYorkSession, chartCandles, visibleCandleCount, sessionTimeMode, manualSessionStart, manualSessionEnd, brokerUtcOffsetHours]);

  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      const chart = chartRef.current;
      const series = seriesRef.current;
      if (!showNewYorkSession || !latestCompletedSessionLevels || !chart || !series || !visibleLogicalRange || visibleLogicalRange.to <= visibleLogicalRange.from) {
        setSessionPriceLines([]);
        return;
      }
      const xForIndex = (index: number) => ((index - chartStartIndex - visibleLogicalRange.from) / (visibleLogicalRange.to - visibleLogicalRange.from)) * plotSize.width;
      const startY = series.priceToCoordinate(latestCompletedSessionLevels.startPrice);
      const endY = series.priceToCoordinate(latestCompletedSessionLevels.endPrice);
      if (startY === null || endY === null) {
        setSessionPriceLines([]);
        return;
      }
      setSessionPriceLines([{
        key: latestCompletedSessionLevels.key,
        startX: xForIndex(latestCompletedSessionLevels.startIndex),
        startY,
        endX: xForIndex(latestCompletedSessionLevels.endIndex),
        endY,
      }]);
    });
    return () => cancelAnimationFrame(frame);
  }, [showNewYorkSession, latestCompletedSessionLevels, visibleLogicalRange, plotSize, chartStartIndex]);
  const replayMarkerCandidate = replayStartTimeSec === null ? -1 : candleLowerBound(chartCandles, replayStartTimeSec);
  const replayMarkerIndex = isSelectingReplay && replayMarkerCandidate < chartCandles.length
    && chartCandles[replayMarkerCandidate]?.time === replayStartTimeSec ? replayMarkerCandidate : -1;
  const fallbackReplayFrom = Math.max(0, chartVisibleCount - 120);
  const fallbackReplayTo = chartVisibleCount + 5;
  const replayFrom = visibleLogicalRange?.from ?? fallbackReplayFrom;
  const replayTo = visibleLogicalRange?.to ?? fallbackReplayTo;
  const replayMarkerX = replayMarkerIndex < 0 || replayTo === replayFrom
    ? null
    : ((replayMarkerIndex - replayFrom) / (replayTo - replayFrom)) * plotSize.width;

  const sessionRangeFrom = visibleLogicalRange?.from ?? fallbackReplayFrom;
  const sessionRangeTo = visibleLogicalRange?.to ?? fallbackReplayTo;
  const sessionFirstIndex = Math.max(chartStartIndex, Math.min(visibleCandleCount - 1, chartStartIndex + Math.floor(sessionRangeFrom)));
  const sessionLastIndex = Math.max(chartStartIndex, Math.min(visibleCandleCount - 1, chartStartIndex + Math.ceil(sessionRangeTo)));
  const visibleSessions = showNewYorkSession && visibleCandleCount > 0
    ? sessionRangesForWindow(
      chartCandles[sessionFirstIndex].time,
      chartCandles[sessionLastIndex].time,
      sessionTimeMode,
      manualSessionStart,
      manualSessionEnd,
      brokerUtcOffsetHours,
    ).map((session) => {
      const startIndex = candleIndexAtOrAfter(chartCandles, session.start, visibleCandleCount);
      const endIndex = candleIndexAtOrAfter(chartCandles, session.end, visibleCandleCount);
      const span = sessionRangeTo - sessionRangeFrom;
      return {
        ...session,
        startX: span > 0 ? ((startIndex - chartStartIndex - sessionRangeFrom) / span) * plotSize.width : 0,
        endX: span > 0 ? ((endIndex - chartStartIndex - sessionRangeFrom) / span) * plotSize.width : 0,
      };
    })
    : [];

  const activeDrawings = draft ? [...drawings, draft] : drawings;

  return (
    <div className="flex h-full min-h-0 w-full flex-col overflow-hidden rounded-lg border border-slate-800 bg-slate-900">
      <div dir="rtl" className="flex shrink-0 flex-wrap items-center gap-1 border-b border-slate-800 bg-slate-950/70 px-2 py-1.5">
        <span className="px-2 text-xs text-slate-500">ترسیم</span>
        {DRAWING_TOOLS.map((drawingTool) => (
          <button key={drawingTool.id} type="button" title={drawingTool.label} aria-label={drawingTool.label}
            onClick={() => { setDraft(null); setTool(drawingTool.id); }}
            className={`min-w-9 rounded px-2 py-1 text-sm ${tool === drawingTool.id ? 'bg-sky-700 text-white' : 'text-slate-300 hover:bg-slate-800'}`}>
            <span aria-hidden="true">{drawingTool.icon}</span>
            <span className="sr-only">{drawingTool.label}</span>
          </button>
        ))}
        <label className="mx-1 flex items-center gap-1 rounded border border-slate-800 px-2 py-1 text-xs text-slate-300">
          <input type="checkbox" checked={showNewYorkSession} onChange={(event) => setShowNewYorkSession(event.target.checked)} />
          سشن نیویورک
        </label>
        {showNewYorkSession && <>
          <select aria-label="Session time mode" value={sessionTimeMode} onChange={(event) => setSessionTimeMode(event.target.value as 'automatic' | 'manual')}
            className="rounded border border-slate-700 bg-slate-900 px-2 py-1 text-xs text-slate-300">
            <option value="automatic">خودکار · وقت نیویورک</option>
            <option value="manual">دستی · ساعت بروکر</option>
          </select>
          {sessionTimeMode === 'manual' && <>
            <label className="flex items-center gap-1 text-[11px] text-slate-400">شروع
              <input aria-label="Manual New York session start" type="time" value={manualSessionStart} onChange={(event) => setManualSessionStart(event.target.value)}
                className="rounded border border-slate-700 bg-slate-900 px-1 py-1 text-xs text-slate-200" />
            </label>
            <label className="flex items-center gap-1 text-[11px] text-slate-400">پایان
              <input aria-label="Manual New York session end" type="time" value={manualSessionEnd} onChange={(event) => setManualSessionEnd(event.target.value)}
                className="rounded border border-slate-700 bg-slate-900 px-1 py-1 text-xs text-slate-200" />
            </label>
            <label className="flex items-center gap-1 text-[11px] text-slate-400">اختلاف UTC
              <input aria-label="Broker UTC offset in hours" type="number" min="-12" max="14" step="0.25" value={brokerUtcOffsetHours}
                onChange={(event) => setBrokerUtcOffsetHours(Number(event.target.value))}
                className="w-14 rounded border border-slate-700 bg-slate-900 px-1 py-1 text-xs text-slate-200" />
            </label>
          </>}
        </>}
        <button type="button" onClick={() => { setDrawings([]); setDraft(null); setTool('cursor'); }}
          className="mr-auto rounded px-2 py-1 text-xs text-slate-400 hover:bg-slate-800 hover:text-white">پاک‌کردن ترسیم‌ها</button>
        {tool !== 'cursor' && <span className="px-2 text-xs text-amber-300">ابزار فعال: {DRAWING_TOOLS.find((item) => item.id === tool)?.label} · روی چارت بکشید</span>}
      </div>

      <div className="relative min-h-0 flex-1" onDoubleClick={handleDrawingDoubleClick}
        onContextMenu={(event) => {
          event.preventDefault();
          const bounds = event.currentTarget.getBoundingClientRect();
          const menuWidth = 256;
          const menuHeight = 232;
          setChartContextMenu({
            x: Math.max(6, Math.min(event.clientX - bounds.left, bounds.width - menuWidth - 6)),
            y: Math.max(6, Math.min(event.clientY - bounds.top, bounds.height - menuHeight - 6)),
          });
        }}
        onPointerDown={(event) => {
          const target = event.target as HTMLElement;
          if (!target.closest('[data-drawing-menu]')) setDrawingMenu(null);
          if (!target.closest('[data-chart-context-menu]')) setChartContextMenu(null);
        }}>
        <div ref={chartContainerRef} className="absolute inset-0"
          onPointerDown={handleTradePointerDown} onPointerMove={handleTradePointerMove}
          onPointerUp={() => { draggedLevelRef.current = null; }} />
        <svg aria-hidden="true" className="pointer-events-none absolute left-0 top-0 z-10"
          width={plotSize.width} height={plotSize.height} viewBox={`0 0 ${Math.max(1, plotSize.width)} ${Math.max(1, plotSize.height)}`}>
          {visibleSessions.map((session) => {
            const left = Math.max(0, Math.min(plotSize.width, session.startX));
            const right = Math.max(0, Math.min(plotSize.width, session.endX));
            return <g key={session.key}>
              {right > left && <rect x={left} y={0} width={right - left} height={plotSize.height} fill="#f59e0b" opacity="0.045" />}
              {session.startX >= 0 && session.startX <= plotSize.width && <g>
                <line x1={session.startX} y1={0} x2={session.startX} y2={plotSize.height} stroke="#34d399" strokeWidth="1.5" strokeDasharray="5 3" />
              </g>}
              {session.endX >= 0 && session.endX <= plotSize.width && <g>
                <line x1={session.endX} y1={0} x2={session.endX} y2={plotSize.height} stroke="#fb7185" strokeWidth="1.5" strokeDasharray="5 3" />
              </g>}
            </g>;
          })}
          {sessionPriceLines.map((line) => <g key={`levels-${line.key}`}>
            {line.startX <= plotSize.width && <line x1={Math.max(0, line.startX)} y1={line.startY} x2={plotSize.width} y2={line.startY} stroke="#34d399" strokeWidth="1.5" strokeDasharray="6 4" />}
            {line.endX <= plotSize.width && <line x1={Math.max(0, line.endX)} y1={line.endY} x2={plotSize.width} y2={line.endY} stroke="#fb7185" strokeWidth="1.5" strokeDasharray="6 4" />}
          </g>)}
          {isSelectingReplay && replayMarkerX !== null && (
            <g>
              <line x1={replayMarkerX} y1={0} x2={replayMarkerX} y2={plotSize.height} stroke="#facc15" strokeWidth="2" />
              <text x={Math.max(6, Math.min(replayMarkerX + 6, plotSize.width - 110))} y={18} fill="#facc15" fontSize="12">Double click to start</text>
            </g>
          )}
          {activeDrawings.map((drawing) => {
            const x1 = drawing.from.x * plotSize.width;
            const y1 = drawing.from.y * plotSize.height;
            const x2 = drawing.to.x * plotSize.width;
            const y2 = drawing.to.y * plotSize.height;
            if (drawing.tool === 'vertical') {
              return <line key={drawing.id} x1={x1} y1={0} x2={x1} y2={plotSize.height} stroke={drawing.color} strokeWidth="1.5" strokeDasharray="5 4" />;
            }
            if (drawing.tool === 'horizontal') {
              return <line key={drawing.id} x1={0} y1={y1} x2={plotSize.width} y2={y1} stroke={drawing.color} strokeWidth="1.5" strokeDasharray="5 4" />;
            }
            if (drawing.tool === 'trendline') {
              return <line key={drawing.id} x1={x1} y1={y1} x2={x2} y2={y2} stroke={drawing.color} strokeWidth="2" />;
            }
            if (drawing.tool === 'fibonacci') {
              const left = Math.min(x1, x2);
              const right = Math.max(x1, x2);
              return <g key={drawing.id}>
                {FIBONACCI_LEVELS.map((level) => {
                  const y = y2 + (y1 - y2) * level;
                  const labelX = right + 4 < plotSize.width - 34 ? right + 4 : Math.max(2, left + 4);
                  return <g key={level}>
                    <line x1={left} y1={y} x2={right} y2={y} stroke={drawing.color} strokeWidth={level === 0 || level === 1 ? 1.5 : 1} strokeDasharray={level === 0 || level === 1 ? undefined : '4 3'} />
                    <text x={labelX} y={y - 3} fill={drawing.color} fontSize="10">{(level * 100).toFixed(1)}%</text>
                  </g>;
                })}
              </g>;
            }
            return <rect key={drawing.id} x={Math.min(x1, x2)} y={Math.min(y1, y2)} width={Math.abs(x2 - x1)} height={Math.abs(y2 - y1)}
              stroke={drawing.color} strokeWidth="1.5" fill={`${drawing.color}1A`} />;
          })}
        </svg>
        <div className={`absolute left-0 top-0 z-20 ${isSelectingReplay ? 'cursor-ew-resize' : tool === 'cursor' ? 'pointer-events-none' : 'cursor-crosshair'}`}
          style={{ width: plotSize.width, height: plotSize.height }}
          onPointerDown={handleSurfacePointerDown} onPointerMove={handleSurfacePointerMove} onPointerUp={handleSurfacePointerUp}
          onPointerCancel={handleSurfacePointerUp} onDoubleClick={handleReplayDoubleClick} onWheel={handleReplayWheel} />
        {drawingMenu && (() => {
          const selectedDrawing = drawings.find((drawing) => drawing.id === drawingMenu.drawingId);
          if (!selectedDrawing) return null;
          return <div dir="rtl" data-drawing-menu className="absolute z-30 w-48 rounded-md border border-slate-700 bg-slate-900 p-3 shadow-xl"
            style={{ left: drawingMenu.x, top: drawingMenu.y }} onDoubleClick={(event) => event.stopPropagation()}>
            <div className="mb-2 text-xs font-medium text-slate-200">ویرایش ترسیم</div>
            <div className="mb-3 flex items-center gap-2">
              {DRAWING_COLORS.map((color) => <button key={color} type="button" aria-label={`تغییر رنگ به ${color}`} title={color}
                onClick={() => {
                  setDrawings((existing) => existing.map((drawing) => drawing.id === selectedDrawing.id ? { ...drawing, color } : drawing));
                  setDrawingMenu(null);
                }}
                className={`h-6 w-6 rounded-full border-2 ${selectedDrawing.color === color ? 'border-white' : 'border-slate-600'}`}
                style={{ backgroundColor: color }} />)}
            </div>
            <button type="button" onClick={() => {
              setDrawings((existing) => existing.filter((drawing) => drawing.id !== selectedDrawing.id));
              setDrawingMenu(null);
            }} className="w-full rounded bg-rose-950 px-2 py-1.5 text-xs text-rose-200 hover:bg-rose-900">حذف ترسیم</button>
          </div>;
        })()}
        {chartContextMenu && <div dir="rtl" data-chart-context-menu className="absolute z-40 w-64 rounded-md border border-slate-700 bg-slate-900 p-3 text-slate-100 shadow-2xl"
          style={{ left: chartContextMenu.x, top: chartContextMenu.y }} onContextMenu={(event) => event.preventDefault()}>
          <div className="mb-3 text-xs font-bold">تنظیمات نمایش چارت</div>
          <label className="mb-2 flex items-center justify-between gap-3 text-xs text-slate-300">
            <span>رنگ کندل صعودی</span>
            <input aria-label="Bullish candle color" type="color" value={chartSettings.upColor}
              onChange={(event) => setChartSettings((settings) => ({ ...settings, upColor: event.target.value }))}
              className="h-7 w-10 cursor-pointer rounded border border-slate-600 bg-transparent p-0.5" />
          </label>
          <label className="mb-3 flex items-center justify-between gap-3 text-xs text-slate-300">
            <span>رنگ کندل نزولی</span>
            <input aria-label="Bearish candle color" type="color" value={chartSettings.downColor}
              onChange={(event) => setChartSettings((settings) => ({ ...settings, downColor: event.target.value }))}
              className="h-7 w-10 cursor-pointer rounded border border-slate-600 bg-transparent p-0.5" />
          </label>
          <label className="flex cursor-pointer items-center justify-between gap-3 text-xs text-slate-300">
            <span>نمایش Grid</span>
            <input type="checkbox" checked={chartSettings.showGrid}
              onChange={(event) => setChartSettings((settings) => ({ ...settings, showGrid: event.target.checked }))} />
          </label>
        </div>}
      </div>
    </div>
  );
}

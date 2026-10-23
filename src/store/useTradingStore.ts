import { create } from 'zustand';
import type { Candle } from '../types/market';
import type { CloseReason, PendingOrder, PendingOrderType, Trade, TradeSide } from '../types/trading';

type TradeLevel = 'stopLoss' | 'takeProfit';

interface TradingState {
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
  closedTradesBySymbol: Record<string, Trade[]>;
  pendingOrders: PendingOrder[];
  nextTradeId: number;
  nextPendingOrderId: number;
  resetAccount: (initialCapital: number) => void;
  setDefaultLots: (lots: number) => void;
  setDefaultStopLossPoints: (points: number) => void;
  setDefaultTakeProfitPoints: (points: number) => void;
  setLeverage: (leverage: number) => void;
  setContractSize: (size: number) => void;
  setPointSize: (size: number) => void;
  setCommissionPerLot: (fee: number) => void;
  openPosition: (side: TradeSide, lots: number, stopLossPoints: number, takeProfitPoints: number, candle: Candle, time: number, symbol?: string) => boolean;
  placePendingOrder: (type: PendingOrderType, lots: number, entryPrice: number, stopLossPoints: number, takeProfitPoints: number, candle: Candle, time: number, symbol?: string) => boolean;
  cancelPendingOrder: (id: number) => void;
  updateTradeLevel: (id: number, level: TradeLevel, price: number | null) => void;
  closePosition: (id: number, candle: Candle, time: number) => void;
  processCandle: (candle: Candle, time: number, symbol?: string) => void;
}

const spreadPrice = (candle: Candle, pointSize: number) => Math.max(0, candle.spread) * pointSize;

function floatingProfit(trade: Trade, candle: Candle) {
  const executablePrice = trade.side === 'buy'
    ? candle.close
    : candle.close + spreadPrice(candle, trade.pointSize);
  const movement = trade.side === 'buy'
    ? executablePrice - trade.entryPrice
    : trade.entryPrice - executablePrice;
  return movement * trade.contractSize * trade.lots;
}

function marginFor(trade: Trade, price: number) {
  return (trade.lots * trade.contractSize * Math.max(0, price)) / trade.leverage;
}

function makeTrade(state: TradingState, id: number, side: TradeSide, lots: number, stopLossPoints: number, takeProfitPoints: number, candle: Candle, time: number, entryPrice: number, symbol: string): Trade | null {
  if (!(lots > 0) || !(state.leverage > 0) || !(state.contractSize > 0) || !(state.pointSize > 0) || !(entryPrice > 0)) return null;
  return {
    id,
    symbol,
    side,
    lots,
    contractSize: state.contractSize,
    leverage: state.leverage,
    pointSize: state.pointSize,
    commissionPerLot: state.commissionPerLot,
    entryTime: time,
    entryPrice,
    stopLoss: stopLossPoints > 0
      ? entryPrice + (side === 'buy' ? -1 : 1) * stopLossPoints * state.pointSize
      : null,
    takeProfit: takeProfitPoints > 0
      ? entryPrice + (side === 'buy' ? 1 : -1) * takeProfitPoints * state.pointSize
      : null,
    status: 'open',
    exitTime: null,
    exitPrice: null,
    closeReason: null,
    realizedProfit: null,
    fees: state.commissionPerLot * lots,
    lastProcessedTime: time,
  };
}

function finishTrade(trade: Trade, candle: Candle, time: number, exitPrice: number, reason: CloseReason) {
  const gross = (trade.side === 'buy' ? exitPrice - trade.entryPrice : trade.entryPrice - exitPrice)
    * trade.contractSize * trade.lots;
  const exitFee = trade.commissionPerLot * trade.lots;
  return {
    ...trade,
    status: 'closed' as const,
    exitTime: time,
    exitPrice,
    closeReason: reason,
    realizedProfit: gross - trade.fees - exitFee,
    fees: trade.fees + exitFee,
    lastProcessedTime: Math.max(trade.lastProcessedTime, candle.time),
    grossProfit: gross,
  };
}

export const useTradingStore = create<TradingState>((set, get) => ({
  initialCapital: 10_000,
  balance: 10_000,
  defaultLots: 0.01,
  defaultStopLossPoints: 1000,
  defaultTakeProfitPoints: 2000,
  leverage: 100,
  contractSize: 1,
  pointSize: 0.1,
  commissionPerLot: 0,
  trades: [],
  closedTradesBySymbol: {},
  pendingOrders: [],
  nextTradeId: 1,
  nextPendingOrderId: 1,

  resetAccount: (initialCapital) => {
    const capital = Math.max(0, initialCapital);
    set({ initialCapital: capital, balance: capital, trades: [], closedTradesBySymbol: {}, pendingOrders: [], nextTradeId: 1, nextPendingOrderId: 1 });
  },
  setDefaultLots: (defaultLots) => set({ defaultLots }),
  setDefaultStopLossPoints: (defaultStopLossPoints) => set({ defaultStopLossPoints }),
  setDefaultTakeProfitPoints: (defaultTakeProfitPoints) => set({ defaultTakeProfitPoints }),
  setLeverage: (leverage) => set({ leverage }),
  setContractSize: (contractSize) => set({ contractSize }),
  setPointSize: (pointSize) => set({ pointSize }),
  setCommissionPerLot: (commissionPerLot) => set({ commissionPerLot }),

  openPosition: (side, lots, stopLossPoints, takeProfitPoints, candle, time, symbol = 'DJIUSD') => {
    const state = get();
    const spread = spreadPrice(candle, state.pointSize);
    const entryPrice = side === 'buy' ? candle.close + spread : candle.close;
    const position = makeTrade(state, state.nextTradeId, side, lots, stopLossPoints, takeProfitPoints, candle, time, entryPrice, symbol);
    if (!position) return false;

    const openTrades = state.trades.filter((trade) => trade.status === 'open' && (trade.symbol ?? 'DJIUSD').toLowerCase() === symbol.toLowerCase());
    const currentEquity = state.balance + openTrades.reduce((sum, trade) => sum + floatingProfit(trade, candle), 0);
    const usedMargin = openTrades.reduce((sum, trade) => sum + marginFor(trade, candle.close), 0);
    if (currentEquity - usedMargin < marginFor(position, entryPrice)) return false;

    set({
      balance: state.balance - position.fees,
      trades: [...state.trades, position],
      nextTradeId: state.nextTradeId + 1,
    });
    return true;
  },

  placePendingOrder: (type, lots, entryPrice, stopLossPoints, takeProfitPoints, candle, time, symbol = 'DJIUSD') => {
    const state = get();
    if (!(lots > 0) || !(entryPrice > 0) || !Number.isFinite(entryPrice) || !(state.leverage > 0) || !(state.contractSize > 0) || !(state.pointSize > 0)) return false;

    const side: TradeSide = type.startsWith('buy') ? 'buy' : 'sell';
    const spread = spreadPrice(candle, state.pointSize);
    const ask = candle.close + spread;
    const priceIsValid = type === 'buy-limit' ? entryPrice < ask
      : type === 'sell-limit' ? entryPrice > candle.close
        : type === 'buy-stop' ? entryPrice > ask
          : entryPrice < candle.close;
    if (!priceIsValid) return false;

    const order: PendingOrder = {
      id: state.nextPendingOrderId,
      symbol,
      type,
      side,
      lots,
      entryPrice,
      stopLoss: stopLossPoints > 0 ? entryPrice + (side === 'buy' ? -1 : 1) * stopLossPoints * state.pointSize : null,
      takeProfit: takeProfitPoints > 0 ? entryPrice + (side === 'buy' ? 1 : -1) * takeProfitPoints * state.pointSize : null,
      contractSize: state.contractSize,
      leverage: state.leverage,
      pointSize: state.pointSize,
      commissionPerLot: state.commissionPerLot,
      placedTime: time,
    };
    set({ pendingOrders: [...state.pendingOrders, order], nextPendingOrderId: state.nextPendingOrderId + 1 });
    return true;
  },

  cancelPendingOrder: (id) => set((state) => ({ pendingOrders: state.pendingOrders.filter((order) => order.id !== id) })),

  updateTradeLevel: (id, level, price) => set((state) => ({
    trades: state.trades.map((trade) => trade.id === id && trade.status === 'open'
      ? {
        ...trade,
        [level]: price === null ? null : Math.round(price / trade.pointSize) * trade.pointSize,
      }
      : trade),
  })),

  closePosition: (id, candle, time) => set((state) => {
    if (!state.trades.some((trade) => trade.id === id && trade.status === 'open')) return state;
    let balance = state.balance;
    const trades = state.trades.map((trade) => {
      if (trade.id !== id || trade.status !== 'open') return trade;
      const spread = spreadPrice(candle, trade.pointSize);
      const exitPrice = trade.side === 'buy' ? candle.close : candle.close + spread;
      const closed = finishTrade(trade, candle, time, exitPrice, 'manual');
      balance += (closed.grossProfit ?? 0) - trade.commissionPerLot * trade.lots;
      return closed;
    });
    const closedTrade = trades.find((trade) => trade.id === id && trade.status === 'closed');
    if (!closedTrade) return { trades, balance };
    const symbolKey = (closedTrade.symbol ?? 'DJIUSD').toLowerCase();
    return {
      trades,
      balance,
      closedTradesBySymbol: {
        ...state.closedTradesBySymbol,
        [symbolKey]: [...(state.closedTradesBySymbol[symbolKey] ?? []), closedTrade]
          .sort((a, b) => (b.exitTime ?? b.entryTime) - (a.exitTime ?? a.entryTime)),
      },
    };
  }),

  processCandle: (candle, time, symbol = 'DJIUSD') => set((state) => {
    const normalizedSymbol = symbol.toLowerCase();
    const hasTradeToProcess = state.trades.some((trade) => trade.status === 'open'
      && (trade.symbol ?? 'DJIUSD').toLowerCase() === normalizedSymbol
      && time > trade.entryTime && time > trade.lastProcessedTime);
    const hasOrderToProcess = state.pendingOrders.some((order) =>
      (order.symbol ?? 'DJIUSD').toLowerCase() === normalizedSymbol && time > order.placedTime);
    if (!hasTradeToProcess && !hasOrderToProcess) return state;

    let balance = state.balance;
    let nextTradeId = state.nextTradeId;
    const newlyClosedTrades: Trade[] = [];
    const trades = state.trades.map((trade) => {
      if (trade.status !== 'open' || (trade.symbol ?? 'DJIUSD').toLowerCase() !== symbol.toLowerCase()
        || time <= trade.entryTime || time <= trade.lastProcessedTime) return trade;

      const spread = spreadPrice(candle, trade.pointSize);
      const askOpen = candle.open + spread;
      const askHigh = candle.high + spread;
      const askLow = candle.low + spread;
      let reason: CloseReason | null = null;
      let exitPrice = 0;

      if (trade.side === 'buy') {
        const stopHit = trade.stopLoss !== null && candle.low <= trade.stopLoss;
        const targetHit = trade.takeProfit !== null && candle.high >= trade.takeProfit;
        if (stopHit) {
          reason = 'stop-loss';
          exitPrice = candle.open <= trade.stopLoss! ? candle.open : trade.stopLoss!;
        } else if (targetHit) {
          reason = 'take-profit';
          exitPrice = candle.open >= trade.takeProfit! ? candle.open : trade.takeProfit!;
        }
      } else {
        const stopHit = trade.stopLoss !== null && askHigh >= trade.stopLoss;
        const targetHit = trade.takeProfit !== null && askLow <= trade.takeProfit;
        if (stopHit) {
          reason = 'stop-loss';
          exitPrice = askOpen >= trade.stopLoss! ? askOpen : trade.stopLoss!;
        } else if (targetHit) {
          reason = 'take-profit';
          exitPrice = askOpen <= trade.takeProfit! ? askOpen : trade.takeProfit!;
        }
      }

      if (reason) {
        const closed = finishTrade(trade, candle, time, exitPrice, reason);
        newlyClosedTrades.push(closed);
        balance += (closed.grossProfit ?? 0) - trade.commissionPerLot * trade.lots;
        return closed;
      }

      return { ...trade, lastProcessedTime: time };
    });

    const remainingOrders: PendingOrder[] = [];
    for (const order of state.pendingOrders) {
      if ((order.symbol ?? 'DJIUSD').toLowerCase() !== symbol.toLowerCase()) {
        remainingOrders.push(order);
        continue;
      }
      if (time <= order.placedTime) {
        remainingOrders.push(order);
        continue;
      }
      const orderSpread = spreadPrice(candle, order.pointSize);
      const askOpen = candle.open + orderSpread;
      const askHigh = candle.high + orderSpread;
      const askLow = candle.low + orderSpread;
      const triggered = order.type === 'buy-limit' ? askLow <= order.entryPrice
        : order.type === 'sell-limit' ? candle.high >= order.entryPrice
          : order.type === 'buy-stop' ? askHigh >= order.entryPrice
            : candle.low <= order.entryPrice;
      if (!triggered) {
        remainingOrders.push(order);
        continue;
      }

      const fillPrice = order.type === 'buy-limit' ? Math.min(askOpen, order.entryPrice)
        : order.type === 'sell-limit' ? Math.max(candle.open, order.entryPrice)
          : order.type === 'buy-stop' ? Math.max(askOpen, order.entryPrice)
            : Math.min(candle.open, order.entryPrice);
      const orderState = { ...state, leverage: order.leverage, contractSize: order.contractSize, pointSize: order.pointSize, commissionPerLot: order.commissionPerLot };
      const createdPosition = makeTrade(orderState, nextTradeId, order.side, order.lots,
        order.stopLoss === null ? 0 : Math.abs(order.entryPrice - order.stopLoss) / order.pointSize,
        order.takeProfit === null ? 0 : Math.abs(order.takeProfit - order.entryPrice) / order.pointSize,
        candle, time, fillPrice, order.symbol ?? 'DJIUSD');
      if (!createdPosition) continue;
      const position = { ...createdPosition, stopLoss: order.stopLoss, takeProfit: order.takeProfit };

      const activeTrades = trades.filter((trade) => trade.status === 'open' && (trade.symbol ?? 'DJIUSD').toLowerCase() === symbol.toLowerCase());
      const currentEquity = balance + activeTrades.reduce((sum, trade) => sum + floatingProfit(trade, candle), 0);
      const usedMargin = activeTrades.reduce((sum, trade) => sum + marginFor(trade, candle.close), 0);
      if (currentEquity - usedMargin < marginFor(position, fillPrice)) continue;
      balance -= position.fees;
      trades.push(position);
      nextTradeId += 1;
    }

    const closedTradesBySymbol = newlyClosedTrades.length === 0 ? state.closedTradesBySymbol : { ...state.closedTradesBySymbol };
    for (const trade of newlyClosedTrades) {
      const symbolKey = (trade.symbol ?? 'DJIUSD').toLowerCase();
      closedTradesBySymbol[symbolKey] = [...(closedTradesBySymbol[symbolKey] ?? []), trade];
    }
    for (const symbolKey of new Set(newlyClosedTrades.map((trade) => (trade.symbol ?? 'DJIUSD').toLowerCase()))) {
      closedTradesBySymbol[symbolKey].sort((a, b) => (b.exitTime ?? b.entryTime) - (a.exitTime ?? a.entryTime));
    }
    return { trades, balance, pendingOrders: remainingOrders, nextTradeId, closedTradesBySymbol };
  }),
}));

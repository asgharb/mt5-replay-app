export type TradeSide = 'buy' | 'sell';
export type TradeStatus = 'open' | 'closed';
export type CloseReason = 'stop-loss' | 'take-profit' | 'manual';
export type PendingOrderType = 'buy-limit' | 'sell-limit' | 'buy-stop' | 'sell-stop';

export type PendingOrder = {
  id: number;
  symbol?: string;
  type: PendingOrderType;
  side: TradeSide;
  lots: number;
  entryPrice: number;
  stopLoss: number | null;
  takeProfit: number | null;
  contractSize: number;
  leverage: number;
  pointSize: number;
  commissionPerLot: number;
  placedTime: number;
};

export type Trade = {
  id: number;
  symbol?: string;
  side: TradeSide;
  lots: number;
  contractSize: number;
  leverage: number;
  pointSize: number;
  commissionPerLot: number;
  entryTime: number;
  entryPrice: number;
  stopLoss: number | null;
  takeProfit: number | null;
  status: TradeStatus;
  exitTime: number | null;
  exitPrice: number | null;
  closeReason: CloseReason | null;
  realizedProfit: number | null;
  grossProfit?: number | null;
  fees: number;
  lastProcessedTime: number;
};

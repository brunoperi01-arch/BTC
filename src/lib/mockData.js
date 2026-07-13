// mockData.js — Données factices utilisées uniquement quand aucune connexion Supabase
// n'est configurée (démo visuelle, pas de vraies données ni de vraie exécution).

function fakePriceSeries(base, points = 40) {
  const now = Date.now();
  let price = base;
  return Array.from({ length: points }, (_, i) => {
    price += (Math.random() - 0.48) * base * 0.002;
    return {
      price: Math.round(price),
      recorded_at: new Date(now - (points - i) * 5 * 60000).toISOString(),
    };
  });
}

export const MOCK_PRICE_DATA = {
  binance: fakePriceSeries(64200),
  coinbase: fakePriceSeries(64250),
};

export const MOCK_SIGNALS = [
  {
    id: 'demo-1',
    exchange: 'binance',
    symbol: 'BTCUSDT',
    action: 'BUY',
    confidence: 0.67,
    reasons: ['RSI à 28.4 (survente)', 'MACD au-dessus de la ligne de signal', 'Prix sous la bande de Bollinger basse', 'Volume supérieur à la moyenne (mouvement confirmé)'],
    indicators: { price: 64210, rsi: 28.4, macd: 12.1, macdSignal: 8.4, smaShort: 64300, smaLong: 63950, bollingerUpper: 65100, bollingerLower: 64180, atr: 420, volumeConfirms: true },
    suggested_amount: 32,
    stop_loss: 63580,
    take_profit: 65260,
    status: 'pending',
    created_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 12 * 60000).toISOString(),
  },
];

export const MOCK_EXECUTIONS = [
  { id: 'e1', side: 'BUY', exchange: 'binance', amount: 28, status: 'filled', auto_executed: false, created_at: new Date(Date.now() - 3600000).toISOString() },
  { id: 'e2', side: 'SELL', exchange: 'coinbase', amount: 41, status: 'filled', auto_executed: true, created_at: new Date(Date.now() - 7200000).toISOString() },
];

export const MOCK_SETTINGS = {
  auto_mode_enabled: true,
  auto_mode_threshold: 0.8,
  max_auto_trades_per_day: 3,
  max_daily_loss_usd: 50,
  circuit_breaker_triggered: false,
};

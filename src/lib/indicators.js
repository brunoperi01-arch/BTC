// indicators.js — Calcul des indicateurs techniques sur une série de prix (close)
// Toutes les fonctions attendent un tableau de nombres (prix de clôture, du plus ancien au plus récent)

/** Simple Moving Average */
export function sma(prices, period) {
  const out = [];
  for (let i = 0; i < prices.length; i++) {
    if (i < period - 1) {
      out.push(null);
      continue;
    }
    const slice = prices.slice(i - period + 1, i + 1);
    out.push(slice.reduce((a, b) => a + b, 0) / period);
  }
  return out;
}

/** Exponential Moving Average */
export function ema(prices, period) {
  const out = [];
  const k = 2 / (period + 1);
  let prevEma = null;
  for (let i = 0; i < prices.length; i++) {
    if (i < period - 1) {
      out.push(null);
      continue;
    }
    if (prevEma === null) {
      // seed avec une SMA
      const slice = prices.slice(0, period);
      prevEma = slice.reduce((a, b) => a + b, 0) / period;
      out.push(prevEma);
      continue;
    }
    prevEma = prices[i] * k + prevEma * (1 - k);
    out.push(prevEma);
  }
  return out;
}

/** Relative Strength Index */
export function rsi(prices, period = 14) {
  const out = new Array(prices.length).fill(null);
  if (prices.length < period + 1) return out;

  let gains = 0;
  let losses = 0;
  for (let i = 1; i <= period; i++) {
    const diff = prices[i] - prices[i - 1];
    if (diff >= 0) gains += diff;
    else losses -= diff;
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;
  out[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);

  for (let i = period + 1; i < prices.length; i++) {
    const diff = prices[i] - prices[i - 1];
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? -diff : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return out;
}

/** MACD: ligne MACD, ligne de signal, histogramme */
export function macd(prices, fastPeriod = 12, slowPeriod = 26, signalPeriod = 9) {
  const emaFast = ema(prices, fastPeriod);
  const emaSlow = ema(prices, slowPeriod);
  const macdLine = prices.map((_, i) =>
    emaFast[i] !== null && emaSlow[i] !== null ? emaFast[i] - emaSlow[i] : null
  );

  // signal = EMA de la macdLine (en ignorant les null de début)
  const firstValid = macdLine.findIndex((v) => v !== null);
  const validMacd = macdLine.slice(firstValid).map((v) => v);
  const signalOnValid = ema(validMacd, signalPeriod);
  const signalLine = new Array(firstValid).fill(null).concat(signalOnValid);

  const histogram = macdLine.map((v, i) =>
    v !== null && signalLine[i] !== null ? v - signalLine[i] : null
  );

  return { macdLine, signalLine, histogram };
}

/**
 * Génère un signal composite à partir des 3 indicateurs.
 * Renvoie { action: 'BUY'|'SELL'|'HOLD', confidence: 0-1, reasons: string[] }
 * Logique volontairement simple et transparente (pas de boîte noire) :
 * chaque indicateur vote, la confiance = proportion de votes concordants.
 */
export function generateSignal(prices, {
  smaShort = 20,
  smaLong = 50,
  rsiPeriod = 14,
  rsiOverbought = 70,
  rsiOversold = 30,
} = {}) {
  const smaShortArr = sma(prices, smaShort);
  const smaLongArr = sma(prices, smaLong);
  const rsiArr = rsi(prices, rsiPeriod);
  const { macdLine, signalLine, histogram } = macd(prices);

  const i = prices.length - 1;
  const reasons = [];
  const votes = [];

  // Vote 1 : croisement de moyennes mobiles (golden/death cross)
  if (smaShortArr[i] !== null && smaLongArr[i] !== null) {
    if (smaShortArr[i] > smaLongArr[i]) {
      votes.push('BUY');
      reasons.push(`SMA${smaShort} au-dessus de SMA${smaLong} (tendance haussière)`);
    } else {
      votes.push('SELL');
      reasons.push(`SMA${smaShort} en-dessous de SMA${smaLong} (tendance baissière)`);
    }
  }

  // Vote 2 : RSI
  if (rsiArr[i] !== null) {
    if (rsiArr[i] < rsiOversold) {
      votes.push('BUY');
      reasons.push(`RSI à ${rsiArr[i].toFixed(1)} (survente)`);
    } else if (rsiArr[i] > rsiOverbought) {
      votes.push('SELL');
      reasons.push(`RSI à ${rsiArr[i].toFixed(1)} (surachat)`);
    } else {
      votes.push('HOLD');
    }
  }

  // Vote 3 : MACD vs signal
  if (macdLine[i] !== null && signalLine[i] !== null) {
    if (macdLine[i] > signalLine[i] && histogram[i] > 0) {
      votes.push('BUY');
      reasons.push('MACD au-dessus de la ligne de signal');
    } else if (macdLine[i] < signalLine[i] && histogram[i] < 0) {
      votes.push('SELL');
      reasons.push('MACD en-dessous de la ligne de signal');
    } else {
      votes.push('HOLD');
    }
  }

  const buyVotes = votes.filter((v) => v === 'BUY').length;
  const sellVotes = votes.filter((v) => v === 'SELL').length;
  const total = votes.length || 1;

  let action = 'HOLD';
  let confidence = 0;
  if (buyVotes > sellVotes) {
    action = 'BUY';
    confidence = buyVotes / total;
  } else if (sellVotes > buyVotes) {
    action = 'SELL';
    confidence = sellVotes / total;
  }

  return {
    action,
    confidence,
    reasons,
    indicators: {
      price: prices[i],
      smaShort: smaShortArr[i],
      smaLong: smaLongArr[i],
      rsi: rsiArr[i],
      macd: macdLine[i],
      macdSignal: signalLine[i],
      macdHistogram: histogram[i],
    },
  };
}

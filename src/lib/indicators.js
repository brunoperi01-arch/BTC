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

/** Bollinger Bands : bande moyenne (SMA), bande haute/basse à N écarts-types */
export function bollingerBands(prices, period = 20, stdDevMult = 2) {
  const middle = sma(prices, period);
  const upper = [];
  const lower = [];
  for (let i = 0; i < prices.length; i++) {
    if (middle[i] === null) {
      upper.push(null);
      lower.push(null);
      continue;
    }
    const slice = prices.slice(i - period + 1, i + 1);
    const variance = slice.reduce((sum, p) => sum + (p - middle[i]) ** 2, 0) / period;
    const stdDev = Math.sqrt(variance);
    upper.push(middle[i] + stdDevMult * stdDev);
    lower.push(middle[i] - stdDevMult * stdDev);
  }
  return { middle, upper, lower };
}

/**
 * Average True Range — mesure de volatilité, sert à calibrer stop-loss/take-profit
 * et la taille de position selon le risque réel du marché plutôt qu'un % fixe.
 * highs/lows/closes doivent être alignés (même longueur, même index temporel).
 */
export function atr(highs, lows, closes, period = 14) {
  const trueRanges = closes.map((close, i) => {
    if (i === 0) return highs[i] - lows[i];
    const highLow = highs[i] - lows[i];
    const highPrevClose = Math.abs(highs[i] - closes[i - 1]);
    const lowPrevClose = Math.abs(lows[i] - closes[i - 1]);
    return Math.max(highLow, highPrevClose, lowPrevClose);
  });
  return ema(trueRanges, period);
}

/**
 * Calcule des niveaux de stop-loss / take-profit basés sur l'ATR plutôt qu'un
 * pourcentage fixe — la marge s'adapte à la volatilité réelle du moment.
 * multiplier classique : 1.5-2x ATR pour le stop, 2.5-3x pour le take-profit (ratio R:R ~1.5).
 */
export function computeRiskLevels(price, atrValue, action, { stopMult = 1.5, targetMult = 2.5 } = {}) {
  if (!atrValue) return { stopLoss: null, takeProfit: null };
  if (action === 'BUY') {
    return {
      stopLoss: price - atrValue * stopMult,
      takeProfit: price + atrValue * targetMult,
    };
  }
  return {
    stopLoss: price + atrValue * stopMult,
    takeProfit: price - atrValue * targetMult,
  };
}


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
  volumes = null, // tableau optionnel, même longueur que prices
  highs = null,   // requis pour l'ATR (sinon dérivé approximativement de prices)
  lows = null,
} = {}) {
  const smaShortArr = sma(prices, smaShort);
  const smaLongArr = sma(prices, smaLong);
  const rsiArr = rsi(prices, rsiPeriod);
  const { macdLine, signalLine, histogram } = macd(prices);
  const bb = bollingerBands(prices, 20, 2);
  const atrArr = highs && lows ? atr(highs, lows, prices, 14) : null;

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

  // Vote 4 : Bollinger Bands — prix hors des bandes = extrême statistique
  if (bb.upper[i] !== null && bb.lower[i] !== null) {
    if (prices[i] <= bb.lower[i]) {
      votes.push('BUY');
      reasons.push('Prix sous la bande de Bollinger basse (extrême statistique)');
    } else if (prices[i] >= bb.upper[i]) {
      votes.push('SELL');
      reasons.push('Prix au-dessus de la bande de Bollinger haute (extrême statistique)');
    }
  }

  // Vote 5 (confirmation, pas un vote directionnel) : volume — un mouvement sur
  // faible volume est moins fiable. On ne vote pas BUY/SELL mais on ajuste la confiance.
  let volumeConfirms = null;
  if (volumes && volumes.length === prices.length) {
    const avgVolume = volumes.slice(Math.max(0, i - 20), i).reduce((a, b) => a + b, 0) / Math.min(20, i);
    volumeConfirms = volumes[i] > avgVolume * 1.2;
    if (volumeConfirms) reasons.push('Volume supérieur à la moyenne (mouvement confirmé)');
    else reasons.push('Volume faible (signal moins fiable, à prendre avec prudence)');
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

  // Le volume ne crée pas de signal seul, mais pénalise/renforce la confiance d'un signal existant
  if (volumeConfirms === false && action !== 'HOLD') confidence *= 0.8;
  if (volumeConfirms === true && action !== 'HOLD') confidence = Math.min(1, confidence * 1.1);

  const riskLevels = atrArr ? computeRiskLevels(prices[i], atrArr[i], action) : { stopLoss: null, takeProfit: null };

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
      bollingerUpper: bb.upper[i],
      bollingerLower: bb.lower[i],
      atr: atrArr ? atrArr[i] : null,
      volumeConfirms,
    },
    riskLevels,
  };
}

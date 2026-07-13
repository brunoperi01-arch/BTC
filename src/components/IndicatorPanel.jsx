export default function IndicatorPanel({ indicators }) {
  if (!indicators) return null;
  const { rsi, macd, macdSignal, smaShort, smaLong } = indicators;

  const rsiColor = rsi > 70 ? 'text-red-400' : rsi < 30 ? 'text-emerald-400' : 'text-neutral-300';
  const macdColor = macd > macdSignal ? 'text-emerald-400' : 'text-red-400';
  const trendColor = smaShort > smaLong ? 'text-emerald-400' : 'text-red-400';

  return (
    <div className="grid grid-cols-3 gap-3">
      <div className="rounded-lg border border-neutral-800 bg-neutral-900 p-3">
        <div className="text-xs text-neutral-500 mb-1">RSI (14)</div>
        <div className={`text-lg font-semibold ${rsiColor}`}>{rsi?.toFixed(1) ?? '—'}</div>
      </div>
      <div className="rounded-lg border border-neutral-800 bg-neutral-900 p-3">
        <div className="text-xs text-neutral-500 mb-1">MACD</div>
        <div className={`text-lg font-semibold ${macdColor}`}>{macd?.toFixed(1) ?? '—'}</div>
      </div>
      <div className="rounded-lg border border-neutral-800 bg-neutral-900 p-3">
        <div className="text-xs text-neutral-500 mb-1">SMA20/50</div>
        <div className={`text-lg font-semibold ${trendColor}`}>{smaShort > smaLong ? '↑' : '↓'}</div>
      </div>
    </div>
  );
}

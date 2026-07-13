import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from 'recharts';

export default function PriceChart({ data, exchange }) {
  const formatted = data.map((d) => ({
    time: new Date(d.recorded_at).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }),
    price: d.price,
  }));

  return (
    <div className="rounded-lg border border-neutral-800 bg-neutral-900 p-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-medium text-neutral-300 uppercase tracking-wide">{exchange}</h3>
        {formatted.length > 0 && (
          <span className="text-lg font-semibold text-neutral-100">
            ${formatted[formatted.length - 1].price.toLocaleString('fr-FR', { maximumFractionDigits: 0 })}
          </span>
        )}
      </div>
      <ResponsiveContainer width="100%" height={200}>
        <LineChart data={formatted}>
          <CartesianGrid strokeDasharray="3 3" stroke="#262626" />
          <XAxis dataKey="time" stroke="#525252" fontSize={10} tickLine={false} />
          <YAxis
            domain={['dataMin - 100', 'dataMax + 100']}
            stroke="#525252"
            fontSize={10}
            tickLine={false}
            width={60}
            tickFormatter={(v) => `$${Math.round(v / 1000)}k`}
          />
          <Tooltip
            contentStyle={{ background: '#171717', border: '1px solid #262626', borderRadius: 8, fontSize: 12 }}
            labelStyle={{ color: '#a3a3a3' }}
          />
          <Line type="monotone" dataKey="price" stroke="#f7931a" strokeWidth={2} dot={false} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

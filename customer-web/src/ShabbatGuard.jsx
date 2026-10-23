import { ShieldCheck } from 'lucide-react';

export default function ShabbatGuard({ message = 'החנות סגורה' }) {
  return (
    <div className="shabbat-screen">
      <div className="shabbat-card">
        <ShieldCheck size={56} />
        <h1>שבת שלום — האתר סגור לרכישה כעת</h1>
        <p>{message}</p>
      </div>
    </div>
  );
}

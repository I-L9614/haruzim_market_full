import { CheckCircle2, Phone, ReceiptText } from 'lucide-react';

export default function OrderConfirmation({ order, onContinue }) {
  return (
    <main className="confirmation-screen" dir="rtl">
      <section className="confirmation-card" aria-labelledby="confirmation-title">
        <div className="confirmation-icon"><CheckCircle2 size={38} /></div>
        <p className="eyebrow">Haruzim Market</p>
        <h1 id="confirmation-title">ההזמנה נקלטה בהצלחה</h1>
        <p className="confirmation-message">נציגי החנות יתקשרו אליך כדי לבצע חיוב ולתאם את המשלוח. לא בוצע חיוב באתר.</p>
        <div className="confirmation-details">
          <div><span><ReceiptText size={17} /> מספר הזמנה</span><strong>{order?._id}</strong></div>
          <div><span>סכום להזמנה</span><strong>{Number(order?.total || 0).toFixed(2)}₪</strong></div>
          <div><span><Phone size={17} /> סטטוס תשלום</span><strong>תיאום טלפוני מול החנות</strong></div>
        </div>
        <button className="primary-btn" type="button" onClick={onContinue}>חזרה לחנות</button>
      </section>
    </main>
  );
}

import { Check, CircleAlert, Truck } from 'lucide-react';

export default function Checkout({
  customer,
  setCustomer,
  checkoutResult,
  onSubmit,
  isSubmitting,
  isShabbatBlocked
}) {
  return (
    <>
      <section className="section-block checkout-form">
        <div className="panel-header">
          <h2>פרטי משלוח</h2>
          <span><Truck size={14} /> תיאום טלפוני</span>
        </div>

        <form onSubmit={(event) => { event.preventDefault(); onSubmit(); }}>
          <div className="form-grid">
            <label>שם מלא<input autoComplete="name" value={customer.name} onChange={(e) => setCustomer((prev) => ({ ...prev, name: e.target.value }))} placeholder="ישראל ישראלי" required /></label>
            <label>טלפון לחזרה<input type="tel" autoComplete="tel" inputMode="tel" value={customer.phone} onChange={(e) => setCustomer((prev) => ({ ...prev, phone: e.target.value }))} placeholder="050-0000000" required /></label>
            <label>אימייל (לא חובה)<input type="email" autoComplete="email" value={customer.email} onChange={(e) => setCustomer((prev) => ({ ...prev, email: e.target.value }))} placeholder="name@example.com" /></label>
            <label>רחוב ומספר<input autoComplete="street-address" value={customer.address.street} onChange={(e) => setCustomer((prev) => ({ ...prev, address: { ...prev.address, street: e.target.value } }))} placeholder="רחוב ומספר בית" required /></label>
            <label>עיר<input autoComplete="address-level2" value={customer.address.city} onChange={(e) => setCustomer((prev) => ({ ...prev, address: { ...prev.address, city: e.target.value } }))} placeholder="עיר" required /></label>
            <label>דירה / כניסה (לא חובה)<input value={customer.address.apartment} onChange={(e) => setCustomer((prev) => ({ ...prev, address: { ...prev.address, apartment: e.target.value } }))} placeholder="דירה, כניסה, קומה" /></label>
            <label className="notes-field">הערות למשלוח (לא חובה)<textarea value={customer.notes} onChange={(e) => setCustomer((prev) => ({ ...prev, notes: e.target.value }))} placeholder="פרטים שיעזרו לנו לתאם את המשלוח" rows="3" /></label>
          </div>
          <p className="offline-payment-note">לא מתבצע חיוב באתר. לאחר שליחת ההזמנה נציגי החנות יתקשרו לביצוע החיוב ולתיאום המשלוח.</p>
          <div className="checkout-submit-row">
            <button className="primary-btn" type="submit" disabled={isSubmitting || isShabbatBlocked}>{isShabbatBlocked ? 'הזמנות סגורות בשבת' : isSubmitting ? 'שולחים הזמנה…' : 'שליחת הזמנה לחנות'}</button>
          </div>
        </form>
      </section>

      {checkoutResult && (
        <section className="success-box">
          <div className={`success-head ${checkoutResult.ok ? '' : 'failure'}`}>
            {checkoutResult.ok ? <Check size={18} /> : <CircleAlert size={18} />}
            <span>{checkoutResult.ok ? 'הזמנה התקבלה' : 'ההזמנה לא הושלמה'}</span>
          </div>
          <p>{checkoutResult.message}</p>
          {checkoutResult.ok && <p className="order-confirmation-total">סה״כ להזמנה: {Number(checkoutResult.order?.total || 0).toFixed(2)}₪ · התשלום יתואם טלפונית.</p>}
        </section>
      )}
    </>
  );
}

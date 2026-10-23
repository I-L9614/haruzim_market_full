import { CreditCard } from 'lucide-react';

export default function CalPayment({ paymentMethod, setPaymentMethod, onSubmitPayment, isSubmitting }) {
  return (
    <div className="payment-box">
      <div className="panel-header compact">
        <h3>תשלום</h3>
        <span><CreditCard size={14} /> Cal</span>
      </div>

      <div className="payment-methods">
        <label className={paymentMethod === 'card' ? 'payment-option active' : 'payment-option'}>
          <input type="radio" name="paymentMethod" value="card" checked={paymentMethod === 'card'} onChange={() => setPaymentMethod('card')} />
          <span>כרטיס אשראי</span>
        </label>
        <label className={paymentMethod === 'cash' ? 'payment-option active' : 'payment-option'}>
          <input type="radio" name="paymentMethod" value="cash" checked={paymentMethod === 'cash'} onChange={() => setPaymentMethod('cash')} />
          <span>מזומן / תשלום בכניסה</span>
        </label>
      </div>

      <button className="primary-btn full" onClick={onSubmitPayment} disabled={isSubmitting}>
        {isSubmitting ? 'מעבד תשלום...' : 'בצע תשלום באמצעות Cal'}
      </button>
    </div>
  );
}
